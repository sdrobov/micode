import { describe, expect, it } from "bun:test";

import { type ContextPinnerHooks, createContextPinnerHook } from "../../src/hooks/context-pinner";

describe("context-pinner", () => {
  let hook: ContextPinnerHooks;

  function createHook(): ContextPinnerHooks {
    return createContextPinnerHook();
  }

  describe("chat.message", () => {
    it("should capture goal from first user message", async () => {
      hook = createHook();

      await hook["chat.message"](
        { sessionID: "s1", parts: [{ type: "text", text: "Implement user authentication with JWT" }] },
        { parts: [] },
      );

      // Trigger params to check state via reminder injection
      const output = { system: "You are an assistant." };
      await hook["chat.params"]({ sessionID: "s1" }, output);
      // Not yet at reminder interval, so no injection yet
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

      // Inject 4 more messages to reach count 5 (reminder interval)
      for (let i = 0; i < 4; i++) {
        await hook["chat.message"]({ sessionID: "s1", parts: [{ type: "text", text: "ok" }] }, { parts: [] });
      }

      const output = { system: "You are an assistant." };
      await hook["chat.params"]({ sessionID: "s1" }, output);

      expect(output.system).toContain("<context-reminder");
      expect(output.system).toContain("create routes, add middleware, write tests");
    });
  });

  describe("chat.params", () => {
    it("should inject reminder at correct interval", async () => {
      hook = createHook();

      // 5 messages to trigger interval (default 5)
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
  });

  describe("event - session.deleted", () => {
    it("should clean up state on session deletion", async () => {
      hook = createHook();

      await hook["chat.message"]({ sessionID: "s4", parts: [{ type: "text", text: "goal" }] }, { parts: [] });

      await hook.event({
        event: { type: "session.deleted", properties: { info: { id: "s4" } } },
      });

      // After deletion, state is cleared
      // Use 4 messages to stay below reminder interval
      for (let i = 0; i < 4; i++) {
        await hook["chat.message"]({ sessionID: "s4", parts: [{ type: "text", text: `m${i}` }] }, { parts: [] });
      }

      const output = { system: "System." };
      await hook["chat.params"]({ sessionID: "s4" }, output);

      // New state should be fresh (no goal, no existing state)
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

      // Simulate compaction
      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: { sessionID: "s5", summary: true },
          },
        },
      });

      // Next chat.params should inject reminder
      const output = { system: "System." };
      await hook["chat.params"]({ sessionID: "s5" }, output);

      expect(output.system).toContain("<context-reminder");
    });
  });

  describe("experimental.session.compacting", () => {
    it("should augment compaction prompt with preservation instruction", async () => {
      hook = createHook();

      const output = { prompt: "Create a structured summary of this session." };
      await hook["experimental.session.compacting"]({ sessionID: "s1" }, output);

      expect(output.prompt).toContain("goal");
      expect(output.prompt).toContain("Preserve");
    });
  });
});
