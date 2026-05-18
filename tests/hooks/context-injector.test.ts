// tests/hooks/context-injector.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock PluginInput
function createMockCtx(directory: string) {
  return {
    directory,
    client: {
      session: {},
      tui: {},
    },
  };
}

describe("context-injector", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "context-injector-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("tool.execute.after hook", () => {
    it("should extract filePath from tool args using camelCase", async () => {
      // Create a README.md in a subdirectory
      const subDir = join(testDir, "src", "components");
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, "README.md"), "# Components\n\nComponent documentation.");

      // Create a file to "read"
      const targetFile = join(subDir, "Button.tsx");
      writeFileSync(targetFile, "export const Button = () => <button />;");

      // Import the hook dynamically to get fresh module
      const { createContextInjectorHook } = await import("../../src/hooks/context-injector");
      const ctx = createMockCtx(testDir);
      const hooks = createContextInjectorHook(ctx as any);

      // Simulate tool execution with camelCase filePath (as OpenCode sends it)
      const input = {
        tool: "read",
        args: { filePath: targetFile }, // camelCase - this is what OpenCode sends
      };
      const output = { output: "file contents here" };

      await hooks["tool.execute.after"](input, output);

      // Should have injected directory context
      expect(output.output).toContain("directory-context");
      expect(output.output).toContain("Components");
    });

    it("should not inject context for non-file-access tools", async () => {
      const { createContextInjectorHook } = await import("../../src/hooks/context-injector");
      const ctx = createMockCtx(testDir);
      const hooks = createContextInjectorHook(ctx as any);

      const input = {
        tool: "bash",
        args: { command: "ls" },
      };
      const output = { output: "file1.txt\nfile2.txt" };

      await hooks["tool.execute.after"](input, output);

      // Should NOT have injected context
      expect(output.output).not.toContain("directory-context");
    });

    it("should invalidate cached context files after edits", async () => {
      const readmePath = join(testDir, "README.md");
      writeFileSync(readmePath, "# Project\n\nVersion one");

      const { createContextInjectorHook } = await import("../../src/hooks/context-injector");
      const ctx = createMockCtx(testDir);
      const hooks = createContextInjectorHook(ctx as any);

      const first = { system: "Base prompt" };
      await hooks["chat.params"]({ sessionID: "session-a" }, first);
      expect(first.system).toContain("Version one");

      writeFileSync(readmePath, "# Project\n\nVersion two");
      await hooks["tool.execute.after"]({ tool: "Edit", args: { filePath: readmePath } }, { output: "updated" });

      const second = { system: "Base prompt" };
      await hooks["chat.params"]({ sessionID: "session-a" }, second);
      expect(second.system).toContain("Version two");
      expect(second.system).not.toContain("Version one");
    });
  });

  describe("chat.params hook", () => {
    it("should budget project context in small-context mode", async () => {
      writeFileSync(join(testDir, "README.md"), "A".repeat(800));
      writeFileSync(join(testDir, "ARCHITECTURE.md"), "B".repeat(800));
      writeFileSync(join(testDir, "CODE_STYLE.md"), "C".repeat(800));

      const { createContextInjectorHook } = await import("../../src/hooks/context-injector");
      const { createPromptBudgetController } = await import("../../src/hooks/prompt-budgeting");
      const { parseSmallContextConfig } = await import("../../src/config-schemas");
      const smallContext = parseSmallContextConfig({
        mode: "on",
        autoThreshold: 400,
        promptBudgeting: {
          maxPromptRatio: 0.4,
          reserveTokens: 40,
        },
      });

      const ctx = createMockCtx(testDir);
      const hooks = createContextInjectorHook(ctx as any, {
        promptBudget: createPromptBudgetController({ smallContext }),
      });

      const output = {
        system: `Base prompt ${"Z".repeat(200)}`,
        options: {},
      };

      await hooks["chat.params"]({ sessionID: "session-budget" }, output);

      expect(output.system).toContain("project-context");
      expect(output.system).toContain("Context trimmed for small-context prompt budget");
      expect(output.system).toContain("context-summary");
    });
  });
});
