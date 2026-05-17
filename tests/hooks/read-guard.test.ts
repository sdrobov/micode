import { describe, expect, it } from "bun:test";

import type { ContextBudgetHooks } from "../../src/hooks/context-budget";
import { createReadGuardHook } from "../../src/hooks/read-guard";

function createMockBudget(overrides?: Partial<ContextBudgetHooks>): ContextBudgetHooks {
  return {
    "chat.params": async () => {},
    event: async () => {},
    estimateReadCost: async () => ({ total: 0, files: [] }),
    canRead: () => ({ decision: "ok", remaining: 50_000, estimatedCost: 100, availableBudget: 40_000 }),
    getBudget: () => null,
    ...overrides,
  };
}

describe("read-guard", () => {
  describe("createReadGuardHook", () => {
    it("should return hook with tool.execute.after handler", () => {
      const hook = createReadGuardHook(createMockBudget());
      expect(hook["tool.execute.after"]).toBeDefined();
    });
  });

  describe("tool.execute.after", () => {
    it("should pass through when budget is OK", async () => {
      const mockBudget = createMockBudget({
        canRead: () => ({ decision: "ok", remaining: 50_000, estimatedCost: 100, availableBudget: 40_000 }),
      });
      const hook = createReadGuardHook(mockBudget);
      const output = { output: "file content here" };

      await hook["tool.execute.after"]({ tool: "Read", sessionID: "s1", args: { path: "/test/file.ts" } }, output);

      expect(output.output).toBe("file content here");
    });

    it("should append warning when budget is tight", async () => {
      const mockBudget = createMockBudget({
        canRead: () => ({ decision: "tight", remaining: 5_000, estimatedCost: 3_000, availableBudget: 2_000 }),
      });
      const hook = createReadGuardHook(mockBudget);
      const output = { output: "some file content" };

      await hook["tool.execute.after"]({ tool: "Read", sessionID: "s1", args: { path: "/test/file.ts" } }, output);

      expect(output.output).toContain("<guard>");
      expect(output.output).toContain("some file content"); // original preserved
    });

    it("should replace output when delegation is needed", async () => {
      const mockBudget = createMockBudget({
        canRead: () => ({ decision: "delegation_needed", remaining: 2_000, estimatedCost: 20_000, availableBudget: 0 }),
      });
      const hook = createReadGuardHook(mockBudget);
      const manyLines = Array.from({ length: 30 }, (_, i) => `line ${i}: content here`).join("\n");
      const output = { output: manyLines };

      await hook["tool.execute.after"]({ tool: "Read", sessionID: "s1", args: { path: "/test/big-file.ts" } }, output);

      expect(output.output).toContain("<guard>");
      expect(output.output).toContain("Delegate this file read");
      expect(output.output).not.toContain("line 29: content here");
    });

    it("should ignore non-read tools", async () => {
      const mockBudget = createMockBudget({
        canRead: () => ({ decision: "delegation_needed", remaining: 0, estimatedCost: 10_000, availableBudget: 0 }),
      });
      const hook = createReadGuardHook(mockBudget);
      const output = { output: "some content" };

      await hook["tool.execute.after"]({ tool: "Edit", sessionID: "s1" }, output);

      expect(output.output).toBe("some content"); // unchanged
    });

    it("should handle batch_read with mixed results", async () => {
      const mockBudget = createMockBudget({
        canRead: () => ({ decision: "tight", remaining: 10_000, estimatedCost: 8_000, availableBudget: 2_000 }),
      });
      const hook = createReadGuardHook(mockBudget);
      const output = { output: "file-a.ts content\nfile-b.ts content" };

      await hook["tool.execute.after"](
        { tool: "batch_read", sessionID: "s1", args: { paths: ["a.ts", "b.ts"] } },
        output,
      );

      expect(output.output).toContain("<guard>");
    });

    it("should handle missing output gracefully", async () => {
      const hook = createReadGuardHook(createMockBudget());
      const output = {};

      await hook["tool.execute.after"]({ tool: "Read", sessionID: "s1" }, output);

      // Should not throw
      expect(output.output).toBeUndefined();
    });
  });
});
