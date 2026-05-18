import { describe, expect, it } from "bun:test";

import { parseSmallContextConfig } from "../src/config-schemas";

describe("SmallContextConfigSchema", () => {
  it("should accept empty config and return defaults", () => {
    const result = parseSmallContextConfig({});

    expect(result).not.toBeNull();
    expect(result?.mode).toBe("auto");
    expect(result?.autoThreshold).toBe(128_000);
    expect(result?.contextLimitOverride).toBeUndefined();
    expect(result?.continuityAnchor.enabled).toBe(true);
    expect(result?.continuityAnchor.budgetTokens).toBe(1_200);
    expect(result?.outputGovernor.reserveTokens).toBe(4_096);
    expect(result?.promptBudgeting.maxPromptRatio).toBe(0.7);
    expect(result?.promptBudgeting.reserveTokens).toBe(8_192);
  });

  it("should accept explicit overrides", () => {
    const result = parseSmallContextConfig({
      mode: "on",
      autoThreshold: 64_000,
      contextLimitOverride: 48_000,
      continuityAnchor: {
        enabled: false,
        budgetTokens: 900,
      },
      outputGovernor: {
        reserveTokens: 2_048,
      },
      promptBudgeting: {
        maxPromptRatio: 0.5,
        reserveTokens: 4_096,
      },
    });

    expect(result).not.toBeNull();
    expect(result?.mode).toBe("on");
    expect(result?.autoThreshold).toBe(64_000);
    expect(result?.contextLimitOverride).toBe(48_000);
    expect(result?.continuityAnchor.enabled).toBe(false);
    expect(result?.continuityAnchor.budgetTokens).toBe(900);
    expect(result?.outputGovernor.enabled).toBe(true);
    expect(result?.outputGovernor.reserveTokens).toBe(2_048);
    expect(result?.promptBudgeting.maxPromptRatio).toBe(0.5);
    expect(result?.promptBudgeting.reserveTokens).toBe(4_096);
  });

  it("should reject invalid mode", () => {
    const result = parseSmallContextConfig({ mode: "sometimes" });
    expect(result).toBeNull();
  });

  it("should reject invalid prompt budgeting ratios", () => {
    const result = parseSmallContextConfig({
      promptBudgeting: {
        maxPromptRatio: 2,
      },
    });

    expect(result).toBeNull();
  });
});
