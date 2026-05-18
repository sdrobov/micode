import type { SmallContextConfig } from "@/config-schemas";
import { config } from "@/utils/config";
import { resolveContextLimit } from "@/utils/model-limits";

const CHARS_PER_TOKEN = 4;
const LIST_SEPARATOR = " | ";
const UNKNOWN_VALUE = "(not captured yet)";
const NO_ITEMS = "(none)";
const DEFAULT_STEP = "(continue the accepted plan)";
const MAX_LIST_ITEMS = 4;
const ELLIPSIS_LENGTH = 3;
const MIN_FIT_ITEM_CHARS = 24;
const MIN_TOTAL_BUDGET_CHARS = 240;
const MIN_FIELD_BUDGET_CHARS = 48;
const MIN_PLAN_BUDGET_CHARS = 64;
const GOAL_BUDGET_RATIO = 0.18;
const PLAN_BUDGET_RATIO = 0.24;
const STEP_BUDGET_RATIO = 0.18;
const CONSTRAINT_BUDGET_RATIO = 0.18;
const COMPLETED_BUDGET_RATIO = 0.18;
const MAX_PLAN_STEPS = 3;

const INLINE_STOP_LABELS = [
  "accepted plan",
  "updated plan",
  "revised plan",
  "corrected plan",
  "plan correction",
  "change of plan",
  "new plan",
  "plan",
  "constraints",
  "requirements",
  "current step",
  "completed",
  "done",
  "dod",
  "definition of done",
] as const;

const PLAN_CORRECTION_LABELS = [
  "accepted plan",
  "updated plan",
  "revised plan",
  "corrected plan",
  "plan correction",
  "change of plan",
  "new plan",
] as const;

const PLAN_LABELS = ["plan"] as const;
const CONSTRAINT_LABELS = ["constraints", "requirements"] as const;
const CURRENT_STEP_LABELS = ["current step"] as const;
const COMPLETED_LABELS = ["completed", "done"] as const;
const SECTION_PREFIX = /^[-*]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+/;

export interface ContinuityAnchor {
  readonly goal: string;
  readonly acceptedPlan: string;
  readonly currentStep: string;
  readonly completed: readonly string[];
  readonly constraints: readonly string[];
}

export interface ContinuityHookConfig {
  readonly smallContext?: SmallContextConfig | null;
  readonly modelContextLimits?: Map<string, number>;
  readonly localContextLimit?: number;
}

interface ContinuitySessionState {
  anchor: ContinuityAnchor;
  smallContextActive: boolean;
}

const continuitySessions = new Map<string, ContinuitySessionState>();

