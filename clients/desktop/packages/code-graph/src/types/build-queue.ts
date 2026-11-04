/** Scope of a code-graph generation queue entry. */
export type CodeGraphQueueScope = 'worktree' | 'workspace-shadow';

/** Lifecycle status of a queue entry surfaced to the UI. */
export type CodeGraphQueueEntryStatus = 'queued' | 'running';

/**
 * One entry in the Code Graph generation queue. The build scheduler is the
 * source of truth and produces this shape; the frontend consumes it verbatim
 * and never re-derives state from internal keys or paths.
 */
export interface CodeGraphQueueEntry {
  /** Stable opaque entry ID (NOT an internal runner key or path). */
  id: string;
  scope: CodeGraphQueueScope;
  /**
   * Owning workspace IDs. A shared shadow/base entry lists ALL workspace IDs
   * currently requiring it, and must not expose canonical repo or shadow paths.
   */
  workspaceIds: string[];
  /** Safe owning-workspace display label. Present for worktree scope. */
  workspaceLabel?: string;
  /** Present for worktree scope. */
  worktreeId?: string;
  repositoryId?: string;
  /** Safe display label (no filesystem/shadow paths). */
  label?: string;
  /** Why the build was requested. */
  trigger: string;
  /** Epoch ms when the entry was enqueued. */
  queuedAt: number;
  /** Epoch ms once running, else null. */
  startedAt: number | null;
  status: CodeGraphQueueEntryStatus;
  /** False for running entries. */
  reorderable: boolean;
}

/**
 * Authoritative snapshot of the Code Graph generation queue.
 *
 * Entries are returned in actual dispatch order — running entries listed
 * first, each with `reorderable === false`. `revision` increases
 * monotonically and changes on every snapshot mutation (enqueue, start,
 * completion, failure, cancellation, owner-set change, reorder); the renderer
 * uses it for optimistic reorder. When the feature flag is off, reads return
 * an empty/disabled snapshot (exact policy in the backend plan); the shape is
 * unchanged.
 */
export interface CodeGraphGenerationQueueSnapshot {
  revision: number;
  entries: CodeGraphQueueEntry[];
}

/**
 * Reorder request for the Code Graph generation queue.
 *
 * `orderedQueuedEntryIds` must be exactly the set of currently-queued entry
 * IDs (no running IDs, no additions, no removals), in the desired order. On
 * success the response is the authoritative post-reorder
 * {@link CodeGraphGenerationQueueSnapshot}; on a revision conflict the
 * response is a `conflict` error paired with the current authoritative
 * snapshot.
 */
export interface CodeGraphReorderGenerationQueueRequest {
  /** The last snapshot revision the renderer observed. */
  revision: number;
  /** Complete, ordered list of CURRENTLY-QUEUED entry IDs. */
  orderedQueuedEntryIds: string[];
}

/** A refused queue change; a `conflict` carries the current snapshot. */
export interface CodeGraphBuildQueueError {
  ok: false;
  code: 'invalid-request' | 'conflict';
  /** Safe, human-readable; never a raw filesystem/shadow path. */
  message: string;
  snapshot?: CodeGraphGenerationQueueSnapshot;
}
