import type {
  ChatJournalRecord,
  ChatStateLoadError,
  PersistedCommandReceipt,
} from '@canopy/desktop-shared/types';
import type { CanonicalChatState } from './chat-state-reducer';
import type { writeSyncedJsonTemp } from '../lib/chat-state-journal';
import type { LegacyChatRevisionGapRecovery } from '../lib/legacy-chat-migration';

export type ChatScopeLifecycle =
  | 'unloaded'
  | 'loading'
  | 'ready'
  | 'draining'
  | 'disposed'
  | 'recovery_error';

export interface ChatScopeKey {
  projectId: string;
  worktreeId: string;
}

export interface ChatStateCommit {
  projectId: string;
  worktreeId: string;
  baseRevision: number;
  revision: number;
  record: ChatJournalRecord;
  state: CanonicalChatState;
  /** True only when this call appended a new durable journal record. */
  applied: boolean;
}

export interface ChatMutationOptions {
  source: ChatJournalRecord['source'];
  mutationId?: string;
  commandResult?: Omit<PersistedCommandReceipt, 'revision'>;
  checkpoint?: boolean;
  expectedRevision?: number;
  /** Reserved for the semantic removal committed by deleteScope itself. */
  allowDuringScopeDeletion?: boolean;
  /** Explicit transcript selection used by the per-chat storage backend. */
  chatIds?: readonly string[];
  fullTranscript?: boolean;
  /** Async preparation performed after durable payload staging. */
  preparePublish?: () => Promise<void>;
  /** Synchronous guard immediately before durable publication starts. */
  beforePublish?: () => void;
}

export class ChatStateRevisionConflictError extends Error {
  public override readonly name = 'ChatStateRevisionConflictError';

  public constructor(
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super(
      `Expected revision ${expectedRevision}, current revision is ${actualRevision}`,
    );
  }
}

export interface ScopePaths {
  tabs: string;
  archives: string;
  journal: string;
}

export interface ChatStateRepositoryOptions {
  resolvePaths?: (scope: ChatScopeKey) => ScopePaths;
  now?: () => number;
  createId?: () => string;
  onCommit?: (commit: ChatStateCommit) => void | Promise<void>;
  hasLiveDependency?: (scope: ChatScopeKey) => boolean;
  /** Injectable checkpoint writer for deterministic cooperative-abort tests. */
  writeSyncedJsonTemp?: typeof writeSyncedJsonTemp;
  checkpointIdleMs?: number;
  checkpointBoundaryDelayMs?: number;
  maxCheckpointAborts?: number;
  maxCheckpointDeferralMs?: number;
  onStorageDiagnostic?: (diagnostic: ChatStateStorageDiagnostic) => void;
}

export interface ChatStateStorageDiagnostic {
  kind:
    | 'journal_loaded'
    | 'journal_growth'
    | 'transcript_bearing_mutation'
    | 'checkpoint_aborted'
    | 'checkpoint_starvation'
    | 'checkpoint_forced'
    | 'checkpoint_completed'
    | 'artifact_maintenance_failed'
    | 'transcript_preview_close_failed'
    | 'legacy_chat_revision_gap_recovered'
    /**
     * A delta-journal record this build does not know (written by a newer
     * build) stopped the load; the scope is in `recovery_error`.
     */
    | 'delta_journal_newer_format'
    /**
     * Unacknowledged bytes after a delta journal's last verified record were
     * excluded from replay (`recordBytes`), never treated as committed.
     */
    | 'delta_journal_torn_tail_dropped'
    /** The scope moved to the delta journal (storage manifest version 3). */
    | 'delta_journal_promoted'
    /** Promotion failed; the scope stays version 2; retried with backoff. */
    | 'delta_journal_promotion_failed'
    /** The scope returned to version 2 storage; its journal was removed. */
    | 'delta_journal_demoted'
    /**
     * Demotion failed; the scope stays version 3, readable and writable
     * through its journal, and a later sweep or load retries.
     */
    | 'delta_journal_demotion_failed';
  occurredAt: string;
  /** The rollback-safe initial release remains entirely v1-authoritative. */
  storageAuthority: 'v1' | 'v2';
  projectId: string;
  worktreeId: string;
  journalBytes: number;
  recordBytes?: number;
  recordCount?: number;
  maxRecordBytes?: number;
  meanRecordBytes?: number;
  checkpointDurationMs?: number;
  checkpointAbortCount?: number;
  maintenanceReason?:
    | 'io'
    | 'capacity'
    | 'pending_replay'
    | 'invalid_sidecar'
    | 'unknown';
  /**
   * `delta_journal_torn_tail_dropped` only: why the tail was not a frame
   * (`incomplete`: cut short; `checksum_mismatch`: complete but invalid).
   */
  journalTailReason?: 'incomplete' | 'checksum_mismatch';
  /**
   * `delta_journal_torn_tail_dropped` only: base name of the quarantine copy
   * in the scope directory, when the tail was kept for inspection.
   */
  journalQuarantineFile?: string;
  /** `legacy_chat_revision_gap_recovered` only; revisions, never content. */
  revisionGap?: LegacyChatRevisionGapRecovery;
}

export interface ChatStateTransactionContext {
  getPortalSendReceipt(
    userMessageId: string,
  ): PersistedCommandReceipt | undefined;
  hasRemovedTab(tabId: string): boolean;
  hasRemovedArchiveEntry(archiveEntryId: string): boolean;
  /** Omitting chatId retains the legacy scope-wide fence. */
  hasRemovedMessage(messageId: string, chatId?: string): boolean;
}

export class ChatStateRepositoryLoadError
  extends Error
  implements ChatStateLoadError
{
  public override readonly name = 'ChatStateLoadError';
  public readonly code = 'recovery_error' as const;
  public readonly retryable = false;
  public readonly cause?: unknown;

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options && 'cause' in options) {
      this.cause = options.cause;
    }
  }
}