function createEmptyAnchor(): ContinuityAnchor {
  return {
    goal: "",
    acceptedPlan: "",
    currentStep: "",
    completed: [],
    constraints: [],
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= ELLIPSIS_LENGTH) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - ELLIPSIS_LENGTH).trimEnd()}...`;
}

function splitItems(value: string): string[] {
  return value
    .split(/\r?\n|;|,\s+/)
    .map((item) => cleanText(item.replace(SECTION_PREFIX, "")))
    .filter((item) => item.length > 0 && item !== NO_ITEMS);
}

function fitItems(values: readonly string[], budgetChars: number): string[] {
  const items: string[] = [];
  let used = 0;
  const maxItemChars = Math.max(MIN_FIT_ITEM_CHARS, Math.floor(budgetChars / MAX_LIST_ITEMS));

  for (const value of values.slice(0, MAX_LIST_ITEMS)) {
    const item = truncateText(cleanText(value), maxItemChars);
    if (!item) continue;

    const separatorCost = items.length === 0 ? 0 : LIST_SEPARATOR.length;
    if (items.length > 0 && used + separatorCost + item.length > budgetChars) break;

    items.push(item);
    used += separatorCost + item.length;
  }

  return items;
}

function getAnchorBudgets(budgetTokens: number): Record<string, number> {
  const totalChars = Math.max(MIN_TOTAL_BUDGET_CHARS, budgetTokens * CHARS_PER_TOKEN);
  return {
    goal: Math.max(MIN_FIELD_BUDGET_CHARS, Math.floor(totalChars * GOAL_BUDGET_RATIO)),
    acceptedPlan: Math.max(MIN_PLAN_BUDGET_CHARS, Math.floor(totalChars * PLAN_BUDGET_RATIO)),
    currentStep: Math.max(MIN_FIELD_BUDGET_CHARS, Math.floor(totalChars * STEP_BUDGET_RATIO)),
    constraints: Math.max(MIN_FIELD_BUDGET_CHARS, Math.floor(totalChars * CONSTRAINT_BUDGET_RATIO)),
    completed: Math.max(MIN_FIELD_BUDGET_CHARS, Math.floor(totalChars * COMPLETED_BUDGET_RATIO)),
  };
}

function sanitizeAnchor(anchor: Partial<ContinuityAnchor>, budgetTokens: number): ContinuityAnchor {
  const budgets = getAnchorBudgets(budgetTokens);
  return {
    goal: truncateText(cleanText(anchor.goal), budgets.goal),
    acceptedPlan: truncateText(cleanText(anchor.acceptedPlan), budgets.acceptedPlan),
    currentStep: truncateText(cleanText(anchor.currentStep), budgets.currentStep),
    constraints: fitItems(anchor.constraints ?? [], budgets.constraints),
    completed: fitItems(anchor.completed ?? [], budgets.completed),
  };
}

function mergeLists(current: readonly string[], update: readonly string[]): string[] {
  const merged = [...update, ...current];
  return [...new Set(merged.map((item) => cleanText(item)).filter(Boolean))];
}

function mergeAnchor(
  current: ContinuityAnchor,
  update: Partial<ContinuityAnchor>,
  budgetTokens: number,
): ContinuityAnchor {
  return sanitizeAnchor(
    {
      goal: update.goal || current.goal,
      acceptedPlan: update.acceptedPlan || current.acceptedPlan,
      currentStep: update.currentStep || current.currentStep,
      constraints: update.constraints?.length
        ? mergeLists(current.constraints, update.constraints)
        : current.constraints,
      completed: update.completed?.length ? mergeLists(current.completed, update.completed) : current.completed,
    },
    budgetTokens,
  );
}

function extractInlineValue(text: string, labels: readonly string[]): string {
  const labelPattern = labels.map(escapeRegex).join("|");
  const stopPattern = INLINE_STOP_LABELS.map(escapeRegex).join("|");
  const pattern = new RegExp(`(?:^|\\b)(?:${labelPattern})[:\\s]+([\\s\\S]+?)(?=\\b(?:${stopPattern})[:\\s]+|$)`, "i");
  return cleanText(pattern.exec(text)?.[1]);
}

function findFirstLabelIndex(text: string): number {
  const indices = INLINE_STOP_LABELS.map((label) => {
    const match = new RegExp(`\\b${escapeRegex(label)}[:\\s]+`, "i").exec(text);
    return match?.index ?? Number.POSITIVE_INFINITY;
  });
  return Math.min(...indices);
}

function extractInitialGoal(text: string): string {
  const index = findFirstLabelIndex(text);
  if (!Number.isFinite(index)) return cleanText(text);
  return cleanText(text.slice(0, index));
}

function extractMarkdownSection(text: string, heading: string, stopPattern: string): string {
  const pattern = new RegExp(`${heading}\\s*\\n([\\s\\S]+?)(?=${stopPattern}|$)`, "i");
  return cleanText(pattern.exec(text)?.[1]);
}

function extractMarkdownItems(text: string, heading: string, stopPattern: string): string[] {
  const section = extractMarkdownSection(text, heading, stopPattern);
  return splitItems(section);
}

function buildPlanFromSteps(steps: readonly string[]): string {
  return cleanText(steps.slice(0, MAX_PLAN_STEPS).join("; "));
}

function getOrCreateSessionState(sessionID: string): ContinuitySessionState {
  const existing = continuitySessions.get(sessionID);
  if (existing) return existing;

  const created = { anchor: createEmptyAnchor(), smallContextActive: false };
  continuitySessions.set(sessionID, created);
  return created;
}

function formatItems(items: readonly string[]): string {
  return items.length > 0 ? items.join(LIST_SEPARATOR) : NO_ITEMS;
}

export function getContinuityAnchorBudget(hookConfig?: ContinuityHookConfig): number {
  return hookConfig?.smallContext?.continuityAnchor.budgetTokens ?? config.smallContext.continuityAnchor.budgetTokens;
}

export function updateSessionContinuityProfile(
  sessionID: string,
  modelID: string,
  providerID: string,
  hookConfig?: ContinuityHookConfig,
): boolean {
  const state = getOrCreateSessionState(sessionID);
  const smallContext = hookConfig?.smallContext;
  const enabled = smallContext?.continuityAnchor.enabled ?? false;

  if (!smallContext || !enabled || smallContext.mode === "off") {
    state.smallContextActive = false;
    return false;
  }

  if (smallContext.mode === "on") {
    state.smallContextActive = true;
    return true;
  }

  const resolution = resolveContextLimit({
    modelID,
    providerID,
    modelContextLimits: hookConfig?.modelContextLimits,
    localContextLimit: hookConfig?.localContextLimit,
    smallContext,
  });

  if (!modelID && !providerID && !resolution.resolved) {
    return state.smallContextActive;
  }

  if (!resolution.resolved || resolution.limit === null) {
    state.smallContextActive = false;
    return false;
  }

  const threshold = smallContext.autoThreshold;
  state.smallContextActive = resolution.limit <= threshold;
  return state.smallContextActive;
}

export function isContinuityAnchorActive(sessionID: string): boolean {
  return continuitySessions.get(sessionID)?.smallContextActive ?? false;
}

export function clearSessionContinuity(sessionID: string): void {
  continuitySessions.delete(sessionID);
}

export function resetContinuityRegistry(): void {
  continuitySessions.clear();
}

export function getSessionContinuityAnchor(sessionID: string): ContinuityAnchor | null {
  return continuitySessions.get(sessionID)?.anchor ?? null;
}

export function mergeSessionContinuityAnchor(
  sessionID: string,
  update: Partial<ContinuityAnchor>,
  budgetTokens: number = config.smallContext.continuityAnchor.budgetTokens,
): ContinuityAnchor {
  const state = getOrCreateSessionState(sessionID);
  const next = mergeAnchor(state.anchor, update, budgetTokens);
  state.anchor = next;
  return next;
}

export function mergeSessionContinuitySummary(
  sessionID: string,
  text: string,
  budgetTokens: number = config.smallContext.continuityAnchor.budgetTokens,
): ContinuityAnchor {
  const state = getOrCreateSessionState(sessionID);
  const update = extractContinuitySummaryUpdate(text);
  const next = sanitizeAnchor(
    {
      goal: update.goal || state.anchor.goal,
      acceptedPlan: state.anchor.acceptedPlan || update.acceptedPlan,
      currentStep: update.currentStep || state.anchor.currentStep,
      constraints: update.constraints?.length
        ? mergeLists(state.anchor.constraints, update.constraints)
        : state.anchor.constraints,
      completed: update.completed?.length
        ? mergeLists(state.anchor.completed, update.completed)
        : state.anchor.completed,
    },
    budgetTokens,
  );
  state.anchor = next;
  return next;
}

export function extractContinuityMessageUpdate(text: string, initialCapture = false): Partial<ContinuityAnchor> {
  const acceptedPlan = initialCapture
    ? extractInlineValue(text, [...PLAN_CORRECTION_LABELS, ...PLAN_LABELS])
    : extractInlineValue(text, PLAN_CORRECTION_LABELS);

  return {
    goal: initialCapture ? extractInitialGoal(text) : "",
    acceptedPlan,
    currentStep: extractInlineValue(text, CURRENT_STEP_LABELS),
    constraints: splitItems(extractInlineValue(text, CONSTRAINT_LABELS)),
    completed: splitItems(extractInlineValue(text, COMPLETED_LABELS)),
  };
}

export function extractContinuitySummaryUpdate(text: string): Partial<ContinuityAnchor> {
  const constraints = extractMarkdownItems(text, "## Constraints(?: & Preferences)?", "\\n##\\s");
  const completed = extractMarkdownItems(text, "### Done", "\\n(?:###|##)\\s");
  const inProgress = extractMarkdownItems(text, "### In Progress", "\\n(?:###|##)\\s");
  const nextSteps = extractMarkdownItems(text, "## Next Steps", "\\n##\\s");

  return {
    goal: extractMarkdownSection(text, "## Goal", "\\n##\\s"),
    acceptedPlan: buildPlanFromSteps(nextSteps),
    currentStep: inProgress[0] ?? nextSteps[0] ?? "",
    constraints,
    completed,
  };
}

export function formatContinuityAnchor(
  sessionID: string,
  anchor: ContinuityAnchor | null,
  budgetTokens: number = config.smallContext.continuityAnchor.budgetTokens,
): string {
  const bounded = sanitizeAnchor(anchor ?? createEmptyAnchor(), budgetTokens);
  return `<continuity-anchor session="${sessionID}">
