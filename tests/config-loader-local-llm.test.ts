import { describe, expect, it } from "bun:test";

import { sanitizeLocalLLMConfig } from "../src/config-loader";

// Note: buildMicodeConfig is not exported directly.
// We test sanitizeLocalLLMConfig which is the building block.

describe("sanitizeLocalLLMConfig", () => {
  it("should return null for undefined input", () => {
    expect(sanitizeLocalLLMConfig(undefined)).toBeNull();
  });

  it("should return config for valid input", () => {
    const result = sanitizeLocalLLMConfig({ contextLimit: 16_384 });
    expect(result).not.toBeNull();
    expect(result?.contextLimit).toBe(16_384);
  });

  it("should return null for invalid input", () => {
    const result = sanitizeLocalLLMConfig({ contextLimit: -1 });
    expect(result).toBeNull();
  });

  it("should handle null input", () => {
    expect(sanitizeLocalLLMConfig(null)).toBeNull();
  });
});
