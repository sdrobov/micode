import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PluginInput } from "@opencode-ai/plugin";

import { config } from "@/utils/config";

import {
  type ContinuityHookConfig,
  formatContinuityAnchor,
  getContinuityAnchorBudget,
  getSessionContinuityAnchor,
  isContinuityAnchorActive,
  mergeSessionContinuitySummary,
  updateSessionContinuityProfile,
} from "./continuity-anchor";
import type { PromptBudgetController } from "./prompt-budgeting";
import { estimatePromptTokens, truncatePromptText } from "./prompt-budgeting";

const LEDGER_TRUNCATION_SUFFIX = "\n\n[Ledger trimmed for small-context prompt budget]";

export interface LedgerInfo {
  readonly sessionName: string;
  readonly filePath: string;
  readonly content: string;
}

async function getFileMtime(filePath: string): Promise<number> {
  try {
    const stat = await Bun.file(filePath).stat();
    return stat ? stat.mtime.getTime() : 0;
  } catch {
    return 0;
  }
}

async function findLatestFile(dir: string, files: string[]): Promise<string> {
  let latestFile = files[0];
  let latestMtime = 0;

  for (const file of files) {
    const mtime = await getFileMtime(join(dir, file));
    if (mtime <= latestMtime) continue;
    latestMtime = mtime;
    latestFile = file;
  }

  return latestFile;
}

export async function findCurrentLedger(directory: string): Promise<LedgerInfo | null> {
  const ledgerDir = join(directory, config.paths.ledgerDir);

  try {
    const files = await readdir(ledgerDir);
    const ledgerFiles = files.filter((file) => file.startsWith(config.paths.ledgerPrefix) && file.endsWith(".md"));
    if (ledgerFiles.length === 0) return null;

    const latestFile = await findLatestFile(ledgerDir, ledgerFiles);
    const filePath = join(ledgerDir, latestFile);
    const content = await readFile(filePath, "utf-8");
    const sessionName = latestFile.replace(config.paths.ledgerPrefix, "").replace(".md", "");
    return { sessionName, filePath, content };
  } catch {
    return null;
  }
}

export function formatLedgerInjection(ledger: LedgerInfo): string {
  return `<continuity-ledger session="${ledger.sessionName}">
${ledger.content}
</continuity-ledger>

You are resuming work from a previous context clear. The ledger above contains your session state.
Review it and continue from where you left off. The "Now" item is your current focus.`;
}

function formatLedgerAnchorInjection(sessionID: string, hookConfig?: ContinuityHookConfig): string {
  const budgetTokens = getContinuityAnchorBudget(hookConfig);
  const anchor = getSessionContinuityAnchor(sessionID);
  return `${formatContinuityAnchor(sessionID, anchor, budgetTokens)}

This anchor was reconstructed from the latest ledger. Resume the accepted plan and current step.`;
}

interface LedgerLoaderHooks {
  "chat.params": (
    input: { sessionID: string },
    output: { options?: Record<string, unknown>; system?: string },
  ) => Promise<void>;
}

export interface LedgerLoaderConfig extends ContinuityHookConfig {
  readonly promptBudget?: PromptBudgetController;
}

function formatBudgetedLedgerInjection(
  ledger: LedgerInfo,
  sessionID: string,
  existingText: string | undefined,
  outputOptions: Record<string, unknown> | undefined,
  hookConfig?: LedgerLoaderConfig,
): string {
  const remainingTokens = hookConfig?.promptBudget?.getRemainingTokens({
    existingText,
    options: outputOptions,
    sessionID,
  });
  const injection = formatLedgerInjection(ledger);
  if (remainingTokens == null || estimatePromptTokens(injection) <= remainingTokens) {
    return injection;
  }

  const prefix = `<continuity-ledger session="${ledger.sessionName}">\n`;
  const suffix = `
</continuity-ledger>

You are resuming work from a previous context clear. The ledger above contains your session state.
Review it and continue from where you left off. The "Now" item is your current focus.`;
  const availableTokens = remainingTokens - estimatePromptTokens(`${prefix}${suffix}`);
  const content = truncatePromptText(ledger.content, availableTokens, LEDGER_TRUNCATION_SUFFIX);
  if (!content) {
    return "";
  }

  return `${prefix}${content}${suffix}`;
}

export function createLedgerLoaderHook(ctx: PluginInput, hookConfig?: LedgerLoaderConfig): LedgerLoaderHooks {
  return {
    "chat.params": async (input, output) => {
      const ledger = await findCurrentLedger(ctx.directory);
      if (!ledger) return;

      updateSessionContinuityProfile(input.sessionID, "", "", hookConfig);

      if (isContinuityAnchorActive(input.sessionID)) {
        mergeSessionContinuitySummary(input.sessionID, ledger.content, getContinuityAnchorBudget(hookConfig));

        const injection = formatLedgerAnchorInjection(input.sessionID, hookConfig);
        output.system = output.system ? `${injection}\n\n${output.system}` : injection;
        return;
      }

      const injection = formatBudgetedLedgerInjection(
        ledger,
        input.sessionID,
        output.system,
        output.options,
        hookConfig,
      );
      if (!injection) return;
      output.system = output.system ? `${injection}\n\n${output.system}` : injection;
    },
  };
}
