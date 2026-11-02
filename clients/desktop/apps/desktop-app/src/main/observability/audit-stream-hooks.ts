import type {
  AgentAuditEntry,
  AgentAuditEventType,
  AgentAuditStatus,
} from '@canopy/desktop-shared/types';

/*
 * The seam between the audit stream and its readers in main (the cost index).
 * Observability calls these; it never imports a reader. A reader registers
 * once at startup. Nothing here carries entry content: listeners get IDs and
 * status only.
 */

/** The file a reader consumed. `ino` is absent when the platform reports none. */
export interface AuditDayFileIdentity {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino?: number;
}

/** An inode of 0 is no identity: some filesystems report it for every file. */
export function sameAuditDayFileIdentity(
  left: AuditDayFileIdentity,
  right: AuditDayFileIdentity,
): boolean {
  if (left.size !== right.size || left.mtimeMs !== right.mtimeMs) return false;
  const leftIno = left.ino === 0 ? undefined : left.ino;
  const rightIno = right.ino === 0 ? undefined : right.ino;
  return (
    leftIno === undefined || rightIno === undefined || leftIno === rightIno
  );
}

/**
 * Asked before an audit day file is deleted by retention. The guard catches
 * its reader up on the file, then resolves with the identity of the file it
 * consumed completely, or null when it has not. Retention deletes the file
 * only while it still has that identity, so a line appended after the check
 * is kept. `dayFilename` is the file's name, such as `2026-10-08.jsonl`.
 *
 * A reader must register before observability initializes: its first prune
 * runs during initialization, and with no guard registered a due file is
 * deleted unread.
 */
export type AuditDayPruneGuard = (
  dayFilename: string,
) => Promise<AuditDayFileIdentity | null>;

/**
 * `verified` is the identity the reader consumed; the file may be deleted
 * only while it still matches. Without it the file is deleted as it is.
 */
export type AuditDayPruneDecision =
  | { readonly prune: false }
  | { readonly prune: true; readonly verified?: AuditDayFileIdentity };

let pruneGuard: AuditDayPruneGuard | null = null;

export function setAuditDayPruneGuard(guard: AuditDayPruneGuard | null): void {
  pruneGuard = guard;
}

/**
 * Whether retention may delete the day file now. The guard is always asked
 * first, so a reader gets its catch-up attempt however old the file is. A
 * file the guard refuses, or whose guard throws, is kept until it is
 * `retentionDays` past its own cutoff: a reader that never catches up cannot
 * keep audit data forever, and what it missed is lost with the file.
 */
export async function mayPruneAuditDayFile(options: {
  readonly dayFilename: string;
  /** Start of the day the file covers, in epoch milliseconds. */
  readonly fileDayTime: number;
  /** Files older than this are due for deletion. */
  readonly cutoffTime: number;
  readonly retentionDays: number;
}): Promise<AuditDayPruneDecision> {
  const guard = pruneGuard;
  if (guard === null) return { prune: true };
  let consumed: AuditDayFileIdentity | null = null;
  try {
    consumed = await guard(options.dayFilename);
  } catch {
    consumed = null;
  }
  if (consumed !== null) return { prune: true, verified: consumed };
  const graceMs = Math.max(1, options.retentionDays) * 24 * 60 * 60 * 1000;
  return options.fileDayTime < options.cutoffTime - graceMs
    ? { prune: true }
    : { prune: false };
}

/**
 * Why an entry that is still running was queued again. `subagent_ended`: one
 * of the turn's subagents finished, and the entry now carries its usage.
 */
export type AuditEntryEnqueueCause = 'subagent_ended';

/** What a listener learns about an audit entry that was just queued. */
export interface AuditEntryEnqueuedEvent {
  readonly eventType: AgentAuditEventType;
  readonly status: AgentAuditStatus;
  readonly projectId?: string;
  readonly worktreeId?: string;
  readonly chatId?: string;
  readonly pipelineExecutionId?: string;
  readonly cause?: AuditEntryEnqueueCause;
}

export type AuditEntryEnqueuedListener = (
  event: AuditEntryEnqueuedEvent,
) => void;

const enqueuedListeners = new Set<AuditEntryEnqueuedListener>();

/** Subscribes to queued audit entries. Returns the unsubscribe function. */
export function onAuditEntryEnqueued(
  listener: AuditEntryEnqueuedListener,
): () => void {
  enqueuedListeners.add(listener);
  return (): void => {
    enqueuedListeners.delete(listener);
  };
}

/** Called by observability for every entry it queues for the audit stream. */
export function notifyAuditEntryEnqueued(
  entry: AgentAuditEntry,
  cause?: AuditEntryEnqueueCause,
): void {
  if (enqueuedListeners.size === 0) return;
  const event: AuditEntryEnqueuedEvent = {
    eventType: entry.eventType,
    status: entry.status,
    ...(entry.projectId !== undefined ? { projectId: entry.projectId } : {}),
    ...(entry.worktreeId !== undefined ? { worktreeId: entry.worktreeId } : {}),
    ...(entry.chatId !== undefined ? { chatId: entry.chatId } : {}),
    ...(entry.pipelineExecutionId !== undefined
      ? { pipelineExecutionId: entry.pipelineExecutionId }
      : {}),
    ...(cause !== undefined ? { cause } : {}),
  };
  enqueuedListeners.forEach((listener): void => {
    try {
      listener(event);
    } catch {
      // A reader's failure must never affect audit recording.
    }
  });
}

/** Test-only: drop the guard and every listener. */
export function resetAuditStreamHooksForTest(): void {
  pruneGuard = null;
  enqueuedListeners.clear();
}
