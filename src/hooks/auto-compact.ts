import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PluginInput } from "@opencode-ai/plugin";

import { config } from "@/utils/config";
import { extractErrorMessage } from "@/utils/errors";
import { log } from "@/utils/logger";
import { resolveContextLimit } from "@/utils/model-limits";

import {
  type ContinuityHookConfig,
  clearSessionContinuity,
  formatResumeContinuityPrompt,
  getContinuityAnchorBudget,
  getSessionContinuityAnchor,
  isContinuityAnchorActive,
  mergeSessionContinuitySummary,
  updateSessionContinuityProfile,
} from "./continuity-anchor";

const SESSION_ID_PREFIX_LENGTH = 8;
const PERCENT_MULTIPLIER = 100;
const MAX_ERROR_MESSAGE_LENGTH = 100;

export interface AutoCompactConfig extends ContinuityHookConfig {
  /** Compaction threshold (0-1), defaults to config.compaction.threshold */
  compactionThreshold?: number;
}

interface PendingCompaction {
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface AutoCompactState {
  inProgress: Set<string>;
  lastCompactTime: Map<string, number>;
  pendingCompactions: Map<string, PendingCompaction>;
}

interface AutoCompactHooks {
  event: (input: { event: { type: string; properties?: unknown } }) => Promise<void>;
}

export function createAutoCompactHook(ctx: PluginInput, hookConfig?: AutoCompactConfig): AutoCompactHooks {
  const threshold = hookConfig?.compactionThreshold ?? config.compaction.threshold;

  const state: AutoCompactState = {
    inProgress: new Set(),
    lastCompactTime: new Map(),
    pendingCompactions: new Map(),
  };

  return {
    event: async ({ event }: { event: { type: string; properties?: unknown } }) => {
      const props = event.properties as Record<string, unknown> | undefined;

      if (event.type === "session.deleted") {
        handleSessionDeleted(state, props);
        return;
      }

      if (event.type === "message.updated") {
        await handleMessageUpdated(ctx, state, threshold, hookConfig, props);
      }
    },
  };
}

function handleSessionDeleted(state: AutoCompactState, props: Record<string, unknown> | undefined): void {
  const sessionInfo = props?.info as { id?: string } | undefined;
  if (!sessionInfo?.id) return;

  state.inProgress.delete(sessionInfo.id);
  state.lastCompactTime.delete(sessionInfo.id);
  clearSessionContinuity(sessionInfo.id);
  resolvePendingWithError(state, sessionInfo.id, "Session deleted");
}

function resolvePendingWithError(state: AutoCompactState, sessionID: string, message: string): void {
  const pending = state.pendingCompactions.get(sessionID);
  if (!pending) return;

  clearTimeout(pending.timeoutId);
  state.pendingCompactions.delete(sessionID);
  pending.reject(new Error(message));
}

async function handleMessageUpdated(
  ctx: PluginInput,
  state: AutoCompactState,
  threshold: number,
  hookConfig: AutoCompactConfig | undefined,
  props: Record<string, unknown> | undefined,
): Promise<void> {
  const info = props?.info as Record<string, unknown> | undefined;
  const sessionID = info?.sessionID as string | undefined;
  if (!sessionID || info?.role !== "assistant") return;

  const modelID = (info?.modelID as string) || "";
  const providerID = (info?.providerID as string) || "";
  updateSessionContinuityProfile(sessionID, modelID, providerID, hookConfig);

  if (info?.summary === true) {
    resolvePendingAsComplete(state, sessionID);
    return;
  }

  if (state.pendingCompactions.has(sessionID)) return;

  const usageRatio = computeUsageRatio(info, hookConfig);
  if (usageRatio === null || usageRatio < threshold) return;

  void triggerCompaction(ctx, state, threshold, sessionID, providerID, modelID, usageRatio, hookConfig);
}

function resolvePendingAsComplete(state: AutoCompactState, sessionID: string): void {
  const pending = state.pendingCompactions.get(sessionID);
  if (!pending) return;

  clearTimeout(pending.timeoutId);
  state.pendingCompactions.delete(sessionID);
  pending.resolve();
}

function computeUsageRatio(info: Record<string, unknown>, hookConfig?: AutoCompactConfig): number | null {
  const tokens = info?.tokens as { input?: number; cache?: { read?: number } } | undefined;
  const inputTokens = tokens?.input || 0;
  const cacheRead = tokens?.cache?.read || 0;
  const totalUsed = inputTokens + cacheRead;
  if (totalUsed === 0) return null;

  const modelID = (info?.modelID as string) || "";
  const providerID = (info?.providerID as string) || "";
  const resolution = resolveContextLimit({
    modelID,
    providerID,
    modelContextLimits: hookConfig?.modelContextLimits,
    localContextLimit: hookConfig?.localContextLimit,
    smallContext: hookConfig?.smallContext,
  });
  if (!resolution.resolved || resolution.limit === null) {
    return null;
  }
  return totalUsed / resolution.limit;
}

function waitForCompaction(state: AutoCompactState, sessionID: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      state.pendingCompactions.delete(sessionID);
      reject(new Error("Compaction timed out"));
    }, config.compaction.timeoutMs);

    state.pendingCompactions.set(sessionID, { resolve, reject, timeoutId });
  });
}

