// src/hooks/mindmodel-injector.ts
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { PluginInput } from "@opencode-ai/plugin";

import {
  formatExamplesForInjection,
  type LoadedExample,
  type LoadedMindmodel,
  loadExamples,
  loadMindmodel,
} from "@/mindmodel";
import { matchCategories } from "@/tools/mindmodel-lookup";
import { config } from "@/utils/config";
import type { PromptBudgetController, PromptBudgetEntry } from "./prompt-budgeting";
import { estimatePromptTokens, selectPromptBudgetEntries, truncatePromptText } from "./prompt-budgeting";

const HASH_BIT_SHIFT = 5;
const BASE_36_RADIX = 36;
const TASK_CACHE_MAX_ENTRIES = 2000;
const MINDMODEL_TRUNCATION_SUFFIX = "\n\n[Example trimmed for small-context prompt budget]";
const CONSTRAINT_TRUNCATION_SUFFIX = "\n\n[Constraints trimmed for small-context prompt budget]";
const EXAMPLES_INTRO =
  "These are code examples from this project's mindmodel. Follow these patterns when implementing similar functionality.";
const EXAMPLES_OMISSION_NOTE = "Additional examples omitted for small-context prompt budget.";

interface MessagePart {
  type: string;
  text?: string;
}

interface MessageWithParts {
  info: { role: string };
  parts: MessagePart[];
}

// Simple hash function for task strings
function hashTask(task: string): string {
  let hash = 0;
  for (let i = 0; i < task.length; i++) {
    const char = task.charCodeAt(i);
    hash = (hash << HASH_BIT_SHIFT) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(BASE_36_RADIX);
}

// Simple LRU cache for matched tasks
interface LRUCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  clear(): void;
}

function createLRUCache<V>(maxSize: number): LRUCache<V> {
  const cache = new Map<string, V>();

  return {
    get(key: string): V | undefined {
      const value = cache.get(key);
      if (value !== undefined) {
        // Move to end (most recently used)
        cache.delete(key);
        cache.set(key, value);
      }
      return value;
    },

    set(key: string, value: V): void {
      if (cache.has(key)) {
        cache.delete(key);
      } else if (cache.size >= maxSize) {
        // Delete oldest (first) entry
        const firstKey = cache.keys().next().value;
        if (firstKey !== undefined) cache.delete(firstKey);
      }
      cache.set(key, value);
    },

    clear(): void {
      cache.clear();
    },
  };
}

function extractTaskFromMessages(messages: MessageWithParts[]): string {
  // Get the last user message
  const lastUserMessage = [...messages].reverse().find((m) => m.info.role === "user");
  if (!lastUserMessage) return "";

  // Extract text from parts
  return lastUserMessage.parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join(" ");
}

async function resolveInjection(
  task: string,
  mindmodel: LoadedMindmodel,
  matchedTasks: LRUCache<LoadedExample[]>,
): Promise<LoadedExample[]> {
  const taskHash = hashTask(task);
  const cachedExamples = matchedTasks.get(taskHash);
  if (cachedExamples !== undefined) {
    return cachedExamples;
  }

  const categories = matchCategories(task, mindmodel.manifest);
  if (categories.length === 0) {
    matchedTasks.set(taskHash, []);
    return [];
  }

  const examples = await loadExamples(mindmodel, categories);
  matchedTasks.set(taskHash, examples);
  return examples;
}

async function loadSystemMd(directory: string): Promise<string | null> {
  try {
    const systemPath = join(directory, config.paths.mindmodelDir, config.paths.mindmodelSystem);
    return await readFile(systemPath, "utf-8");
  } catch {
    return null;
  }
}

interface ResettableCachedLoader<T> {
  load: () => Promise<T | null>;
  clear: () => void;
}

function createCachedLoader<T>(loader: () => Promise<T | null>): ResettableCachedLoader<T> {
  let cached: T | null | undefined;

  return {
    load: async () => {
      if (cached === undefined) cached = await loader();
      return cached;
    },
    clear: () => {
      cached = undefined;
    },
  };
}

