import { describe, expect, it } from "bun:test";

import type { ContextBudgetHooks } from "../../src/hooks/context-budget";
import { createCheckContextBudgetTool } from "../../src/tools/check-context-budget";

function createMockBudget(overrides?: Partial<ContextBudgetHooks>): ContextBudgetHooks {
  return {
    "chat.params": async () => {},
    event: async () => {},
    estimateReadCost: async (paths) => ({
      total: paths.length * 1000,
      files: paths.map((p) => ({ path: p, estimated: 1000, method: "exact" })),
    }),
    canRead: () => ({ decision: "ok", remaining: 50_000, estimatedCost: 1000, availableBudget: 40_000 }),
    assessFanout: async (sessionID, opts) => {
      const fileEstimates = (opts.files ?? []).map((path) => ({ path, estimated: 1000, method: "exact" as const }));
      return {
        active: false,
        decision: "direct_ok",
        reasons: [],
        estimatedCost: fileEstimates.length * 1000,
        fileEstimates,
        readDecision: "ok",
        fileCount: fileEstimates.length,
        extrapolatedFileCount: 0,
        largeFileCount: 0,
        expectedToolCalls: opts.expectedToolCalls ?? 0,
        mixedToolCount: opts.plannedTools?.length ?? 0,
        remaining: sessionID === "s1" ? 50_000 : 40_000,
        availableBudget: 40_000,
      };
    },
    getBudget: () => ({ used: 10_000, limit: 50_000, remaining: 40_000 }),
    getOutputGovernorState: () => ({
      active: false,
      reason: "disabled",
      mode: "off",
      used: 10_000,
      limit: 50_000,
      remaining: 40_000,
      reserveTokens: 0,
      availableTokens: 40_000,
      charPerToken: 2,
    }),
    ...overrides,
  };
}

describe("check-context-budget tool", () => {
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

  describe("tool output", () => {
    it("should include proactive fanout guidance for broad investigations", async () => {
      const budget = createMockBudget({
        assessFanout: async (_sessionID, opts) => ({
          active: true,
          decision: "fanout_recommended",
          reasons: ["investigation spans 4 files", "3 tool types are mixed in one investigation"],
          estimatedCost: 4_000,
          fileEstimates: (opts.files ?? []).map((path) => ({ path, estimated: 1000, method: "exact" as const })),
          readDecision: "ok",
          fileCount: opts.files?.length ?? 0,
          extrapolatedFileCount: 0,
          largeFileCount: 0,
          expectedToolCalls: opts.expectedToolCalls ?? 0,
          mixedToolCount: opts.plannedTools?.length ?? 0,
          remaining: 40_000,
          availableBudget: 30_000,
        }),
      });
      const tool = createCheckContextBudgetTool(budget).check_context_budget;
      const result = await tool.execute(
        {
          files: ["a.ts", "b.ts", "c.ts", "d.ts"],
          expectedToolCalls: 5,
          plannedTools: ["Glob", "Grep", "Read"],
          investigationType: "broad_exploration",
        },
        { sessionID: "s1" },
      );
      const parsed = JSON.parse(result);

      expect(parsed.result.decision).toBe("ok");
      expect(parsed.result.fanoutDecision).toBe("fanout_recommended");
      expect(parsed.fanout.active).toBe(true);
      expect(parsed.recommendation).toContain("Prefer summary fanout");
    });
  });
});
