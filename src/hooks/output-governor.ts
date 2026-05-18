import type { ContextBudgetHooks, OutputGovernorState } from "@/hooks/context-budget";

const DOCUMENT_TOOLS = new Set([
  "Read",
  "Task",
  "batch_read",
  "look_at",
  "spawn_agent",
  "task",
  "webfetch",
  "web_fetch",
  "context7_query-docs",
  "context7_resolve-library-id",
  "btca_ask",
]);
const LOG_TOOLS = new Set(["bash", "read_bash", "write_bash"]);
const PTY_TOOLS = new Set(["pty_read"]);
const DEFAULT_HEADER_LINES = 6;
const LOG_HEADER_LINES = 2;
const LOG_TAIL_LINES = 80;
const NOTE_VARIANTS = ["detailed", "short"] as const;
const PTY_HEADER_LINES = 1;
const PTY_FOOTER_LINES = 2;
const PTY_TAIL_LINES = 60;

export interface OutputGovernorHooks {
  "tool.execute.after": (
    input: { tool?: string; name?: string; sessionID: string },
    output: { output?: string },
  ) => Promise<void>;
}

function estimateTokens(text: string, charPerToken: number): number {
  return Math.ceil(text.length / charPerToken);
}

function takeLeadingLines(lines: readonly string[], maxTokens: number, charPerToken: number): string[] {
  const taken: string[] = [];
  let usedTokens = 0;

  for (const line of lines) {
    const lineTokens = estimateTokens(`${line}\n`, charPerToken);
    if (taken.length > 0 && usedTokens + lineTokens > maxTokens) {
      break;
    }
    if (taken.length === 0 && lineTokens > maxTokens) {
      break;
    }
    taken.push(line);
    usedTokens += lineTokens;
  }

  return taken;
}

function takeTrailingLines(lines: readonly string[], maxTokens: number, charPerToken: number): string[] {
  const taken: string[] = [];
  let usedTokens = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const lineTokens = estimateTokens(`${line}\n`, charPerToken);
    if (taken.length > 0 && usedTokens + lineTokens > maxTokens) {
      break;
    }
    if (taken.length === 0 && lineTokens > maxTokens) {
      break;
    }
    taken.push(line);
    usedTokens += lineTokens;
  }

  return taken.reverse();
}

function buildNote(hiddenLines: number, detail: string): string {
  const lineLabel = hiddenLines === 1 ? "line" : "lines";
  return `[Output truncated: ${hiddenLines} ${lineLabel} hidden to preserve small-context output headroom. ${detail}]`;
}

function buildShortNote(): string {
  return "[Output truncated for small-context headroom.]";
}

function renderNote(variant: (typeof NOTE_VARIANTS)[number], hiddenLines: number, detail: string): string {
  return variant === "short" ? buildShortNote() : buildNote(hiddenLines, detail);
}

function joinSections(sections: readonly string[][]): string {
  return sections
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n"))
    .join("\n");
}

function shrinkSection(lines: string[] | undefined, shrinkFromStart: boolean): boolean {
  if (!lines || lines.length === 0) {
    return false;
  }

  if (shrinkFromStart) {
    lines.shift();
    return true;
  }

  lines.pop();
  return true;
}

function fitNoteVariant(
  sections: readonly string[][],
  hiddenLines: number,
  detail: string,
  state: OutputGovernorState,
  shrinkIndex: number,
  shrinkFromStart: boolean,
  variant: (typeof NOTE_VARIANTS)[number],
): string | null {
  const mutableSections = sections.map((lines) => [...lines]);
  const originalLength = mutableSections[shrinkIndex]?.length ?? 0;

  for (;;) {
    const currentLength = mutableSections[shrinkIndex]?.length ?? 0;
    const extraHidden = originalLength - currentLength;
    const note = renderNote(variant, hiddenLines + extraHidden, detail);
    const withNote = joinSections([...mutableSections, ["", note]]);

    if (estimateTokens(withNote, state.charPerToken) <= state.availableTokens) {
      return withNote;
    }

    if (!shrinkSection(mutableSections[shrinkIndex], shrinkFromStart)) {
      return null;
    }
  }
}

