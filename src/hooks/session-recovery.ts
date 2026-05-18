import type { PluginInput } from "@opencode-ai/plugin";

import {
  type ContinuityHookConfig,
  clearSessionContinuity,
  formatResumeContinuityPrompt,
  getContinuityAnchorBudget,
  getSessionContinuityAnchor,
  isContinuityAnchorActive,
  mergeSessionContinuityAnchor,
  mergeSessionContinuitySummary,
  updateSessionContinuityProfile,
} from "./continuity-anchor";
import {
  activateOverflowRecovery,
  clearOverflowRecoverySession,
  deactivateOverflowRecovery,
  escalateOverflowRecovery,
  isOverflowRecoveryActive,
  OVERFLOW_RECOVERY_SOURCES,
} from "./overflow-recovery-state";

const RECOVERY_KINDS = {
  PROTOCOL: "protocol",
  OVERFLOW: "overflow",
} as const;

const RECOVERABLE_ERRORS = {
  TOOL_RESULT_MISSING: {
    kind: RECOVERY_KINDS.PROTOCOL,
    label: "missing tool result block",
    patterns: [/tool_result block\(s\) missing/i],
  },
  THINKING_BLOCK_ORDER: {
    kind: RECOVERY_KINDS.PROTOCOL,
    label: "thinking block order",
    patterns: [/thinking blocks must be at the start/i],
  },
  THINKING_DISABLED: {
    kind: RECOVERY_KINDS.PROTOCOL,
    label: "thinking disabled",
    patterns: [/thinking is not enabled/i],
  },
  EMPTY_CONTENT: {
    kind: RECOVERY_KINDS.PROTOCOL,
    label: "empty content",
    patterns: [/content cannot be empty/i],
  },
  INVALID_TOOL_RESULT: {
    kind: RECOVERY_KINDS.PROTOCOL,
    label: "invalid tool result order",
    patterns: [/tool_result must follow tool_use/i],
  },
  CONTEXT_OVERFLOW: {
    kind: RECOVERY_KINDS.OVERFLOW,
    label: "context overflow",
    patterns: [
      /\bcontext(?: size| length| window)?\b[\s\S]{0,40}\b(exceed(?:ed|s)?|overflow|too (?:large|long)|limit)\b/i,
      /\bmaximum context length\b/i,
      /\bcontext_length_exceeded\b/i,
      /\b(prompt|input|request)\b[\s\S]{0,40}\b(too (?:long|large)|exceed(?:ed|s)?)\b/i,
      /\btoo many tokens\b/i,
      /\btokens?\b[\s\S]{0,40}\bexceed(?:ed|s)?\b[\s\S]{0,40}\b(context|limit|maximum)\b/i,
    ],
  },
} as const;

type RecoverableErrorType = keyof typeof RECOVERABLE_ERRORS;
type RecoveryKind = (typeof RECOVERY_KINDS)[keyof typeof RECOVERY_KINDS];

interface RecoverableErrorMatch {
  readonly type: RecoverableErrorType;
  readonly kind: RecoveryKind;
  readonly label: string;
}

interface RecoveryState {
  processingErrors: Set<string>;
  recoveryAttempts: Map<string, number>;
}

interface RecoveryContext {
  ctx: PluginInput;
  state: RecoveryState;
  hookConfig?: ContinuityHookConfig;
}

const MAX_RECOVERY_ATTEMPTS = 3;
const ABORT_SETTLE_DELAY_MS = 500;
const RECOVERY_TOAST_DURATION_MS = 3000;
const TOAST_FAILURE_DURATION_MS = 5000;
const ERROR_KEY_EXPIRY_MS = 10000;

function extractErrorInfo(error: unknown): { message: string; messageIndex?: number } | null {
  if (!error) return null;

  let errorMessage = JSON.stringify(error);
  if (typeof error === "string") {
    errorMessage = error;
  } else if (error instanceof Error) {
    errorMessage = error.message;
  }

  const messageIndex = errorMessage.match(/messages?[.\s](\d+)/i)?.[1];

  return {
    message: errorMessage.toLowerCase(),
    messageIndex: messageIndex ? parseInt(messageIndex, 10) : undefined,
  };
}

function identifyErrorType(errorMessage: string): RecoverableErrorType | null {
  const recoverableErrors = Object.entries(RECOVERABLE_ERRORS) as Array<
    [RecoverableErrorType, (typeof RECOVERABLE_ERRORS)[RecoverableErrorType]]
  >;

  for (const [type, rule] of recoverableErrors) {
    if (rule.patterns.some((pattern) => pattern.test(errorMessage))) {
      return type;
    }
  }

  return null;
}

async function getSessionMessages(rc: RecoveryContext, sessionID: string): Promise<unknown[]> {
  try {
    const resp = await rc.ctx.client.session.messages({
      path: { id: sessionID },
      query: { directory: rc.ctx.directory },
    });
    return (resp as { data?: unknown[] }).data || [];
  } catch {
    return [];
  }
}