Goal: ${bounded.goal || UNKNOWN_VALUE}
Accepted plan: ${bounded.acceptedPlan || UNKNOWN_VALUE}
Current step: ${bounded.currentStep || DEFAULT_STEP}
Completed: ${formatItems(bounded.completed)}
Constraints: ${formatItems(bounded.constraints)}
Resume rule: Continue the accepted plan. Only replace it if the user explicitly corrects the plan.
</continuity-anchor>`;
}

export function formatCompactionContinuityContext(
  sessionID: string,
  anchor: ContinuityAnchor | null,
  budgetTokens: number = config.smallContext.continuityAnchor.budgetTokens,
): string {
  return `${formatContinuityAnchor(sessionID, anchor, budgetTokens)}

When summarizing, preserve the goal, accepted plan, current step, completed items, and constraints.
If the user corrected the plan mid-session, keep the corrected plan instead of the initial plan.`;
}

export function formatResumeContinuityPrompt(
  sessionID: string,
  anchor: ContinuityAnchor | null,
  budgetTokens: number = config.smallContext.continuityAnchor.budgetTokens,
  reason = "Continue from where you left off.",
): string {
  return `${reason}

${formatContinuityAnchor(sessionID, anchor, budgetTokens)}

Continue the accepted plan. Do not invent a replacement plan.`;
}