function appendNote(
  sections: readonly string[][],
  hiddenLines: number,
  detail: string,
  state: OutputGovernorState,
  shrinkIndex: number,
  shrinkFromStart: boolean = false,
): string {
  const base = joinSections(sections);

  for (const variant of NOTE_VARIANTS) {
    const fitted = fitNoteVariant(sections, hiddenLines, detail, state, shrinkIndex, shrinkFromStart, variant);
    if (fitted) {
      return fitted;
    }
  }

  return base;
}

function truncateFromStart(output: string, state: OutputGovernorState, detail: string): string {
  const lines = output.split("\n");
  const header = lines.slice(0, DEFAULT_HEADER_LINES);
  const body = lines.slice(DEFAULT_HEADER_LINES);
  const safeHeader = takeLeadingLines(header, state.availableTokens, state.charPerToken);
  const safeHeaderTokens = estimateTokens(safeHeader.join("\n"), state.charPerToken);
  const safeBody = takeLeadingLines(body, Math.max(0, state.availableTokens - safeHeaderTokens), state.charPerToken);

  if (safeHeader.length + safeBody.length === lines.length) {
    return output;
  }

  return appendNote([safeHeader, safeBody], lines.length - safeHeader.length - safeBody.length, detail, state, 1);
}

function truncateLogs(
  output: string,
  state: OutputGovernorState,
  headerLines: number,
  footerLines: number,
  tailLines: number,
): string {
  const lines = output.split("\n");
  const header = lines.slice(0, headerLines);
  const footer = footerLines > 0 ? lines.slice(-footerLines) : [];
  const body = lines.slice(headerLines, lines.length - footer.length);
  const safeHeader = takeLeadingLines(header, state.availableTokens, state.charPerToken);
  const headerTokens = estimateTokens(safeHeader.join("\n"), state.charPerToken);
  const safeFooter = takeTrailingLines(footer, Math.max(0, state.availableTokens - headerTokens), state.charPerToken);
  const footerTokens = estimateTokens(safeFooter.join("\n"), state.charPerToken);
  const tailSource = body.slice(-tailLines);
  const safeTail = takeTrailingLines(
    tailSource,
    Math.max(0, state.availableTokens - headerTokens - footerTokens),
    state.charPerToken,
  );

  if (safeHeader.length + body.length + safeFooter.length === lines.length && safeTail.length === body.length) {
    return output;
  }

  const hiddenLines = Math.max(0, body.length - safeTail.length);
  return appendNote(
    [safeHeader, safeTail, safeFooter],
    hiddenLines,
    "Latest log lines were preserved.",
    state,
    1,
    true,
  );
}

function suppressOutput(toolName: string): string {
  return `[${toolName} output suppressed to preserve small-context output headroom. Request a narrower slice or specific range.]`;
}

function getToolName(input: { tool?: string; name?: string }): string {
  return input.tool ?? input.name ?? "";
}

function shouldGovernTool(toolName: string): boolean {
  return DOCUMENT_TOOLS.has(toolName) || LOG_TOOLS.has(toolName) || PTY_TOOLS.has(toolName);
}

export function governToolOutput(toolName: string, output: string, state: OutputGovernorState): string {
  if (!state.active || !shouldGovernTool(toolName)) {
    return output;
  }

  if (state.availableTokens <= 0) {
    return suppressOutput(toolName);
  }

  if (estimateTokens(output, state.charPerToken) <= state.availableTokens) {
    return output;
  }

  if (PTY_TOOLS.has(toolName)) {
    return truncateLogs(output, state, PTY_HEADER_LINES, PTY_FOOTER_LINES, PTY_TAIL_LINES);
  }

  if (LOG_TOOLS.has(toolName)) {
    return truncateLogs(output, state, LOG_HEADER_LINES, 0, LOG_TAIL_LINES);
  }

  return truncateFromStart(output, state, "Use narrower reads or delegate the full output.");
}

export function createOutputGovernorHook(budget: ContextBudgetHooks): OutputGovernorHooks {
  return {
    "tool.execute.after": async (input, output) => {
      const toolName = getToolName(input);
      if (!toolName || !output.output) {
        return;
      }

      output.output = governToolOutput(toolName, output.output, budget.getOutputGovernorState(input.sessionID));
    },
  };
}
