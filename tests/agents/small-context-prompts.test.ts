import { describe, expect, it } from "bun:test";
import { codebaseAnalyzerAgent } from "../../src/agents/codebase-analyzer";
import { primaryAgent } from "../../src/agents/commander";
import { executorAgent } from "../../src/agents/executor";
import { implementerAgent } from "../../src/agents/implementer";
import { patternFinderAgent } from "../../src/agents/pattern-finder";
import { plannerAgent } from "../../src/agents/planner";

const promptAgents = [
  primaryAgent,
  plannerAgent,
  executorAgent,
  implementerAgent,
  codebaseAnalyzerAgent,
  patternFinderAgent,
];

describe("small-context prompt guidance", () => {
  it("should tell agents to start narrow and budget risky reads", () => {
    for (const agent of promptAgents) {
      expect(agent.prompt).toContain("small-context safeguards");
      expect(agent.prompt).toContain("Start narrow");
      expect(agent.prompt).toContain("look_at()");
      expect(agent.prompt).toContain("check_context_budget()");
      expect(agent.prompt).toContain("expectedToolCalls");
      expect(agent.prompt).toContain("investigationType");
    }
  });

  it("should preserve continuity after compaction", () => {
    for (const agent of promptAgents) {
      expect(agent.prompt).toContain("After compaction");
      expect(agent.prompt).toMatch(/continuity\s+anchor/);
    }
  });

  it("should keep terminal output filtered where terminal tools exist", () => {
    expect(primaryAgent.prompt).toContain("filtered, paginated, tailed, or pattern-matched");
    expect(plannerAgent.prompt).toContain("filtered, paginated, tailed, or pattern-matched");
    expect(executorAgent.prompt).toContain("filtered, paginated, tailed, or pattern-matched");
    expect(implementerAgent.prompt).toContain("filtered, paginated, tailed, or pattern-matched");
  });

  it("should prefer fanout summaries for broad investigations", () => {
    expect(primaryAgent.prompt).toContain("fanout_recommended");
    expect(plannerAgent.prompt).toContain("fanout_required");
    expect(executorAgent.prompt).toContain("compact summary findings");
    expect(codebaseAnalyzerAgent.prompt).toContain("summary-shaped");
    expect(patternFinderAgent.prompt).toContain("summary-shaped");
  });

  it("should remove broad read instructions that conflict with small-context mode", () => {
    expect(codebaseAnalyzerAgent.prompt).not.toContain("Read all relevant files completely");
    expect(codebaseAnalyzerAgent.prompt).not.toContain("Read files COMPLETELY - never use limit/offset");
    expect(implementerAgent.prompt).not.toContain("Read files COMPLETELY before editing");
  });
});