async function abortSession(rc: RecoveryContext, sessionID: string): Promise<void> {
  try {
    await rc.ctx.client.session.abort({
      path: { id: sessionID },
      query: { directory: rc.ctx.directory },
    });
  } catch {
    // Ignore abort errors
  }
}

function extractLatestSummary(messages: readonly unknown[]): string | null {
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

function buildProtocolResumePrompt(rc: RecoveryContext, sessionID: string): string {
  if (!isContinuityAnchorActive(sessionID)) {
    return "Continue from where you left off.";
  }

  return formatResumeContinuityPrompt(
    sessionID,
    getSessionContinuityAnchor(sessionID),
    getContinuityAnchorBudget(rc.hookConfig),
    "Recover the session from this continuity anchor.",
  );
}

function buildOverflowResumePrompt(rc: RecoveryContext, sessionID: string): string {
  return formatResumeContinuityPrompt(
    sessionID,
    getSessionContinuityAnchor(sessionID),
    getContinuityAnchorBudget(rc.hookConfig),
    "Context overflowed. Resume from this continuity anchor.",
  );
}

function buildResumePrompt(rc: RecoveryContext, sessionID: string, recoveryKind: RecoveryKind): string {
  if (recoveryKind === RECOVERY_KINDS.OVERFLOW) {
    return buildOverflowResumePrompt(rc, sessionID);
  }

  return buildProtocolResumePrompt(rc, sessionID);
}

function getPreservedContinuityProgress(sessionID: string): { acceptedPlan: string; currentStep: string } | null {
  const anchor = getSessionContinuityAnchor(sessionID);
  if (!anchor?.acceptedPlan && !anchor?.currentStep) return null;

  return {
    acceptedPlan: anchor?.acceptedPlan ?? "",
    currentStep: anchor?.currentStep ?? "",
  };
}

function mergeLatestSummaryIntoContinuity(
  rc: RecoveryContext,
  sessionID: string,
  summaryText: string,
  recoveryKind: RecoveryKind,
): void {
  const budgetTokens = getContinuityAnchorBudget(rc.hookConfig);
  const preservedProgress = recoveryKind === RECOVERY_KINDS.OVERFLOW ? getPreservedContinuityProgress(sessionID) : null;

  mergeSessionContinuitySummary(sessionID, summaryText, budgetTokens);
  if (!preservedProgress) return;

  mergeSessionContinuityAnchor(sessionID, preservedProgress, budgetTokens);
}

function updateOverflowRecoveryState(sessionID: string): void {
  if (isOverflowRecoveryActive(sessionID)) {
    escalateOverflowRecovery(sessionID, OVERFLOW_RECOVERY_SOURCES.SESSION_RECOVERY);
    return;
  }

  activateOverflowRecovery(sessionID, OVERFLOW_RECOVERY_SOURCES.SESSION_RECOVERY);
}

async function resumeSession(
  rc: RecoveryContext,
  sessionID: string,
  recoveryKind: RecoveryKind,
  providerID?: string,
  modelID?: string,
  agent?: string,
): Promise<void> {
  try {
    const messages = await getSessionMessages(rc, sessionID);
    const summaryText = extractLatestSummary(messages);
    if (summaryText) {
      mergeLatestSummaryIntoContinuity(rc, sessionID, summaryText, recoveryKind);
    }

    await rc.ctx.client.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [{ type: "text", text: buildResumePrompt(rc, sessionID, recoveryKind) }],
        ...(providerID && modelID ? { providerID, modelID } : {}),
        ...(agent ? { agent } : {}),
      },
      query: { directory: rc.ctx.directory },
    });
  } catch {
    // Resume failed, user will need to continue manually
  }
}

function showToast(
  rc: RecoveryContext,
  title: string,
  message: string,
  variant: "info" | "success" | "warning" | "error",
  duration: number,
): void {
  rc.ctx.client.tui.showToast({ body: { title, message, variant, duration } }).catch((_e: unknown) => {
    /* fire-and-forget */
  });
}

