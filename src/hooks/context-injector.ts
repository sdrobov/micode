import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { PluginInput } from "@opencode-ai/plugin";

import { config } from "@/utils/config";
import type { PromptBudgetController, PromptBudgetEntry } from "./prompt-budgeting";
import { estimatePromptTokens, selectPromptBudgetEntries, truncatePromptText } from "./prompt-budgeting";

// Tools that trigger directory-aware context injection
const FILE_ACCESS_TOOLS = ["Read", "read", "Edit", "edit"];
const CACHE_INVALIDATION_TOOLS = ["Edit", "edit", "Write", "write"];
const CONTEXT_TRUNCATION_SUFFIX = "\n\n[Context trimmed for small-context prompt budget]";
const CONTEXT_OMISSION_TEMPLATE =
  '<context-summary omitted="%COUNT%">Additional context files omitted for small-context prompt budget.</context-summary>';

// Cache for file contents
interface ContextCache {
  rootContent: Map<string, string>;
  directoryContent: Map<string, Map<string, string>>; // path -> filename -> content
  lastRootCheck: number;
}

interface ContextInjectorHooks {
  "chat.params": (
    _input: { sessionID: string },
    output: { options?: Record<string, unknown>; system?: string },
  ) => Promise<void>;
  "tool.execute.after": (
    input: { tool: string; sessionID?: string; args?: Record<string, unknown> },
    output: { output?: string },
  ) => Promise<void>;
}

export interface ContextInjectorConfig {
  readonly promptBudget?: PromptBudgetController;
}

interface ContextFile {
  readonly filename: string;
  readonly content: string;
}

function createChatParamsHandler(
  loadRootContextFiles: () => Promise<Map<string, string>>,
  promptBudget?: PromptBudgetController,
): ContextInjectorHooks["chat.params"] {
  return async (input, output) => {
    const files = await loadRootContextFiles();
    if (files.size === 0) return;

    const contextBlock = formatBudgetedContextBlock(files, "project-context", {
      existingText: output.system,
      options: output.options,
      promptBudget,
      sessionID: input.sessionID,
    });
    if (!contextBlock) return;
    output.system = output.system ? output.system + contextBlock : contextBlock;
  };
}

function createToolExecuteHandler(
  projectRoot: string,
  cache: ContextCache,
  walkUpForContextFiles: (filePath: string) => Promise<Map<string, string>>,
  promptBudget?: PromptBudgetController,
): ContextInjectorHooks["tool.execute.after"] {
  return async (input, output) => {
    const filePath = getToolFilePath(input.args);
    if (!filePath) return;

    if (CACHE_INVALIDATION_TOOLS.includes(input.tool)) {
      invalidateContextCache(projectRoot, cache, filePath);
    }

    if (!FILE_ACCESS_TOOLS.includes(input.tool)) return;

    try {
      const directoryFiles = await walkUpForContextFiles(filePath);
      if (directoryFiles.size === 0) return;

      const contextBlock = formatBudgetedContextBlock(directoryFiles, "directory-context", {
        existingText: output.output,
        promptBudget,
        sessionID: input.sessionID,
      });
      if (!contextBlock || !output.output) return;
      output.output = output.output + contextBlock;
    } catch {
      // Ignore errors in context injection
    }
  };
}

export function createContextInjectorHook(ctx: PluginInput, hookConfig?: ContextInjectorConfig): ContextInjectorHooks {
  const cache: ContextCache = {
    rootContent: new Map(),
    directoryContent: new Map(),
    lastRootCheck: 0,
  };

  const loadRootContextFiles = (): Promise<Map<string, string>> => loadRootFiles(ctx, cache);
  const walkUpForContextFiles = (filePath: string): Promise<Map<string, string>> =>
    walkUpForContext(ctx, cache, filePath);

  return {
    "chat.params": createChatParamsHandler(loadRootContextFiles, hookConfig?.promptBudget),
    "tool.execute.after": createToolExecuteHandler(
      ctx.directory,
      cache,
      walkUpForContextFiles,
      hookConfig?.promptBudget,
    ),
  };
}

// --- Private helpers ---

async function loadRootFiles(ctx: PluginInput, cache: ContextCache): Promise<Map<string, string>> {
  const now = Date.now();
  if (now - cache.lastRootCheck < config.limits.contextCacheTtlMs && cache.rootContent.size > 0) {
    return cache.rootContent;
  }

  cache.rootContent.clear();
  cache.lastRootCheck = now;

  for (const filename of config.paths.rootContextFiles) {
    await tryLoadFile(join(ctx.directory, filename), filename, cache.rootContent);
  }

  return cache.rootContent;
}

async function tryLoadFile(filepath: string, key: string, target: Map<string, string>): Promise<void> {
  try {
    const content = await readFile(filepath, "utf-8");
    if (content.trim()) {
      target.set(key, content);
    }
  } catch {
    // File doesn't exist - skip
  }
}