async function triggerCompaction(
  ctx: PluginInput,
  state: AutoCompactState,
  threshold: number,
  sessionID: string,
  providerID: string,
  modelID: string,
  usageRatio: number,
  hookConfig?: AutoCompactConfig,
): Promise<void> {
  if (state.inProgress.has(sessionID)) return;

  const lastCompact = state.lastCompactTime.get(sessionID) || 0;
  if (Date.now() - lastCompact < config.compaction.cooldownMs) return;

  state.inProgress.add(sessionID);

  try {
    await showCompactionStartToast(ctx, threshold, usageRatio);
    const compactionPromise = waitForCompaction(state, sessionID);

    await ctx.client.session.summarize({
      path: { id: sessionID },
      body: { providerID, modelID },
      query: { directory: ctx.directory },
    });

    await compactionPromise;
    state.lastCompactTime.set(sessionID, Date.now());

    const summaryText = await writeSummaryToLedger(ctx, sessionID);
    if (summaryText) {
      mergeSessionContinuitySummary(sessionID, summaryText, getContinuityAnchorBudget(hookConfig));
    }

    await showCompactionSuccessToast(ctx);
    await autoContinueAfterCompaction(ctx, sessionID, providerID, modelID, hookConfig);
  } catch (e) {
    await showCompactionErrorToast(ctx, e);
  } finally {
    state.inProgress.delete(sessionID);
  }
}

async function showCompactionStartToast(ctx: PluginInput, threshold: number, usageRatio: number): Promise<void> {
  const usedPercent = Math.round(usageRatio * PERCENT_MULTIPLIER);
  const thresholdPercent = Math.round(threshold * PERCENT_MULTIPLIER);

  await ctx.client.tui
    .showToast({
      body: {
        title: "Auto Compacting",
        message: `Context at ${usedPercent}% (threshold: ${thresholdPercent}%). Summarizing...`,
        variant: "warning",
        duration: config.timeouts.toastWarningMs,
      },
    })
    .catch((_e: unknown) => {
      /* fire-and-forget */
    });
}

async function showCompactionSuccessToast(ctx: PluginInput): Promise<void> {
  await ctx.client.tui
    .showToast({
      body: {
        title: "Compaction Complete",
        message: "Session summarized. Continuing...",
        variant: "success",
        duration: config.timeouts.toastSuccessMs,
      },
    })
    .catch((_e: unknown) => {
      /* fire-and-forget */
    });
}

async function showCompactionErrorToast(ctx: PluginInput, error: unknown): Promise<void> {
  const errorMessage = extractErrorMessage(error);
  await ctx.client.tui
    .showToast({
      body: {
        title: "Compaction Failed",
        message: errorMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH),
        variant: "error",
        duration: config.timeouts.toastErrorMs,
      },
    })
    .catch((_e: unknown) => {
      /* fire-and-forget */
    });
}

function buildAutoContinuePrompt(sessionID: string, hookConfig?: AutoCompactConfig): string {
  if (!isContinuityAnchorActive(sessionID)) {
    return "Context was compacted. Continue from where you left off. Check the summary above first.";
  }

  return formatResumeContinuityPrompt(
    sessionID,
    getSessionContinuityAnchor(sessionID),
    getContinuityAnchorBudget(hookConfig),
    "Context was compacted. Resume from this continuity anchor.",
  );
}

async function autoContinueAfterCompaction(
  ctx: PluginInput,
  sessionID: string,
  providerID: string,
  modelID: string,
  hookConfig?: AutoCompactConfig,
): Promise<void> {
  const text = buildAutoContinuePrompt(sessionID, hookConfig);

  await ctx.client.session
    .prompt({
      path: { id: sessionID },
      body: {
        parts: [{ type: "text", text }],
        model: { providerID, modelID },
      },
      query: { directory: ctx.directory },
    })
    .catch((_e: unknown) => {
      // If auto-continue fails, user can manually prompt
    });
}

async function writeSummaryToLedger(ctx: PluginInput, sessionID: string): Promise<string | null> {
  try {
    const resp = await ctx.client.session.messages({
      path: { id: sessionID },
      query: { directory: ctx.directory },
    });

    const summaryText = extractSummaryText(resp);
    if (!summaryText) return null;

    const ledgerDir = join(ctx.directory, config.paths.ledgerDir);
    await mkdir(ledgerDir, { recursive: true });

    const timestamp = new Date().toISOString();
    const sessionName = sessionID.slice(0, SESSION_ID_PREFIX_LENGTH);
    const ledgerPath = join(ledgerDir, `${config.paths.ledgerPrefix}${sessionName}.md`);
    const ledgerContent = `---
session: ${sessionName}
updated: ${timestamp}
---

${summaryText}
`;

    await writeFile(ledgerPath, ledgerContent, "utf-8");
    return summaryText;
  } catch (error) {
    log.error("auto-compact", "Failed to write ledger", error);
    return null;
  }
}

function extractSummaryText(resp: unknown): string | null {
  const messages = (resp as { data?: unknown[] }).data;
  if (!Array.isArray(messages)) return null;

  const summaryMessage = [...messages].reverse().find((message) => {
    const entry = message as Record<string, unknown>;
    const info = entry.info as Record<string, unknown> | undefined;
    return info?.role === "assistant" && info?.summary === true;
  }) as Record<string, unknown> | undefined;
  if (!summaryMessage) return null;

  const parts = summaryMessage.parts as Array<{ type: string; text?: string }> | undefined;
  if (!parts) return null;

  const text = parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n\n");

  return text.trim() || null;
}