async function attemptRecovery(
  rc: RecoveryContext,
  sessionID: string,
  errorMatch: RecoverableErrorMatch,
  providerID?: string,
  modelID?: string,
  agent?: string,
): Promise<boolean> {
  const recoveryKey = `${sessionID}:${errorMatch.type}`;
  const attempts = rc.state.recoveryAttempts.get(recoveryKey) || 0;
  if (attempts >= MAX_RECOVERY_ATTEMPTS) {
    showToast(
      rc,
      "Recovery Failed",
      `Max attempts reached for ${errorMatch.label}. Manual intervention needed.`,
      "error",
      TOAST_FAILURE_DURATION_MS,
    );
    return false;
  }

  rc.state.recoveryAttempts.set(recoveryKey, attempts + 1);
  if (errorMatch.kind === RECOVERY_KINDS.OVERFLOW) {
    updateOverflowRecoveryState(sessionID);
  }

  showToast(rc, "Session Recovery", `Recovering from ${errorMatch.label}...`, "warning", RECOVERY_TOAST_DURATION_MS);

  await abortSession(rc, sessionID);
  await new Promise((resolve) => setTimeout(resolve, ABORT_SETTLE_DELAY_MS));
  await resumeSession(rc, sessionID, errorMatch.kind, providerID, modelID, agent);

  showToast(rc, "Recovery Complete", "Session resumed. Continuing...", "success", RECOVERY_TOAST_DURATION_MS);
  return true;
}

function cleanupSession(state: RecoveryState, sessionID: string): void {
  clearOverflowRecoverySession(sessionID);

  for (const key of state.recoveryAttempts.keys()) {
    if (key.startsWith(`${sessionID}:`)) {
      state.recoveryAttempts.delete(key);
    }
  }

  for (const key of state.processingErrors) {
    if (key.startsWith(`${sessionID}:`)) {
      state.processingErrors.delete(key);
    }
  }
}

function deduplicateError(state: RecoveryState, sessionID: string, errorType: RecoverableErrorType): boolean {
  const errorKey = `${sessionID}:${errorType}`;
  if (state.processingErrors.has(errorKey)) return false;

  state.processingErrors.add(errorKey);
  setTimeout(() => state.processingErrors.delete(errorKey), ERROR_KEY_EXPIRY_MS);
  return true;
}

function classifyError(error: unknown): RecoverableErrorType | null {
  const errorInfo = extractErrorInfo(error);
  if (!errorInfo) return null;
  return identifyErrorType(errorInfo.message);
}

function getRecoverableErrorMatch(error: unknown): RecoverableErrorMatch | null {
  const errorType = classifyError(error);
  if (!errorType) return null;

  const rule = RECOVERABLE_ERRORS[errorType];
  return {
    type: errorType,
    kind: rule.kind,
    label: rule.label,
  };
}

function handleSuccessfulAssistantMessage(info: Record<string, unknown> | undefined): void {
  const sessionID = info?.sessionID as string | undefined;
  if (!sessionID || info?.role !== "assistant") return;
  if (!isOverflowRecoveryActive(sessionID)) return;
  deactivateOverflowRecovery(sessionID);
}

async function handleSessionError(rc: RecoveryContext, props: Record<string, unknown> | undefined): Promise<void> {
  const sessionID = props?.sessionID as string | undefined;
  const error = props?.error;
  if (!sessionID || !error) return;

  const errorMatch = getRecoverableErrorMatch(error);
  if (!errorMatch || !deduplicateError(rc.state, sessionID, errorMatch.type)) return;

  await attemptRecovery(rc, sessionID, errorMatch);
}

async function handleMessageError(rc: RecoveryContext, props: Record<string, unknown> | undefined): Promise<void> {
  const info = props?.info as Record<string, unknown> | undefined;
  const sessionID = info?.sessionID as string | undefined;
  if (!sessionID) return;

  const error = info?.error;
  if (!error) {
    handleSuccessfulAssistantMessage(info);
    return;
  }

  const providerID = info.providerID as string | undefined;
  const modelID = info.modelID as string | undefined;
  updateSessionContinuityProfile(sessionID, modelID ?? "", providerID ?? "", rc.hookConfig);

  const errorMatch = getRecoverableErrorMatch(error);
  if (!errorMatch || !deduplicateError(rc.state, sessionID, errorMatch.type)) return;

  const agent = info.agent as string | undefined;
  await attemptRecovery(rc, sessionID, errorMatch, providerID, modelID, agent);
}

interface SessionRecoveryHooks {
  event: (input: { event: { type: string; properties?: unknown } }) => Promise<void>;
}

export function createSessionRecoveryHook(ctx: PluginInput, hookConfig?: ContinuityHookConfig): SessionRecoveryHooks {
  const rc: RecoveryContext = {
    ctx,
    state: { processingErrors: new Set(), recoveryAttempts: new Map() },
    hookConfig,
  };

  return {
    event: async ({ event }: { event: { type: string; properties?: unknown } }) => {
      const props = event.properties as Record<string, unknown> | undefined;

      if (event.type === "session.deleted") {
        const sessionInfo = props?.info as { id?: string } | undefined;
        if (!sessionInfo?.id) return;

        cleanupSession(rc.state, sessionInfo.id);
        clearSessionContinuity(sessionInfo.id);
        return;
      }

      if (event.type === "session.error") {
        await handleSessionError(rc, props);
      }

      if (event.type === "message.updated") {
        await handleMessageError(rc, props);
      }
    },
  };
}
