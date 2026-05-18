import { describe, expect, it } from "bun:test";

import type { ContextBudgetConfig } from "../../src/hooks/context-budget";
import { createContextBudgetHook } from "../../src/hooks/context-budget";
import { createOutputGovernorHook } from "../../src/hooks/output-governor";

const BASE_SMALL_CONTEXT = {
  mode: "on",
  autoThreshold: 128_000,
  continuityAnchor: { enabled: true, budgetTokens: 900 },
  outputGovernor: { enabled: true, reserveTokens: 60 },
  promptBudgeting: { enabled: true, maxPromptRatio: 0.5, reserveTokens: 120 },
} as const;

function createMockCtx() {
  return {
    client: { session: { messages: async () => ({ data: [] }) }, tui: { showToast: async () => {} } },
  } as any;
}

function createBudget(config: Partial<ContextBudgetConfig> = {}) {
  return createContextBudgetHook(createMockCtx(), {
    defaultContextLimit: 220,
    charPerToken: 1,
    smallContext: BASE_SMALL_CONTEXT,
    ...config,
  });
}

function createLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index.toString().padStart(2, "0")} :: payload`).join(
    "\n",
  );
}

async function trackSession(
  budget: ReturnType<typeof createBudget>,
  sessionID: string,
  info: { input: number; modelID?: string; providerID?: string },
): Promise<void> {
  await budget.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          sessionID,
          role: "assistant",
          tokens: { input: info.input },
          modelID: info.modelID,
          providerID: info.providerID,
        },
      },
    } as any,
  });
}

describe("output-governor", () => {
  it("should leave output unchanged for unknown models in auto mode", async () => {
    const budget = createBudget({
      defaultContextLimit: 64_000,
      smallContext: {
        ...BASE_SMALL_CONTEXT,
        mode: "auto",
        autoThreshold: 256_000,
      },
    });
    const hook = createOutputGovernorHook(budget);
    const original = createLines("Read line", 20);
    const output = { output: original };

    await trackSession(budget, "session-1", {
      input: 10_000,
      modelID: "unknown-model",
      providerID: "custom",
    });
    await hook["tool.execute.after"]({ tool: "Read", sessionID: "session-1" }, output);

    expect(output.output).toBe(original);
  });

  it("should truncate Read output when small-context mode is active", async () => {
    const budget = createBudget();
    const hook = createOutputGovernorHook(budget);
    const output = { output: createLines("Read line", 20) };

    await trackSession(budget, "session-1", { input: 40 });
    await hook["tool.execute.after"]({ tool: "Read", sessionID: "session-1" }, output);

    expect(output.output).toContain("Read line 00");
    expect(output.output).not.toBe(createLines("Read line", 20));
    expect(output.output).not.toContain("Read line 19");
  });

  it("should truncate batch_read output while preserving the batch header", async () => {
    const budget = createBudget();
    const hook = createOutputGovernorHook(budget);
    const output = {
      output: [
        "# Batch Read (2 files)",
        "",
        "## src/a.ts",
        "",
        "```",
        createLines("file-a", 10),
        "```",
        "",
        "## src/b.ts",
        "",
        "```",
        createLines("file-b", 10),
        "```",
      ].join("\n"),
    };

    await trackSession(budget, "session-1", { input: 40 });
    await hook["tool.execute.after"]({ tool: "batch_read", sessionID: "session-1" }, output);

    expect(output.output).toContain("# Batch Read (2 files)");
    expect(output.output).toContain("Output truncated");
    expect(output.output).not.toContain("file-b 09");
  });

  it("should govern look_at and external fetch outputs", async () => {
    const budget = createBudget();
    const hook = createOutputGovernorHook(budget);
    const tools = [
      "look_at",
      "spawn_agent",
      "webfetch",
      "context7_query-docs",
      "context7_resolve-library-id",
      "btca_ask",
    ];

    await trackSession(budget, "session-1", { input: 40 });

    for (const tool of tools) {
      const output = { output: createLines(`${tool} line`, 20) };
      await hook["tool.execute.after"]({ tool, sessionID: "session-1" }, output);
      expect(output.output).not.toBe(createLines(`${tool} line`, 20));
      expect(output.output).not.toContain(`${tool} line 19`);
    }
  });

  it("should preserve the latest bash-like log lines", async () => {
    const budget = createBudget();
    const hook = createOutputGovernorHook(budget);
    const output = { output: createLines("bash log", 30) };

    await trackSession(budget, "session-1", { input: 40 });
    await hook["tool.execute.after"]({ tool: "bash", sessionID: "session-1" }, output);

    expect(output.output).toContain("bash log 29");
    expect(output.output).not.toContain("bash log 05");
    expect(output.output).not.toBe(createLines("bash log", 30));
  });

  it("should preserve PTY framing and tail output", async () => {
    const budget = createBudget();
    const hook = createOutputGovernorHook(budget);
    const numbered = Array.from({ length: 30 }, (_, index) => {
      return `${(index + 1).toString().padStart(5, "0")}| pty line ${index.toString().padStart(2, "0")} :: payload`;
    }).join("\n");
    const output = {
      output: [
        `<pty_output id="pty_1" status="running">`,
        numbered,
        "",
        "(End of buffer - total 30 lines)",
        "</pty_output>",
      ].join("\n"),
    };

    await trackSession(budget, "session-1", { input: 40 });
    await hook["tool.execute.after"]({ tool: "pty_read", sessionID: "session-1" }, output);

    expect(output.output).toContain(`<pty_output id="pty_1" status="running">`);
    expect(output.output).toContain("00030| pty line 29");
    expect(output.output).toContain("</pty_output>");
    expect(output.output).not.toContain("00005| pty line 04");
  });

  it("should suppress output when no headroom remains", async () => {
    const budget = createBudget();
    const hook = createOutputGovernorHook(budget);
    const output = { output: createLines("Read line", 5) };

    await trackSession(budget, "session-1", { input: 180 });
    await hook["tool.execute.after"]({ tool: "Read", sessionID: "session-1" }, output);

    expect(output.output).toContain("output suppressed");
  });
});
