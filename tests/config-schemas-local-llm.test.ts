import { describe, expect, it } from "bun:test";

import { isLocalLLMProvider, parseLocalLLMConfig } from "../src/config-schemas";

describe("LocalLLMConfigSchema", () => {
  it("should accept valid full config", () => {
    const result = parseLocalLLMConfig({
      contextLimit: 16_384,
      charPerToken: 2,
      maxReadRatio: 0.25,
      minRemainingRatio: 0.2,
      reminderInterval: 3,
      outputBudget: 2_048,
      reasoningBudget: 2_048,
    });
    expect(result).not.toBeNull();
    expect(result?.contextLimit).toBe(16_384);
  });

  it("should accept empty config and return defaults", () => {
    const result = parseLocalLLMConfig({});
    expect(result).not.toBeNull();
    expect(result?.contextLimit).toBe(32_768);
    expect(result?.charPerToken).toBe(2);
    expect(result?.reminderInterval).toBe(5);
  });

  it("should reject negative contextLimit", () => {
    const result = parseLocalLLMConfig({ contextLimit: -100 });
    expect(result).toBeNull();
  });

  it("should reject invalid maxReadRatio > 1", () => {
    const result = parseLocalLLMConfig({ maxReadRatio: 2 });
    expect(result).toBeNull();
  });

  it("should reject invalid charPerToken of 0", () => {
    const result = parseLocalLLMConfig({ charPerToken: 0 });
    expect(result).toBeNull();
  });
});

describe("isLocalLLMProvider", () => {
  it("should detect ollama providers", () => {
    expect(isLocalLLMProvider("ollama/my-model")).toBe(true);
    expect(isLocalLLMProvider("ollama")).toBe(true);
  });

  it("should detect local providers", () => {
    expect(isLocalLLMProvider("local/my-model")).toBe(true);
    expect(isLocalLLMProvider("local")).toBe(true);
  });

  it("should detect lm-studio providers", () => {
    expect(isLocalLLMProvider("lm-studio/my-model")).toBe(true);
    expect(isLocalLLMProvider("lm-studio")).toBe(true);
  });

  it("should detect llamacpp providers", () => {
    expect(isLocalLLMProvider("llamacpp/my-model")).toBe(true);
    expect(isLocalLLMProvider("llamacpp")).toBe(true);
  });

  it("should return false for cloud providers", () => {
    expect(isLocalLLMProvider("anthropic")).toBe(false);
    expect(isLocalLLMProvider("openai/gpt-4o")).toBe(false);
    expect(isLocalLLMProvider("")).toBe(false);
  });

  it("should return false for undefined", () => {
    expect(isLocalLLMProvider(undefined)).toBe(false);
  });
});
