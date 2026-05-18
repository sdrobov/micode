import type { PluginInput } from "@opencode-ai/plugin";

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

const RECOVERABLE_ERRORS = {
  TOOL_RESULT_MISSING: "tool_result block(s) missing",
  THINKING_BLOCK_ORDER: "thinking blocks must be at the start",
  THINKING_DISABLED: "thinking is not enabled",
  EMPTY_CONTENT: "content cannot be empty",
  INVALID_TOOL_RESULT: "tool_result must follow tool_use",
} as const;

type RecoverableErrorType = keyof typeof RECOVERABLE_ERRORS;

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
  for (const [type, pattern] of Object.entries(RECOVERABLE_ERRORS)) {
    if (errorMessage.includes(pattern.toLowerCase())) {
      return type as RecoverableErrorType;
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

function buildResumePrompt(rc: RecoveryContext, sessionID: string): string {
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

async function resumeSession(
  rc: RecoveryContext,
  sessionID: string,
  providerID?: string,
  modelID?: string,
  agent?: string,
): Promise<void> {
  try {
    const messages = await getSessionMessages(rc, sessionID);
    const summaryText = extractLatestSummary(messages);
    if (summaryText) {
      mergeSessionContinuitySummary(sessionID, summaryText, getContinuityAnchorBudget(rc.hookConfig));
    }

    await rc.ctx.client.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [{ type: "text", text: buildResumePrompt(rc, sessionID) }],
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
  errorType: RecoverableErrorType,
  providerID?: string,
  modelID?: string,
  agent?: string,
): Promise<boolean> {
  const recoveryKey = `${sessionID}:${errorType}`;
  const attempts = rc.state.recoveryAttempts.get(recoveryKey) || 0;
  if (attempts >= MAX_RECOVERY_ATTEMPTS) {
    showToast(
      rc,
      "Recovery Failed",
      `Max attempts reached for ${errorType}. Manual intervention needed.`,
      "error",
      TOAST_FAILURE_DURATION_MS,
    );
    return false;
  }

  rc.state.recoveryAttempts.set(recoveryKey, attempts + 1);
  showToast(
    rc,
    "Session Recovery",
    `Recovering from ${errorType.toLowerCase().replace(/_/g, " ")}...`,
    "warning",
    RECOVERY_TOAST_DURATION_MS,
  );

  await abortSession(rc, sessionID);
  await new Promise((resolve) => setTimeout(resolve, ABORT_SETTLE_DELAY_MS));
  await resumeSession(rc, sessionID, providerID, modelID, agent);

  showToast(rc, "Recovery Complete", "Session resumed. Continuing...", "success", RECOVERY_TOAST_DURATION_MS);
  return true;
}

function cleanupSession(state: RecoveryState, sessionID: string): void {
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

async function handleSessionError(rc: RecoveryContext, props: Record<string, unknown> | undefined): Promise<void> {
  const sessionID = props?.sessionID as string | undefined;
  const error = props?.error;
  if (!sessionID || !error) return;

  const errorType = classifyError(error);
  if (!errorType || !deduplicateError(rc.state, sessionID, errorType)) return;

  await attemptRecovery(rc, sessionID, errorType);
}

async function handleMessageError(rc: RecoveryContext, props: Record<string, unknown> | undefined): Promise<void> {
  const info = props?.info as Record<string, unknown> | undefined;
  const sessionID = info?.sessionID as string | undefined;
  const error = info?.error;
  if (!sessionID || !error) return;

  const providerID = info.providerID as string | undefined;
  const modelID = info.modelID as string | undefined;
  updateSessionContinuityProfile(sessionID, modelID ?? "", providerID ?? "", rc.hookConfig);

  const errorType = classifyError(error);
  if (!errorType || !deduplicateError(rc.state, sessionID, errorType)) return;

  const agent = info.agent as string | undefined;
  await attemptRecovery(rc, sessionID, errorType, providerID, modelID, agent);
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
