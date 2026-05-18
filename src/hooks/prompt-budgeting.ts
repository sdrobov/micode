import type { SmallContextConfig } from "@/config-schemas";
import { config } from "@/utils/config";
import { resolveContextLimit } from "@/utils/model-limits";

const MESSAGE_UPDATED = "message.updated";
const SESSION_DELETED = "session.deleted";
const MODEL_SEPARATOR = "/";
const DEFAULT_PRIORITY = 100;
const TRUNCATION_SUFFIX = "\n\n[Truncated for small-context prompt budget]";

interface SessionModel {
  readonly modelID: string;
  readonly providerID: string;
}

export interface PromptBudgetControllerConfig {
  readonly smallContext?: SmallContextConfig | null;
  readonly modelContextLimits?: Map<string, number>;
  readonly localContextLimit?: number;
}

export interface PromptBudgetRequest {
  readonly sessionID?: string;
  readonly existingText?: string | readonly string[];
  readonly options?: Record<string, unknown>;
  readonly modelID?: string;
  readonly providerID?: string;
}

export interface PromptBudgetEntry<T> {
  readonly value: T;
  readonly text: string;
  readonly priority?: number;
  readonly dedupeKey?: string;
}

export interface PromptBudgetSelection<T> {
  readonly values: readonly T[];
  readonly omittedCount: number;
  readonly remainingTokens: number;
  readonly truncated: boolean;
}

export interface PromptBudgetController {
  event: (input: { event: { type: string; properties?: unknown } }) => Promise<void>;
  getRemainingTokens: (request: PromptBudgetRequest) => number | null;
}

interface OrderedPromptBudgetEntry<T> extends PromptBudgetEntry<T> {
  readonly index: number;
  readonly priority: number;
}

export function estimatePromptTokens(text: string): number {
  return Math.ceil(text.length / config.tokens.charsPerToken);
}

function joinExistingText(existingText?: string | readonly string[]): string {
  if (!existingText) return "";
  if (typeof existingText === "string") return existingText;
  return existingText.join("\n\n");
}

function parseModelSpecifier(model: string): SessionModel | null {
  const [providerID, ...modelParts] = model.split(MODEL_SEPARATOR);
  if (!providerID || modelParts.length === 0) return null;
  return { providerID, modelID: modelParts.join(MODEL_SEPARATOR) };
}

function readModelFromOptions(options?: Record<string, unknown>): SessionModel | null {
  const model = options?.model;
  if (typeof model === "string") {
    return parseModelSpecifier(model);
  }

  const modelID = options?.modelID;
  const providerID = options?.providerID;
  if (typeof modelID !== "string" || typeof providerID !== "string") return null;
  return { modelID, providerID };
}

function readSessionModel(sessionID: string | undefined, sessions: Map<string, SessionModel>): SessionModel | null {
  if (!sessionID) return null;
  return sessions.get(sessionID) ?? null;
}

function resolveModel(request: PromptBudgetRequest, sessions: Map<string, SessionModel>): SessionModel | null {
  if (request.modelID && request.providerID) {
    return { modelID: request.modelID, providerID: request.providerID };
  }

  return readModelFromOptions(request.options) ?? readSessionModel(request.sessionID, sessions);
}

function resolvePromptBudgetContextLimit(
  request: PromptBudgetRequest,
  sessions: Map<string, SessionModel>,
  hookConfig?: PromptBudgetControllerConfig,
): number | null {
  const smallContext = hookConfig?.smallContext;
  if (!smallContext?.promptBudgeting.enabled || smallContext.mode === "off") return null;

  const model = resolveModel(request, sessions);
  const resolution = resolveContextLimit({
    modelID: model?.modelID,
    providerID: model?.providerID,
    modelContextLimits: hookConfig?.modelContextLimits,
    localContextLimit: hookConfig?.localContextLimit,
    smallContext,
  });

  if (smallContext.mode === "on") {
    return resolution.limit ?? smallContext.autoThreshold;
  }

  if (!resolution.resolved || resolution.limit === null) return null;
  if (resolution.limit > smallContext.autoThreshold) return null;
  return resolution.limit;
}

function calculateRemainingTokens(
  request: PromptBudgetRequest,
  contextLimit: number,
  smallContext: SmallContextConfig,
): number {
  const maxPromptTokens = Math.floor(contextLimit * smallContext.promptBudgeting.maxPromptRatio);
  const budgetCap = Math.max(0, maxPromptTokens - smallContext.promptBudgeting.reserveTokens);
  const existingTokens = estimatePromptTokens(joinExistingText(request.existingText));
  return Math.max(0, budgetCap - existingTokens);
}

