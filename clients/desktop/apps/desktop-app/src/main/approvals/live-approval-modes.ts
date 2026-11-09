import type { ApprovalMode, ApprovalRule } from '@canopy/desktop-shared/types';
import {
  limitAllowRules,
  narrowSessionApprovalRules,
} from '@canopy/desktop-shared/lib/send-approval-narrowing';
import { advanceApprovalAuthorityRevision } from './rule-revisions';

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
  advanceApprovalAuthorityRevision();
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
  advanceApprovalAuthorityRevision();
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
  advanceApprovalAuthorityRevision();
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
    advanceApprovalAuthorityRevision();
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

/** What a chat's live provider session applies; each part undefined when unknown. */
export interface AppliedApproval {
  mode: ApprovalMode | undefined;
  rules: readonly ApprovalRule[] | undefined;
}

type AppliedApprovalReader = (
  projectId: string,
  worktreeId: string,
  chatId: string,
) => AppliedApproval | undefined;

let readAppliedApproval: AppliedApprovalReader = () => undefined;

/**
 * Sets where the caller bounds below read what a chat's live provider
 * session has applied. The session manager sets it as it loads; until then
 * no chat has a session.
 */
export function setAppliedApprovalReader(reader: AppliedApprovalReader): void {
  readAppliedApproval = reader;
}

/**
 * The loosest mode a calling chat's agent may act with now:
 * `boundingApprovalMode`, clamped to the mode the chat's live session has
 * applied when it reports one. The registry holds the chat's own mode, so an
 * admitted agent turn's cap does not outlast that turn, while the turn's
 * agent stays within the cap (CAN-4821).
 */
export function callerBoundingApprovalMode(
  projectId: string,
  worktreeId: string,
  chatId: string,
  mode: ApprovalMode,
): ApprovalMode {
  const bound = boundingApprovalMode(projectId, worktreeId, chatId, mode);
  const applied = readAppliedApproval(projectId, worktreeId, chatId)?.mode;
  return applied !== undefined && isApprovalModeDowngrade(bound, applied)
    ? applied
    : bound;
}

/**
 * A calling chat's session rules `rules`, narrowed to the rules its live
 * session applies when it reports them: only the allow rules both hold, and
 * the deny rules of either. Never wider than `rules` (CAN-4821).
 */
export function callerBoundingSessionApprovalRules(
  projectId: string,
  worktreeId: string,
  chatId: string,
  rules: readonly ApprovalRule[],
): readonly ApprovalRule[] {
  const applied = readAppliedApproval(projectId, worktreeId, chatId)?.rules;
  return applied
    ? narrowSessionApprovalRules(limitAllowRules(rules, applied), applied)
    : rules;
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
