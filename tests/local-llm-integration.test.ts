import { describe, expect, it } from "bun:test";

import { isLocalLLMProvider } from "../src/config-schemas";
import { type ContextBudgetHooks, createContextBudgetHook } from "../src/hooks/context-budget";
import { type ContextPinnerHooks, createContextPinnerHook } from "../src/hooks/context-pinner";
import { createReadGuardHook, type ReadGuardHooks } from "../src/hooks/read-guard";
import { createToolLoopGuardHook, type ToolLoopGuardHooks } from "../src/hooks/tool-loop-guard";

function createMockCtx() {
  return {
    client: { session: { messages: async () => ({ data: [] }) }, tui: { showToast: async () => {} } },
  } as any;
}

describe("local-llm-integration - provider detection", () => {
  it("should detect ollama providers", () => {
    expect(isLocalLLMProvider("ollama/llama3")).toBe(true);
  });

  it("should not detect cloud providers", () => {
    expect(isLocalLLMProvider("openai/gpt-4o")).toBe(false);
    expect(isLocalLLMProvider("anthropic/claude-sonnet")).toBe(false);
  });

  it("should return false for undefined or empty", () => {
    expect(isLocalLLMProvider(undefined)).toBe(false);
    expect(isLocalLLMProvider("")).toBe(false);
  });
});

describe("local-llm-integration - budget tracking lifecycle", () => {
  it("should track tokens, make read decisions, and clean up on delete", async () => {
    const ctx = createMockCtx();
    const budget: ContextBudgetHooks = createContextBudgetHook(ctx, { defaultContextLimit: 32_768 });

    // Step 1: Track token usage
    await budget.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            sessionID: "test-session",
            role: "assistant",
            tokens: { input: 10_000, cache: { read: 2_000 } },
            modelID: "llama3",
            providerID: "ollama",
          },
        },
      } as any,
    });

    let budgetState = budget.getBudget("test-session");
    expect(budgetState).not.toBeNull();
    expect(budgetState?.used).toBe(12_000);

    // Step 2: Make read decision (small file should be OK)
    const okDecision = budget.canRead("test-session", 1_000);
    expect(okDecision.decision).toBe("ok");

    // Step 3: Large file should trigger delegation
    const largeDecision = budget.canRead("test-session", 15_000);
    expect(largeDecision.decision).toBe("delegation_needed");

    // Step 4: Clean up on session deleted
    await budget.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: "test-session" } },
      } as any,
    });

    budgetState = budget.getBudget("test-session");
    expect(budgetState).toBeNull();
  });
});

describe("local-llm-integration - read guard lifecycle", () => {
  it("should pass through OK reads and block large ones", async () => {
    const ctx = createMockCtx();
    const budget: ContextBudgetHooks = createContextBudgetHook(ctx, { defaultContextLimit: 32_768 });
    const guard: ReadGuardHooks = createReadGuardHook(budget);

    // Simulate low usage
    await budget.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            sessionID: "guard-session",
            role: "assistant",
            tokens: { input: 5_000 },
            modelID: "llama3",
            providerID: "ollama",
          },
        },
      } as any,
    });

    // Small read should pass through unchanged
    const passOutput = { output: "small content" };
    await guard["tool.execute.after"](
      { tool: "Read", sessionID: "guard-session", args: { path: "/small.ts" } },
      passOutput,
    );
    expect(passOutput.output).toBe("small content");

    // Large read should be guarded
    const largeOutput = { output: "x".repeat(50_000) };
    await guard["tool.execute.after"](
      { tool: "Read", sessionID: "guard-session", args: { path: "/large.ts" } },
      largeOutput,
    );
    expect(largeOutput.output).toContain("<guard>");
    expect(largeOutput.output).toContain("Delegate");
  });
});

describe("local-llm-integration - context pinner lifecycle", () => {
  it("should capture goal and inject periodic reminders", async () => {
    const pinner: ContextPinnerHooks = createContextPinnerHook();

    // Capture goal
    await pinner["chat.message"](
      {
        sessionID: "pinner-session",
        parts: [{ type: "text", text: "Implement auth. Plan: create login, middleware. DoD: tests pass." }],
      },
      { parts: [] },
    );

    // No immediate reminder before interval
    const earlyOutput = { system: "System prompt." };
    await pinner["chat.params"]({ sessionID: "pinner-session" }, earlyOutput);
    expect(earlyOutput.system).toBe("System prompt.");

    // 4 more messages triggers reminder (1 from capture + 4 = 5, 5 % 5 === 0)
    for (let i = 0; i < 4; i++) {
      await pinner["chat.message"](
        { sessionID: "pinner-session", parts: [{ type: "text", text: "continue" }] },
        { parts: [] },
      );
    }

    const reminderOutput = { system: "System prompt." };
    await pinner["chat.params"]({ sessionID: "pinner-session" }, reminderOutput);
    expect(reminderOutput.system).toContain("<context-reminder");
    expect(reminderOutput.system).toContain("Implement auth");
  });
});

describe("local-llm-integration - read guard respects non-read tools", () => {
  it("should not modify non-read tool output", async () => {
    const ctx = createMockCtx();
    const budget: ContextBudgetHooks = createContextBudgetHook(ctx, { defaultContextLimit: 10_000 });
    const guard: ReadGuardHooks = createReadGuardHook(budget);

    const editOutput = { output: "console.log('hello');" };
    await guard["tool.execute.after"]({ tool: "Edit", sessionID: "s1", args: { filePath: "/test.ts" } }, editOutput);
    expect(editOutput.output).toBe("console.log('hello');");
  });
});

describe("local-llm-integration - tool loop guard lifecycle", () => {
  it("should interrupt repeated identical failures for local LLM sessions", async () => {
    let aborts = 0;
    const prompts: string[] = [];
    const ctx = {
      client: {
        session: {
          abort: async () => {
            aborts += 1;
          },
          prompt: async ({ body }: { body: { parts: Array<{ text?: string }> } }) => {
            prompts.push(body.parts[0]?.text ?? "");
          },
        },
        tui: { showToast: async () => {} },
      },
      directory: "/test",
    } as any;
    const guard: ToolLoopGuardHooks = createToolLoopGuardHook(ctx, { abortSettleDelayMs: 0, threshold: 2 });

    await guard["tool.execute.after"](
      { tool: "pty_write", sessionID: "local-1", args: { id: "pty_1", data: "ls\n" } },
      { output: "Error: Missing required parameter 'session_id'" },
    );
    await guard["tool.execute.after"](
      { tool: "pty_write", sessionID: "local-1", args: { id: "pty_1", data: "ls\n" } },
      { output: "Error: Missing required parameter 'session_id'" },
    );

    expect(aborts).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("tool loop was interrupted");
  });
});
