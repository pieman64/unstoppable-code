import type { ApprovalMode } from '@canopy/desktop-shared/types';

const liveApprovalModeBySession = new Map<string, ApprovalMode>();
const approvalModeOperationsBySession = new Map<string, Promise<void>>();
const pendingApprovalModeBySession = new Map<
  string,
  { generation: number; mode: ApprovalMode }
>();
let pendingApprovalModeGeneration = 0;
const approvalModeRank: Readonly<Record<ApprovalMode, number>> = {
  ask: 0,
  auto: 1,
  'full-access': 2,
};

function approvalModeKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return `${projectId}:${worktreeId}:${chatId}`;
}

export function getLiveApprovalMode(
  projectId: string,
  worktreeId: string,
  chatId: string,
): ApprovalMode | undefined {
  return liveApprovalModeBySession.get(
    approvalModeKey(projectId, worktreeId, chatId),
  );
}

export function setLiveApprovalMode(
  projectId: string,
  worktreeId: string,
  chatId: string,
  mode: ApprovalMode,
): void {
  liveApprovalModeBySession.set(
    approvalModeKey(projectId, worktreeId, chatId),
    mode,
  );
}

export function clearLiveApprovalMode(
  projectId: string,
  worktreeId: string,
  chatId: string,
): void {
  liveApprovalModeBySession.delete(
    approvalModeKey(projectId, worktreeId, chatId),
  );
  pendingApprovalModeBySession.delete(
    approvalModeKey(projectId, worktreeId, chatId),
  );
}

export function getPendingApprovalMode(
  projectId: string,
  worktreeId: string,
  chatId: string,
): ApprovalMode | undefined {
  return pendingApprovalModeBySession.get(
    approvalModeKey(projectId, worktreeId, chatId),
  )?.mode;
}

export function beginApprovalModeTransition(
  projectId: string,
  worktreeId: string,
  chatId: string,
  mode: ApprovalMode,
): number {
  const generation = ++pendingApprovalModeGeneration;
  pendingApprovalModeBySession.set(
    approvalModeKey(projectId, worktreeId, chatId),
    { generation, mode },
  );
  return generation;
}

export function isApprovalModeTransitionCurrent(
  projectId: string,
  worktreeId: string,
  chatId: string,
  generation: number,
): boolean {
  return (
    pendingApprovalModeBySession.get(
      approvalModeKey(projectId, worktreeId, chatId),
    )?.generation === generation
  );
}

export function endApprovalModeTransition(
  projectId: string,
  worktreeId: string,
  chatId: string,
  generation: number,
): void {
  const key = approvalModeKey(projectId, worktreeId, chatId);
  if (pendingApprovalModeBySession.get(key)?.generation === generation) {
    pendingApprovalModeBySession.delete(key);
  }
}

/**
 * Linearizes approval-mode transitions with operations that copy a chat's
 * authority into another scope. A caller may hold the slot across an atomic
 * copy when the trusted approval mode must land in the same durable commit as
 * the destination chat.
 */
export async function withApprovalModeOperation<T>(
  projectId: string,
  worktreeId: string,
  chatId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = approvalModeKey(projectId, worktreeId, chatId);
  const previousOperation =
    approvalModeOperationsBySession.get(key) ?? Promise.resolve();
  let releaseCurrentOperation: (() => void) | undefined;
  const currentOperation = new Promise<void>((resolve) => {
    releaseCurrentOperation = resolve;
  });
  approvalModeOperationsBySession.set(key, currentOperation);

  await previousOperation;
  try {
    return await operation();
  } finally {
    releaseCurrentOperation?.();
    if (approvalModeOperationsBySession.get(key) === currentOperation) {
      approvalModeOperationsBySession.delete(key);
    }
  }
}

export function clampToLiveApprovalMode(
  projectId: string,
  worktreeId: string,
  chatId: string,
  requestedMode: ApprovalMode | undefined,
): ApprovalMode | undefined {
  const liveMode = getLiveApprovalMode(projectId, worktreeId, chatId);
  if (liveMode === undefined) {
    return requestedMode;
  }
  if (requestedMode === undefined) {
    return liveMode;
  }
  return approvalModeRank[liveMode] <= approvalModeRank[requestedMode]
    ? liveMode
    : requestedMode;
}

/**
 * The loosest mode a chat may grant now: `mode`, clamped to its live mode
 * and to a pending switch, whichever is stricter. A restrictive switch
 * updates both before it awaits anything, so a synchronous check against
 * this sees a switch whose persisted write has not landed yet.
 */
export function boundingApprovalMode(
  projectId: string,
  worktreeId: string,
  chatId: string,
  mode: ApprovalMode,
): ApprovalMode {
  const bound =
    clampToLiveApprovalMode(projectId, worktreeId, chatId, mode) ?? mode;
  const pending = getPendingApprovalMode(projectId, worktreeId, chatId);
  return pending !== undefined && isApprovalModeDowngrade(bound, pending)
    ? pending
    : bound;
}

/**
 * The loosest mode a chat's turns may run with once its pending switch
 * lands: the looser of `mode` and that switch.
 */
export function reachableApprovalMode(
  projectId: string,
  worktreeId: string,
  chatId: string,
  mode: ApprovalMode,
): ApprovalMode {
  const pending = getPendingApprovalMode(projectId, worktreeId, chatId);
  return pending !== undefined && isApprovalModeDowngrade(pending, mode)
    ? pending
    : mode;
}

export function isApprovalModeDowngrade(
  previousMode: ApprovalMode,
  nextMode: ApprovalMode,
): boolean {
  return approvalModeRank[nextMode] < approvalModeRank[previousMode];
}
