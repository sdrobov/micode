import type { SmallContextConfig } from "@/config-schemas";
import { config } from "@/utils/config";

// Shared model context limits (tokens)
// Used by context-window-monitor and auto-compact hooks

// Fallback patterns for models not in opencode.json
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Claude models
  "claude-opus": 200_000,
  "claude-sonnet": 200_000,
  "claude-haiku": 200_000,
  "claude-3": 200_000,
  "claude-4": 200_000,
  // OpenAI models
  "gpt-4o": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 128_000,
  "gpt-5": 200_000,
  o1: 200_000,
  o3: 200_000,
  // Google models
  gemini: 1_000_000,
};

export const DEFAULT_CONTEXT_LIMIT = 200_000;
export const SMALL_CONTEXT_AUTO_THRESHOLD = config.smallContext.autoThreshold;
export const CONTEXT_LIMIT_SOURCES = {
  smallContextOverride: "smallContext.contextLimitOverride",
  localLLM: "localLLM.contextLimit",
  opencode: "opencode.limit.context",
  unresolved: "unresolved",
} as const;

export type ContextLimitSource = (typeof CONTEXT_LIMIT_SOURCES)[keyof typeof CONTEXT_LIMIT_SOURCES];

export interface ContextLimitResolution {
  readonly limit: number | null;
  readonly source: ContextLimitSource;
  readonly resolved: boolean;
}

export interface ContextLimitResolverInput {
  readonly modelID?: string;
  readonly providerID?: string;
  readonly modelContextLimits?: Map<string, number>;
  readonly localContextLimit?: number;
  readonly defaultContextLimit?: number;
  readonly smallContext?: Pick<SmallContextConfig, "contextLimitOverride"> | null;
}

function hasPositiveLimit(limit: number | undefined): limit is number {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0;
}

function getExactContextLimit(
  modelID: string | undefined,
  providerID: string | undefined,
  loadedLimits?: Map<string, number>,
): number | null {
  if (!loadedLimits || !providerID || !modelID) {
    return null;
  }

  const exactLimit = loadedLimits.get(`${providerID}/${modelID}`);
  return hasPositiveLimit(exactLimit) ? exactLimit : null;
}

export function resolveContextLimit(input: ContextLimitResolverInput): ContextLimitResolution {
  const overrideLimit = input.smallContext?.contextLimitOverride;
  if (hasPositiveLimit(overrideLimit)) {
    return {
      limit: overrideLimit,
      source: CONTEXT_LIMIT_SOURCES.smallContextOverride,
      resolved: true,
    };
  }

  const localContextLimit = input.localContextLimit ?? input.defaultContextLimit;
  if (hasPositiveLimit(localContextLimit)) {
    return {
      limit: localContextLimit,
      source: CONTEXT_LIMIT_SOURCES.localLLM,
      resolved: true,
    };
  }

  const exactLimit = getExactContextLimit(input.modelID, input.providerID, input.modelContextLimits);
  if (exactLimit !== null) {
    return {
      limit: exactLimit,
      source: CONTEXT_LIMIT_SOURCES.opencode,
      resolved: true,
    };
  }

  return {
    limit: null,
    source: CONTEXT_LIMIT_SOURCES.unresolved,
    resolved: false,
  };
}

/**
 * Get the context window limit for a given model.
 * Priority: loaded limits (exact match) > pattern match > default
 *
 * @param modelID - The model ID (e.g., "gpt-4o", "claude-opus")
 * @param providerID - Optional provider ID (e.g., "openai", "anthropic")
 * @param loadedLimits - Optional map of "provider/model" -> limit from opencode.json
 */
export function getContextLimit(modelID: string, providerID?: string, loadedLimits?: Map<string, number>): number {
  const exactLimit = getExactContextLimit(modelID, providerID, loadedLimits);
  if (exactLimit !== null) {
    return exactLimit;
  }

  const modelLower = modelID.toLowerCase();
  for (const [pattern, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (modelLower.includes(pattern)) {
      return limit;
    }
  }

  return DEFAULT_CONTEXT_LIMIT;
}

/**
 * Check whether a resolved context window should be treated as small-context.
 */
export function isSmallContextLimit(contextLimit: number, threshold = SMALL_CONTEXT_AUTO_THRESHOLD): boolean {
  return contextLimit <= threshold;
}

/**
 * Check whether a model should use the small-context profile.
 */
export function isSmallContextModel(
  modelID: string,
  providerID?: string,
  loadedLimits?: Map<string, number>,
  threshold = SMALL_CONTEXT_AUTO_THRESHOLD,
): boolean {
  const contextLimit = getContextLimit(modelID, providerID, loadedLimits);
  return isSmallContextLimit(contextLimit, threshold);
}
