// src/hooks/context-budget.ts
// Central per-session state for local LLM context budget tracking
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";

import type { PluginInput } from "@opencode-ai/plugin";
import type { SmallContextConfig } from "@/config-schemas";

import { config } from "@/utils/config";
import type { ContextLimitResolution } from "@/utils/model-limits";
import { resolveContextLimit } from "@/utils/model-limits";

const ESTIMATE_SAMPLE_LINES = 100;
const ESTIMATE_EXTRAPOLATION_MULTIPLIER = 2;
const ESTIMATE_BYTES_PER_LINE = 80;
const NOT_FOUND_ESTIMATE = 50;
const EMPTY_FILE_ESTIMATE = 10;
const FANOUT_FILE_THRESHOLD = 4;
const FANOUT_TOOL_CALL_THRESHOLD = 5;
const FANOUT_MIXED_TOOL_THRESHOLD = 3;
const FANOUT_LARGE_FILE_MIN_TOKENS = 2_000;
const FANOUT_LARGE_FILE_RATIO = 0.08;
const FANOUT_TIGHT_REMAINING_RATIO = 0.2;
const FANOUT_REQUIRED_SIGNAL_COUNT = 3;

export const CONTEXT_BUDGET_INVESTIGATION_TYPES = [
  "targeted_read",
  "multi_file_read",
  "broad_exploration",
  "architecture_trace",
  "pattern_search",
] as const;

interface TokenUsage {
  used: number;
  limit: number;
  lastUpdated: number;
}

interface SessionBudgetState {
  tokenUsage: TokenUsage;
  modelID: string;
  providerID: string;
  contextResolution: ContextLimitResolution;
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

export type InvestigationType = (typeof CONTEXT_BUDGET_INVESTIGATION_TYPES)[number];
export type FanoutDecision = "direct_ok" | "fanout_recommended" | "fanout_required";

export interface FanoutOptions extends CanReadOptions {
  files?: readonly string[];
  expectedToolCalls?: number;
  plannedTools?: readonly string[];
  continuingAfterCompaction?: boolean;
  investigationType?: InvestigationType;
}

export interface FanoutAssessment {
  active: boolean;
  decision: FanoutDecision;
  reasons: string[];
  estimatedCost: number;
  fileEstimates: FileCostEstimate[];
  readDecision: ReadDecision;
  fileCount: number;
  extrapolatedFileCount: number;
  largeFileCount: number;
  expectedToolCalls: number;
  mixedToolCount: number;
  remaining: number;
  availableBudget: number;
}

export type OutputGovernorReason =
  | "active"
  | "disabled"
  | "mode_off"
  | "non_small_context"
  | "session_untracked"
  | "unknown_model";

export interface OutputGovernorState {
  active: boolean;
  reason: OutputGovernorReason;
  mode: SmallContextConfig["mode"];
  used: number;
  limit: number;
  remaining: number;
  reserveTokens: number;
  availableTokens: number;
  charPerToken: number;
}

export interface ContextBudgetHooks {
  "chat.params": (input: { sessionID: string }) => Promise<void>;
  event: (input: { event: { type: string; properties?: unknown } }) => Promise<void>;
  /** Estimate the token cost of reading specified files */
  estimateReadCost: (paths: string[]) => Promise<ReadCostEstimate>;
  /** Check if reading the specified files fits the remaining budget */
  canRead: (sessionID: string, cost: number, opts?: CanReadOptions) => CanReadResult;
  /** Decide whether a small-context investigation should fan out to summary subagents */
  assessFanout: (sessionID: string, opts: FanoutOptions) => Promise<FanoutAssessment>;
  /** Get current budget state for a session */
  getBudget: (sessionID: string) => { used: number; limit: number; remaining: number } | null;
  /** Get current output-governor state for a session */
  getOutputGovernorState: (sessionID: string) => OutputGovernorState;
}

export interface ContextBudgetConfig {
  modelContextLimits?: Map<string, number>;
  localContextLimit?: number;
  defaultContextLimit?: number;
  charPerToken?: number;
  maxReadRatio?: number;
  minRemainingRatio?: number;
  outputBudget?: number;
  reasoningBudget?: number;
  smallContext?: SmallContextConfig | null;
}

function getConfiguredLocalContextLimit(hookConfig?: ContextBudgetConfig): number | undefined {
  return hookConfig?.localContextLimit;
}

function getFallbackBudgetLimit(hookConfig?: ContextBudgetConfig): number {
  const resolution = resolveContextLimit({
    localContextLimit: getConfiguredLocalContextLimit(hookConfig),
    smallContext: hookConfig?.smallContext,
  });
  return (
    resolution.limit ??
    hookConfig?.defaultContextLimit ??
    hookConfig?.smallContext?.autoThreshold ??
    config.localLLM.defaultContextLimit
  );
}

function resolveSessionContextResolution(
  modelID: string,
  providerID: string,
  existing: SessionBudgetState | undefined,
  hookConfig?: ContextBudgetConfig,
): ContextLimitResolution {
  if (modelID || providerID) {
    return resolveContextLimit({
      modelID,
      providerID,
      modelContextLimits: hookConfig?.modelContextLimits,
      localContextLimit: getConfiguredLocalContextLimit(hookConfig),
      smallContext: hookConfig?.smallContext,
    });
  }

  return (
    existing?.contextResolution ??
    resolveContextLimit({
      localContextLimit: getConfiguredLocalContextLimit(hookConfig),
      smallContext: hookConfig?.smallContext,
    })
  );
}

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
  const existing = sessions.get(sessionID);
  const contextResolution = resolveSessionContextResolution(modelID, providerID, existing, hookConfig);
  const contextLimit = contextResolution.limit ?? existing?.tokenUsage.limit ?? getFallbackBudgetLimit(hookConfig);
  const used = Math.max(totalUsed, existing?.tokenUsage.used ?? 0);
  const limit = contextLimit;

