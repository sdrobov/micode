import type { PluginInput } from "@opencode-ai/plugin";

import { config } from "@/utils/config";
import { extractErrorMessage } from "@/utils/errors";
import { log } from "@/utils/logger";

export interface ToolLoopGuardConfig {
  abortSettleDelayMs?: number;
  threshold?: number;
  maxInterventions?: number;
}

export interface ToolLoopGuardHooks {
  "tool.execute.after": (
    input: { tool: string; sessionID: string; args?: Record<string, unknown> },
    output: { output?: string },
  ) => Promise<void>;
  cleanupSession: (sessionID: string) => void;
}

interface FailureSnapshot {
  readonly argsPreview: string;
  readonly errorPreview: string;
  readonly signature: string;
  readonly streak: number;
  readonly tool: string;
}

interface SessionState {
  interventions: Map<string, number>;
  lastFailure: FailureSnapshot | null;
}

const ABORT_SETTLE_DELAY_MS = 500;
const OUTPUT_PREVIEW_LIMIT = 240;
const FAILURE_SCAN_LINE_LIMIT = 12;
const TOAST_DURATION_MS = 4000;
const FAILURE_PREFIX_PATTERNS = [
  /^\*\*error\*\*:/i,
  /^error:/i,
  /^failed(?::|\s)/i,
  /^invalid\b/i,
  /^missing\b/i,
  /^unknown\b/i,
  /^no\s.+\s(specified|found)\b/i,
] as const;
const FAILURE_FRAGMENT_PATTERNS = [
  /\bnot found\b/i,
  /\bis required\b/i,
  /\bmust be\b/i,
  /\binvalid\b/i,
  /\bunknown\b/i,
  /\bfailed\b/i,
] as const;

function createSessionState(): SessionState {
  return {
    interventions: new Map(),
    lastFailure: null,
  };
}

function getSessionState(sessions: Map<string, SessionState>, sessionID: string): SessionState {
  const existing = sessions.get(sessionID);
  if (existing) return existing;

  const created = createSessionState();
  sessions.set(sessionID, created);
  return created;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function isPrimitive(value: unknown): value is boolean | number | string | null {
  return value === null || ["boolean", "number", "string"].includes(typeof value);
}

function stringifyNonObject(value: unknown): string {
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return value.description ? `symbol:${value.description}` : "symbol";
  if (typeof value === "bigint") return value.toString();
  return Object.prototype.toString.call(value);
}

function normalizeValue(value: unknown): unknown {
  if (isPrimitive(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry));
  if (!value || typeof value !== "object") return stringifyNonObject(value);

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeValue(entry)]),
  );
}

function normalizeArgs(args: Record<string, unknown> | undefined): string {
  const normalized = normalizeValue(args ?? {});
  return JSON.stringify(normalized);
}

function normalizeFailureText(text: string): string {
  return collapseWhitespace(text).toLowerCase();
}

function matchesFailurePrefix(line: string): boolean {
  return FAILURE_PREFIX_PATTERNS.some((pattern) => pattern.test(line));
}

function matchesFailureFragment(line: string): boolean {
  return FAILURE_FRAGMENT_PATTERNS.some((pattern) => pattern.test(line));
}

function extractTaggedFailure(output: string): string | null {
  const match = output.match(/<error>([\s\S]*?)<\/error>/i);
  return match?.[1] ? collapseWhitespace(match[1]) : null;
}

function shouldSkipFailureScanLine(line: string): boolean {
  return (
    line.startsWith("#") ||
    line.startsWith("```") ||
    line.startsWith("<") ||
    /^\d+[.|]/.test(line) ||
    /^\d+\|/.test(line)
  );
}

function collectCandidateLines(output: string): string[] {
  const candidates: string[] = [];
  let insideCodeBlock = false;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("```")) {
      insideCodeBlock = !insideCodeBlock;
      continue;
    }
    if (insideCodeBlock || shouldSkipFailureScanLine(line)) continue;

    candidates.push(line);
    if (candidates.length >= FAILURE_SCAN_LINE_LIMIT) break;
  }

  return candidates;
}

function findFailureLine(output: string): string | null {
  const lines = collectCandidateLines(output);
  const exact = lines.find((line) => matchesFailurePrefix(line));
  if (exact) return exact;

  const partial = lines.find((line) => matchesFailureFragment(line));
  return partial ?? null;
}

function extractFailureFingerprint(output: string | undefined): string | null {
  if (!output) return null;

  const taggedFailure = extractTaggedFailure(output);
  if (taggedFailure) return normalizeFailureText(taggedFailure);

  const failureLine = findFailureLine(output);
  return failureLine ? normalizeFailureText(failureLine) : null;
}

function buildSignature(tool: string, args: Record<string, unknown> | undefined, fingerprint: string): string {
  return `${tool}::${normalizeArgs(args)}::${fingerprint}`;
}

