import { beforeEach, describe, expect, it } from "bun:test";

import {
  activateOverflowRecovery,
  clearOverflowRecoverySession,
  deactivateOverflowRecovery,
  escalateOverflowRecovery,
  getOverflowRecoveryState,
  isOverflowRecoveryActive,
  OVERFLOW_RECOVERY_SOURCES,
  OVERFLOW_RECOVERY_STAGES,
  resetOverflowRecoveryState,
} from "../../src/hooks/overflow-recovery-state";

const SESSION_A = "session-a";
const SESSION_B = "session-b";
const CONTEXT_BUDGET = OVERFLOW_RECOVERY_SOURCES.CONTEXT_BUDGET;
const OUTPUT_GOVERNOR = OVERFLOW_RECOVERY_SOURCES.OUTPUT_GOVERNOR;
const SESSION_RECOVERY = OVERFLOW_RECOVERY_SOURCES.SESSION_RECOVERY;

describe("overflow-recovery-state", () => {
  beforeEach(() => {
    resetOverflowRecoveryState();
  });

  describe("OVERFLOW_RECOVERY_STAGES", () => {
    it("exposes the expected degraded stages", () => {
      expect(OVERFLOW_RECOVERY_STAGES.NORMAL).toBe("normal");
      expect(OVERFLOW_RECOVERY_STAGES.REDUCED).toBe("reduced");
      expect(OVERFLOW_RECOVERY_STAGES.STRICT).toBe("strict");
      expect(OVERFLOW_RECOVERY_STAGES.MINIMAL).toBe("minimal");
    });
  });

  describe("OVERFLOW_RECOVERY_SOURCES", () => {
    it("exposes the expected coordinator sources", () => {
      expect(OVERFLOW_RECOVERY_SOURCES.SESSION_RECOVERY).toBe("session-recovery");
      expect(OVERFLOW_RECOVERY_SOURCES.CONTEXT_BUDGET).toBe("context-budget");
      expect(OVERFLOW_RECOVERY_SOURCES.PROMPT_BUDGETING).toBe("prompt-budgeting");
      expect(OVERFLOW_RECOVERY_SOURCES.OUTPUT_GOVERNOR).toBe("output-governor");
    });
  });

  describe("getOverflowRecoveryState", () => {
    it("returns the default state for an unknown session", () => {
      expect(getOverflowRecoveryState(SESSION_A)).toEqual({
        active: false,
        stage: OVERFLOW_RECOVERY_STAGES.NORMAL,
        overflowCount: 0,
        lastSource: null,
        lastOverflowAt: null,
      });
    });
  });

  describe("isOverflowRecoveryActive", () => {
    it("tracks whether a session is currently degraded", () => {
      expect(isOverflowRecoveryActive(SESSION_A)).toBe(false);

      activateOverflowRecovery(SESSION_A, CONTEXT_BUDGET);

      expect(isOverflowRecoveryActive(SESSION_A)).toBe(true);
    });
  });

  describe("activateOverflowRecovery", () => {
    it("activates reduced mode by default and records overflow metadata", () => {
      const state = activateOverflowRecovery(SESSION_A, CONTEXT_BUDGET);

      expect(state.active).toBe(true);
      expect(state.stage).toBe(OVERFLOW_RECOVERY_STAGES.REDUCED);
      expect(state.overflowCount).toBe(1);
      expect(state.lastSource).toBe(CONTEXT_BUDGET);
      expect(typeof state.lastOverflowAt).toBe("number");
      expect(state.lastOverflowAt).toBeGreaterThan(0);
    });

    it("accepts an explicit stage for stricter recovery modes", () => {
      const state = activateOverflowRecovery(SESSION_A, SESSION_RECOVERY, OVERFLOW_RECOVERY_STAGES.STRICT);

      expect(state.stage).toBe(OVERFLOW_RECOVERY_STAGES.STRICT);
      expect(state.lastSource).toBe(SESSION_RECOVERY);
    });

    it("reuses the current degraded stage when reactivated without escalation", () => {
      activateOverflowRecovery(SESSION_A, CONTEXT_BUDGET, OVERFLOW_RECOVERY_STAGES.STRICT);
      deactivateOverflowRecovery(SESSION_A);

      const state = activateOverflowRecovery(SESSION_A, OUTPUT_GOVERNOR);

      expect(state.active).toBe(true);
      expect(state.stage).toBe(OVERFLOW_RECOVERY_STAGES.STRICT);
      expect(state.overflowCount).toBe(2);
      expect(state.lastSource).toBe(OUTPUT_GOVERNOR);
    });
  });

  describe("escalateOverflowRecovery", () => {
    it("advances through stricter stages and caps at minimal mode", () => {
      const reduced = escalateOverflowRecovery(SESSION_A, CONTEXT_BUDGET);
      const strict = escalateOverflowRecovery(SESSION_A, CONTEXT_BUDGET);
      const minimal = escalateOverflowRecovery(SESSION_A, CONTEXT_BUDGET);
      const capped = escalateOverflowRecovery(SESSION_A, CONTEXT_BUDGET);

      expect(reduced.stage).toBe(OVERFLOW_RECOVERY_STAGES.REDUCED);
      expect(strict.stage).toBe(OVERFLOW_RECOVERY_STAGES.STRICT);
      expect(minimal.stage).toBe(OVERFLOW_RECOVERY_STAGES.MINIMAL);
      expect(capped.stage).toBe(OVERFLOW_RECOVERY_STAGES.MINIMAL);
      expect(capped.overflowCount).toBe(4);
    });
  });

  describe("deactivateOverflowRecovery", () => {
    it("disables degraded mode while preserving the last stage and metadata", () => {
      activateOverflowRecovery(SESSION_A, CONTEXT_BUDGET, OVERFLOW_RECOVERY_STAGES.STRICT);

      const state = deactivateOverflowRecovery(SESSION_A);

      expect(state.active).toBe(false);
      expect(state.stage).toBe(OVERFLOW_RECOVERY_STAGES.STRICT);
      expect(state.overflowCount).toBe(1);
      expect(state.lastSource).toBe(CONTEXT_BUDGET);
    });

    it("returns the default state for an unknown session", () => {
      expect(deactivateOverflowRecovery(SESSION_A)).toEqual(getOverflowRecoveryState(SESSION_A));
    });
  });

  describe("clearOverflowRecoverySession", () => {
    it("removes state for only the requested session", () => {
      activateOverflowRecovery(SESSION_A, CONTEXT_BUDGET);
      activateOverflowRecovery(SESSION_B, OUTPUT_GOVERNOR);

      clearOverflowRecoverySession(SESSION_A);

      expect(getOverflowRecoveryState(SESSION_A)).toEqual({
        active: false,
        stage: OVERFLOW_RECOVERY_STAGES.NORMAL,
        overflowCount: 0,
        lastSource: null,
        lastOverflowAt: null,
      });
      expect(isOverflowRecoveryActive(SESSION_B)).toBe(true);
    });
  });

  describe("resetOverflowRecoveryState", () => {
    it("clears every tracked session", () => {
      activateOverflowRecovery(SESSION_A, CONTEXT_BUDGET);
      activateOverflowRecovery(SESSION_B, OUTPUT_GOVERNOR);

      resetOverflowRecoveryState();

      expect(isOverflowRecoveryActive(SESSION_A)).toBe(false);
      expect(isOverflowRecoveryActive(SESSION_B)).toBe(false);
      expect(getOverflowRecoveryState(SESSION_B).overflowCount).toBe(0);
    });
  });
});
