import { beforeEach, describe, expect, it } from "bun:test";

import { parseSmallContextConfig } from "../../src/config-schemas";
import {
  activateOverflowRecovery,
  OVERFLOW_RECOVERY_SOURCES,
  OVERFLOW_RECOVERY_STAGES,
  resetOverflowRecoveryState,
} from "../../src/hooks/overflow-recovery-state";
import {
  createPromptBudgetController,
  selectPromptBudgetEntries,
  truncatePromptText,
} from "../../src/hooks/prompt-budgeting";

describe("prompt-budgeting", () => {
  beforeEach(() => {
    resetOverflowRecoveryState();
  });

  it("should use the small-context threshold when mode is forced on", () => {
    const smallContext = parseSmallContextConfig({
      mode: "on",
      autoThreshold: 1_000,
      promptBudgeting: {
        maxPromptRatio: 0.5,
        reserveTokens: 100,
      },
    });
    const controller = createPromptBudgetController({ smallContext });

    const remaining = controller.getRemainingTokens({
      existingText: "A".repeat(200),
      sessionID: "forced-session",
    });

    expect(remaining).toBe(350);
  });

  it("should activate automatically only for remembered small-context models", async () => {
    const smallContext = parseSmallContextConfig({
      mode: "auto",
      autoThreshold: 2_000,
      promptBudgeting: {
        maxPromptRatio: 0.5,
        reserveTokens: 100,
      },
    });
    const controller = createPromptBudgetController({
      modelContextLimits: new Map([
        ["custom/small-model", 1_500],
        ["custom/large-model", 4_000],
      ]),
      smallContext,
    });

    expect(controller.getRemainingTokens({ sessionID: "session-auto" })).toBeNull();

    await controller.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            modelID: "small-model",
            providerID: "custom",
            sessionID: "session-auto",
          },
        },
      },
    });

    expect(controller.getRemainingTokens({ existingText: "A".repeat(100), sessionID: "session-auto" })).toBe(625);

    await controller.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            modelID: "large-model",
            providerID: "custom",
            sessionID: "session-large",
          },
        },
      },
    });

    expect(controller.getRemainingTokens({ sessionID: "session-large" })).toBeNull();
    expect(controller.getRemainingTokens({ modelID: "unknown", providerID: "custom" })).toBeNull();
  });

  it("should allow auto mode when a context override is configured", () => {
    const smallContext = parseSmallContextConfig({
      mode: "auto",
      autoThreshold: 2_000,
      contextLimitOverride: 1_500,
      promptBudgeting: {
        maxPromptRatio: 0.5,
        reserveTokens: 100,
      },
    });
    const controller = createPromptBudgetController({ smallContext });

    expect(controller.getRemainingTokens({ existingText: "A".repeat(100), sessionID: "session-override" })).toBe(625);
  });

  it("should tighten prompt headroom during overflow recovery even for unknown models", () => {
    const smallContext = parseSmallContextConfig({
      mode: "auto",
      autoThreshold: 2_000,
      promptBudgeting: {
        maxPromptRatio: 0.5,
        reserveTokens: 100,
      },
    });
    const controller = createPromptBudgetController({ smallContext });

    activateOverflowRecovery(
      "overflow-session",
      OVERFLOW_RECOVERY_SOURCES.SESSION_RECOVERY,
      OVERFLOW_RECOVERY_STAGES.STRICT,
    );

    expect(controller.getRemainingTokens({ sessionID: "overflow-session" })).toBe(500);
  });

  it("should dedupe entries and truncate the final fit", () => {
    const entries = [
      { value: "Keep me", text: "Keep me", dedupeKey: "Keep me", priority: 0 },
      { value: "Keep me", text: "Keep me", dedupeKey: "Keep me", priority: 1 },
      { value: "B".repeat(40), text: "B".repeat(40), dedupeKey: "long", priority: 2 },
      { value: "Tail entry", text: "Tail entry", dedupeKey: "tail", priority: 3 },
    ];

    const selection = selectPromptBudgetEntries(entries, 8, (entry, remainingTokens) => {
      const value = truncatePromptText(entry.value, remainingTokens, "...");
      return value ? { ...entry, value, text: value } : null;
    });

    expect(selection.values).toHaveLength(2);
    expect(selection.values[0]).toBe("Keep me");
    expect(selection.values[1]).toContain("...");
    expect(selection.omittedCount).toBe(1);
    expect(selection.truncated).toBe(true);
  });
});