function updateFailureState(
  state: SessionState,
  tool: string,
  args: Record<string, unknown> | undefined,
  fingerprint: string,
): FailureSnapshot {
  const signature = buildSignature(tool, args, fingerprint);
  const previous = state.lastFailure;
  const streak = previous?.signature === signature ? previous.streak + 1 : 1;
  const snapshot = {
    tool,
    signature,
    streak,
    argsPreview: truncateText(normalizeArgs(args), OUTPUT_PREVIEW_LIMIT),
    errorPreview: truncateText(fingerprint, OUTPUT_PREVIEW_LIMIT),
  };

  state.lastFailure = snapshot;
  return snapshot;
}

function clearLastFailure(state: SessionState): void {
  state.lastFailure = null;
}

function buildSoftBlocker(snapshot: FailureSnapshot): string {
  return [
    `<tool-loop-guard status="blocked">`,
    `Repeated failing tool call detected.`,
    `Tool: ${snapshot.tool}`,
    `Attempts: ${snapshot.streak}`,
    `Args: ${snapshot.argsPreview}`,
    `Error: ${snapshot.errorPreview}`,
    `Do not call this tool again with the same arguments in this turn.`,
    `Try a different approach: inspect the tool schema, discover valid inputs first, switch tools, or ask the user for missing information.`,
    `</tool-loop-guard>`,
  ].join("\n");
}

function buildRecoveryPrompt(snapshot: FailureSnapshot): string {
  return [
    `A tool loop was interrupted.`,
    ``,
    `You called ${snapshot.tool} ${snapshot.streak} times with the same arguments and received the same failure.`,
    `Do not call ${snapshot.tool} again with the same arguments in this turn.`,
    ``,
    `Failure summary:`,
    `- tool: ${snapshot.tool}`,
    `- args: ${snapshot.argsPreview}`,
    `- error: ${snapshot.errorPreview}`,
    ``,
    `Use a different approach now:`,
    `1. Re-check the tool schema and required argument names or types.`,
    `2. Discover valid paths, IDs, or inputs before retrying.`,
    `3. If the task is too broad, switch to a narrower tool or delegate it.`,
    `4. If required information is missing, explain the blocker or ask the user.`,
    ``,
    `Continue from the user's goal without repeating the same failing call.`,
  ].join("\n");
}

async function showLoopToast(ctx: PluginInput, snapshot: FailureSnapshot): Promise<void> {
  await ctx.client.tui
    .showToast({
      body: {
        title: "Tool Loop Interrupted",
        message: `${snapshot.tool} failed ${snapshot.streak} times with the same arguments. Redirecting the run.`,
        variant: "warning",
        duration: TOAST_DURATION_MS,
      },
    })
    .catch((_error: unknown) => {
      /* fire-and-forget */
    });
}

async function interruptRun(
  ctx: PluginInput,
  sessionID: string,
  prompt: string,
  abortSettleDelayMs: number,
): Promise<void> {
  await ctx.client.session.abort({
    path: { id: sessionID },
    query: { directory: ctx.directory },
  });

  await new Promise((resolve) => setTimeout(resolve, abortSettleDelayMs));

  await ctx.client.session.prompt({
    path: { id: sessionID },
    body: { parts: [{ type: "text", text: prompt }] },
    query: { directory: ctx.directory },
  });
}

async function handleLoop(
  ctx: PluginInput,
  input: { sessionID: string },
  output: { output?: string },
  state: SessionState,
  snapshot: FailureSnapshot,
  abortSettleDelayMs: number,
  maxInterventions: number,
): Promise<void> {
  const attempts = state.interventions.get(snapshot.signature) ?? 0;
  const blocker = buildSoftBlocker(snapshot);
  output.output = blocker;

  if (attempts >= maxInterventions) {
    clearLastFailure(state);
    return;
  }

  state.interventions.set(snapshot.signature, attempts + 1);
  clearLastFailure(state);

  try {
    await showLoopToast(ctx, snapshot);
    await interruptRun(ctx, input.sessionID, buildRecoveryPrompt(snapshot), abortSettleDelayMs);
  } catch (error) {
    log.warn("hooks.tool-loop-guard", `Failed to interrupt tool loop: ${extractErrorMessage(error)}`);
  }
}

export function createToolLoopGuardHook(ctx: PluginInput, hookConfig?: ToolLoopGuardConfig): ToolLoopGuardHooks {
  const abortSettleDelayMs = hookConfig?.abortSettleDelayMs ?? ABORT_SETTLE_DELAY_MS;
  const threshold = hookConfig?.threshold ?? config.localLLM.toolLoopThreshold;
  const maxInterventions = hookConfig?.maxInterventions ?? config.localLLM.toolLoopMaxInterventions;
  const sessions = new Map<string, SessionState>();

  return {
    "tool.execute.after": async (input, output) => {
      const fingerprint = extractFailureFingerprint(output.output);
      const state = getSessionState(sessions, input.sessionID);
      if (!fingerprint) {
        clearLastFailure(state);
        return;
      }

      const snapshot = updateFailureState(state, input.tool, input.args, fingerprint);
      if (snapshot.streak < threshold) return;

      await handleLoop(ctx, input, output, state, snapshot, abortSettleDelayMs, maxInterventions);
    },

    cleanupSession: (sessionID: string) => {
      sessions.delete(sessionID);
    },
  };
}