  sessions.set(sessionID, {
    tokenUsage: { used, limit, lastUpdated: Date.now() },
    modelID,
    providerID,
    contextResolution,
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
  const limit = state?.tokenUsage.limit ?? getFallbackBudgetLimit(hookConfig);
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

function getSmallContextConfig(hookConfig?: ContextBudgetConfig): SmallContextConfig {
  return hookConfig?.smallContext ?? config.smallContext;
}

function isSmallContextBudgetActive(session: SessionBudgetState | null, smallContext: SmallContextConfig): boolean {
  if (smallContext.mode === "off") {
    return false;
  }

  if (smallContext.mode === "on") {
    return true;
  }

  const limit = session?.contextResolution.limit;
  if (!session?.contextResolution.resolved || limit == null) {
    return false;
  }

  return limit <= smallContext.autoThreshold;
}

function getBudgetState(
  sessionID: string,
  sessions: Map<string, SessionBudgetState>,
  hookConfig?: ContextBudgetConfig,
): { used: number; limit: number; remaining: number; session: SessionBudgetState | null } {
  const session = sessions.get(sessionID) ?? null;
  const limit = session?.tokenUsage.limit ?? getFallbackBudgetLimit(hookConfig);
  const used = session?.tokenUsage.used ?? 0;
  return { used, limit, remaining: limit - used, session };
}

function countMixedTools(plannedTools: readonly string[] | undefined): number {
  const tools = new Set<string>();
  for (const toolName of plannedTools ?? []) {
    const normalized = toolName.trim().toLowerCase();
    if (normalized.length > 0) {
      tools.add(normalized);
    }
  }
  return tools.size;
}

function getExpectedToolCalls(options: FanoutOptions, mixedToolCount: number): number {
  return Math.max(options.expectedToolCalls ?? 0, mixedToolCount);
}

function isBroadInvestigationType(type: InvestigationType | undefined): boolean {
  return type === "broad_exploration" || type === "architecture_trace" || type === "pattern_search";
}

function isLargeFileEstimate(estimate: FileCostEstimate, limit: number): boolean {
  const threshold = Math.max(FANOUT_LARGE_FILE_MIN_TOKENS, Math.floor(limit * FANOUT_LARGE_FILE_RATIO));
  return estimate.estimated >= threshold;
}

function countFanoutSignals(
  fileCount: number,
  extrapolatedFileCount: number,
  largeFileCount: number,
  expectedToolCalls: number,
  mixedToolCount: number,
  broadInvestigation: boolean,
): number {
  let signals = 0;
  if (fileCount >= FANOUT_FILE_THRESHOLD) signals++;
  if (extrapolatedFileCount > 0 || largeFileCount > 0) signals++;
  if (expectedToolCalls >= FANOUT_TOOL_CALL_THRESHOLD) signals++;
  if (expectedToolCalls >= FANOUT_MIXED_TOOL_THRESHOLD && mixedToolCount >= FANOUT_MIXED_TOOL_THRESHOLD) signals++;
  if (broadInvestigation) signals++;
  return signals;
}

function getInvestigationReason(
  broadInvestigation: boolean,
  continuingAfterCompaction: boolean | undefined,
): string | null {
  if (!broadInvestigation) {
    return null;
  }
  return continuingAfterCompaction
    ? "this is the first broad investigation after compaction or resume"
    : "the investigation is broad rather than targeted";
}

function buildFanoutReasons(
  readDecision: ReadDecision,
  tightHeadroom: boolean,
  fileCount: number,
  extrapolatedFileCount: number,
  largeFileCount: number,
  expectedToolCalls: number,
  mixedToolCount: number,
  broadInvestigation: boolean,
  continuingAfterCompaction: boolean | undefined,
): string[] {
  return [
    readDecision === "delegation_needed" ? "estimated read cost already exceeds direct budget" : null,
    tightHeadroom ? "remaining context headroom is tight" : null,
    fileCount >= FANOUT_FILE_THRESHOLD ? `investigation spans ${fileCount} files` : null,
    largeFileCount > 0 ? `${largeFileCount} file estimate(s) are large` : null,
    extrapolatedFileCount > 0 ? "one or more file sizes are extrapolated" : null,
    expectedToolCalls >= FANOUT_TOOL_CALL_THRESHOLD ? `${expectedToolCalls} tool calls are planned` : null,
    expectedToolCalls >= FANOUT_MIXED_TOOL_THRESHOLD && mixedToolCount >= FANOUT_MIXED_TOOL_THRESHOLD
      ? `${mixedToolCount} tool types are mixed in one investigation`
      : null,
    getInvestigationReason(broadInvestigation, continuingAfterCompaction),
  ].filter((reason): reason is string => reason !== null);
}

function decideFanout(
  active: boolean,
  readDecision: ReadDecision,
  tightHeadroom: boolean,
  signalCount: number,
  continuingAfterCompaction: boolean | undefined,
  broadInvestigation: boolean,
): FanoutDecision {
  if (!active) {
    return "direct_ok";
  }

  if (readDecision === "delegation_needed") {
    return "fanout_required";
  }

  if (continuingAfterCompaction && broadInvestigation) {
    return "fanout_required";
  }

  if (tightHeadroom && signalCount > 0) {
    return "fanout_required";
  }

  if (signalCount >= FANOUT_REQUIRED_SIGNAL_COUNT) {
    return "fanout_required";
  }

  if (signalCount > 0) {
    return "fanout_recommended";
  }

  return "direct_ok";
}

interface FanoutMetrics {
  mixedToolCount: number;
  expectedToolCalls: number;
  extrapolatedFileCount: number;
  largeFileCount: number;
  broadInvestigation: boolean;
  signalCount: number;
  tightHeadroom: boolean;
}

function buildFanoutMetrics(
  opts: FanoutOptions,
  estimate: ReadCostEstimate,
  budgetLimit: number,
  budgetRemaining: number,
  readDecision: ReadDecision,
): FanoutMetrics {
  const mixedToolCount = countMixedTools(opts.plannedTools);
  const expectedToolCalls = getExpectedToolCalls(opts, mixedToolCount);
  const extrapolatedFileCount = estimate.files.filter((item) => item.method === "extrapolate").length;
  const largeFileCount = estimate.files.filter((item) => isLargeFileEstimate(item, budgetLimit)).length;
  const broadInvestigation = isBroadInvestigationType(opts.investigationType);
  return {
    mixedToolCount,
    expectedToolCalls,
    extrapolatedFileCount,
    largeFileCount,
    broadInvestigation,
    signalCount: countFanoutSignals(
      estimate.files.length,
      extrapolatedFileCount,
      largeFileCount,
      expectedToolCalls,
      mixedToolCount,
      broadInvestigation,
    ),
    tightHeadroom:
      readDecision === "tight" || budgetRemaining / Math.max(1, budgetLimit) <= FANOUT_TIGHT_REMAINING_RATIO,
  };
}

function createFanoutAssessment(
  active: boolean,
  opts: FanoutOptions,
  estimate: ReadCostEstimate,
  readResult: CanReadResult,
  metrics: FanoutMetrics,
): FanoutAssessment {
  return {
    active,
    decision: decideFanout(
      active,
      readResult.decision,
      metrics.tightHeadroom,
      metrics.signalCount,
      opts.continuingAfterCompaction,
      metrics.broadInvestigation,
    ),
    reasons: buildFanoutReasons(
      readResult.decision,
      metrics.tightHeadroom,
      estimate.files.length,
      metrics.extrapolatedFileCount,
      metrics.largeFileCount,
      metrics.expectedToolCalls,
      metrics.mixedToolCount,
      metrics.broadInvestigation,
      opts.continuingAfterCompaction,
    ),
    estimatedCost: estimate.total,
    fileEstimates: estimate.files,
    readDecision: readResult.decision,
    fileCount: estimate.files.length,
    extrapolatedFileCount: metrics.extrapolatedFileCount,
    largeFileCount: metrics.largeFileCount,
    expectedToolCalls: metrics.expectedToolCalls,
    mixedToolCount: metrics.mixedToolCount,
    remaining: readResult.remaining,
    availableBudget: readResult.availableBudget,
  };
}

async function handleAssessFanout(
  sessionID: string,
  opts: FanoutOptions,
  sessions: Map<string, SessionBudgetState>,
  charPerToken: number,
  hookConfig?: ContextBudgetConfig,
): Promise<FanoutAssessment> {
  const files = opts.files ? [...opts.files] : [];
  const estimate = await handleEstimateReadCost(files, charPerToken);
  const readResult = handleCanRead(sessionID, estimate.total, opts, sessions, hookConfig);
  const budgetState = getBudgetState(sessionID, sessions, hookConfig);
  const smallContext = getSmallContextConfig(hookConfig);
  const active = isSmallContextBudgetActive(budgetState.session, smallContext);
  const metrics = buildFanoutMetrics(opts, estimate, budgetState.limit, budgetState.remaining, readResult.decision);
  return createFanoutAssessment(active, opts, estimate, readResult, metrics);
}

function buildOutputGovernorState(
  reason: OutputGovernorReason,
  mode: SmallContextConfig["mode"],
  budgetState: { used: number; limit: number; remaining: number },
  reserveTokens: number,
  charPerToken: number,
): OutputGovernorState {
  return {
    active: reason === "active",
    reason,
    mode,
    used: budgetState.used,
    limit: budgetState.limit,
    remaining: budgetState.remaining,
    reserveTokens,
    availableTokens: Math.max(0, budgetState.remaining - reserveTokens),
    charPerToken,
  };
}

function getOutputGovernorReason(
  session: SessionBudgetState | null,
  smallContext: SmallContextConfig,
): OutputGovernorReason {
  if (!smallContext.outputGovernor.enabled) {
    return "disabled";
  }

  if (smallContext.mode === "off") {
    return "mode_off";
  }

  if (smallContext.mode === "on") {
    return "active";
  }

  if (!session) {
    return "session_untracked";
  }

  if (!session.contextResolution.resolved || session.contextResolution.limit === null) {
    return "unknown_model";
  }

  return isSmallContextBudgetActive(session, smallContext) ? "active" : "non_small_context";
}

function handleGetOutputGovernorState(
  sessionID: string,
  sessions: Map<string, SessionBudgetState>,
  charPerToken: number,
  hookConfig?: ContextBudgetConfig,
): OutputGovernorState {
  const smallContext = getSmallContextConfig(hookConfig);
  const budgetState = getBudgetState(sessionID, sessions, hookConfig);
  const reserveTokens = smallContext.outputGovernor.reserveTokens;
  const reason = getOutputGovernorReason(budgetState.session, smallContext);
  return buildOutputGovernorState(reason, smallContext.mode, budgetState, reserveTokens, charPerToken);
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
    assessFanout: async (sessionID, opts) => handleAssessFanout(sessionID, opts, sessions, charPerToken, hookConfig),
    getBudget: (sessionID) => handleGetBudget(sessionID, sessions),
    getOutputGovernorState: (sessionID) => handleGetOutputGovernorState(sessionID, sessions, charPerToken, hookConfig),
  };
}