interface MindmodelInjectorHooks {
  "experimental.chat.messages.transform": (
    _input: { sessionID?: string } & Record<string, unknown>,
    output: { messages: MessageWithParts[] },
  ) => Promise<void>;
  "experimental.chat.system.transform": (_input: { sessionID: string }, output: { system: string[] }) => Promise<void>;
  "tool.execute.after": (
    input: { tool: string; args?: Record<string, unknown> },
    output: { output?: string },
  ) => Promise<void>;
}

export interface MindmodelInjectorConfig {
  readonly promptBudget?: PromptBudgetController;
}

interface ExampleBlock {
  readonly path: string;
  readonly description: string;
  readonly content: string;
}

function createMessageTransformHandler(
  getMindmodel: ResettableCachedLoader<LoadedMindmodel>,
  matchedTasks: LRUCache<LoadedExample[]>,
  pendingInjections: Map<string, LoadedExample[]>,
): MindmodelInjectorHooks["experimental.chat.messages.transform"] {
  return async (input, output) => {
    try {
      const sessionID = input.sessionID;
      if (!sessionID) return;

      const mindmodel = await getMindmodel.load();
      if (!mindmodel) {
        pendingInjections.delete(sessionID);
        return;
      }

      const task = extractTaskFromMessages(output.messages);
      if (!task) {
        pendingInjections.delete(sessionID);
        return;
      }

      const examples = await resolveInjection(task, mindmodel, matchedTasks);
      if (examples.length === 0) {
        pendingInjections.delete(sessionID);
        return;
      }
      pendingInjections.set(sessionID, examples);
    } catch {
      // Silently ignore errors so pattern lookup never blocks the main flow.
    }
  };
}

function createSystemTransformHandler(
  getSystemMd: ResettableCachedLoader<string>,
  pendingInjections: Map<string, LoadedExample[]>,
  promptBudget?: PromptBudgetController,
): MindmodelInjectorHooks["experimental.chat.system.transform"] {
  return async (input, output) => {
    const systemMd = await getSystemMd.load();
    const examples = pendingInjections.get(input.sessionID) ?? [];
    pendingInjections.delete(input.sessionID);

    const remainingTokens = promptBudget?.getRemainingTokens({
      existingText: output.system,
      sessionID: input.sessionID,
    });
    if (remainingTokens == null) {
      injectMindmodelContent(output, systemMd, examples);
      return;
    }

    injectBudgetedMindmodelContent(output, systemMd, examples, remainingTokens);
  };
}

function createToolExecuteHandler(
  projectDir: string,
  matchedTasks: LRUCache<LoadedExample[]>,
  pendingInjections: Map<string, LoadedExample[]>,
  getMindmodel: ResettableCachedLoader<LoadedMindmodel>,
  getSystemMd: ResettableCachedLoader<string>,
): MindmodelInjectorHooks["tool.execute.after"] {
  return async (input) => {
    if (!["Edit", "edit", "Write", "write"].includes(input.tool)) return;

    const filePath = getToolFilePath(input.args);
    if (!filePath) return;
    if (!resolve(filePath).startsWith(resolve(projectDir, config.paths.mindmodelDir))) return;
    matchedTasks.clear();
    pendingInjections.clear();
    getMindmodel.clear();
    getSystemMd.clear();
  };
}

export function createMindmodelInjectorHook(
  ctx: PluginInput,
  hookConfig?: MindmodelInjectorConfig,
): MindmodelInjectorHooks {
  const pendingInjections = new Map<string, LoadedExample[]>();
  const matchedTasks = createLRUCache<LoadedExample[]>(TASK_CACHE_MAX_ENTRIES);
  const getMindmodel = createCachedLoader(() => loadMindmodel(ctx.directory));
  const getSystemMd = createCachedLoader(() => loadSystemMd(ctx.directory));

  return {
    "experimental.chat.messages.transform": createMessageTransformHandler(
      getMindmodel,
      matchedTasks,
      pendingInjections,
    ),
    "experimental.chat.system.transform": createSystemTransformHandler(
      getSystemMd,
      pendingInjections,
      hookConfig?.promptBudget,
    ),
    "tool.execute.after": createToolExecuteHandler(
      ctx.directory,
      matchedTasks,
      pendingInjections,
      getMindmodel,
      getSystemMd,
    ),
  };
}