function rememberSessionModel(
  sessions: Map<string, SessionModel>,
  properties: Record<string, unknown> | undefined,
): void {
  const info = properties?.info as Record<string, unknown> | undefined;
  const sessionID = info?.sessionID;
  const modelID = info?.modelID;
  const providerID = info?.providerID;
  if (typeof sessionID !== "string") return;
  if (typeof modelID !== "string" || typeof providerID !== "string") return;
  sessions.set(sessionID, { modelID, providerID });
}

function forgetSessionModel(
  sessions: Map<string, SessionModel>,
  properties: Record<string, unknown> | undefined,
): void {
  const info = properties?.info as { id?: string } | undefined;
  if (info?.id) {
    sessions.delete(info.id);
  }
}

function orderPromptBudgetEntries<T>(entries: readonly PromptBudgetEntry<T>[]): OrderedPromptBudgetEntry<T>[] {
  return entries
    .map((entry, index) => ({ ...entry, index, priority: entry.priority ?? DEFAULT_PRIORITY }))
    .sort((left, right) => {
      if (left.priority === right.priority) {
        return left.index - right.index;
      }
      return left.priority - right.priority;
    });
}

function normalizePromptBudgetKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function dedupePromptBudgetEntries<T>(entries: readonly OrderedPromptBudgetEntry<T>[]): OrderedPromptBudgetEntry<T>[] {
  const seen = new Set<string>();
  const unique: OrderedPromptBudgetEntry<T>[] = [];

  for (const entry of entries) {
    const dedupeKey = normalizePromptBudgetKey(entry.dedupeKey ?? entry.text);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    unique.push(entry);
  }

  return unique;
}

export function truncatePromptText(text: string, maxTokens: number, suffix = TRUNCATION_SUFFIX): string | null {
  const maxChars = maxTokens * config.tokens.charsPerToken;
  if (maxChars <= suffix.length) return null;

  const trimmed = text.slice(0, maxChars - suffix.length).trimEnd();
  if (!trimmed) return null;
  return `${trimmed}${suffix}`;
}

export function selectPromptBudgetEntries<T>(
  entries: readonly PromptBudgetEntry<T>[],
  budgetTokens: number,
  truncateEntry: (entry: PromptBudgetEntry<T>, remainingTokens: number) => PromptBudgetEntry<T> | null,
): PromptBudgetSelection<T> {
  const uniqueEntries = dedupePromptBudgetEntries(orderPromptBudgetEntries(entries));
  if (budgetTokens <= 0 || uniqueEntries.length === 0) {
    return { values: [], omittedCount: uniqueEntries.length, remainingTokens: 0, truncated: false };
  }

  const values: T[] = [];
  let remainingTokens = budgetTokens;
  let truncated = false;
  let omittedCount = 0;

  for (const [index, entry] of uniqueEntries.entries()) {
    const entryTokens = estimatePromptTokens(entry.text);
    if (entryTokens <= remainingTokens) {
      values.push(entry.value);
      remainingTokens -= entryTokens;
      continue;
    }

    const partial = truncateEntry(entry, remainingTokens);
    if (partial) {
      values.push(partial.value);
      remainingTokens = 0;
      truncated = true;
      omittedCount += uniqueEntries.length - index - 1;
      break;
    }

    omittedCount++;
  }

  return { values, omittedCount, remainingTokens, truncated };
}

export function createPromptBudgetController(hookConfig?: PromptBudgetControllerConfig): PromptBudgetController {
  const sessions = new Map<string, SessionModel>();

  return {
    event: async ({ event }) => {
      const properties = event.properties as Record<string, unknown> | undefined;

      if (event.type === SESSION_DELETED) {
        forgetSessionModel(sessions, properties);
        return;
      }

      if (event.type === MESSAGE_UPDATED) {
        rememberSessionModel(sessions, properties);
      }
    },
    getRemainingTokens: (request) => {
      const smallContext = hookConfig?.smallContext;
      if (!smallContext) return null;

      const contextLimit = resolvePromptBudgetContextLimit(request, sessions, hookConfig);
      if (contextLimit === null) return null;
      return calculateRemainingTokens(request, contextLimit, smallContext);
    },
  };
}
