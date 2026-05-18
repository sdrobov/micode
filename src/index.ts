import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { McpLocalConfig } from "@opencode-ai/sdk";
import { agents, PRIMARY_AGENT_NAME } from "@/agents";
import type { MicodeConfig } from "@/config-loader";
import { loadMicodeConfig, loadModelContextLimits, mergeAgentConfigs } from "@/config-loader";
import { isLocalLLMProvider } from "@/config-schemas";
import {
  createArtifactAutoIndexHook,
  createAutoCompactHook,
  createCommentCheckerHook,
  createConstraintReviewerHook,
  createContextBudgetHook,
  createContextInjectorHook,
  createContextPinnerHook,
  createContextWindowMonitorHook,
  createFetchTrackerHook,
  createFileOpsTrackerHook,
  createFragmentInjectorHook,
  createLedgerLoaderHook,
  createMindmodelInjectorHook,
  createOutputGovernorHook,
  createPromptBudgetController,
  createSessionRecoveryHook,
  createTokenAwareTruncationHook,
  createToolLoopGuardHook,
  getFileOps,
  warnUnknownAgents,
} from "@/hooks";
import {
  artifact_search,
  ast_grep_replace,
  ast_grep_search,
  btca_ask,
  checkAstGrepAvailable,
  checkBtcaAvailable,
  createBatchReadTool,
  createCheckContextBudgetTool,
  createMindmodelLookupTool,
  createOcttoTools,
  createPTYManager,
  createPtyTools,
  createSessionStore,
  createSpawnAgentTool,
  loadBunPty,
  look_at,
  milestone_artifact_search,
} from "@/tools";
import { config } from "@/utils/config";
import { extractErrorMessage } from "@/utils/errors";
import { log } from "@/utils/logger";

