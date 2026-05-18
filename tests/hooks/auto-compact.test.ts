import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { PluginInput } from "@opencode-ai/plugin";

import { type AutoCompactConfig, createAutoCompactHook } from "../../src/hooks/auto-compact";
import type { ContinuityHookConfig } from "../../src/hooks/continuity-anchor";
import {
  mergeSessionContinuityAnchor,
  resetContinuityRegistry,
  updateSessionContinuityProfile,
} from "../../src/hooks/continuity-anchor";

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

describe("auto-compact", () => {
  let testDir: string;

  beforeEach(() => {
    resetContinuityRegistry();
    testDir = join(process.cwd(), ".test-artifacts", `auto-compact-${Date.now()}`);
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  function createMockCtx(overrides?: Record<string, unknown>): PluginInput {
    return {
      directory: testDir,
      client: {
        session: {
          summarize: async () => {},
          messages: async () => ({ data: [] }),
          prompt: async () => {},
          abort: async () => {},
        },
        tui: {
          showToast: async () => {},
        },
      },
      ...overrides,
    } as unknown as PluginInput;
  }

  describe("createAutoCompactHook", () => {
    it("should return a hook with event handler", () => {
      const hook = createAutoCompactHook(createMockCtx());
      expect(hook.event).toBeDefined();
      expect(typeof hook.event).toBe("function");
    });

    it("should accept optional config with custom threshold", () => {
      const hookConfig: AutoCompactConfig = { compactionThreshold: 0.5 };
      const hook = createAutoCompactHook(createMockCtx(), hookConfig);
      expect(hook.event).toBeDefined();
    });
  });

  describe("session.deleted event", () => {
    it("should handle session deletion gracefully", async () => {
      const hook = createAutoCompactHook(createMockCtx());

      await hook.event({
        event: {
          type: "session.deleted",
          properties: { info: { id: "session-123" } },
        },
      });
    });

    it("should handle missing session info on deletion", async () => {
      const hook = createAutoCompactHook(createMockCtx());

      await hook.event({
        event: {
          type: "session.deleted",
          properties: {},
        },
      });
    });
  });

  describe("message.updated event", () => {
    it("should ignore non-assistant messages", async () => {
      let summarizeCalled = false;
      const ctx = createMockCtx({
        client: {
          session: {
            summarize: async () => {
              summarizeCalled = true;
            },
            messages: async () => ({ data: [] }),
            prompt: async () => {},
          },
          tui: { showToast: async () => {} },
        },
      });

      const hook = createAutoCompactHook(ctx, { compactionThreshold: 0.5 });

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "s1",
              role: "user",
              tokens: { input: 100_000, cache: { read: 50_000 } },
              modelID: "claude-sonnet",
              providerID: "anthropic",
            },
          },
        },
      });

      expect(summarizeCalled).toBe(false);
    });

    it("should ignore messages without sessionID", async () => {
      let summarizeCalled = false;
      const ctx = createMockCtx({
        client: {
          session: {
            summarize: async () => {
              summarizeCalled = true;
            },
            messages: async () => ({ data: [] }),
            prompt: async () => {},
          },
          tui: { showToast: async () => {} },
        },
      });

      const hook = createAutoCompactHook(ctx, { compactionThreshold: 0.5 });

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              role: "assistant",
              tokens: { input: 180_000 },
              modelID: "claude-sonnet",
            },
          },
        },
      });

      expect(summarizeCalled).toBe(false);
    });

    it("should ignore messages with zero tokens", async () => {
      let summarizeCalled = false;
      const ctx = createMockCtx({
        client: {
          session: {
            summarize: async () => {
              summarizeCalled = true;
            },
            messages: async () => ({ data: [] }),
            prompt: async () => {},
          },
          tui: { showToast: async () => {} },
        },
      });

      const hook = createAutoCompactHook(ctx, { compactionThreshold: 0.5 });

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "s1",
              role: "assistant",
              tokens: { input: 0 },
              modelID: "claude-sonnet",
              providerID: "anthropic",
            },
          },
        },
      });

      expect(summarizeCalled).toBe(false);
    });

    it("should not trigger compaction when below threshold", async () => {
      let summarizeCalled = false;
      const ctx = createMockCtx({
        client: {
          session: {
            summarize: async () => {
              summarizeCalled = true;
            },
            messages: async () => ({ data: [] }),
            prompt: async () => {},
          },
          tui: { showToast: async () => {} },
        },
      });

      const hook = createAutoCompactHook(ctx);

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "s1",
              role: "assistant",
              tokens: { input: 50_000, cache: { read: 0 } },
              modelID: "claude-sonnet",
              providerID: "anthropic",
            },
          },
        },
      });

      expect(summarizeCalled).toBe(false);
    });

    it("should resolve pending compaction on summary message", async () => {
      const ctx = createMockCtx();
      const hook = createAutoCompactHook(ctx);

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "s1",
              role: "assistant",
              summary: true,
            },
          },
        },
      });
    });

    it("should use custom model limits when provided", async () => {
      let summarizeCalled = false;
      const ctx = createMockCtx({
        client: {
          session: {
            summarize: async () => {
              summarizeCalled = true;
            },
            messages: async () => ({ data: [] }),
            prompt: async () => {},
          },
          tui: { showToast: async () => {} },
        },
      });

      const customLimits = new Map([["anthropic/claude-sonnet", 100_000]]);
      const hook = createAutoCompactHook(ctx, {
        compactionThreshold: 0.5,
        modelContextLimits: customLimits,
      });

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "s1",
              role: "assistant",
              tokens: { input: 40_000 },
              modelID: "claude-sonnet",
              providerID: "anthropic",
            },
          },
        },
      });

      expect(summarizeCalled).toBe(false);
    });

    it("should not compact unresolved models without an override", async () => {
      let summarizeCalled = false;
      const ctx = createMockCtx({
        client: {
          session: {
            summarize: async () => {
              summarizeCalled = true;
            },
            messages: async () => ({ data: [] }),
            prompt: async () => {},
          },
          tui: { showToast: async () => {} },
        },
      });

      const hook = createAutoCompactHook(ctx, {
        compactionThreshold: 0.5,
        smallContext: {
          mode: "auto",
          autoThreshold: 96_000,
          continuityAnchor: { enabled: true, budgetTokens: 120 },
          outputGovernor: { enabled: true, reserveTokens: 4_096 },
          promptBudgeting: { enabled: true, maxPromptRatio: 0.7, reserveTokens: 8_192 },
        },
      });

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "s-unresolved",
              role: "assistant",
              tokens: { input: 120_000 },
              modelID: "mystery-model",
              providerID: "custom",
            },
          },
        },
      });

      expect(summarizeCalled).toBe(false);
    });

    it("should compact unknown models when a context override is configured", async () => {
      let summarizeCalled = false;
      const ctx = createMockCtx({
        client: {
          session: {
            summarize: async () => {
              summarizeCalled = true;
              setTimeout(() => {
                void hook.event({
                  event: {
                    type: "message.updated",
                    properties: {
                      info: {
                        sessionID: "s-override",
                        role: "assistant",
                        summary: true,
                      },
                    },
                  },
                });
              }, 10);
            },
            messages: async () => ({ data: [] }),
            prompt: async () => {},
          },
          tui: { showToast: async () => {} },
        },
      });

      const hook = createAutoCompactHook(ctx, {
        compactionThreshold: 0.5,
        smallContext: {
          mode: "auto",
          autoThreshold: 96_000,
          contextLimitOverride: 64_000,
          continuityAnchor: { enabled: true, budgetTokens: 120 },
          outputGovernor: { enabled: true, reserveTokens: 4_096 },
          promptBudgeting: { enabled: true, maxPromptRatio: 0.7, reserveTokens: 8_192 },
        },
      });

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "s-override",
              role: "assistant",
              tokens: { input: 40_000 },
              modelID: "mystery-model",
              providerID: "custom",
            },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(summarizeCalled).toBe(true);
    });

    it("should continue from the continuity anchor for small-context sessions", async () => {
      const promptTexts: string[] = [];
      const summaryText = `# Session Summary

## Goal
Stabilize continuity

## Constraints & Preferences
- Keep changes scoped

## Progress
### Done
- [x] Added shared helper

### In Progress
- [ ] Wire auto compact follow-up

### Blocked
- (none)

## Key Decisions
- **Use anchor**: Keep the accepted plan after compaction

## Next Steps
1. Finish the auto compact prompt
2. Update tests

## Critical Context
- Preserve the corrected plan`;

      const ctx = createMockCtx({
        client: {
          session: {
            summarize: async () => {
              setTimeout(() => {
                void hook.event({
                  event: {
                    type: "message.updated",
                    properties: {
                      info: {
                        sessionID: "s-anchor",
                        role: "assistant",
                        summary: true,
                      },
                    },
                  },
                });
              }, 10);
            },
            messages: async () => ({
              data: [
                {
                  info: { role: "assistant", summary: true },
                  parts: [{ type: "text", text: summaryText }],
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

      const hookConfig: AutoCompactConfig = {
        compactionThreshold: 0.5,
        ...SMALL_CONTEXT_CONFIG,
      };
      const hook = createAutoCompactHook(ctx, hookConfig);

      mergeSessionContinuityAnchor(
        "s-anchor",
        {
          goal: "Stabilize continuity",
          acceptedPlan: "Keep ledger-loader clean first, then adjust auto compact",
          currentStep: "Finish the auto compact prompt",
          constraints: ["Keep changes scoped"],
        },
        120,
      );
      updateSessionContinuityProfile("s-anchor", "gpt-4o", "openai", hookConfig);

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              sessionID: "s-anchor",
              role: "assistant",
              tokens: { input: 40_000 },
              modelID: "gpt-4o",
              providerID: "openai",
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(promptTexts).toHaveLength(1);
      expect(promptTexts[0]).toContain("<continuity-anchor");
      expect(promptTexts[0]).toContain("Accepted plan: Keep ledger-loader clean first");
      expect(promptTexts[0]).toContain("Current step: Wire auto compact follow-up");
    });
  });

  describe("unknown event types", () => {
    it("should ignore unrecognized events", async () => {
      const hook = createAutoCompactHook(createMockCtx());

      await hook.event({
        event: { type: "some.unknown.event", properties: {} },
      });
    });
  });
});