async function walkUpForContext(ctx: PluginInput, cache: ContextCache, filePath: string): Promise<Map<string, string>> {
  const absPath = resolve(filePath);
  const projectRoot = resolve(ctx.directory);

  const cacheKey = dirname(absPath);
  const cached = cache.directoryContent.get(cacheKey);
  if (cached) return cached;

  const collected = new Map<string, string>();
  let currentDir = dirname(absPath);

  while (currentDir === projectRoot || currentDir.startsWith(`${projectRoot}/`)) {
    await collectDirContextFiles(currentDir, projectRoot, collected);
    if (currentDir === projectRoot) break;
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  cache.directoryContent.set(cacheKey, collected);
  evictOldestIfNeeded(cache);

  return collected;
}

async function collectDirContextFiles(
  currentDir: string,
  projectRoot: string,
  collected: Map<string, string>,
): Promise<void> {
  for (const filename of config.paths.dirContextFiles) {
    const contextPath = join(currentDir, filename);
    const relPath = currentDir.replace(projectRoot, "").replace(/^\//, "") || ".";
    const key = `${relPath}/${filename}`;
    if (collected.has(key)) continue;
    await tryLoadFile(contextPath, key, collected);
  }
}

function evictOldestIfNeeded(cache: ContextCache): void {
  if (cache.directoryContent.size <= config.limits.contextCacheMaxSize) return;
  const firstKey = cache.directoryContent.keys().next().value;
  if (firstKey) cache.directoryContent.delete(firstKey);
}

function getToolFilePath(args?: Record<string, unknown>): string | undefined {
  const filePath = args?.filePath;
  if (typeof filePath === "string") return filePath;
  const snakeCaseFilePath = args?.file_path;
  return typeof snakeCaseFilePath === "string" ? snakeCaseFilePath : undefined;
}

function clearDirectoryCache(cache: ContextCache, directory: string): void {
  for (const cacheKey of [...cache.directoryContent.keys()]) {
    if (cacheKey === directory || cacheKey.startsWith(`${directory}/`)) {
      cache.directoryContent.delete(cacheKey);
    }
  }
}

function invalidateContextCache(projectRoot: string, cache: ContextCache, filePath: string): void {
  const resolvedPath = resolve(filePath);
  const resolvedRoot = resolve(projectRoot);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}/`)) return;

  const rootFiles = new Set(config.paths.rootContextFiles);
  if (rootFiles.has(resolvedPath.replace(`${resolvedRoot}/`, ""))) {
    cache.rootContent.clear();
    cache.lastRootCheck = 0;
  }

  const contextFiles = new Set(config.paths.dirContextFiles);
  const filename = resolvedPath.split("/").pop();
  if (!filename || !contextFiles.has(filename)) return;
  clearDirectoryCache(cache, dirname(resolvedPath));
}

function formatSingleContextBlock(file: ContextFile): string {
  return `<context file="${file.filename}">\n${file.content}\n</context>`;
}

function formatOmissionSummary(omittedCount: number): string {
  return CONTEXT_OMISSION_TEMPLATE.replace("%COUNT%", String(omittedCount));
}

function toContextEntries(files: Map<string, string>): PromptBudgetEntry<ContextFile>[] {
  return [...files.entries()].map(([filename, content], index) => ({
    value: { filename, content },
    text: formatSingleContextBlock({ filename, content }),
    priority: index,
    dedupeKey: content,
  }));
}

function truncateContextEntry(
  entry: PromptBudgetEntry<ContextFile>,
  remainingTokens: number,
): PromptBudgetEntry<ContextFile> | null {
  const wrapperTokens = estimatePromptTokens(formatSingleContextBlock({ ...entry.value, content: "" }));
  const content = truncatePromptText(entry.value.content, remainingTokens - wrapperTokens, CONTEXT_TRUNCATION_SUFFIX);
  if (!content) return null;

  const value = { ...entry.value, content };
  return { ...entry, value, text: formatSingleContextBlock(value) };
}

function formatBudgetedContextBlock(
  files: Map<string, string>,
  label: string,
  options: {
    readonly existingText?: string;
    readonly options?: Record<string, unknown>;
    readonly promptBudget?: PromptBudgetController;
    readonly sessionID?: string;
  },
): string {
  if (files.size === 0) return "";

  const remainingTokens = options.promptBudget?.getRemainingTokens({
    existingText: options.existingText,
    options: options.options,
    sessionID: options.sessionID,
  });
  if (remainingTokens == null) {
    return formatContextBlock(
      [...files.entries()].map(([filename, content]) => ({ filename, content })),
      label,
    );
  }

  const selection = selectPromptBudgetEntries(toContextEntries(files), remainingTokens, truncateContextEntry);
  if (selection.values.length === 0) return "";
  return formatContextBlock(selection.values, label, selection.omittedCount);
}

function formatContextBlock(files: readonly ContextFile[], label: string, omittedCount = 0): string {
  if (files.length === 0) return "";
  const blocks: string[] = [];
  for (const file of files) {
    blocks.push(formatSingleContextBlock(file));
  }
  if (omittedCount > 0) {
    blocks.push(formatOmissionSummary(omittedCount));
  }
  return `\n<${label}>\n${blocks.join("\n\n")}\n</${label}>\n`;
}
