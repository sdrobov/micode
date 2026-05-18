import { config } from "@/utils/config";

import {
  type ContinuityHookConfig,
  clearSessionContinuity,
  extractContinuityMessageUpdate,
  formatCompactionContinuityContext,
  formatContinuityAnchor,
  getContinuityAnchorBudget,
  getSessionContinuityAnchor,
  isContinuityAnchorActive,
  mergeSessionContinuityAnchor,
  updateSessionContinuityProfile,
} from "./continuity-anchor";

const NOT_CAPTURED = "(not captured yet)";

interface SessionPinnerState {
  dod: string;
  messageCount: number;
  pendingPostCompaction: boolean;
}

export interface ContextPinnerHooks {
  "chat.message": (
    input: { sessionID: string; parts?: Array<{ type: string; text?: string }> },
    output: { parts?: Array<{ type: string; text?: string }> },
  ) => Promise<void>;
  "chat.params": (
    input: { sessionID: string },
    output: { options?: Record<string, unknown>; system?: string },
  ) => Promise<void>;
  event: (input: { event: { type: string; properties?: unknown } }) => Promise<void>;
  "experimental.session.compacting": (
    input: { sessionID: string },
    output: { context?: string[]; prompt?: string },
  ) => Promise<void>;
}

function getOrCreateSession(sessions: Map<string, SessionPinnerState>, id: string): SessionPinnerState {
  const existing = sessions.get(id);
  if (existing) return existing;

  const created = {
    dod: "",
    messageCount: 0,
    pendingPostCompaction: false,
  };
  sessions.set(id, created);
  return created;
}

function extractText(parts?: Array<{ type: string; text?: string }>): string {
  return (
    parts
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ") || ""
  );
}

function extractDod(text: string): string {
  const match = text.match(/(?:dod|definition of done)[:\s]+(.+?)(?:$)/i);
  return match?.[1]?.trim() ?? "";
}

function buildLegacyReminder(sessionID: string, state: SessionPinnerState): string {
  const anchor = getSessionContinuityAnchor(sessionID);
  const goal = anchor?.goal || NOT_CAPTURED;
  const plan = anchor?.acceptedPlan || NOT_CAPTURED;
  const dod = state.dod || NOT_CAPTURED;
  const completed = anchor?.completed.length ? anchor.completed.join(", ") : "(none)";

  return `<context-reminder session="${sessionID}">
  Original goal: ${goal}
  Plan: ${plan}
  DoD remaining: ${dod}
  Completed: ${completed}
  This is a periodic context reminder. Do not restart; continue the current plan.
</context-reminder>`;
}

function buildReminder(sessionID: string, state: SessionPinnerState, hookConfig?: ContinuityHookConfig): string {
  if (!isContinuityAnchorActive(sessionID)) {
    return buildLegacyReminder(sessionID, state);
  }

  const budgetTokens = getContinuityAnchorBudget(hookConfig);
  const anchor = getSessionContinuityAnchor(sessionID);
  return `${formatContinuityAnchor(sessionID, anchor, budgetTokens)}

This is a continuity reminder. Continue the accepted plan and current step.`;
}

function injectReminder(
  sessionID: string,
  state: SessionPinnerState,
  output: { system?: string },
  hookConfig?: ContinuityHookConfig,
): void {
  if (!output.system) return;
  output.system = `${output.system}\n\n${buildReminder(sessionID, state, hookConfig)}`;
}

function handleMessageUpdated(
  sessions: Map<string, SessionPinnerState>,
  hookConfig: ContinuityHookConfig | undefined,
  props: Record<string, unknown> | undefined,
): void {
  const info = props?.info as Record<string, unknown> | undefined;
  const sessionID = info?.sessionID as string | undefined;
  if (!sessionID) return;

  updateSessionContinuityProfile(
    sessionID,
    (info?.modelID as string) || "",
    (info?.providerID as string) || "",
    hookConfig,
  );

  if (info?.summary !== true) return;

  const state = sessions.get(sessionID);
  if (!state) return;
  state.pendingPostCompaction = true;
}

function createMessageHandler(
  sessions: Map<string, SessionPinnerState>,
  hookConfig?: ContinuityHookConfig,
): (
  input: { sessionID: string; parts?: Array<{ type: string; text?: string }> },
  output: { parts?: Array<{ type: string; text?: string }> },
) => Promise<void> {
  return async (input, _output) => {
    const state = getOrCreateSession(sessions, input.sessionID);
    state.messageCount++;

    const text = extractText(input.parts);
    if (!text) return;

    const isInitialCapture = !getSessionContinuityAnchor(input.sessionID)?.goal;
    const update = extractContinuityMessageUpdate(text, isInitialCapture);
    mergeSessionContinuityAnchor(input.sessionID, update, getContinuityAnchorBudget(hookConfig));

    const dod = extractDod(text);
    if (dod) {
      state.dod = dod;
    }
  };
}

function createParamsHandler(
  sessions: Map<string, SessionPinnerState>,
  hookConfig?: ContinuityHookConfig,
): (input: { sessionID: string }, output: { options?: Record<string, unknown>; system?: string }) => Promise<void> {
  return async (input, output) => {
    const state = getOrCreateSession(sessions, input.sessionID);

    if (state.pendingPostCompaction) {
      injectReminder(input.sessionID, state, output, hookConfig);
      state.pendingPostCompaction = false;
      return;
    }

    if (state.messageCount > 0 && state.messageCount % config.localLLM.reminderInterval === 0) {
      injectReminder(input.sessionID, state, output, hookConfig);
    }
  };
}

function createEventHandler(
  sessions: Map<string, SessionPinnerState>,
  hookConfig?: ContinuityHookConfig,
): (input: { event: { type: string; properties?: unknown } }) => Promise<void> {
  return async ({ event }) => {
    const props = event.properties as Record<string, unknown> | undefined;

    if (event.type === "session.deleted") {
      const sessionInfo = props?.info as { id?: string } | undefined;
      if (!sessionInfo?.id) return;
      sessions.delete(sessionInfo.id);
      clearSessionContinuity(sessionInfo.id);
      return;
    }

    if (event.type === "message.updated") {
      handleMessageUpdated(sessions, hookConfig, props);
    }
  };
}

function createCompactingHandler(
  hookConfig?: ContinuityHookConfig,
): (input: { sessionID: string }, output: { context?: string[]; prompt?: string }) => Promise<void> {
  return async (input, output) => {
    if (isContinuityAnchorActive(input.sessionID)) {
      const anchor = getSessionContinuityAnchor(input.sessionID);
      const budgetTokens = getContinuityAnchorBudget(hookConfig);
      output.context = [
        ...(output.context ?? []),
        formatCompactionContinuityContext(input.sessionID, anchor, budgetTokens),
      ];
      return;
    }

    if (output.prompt && !output.prompt.includes("Goal")) {
      output.prompt = `${output.prompt}\n\nIMPORTANT: Preserve the original goal, plan, and DoD in the summary.`;
    }
  };
}

export function createContextPinnerHook(hookConfig?: ContinuityHookConfig): ContextPinnerHooks {
  const sessions = new Map<string, SessionPinnerState>();
  return {
    "chat.message": createMessageHandler(sessions, hookConfig),
    "chat.params": createParamsHandler(sessions, hookConfig),
    event: createEventHandler(sessions, hookConfig),
    "experimental.session.compacting": createCompactingHandler(hookConfig),
  };
}
