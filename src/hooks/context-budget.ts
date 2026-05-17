// src/hooks/context-budget.ts
// Central per-session state for local LLM context budget tracking
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";

import type { PluginInput } from "@opencode-ai/plugin";

import { config } from "@/utils/config";
import { getContextLimit } from "@/utils/model-limits";

const ESTIMATE_SAMPLE_LINES = 100;
const ESTIMATE_EXTRAPOLATION_MULTIPLIER = 2;
const ESTIMATE_BYTES_PER_LINE = 80;
const NOT_FOUND_ESTIMATE = 50;
const EMPTY_FILE_ESTIMATE = 10;

interface TokenUsage {
  used: number;
  limit: number;
  lastUpdated: number;
}

interface SessionBudgetState {
  tokenUsage: TokenUsage;
  modelID: string;
  providerID: string;
}

export interface FileCostEstimate {
  path: string;
  estimated: number;
  method: "exact" | "extrapolate" | "not_found";
}

export interface ReadCostEstimate {
  total: number;
  files: FileCostEstimate[];
}

export interface CanReadOptions {
  reserveForThinking?: number;
  reserveForOutput?: number;
}

export type ReadDecision = "ok" | "tight" | "delegation_needed";

export interface CanReadResult {
  decision: ReadDecision;
  remaining: number;
  estimatedCost: number;
  availableBudget: number;
}

export interface ContextBudgetHooks {
  "chat.params": (input: { sessionID: string }) => Promise<void>;
  event: (input: { event: { type: string; properties?: unknown } }) => Promise<void>;
  /** Estimate the token cost of reading specified files */
  estimateReadCost: (paths: string[]) => Promise<ReadCostEstimate>;
  /** Check if reading the specified files fits the remaining budget */
  canRead: (sessionID: string, cost: number, opts?: CanReadOptions) => CanReadResult;
  /** Get current budget state for a session */
  getBudget: (sessionID: string) => { used: number; limit: number; remaining: number } | null;
}

export interface ContextBudgetConfig {
  modelContextLimits?: Map<string, number>;
  defaultContextLimit?: number;
  charPerToken?: number;
  maxReadRatio?: number;
  minRemainingRatio?: number;
  outputBudget?: number;
  reasoningBudget?: number;
}

// --- Module-level helper functions ---

async function handleEvent(
  event: { type: string; properties?: unknown },
  sessions: Map<string, SessionBudgetState>,
  hookConfig?: ContextBudgetConfig,
): Promise<void> {
  const props = event.properties as Record<string, unknown> | undefined;

  if (event.type === "session.deleted") {
    const sessionInfo = props?.info as { id?: string } | undefined;
    if (sessionInfo?.id) {
      sessions.delete(sessionInfo.id);
    }
    return;
  }

  if (event.type !== "message.updated") return;

  const info = props?.info as Record<string, unknown> | undefined;
  const sessionID = info?.sessionID as string | undefined;
  if (!sessionID || info?.role !== "assistant") return;

  const tokens = info.tokens as { input?: number; cache?: { read?: number } } | undefined;
  const inputTokens = tokens?.input || 0;
  const cacheRead = tokens?.cache?.read || 0;
  const totalUsed = inputTokens + cacheRead;

  const modelID = (info.modelID as string) || "";
  const providerID = (info.providerID as string) || "";
  const contextLimit =
    hookConfig?.defaultContextLimit ?? getContextLimit(modelID, providerID, hookConfig?.modelContextLimits);

  const existing = sessions.get(sessionID);
  const used = Math.max(totalUsed, existing?.tokenUsage.used ?? 0);
  const limit = existing?.tokenUsage.limit ?? contextLimit;

  sessions.set(sessionID, {
    tokenUsage: { used, limit, lastUpdated: Date.now() },
    modelID,
    providerID,
  });
}

async function estimateSmallFileCost(filePath: string, charPerToken: number): Promise<FileCostEstimate> {
  const content = await readFile(filePath, "utf-8");
  const tokens = Math.ceil(content.length / charPerToken);
  return { path: filePath, estimated: tokens, method: "exact" };
}

async function estimateLargeFileCost(
  filePath: string,
  charPerToken: number,
  fileSize: number,
): Promise<FileCostEstimate> {
  const readlineModule = await import("node:readline");
  const fsModule = await import("node:fs");

  const rl = readlineModule.createInterface({
    input: fsModule.createReadStream(filePath),
  });
  let sampleChars = 0;
  let lines = 0;

  for await (const line of rl) {
    sampleChars += line.length + 1;
    lines++;
    if (lines >= ESTIMATE_SAMPLE_LINES) break;
  }
  rl.close();

  if (lines === 0) {
    return { path: filePath, estimated: EMPTY_FILE_ESTIMATE, method: "extrapolate" };
  }

  const avgCharsPerLine = sampleChars / lines;
  const totalLines = fileSize / avgCharsPerLine;
  const totalChars = totalLines * avgCharsPerLine;
  const tokens = Math.ceil(totalChars / charPerToken);
  const conservativeTokens = tokens * ESTIMATE_EXTRAPOLATION_MULTIPLIER;
  return { path: filePath, estimated: conservativeTokens, method: "extrapolate" };
}

