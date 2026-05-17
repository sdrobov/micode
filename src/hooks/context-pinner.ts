// src/hooks/context-pinner.ts
// Captures session goals and periodically re-injects context reminders
import { config } from "@/utils/config";

const MAX_SNIPPET_LENGTH = 500;
const NOT_CAPTURED = "(not captured yet)";

interface SessionPinnerState {
  goal: string;
  plan: string;
  dod: string;
  completed: string[];
  messageCount: number;
  lastReminderIndex: number;
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
  let state = sessions.get(id);
  if (state) return state;

  state = {
    goal: "",
    plan: "",
    dod: "",
    completed: [],
    messageCount: 0,
    lastReminderIndex: 0,
    pendingPostCompaction: false,
  };
  sessions.set(id, state);
  return state;
}

function buildReminder(sessionID: string, state: SessionPinnerState): string {
  const goal = state.goal || NOT_CAPTURED;
  const plan = state.plan || NOT_CAPTURED;
  const dod = state.dod || NOT_CAPTURED;
  const completed = state.completed.length > 0 ? state.completed.join(", ") : "(none)";

  return `<context-reminder session="${sessionID}">
  Original goal: ${goal}
  Plan: ${plan}
  DoD remaining: ${dod}
  Completed: ${completed}
  This is a periodic context reminder. Do not restart — continue the current plan.
</context-reminder>`;
}

function extractText(parts?: Array<{ type: string; text?: string }>): string {
  return (
    parts
      ?.filter((p) => p.type === "text")
      .map((p) => p.text)
      .join(" ") || ""
  );
}

function extractGoalMetadata(text: string, state: SessionPinnerState): void {
  const planMatch = text.match(/plan[:\s]+(.+?)(?:dod|doctrine|$)/i);
  if (planMatch) {
    state.plan = planMatch[1].trim().slice(0, MAX_SNIPPET_LENGTH);
  }

  const dodMatch = text.match(/(?:dod|definition of done)[:\s]+(.+?)(?:$)/i);
  if (dodMatch) {
    state.dod = dodMatch[1].trim().slice(0, MAX_SNIPPET_LENGTH);
  }
}

function handleSessionDeleted(
  sessions: Map<string, SessionPinnerState>,
  props: Record<string, unknown> | undefined,
): void {
  const sessionInfo = props?.info as { id?: string } | undefined;
  if (!sessionInfo?.id) return;
  sessions.delete(sessionInfo.id);
}

function handleMessageUpdated(
  sessions: Map<string, SessionPinnerState>,
  props: Record<string, unknown> | undefined,
): void {
  const info = props?.info as Record<string, unknown> | undefined;
  const sessionID = info?.sessionID as string | undefined;
  if (!sessionID) return;
  if (info?.summary !== true) return;

  const state = sessions.get(sessionID);
  if (!state) return;
  state.pendingPostCompaction = true;
}

function injectReminder(sessionID: string, state: SessionPinnerState, output: { system?: string }): void {
  if (!output.system) return;
  const reminder = buildReminder(sessionID, state);
  output.system = `${output.system}\n\n${reminder}`;
}

function createMessageHandler(
  sessions: Map<string, SessionPinnerState>,
): (
  input: { sessionID: string; parts?: Array<{ type: string; text?: string }> },
  output: { parts?: Array<{ type: string; text?: string }> },
) => Promise<void> {
  return async (input, _output) => {
    const state = getOrCreateSession(sessions, input.sessionID);
    state.messageCount++;

    const text = extractText(input.parts);
    if (state.goal || !text) return;

    state.goal = text.slice(0, MAX_SNIPPET_LENGTH);
    extractGoalMetadata(text, state);
  };
}

function createParamsHandler(
  sessions: Map<string, SessionPinnerState>,
): (input: { sessionID: string }, output: { options?: Record<string, unknown>; system?: string }) => Promise<void> {
  return async (input, output) => {
    const state = getOrCreateSession(sessions, input.sessionID);

    if (state.pendingPostCompaction) {
      injectReminder(input.sessionID, state, output);
      state.pendingPostCompaction = false;
      return;
    }

    if (state.messageCount > 0 && state.messageCount % config.localLLM.reminderInterval === 0) {
      injectReminder(input.sessionID, state, output);
    }
  };
}

function createEventHandler(
  sessions: Map<string, SessionPinnerState>,
): (input: { event: { type: string; properties?: unknown } }) => Promise<void> {
  return async ({ event }) => {
    const props = event.properties as Record<string, unknown> | undefined;

    if (event.type === "session.deleted") {
      handleSessionDeleted(sessions, props);
      return;
    }

    if (event.type === "message.updated") {
      handleMessageUpdated(sessions, props);
    }
  };
}

function createCompactingHandler(): (
  input: { sessionID: string },
  output: { context?: string[]; prompt?: string },
) => Promise<void> {
  return async (_input, output) => {
    if (output.prompt && !output.prompt.includes("Goal")) {
      output.prompt = `${output.prompt}\n\nIMPORTANT: Preserve the original goal, plan, and DoD in the summary.`;
    }
  };
}

export function createContextPinnerHook(): ContextPinnerHooks {
  const sessions = new Map<string, SessionPinnerState>();
  return {
    "chat.message": createMessageHandler(sessions),
    "chat.params": createParamsHandler(sessions),
    event: createEventHandler(sessions),
    "experimental.session.compacting": createCompactingHandler(),
  };
}
