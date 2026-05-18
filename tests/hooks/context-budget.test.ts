import { afterEach, describe, expect, it } from "bun:test";

import type { ContextBudgetHooks } from "../../src/hooks/context-budget";
import { createContextBudgetHook } from "../../src/hooks/context-budget";

function createMockCtx() {
  return {
    client: { session: { messages: async () => ({ data: [] }) }, tui: { showToast: async () => {} } },
  } as any;
}

describe("context-budget", () => {
  let hook: ContextBudgetHooks;

  afterEach(() => {
    hook = null as unknown as ContextBudgetHooks;
  });

  describe("createContextBudgetHook", () => {
    it("should return handler object with all expected keys", () => {
      hook = createContextBudgetHook(createMockCtx());
      expect(hook).toHaveProperty(["chat.params"]);
      expect(hook).toHaveProperty("event");
      expect(hook).toHaveProperty("estimateReadCost");
      expect(hook).toHaveProperty("canRead");
      expect(hook).toHaveProperty("assessFanout");
      expect(hook).toHaveProperty("getBudget");
      expect(hook).toHaveProperty("getOutputGovernorState");
    });
  });

  describe("event handler - message.updated", () => {
    it("should track token usage from message.updated events", async () => {
      hook = createContextBudgetHook(createMockCtx(), {
        modelContextLimits: new Map([["anthropic/claude-sonnet", 200_000]]),
      });

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "s1",
              role: "assistant",
              tokens: { input: 10_000, cache: { read: 2_000 } },
              modelID: "claude-sonnet",
              providerID: "anthropic",
            },
          },
        },
      } as any);

      const budget = hook.getBudget("s1");
      expect(budget).not.toBeNull();
      expect(budget?.used).toBe(12_000); // 10_000 + 2_000
      expect(budget?.limit).toBe(200_000); // default limit
    });

    it("should ignore user role messages", async () => {
      hook = createContextBudgetHook(createMockCtx());

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "s1",
              role: "user",
              tokens: { input: 50_000 },
              modelID: "claude-sonnet",
              providerID: "anthropic",
            },
          },
        },
      } as any);

      expect(hook.getBudget("s1")).toBeNull();
    });
  });

  describe("event handler - session.deleted", () => {
    it("should clean up session state on deletion", async () => {
      hook = createContextBudgetHook(createMockCtx());

      await hook.event({
        event: {
          type: "message.updated",
          properties: { info: { sessionID: "s1", role: "assistant", tokens: { input: 10_000 } } },
        } as any,
      });

      expect(hook.getBudget("s1")).not.toBeNull();

      await hook.event({
        event: { type: "session.deleted", properties: { info: { id: "s1" } } } as any,
      });

      expect(hook.getBudget("s1")).toBeNull();
    });
  });

  describe("canRead", () => {
    it("should return ok when budget has plenty of room", () => {
      hook = createContextBudgetHook(createMockCtx(), { defaultContextLimit: 50_000 });

      // Simulate 10K used
      hook.event({
        event: {
          type: "message.updated",
          properties: { info: { sessionID: "s1", role: "assistant", tokens: { input: 10_000 } } },
        } as any,
      });

      const result = hook.canRead("s1", 2_000);
      expect(result.decision).toBe("ok");
    });

    it("should return delegation_needed when cost exceeds maxReadRatio", () => {
      hook = createContextBudgetHook(createMockCtx(), { defaultContextLimit: 10_000, maxReadRatio: 0.3 });

      // 0 used, 10K limit, 30% = 3K max allowed
      const result = hook.canRead("s1", 5_000);
      expect(result.decision).toBe("delegation_needed");
    });

    it("should return tight when remaining after read is below minRemainingRatio", () => {
      hook = createContextBudgetHook(createMockCtx(), {
        defaultContextLimit: 10_000,
        maxReadRatio: 0.5,
        minRemainingRatio: 0.25,
      });

      // 8K used, 2K remaining. Read cost 500. After: 1.5K remaining. minRemaining = 2.5K.
      // 1.5K < 2.5K → tight
      hook.event({
        event: {
          type: "message.updated",
          properties: { info: { sessionID: "s1", role: "assistant", tokens: { input: 8_000 } } },
        } as any,
      });

      const result = hook.canRead("s1", 500);
      expect(result.decision).toBe("tight");
    });

    it("should return delegation_needed when budget is exhausted", () => {
      hook = createContextBudgetHook(createMockCtx(), { defaultContextLimit: 10_000 });

      // 10K used → 0 remaining
      hook.event({
        event: {
          type: "message.updated",
          properties: { info: { sessionID: "s1", role: "assistant", tokens: { input: 10_000 } } },
        } as any,
      });

      const result = hook.canRead("s1", 100);
      expect(result.decision).toBe("delegation_needed");
    });
  });

  describe("session isolation", () => {
    it("should track different sessions independently", () => {
      hook = createContextBudgetHook(createMockCtx(), { defaultContextLimit: 50_000 });

      hook.event({
        event: {
          type: "message.updated",
          properties: { info: { sessionID: "s1", role: "assistant", tokens: { input: 30_000 } } },
        } as any,
      });
      hook.event({
        event: {
          type: "message.updated",
          properties: { info: { sessionID: "s2", role: "assistant", tokens: { input: 5_000 } } },
        } as any,
      });

      const s1Budget = hook.getBudget("s1");
      const s2Budget = hook.getBudget("s2");
      expect(s1Budget?.used).toBe(30_000);
      expect(s2Budget?.used).toBe(5_000);
    });
  });

  describe("getOutputGovernorState", () => {
    it("should activate for explicitly enabled small-context mode", () => {
      hook = createContextBudgetHook(createMockCtx(), {
        defaultContextLimit: 12_000,
        charPerToken: 1,
        smallContext: {
          mode: "on",
          autoThreshold: 8_000,
          continuityAnchor: { enabled: true, budgetTokens: 900 },
          outputGovernor: { enabled: true, reserveTokens: 2_000 },
          promptBudgeting: { enabled: true, maxPromptRatio: 0.5, reserveTokens: 4_000 },
        },
      });

      const state = hook.getOutputGovernorState("session-1");

      expect(state.active).toBe(true);
      expect(state.availableTokens).toBe(10_000);
      expect(state.reason).toBe("active");
    });

    it("should auto-activate for known small-context models", async () => {
      hook = createContextBudgetHook(createMockCtx(), {
        charPerToken: 1,
        smallContext: {
          mode: "auto",
          autoThreshold: 96_000,
          continuityAnchor: { enabled: true, budgetTokens: 900 },
          outputGovernor: { enabled: true, reserveTokens: 4_000 },
          promptBudgeting: { enabled: true, maxPromptRatio: 0.5, reserveTokens: 4_000 },
        },
        modelContextLimits: new Map([["custom/model-a", 64_000]]),
      });

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "session-1",
              role: "assistant",
              tokens: { input: 10_000 },
              modelID: "model-a",
              providerID: "custom",
            },
          },
        } as any,
      });

      const state = hook.getOutputGovernorState("session-1");

      expect(state.active).toBe(true);
      expect(state.availableTokens).toBe(50_000);
    });

    it("should stay inactive for unknown models in auto mode", async () => {
      hook = createContextBudgetHook(createMockCtx(), {
        defaultContextLimit: 64_000,
        charPerToken: 1,
        smallContext: {
          mode: "auto",
          autoThreshold: 256_000,
          continuityAnchor: { enabled: true, budgetTokens: 900 },
          outputGovernor: { enabled: true, reserveTokens: 4_000 },
          promptBudgeting: { enabled: true, maxPromptRatio: 0.5, reserveTokens: 4_000 },
        },
      });

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "session-1",
              role: "assistant",
              tokens: { input: 10_000 },
              modelID: "mystery-model",
              providerID: "custom",
            },
          },
        } as any,
      });

      const state = hook.getOutputGovernorState("session-1");

      expect(state.active).toBe(false);
      expect(state.reason).toBe("unknown_model");
    });

    it("should stay inactive for known large-context models in auto mode", async () => {
      hook = createContextBudgetHook(createMockCtx(), {
        charPerToken: 1,
        modelContextLimits: new Map([["anthropic/claude-sonnet", 200_000]]),
        smallContext: {
          mode: "auto",
          autoThreshold: 96_000,
          continuityAnchor: { enabled: true, budgetTokens: 900 },
          outputGovernor: { enabled: true, reserveTokens: 4_000 },
          promptBudgeting: { enabled: true, maxPromptRatio: 0.5, reserveTokens: 4_000 },
        },
      });

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "session-1",
              role: "assistant",
              tokens: { input: 10_000 },
              modelID: "claude-sonnet",
              providerID: "anthropic",
            },
          },
        } as any,
      });

      const state = hook.getOutputGovernorState("session-1");

      expect(state.active).toBe(false);
      expect(state.reason).toBe("non_small_context");
    });

    it("should activate for unknown models when a context override is configured", async () => {
      hook = createContextBudgetHook(createMockCtx(), {
        charPerToken: 1,
        smallContext: {
          mode: "auto",
          autoThreshold: 96_000,
          contextLimitOverride: 64_000,
          continuityAnchor: { enabled: true, budgetTokens: 900 },
          outputGovernor: { enabled: true, reserveTokens: 4_000 },
          promptBudgeting: { enabled: true, maxPromptRatio: 0.5, reserveTokens: 4_000 },
        },
      });

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "session-override",
              role: "assistant",
              tokens: { input: 10_000 },
              modelID: "mystery-model",
              providerID: "custom",
            },
          },
        } as any,
      });

      const state = hook.getOutputGovernorState("session-override");

      expect(state.active).toBe(true);
      expect(state.availableTokens).toBe(50_000);
      expect(state.reason).toBe("active");
    });
  });

  describe("assessFanout", () => {
    it("should recommend fanout for broad multi-file work in small-context mode", async () => {
      hook = createContextBudgetHook(createMockCtx(), {
        defaultContextLimit: 32_000,
        smallContext: {
          mode: "on",
          autoThreshold: 96_000,
          continuityAnchor: { enabled: true, budgetTokens: 900 },
          outputGovernor: { enabled: true, reserveTokens: 2_000 },
          promptBudgeting: { enabled: true, maxPromptRatio: 0.5, reserveTokens: 4_000 },
        },
      });

      const result = await hook.assessFanout("session-1", {
        files: ["a.ts", "b.ts", "c.ts", "d.ts"],
        expectedToolCalls: 5,
        plannedTools: ["Glob", "Grep", "Read"],
        investigationType: "broad_exploration",
      });

      expect(result.active).toBe(true);
      expect(result.decision).toBe("fanout_required");
      expect(result.reasons).toContain("investigation spans 4 files");
    });

    it("should stay direct for non-small-context sessions", async () => {
      hook = createContextBudgetHook(createMockCtx(), {
        modelContextLimits: new Map([["anthropic/claude-sonnet", 200_000]]),
        smallContext: {
          mode: "auto",
          autoThreshold: 96_000,
          continuityAnchor: { enabled: true, budgetTokens: 900 },
          outputGovernor: { enabled: true, reserveTokens: 2_000 },
          promptBudgeting: { enabled: true, maxPromptRatio: 0.5, reserveTokens: 4_000 },
        },
      });

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "session-large",
              role: "assistant",
              tokens: { input: 10_000 },
              modelID: "claude-sonnet",
              providerID: "anthropic",
            },
          },
        } as any,
      });

      const result = await hook.assessFanout("session-large", {
        files: ["a.ts", "b.ts", "c.ts", "d.ts"],
        expectedToolCalls: 5,
        plannedTools: ["Glob", "Grep", "Read"],
        investigationType: "broad_exploration",
      });

      expect(result.active).toBe(false);
      expect(result.decision).toBe("direct_ok");
    });

    it("should require fanout after compaction for a broad resume investigation", async () => {
      hook = createContextBudgetHook(createMockCtx(), {
        defaultContextLimit: 32_000,
        smallContext: {
          mode: "on",
          autoThreshold: 96_000,
          continuityAnchor: { enabled: true, budgetTokens: 900 },
          outputGovernor: { enabled: true, reserveTokens: 2_000 },
          promptBudgeting: { enabled: true, maxPromptRatio: 0.5, reserveTokens: 4_000 },
        },
      });

      const result = await hook.assessFanout("session-1", {
        files: ["a.ts", "b.ts"],
        expectedToolCalls: 3,
        plannedTools: ["Glob", "Read", "look_at"],
        continuingAfterCompaction: true,
        investigationType: "architecture_trace",
      });

      expect(result.decision).toBe("fanout_required");
      expect(result.reasons).toContain("this is the first broad investigation after compaction or resume");
    });
  });
});
