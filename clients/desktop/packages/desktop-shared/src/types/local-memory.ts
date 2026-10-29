export interface MemorySource {
  provider: string;
  chatId: string;
  sessionId?: string;
}

export interface SearchHit {
  fileKey: string;
  scope: 'user' | 'workspace';
  snippet: string;
  heading?: string;
}

export type LocalMemoryScopeRequest =
  | { scope: 'user' }
  | { scope: 'workspace'; workspaceId: string };

export interface LocalMemoryFileSummary {
  fileKey: string;
  kind: 'index' | 'topic' | 'inbox';
  modifiedAt: string;
  sizeBytes: number;
  /** First-line ATX level-1 heading text, when the file starts with one. */
  title?: string;
}

export interface LocalMemoryItem {
  id: string;
  kind: 'heading' | 'list-item' | 'paragraph' | 'code' | 'block';
  text: string;
  level?: number;
  children: LocalMemoryItem[];
}

export interface LocalMemoryDocument {
  fileKey: string;
  revision: string;
  items: LocalMemoryItem[];
}

export type LocalMemoryReadRequest = LocalMemoryScopeRequest & {
  fileKey: string;
};
export type LocalMemoryDeleteRequest = LocalMemoryReadRequest & {
  itemId: string;
  revision: string;
};
export type LocalMemoryUpdateRequest = LocalMemoryDeleteRequest & {
  text: string;
};

export type LocalMemoryConsolidationResult =
  | 'success'
  | 'skipped'
  | 'failed'
  | 'cancelled';

export interface LocalMemoryConsolidationStatus {
  /** Top-level `inbox/*.md` notes not yet folded into the index. */
  pendingNotes: number;
  running: boolean;
  /** True while a rebuild owns the scope; `running` is true as well. */
  rebuilding: boolean;
  /** When the last consolidation run of any outcome finished. */
  lastRunAt: string | null;
  lastResult: LocalMemoryConsolidationResult | null;
  /** Skip/failure reason, or the user-facing message for a blocked model. */
  lastReason: string | null;
  /** When the last successful consolidation rewrote the index. */
  lastConsolidatedAt: string | null;
}

export interface LocalMemoryRebuildResult {
  /**
   * `completed`: nothing is left pending. `stopped`: a consolidation run did
   * not succeed or stopped making progress, so pending sources remain queued.
   * `failed`: the rebuild could not prepare the scope. `skipped`: nothing ran.
   */
  status: 'completed' | 'stopped' | 'failed' | 'skipped';
  reason?: string;
  /** Snapshot taken before the rebuild changed anything, when one was taken. */
  snapshotId: string | null;
  restoredInboxNotes: number;
  restoredImports: number;
  /** Consolidation runs the rebuild performed. */
  runs: number;
}

export interface LocalMemoryRebuildResponse {
  rebuild: LocalMemoryRebuildResult;
  status: LocalMemoryConsolidationStatus;
}

export type LocalMemorySnapshotReason = 'consolidation' | 'rebuild' | 'restore';

export interface LocalMemorySnapshotSummary {
  id: string;
  createdAt: string;
  reason: LocalMemorySnapshotReason;
  /** Topic files captured alongside the index. */
  topicCount: number;
}

export type LocalMemorySnapshotRestoreRequest = LocalMemoryScopeRequest & {
  snapshotId: string;
};

export interface LocalMemorySnapshotRestoreResponse {
  status: 'restored' | 'skipped';
  reason?: string;
  /** Snapshot of the state the restore replaced, when one was taken. */
  previousSnapshotId: string | null;
}

/**
 * Stored verbatim as `lastReason` when consolidation refuses an
 * organization-blocked model; the explorer shows it unchanged.
 */
export const LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE =
  'Memory consolidation was skipped: this model is blocked by your organization policy.';

/**
 * Stored verbatim as `lastReason` (and returned as a rebuild reason) when a
 * memory run refuses the memory model the user chose because this install
 * cannot run it right now. Memory is never sent to another model instead.
 */
export const LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE =
  "Memory consolidation was skipped: your memory model isn't available. Choose another memory model in settings, or try again once it's available.";

/** Reasons that are complete sentences, shown without a prefix. */
export const LOCAL_MEMORY_FULL_SENTENCE_REASONS: ReadonlySet<string> = new Set([
  LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
  LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
]);
