import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import { type ToolContext, tool } from "@opencode-ai/plugin/tool";
import type { ContextBudgetHooks, OutputGovernorState } from "@/hooks/context-budget";
import { governToolOutput } from "@/hooks/output-governor";
import { extractErrorMessage } from "@/utils/errors";

// Extended context with metadata (available but not typed in plugin API)
// Using intersection to add optional metadata without type conflict
type ExtendedContext = ToolContext & {
  metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void;
};

const MS_PER_SECOND = 1000;
const MAX_PLAIN_SUMMARY_LINES = 2;
const CODE_FENCE = /^```/;
const SUMMARY_LINE_PATTERNS = [/^#{1,6}\s/, /^[-*]\s/, /^\d+\.\s/, /^\*\*.+\*\*/, /^\|/, /^`[^`]+`/] as const;
const SUMMARY_OMISSION_NOTE = "[Detailed code excerpts omitted to keep the subagent summary compact.]";

interface SessionCreateResponse {
  readonly data?: { readonly id?: string };
}

interface MessagePart {
  readonly type: string;
  readonly text?: string;
}

interface SessionMessage {
  readonly info?: { readonly role?: "user" | "assistant" };
  readonly parts?: MessagePart[];
}

interface SessionMessagesResponse {
  readonly data?: SessionMessage[];
}

interface AgentTask {
  readonly agent: string;
  readonly prompt: string;
  readonly description: string;
}

function getSessionId(toolCtx: ToolContext): string {
  const record = toolCtx as Record<string, unknown>;
  return (record.sessionID as string | undefined) ?? (record.session_id as string | undefined) ?? "unknown";
}

function isSummaryLine(line: string): boolean {
  return SUMMARY_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

function isCodeFence(line: string): boolean {
  return CODE_FENCE.test(line.trim());
}

function collapseBlankLines(lines: readonly string[]): string[] {
  const compact = lines.filter((line, index) => {
    if (line !== "") return true;
    const previous = lines[index - 1];
    return previous !== "";
  });
  while (compact[0] === "") compact.shift();
  while (compact.at(-1) === "") compact.pop();
  return compact;
}

function appendBlankSummaryLine(summary: string[]): void {
  summary.push("");
}

function appendContentSummaryLine(summary: string[], line: string, plainLines: number): number {
  if (isSummaryLine(line)) {
    summary.push(line);
    return 0;
  }
  if (plainLines < MAX_PLAIN_SUMMARY_LINES) {
    summary.push(line);
    return plainLines + 1;
  }
  return plainLines;
}

function buildCompactSummary(output: string): string {
  const summary: string[] = [];
  let inCodeBlock = false;
  let omittedCode = false;
  let plainLines = 0;
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (isCodeFence(line)) {
      inCodeBlock = !inCodeBlock;
      omittedCode = true;
      plainLines = 0;
      continue;
    }
    if (inCodeBlock) {
      omittedCode = true;
      continue;
    }
    if (line.trim().length === 0) {
      appendBlankSummaryLine(summary);
      plainLines = 0;
      continue;
    }
    plainLines = appendContentSummaryLine(summary, line, plainLines);
  }
  const compact = collapseBlankLines(summary);
  if (omittedCode) compact.push("", SUMMARY_OMISSION_NOTE);
  return compact.join("\n").trim() || output;
}

export function normalizeSpawnAgentOutput(output: string, state: OutputGovernorState | undefined): string {
  if (!state?.active) {
    return output;
  }
  return governToolOutput("spawn_agent", buildCompactSummary(output), state);
}

function updateProgress(
  toolCtx: ExtendedContext,
  progressState: { completed: number; total: number; startTime: number } | undefined,
  status: string,
): void {
  if (toolCtx.metadata && progressState) {
    const elapsed = ((Date.now() - progressState.startTime) / MS_PER_SECOND).toFixed(0);
    toolCtx.metadata({
      title: `[${progressState.completed}/${progressState.total}] ${status} (${elapsed}s)`,
    });
  }
}

