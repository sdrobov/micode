// src/tools/check-context-budget.ts
// A tool the model calls BEFORE reading files to check if it fits budget
import type { ToolDefinition } from "@opencode-ai/plugin";
import { type ToolContext, tool } from "@opencode-ai/plugin/tool";

import type { CanReadResult, ContextBudgetHooks } from "@/hooks/context-budget";

const DEFAULT_BUDGET_LIMIT = 32_768;
const PERCENTAGE_MAX = 100;

export interface CheckBudgetArgs {
  files?: string[];
  checkGrep?: { pattern: string; include?: string };
  reserveForThinking?: number;
  reserveForOutput?: number;
}

function getSessionId(toolCtx: ToolContext): string {
  return (
    ((toolCtx as Record<string, unknown>).sessionID as string | undefined) ??
    ((toolCtx as Record<string, unknown>).session_id as string | undefined) ??
    "unknown"
  );
}

async function executeCheckContextBudget(
  budget: ContextBudgetHooks,
  args: CheckBudgetArgs,
  toolCtx: ToolContext,
): Promise<string> {
  const sessionID = getSessionId(toolCtx);
  const { files, reserveForThinking, reserveForOutput } = args;
  const currentBudget = budget.getBudget(sessionID);
  const { used = 0, limit = DEFAULT_BUDGET_LIMIT } = currentBudget ?? {};
  const remaining = currentBudget?.remaining ?? limit;
  let estimatedCost = 0,
    estimates: Array<{ path: string; estimated: number; method: string }> = [];
  if (files && files.length > 0) {
    const cost = await budget.estimateReadCost(files);
    estimatedCost = cost.total;
    estimates = cost.files.map((f) => ({ path: f.path, estimated: f.estimated, method: f.method }));
  }
  const decision = budget.canRead(sessionID, estimatedCost, {
    reserveForThinking,
    reserveForOutput,
  });
  return formatBudgetResponse(used, limit, remaining, estimatedCost, estimates, decision);
}

export function createCheckContextBudgetTool(budget: ContextBudgetHooks): { check_context_budget: ToolDefinition } {
  const check_context_budget = tool({
    description: `Check if reading files fits within the remaining context budget.
Call this BEFORE reading files, especially when working with local LLMs with limited context windows.
Returns budget status and recommendations.`,
    args: {
      files: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("File paths to check. Estimates the token cost of reading each."),
      checkGrep: tool.schema
        .object({
          pattern: tool.schema.string().describe("Grep pattern to estimate"),
          include: tool.schema.string().optional().describe("File include pattern"),
        })
        .optional()
        .describe("Grep query to estimate (not currently implemented — reserved for future)"),
      reserveForThinking: tool.schema.number().optional().describe("Override thinking reservation (default: 4096)"),
      reserveForOutput: tool.schema.number().optional().describe("Override output reservation (default: 4096)"),
    } as Record<string, unknown>,
    execute: async (args: CheckBudgetArgs, toolCtx: ToolContext) => executeCheckContextBudget(budget, args, toolCtx),
  });

  return { check_context_budget };
}

function formatBudgetResponse(
  used: number,
  limit: number,
  remaining: number,
  estimatedCost: number,
  estimates: Array<{ path: string; estimated: number; method: string }>,
  decision: CanReadResult,
): string {
  const response = {
    current: {
      used,
      limit,
      remaining,
      usagePercent: limit > 0 ? Math.round((used / limit) * PERCENTAGE_MAX) : 0,
    },
    estimated: {
      cost: estimatedCost,
      files: estimates,
    },
    result: {
      decision: decision.decision,
      remainingAfter: remaining - estimatedCost,
      availableBudget: decision.availableBudget,
    },
    recommendation: getRecommendation(decision.decision, estimatedCost, remaining),
  };
  return JSON.stringify(response, null, 2);
}

function getRecommendation(decision: string, cost: number, remaining: number): string {
  switch (decision) {
    case "ok":
      return "OK to read. The content fits within budget.";
    case "tight":
      return `Estimated cost ${cost} tokens. Budget is tight (${remaining} remaining). Prefer look_at() or delegate to a subagent.`;
    case "delegation_needed":
      return `Estimated cost ${cost} tokens exceeds available budget (${remaining} remaining). Use spawn_agent or Task to delegate this read to a subagent.`;
    default:
      return "Check budget and proceed with caution.";
  }
}
