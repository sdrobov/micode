// tests/utils/model-limits.test.ts
import { describe, expect, it } from "bun:test";

import {
  CONTEXT_LIMIT_SOURCES,
  DEFAULT_CONTEXT_LIMIT,
  getContextLimit,
  isSmallContextLimit,
  isSmallContextModel,
  MODEL_CONTEXT_LIMITS,
  resolveContextLimit,
  SMALL_CONTEXT_AUTO_THRESHOLD,
} from "../../src/utils/model-limits";

describe("model-limits", () => {
  describe("getContextLimit without loaded limits", () => {
    it("should return limit for known model pattern", () => {
      expect(getContextLimit("gpt-4o")).toBe(128_000);
      expect(getContextLimit("claude-opus")).toBe(200_000);
      expect(getContextLimit("gemini-pro")).toBe(1_000_000);
    });

    it("should match case-insensitively", () => {
      expect(getContextLimit("GPT-4O")).toBe(128_000);
      expect(getContextLimit("Claude-Opus")).toBe(200_000);
    });

    it("should return default for unknown model", () => {
      expect(getContextLimit("unknown-model")).toBe(DEFAULT_CONTEXT_LIMIT);
    });
  });

  describe("resolveContextLimit", () => {
    it("should prefer the small-context override", () => {
      const resolution = resolveContextLimit({
        modelID: "model-a",
        providerID: "custom",
        modelContextLimits: new Map([["custom/model-a", 96_000]]),
        localContextLimit: 64_000,
        smallContext: { contextLimitOverride: 32_000 },
      });

      expect(resolution).toEqual({
        limit: 32_000,
        source: CONTEXT_LIMIT_SOURCES.smallContextOverride,
        resolved: true,
      });
    });

    it("should prefer the local LLM context limit over opencode limits", () => {
      const resolution = resolveContextLimit({
        modelID: "model-a",
        providerID: "custom",
        modelContextLimits: new Map([["custom/model-a", 96_000]]),
        localContextLimit: 64_000,
      });

      expect(resolution).toEqual({
        limit: 64_000,
        source: CONTEXT_LIMIT_SOURCES.localLLM,
        resolved: true,
      });
    });

    it("should resolve exact opencode limits without pattern guessing", () => {
      const resolution = resolveContextLimit({
        modelID: "model-a",
        providerID: "custom",
        modelContextLimits: new Map([["custom/model-a", 96_000]]),
      });

      expect(resolution).toEqual({
        limit: 96_000,
        source: CONTEXT_LIMIT_SOURCES.opencode,
        resolved: true,
      });
    });

    it("should stay unresolved for unknown models without overrides", () => {
      const resolution = resolveContextLimit({
        modelID: "gpt-4o",
        providerID: "openai",
      });

      expect(resolution).toEqual({
        limit: null,
        source: CONTEXT_LIMIT_SOURCES.unresolved,
        resolved: false,
      });
    });
  });

  describe("getContextLimit with loaded limits", () => {
    it("should prefer loaded limits over pattern matching", () => {
      const loadedLimits = new Map([["github-copilot/gpt-4", 128_000]]);

      const limit = getContextLimit("gpt-4", "github-copilot", loadedLimits);

      expect(limit).toBe(128_000);
    });

    it("should use exact match with provider/model", () => {
      const loadedLimits = new Map([
        ["openai/gpt-4o", 150_000], // Different from MODEL_CONTEXT_LIMITS
        ["anthropic/claude-opus", 250_000],
      ]);

      expect(getContextLimit("gpt-4o", "openai", loadedLimits)).toBe(150_000);
      expect(getContextLimit("claude-opus", "anthropic", loadedLimits)).toBe(250_000);
    });

    it("should fall back to pattern matching if not in loaded limits", () => {
      const loadedLimits = new Map([["openai/gpt-4o", 150_000]]);

      // Different provider - should fall back to pattern match
      const limit = getContextLimit("gpt-4o", "azure", loadedLimits);

      expect(limit).toBe(MODEL_CONTEXT_LIMITS["gpt-4o"]);
    });

    it("should fall back to default if no match anywhere", () => {
      const loadedLimits = new Map([["openai/gpt-4o", 150_000]]);

      const limit = getContextLimit("unknown-model", "unknown-provider", loadedLimits);

      expect(limit).toBe(DEFAULT_CONTEXT_LIMIT);
    });

    it("should work without provider ID", () => {
      const loadedLimits = new Map([["openai/gpt-4o", 150_000]]);

      // No provider ID - can't do exact match, falls back to pattern
      const limit = getContextLimit("gpt-4o", undefined, loadedLimits);

      expect(limit).toBe(MODEL_CONTEXT_LIMITS["gpt-4o"]);
    });
  });

  describe("MODEL_CONTEXT_LIMITS", () => {
    it("should have Claude models", () => {
      expect(MODEL_CONTEXT_LIMITS["claude-opus"]).toBe(200_000);
      expect(MODEL_CONTEXT_LIMITS["claude-sonnet"]).toBe(200_000);
    });

    it("should have OpenAI models", () => {
      expect(MODEL_CONTEXT_LIMITS["gpt-4o"]).toBe(128_000);
      expect(MODEL_CONTEXT_LIMITS["gpt-4"]).toBe(128_000);
    });

    it("should have Google models", () => {
      expect(MODEL_CONTEXT_LIMITS.gemini).toBe(1_000_000);
    });
  });

  describe("DEFAULT_CONTEXT_LIMIT", () => {
    it("should be 200_000", () => {
      expect(DEFAULT_CONTEXT_LIMIT).toBe(200_000);
    });
  });

  describe("isSmallContextLimit", () => {
    it("should treat limits at or below the threshold as small-context", () => {
      expect(isSmallContextLimit(64_000)).toBe(true);
      expect(isSmallContextLimit(SMALL_CONTEXT_AUTO_THRESHOLD)).toBe(true);
      expect(isSmallContextLimit(200_000)).toBe(false);
    });
  });

  describe("isSmallContextModel", () => {
    it("should detect known 128k models as small-context", () => {
      expect(isSmallContextModel("gpt-4o")).toBe(true);
    });

    it("should use loaded limits for custom thresholds", () => {
      const loadedLimits = new Map([["custom/model-a", 64_000]]);

      expect(isSmallContextModel("model-a", "custom", loadedLimits)).toBe(true);
      expect(isSmallContextModel("model-a", "custom", loadedLimits, 32_000)).toBe(false);
    });

    it("should keep unknown models out of small-context mode by default", () => {
      expect(isSmallContextModel("unknown-model")).toBe(false);
    });
  });
});