function getToolFilePath(args?: Record<string, unknown>): string | undefined {
  const filePath = args?.filePath;
  if (typeof filePath === "string") return filePath;
  const snakeCaseFilePath = args?.file_path;
  return typeof snakeCaseFilePath === "string" ? snakeCaseFilePath : undefined;
}

function formatConstraintBlock(content: string): string {
  return `<mindmodel-constraints>\n${content}\n</mindmodel-constraints>`;
}

function toExampleBlock(example: LoadedExample): ExampleBlock {
  return {
    path: example.path,
    description: example.description,
    content: example.content,
  };
}

function formatSingleExample(example: ExampleBlock): string {
  return `<example category="${example.path}" description="${example.description}">
${example.content}
</example>`;
}

function formatExampleBlocks(examples: readonly ExampleBlock[], omittedCount = 0): string {
  if (examples.length === 0 && omittedCount === 0) return "";

  const blocks = examples.map((example) => formatSingleExample(example));
  if (omittedCount > 0) {
    blocks.push(EXAMPLES_OMISSION_NOTE);
  }

  return `<mindmodel-examples>
${EXAMPLES_INTRO}

${blocks.join("\n\n")}
</mindmodel-examples>`;
}

function formatExampleWrapper(content: string): string {
  return `<mindmodel-examples>
${EXAMPLES_INTRO}

${content}
</mindmodel-examples>`;
}

function truncateConstraintBlock(content: string, remainingTokens: number): string | null {
  const wrapperTokens = estimatePromptTokens(formatConstraintBlock(""));
  return truncatePromptText(content, remainingTokens - wrapperTokens, CONSTRAINT_TRUNCATION_SUFFIX);
}

function truncateExampleEntry(
  entry: PromptBudgetEntry<ExampleBlock>,
  remainingTokens: number,
): PromptBudgetEntry<ExampleBlock> | null {
  const wrapperTokens = estimatePromptTokens(formatSingleExample({ ...entry.value, content: "" }));
  const content = truncatePromptText(entry.value.content, remainingTokens - wrapperTokens, MINDMODEL_TRUNCATION_SUFFIX);
  if (!content) return null;

  const value = { ...entry.value, content };
  return { ...entry, value, text: formatSingleExample(value) };
}

function toExampleEntries(examples: readonly LoadedExample[]): PromptBudgetEntry<ExampleBlock>[] {
  return examples.map((example, index) => {
    const value = toExampleBlock(example);
    return {
      value,
      text: formatSingleExample(value),
      priority: index,
      dedupeKey: example.path,
    };
  });
}

function injectMindmodelContent(
  output: { system: string[] },
  systemMd: string | null,
  examples: readonly LoadedExample[],
): void {
  if (systemMd) {
    output.system.unshift(formatConstraintBlock(systemMd));
  }
  if (examples.length > 0) {
    output.system.unshift(formatExamplesForInjection([...examples]));
  }
}

function injectBudgetedMindmodelContent(
  output: { system: string[] },
  systemMd: string | null,
  examples: readonly LoadedExample[],
  remainingTokens: number,
): void {
  let budget = remainingTokens;

  if (systemMd) {
    const block = fitConstraintBlock(systemMd, budget);
    if (block) {
      output.system.unshift(block);
      budget -= estimatePromptTokens(block);
    }
  }

  if (budget <= 0 || examples.length === 0) return;
  const examplesBlock = fitExampleBlocks(examples, budget);
  if (examplesBlock) {
    output.system.unshift(examplesBlock);
  }
}

function fitConstraintBlock(content: string, remainingTokens: number): string | null {
  const block = formatConstraintBlock(content);
  const fullTokens = estimatePromptTokens(block);
  if (fullTokens <= remainingTokens) return block;

  const truncated = truncateConstraintBlock(content, remainingTokens);
  return truncated ? formatConstraintBlock(truncated) : null;
}

function fitExampleBlocks(examples: readonly LoadedExample[], remainingTokens: number): string | null {
  const wrapperTokens = estimatePromptTokens(formatExampleWrapper(""));
  if (remainingTokens <= wrapperTokens) return null;

  const selection = selectPromptBudgetEntries(
    toExampleEntries(examples),
    remainingTokens - wrapperTokens,
    truncateExampleEntry,
  );
  if (selection.values.length === 0) return null;
  return formatExampleBlocks(selection.values, selection.omittedCount);
}
