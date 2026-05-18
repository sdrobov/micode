import { beforeEach, describe, expect, it } from "bun:test";
import { type ContextPinnerHooks, createContextPinnerHook } from "../../src/hooks/context-pinner";
import type { ContinuityHookConfig } from "../../src/hooks/continuity-anchor";
import { resetContinuityRegistry } from "../../src/hooks/continuity-anchor";

const SMALL_CONTEXT_CONFIG: ContinuityHookConfig = {
  smallContext: {
    mode: "auto",
    autoThreshold: 128_000,
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
  modelContextLimits: new Map([["openai/gpt-4o", 64_000]]),
};

describe("context-pinner", () => {
  let hook: ContextPinnerHooks;

  beforeEach(() => {
    resetContinuityRegistry();
  });

  function createHook(hookConfig?: ContinuityHookConfig): ContextPinnerHooks {
    return createContextPinnerHook(hookConfig);
  }

  describe("chat.message", () => {
    it("should capture goal from first user message", async () => {
      hook = createHook();

      await hook["chat.message"](
        { sessionID: "s1", parts: [{ type: "text", text: "Implement user authentication with JWT" }] },
        { parts: [] },
      );

      const output = { system: "You are an assistant." };
      await hook["chat.params"]({ sessionID: "s1" }, output);
      expect(output.system).toBe("You are an assistant.");
    });

    it("should extract plan from message text", async () => {
      hook = createHook();

      await hook["chat.message"](
        {
          sessionID: "s1",
          parts: [
            { type: "text", text: "Add login. Plan: create routes, add middleware, write tests. DoD: all tests pass" },
          ],
        },
        { parts: [] },
      );

      for (let i = 0; i < 4; i++) {
        await hook["chat.message"]({ sessionID: "s1", parts: [{ type: "text", text: "ok" }] }, { parts: [] });
      }

      const output = { system: "You are an assistant." };
      await hook["chat.params"]({ sessionID: "s1" }, output);

      expect(output.system).toContain("<context-reminder");
      expect(output.system).toContain("create routes, add middleware, write tests");
    });

    it("should prefer an explicit plan correction in small-context mode", async () => {
      hook = createHook(SMALL_CONTEXT_CONFIG);

      await hook["chat.message"](
        {
          sessionID: "s1",
          parts: [{ type: "text", text: "Ship the hook update. Plan: patch context-pinner, update tests" }],
        },
        { parts: [] },
      );

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "s1",
              role: "assistant",
              providerID: "openai",
              modelID: "gpt-4o",
            },
          },
        },
      });

      await hook["chat.message"](
        {
          sessionID: "s1",
          parts: [{ type: "text", text: "Updated plan: keep ledger-loader clean first, then adjust context-pinner" }],
        },
        { parts: [] },
      );

      const output = { context: [] as string[] };
      await hook["experimental.session.compacting"]({ sessionID: "s1" }, output);

      expect(output.context[0]).toContain("Accepted plan: keep ledger-loader clean first");
      expect(output.context[0]).not.toContain("patch context-pinner, update tests");
    });
  });

  describe("chat.params", () => {
    it("should inject reminder at correct interval", async () => {
      hook = createHook();

      for (let i = 0; i < 5; i++) {
        await hook["chat.message"]({ sessionID: "s2", parts: [{ type: "text", text: `message ${i}` }] }, { parts: [] });
      }

      const output = { system: "System prompt." };
      await hook["chat.params"]({ sessionID: "s2" }, output);

      expect(output.system).toContain("<context-reminder");
      expect(output.system).toContain('session="s2"');
    });

    it("should not inject reminder before interval", async () => {
      hook = createHook();

      await hook["chat.message"]({ sessionID: "s3", parts: [{ type: "text", text: "hello" }] }, { parts: [] });

      const output = { system: "System prompt." };
      await hook["chat.params"]({ sessionID: "s3" }, output);

      expect(output.system).toBe("System prompt.");
    });

    it("should inject the compact anchor for detected small-context sessions", async () => {
      hook = createHook(SMALL_CONTEXT_CONFIG);

      await hook["chat.message"](
        {
          sessionID: "s-small",
          parts: [{ type: "text", text: "Refine batching. Plan: add helper, update auto compact" }],
        },
        { parts: [] },
      );

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "s-small",
              role: "assistant",
              providerID: "openai",
              modelID: "gpt-4o",
            },
          },
        },
      });

      for (let i = 0; i < 4; i++) {
        await hook["chat.message"]({ sessionID: "s-small", parts: [{ type: "text", text: "ok" }] }, { parts: [] });
      }

      const output = { system: "System prompt." };
      await hook["chat.params"]({ sessionID: "s-small" }, output);

      expect(output.system).toContain("<continuity-anchor");
      expect(output.system).toContain("Accepted plan: add helper");
      expect(output.system).not.toContain("<context-reminder");
    });
  });

  describe("event - session.deleted", () => {
    it("should clean up state on session deletion", async () => {
      hook = createHook();

      await hook["chat.message"]({ sessionID: "s4", parts: [{ type: "text", text: "goal" }] }, { parts: [] });

      await hook.event({
        event: { type: "session.deleted", properties: { info: { id: "s4" } } },
      });

      for (let i = 0; i < 4; i++) {
        await hook["chat.message"]({ sessionID: "s4", parts: [{ type: "text", text: `m${i}` }] }, { parts: [] });
      }

      const output = { system: "System." };
      await hook["chat.params"]({ sessionID: "s4" }, output);

      expect(output.system).toBe("System.");
    });
  });

  describe("event - message.updated with summary", () => {
    it("should set pendingPostCompaction on summary event", async () => {
      hook = createHook();

      await hook["chat.message"](
        { sessionID: "s5", parts: [{ type: "text", text: "Build feature X" }] },
        { parts: [] },
      );

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: { sessionID: "s5", summary: true },
          },
        },
      });

      const output = { system: "System." };
      await hook["chat.params"]({ sessionID: "s5" }, output);

      expect(output.system).toContain("<context-reminder");
    });
  });

  describe("experimental.session.compacting", () => {
    it("should augment compaction prompt with preservation instruction in legacy mode", async () => {
      hook = createHook();

      const output = { prompt: "Create a structured summary of this session." };
      await hook["experimental.session.compacting"]({ sessionID: "s1" }, output);

      expect(output.prompt).toContain("goal");
      expect(output.prompt).toContain("Preserve");
    });

    it("should inject the compact anchor into compaction context for small-context mode", async () => {
      hook = createHook(SMALL_CONTEXT_CONFIG);

      await hook["chat.message"](
        {
          sessionID: "s-compaction",
          parts: [{ type: "text", text: "Stabilize resume flow. Plan: preserve the accepted plan" }],
        },
        { parts: [] },
      );

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "s-compaction",
              role: "assistant",
              providerID: "openai",
              modelID: "gpt-4o",
            },
          },
        },
      });

      const output = { context: [] as string[], prompt: "base prompt" };
      await hook["experimental.session.compacting"]({ sessionID: "s-compaction" }, output);

      expect(output.context).toHaveLength(1);
      expect(output.context[0]).toContain("<continuity-anchor");
      expect(output.prompt).toBe("base prompt");
    });
  });
});
