export const OVERFLOW_RECOVERY_STAGES = {
  NORMAL: "normal",
  REDUCED: "reduced",
  STRICT: "strict",
  MINIMAL: "minimal",
} as const;

export const OVERFLOW_RECOVERY_SOURCES = {
  SESSION_RECOVERY: "session-recovery",
  CONTEXT_BUDGET: "context-budget",
  PROMPT_BUDGETING: "prompt-budgeting",
  OUTPUT_GOVERNOR: "output-governor",
} as const;

const STAGE_SEQUENCE = [
  OVERFLOW_RECOVERY_STAGES.NORMAL,
  OVERFLOW_RECOVERY_STAGES.REDUCED,
  OVERFLOW_RECOVERY_STAGES.STRICT,
  OVERFLOW_RECOVERY_STAGES.MINIMAL,
] as const;

export type OverflowRecoveryStage = (typeof STAGE_SEQUENCE)[number];
export type OverflowRecoverySource = (typeof OVERFLOW_RECOVERY_SOURCES)[keyof typeof OVERFLOW_RECOVERY_SOURCES];

export interface OverflowRecoveryState {
  readonly active: boolean;
  readonly stage: OverflowRecoveryStage;
  readonly overflowCount: number;
  readonly lastSource: OverflowRecoverySource | null;
  readonly lastOverflowAt: number | null;
}

const DEFAULT_OVERFLOW_RECOVERY_STATE: OverflowRecoveryState = {
  active: false,
  stage: OVERFLOW_RECOVERY_STAGES.NORMAL,
  overflowCount: 0,
  lastSource: null,
  lastOverflowAt: null,
};

const sessionOverflowRecovery = new Map<string, OverflowRecoveryState>();

function cloneOverflowRecoveryState(state: OverflowRecoveryState): OverflowRecoveryState {
  return { ...state };
}

function hasOverflowRecoveryState(sessionID: string): boolean {
  return sessionOverflowRecovery.has(sessionID);
}

function readOverflowRecoveryState(sessionID: string): OverflowRecoveryState {
  return sessionOverflowRecovery.get(sessionID) ?? DEFAULT_OVERFLOW_RECOVERY_STATE;
}

function saveOverflowRecoveryState(sessionID: string, state: OverflowRecoveryState): OverflowRecoveryState {
  const snapshot = cloneOverflowRecoveryState(state);
  sessionOverflowRecovery.set(sessionID, snapshot);
  return cloneOverflowRecoveryState(snapshot);
}

function resolveActivationStage(
  currentStage: OverflowRecoveryStage,
  requestedStage?: OverflowRecoveryStage,
): OverflowRecoveryStage {
  if (requestedStage) return requestedStage;
  if (currentStage === OVERFLOW_RECOVERY_STAGES.NORMAL) {
    return OVERFLOW_RECOVERY_STAGES.REDUCED;
  }
  return currentStage;
}

function getNextOverflowRecoveryStage(stage: OverflowRecoveryStage): OverflowRecoveryStage {
  const index = STAGE_SEQUENCE.indexOf(stage);
  if (index < 0 || index === STAGE_SEQUENCE.length - 1) {
    return OVERFLOW_RECOVERY_STAGES.MINIMAL;
  }
  return STAGE_SEQUENCE[index + 1] ?? OVERFLOW_RECOVERY_STAGES.MINIMAL;
}

function buildOverflowRecoveryState(
  current: OverflowRecoveryState,
  stage: OverflowRecoveryStage,
  source: OverflowRecoverySource,
): OverflowRecoveryState {
  return {
    active: true,
    stage,
    overflowCount: current.overflowCount + 1,
    lastSource: source,
    lastOverflowAt: Date.now(),
  };
}

export function getOverflowRecoveryState(sessionID: string): OverflowRecoveryState {
  return cloneOverflowRecoveryState(readOverflowRecoveryState(sessionID));
}

export function isOverflowRecoveryActive(sessionID: string): boolean {
  return readOverflowRecoveryState(sessionID).active;
}

export function activateOverflowRecovery(
  sessionID: string,
  source: OverflowRecoverySource,
  stage?: OverflowRecoveryStage,
): OverflowRecoveryState {
  const current = readOverflowRecoveryState(sessionID);
  const nextStage = resolveActivationStage(current.stage, stage);
  return saveOverflowRecoveryState(sessionID, buildOverflowRecoveryState(current, nextStage, source));
}

export function escalateOverflowRecovery(sessionID: string, source: OverflowRecoverySource): OverflowRecoveryState {
  const current = readOverflowRecoveryState(sessionID);
  const nextStage = getNextOverflowRecoveryStage(current.stage);
  return saveOverflowRecoveryState(sessionID, buildOverflowRecoveryState(current, nextStage, source));
}

export function deactivateOverflowRecovery(sessionID: string): OverflowRecoveryState {
  const current = readOverflowRecoveryState(sessionID);
  if (!hasOverflowRecoveryState(sessionID)) {
    return cloneOverflowRecoveryState(current);
  }

  return saveOverflowRecoveryState(sessionID, {
    ...current,
    active: false,
  });
}

export function clearOverflowRecoverySession(sessionID: string): void {
  sessionOverflowRecovery.delete(sessionID);
}

export function resetOverflowRecoveryState(): void {
  sessionOverflowRecovery.clear();
}
