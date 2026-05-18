import { beforeEach, describe, expect, it } from "bun:test";

import {
  formatContinuityAnchor,
  getSessionContinuityAnchor,
  mergeSessionContinuityAnchor,
  mergeSessionContinuitySummary,
  resetContinuityRegistry,
  updateSessionContinuityProfile,
} from "../../src/hooks/continuity-anchor";

describe("continuity-anchor", () => {
  beforeEach(() => {
    resetContinuityRegistry();
  });

  it("should keep unknown models on legacy behavior in auto mode", () => {
    const active = updateSessionContinuityProfile("s-unknown", "mystery-model", "custom", {
      smallContext: {
        mode: "auto",
        autoThreshold: 512_000,
        continuityAnchor: {
          enabled: true,
          budgetTokens: 120,
        },
        outputGovernor: {
          enabled: true,
          reserveTokens: 4_096,
        },
        promptBudgeting: {
          enabled: true,
          maxPromptRatio: 0.7,
          reserveTokens: 8_192,
        },
      },
    });

    expect(active).toBe(false);
  });

  it("should activate unknown models in auto mode when a context override is set", () => {
    const active = updateSessionContinuityProfile("s-override", "mystery-model", "custom", {
      smallContext: {
        mode: "auto",
        autoThreshold: 512_000,
        contextLimitOverride: 64_000,
        continuityAnchor: {
          enabled: true,
          budgetTokens: 120,
        },
        outputGovernor: {
          enabled: true,
          reserveTokens: 4_096,
        },
        promptBudgeting: {
          enabled: true,
          maxPromptRatio: 0.7,
          reserveTokens: 8_192,
        },
      },
    });

    expect(active).toBe(true);
  });

  it("should keep a corrected accepted plan when summary updates arrive", () => {
    mergeSessionContinuityAnchor("s-summary", {
      goal: "Ship the continuity anchor",
      acceptedPlan: "Keep ledger-loader clean first, then adjust auto compact",
    });

    mergeSessionContinuitySummary(
      "s-summary",
      `# Session Summary

## Goal
Ship the continuity anchor

## Constraints & Preferences
- Keep hooks scoped

## Progress
### Done
- [x] Added parser coverage

### In Progress
- [ ] Update session recovery

### Blocked
- (none)

## Key Decisions
- **Use anchor**: Continue the corrected plan

## Next Steps
1. Finish session recovery
2. Update tests

## Critical Context
- Preserve continuity`,
      120,
    );

    expect(getSessionContinuityAnchor("s-summary")?.acceptedPlan).toContain("Keep ledger-loader clean first");
    expect(getSessionContinuityAnchor("s-summary")?.currentStep).toContain("Update session recovery");
    expect(getSessionContinuityAnchor("s-summary")?.completed).toContain("Added parser coverage");
  });

  it("should bound the formatted anchor when the budget is small", () => {
    mergeSessionContinuityAnchor(
      "s-budget",
      {
        goal: "A".repeat(200),
        acceptedPlan: "B".repeat(240),
        currentStep: "C".repeat(180),
        completed: ["D".repeat(120), "E".repeat(120), "F".repeat(120)],
        constraints: ["G".repeat(120), "H".repeat(120), "I".repeat(120)],
      },
      60,
    );

    const text = formatContinuityAnchor("s-budget", getSessionContinuityAnchor("s-budget"), 60);
    expect(text.length).toBeLessThan(600);
    expect(text).toContain("<continuity-anchor");
  });
});
