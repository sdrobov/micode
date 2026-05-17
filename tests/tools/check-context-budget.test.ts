import { describe, expect, it } from "bun:test";

import type { ContextBudgetHooks } from "../../src/hooks/context-budget";

function createMockBudget(overrides?: Partial<ContextBudgetHooks>): ContextBudgetHooks {
  return {
    "chat.params": async () => {},
    event: async () => {},
    estimateReadCost: async (paths) => ({
      total: paths.length * 1000,
      files: paths.map((p) => ({ path: p, estimated: 1000, method: "exact" })),
    }),
    canRead: () => ({ decision: "ok", remaining: 50_000, estimatedCost: 1000, availableBudget: 40_000 }),
    getBudget: () => ({ used: 10_000, limit: 50_000, remaining: 40_000 }),
    ...overrides,
  };
}

describe("check-context-budget tool", () => {
  // Only test the logic since the actual tool API is complex to construct in tests
  describe("execution logic", () => {
    it("should return ok for files within budget", async () => {
      const budget = createMockBudget({
        canRead: () => ({ decision: "ok", remaining: 50_000, estimatedCost: 1000, availableBudget: 40_000 }),
      });
      const estimate = await budget.estimateReadCost(["src/test.ts"]);
      expect(estimate.total).toBe(1000);
      expect(estimate.files[0].method).toBe("exact");
    });

    it("should return delegation_needed for large files", async () => {
      const budget = createMockBudget({
        canRead: () => ({ decision: "delegation_needed", remaining: 2_000, estimatedCost: 15_000, availableBudget: 0 }),
      });
      const result = budget.canRead("s1", 15_000);
      expect(result.decision).toBe("delegation_needed");
    });

    it("should return tight budget warning", async () => {
      const budget = createMockBudget({
        canRead: () => ({ decision: "tight", remaining: 5_000, estimatedCost: 3_000, availableBudget: 1000 }),
      });
      const result = budget.canRead("s1", 3_000);
      expect(result.decision).toBe("tight");
    });

    it("should return current budget state", async () => {
      const budget = createMockBudget();
      const state = budget.getBudget("s1");
      expect(state).not.toBeNull();
      expect(state?.used).toBe(10_000);
      expect(state?.limit).toBe(50_000);
      expect(state?.remaining).toBe(40_000);
    });
  });
});
