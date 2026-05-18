import { describe, expect, it } from "bun:test";

import { createToolLoopGuardHook } from "../../src/hooks/tool-loop-guard";

interface MockCalls {
  aborts: number;
  prompts: string[];
  toasts: string[];
}

function createMockCtx(options?: { failAbort?: boolean; failPrompt?: boolean }) {
  const calls: MockCalls = {
    aborts: 0,
    prompts: [],
    toasts: [],
  };

  const ctx = {
    directory: "/test",
    client: {
      session: {
        abort: async () => {
          calls.aborts += 1;
          if (options?.failAbort) {
            throw new Error("abort failed");
          }
        },
        prompt: async ({ body }: { body: { parts: Array<{ text?: string }> } }) => {
          const prompt = body.parts[0]?.text ?? "";
          calls.prompts.push(prompt);
          if (options?.failPrompt) {
            throw new Error("prompt failed");
          }
        },
      },
      tui: {
        showToast: async ({ body }: { body: { message: string } }) => {
          calls.toasts.push(body.message);
        },
      },
    },
  } as any;

  return { calls, ctx };
}

describe("tool-loop-guard", () => {
  it("should return a hook with tool.execute.after and cleanupSession", () => {
    const { ctx } = createMockCtx();
    const hook = createToolLoopGuardHook(ctx);

    expect(hook["tool.execute.after"]).toBeDefined();
    expect(hook.cleanupSession).toBeDefined();
  });

  it("should interrupt repeated identical failures", async () => {
    const { calls, ctx } = createMockCtx();
    const hook = createToolLoopGuardHook(ctx, { abortSettleDelayMs: 0, threshold: 2 });

    await hook["tool.execute.after"](
      { tool: "pty_write", sessionID: "s1", args: { id: "pty_1", data: "ls\n" } },
      { output: "Error: Missing required parameter 'session_id'" },
    );
    expect(calls.aborts).toBe(0);

    const repeated = { output: "Error: Missing required parameter 'session_id'" };
    await hook["tool.execute.after"](
      { tool: "pty_write", sessionID: "s1", args: { id: "pty_1", data: "ls\n" } },
      repeated,
    );

    expect(calls.aborts).toBe(1);
    expect(calls.prompts).toHaveLength(1);
    expect(calls.prompts[0]).toContain("Do not call pty_write again with the same arguments");
    expect(repeated.output).toContain("<tool-loop-guard");
  });

  it("should reset the streak after a successful tool call", async () => {
    const { calls, ctx } = createMockCtx();
    const hook = createToolLoopGuardHook(ctx, { abortSettleDelayMs: 0, threshold: 2 });

    await hook["tool.execute.after"](
      { tool: "pty_write", sessionID: "s1", args: { id: "pty_1", data: "ls\n" } },
      { output: "Error: Missing required parameter 'session_id'" },
    );

    await hook["tool.execute.after"](
      { tool: "pty_write", sessionID: "s1", args: { id: "pty_1", data: "ls\n" } },
      { output: 'Sent 3 bytes to pty_1: "ls\\n"' },
    );

    await hook["tool.execute.after"](
      { tool: "pty_write", sessionID: "s1", args: { id: "pty_1", data: "ls\n" } },
      { output: "Error: Missing required parameter 'session_id'" },
    );

    expect(calls.aborts).toBe(0);
    expect(calls.prompts).toHaveLength(0);
  });

  it("should clear session state on cleanup", async () => {
    const { calls, ctx } = createMockCtx();
    const hook = createToolLoopGuardHook(ctx, { abortSettleDelayMs: 0, threshold: 2 });

    await hook["tool.execute.after"](
      { tool: "pty_write", sessionID: "s1", args: { id: "pty_1", data: "ls\n" } },
      { output: "Error: Missing required parameter 'session_id'" },
    );

    hook.cleanupSession("s1");

    await hook["tool.execute.after"](
      { tool: "pty_write", sessionID: "s1", args: { id: "pty_1", data: "ls\n" } },
      { output: "Error: Missing required parameter 'session_id'" },
    );

    expect(calls.aborts).toBe(0);
  });

  it("should fall back to a blocker after max interventions", async () => {
    const { calls, ctx } = createMockCtx();
    const hook = createToolLoopGuardHook(ctx, {
      abortSettleDelayMs: 0,
      maxInterventions: 1,
      threshold: 2,
    });

    await hook["tool.execute.after"](
      { tool: "octto_session", sessionID: "s1", args: { session_id: "missing" } },
      { output: "<error>Session not found: missing</error>" },
    );
    await hook["tool.execute.after"](
      { tool: "octto_session", sessionID: "s1", args: { session_id: "missing" } },
      { output: "<error>Session not found: missing</error>" },
    );

    await hook["tool.execute.after"](
      { tool: "octto_session", sessionID: "s1", args: { session_id: "missing" } },
      { output: "<error>Session not found: missing</error>" },
    );
    const fallback = { output: "<error>Session not found: missing</error>" };
    await hook["tool.execute.after"](
      { tool: "octto_session", sessionID: "s1", args: { session_id: "missing" } },
      fallback,
    );

    expect(calls.aborts).toBe(1);
    expect(fallback.output).toContain("<tool-loop-guard");
  });

  it("should avoid false positives for code content inside batch reads", async () => {
    const { calls, ctx } = createMockCtx();
    const hook = createToolLoopGuardHook(ctx, { abortSettleDelayMs: 0, threshold: 2 });
    const output = {
      output: '# Batch Read (1 files)\n\n## src/test.ts\n\n```\nfailed();\nthrow new Error("boom");\n```\n',
    };

    await hook["tool.execute.after"]({ tool: "batch_read", sessionID: "s1", args: { paths: ["src/test.ts"] } }, output);
    await hook["tool.execute.after"](
      { tool: "batch_read", sessionID: "s1", args: { paths: ["src/test.ts"] } },
      { ...output },
    );

    expect(calls.aborts).toBe(0);
    expect(calls.prompts).toHaveLength(0);
  });

  it("should keep the blocker output when abort fails", async () => {
    const { calls, ctx } = createMockCtx({ failAbort: true });
    const hook = createToolLoopGuardHook(ctx, { abortSettleDelayMs: 0, threshold: 2 });

    await hook["tool.execute.after"](
      { tool: "pty_write", sessionID: "s1", args: { id: "pty_1", data: "ls\n" } },
      { output: "Error: Missing required parameter 'session_id'" },
    );

    const repeated = { output: "Error: Missing required parameter 'session_id'" };
    await hook["tool.execute.after"](
      { tool: "pty_write", sessionID: "s1", args: { id: "pty_1", data: "ls\n" } },
      repeated,
    );

    expect(calls.aborts).toBe(1);
    expect(calls.prompts).toHaveLength(0);
    expect(repeated.output).toContain("<tool-loop-guard");
  });
});
