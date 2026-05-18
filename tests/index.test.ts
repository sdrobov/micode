// tests/index.test.ts
import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

describe("index.ts constraint-reviewer integration", () => {
  it("should import createConstraintReviewerHook", async () => {
    const source = await readFile("src/index.ts", "utf-8");
    expect(source).toContain("createConstraintReviewerHook");
  });

  it("should create the constraint reviewer hook", async () => {
    const source = await readFile("src/index.ts", "utf-8");
    // The hook should be created with a review function
    expect(source).toContain("constraintReviewerHook");
    expect(source).toContain("createConstraintReviewerHook(ctx");
  });

  it("should call constraint reviewer hook in tool.execute.after", async () => {
    const source = await readFile("src/index.ts", "utf-8");
    // The hook should be integrated into the tool.execute.after handler
    expect(source).toContain('constraintReviewerHook["tool.execute.after"]');
  });

  it("should call constraint reviewer hook in chat.message", async () => {
    const source = await readFile("src/index.ts", "utf-8");
    // The hook should be integrated into the chat.message handler
    expect(source).toContain('constraintReviewerHook["chat.message"]');
  });

  it("should use mm-constraint-reviewer agent for review", async () => {
    const source = await readFile("src/index.ts", "utf-8");
    // The review function should use the mm-constraint-reviewer agent
    expect(source).toContain("mm-constraint-reviewer");
  });
});

describe("index.ts tool-loop-guard integration", () => {
  it("should import createToolLoopGuardHook", async () => {
    const source = await readFile("src/index.ts", "utf-8");
    expect(source).toContain("createToolLoopGuardHook");
  });

  it("should create the tool loop guard inside runtime hook creation", async () => {
    const source = await readFile("src/index.ts", "utf-8");
    expect(source).toContain("toolLoopGuardHook: isLocalLLM");
    expect(source).toContain("createToolLoopGuardHook(ctx");
  });

  it("should call tool loop guard in tool.execute.after", async () => {
    const source = await readFile("src/index.ts", "utf-8");
    expect(source).toContain('toolLoopGuardHook["tool.execute.after"]');
  });

  it("should clean up tool loop guard state on session deletion", async () => {
    const source = await readFile("src/index.ts", "utf-8");
    expect(source).toContain("toolLoopGuardHook?.cleanupSession(sessionId)");
  });
});

describe("index.ts small-context integration", () => {
  it("should create a prompt budget controller from smallContext config", async () => {
    const source = await readFile("src/index.ts", "utf-8");
    expect(source).toContain("createPromptBudgetController");
    expect(source).toContain("const promptBudgetController = smallContext");
  });

  it("should create and call the output governor hook", async () => {
    const source = await readFile("src/index.ts", "utf-8");
    expect(source).toContain("createOutputGovernorHook");
    expect(source).toContain('outputGovernorHook["tool.execute.after"]');
  });

  it("should forward prompt budgeting into prompt-injecting hooks", async () => {
    const source = await readFile("src/index.ts", "utf-8");
    expect(source).toContain("createContextInjectorHook(ctx, {");
    expect(source).toContain("createFragmentInjectorHook(ctx, userConfig, {");
    expect(source).toContain("createMindmodelInjectorHook(ctx, { promptBudget:");
  });

  it("should wire local context resolution into small-context hooks", async () => {
    const source = await readFile("src/index.ts", "utf-8");
    expect(source).toContain("const localContextLimit = isLocalLLM");
    expect(source).toContain("createPromptBudgetController({ smallContext, modelContextLimits, localContextLimit })");
    expect(source).toContain("createContextWindowMonitorHook(ctx, {");
  });
});

describe("index.ts commands", () => {
  it("should use project-initializer agent for /init command", async () => {
    const source = await readFile("src/index.ts", "utf-8");
    // The /init command should use project-initializer
    const initCommandMatch = source.match(/init:\s*\{[^}]*agent:\s*["']([^"']+)["']/);
    expect(initCommandMatch).not.toBeNull();
    expect(initCommandMatch?.[1]).toBe("project-initializer");
  });

  it("should use mm-orchestrator agent for /mindmodel command", async () => {
    const source = await readFile("src/index.ts", "utf-8");
    // The /mindmodel command should use mm-orchestrator
    const mindmodelMatch = source.match(/mindmodel:\s*\{[^}]*agent:\s*["']([^"']+)["']/);
    expect(mindmodelMatch).not.toBeNull();
    expect(mindmodelMatch?.[1]).toBe("mm-orchestrator");
  });
});
