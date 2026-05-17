// src/hooks/read-guard.ts
// Intercepts file read tool outputs and checks against context budget

import type { ContextBudgetHooks } from "@/hooks/context-budget";
import { config } from "@/utils/config";

const READ_TOOLS = new Set(["Read", "batch_read", "look_at", "Grep", "Glob", "ast_grep_search"]);
const TOKENS_PER_K = 1000;

export interface ReadGuardHooks {
  "tool.execute.after": (
    input: { tool: string; sessionID: string; args?: Record<string, unknown> },
    output: { output?: string },
  ) => Promise<void>;
}

export function createReadGuardHook(budget: ContextBudgetHooks): ReadGuardHooks {
  return {
    "tool.execute.after": async (input, output) => {
      const { tool: toolName, sessionID } = input;

      if (!READ_TOOLS.has(toolName)) return;
      if (!output.output) return;

      const outputLength = output.output.length;
      const estimatedTokens = Math.ceil(outputLength / config.localLLM.charPerToken);

      const result = budget.canRead(sessionID, estimatedTokens);
      if (result.decision === "ok") return;

      const remainingK = Math.round(result.remaining / TOKENS_PER_K);
      const costK = Math.round(estimatedTokens / TOKENS_PER_K);

      const guardBlock = `<guard>
Context budget exceeded or tight for this read.
Estimated cost: ${costK}K tokens | Remaining budget: ${remainingK}K tokens
Action: ${result.decision === "delegation_needed" ? "Delegate this file read to a subagent." : "Consider using look_at() instead of full Read()."}
</guard>`;

      if (result.decision === "tight") {
        // Keep output but append warning
        output.output = `${output.output}\n\n${guardBlock}`;
      } else {
        // delegation_needed: replace output with delegation note
        const truncated = truncateOutput(output.output);
        output.output = `${truncated}\n\n${guardBlock}`;
      }
    },
  };
}

function truncateOutput(output: string): string {
  const maxLines = 20;
  const lines = output.split("\n");
  if (lines.length <= maxLines) return output;

  const headerLines = config.tokens.preserveHeaderLines;
  const header = lines.slice(0, headerLines).join("\n");
  const remaining = lines.length - headerLines;
  return `${header}
... truncated ${remaining} lines (budget guard triggered) ...
<see truncated>Use a subagent to analyze this file.</see truncated>`;
}
