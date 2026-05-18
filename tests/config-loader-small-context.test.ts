import { describe, expect, it } from "bun:test";

import { sanitizeSmallContextConfig } from "../src/config-loader";

describe("sanitizeSmallContextConfig", () => {
  it("should return null for undefined input", () => {
    expect(sanitizeSmallContextConfig(undefined)).toBeNull();
  });

  it("should return config for valid input", () => {
    const result = sanitizeSmallContextConfig({
      mode: "auto",
      contextLimitOverride: 48_000,
      continuityAnchor: {
        budgetTokens: 900,
      },
    });

    expect(result).not.toBeNull();
    expect(result?.mode).toBe("auto");
    expect(result?.contextLimitOverride).toBe(48_000);
    expect(result?.continuityAnchor.budgetTokens).toBe(900);
    expect(result?.outputGovernor.reserveTokens).toBe(4_096);
  });

  it("should return null for invalid input", () => {
    const result = sanitizeSmallContextConfig({
      outputGovernor: {
        reserveTokens: 0,
      },
    });

    expect(result).toBeNull();
  });

  it("should handle null input", () => {
    expect(sanitizeSmallContextConfig(null)).toBeNull();
  });
});