async function executeAgentSession(ctx: PluginInput, task: AgentTask): Promise<string> {
  const sessionResp = (await ctx.client.session.create({
    body: {},
    query: { directory: ctx.directory },
  })) as SessionCreateResponse;

  const sessionID = sessionResp.data?.id;
  if (!sessionID) {
    return `## ${task.description}\n\n**Agent**: ${task.agent}\n**Error**: Failed to create session`;
  }

  await ctx.client.session.prompt({
    path: { id: sessionID },
    body: {
      parts: [{ type: "text", text: task.prompt }],
      agent: task.agent,
    },
    query: { directory: ctx.directory },
  });

  const messagesResp = (await ctx.client.session.messages({
    path: { id: sessionID },
    query: { directory: ctx.directory },
  })) as SessionMessagesResponse;

  const messages = messagesResp.data || [];
  const lastAssistant = messages.filter((m) => m.info?.role === "assistant").pop();
  const agentResponse =
    lastAssistant?.parts
      ?.filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n") || "(No response from agent)";

  await ctx.client.session
    .delete({ path: { id: sessionID }, query: { directory: ctx.directory } })
    .catch((_e: unknown) => {
      /* fire-and-forget */
    });

  return agentResponse;
}

async function runAgent(
  ctx: PluginInput,
  task: AgentTask,
  toolCtx: ExtendedContext,
  governorState: OutputGovernorState | undefined,
  progressState?: { completed: number; total: number; startTime: number },
): Promise<string> {
  const agentStartTime = Date.now();
  updateProgress(toolCtx, progressState, `Running ${task.agent}...`);

  try {
    const agentOutput = normalizeSpawnAgentOutput(await executeAgentSession(ctx, task), governorState);
    const agentTime = ((Date.now() - agentStartTime) / MS_PER_SECOND).toFixed(1);
    return `## ${task.description} (${agentTime}s)\n\n**Agent**: ${task.agent}\n\n### Result\n\n${agentOutput}`;
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    return `## ${task.description}\n\n**Agent**: ${task.agent}\n**Error**: ${errorMsg}`;
  }
}

async function runParallelAgents(
  ctx: PluginInput,
  agents: AgentTask[],
  extCtx: ExtendedContext,
  governorState: OutputGovernorState | undefined,
): Promise<string> {
  const startTime = Date.now();
  const progressState = { completed: 0, total: agents.length, startTime };

  extCtx.metadata?.({ title: `Running ${agents.length} agents in parallel...` });

  const runWithProgress = async (task: AgentTask): Promise<string> => {
    const agentOutput = await runAgent(ctx, task, extCtx, governorState, progressState);
    progressState.completed++;
    const elapsed = ((Date.now() - startTime) / MS_PER_SECOND).toFixed(0);
    extCtx.metadata?.({
      title: `[${progressState.completed}/${agents.length}] ${task.agent} done (${elapsed}s)`,
    });
    return agentOutput;
  };

  const results = await Promise.all(agents.map(runWithProgress));
  const totalTime = ((Date.now() - startTime) / MS_PER_SECOND).toFixed(1);

  extCtx.metadata?.({ title: `${agents.length} agents completed in ${totalTime}s` });

  return `# ${agents.length} agents completed in ${totalTime}s (parallel)\n\n${results.join("\n\n---\n\n")}`;
}

export function createSpawnAgentTool(ctx: PluginInput, budget?: ContextBudgetHooks): ToolDefinition {
  return tool({
    description: `Spawn subagents to execute tasks in PARALLEL.
All agents in the array run concurrently via Promise.all.

Example:
spawn_agent({
  agents: [
    {agent: "mm-stack-detector", prompt: "...", description: "Detect stack"},
    {agent: "mm-dependency-mapper", prompt: "...", description: "Map deps"}
  ]
})`,
    args: {
      agents: tool.schema
        .array(
          tool.schema.object({
            agent: tool.schema.string().describe("Agent to spawn"),
            prompt: tool.schema.string().describe("Full prompt/instructions"),
            description: tool.schema.string().describe("Short description"),
          }),
        )
        .describe("Agents to spawn in parallel"),
    },
    execute: async (args, toolCtx) => {
      const { agents } = args;
      const extCtx = toolCtx as ExtendedContext;
      const governorState = budget?.getOutputGovernorState(getSessionId(toolCtx));

      if (!agents || agents.length === 0) return "## spawn_agent Failed\n\nNo agents specified.";

      if (agents.length === 1) {
        extCtx.metadata?.({ title: `Running ${agents[0].agent}...` });
        return runAgent(ctx, agents[0], extCtx, governorState);
      }

      return runParallelAgents(ctx, agents, extCtx, governorState);
    },
  });
}