async function estimateSingleFileCost(filePath: string, charPerToken: number): Promise<FileCostEstimate> {
  try {
    if (!existsSync(filePath)) {
      return { path: filePath, estimated: NOT_FOUND_ESTIMATE, method: "not_found" };
    }

    const stats = statSync(filePath);
    const fileSize = stats.size;

    if (fileSize < ESTIMATE_SAMPLE_LINES * ESTIMATE_BYTES_PER_LINE) {
      return await estimateSmallFileCost(filePath, charPerToken);
    }

    return await estimateLargeFileCost(filePath, charPerToken, fileSize);
  } catch {
    return { path: filePath, estimated: NOT_FOUND_ESTIMATE, method: "not_found" };
  }
}

async function handleEstimateReadCost(paths: string[], charPerToken: number): Promise<ReadCostEstimate> {
  const files: FileCostEstimate[] = [];
  let total = 0;

  for (const filePath of paths) {
    const estimate = await estimateSingleFileCost(filePath, charPerToken);
    files.push(estimate);
    total += estimate.estimated;
  }

  return { total, files };
}

function handleCanRead(
  sessionID: string,
  cost: number,
  opts: CanReadOptions | undefined,
  sessions: Map<string, SessionBudgetState>,
  hookConfig?: ContextBudgetConfig,
): CanReadResult {
  const state = sessions.get(sessionID);
  const limit = state?.tokenUsage.limit ?? hookConfig?.defaultContextLimit ?? config.localLLM.defaultContextLimit;
  const usedTokens = state?.tokenUsage.used ?? 0;
  const remaining = limit - usedTokens;

  const reserveThinking = opts?.reserveForThinking ?? 0;
  const reserveOutput = opts?.reserveForOutput ?? 0;
  const totalReserved = reserveThinking + reserveOutput;
  const availableBudget = remaining - totalReserved;

  if (availableBudget <= 0) {
    return { decision: "delegation_needed", remaining, estimatedCost: cost, availableBudget: 0 };
  }

  const maxReadRatio = hookConfig?.maxReadRatio ?? config.localLLM.maxReadRatio;
  const maxAllowed = remaining * maxReadRatio;
  if (cost > maxAllowed) {
    return { decision: "delegation_needed", remaining, estimatedCost: cost, availableBudget };
  }

  const minRemainingRatio = hookConfig?.minRemainingRatio ?? config.localLLM.minRemainingRatio;
  const remainingAfter = remaining - cost;
  const minRemaining = limit * minRemainingRatio;
  if (remainingAfter < minRemaining) {
    return { decision: "tight", remaining, estimatedCost: cost, availableBudget };
  }

  return { decision: "ok", remaining, estimatedCost: cost, availableBudget };
}

function handleGetBudget(
  sessionID: string,
  sessions: Map<string, SessionBudgetState>,
): { used: number; limit: number; remaining: number } | null {
  const state = sessions.get(sessionID);
  if (!state) return null;

  return {
    used: state.tokenUsage.used,
    limit: state.tokenUsage.limit,
    remaining: state.tokenUsage.limit - state.tokenUsage.used,
  };
}

// --- Factory function ---

export function createContextBudgetHook(_ctx: PluginInput, hookConfig?: ContextBudgetConfig): ContextBudgetHooks {
  const sessions = new Map<string, SessionBudgetState>();
  const charPerToken = hookConfig?.charPerToken ?? config.localLLM.charPerToken;
  const _outputBudget = hookConfig?.outputBudget ?? config.localLLM.outputBudget;
  const _reasoningBudget = hookConfig?.reasoningBudget ?? config.localLLM.reasoningBudget;

  return {
    "chat.params": async () => {
      // No-op in this hook; used only by context-pinner
    },
    event: async ({ event }) => handleEvent(event, sessions, hookConfig),
    estimateReadCost: async (paths) => handleEstimateReadCost(paths, charPerToken),
    canRead: (sessionID, cost, opts) => handleCanRead(sessionID, cost, opts, sessions, hookConfig),
    getBudget: (sessionID) => handleGetBudget(sessionID, sessions),
  };
}
