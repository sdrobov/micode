import { beforeEach, describe, expect, it } from "bun:test";

import type { ContinuityHookConfig } from "../../src/hooks/continuity-anchor";
import {
  mergeSessionContinuityAnchor,
  resetContinuityRegistry,
  updateSessionContinuityProfile,
} from "../../src/hooks/continuity-anchor";
import { createSessionRecoveryHook } from "../../src/hooks/session-recovery";

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

describe("session-recovery", () => {
  beforeEach(() => {
    resetContinuityRegistry();
  });

  function createMockCtx(overrides?: Record<string, unknown>) {
    return {
      directory: "/test",
      client: {
        session: {
          abort: async () => {},
          messages: async () => ({
            data: [
              {
                info: { role: "user" },
                parts: [{ type: "text", text: "Do something" }],
              },
            ],
          }),
          prompt: async () => {},
        },
        tui: {
          showToast: async () => {},
        },
      },
      ...overrides,
    } as any;
  }

  describe("createSessionRecoveryHook", () => {
    it("should return a hook with event handler", () => {
      const hook = createSessionRecoveryHook(createMockCtx());
      expect(hook.event).toBeDefined();
      expect(typeof hook.event).toBe("function");
    });
  });

  describe("session.error event", () => {
    it("should attempt recovery for TOOL_RESULT_MISSING error", async () => {
      let abortCalled = false;
      let promptCalled = false;
      const ctx = createMockCtx({
        client: {
          session: {
            abort: async () => {
              abortCalled = true;
            },
            messages: async () => ({
              data: [
                {
                  info: { role: "user" },
                  parts: [{ type: "text", text: "Run tests" }],
                },
              ],
            }),
            prompt: async () => {
              promptCalled = true;
            },
          },
          tui: { showToast: async () => {} },
        },
      });

      const hook = createSessionRecoveryHook(ctx);

      await hook.event({
        event: {
          type: "session.error",
          properties: {
            sessionID: "s1",
            error: "tool_result block(s) missing in the request",
          },
        },
      });

      // Give async recovery time to complete
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(abortCalled).toBe(true);
      expect(promptCalled).toBe(true);
    });

    it("should attempt recovery for THINKING_BLOCK_ORDER error", async () => {
      let abortCalled = false;
      const ctx = createMockCtx({
        client: {
          session: {
            abort: async () => {
              abortCalled = true;
            },
            messages: async () => ({
              data: [{ info: { role: "user" }, parts: [{ type: "text", text: "x" }] }],
            }),
            prompt: async () => {},
          },
          tui: { showToast: async () => {} },
        },
      });

      const hook = createSessionRecoveryHook(ctx);

      await hook.event({
        event: {
          type: "session.error",
          properties: {
            sessionID: "s1",
            error: "thinking blocks must be at the start of the response",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(abortCalled).toBe(true);
    });

    it("should attempt recovery for THINKING_DISABLED error", async () => {
      let abortCalled = false;
      const ctx = createMockCtx({
        client: {
          session: {
            abort: async () => {
              abortCalled = true;
            },
            messages: async () => ({
              data: [{ info: { role: "user" }, parts: [{ type: "text", text: "x" }] }],
            }),
            prompt: async () => {},
          },
          tui: { showToast: async () => {} },
        },
      });

      const hook = createSessionRecoveryHook(ctx);

      await hook.event({
        event: {
          type: "session.error",
          properties: {
            sessionID: "s1",
            error: "thinking is not enabled for this model",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(abortCalled).toBe(true);
    });

    it("should ignore non-recoverable errors", async () => {
      let abortCalled = false;
      const ctx = createMockCtx({
        client: {
          session: {
            abort: async () => {
              abortCalled = true;
            },
            messages: async () => ({ data: [] }),
            prompt: async () => {},
          },
          tui: { showToast: async () => {} },
        },
      });

      const hook = createSessionRecoveryHook(ctx);

      await hook.event({
        event: {
          type: "session.error",
          properties: {
            sessionID: "s1",
            error: "rate limit exceeded",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(abortCalled).toBe(false);
    });

    it("should ignore events without sessionID", async () => {
      let abortCalled = false;
      const ctx = createMockCtx({
        client: {
          session: {
            abort: async () => {
              abortCalled = true;
            },
            messages: async () => ({ data: [] }),
            prompt: async () => {},
          },
          tui: { showToast: async () => {} },
        },
      });

      const hook = createSessionRecoveryHook(ctx);

      await hook.event({
        event: {
          type: "session.error",
          properties: { error: "tool_result block(s) missing" },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(abortCalled).toBe(false);
    });

    it("should show toast with error type info during recovery", async () => {
      const toastMessages: string[] = [];
      const ctx = createMockCtx({
        client: {
          session: {
            abort: async () => {},
            messages: async () => ({
              data: [{ info: { role: "user" }, parts: [{ type: "text", text: "x" }] }],
            }),
            prompt: async () => {},
          },
          tui: {
            showToast: async ({ body }: any) => {
              toastMessages.push(body.message);
            },
          },
        },
      });

      const hook = createSessionRecoveryHook(ctx);

      await hook.event({
        event: {
          type: "session.error",
          properties: {
            sessionID: "s1",
            error: "content cannot be empty",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(toastMessages.some((m) => m.includes("empty content"))).toBe(true);
    });
  });

  describe("message.updated event with error", () => {
    it("should attempt recovery for error in message info", async () => {
      let abortCalled = false;
      const ctx = createMockCtx({
        client: {
          session: {
            abort: async () => {
              abortCalled = true;
            },
            messages: async () => ({
              data: [{ info: { role: "user" }, parts: [{ type: "text", text: "x" }] }],
            }),
            prompt: async () => {},
          },
          tui: { showToast: async () => {} },
        },
      });

      const hook = createSessionRecoveryHook(ctx);

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "s1",
              error: "tool_result must follow tool_use",
              providerID: "anthropic",
              modelID: "claude-sonnet",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(abortCalled).toBe(true);
    });

    it("should resume from the continuity anchor for small-context sessions", async () => {
      const promptTexts: string[] = [];
      const ctx = createMockCtx({
        client: {
          session: {
            abort: async () => {},
            messages: async () => ({
              data: [
                {
                  info: { role: "assistant", summary: true },
                  parts: [
                    {
                      type: "text",
                      text: `# Session Summary

## Goal
Preserve continuity

## Constraints & Preferences
- Stay scoped

## Progress
### Done
- [x] Captured corrected plan

### In Progress
- [ ] Resume session recovery

### Blocked
- (none)

## Key Decisions
- **Keep accepted plan**: Do not restart

## Next Steps
1. Finish session recovery
2. Update tests

## Critical Context
- Continue the corrected plan`,
                    },
                  ],
                },
              ],
            }),
            prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
              promptTexts.push(body.parts[0].text);
            },
          },
          tui: { showToast: async () => {} },
        },
      });

      mergeSessionContinuityAnchor("s1", {
        goal: "Preserve continuity",
        acceptedPlan: "Keep ledger-loader clean first, then adjust recovery",
      });
      updateSessionContinuityProfile("s1", "gpt-4o", "openai", SMALL_CONTEXT_CONFIG);

      const hook = createSessionRecoveryHook(ctx, SMALL_CONTEXT_CONFIG);

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "s1",
              error: "tool_result must follow tool_use",
              providerID: "openai",
              modelID: "gpt-4o",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(promptTexts).toHaveLength(1);
      expect(promptTexts[0]).toContain("<continuity-anchor");
      expect(promptTexts[0]).toContain("Accepted plan: Keep ledger-loader clean first");
      expect(promptTexts[0]).toContain("Current step: Resume session recovery");
    });
  });

  describe("session.deleted event", () => {
    it("should clean up recovery state for deleted session", async () => {
      const hook = createSessionRecoveryHook(createMockCtx());

      // Trigger a recovery to set up state
      await hook.event({
        event: {
          type: "session.error",
          properties: {
            sessionID: "s1",
            error: "content cannot be empty",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 600));

      // Delete the session
      await hook.event({
        event: {
          type: "session.deleted",
          properties: { info: { id: "s1" } },
        },
      });

      // Should not throw or cause issues
    });

    it("should handle missing session info on deletion", async () => {
      const hook = createSessionRecoveryHook(createMockCtx());

      await hook.event({
        event: {
          type: "session.deleted",
          properties: {},
        },
      });
    });
  });

  describe("error classification", () => {
    it("should handle Error objects", async () => {
      let abortCalled = false;
      const ctx = createMockCtx({
        client: {
          session: {
            abort: async () => {
              abortCalled = true;
            },
            messages: async () => ({
              data: [{ info: { role: "user" }, parts: [{ type: "text", text: "x" }] }],
            }),
            prompt: async () => {},
          },
          tui: { showToast: async () => {} },
        },
      });

      const hook = createSessionRecoveryHook(ctx);

      await hook.event({
        event: {
          type: "session.error",
          properties: {
            sessionID: "s1",
            error: new Error("tool_result block(s) missing"),
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(abortCalled).toBe(true);
    });

    it("should handle error as object (JSON stringified)", async () => {
      let abortCalled = false;
      const ctx = createMockCtx({
        client: {
          session: {
            abort: async () => {
              abortCalled = true;
            },
            messages: async () => ({
              data: [{ info: { role: "user" }, parts: [{ type: "text", text: "x" }] }],
            }),
            prompt: async () => {},
          },
          tui: { showToast: async () => {} },
        },
      });

      const hook = createSessionRecoveryHook(ctx);

      await hook.event({
        event: {
          type: "session.error",
          properties: {
            sessionID: "s2",
            error: { message: "thinking is not enabled" },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(abortCalled).toBe(true);
    });
  });

  describe("deduplication", () => {
    it("should deduplicate rapid identical errors for same session", async () => {
      let abortCount = 0;
      const ctx = createMockCtx({
        client: {
          session: {
            abort: async () => {
              abortCount++;
            },
            messages: async () => ({
              data: [{ info: { role: "user" }, parts: [{ type: "text", text: "x" }] }],
            }),
            prompt: async () => {},
          },
          tui: { showToast: async () => {} },
        },
      });

      const hook = createSessionRecoveryHook(ctx);

      // Fire two identical errors rapidly (before dedup expiry)
      await hook.event({
        event: {
          type: "session.error",
          properties: { sessionID: "s1", error: "content cannot be empty" },
        },
      });
      await hook.event({
        event: {
          type: "session.error",
          properties: { sessionID: "s1", error: "content cannot be empty" },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 600));
      // Only one recovery should have been attempted
      expect(abortCount).toBe(1);
    });
  });
});
