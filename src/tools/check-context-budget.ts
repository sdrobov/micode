// src/tools/check-context-budget.ts
// A tool the model calls BEFORE reading files to check if it fits budget
import type { ToolDefinition } from "@opencode-ai/plugin";
import { type ToolContext, tool } from "@opencode-ai/plugin/tool";

import {
  CONTEXT_BUDGET_INVESTIGATION_TYPES,
  type ContextBudgetHooks,
  type FanoutAssessment,
} from "@/hooks/context-budget";

const DEFAULT_BUDGET_LIMIT = 32_768;
const PERCENTAGE_MAX = 100;

export interface CheckBudgetArgs {
  files?: string[];
  checkGrep?: { pattern: string; include?: string };
  reserveForThinking?: number;
  reserveForOutput?: number;
  expectedToolCalls?: number;
  plannedTools?: string[];
  continuingAfterCompaction?: boolean;
  investigationType?: (typeof CONTEXT_BUDGET_INVESTIGATION_TYPES)[number];
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
  const {
    files,
    reserveForThinking,
    reserveForOutput,
    expectedToolCalls,
    plannedTools,
    continuingAfterCompaction,
    investigationType,
  } = args;
  const currentBudget = budget.getBudget(sessionID);
  const { used = 0, limit = DEFAULT_BUDGET_LIMIT } = currentBudget ?? {};
  const remaining = currentBudget?.remaining ?? limit;
  const fanout = await budget.assessFanout(sessionID, {
    files,
    reserveForThinking,
    reserveForOutput,
    expectedToolCalls,
    plannedTools,
    continuingAfterCompaction,
    investigationType,
  });
  const estimates = fanout.fileEstimates.map((file) => ({
    path: file.path,
    estimated: file.estimated,
    method: file.method,
  }));
  return formatBudgetResponse(used, limit, remaining, fanout, estimates);
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
      expectedToolCalls: tool.schema.number().optional().describe("Planned tool calls for this investigation"),
      plannedTools: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("Planned tool names when the investigation will mix multiple tools"),
      continuingAfterCompaction: tool.schema
        .boolean()
        .optional()
        .describe("Set when this is the first broad investigation after compaction or resume"),
      investigationType: tool.schema
        .enum(CONTEXT_BUDGET_INVESTIGATION_TYPES)
        .optional()
        .describe("Investigation shape: targeted read, broad exploration, architecture trace, or pattern search"),
    },
    execute: async (args: CheckBudgetArgs, toolCtx: ToolContext) => executeCheckContextBudget(budget, args, toolCtx),
  });

  return { check_context_budget };
}

function formatBudgetResponse(
  used: number,
  limit: number,
  remaining: number,
  fanout: FanoutAssessment,
  estimates: Array<{ path: string; estimated: number; method: string }>,
): string {
  const response = {
    current: {
      used,
      limit,
      remaining,
      usagePercent: limit > 0 ? Math.round((used / limit) * PERCENTAGE_MAX) : 0,
    },
    estimated: {
      cost: fanout.estimatedCost,
      files: estimates,
    },
    result: {
      decision: fanout.readDecision,
      fanoutDecision: fanout.decision,
      remainingAfter: remaining - fanout.estimatedCost,
      availableBudget: fanout.availableBudget,
    },
    fanout: {
      active: fanout.active,
      decision: fanout.decision,
      reasons: fanout.reasons,
      expectedToolCalls: fanout.expectedToolCalls,
      mixedToolCount: fanout.mixedToolCount,
    },
    recommendation: getRecommendation(fanout, remaining),
  };
  return JSON.stringify(response, null, 2);
}

function getRecommendation(fanout: FanoutAssessment, remaining: number): string {
  if (fanout.decision === "fanout_required") {
    return `Use Task or spawn_agent to fan out this investigation and request compact summary findings with file:line refs. ${fanout.reasons.join("; ")}.`;
  }

  if (fanout.decision === "fanout_recommended") {
    return `Prefer summary fanout before opening everything directly. ${fanout.reasons.join("; ")}.`;
  }

  switch (fanout.readDecision) {
    case "ok":
      return "OK to read. The content fits within budget.";
    case "tight":
      return `Estimated cost ${fanout.estimatedCost} tokens. Budget is tight (${remaining} remaining). Prefer look_at() or delegate to a subagent.`;
    case "delegation_needed":
      return `Estimated cost ${fanout.estimatedCost} tokens exceeds available budget (${remaining} remaining). Use spawn_agent or Task to delegate this read to a subagent.`;
    default:
      return "Check budget and proceed with caution.";
  }
}
