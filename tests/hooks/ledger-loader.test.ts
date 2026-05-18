import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resetContinuityRegistry } from "../../src/hooks/continuity-anchor";
import { createLedgerLoaderHook, findCurrentLedger } from "../../src/hooks/ledger-loader";

describe("ledger-loader", () => {
  let testDir: string;

  beforeEach(() => {
    resetContinuityRegistry();
    testDir = join(process.cwd(), ".test-artifacts", `ledger-test-${Date.now()}`);
    mkdirSync(join(testDir, "thoughts", "ledgers"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should find ledger files in thoughts/ledgers/", async () => {
    const ledgerPath = join(testDir, "thoughts", "ledgers", "CONTINUITY_test-session.md");
    writeFileSync(ledgerPath, "# Session: test-session\n\n## Goal\nTest goal");

    const result = await findCurrentLedger(testDir);

    expect(result).not.toBeNull();
    expect(result?.sessionName).toBe("test-session");
  });

  it("should return null when no ledger exists", async () => {
    const result = await findCurrentLedger(testDir);
    expect(result).toBeNull();
  });

  it("should inject the compact continuity anchor when small-context mode is on", async () => {
    const ledgerPath = join(testDir, "thoughts", "ledgers", "CONTINUITY_test-session.md");
    writeFileSync(
      ledgerPath,
      `# Session Summary

## Goal
Keep continuity on track

## Constraints & Preferences
- Preserve the accepted plan

## Progress
### Done
- [x] Added anchor helper

### In Progress
- [ ] Update ledger loader

### Blocked
- (none)

## Key Decisions
- **Use compact anchors**: Avoid prompt bloat

## Next Steps
1. Finish ledger loader
2. Update tests

## Critical Context
- Keep the corrected plan`,
    );

    const ctx = {
      directory: testDir,
    } as { directory: string };
    const hook = createLedgerLoaderHook(ctx as never, {
      smallContext: {
        mode: "on",
        autoThreshold: 128_000,
        continuityAnchor: {
          enabled: true,
          budgetTokens: 120,
        },
        outputGovernor: {
          enabled: true,
          reserveTokens: 4_096,
        },
        promptBudgeting: {
          enabled: true,
          maxPromptRatio: 0.7,
          reserveTokens: 8_192,
        },
      },
    });

    const output = { system: "base system" };
    await hook["chat.params"]({ sessionID: "s-ledger" }, output);

    expect(output.system).toContain("<continuity-anchor");
    expect(output.system).toContain("Current step: Update ledger loader");
    expect(output.system).not.toContain("<continuity-ledger");
  });
});
