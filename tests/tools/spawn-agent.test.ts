import { describe, expect, it } from "bun:test";

import type { OutputGovernorState } from "../../src/hooks/context-budget";
import { normalizeSpawnAgentOutput } from "../../src/tools/spawn-agent";

const ACTIVE_STATE: OutputGovernorState = {
  active: true,
  reason: "active",
  mode: "on",
  used: 1_000,
  limit: 8_000,
  remaining: 7_000,
  reserveTokens: 500,
  availableTokens: 6_500,
  charPerToken: 1,
};

describe("spawn-agent output normalization", () => {
  it("should collapse raw code blocks into a compact summary in small-context mode", () => {
    const raw = [
      "## Pattern: Example",
      "",
      "**Best example**: `src/example.ts:10-20`",
      "```ts",
      "const alpha = 1;",
      "const beta = 2;",
      "const gamma = 3;",
      "```",
      "",
      "- Key takeaway",
    ].join("\n");

    const normalized = normalizeSpawnAgentOutput(raw, ACTIVE_STATE);

    expect(normalized).toContain("## Pattern: Example");
    expect(normalized).toContain("Detailed code excerpts omitted");
    expect(normalized).not.toContain("const gamma = 3;");
  });

  it("should preserve raw output when small-context mode is inactive", () => {
    const raw = "plain output\n```ts\nconst alpha = 1;\n```";

    expect(normalizeSpawnAgentOutput(raw, { ...ACTIVE_STATE, active: false })).toBe(raw);
  });
});