// Think mode: detect keywords and enable extended thinking
const THINK_KEYWORDS = [
  /\bthink\s*(hard|deeply|carefully|through)\b/i,
  /\bthink\b.*\b(about|on|through)\b/i,
  /\b(deeply|carefully)\s*think\b/i,
  /\blet('s|s)?\s*think\b/i,
];

function detectThinkKeyword(text: string): boolean {
  return THINK_KEYWORDS.some((pattern) => pattern.test(text));
}

// MCP server configurations
const MCP_SERVERS: Record<string, McpLocalConfig> = {
  context7: {
    type: "local",
    command: ["npx", "-y", "@upstash/context7-mcp@latest"],
  },
};

// Environment-gated research MCP servers
if (process.env.PERPLEXITY_API_KEY) {
  MCP_SERVERS.perplexity = {
    type: "local",
    command: ["npx", "-y", "@anthropic/mcp-perplexity"],
  };
}

if (process.env.FIRECRAWL_API_KEY) {
  MCP_SERVERS.firecrawl = {
    type: "local",
    command: ["npx", "-y", "firecrawl-mcp"],
  };
}

const PLUGIN_COMMANDS = {
  init: {
    description: "Initialize project with ARCHITECTURE.md and CODE_STYLE.md",
    agent: "project-initializer",
    template: "Initialize this project. $ARGUMENTS",
  },
  mindmodel: {
    description: "Generate .mindmodel/ constraints for this project",
    agent: "mm-orchestrator",
    template: "Generate mindmodel for this project. $ARGUMENTS",
  },
  ledger: {
    description: "Create or update continuity ledger for session state",
    agent: "ledger-creator",
    template: "Update the continuity ledger. $ARGUMENTS",
  },
  search: {
    description: "Search past handoffs, plans, and ledgers",
    agent: "artifact-searcher",
    template: "Search for: $ARGUMENTS",
  },
};

function extractTextFromParts(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((p) => p.type === "text" && "text" in p)
    .map((p) => (p as { text: string }).text)
    .join("");
}

async function checkToolDependencies(): Promise<void> {
  const astGrepStatus = await checkAstGrepAvailable();
  if (!astGrepStatus.available) {
    log.warn("micode", astGrepStatus.message ?? "ast-grep unavailable");
  }

  const btcaStatus = await checkBtcaAvailable();
  if (!btcaStatus.available) {
    log.warn("micode", btcaStatus.message ?? "btca unavailable");
  }
}

async function runConstraintReview(
  ctx: PluginInput,
  internalSessions: Set<string>,
  reviewPrompt: string,
): Promise<string> {
  let sessionId: string | undefined;
  try {
    const sessionResult = await ctx.client.session.create({
      body: { title: "constraint-reviewer" },
    });

    if (!sessionResult.data?.id) {
      log.warn("mindmodel", "Failed to create reviewer session");
      return '{"status": "PASS", "violations": [], "summary": "Review skipped"}';
    }
    sessionId = sessionResult.data.id;

    internalSessions.add(sessionId);

    const promptResult = await ctx.client.session.prompt({
      path: { id: sessionId },
      body: {
        agent: "mm-constraint-reviewer",
        tools: {},
        parts: [{ type: "text", text: reviewPrompt }],
      },
    });

    if (!promptResult.data?.parts) {
      return '{"status": "PASS", "violations": [], "summary": "Empty response"}';
    }

    return extractTextFromParts(promptResult.data.parts);
  } catch (error) {
    log.warn("mindmodel", `Reviewer failed: ${extractErrorMessage(error)}`);
    return '{"status": "PASS", "violations": [], "summary": "Review failed"}';
  } finally {
    if (sessionId) {
      internalSessions.delete(sessionId);
      await ctx.client.session.delete({ path: { id: sessionId } }).catch((_e: unknown) => {
        /* fire-and-forget */
      });
    }
  }
}

interface RuntimeHooks {
  contextBudgetHook: ReturnType<typeof createContextBudgetHook> | null;
  contextPinnerHook: ReturnType<typeof createContextPinnerHook> | null;
  outputGovernorHook: ReturnType<typeof createOutputGovernorHook> | null;
  toolLoopGuardHook: ReturnType<typeof createToolLoopGuardHook> | null;
}

function getProviderID(ctx: PluginInput): string | undefined {
  const record = ctx as Record<string, unknown>;
  return typeof record.providerID === "string" ? record.providerID : undefined;
}

function createRuntimeHooks(
  isLocalLLM: boolean,
  ctx: PluginInput,
  userConfig: MicodeConfig | null,
  modelContextLimits: Map<string, number>,
  localContextLimit: number | undefined,
): RuntimeHooks {
  const smallContext = userConfig?.smallContext ?? null;
  const smallContextConfigured = smallContext !== null;
  const shouldTrackBudget = isLocalLLM || smallContextConfigured;

  if (!shouldTrackBudget) {
    return { contextBudgetHook: null, contextPinnerHook: null, outputGovernorHook: null, toolLoopGuardHook: null };
  }

  const contextBudgetHook = createContextBudgetHook(ctx, {
    localContextLimit,
    charPerToken: userConfig?.localLLM?.charPerToken,
    maxReadRatio: userConfig?.localLLM?.maxReadRatio,
    minRemainingRatio: userConfig?.localLLM?.minRemainingRatio,
    outputBudget: userConfig?.localLLM?.outputBudget,
    reasoningBudget: userConfig?.localLLM?.reasoningBudget,
    modelContextLimits,
    smallContext,
  });

  return {
    contextBudgetHook,
    contextPinnerHook: smallContextConfigured
      ? createContextPinnerHook({ smallContext, modelContextLimits, localContextLimit })
      : null,
    outputGovernorHook: smallContextConfigured ? createOutputGovernorHook(contextBudgetHook) : null,
    toolLoopGuardHook: isLocalLLM
      ? createToolLoopGuardHook(ctx, {
          threshold: userConfig?.localLLM?.toolLoopThreshold,
          maxInterventions: userConfig?.localLLM?.toolLoopMaxInterventions,
        })
      : null,
  };
}

function warnUnknownFragmentAgents(userConfig: MicodeConfig | null): void {
  if (!userConfig?.fragments) return;

  const knownAgentNames = new Set(Object.keys(agents));
  const fragmentAgentNames = Object.keys(userConfig.fragments);
  const warnings = warnUnknownAgents(fragmentAgentNames, knownAgentNames);
  for (const warning of warnings) {
    log.warn("micode", warning);
  }
}

// eslint-disable-next-line max-lines-per-function
const OpenCodeConfigPlugin: Plugin = async (ctx) => {
  // Validate external tool dependencies at startup
  await checkToolDependencies();

  // Load user config for agent overrides and feature flags
  const userConfig = await loadMicodeConfig();

  // Load model context limits from opencode.json
  const modelContextLimits = loadModelContextLimits();
  const smallContext = userConfig?.smallContext ?? null;

  // Think mode state per session
  const thinkModeState = new Map<string, boolean>();

  // Feature-flagged local LLM mode
  const isLocalLLM = isLocalLLMProvider(getProviderID(ctx));
  const localContextLimit = isLocalLLM
    ? (userConfig?.localLLM?.contextLimit ?? config.localLLM.defaultContextLimit)
    : undefined;
  const promptBudgetController = smallContext
    ? createPromptBudgetController({ smallContext, modelContextLimits, localContextLimit })
    : null;

  // Hooks
  const autoCompactHook = createAutoCompactHook(ctx, {
    compactionThreshold: userConfig?.compactionThreshold,
    modelContextLimits,
    localContextLimit,
    smallContext,
  });
  const contextInjectorHook = createContextInjectorHook(ctx, {
    promptBudget: promptBudgetController ?? undefined,
  });
  const ledgerLoaderHook = createLedgerLoaderHook(ctx, {
    modelContextLimits,
    localContextLimit,
    promptBudget: promptBudgetController ?? undefined,
    smallContext,
  });
  const sessionRecoveryHook = createSessionRecoveryHook(ctx, {
    modelContextLimits,
    localContextLimit,
    smallContext,
  });
  const tokenAwareTruncationHook = createTokenAwareTruncationHook(ctx);
  const contextWindowMonitorHook = createContextWindowMonitorHook(ctx, {
    modelContextLimits,
    localContextLimit,
    smallContext,
  });
  const commentCheckerHook = createCommentCheckerHook(ctx);
  const artifactAutoIndexHook = createArtifactAutoIndexHook(ctx);
  const fileOpsTrackerHook = createFileOpsTrackerHook(ctx);
  const fetchTrackerHook = createFetchTrackerHook(ctx);

  // Fragment injector hook - injects user-defined prompt fragments
  const fragmentInjectorHook = createFragmentInjectorHook(ctx, userConfig, {
    promptBudget: promptBudgetController ?? undefined,
  });

  // Runtime hooks for local models and small-context mode
  const { contextBudgetHook, contextPinnerHook, outputGovernorHook, toolLoopGuardHook } = createRuntimeHooks(
    isLocalLLM,
    ctx,
    userConfig,
    modelContextLimits,
    localContextLimit,
  );

  // Warn about unknown agent names in fragments config
  warnUnknownFragmentAgents(userConfig);

  // Track internal sessions to prevent hook recursion (used by reviewer)
  const internalSessions = new Set<string>();

  // Mindmodel injector hook - matches tasks to patterns via keywords and injects them
  // Feature-flagged: set features.mindmodelInjection=true in micode.json to enable
  const mindmodelInjectorHook = userConfig?.features?.mindmodelInjection
    ? createMindmodelInjectorHook(ctx, { promptBudget: promptBudgetController ?? undefined })
    : null;

  // Mindmodel lookup tool - agents call this when they need coding patterns
  const mindmodelLookupTool = createMindmodelLookupTool(ctx);

  // Constraint reviewer hook - reviews generated code against .mindmodel/ constraints
  const constraintReviewerHook = createConstraintReviewerHook(ctx, (reviewPrompt) =>
    runConstraintReview(ctx, internalSessions, reviewPrompt),
  );

  // PTY System - load bun-pty with graceful degradation
  // Sets BUN_PTY_LIB env var to fix path resolution in OpenCode plugin environments
  // See: https://github.com/vtemian/micode/issues/20
  const ptyManager = createPTYManager();
  const bunPty = await loadBunPty();
  if (bunPty) {
    ptyManager.init(bunPty.spawn);
  }
  const ptyTools = ptyManager.available ? createPtyTools(ptyManager) : {};

  // Spawn agent tool (for subagents to spawn other subagents)
  const spawn_agent = createSpawnAgentTool(ctx, contextBudgetHook ?? undefined);

  // Batch read tool (for parallel file reads)
  const batch_read = createBatchReadTool(ctx);

  // Octto (browser-based brainstorming) tools
  const octtoSessionStore = createSessionStore();

  // Track octto sessions per opencode session for cleanup
  const octtoSessions = new Map<string, Set<string>>();

  const octtoTools = createOcttoTools(octtoSessionStore, ctx.client, {
    onCreated: (parentSessionId, octtoSessionId) => {
      const sessions = octtoSessions.get(parentSessionId) ?? new Set<string>();
      sessions.add(octtoSessionId);
      octtoSessions.set(parentSessionId, sessions);
    },
    onEnded: (parentSessionId, octtoSessionId) => {
      const sessions = octtoSessions.get(parentSessionId);
      if (!sessions) return;
      sessions.delete(octtoSessionId);
      if (sessions.size === 0) {
        octtoSessions.delete(parentSessionId);
      }
    },
  });

  async function cleanupDeletedSession(event: { properties?: unknown }): Promise<void> {
    const props = event.properties as { info?: { id?: string } } | undefined;
    if (!props?.info?.id) return;

    const sessionId = props.info.id;
    thinkModeState.delete(sessionId);
    ptyManager.cleanupBySession(sessionId);
    constraintReviewerHook.cleanupSession(sessionId);
    fetchTrackerHook.cleanupSession(sessionId);
    toolLoopGuardHook?.cleanupSession(sessionId);

    // Cleanup octto sessions
    const sessionOcttoIds = octtoSessions.get(sessionId);
    if (sessionOcttoIds) {
      for (const octtoSessionId of sessionOcttoIds) {
        await octtoSessionStore.endSession(octtoSessionId).catch((_e: unknown) => {
          /* fire-and-forget */
        });
      }
      octtoSessions.delete(sessionId);
    }
  }

  return {
    // Tools
    tool: {
      ast_grep_search,
      ast_grep_replace,
      btca_ask,
      look_at,
      artifact_search,
      milestone_artifact_search,
      spawn_agent,
      batch_read,
      ...(contextBudgetHook ? createCheckContextBudgetTool(contextBudgetHook) : {}),
      ...mindmodelLookupTool,
      ...ptyTools,
      ...octtoTools,
    },

    config: async (config) => {
      // Allow all permissions globally - no prompts
      config.permission = {
        ...config.permission,
        edit: "allow",
        bash: "allow",
        webfetch: "allow",
        external_directory: "allow",
      };

      // Merge user config overrides into plugin agents
      const mergedAgents = mergeAgentConfigs(agents, userConfig);

      // Add our agents - our agents override OpenCode defaults, demote built-in build/plan to subagent
      config.agent = {
        ...config.agent, // OpenCode defaults first
        build: { ...config.agent?.build, mode: "subagent" },
        plan: { ...config.agent?.plan, mode: "subagent" },
        triage: { ...config.agent?.triage, mode: "subagent" },
        docs: { ...config.agent?.docs, mode: "subagent" },
        // Our agents override - spread these LAST so they take precedence
        ...Object.fromEntries(Object.entries(mergedAgents).filter(([k]) => k !== PRIMARY_AGENT_NAME)),
        [PRIMARY_AGENT_NAME]: mergedAgents[PRIMARY_AGENT_NAME],
      };

      // Add MCP servers (plugin servers override defaults)
      config.mcp = {
        ...config.mcp,
        ...MCP_SERVERS,
      };

      // Add commands
      config.command = { ...config.command, ...PLUGIN_COMMANDS };
    },

    "chat.message": async (input, output) => {
      // Extract text from user message
      const text = output.parts
        .filter((p) => p.type === "text" && "text" in p)
        .map((p) => (p as { text: string }).text)
        .join(" ");

      // Track if think mode was requested
      thinkModeState.set(input.sessionID, detectThinkKeyword(text));

      // Check for override command
      await constraintReviewerHook["chat.message"](input, output);

      // Capture session goal for context reminders
      if (contextPinnerHook) {
        await contextPinnerHook["chat.message"](input, output);
      }
    },

    "chat.params": async (input, output) => {
      // Inject user-defined fragments FIRST (highest priority, beginning of prompt)
      await fragmentInjectorHook["chat.params"](input, output);

      // Inject ledger context (high priority)
      await ledgerLoaderHook["chat.params"](input, output);

      // Inject project context files
      await contextInjectorHook["chat.params"](input, output);

      // Inject context window status
      await contextWindowMonitorHook["chat.params"](input, output);

      // Track context budget status
      if (contextBudgetHook) {
        await contextBudgetHook["chat.params"](input);
      }

      // Inject periodic context reminders
      if (contextPinnerHook) {
        await contextPinnerHook["chat.params"](input, output);
      }

      // If think mode was requested, increase thinking budget
      if (thinkModeState.get(input.sessionID)) {
        output.options = {
          ...output.options,
          thinking: {
            type: "enabled",
            budgetTokens: config.thinking.budgetTokens,
          },
        };
      }
    },

    // Structured compaction prompt (Factory.ai / pi-mono best practices)
    "experimental.session.compacting": async (
      input: { sessionID: string },
      output: { context: string[]; prompt?: string },
    ) => {
      const fileOpsSection = formatFileOpsSection(input.sessionID);

      output.prompt = `Create a structured summary for continuing this conversation. Use this EXACT format:

# Session Summary

## Goal
{The core objective being pursued - one sentence describing success criteria}

## Constraints & Preferences
{Technical requirements, patterns to follow, things to avoid - or "(none)"}

## Progress
### Done
- [x] {Completed items with specific details}

### In Progress
- [ ] {Current work - what's actively being worked on}

### Blocked
- {Issues preventing progress, if any - or "(none)"}

## Key Decisions
- **{Decision}**: {Rationale - why this choice was made}

## Next Steps
1. {Ordered list of what to do next - be specific}

## Critical Context
- {Data, examples, references, or findings needed to continue work}
- {Important discoveries or insights from this session}
${fileOpsSection}

IMPORTANT:
- Preserve EXACT file paths and function names
- Focus on information needed to continue seamlessly
- Be specific about what was done, not vague summaries
- Include any error messages or issues encountered`;

      if (contextPinnerHook) {
        await contextPinnerHook["experimental.session.compacting"](input, output);
      }
    },

    // Tool output processing
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string; args?: Record<string, unknown> },
      output: { output?: string },
    ) => {
      // Token-aware truncation
      await tokenAwareTruncationHook["tool.execute.after"]({ name: input.tool, sessionID: input.sessionID }, output);

      // Comment checker for Edit tool
      await commentCheckerHook["tool.execute.after"]({ tool: input.tool, args: input.args }, output);

      // Directory-aware context injection for Read/Edit
      await contextInjectorHook["tool.execute.after"](
        { tool: input.tool, sessionID: input.sessionID, args: input.args },
        output,
      );

      if (outputGovernorHook) {
        await outputGovernorHook["tool.execute.after"]({ tool: input.tool, sessionID: input.sessionID }, output);
      }

      // Auto-index artifacts when written to thoughts/ directories
      await artifactAutoIndexHook["tool.execute.after"]({ tool: input.tool, args: input.args }, output);

      // Track file operations for ledger
      await fileOpsTrackerHook["tool.execute.after"](
        { tool: input.tool, sessionID: input.sessionID, args: input.args },
        output,
      );

      await fragmentInjectorHook["tool.execute.after"]({ tool: input.tool, args: input.args }, output);

      // Track fetch operations and cache results
      await fetchTrackerHook["tool.execute.after"](
        { tool: input.tool, sessionID: input.sessionID, args: input.args },
        output,
      );

      if (mindmodelInjectorHook) {
        await mindmodelInjectorHook["tool.execute.after"]({ tool: input.tool, args: input.args }, output);
      }

      // Constraint review for Edit/Write
      await constraintReviewerHook["tool.execute.after"](
        { tool: input.tool, sessionID: input.sessionID, args: input.args },
        output,
      );

      if (toolLoopGuardHook) {
        await toolLoopGuardHook["tool.execute.after"](
          { tool: input.tool, sessionID: input.sessionID, args: input.args },
          output,
        );
      }
    },

    // Transform messages: match task keywords and prepare mindmodel injection
    "experimental.chat.messages.transform": async (input, output) => {
      if (!mindmodelInjectorHook) return;
      // Skip internal sessions (reviewer)
      const sessionID = (input as { sessionID?: string }).sessionID;
      if (sessionID && internalSessions.has(sessionID)) return;

      await mindmodelInjectorHook["experimental.chat.messages.transform"](input, output);
    },

    // Transform system prompt: filter CLAUDE.md/AGENTS.md + inject mindmodel
    "experimental.chat.system.transform": async (input, output) => {
      // Filter out CLAUDE.md/AGENTS.md from system prompt for our agents
      output.system = output.system.filter((s) => {
        // Keep entries that don't come from CLAUDE.md or AGENTS.md
        if (s.startsWith("Instructions from:")) {
          const path = s.split("\n")[0];
          if (path.includes("CLAUDE.md") || path.includes("AGENTS.md")) {
            return false;
          }
        }
        return true;
      });

      // Inject mindmodel patterns into system prompt (if enabled)
      if (mindmodelInjectorHook && input.sessionID) {
        await mindmodelInjectorHook["experimental.chat.system.transform"](
          input as typeof input & { sessionID: string },
          output,
        );
      }
    },

    event: async ({ event }) => {
      // Session cleanup (think mode + PTY + octto + constraint reviewer)
      if (event.type === "session.deleted") {
        await cleanupDeletedSession(event);
      }

      // Run all event hooks
      await autoCompactHook.event({ event });
      await sessionRecoveryHook.event({ event });
      await tokenAwareTruncationHook.event({ event });
      await contextWindowMonitorHook.event({ event });

      // File ops tracker cleanup
      await fileOpsTrackerHook.event({ event });

      // Fetch tracker cleanup
      await fetchTrackerHook.event({ event });

      // Track context budget usage (message.updated events)
      if (contextBudgetHook) {
        await contextBudgetHook.event({ event });
      }

      if (promptBudgetController) {
        await promptBudgetController.event({ event });
      }

      // Session cleanup and post-compaction detection for context reminders
      if (contextPinnerHook) {
        await contextPinnerHook.event({ event });
      }
    },
  };
};

function formatFileOpsSection(sessionID: string): string {
  const fileOps = getFileOps(sessionID);
  const readPaths = Array.from(fileOps.read).sort();
  const modifiedPaths = Array.from(fileOps.modified).sort();

  return `
## File Operations
### Read
${readPaths.length > 0 ? readPaths.map((p) => `- \`${p}\``).join("\n") : "- (none)"}

### Modified
${modifiedPaths.length > 0 ? modifiedPaths.map((p) => `- \`${p}\``).join("\n") : "- (none)"}`;
}

export { OpenCodeConfigPlugin };
