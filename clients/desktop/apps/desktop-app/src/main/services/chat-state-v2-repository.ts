import { isMcpActivationMessage } from './mcp-activation-message';
import type { AgentDelegationTranscriptItem } from '@canopy/protocol/delegation';
import type {
  DelegationRun,
  DelegationRunItems,
} from '../lib/chat-delegation-log';
import type {
  TranscriptDescriptor,
  TranscriptViewRequest,
} from '@canopy/agent-transcript/transcript-storage';
import type { CapturedTranscriptPreview } from '../lib/chat-transcript-log';
import type { ChatRecoveryIndex } from '../lib/chat-storage-v2';
import type {
  ChatToolOutputResponse,
  ChatVisualReadResponse,
} from '@canopy/desktop-shared/types';
import type {
  ChatStorageImportOptions,
  TranscriptConsumeOptions,
} from './chat-state-v2-backend';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ChatCoreMutation,
  ChatJournalRecord,
  ChatTabsFile,
  PersistedChatMessage,
  PersistedChatTab,
  PersistedCommandReceipt,
} from '@canopy/desktop-shared/types';
import type {
  PersistedToolOutputReference,
  PersistedVisualReference,
} from '@canopy/agent-transcript/types';
import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { getDataDir } from '../lib/paths';
import { isErrnoException } from '../lib/type-guards';
import { VisualStagingStoreImpl } from '../lib/visual-staging';
import { ChatVisualStagingSweep } from '../lib/chat-visual-staging-sweep';
import {
  chatVisualStagingPublicationGeneration,
  chatVisualStagingScopesMarkerExists,
  removeChatVisualStagingScopesMarker,
  withChatVisualStagingScopesMarker,
} from '../lib/visual-staging-scopes-marker';
import type {
  PromotedVisual,
  ProviderVisualAdmission,
  StageVisualDocument,
  VisualStagingSidecar,
  VisualStagingStore,
  VisualStagingTarget,
  VisualToolIdentityResolver,
} from '../lib/chat-visual-contracts';
import { type DeltaJournalDiagnostic } from '../lib/chat-delta-journal/writer';
import {
  deltaJournalBackendOptions,
  deltaJournalLifecycleDiagnostic,
  deltaJournalWriterDiagnostic,
} from '../lib/chat-delta-journal/repository-support';
import type { ActiveTurnDelta } from '../lib/chat-delta-journal/active-turn';
import { registerChatStorageScope } from '@canopy/desktop-shared/node/chat-storage-activity';
import { ArtifactMaintenanceCapacityError } from '../lib/chat-artifact-maintenance';
import {
  migrateLegacyChatScope,
  type LegacyChatScopePaths,
} from '../lib/legacy-chat-migration';
import {
  resolveChatTabsFilePath,
  resolveChatArchivesFilePath,
  resolveChatJournalFilePath,
} from '../lib/resolve-worktree';
import {
  fsyncDirectory,
  type ChatJournalDiagnostic,
} from '../lib/chat-state-journal';
import type { CanonicalChatState } from './chat-state-reducer';
import { markChatApprovalStateChanged } from '../approvals/rule-revisions';
import {
  ChatStateV2Backend,
  type ChatReadSelection,
  type V2MutationOptions,
} from './chat-state-v2-backend';
import { ChatStorageNewerFormatError } from '../lib/chat-delta-journal/format';
import {
  summarizeDeltaJournal,
  type DeltaJournalSummary,
} from '../lib/chat-delta-journal/reader';
import {
  ChatStateRepositoryLoadError,
  ChatStateRevisionConflictError,
  type ChatStateRepositoryOptions,
  type ChatScopeKey,
  type ChatScopeLifecycle,
  type ChatStateCommit,
  type ChatStateStorageDiagnostic,
  type ChatStateTransactionContext,
} from './chat-state-contracts';

/** Options of one repository transaction. */
export type ChatStateTransactionOptions = V2MutationOptions & {
  /**
   * Called synchronously once the transaction holds its place in the scope's
   * commit order (its turn of the scope lease is queued). A producer that
   * must keep its own order may submit its next transaction from then on,
   * without waiting for this one to be durable.
   */
  onQueued?: () => void;
};

export interface ChatStateV2RepositoryOptions extends Omit<
  ChatStateRepositoryOptions,
  'hasLiveDependency'
> {
  hasLiveDependency?: (scope: ChatScopeKey) => boolean | Promise<boolean>;
  /** Delta-journal idle checkpoint delay (P1 §A: about one second). */
  deltaJournalIdleCheckpointMs?: number;
  /** Delta-journal size checkpoint threshold; defaults to 4 MiB. */
  deltaJournalCheckpointBytes?: number;
  /** Records estimated above this take the version 2 path (tests). */
  deltaJournalLargeRecordBytes?: number;
  /** First retry delay of a failed promotion (doubles); default 30 s. */
  deltaJournalPromotionRetryMs?: number;
  /** Retries of a failed promotion; default 5. */
  deltaJournalPromotionRetryLimit?: number;
}

/**
 * Node file-system errors carry a string errno `code`; storage integrity and
 * migration failures do not. Only the former can clear without intervention.
 */
function isOperatingSystemFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) return true;
    current = Reflect.get(current, 'cause');
  }
  return false;
}

function aggregateFailure(errors: unknown[], message: string): Error {
  return Object.assign(new Error(message), { name: 'AggregateError', errors });
}

function errorFromUnknown(value: unknown): Error {
  return value instanceof Error
    ? value
    : Object.assign(new Error(String(value)), { cause: value });
}

interface ScopeEntry {
  scope: ChatScopeKey;
  store: ChatStorageV2;
  paths: LegacyChatScopePaths;
  backend: ChatStateV2Backend;
  visualStaging?: VisualStagingStore;
  lifecycle: ChatScopeLifecycle;
  loading?: Promise<void>;
  /** A cached non-transient recovery failure; only releaseScope retries it. */
  loadError?: ChatStateRepositoryLoadError;
  deleting: number;
  /** A lease covers admission through completion, including reads/exports. */
  tail: Promise<unknown>;
  /** Observers see applied commits strictly in revision order per scope. */
  publishTail: Promise<void>;
  previewReaders: Set<CapturedTranscriptPreview>;
  previewCloseFailure?: boolean;
  maintenanceChats: Set<string>;
  maintenanceDeferred: Set<string>;
  maintenanceCapacityChats: Set<string>;
  maintenanceImmediate?: ReturnType<typeof setImmediate>;
  maintenanceCapacityWake?: () => void;
  maintenanceFailure?: string;
  maintenanceFailedChatId?: string;
  /** The delta journal's idle checkpoint (P1 §A). */
  journalIdleTimer?: ReturnType<typeof setTimeout>;
  journalCheckpointQueued?: boolean;
  formatReconcileQueued?: boolean;
}

function hasVisualOwner(
  recovery: ChatRecoveryIndex,
  chatId: string,
  visualId: string,
): boolean {
  // The ledger is read from disk; a malformed entry is not an owner.
  const owners: unknown = recovery.visualOwnersByChatId?.[chatId];
  return (
    typeof owners === 'object' &&
    owners !== null &&
    Object.prototype.hasOwnProperty.call(owners, visualId)
  );
}

async function childDirectories(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return [];
    throw error;
  }
}

function stateHasChat(state: CanonicalChatState, chatId: string): boolean {
  return (
    state.tabsFile.tabs.some((tab) => tab.id === chatId) ||
    state.archivesFile.archived.some((entry) => entry.tab.id === chatId)
  );
}

function removedVisualChats(
  mutations: readonly ChatCoreMutation[],
  state: CanonicalChatState,
): string[] {
  const candidates = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.type === 'tab.removed') candidates.add(mutation.tabId);
    else if (mutation.type === 'archive.removed') {
      candidates.add(mutation.chatId);
      candidates.add(mutation.archiveEntryId);
    }
  }
  return Array.from(candidates).filter(
    (chatId) => !stateHasChat(state, chatId),
  );
}

/** A value as JSON with object keys sorted, so key order never matters. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : nested,
  );
}

function approvalStateOf(tab: PersistedChatTab | undefined): string {
  return canonicalJson([
    tab?.approvalMode ?? null,
    tab?.sessionApprovalRules ?? [],
    tab?.selectedRepoId ?? null,
  ]);
}

const APPROVAL_STATE_PATCH_KEYS = [
  'approvalMode',
  'sessionApprovalRules',
  'selectedRepoId',
] as const;

/** Marks each chat whose approval state these mutations change. */
function noteApprovalStateChanges(
  scope: ChatScopeKey,
  current: CanonicalChatState,
  mutations: readonly ChatCoreMutation[],
): void {
  const tabOf = (chatId: string): PersistedChatTab | undefined =>
    current.tabsFile.tabs.find((tab) => tab.id === chatId) ??
    current.archivesFile.archived.find((entry) => entry.tab.id === chatId)?.tab;
  const mark = (chatId: string): void =>
    markChatApprovalStateChanged({ ...scope, chatId });
  for (const mutation of mutations) {
    if (mutation.type === 'tab.created') {
      if (
        approvalStateOf(tabOf(mutation.tab.id)) !==
        approvalStateOf(mutation.tab)
      )
        mark(mutation.tab.id);
    } else if (mutation.type === 'tab.metadata_patched') {
      const tab = tabOf(mutation.tabId);
      if (
        APPROVAL_STATE_PATCH_KEYS.some(
          (key) =>
            key in mutation.patch &&
            canonicalJson(mutation.patch[key] ?? null) !==
              canonicalJson(tab?.[key] ?? null),
        )
      )
        mark(mutation.tabId);
    } else if (mutation.type === 'tab.removed') {
      mark(mutation.tabId);
    } else if (mutation.type === 'archive.upserted') {
      mark(mutation.entry.tab.id);
    }
  }
}

function markImportedApprovalState(
  scope: ChatScopeKey,
  metadata: Pick<CanonicalChatState, 'tabsFile' | 'archivesFile'>,
): void {
  for (const tab of [
    ...metadata.tabsFile.tabs,
    ...metadata.archivesFile.archived.map((entry) => entry.tab),
  ])
    markChatApprovalStateChanged({ ...scope, chatId: tab.id });
}

/** V2-only scope ownership. Legacy access is confined to first-load migration;
 * no method writes an aggregate snapshot or transcript-bearing scope journal.
 */
/** How a transcript preview was streamed to its consumer. */
export interface TranscriptPreviewRead {
  /**
   * False when only the active sidecar rows were streamed because the
   * consumer already holds a projection of this exact committed prefix.
   */
  committedIncluded: boolean;
  /**
   * The active rows came from a delta journal's in-memory projection: the
   * chat's later updates can be read as deltas (`activeTurnDelta`).
   */
  journalProjected?: boolean;
}

export interface TranscriptPreviewOptions {
  /**
   * Receives the captured descriptor. Returning true streams only the active
   * sidecar rows; the committed prefix is identified, not re-read.
   */
  reuseCommittedPrefix?: (descriptor: TranscriptDescriptor) => boolean;
}

export class ChatStateV2Repository {
  private readonly scopes = new Map<string, ScopeEntry>();
  private accepting = true;
  private readonly diagnosticListeners = new Set<
    (diagnostic: ChatStateStorageDiagnostic) => void
  >();
  private readonly diagnostics = new Map<
    string,
    ChatStateStorageDiagnostic[]
  >();
  private onCommit?: ChatStateRepositoryOptions['onCommit'];
  /** Visual staging sweeps of unloaded scopes; a load of the same directory waits. */
  private readonly sweepLocks = new Map<string, Promise<void>>();
  /** Visual staging sweeps in flight; a drain stops them and waits for them. */
  private readonly sweeps = new Set<Promise<void>>();
  private readonly visualStagingSweep: ChatVisualStagingSweep;
  private visualStagingSweepStarted = false;
  public constructor(
    private readonly options: ChatStateV2RepositoryOptions = {},
  ) {
    this.onCommit = options.onCommit;
    this.visualStagingSweep = new ChatVisualStagingSweep(() =>
      this.runVisualStagingSweep(),
    );
    if (options.onStorageDiagnostic)
      this.diagnosticListeners.add(options.onStorageDiagnostic);
  }

  /**
   * Shared-container viewer scopes are read-only projections of a replica
   * and never promote; every other repository scope (worktrees, cowork Work
   * Entries, App Advisor, Code Review, Pipeline Editor, plan-explore, and
   * legacy scopes once migrated) does.
   */
  private promotable(scope: ChatScopeKey): boolean {
    return scope.projectId !== SHARED_CONTAINER_VIEWER_PROJECT_ID;
  }

  private recordDeltaJournalLifecycle(
    entry: ScopeEntry | undefined,
    scope: ChatScopeKey,
    kind: ChatStateStorageDiagnostic['kind'],
  ): void {
    const diagnostic = deltaJournalLifecycleDiagnostic(scope, kind);
    if (entry) this.recordStorageDiagnostic(entry, diagnostic);
    else
      for (const listener of Array.from(this.diagnosticListeners))
        try {
          listener(diagnostic);
        } catch {
          // Diagnostics never change the storage outcome.
        }
  }

  private recordDeltaJournalDiagnostic(
    directory: string,
    diagnostic: DeltaJournalDiagnostic,
    fallbackScope?: ChatScopeKey,
  ): void {
    const entry = this.scopes.get(directory);
    const scope = entry?.scope ?? fallbackScope;
    if (!scope) return;
    const record = deltaJournalWriterDiagnostic(scope, diagnostic);
    if (entry) this.recordStorageDiagnostic(entry, record);
    else
      for (const listener of Array.from(this.diagnosticListeners))
        try {
          listener(record);
        } catch {
          // Diagnostics never change the storage outcome.
        }
  }

  private recordVisualOwnerLedgerInvalid(
    directory: string,
    scope: ChatScopeKey,
    reason: string,
  ): void {
    const diagnostic: ChatStateStorageDiagnostic = {
      kind: 'artifact_maintenance_failed',
      occurredAt: new Date().toISOString(),
      storageAuthority: 'v2',
      ...scope,
      journalBytes: 0,
      maintenanceReason: reason === 'io' ? 'io' : 'unknown',
    };
    const entry = this.scopes.get(directory);
    if (entry) {
      this.recordStorageDiagnostic(entry, diagnostic);
      return;
    }
    for (const listener of Array.from(this.diagnosticListeners))
      try {
        listener(diagnostic);
      } catch {
        // Invalid recovery metadata must not change repository admission.
      }
  }

  private async tryPromote(entry: ScopeEntry): Promise<void> {
    if (!this.promotable(entry.scope)) return;
    try {
      if (await entry.backend.promoteToDeltaJournal())
        this.recordDeltaJournalLifecycle(
          entry,
          entry.scope,
          'delta_journal_promoted',
        );
    } catch {
      // The scope stays version 2 (a leftover journal is ignored and later
      // removed); the backend retries at a later idle point, bounded.
      this.recordDeltaJournalLifecycle(
        entry,
        entry.scope,
        'delta_journal_promotion_failed',
      );
    }
  }

  /** Promote a writable scope between operations, under its scope lease. */
  private async reconcileFormat(entry: ScopeEntry): Promise<void> {
    entry.formatReconcileQueued = false;
    if (entry.lifecycle !== 'ready' || entry.deleting || !this.accepting)
      return;
    if (!entry.backend.isDeltaJournal()) await this.tryPromote(entry);
    this.scheduleJournalWork(entry);
  }

  private queueFormatReconcile(entry: ScopeEntry): void {
    if (entry.formatReconcileQueued) return;
    entry.formatReconcileQueued = true;
    void this.serialized(entry, () => this.reconcileFormat(entry)).catch(() => {
      entry.formatReconcileQueued = false;
    });
  }

  private clearJournalIdleTimer(entry: ScopeEntry): void {
    if (entry.journalIdleTimer) clearTimeout(entry.journalIdleTimer);
    entry.journalIdleTimer = undefined;
  }

  /** Queue a checkpoint of pending journal records under the scope lease. */
  private queueJournalCheckpoint(entry: ScopeEntry): void {
    this.clearJournalIdleTimer(entry);
    if (entry.journalCheckpointQueued) return;
    entry.journalCheckpointQueued = true;
    void this.serialized(entry, async () => {
      entry.journalCheckpointQueued = false;
      if (entry.lifecycle !== 'ready' || entry.deleting || !this.accepting)
        return;
      if (await entry.backend.checkpointPendingJournal('timer'))
        await this.requestArtifactMaintenance(entry);
    }).catch(() => {
      // A failed checkpoint leaves the records journaled; the next commit
      // re-arms the triggers and a reload recovers the writer.
      entry.journalCheckpointQueued = false;
    });
  }

  /**
   * After a commit: the size trigger checkpoints right away, otherwise the
   * idle trigger is (re)armed; a scope demoted for one large transaction,
   * or whose failed promotion's retry is due, is offered promotion again.
   */
  private scheduleJournalWork(entry: ScopeEntry): void {
    if (!this.accepting || entry.lifecycle !== 'ready' || entry.deleting) {
      this.clearJournalIdleTimer(entry);
      return;
    }
    if (entry.backend.wantsRepromotion()) this.queueFormatReconcile(entry);
    if (entry.backend.pendingJournalRecords() === 0) {
      this.clearJournalIdleTimer(entry);
      return;
    }
    if (entry.backend.journalCheckpointDue()) {
      this.queueJournalCheckpoint(entry);
      return;
    }
    this.clearJournalIdleTimer(entry);
    if (!entry.backend.journalIdleCheckpointWanted()) return;
    entry.journalIdleTimer = setTimeout(() => {
      entry.journalIdleTimer = undefined;
      this.queueJournalCheckpoint(entry);
    }, this.options.deltaJournalIdleCheckpointMs ?? 1000);
    entry.journalIdleTimer.unref?.();
  }

  private async runVisualStagingSweep(): Promise<void> {
    if (!this.accepting) return;
    const sweep = this.sweepVisualStagingScopes();
    this.sweeps.add(sweep);
    try {
      await sweep;
    } finally {
      this.sweeps.delete(sweep);
    }
  }

  private async sweepVisualStagingScopes(): Promise<void> {
    const dataDir = getDataDir();
    if (!(await chatVisualStagingScopesMarkerExists(dataDir))) return;
    if (!this.accepting) return;
    const generation = chatVisualStagingPublicationGeneration();
    let roots: string[];
    try {
      roots = [
        dataDir,
        ...(await childDirectories(join(dataDir, 'workspaces'))),
        ...(await childDirectories(join(dataDir, 'app-workspaces'))),
      ];
    } catch {
      return;
    }
    let clean = true;
    for (const root of roots) {
      if (!this.accepting) return;
      let scopeDirectories: string[];
      try {
        scopeDirectories = await childDirectories(
          join(root, 'chat-storage-v2'),
        );
      } catch {
        clean = false;
        continue;
      }
      for (const directory of scopeDirectories) {
        if (!this.accepting) return;
        try {
          const result = await this.sweepVisualStagingDirectory(directory);
          if (result.remaining > 0) clean = false;
        } catch {
          clean = false;
        }
      }
    }
    if (clean && this.accepting)
      await removeChatVisualStagingScopesMarker(generation, dataDir).catch(
        () => false,
      );
  }

  private async sweepVisualStagingDirectory(
    scopeDirectory: string,
  ): Promise<{ removed: number; remaining: number }> {
    const loaded = this.scopes.get(scopeDirectory);
    if (loaded && ['ready', 'loading', 'draining'].includes(loaded.lifecycle)) {
      return this.serialized(loaded, async () => {
        if (
          this.scopes.get(scopeDirectory) !== loaded ||
          loaded.lifecycle === 'disposed'
        )
          return this.sweepLockedVisualStagingDirectory(scopeDirectory);
        if (loaded.lifecycle === 'ready') {
          if (!loaded.visualStaging)
            throw new Error('Visual staging is not initialized');
          return loaded.visualStaging.sweep(this.visualNow());
        }
        if (
          ['unloaded', 'recovery_error', 'disposed'].includes(loaded.lifecycle)
        )
          return this.sweepLockedVisualStagingDirectory(scopeDirectory);
        return this.sweepUnloadedVisualStaging(scopeDirectory);
      });
    }
    return this.sweepLockedVisualStagingDirectory(scopeDirectory);
  }

  private async sweepLockedVisualStagingDirectory(
    scopeDirectory: string,
  ): Promise<{ removed: number; remaining: number }> {
    const run = (this.sweepLocks.get(scopeDirectory) ?? Promise.resolve())
      .catch(() => undefined)
      .then(
        (): Promise<{ removed: number; remaining: number }> =>
          this.sweepUnloadedVisualStaging(scopeDirectory),
      );
    const lock = run.then(() => undefined);
    this.sweepLocks.set(scopeDirectory, lock);
    try {
      return await run;
    } finally {
      if (this.sweepLocks.get(scopeDirectory) === lock)
        this.sweepLocks.delete(scopeDirectory);
    }
  }

  private async sweepUnloadedVisualStaging(
    scopeDirectory: string,
  ): Promise<{ removed: number; remaining: number }> {
    const staging = new VisualStagingStoreImpl(
      join(scopeDirectory, 'visual-staging'),
      { now: (): number => this.visualNow() },
    );
    const now = this.visualNow();
    return staging.sweep(now);
  }

  private resolve(scope: ChatScopeKey): LegacyChatScopePaths {
    return (
      this.options.resolvePaths?.(scope) ?? {
        tabs: resolveChatTabsFilePath(scope.projectId, scope.worktreeId),
        archives: resolveChatArchivesFilePath(
          scope.projectId,
          scope.worktreeId,
        ),
        journal: resolveChatJournalFilePath(scope.projectId, scope.worktreeId),
      }
    );
  }
  private entry(scope: ChatScopeKey, readmit = true): ScopeEntry {
    const paths = this.resolve(scope);
    const store = ChatStorageV2.fromLegacyPaths(paths);
    let entry = this.scopes.get(store.directory);
    // A completed deletion leaves a disposed entry so continuations that
    // still hold it drain. Once no deletion is in flight, the same scope id
    // (a recreated worktree or Work Entry) admits again as a fresh scope.
    if (readmit && entry?.lifecycle === 'disposed' && !entry.deleting)
      entry = undefined;
    if (!entry) {
      if (!this.accepting) throw new Error('Chat state repository is draining');
      entry = {
        scope,
        store,
        paths,
        backend: new ChatStateV2Backend(store, {
          deltaJournal: {
            ...deltaJournalBackendOptions(this.options, (diagnostic): void =>
              this.recordDeltaJournalDiagnostic(store.directory, diagnostic),
            ),
            onCheckpointed: (rotation): void => {
              // A Work Entry summary is fingerprinted by its journal's
              // modification time, which a checkpoint changes.
              void import('../lib/cowork-work-entries')
                .then(({ refreshWorkEntrySummaryStamp }) =>
                  refreshWorkEntrySummaryStamp(
                    scope.projectId,
                    scope.worktreeId,
                    rotation,
                  ),
                )
                .catch(() => undefined);
            },
          },
          onVisualOwnerLedgerInvalid: ({ reason }): void =>
            this.recordVisualOwnerLedgerInvalid(store.directory, scope, reason),
        }),
        lifecycle: 'unloaded',
        deleting: 0,
        tail: Promise.resolve(),
        publishTail: Promise.resolve(),
        previewReaders: new Set(),
        maintenanceChats: new Set(),
        maintenanceDeferred: new Set(),
        maintenanceCapacityChats: new Set(),
      };
      this.scopes.set(store.directory, entry);
      // Lets the local chat-storage activity summaries name their scope.
      registerChatStorageScope(store.directory, scope);
    }
    return entry;
  }
  /**
   * One turn of the scope lease. Commits admitted for group commit
   * ({@link admission}) may still be waiting for their journal sync: the
   * backend's state is then ahead of the journal, so the operation starts
   * only once they are durable (or their batch failed and the scope will
   * reload). Reads, captures, copies, imports, checkpoints, promotion,
   * demotion, eviction, deletion and drain therefore never run beside an
   * open batch. With nothing pending the operation starts as before.
   */
  private async serialized<T>(
    entry: ScopeEntry,
    operation: () => Promise<T>,
  ): Promise<T> {
    const next = entry.tail
      .catch(() => undefined)
      .then(() => {
        const pending = entry.backend.pendingJournalDurability();
        return pending ? pending.then(operation, operation) : operation();
      });
    entry.tail = next;
    return next;
  }

  /**
   * A turn of the scope lease for a commit that may be group committed: it
   * does not wait for the journal sync of the commits admitted before it,
   * so it is prepared against their state and can share their next sync.
   * The lease still orders admissions one at a time.
   */
  private async admission<T>(
    entry: ScopeEntry,
    operation: () => Promise<T>,
  ): Promise<T> {
    const next = entry.tail.catch(() => undefined).then(operation);
    entry.tail = next;
    return next;
  }

  private async closePreviewReaders(entry: ScopeEntry): Promise<void> {
    const readers = Array.from(entry.previewReaders);
    const outcomes = await Promise.allSettled(
      readers.map((reader) => reader.close()),
    );
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled')
        entry.previewReaders.delete(readers[index]);
    });
    const failures = outcomes
      .filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === 'rejected',
      )
      .map((outcome): unknown => outcome.reason);
    if (failures.length) {
      this.recordPreviewCloseFailure(entry);
      throw aggregateFailure(failures, 'Transcript preview close failed');
    }
    entry.previewCloseFailure = false;
  }

  private recordPreviewCloseFailure(entry: ScopeEntry): void {
    if (entry.previewCloseFailure) return;
    entry.previewCloseFailure = true;
    const diagnostic: ChatStateStorageDiagnostic = {
      kind: 'transcript_preview_close_failed',
      occurredAt: new Date().toISOString(),
      storageAuthority: 'v2',
      ...entry.scope,
      journalBytes: 0,
    };
    const retained = this.diagnostics.get(entry.store.directory) ?? [];
    this.diagnostics.set(
      entry.store.directory,
      [...retained, diagnostic].slice(-64),
    );
    for (const listener of Array.from(this.diagnosticListeners))
      try {
        listener(diagnostic);
      } catch {
        // Operational diagnostics cannot alter canonical storage work.
      }
  }

  private recordArtifactMaintenanceFailure(
    entry: ScopeEntry,
    chatId: string,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    const reason: NonNullable<ChatStateStorageDiagnostic['maintenanceReason']> =
      error instanceof ArtifactMaintenanceCapacityError
        ? 'capacity'
        : isOperatingSystemFailure(error)
          ? 'io'
          : message.includes('replay is pending')
            ? 'pending_replay'
            : message.includes('sidecar') || message.includes('transcript')
              ? 'invalid_sidecar'
              : 'unknown';
    const changed =
      entry.maintenanceFailedChatId !== chatId ||
      entry.maintenanceFailure !== message;
    entry.maintenanceFailedChatId = chatId;
    entry.maintenanceFailure = message;
    if (!changed) return;
    const diagnostic: ChatStateStorageDiagnostic = {
      kind: 'artifact_maintenance_failed',
      occurredAt: new Date().toISOString(),
      storageAuthority: 'v2',
      ...entry.scope,
      journalBytes: 0,
      maintenanceReason: reason,
    };
    const retained = this.diagnostics.get(entry.store.directory) ?? [];
    this.diagnostics.set(
      entry.store.directory,
      [...retained, diagnostic].slice(-64),
    );
    for (const listener of Array.from(this.diagnosticListeners))
      try {
        listener(diagnostic);
      } catch {
        // Operational diagnostics cannot alter canonical storage work.
      }
  }

  private cancelArtifactMaintenance(entry: ScopeEntry): void {
    if (entry.maintenanceImmediate) clearImmediate(entry.maintenanceImmediate);
    entry.maintenanceImmediate = undefined;
    entry.maintenanceCapacityWake?.();
    entry.maintenanceCapacityWake = undefined;
  }

  private armArtifactMaintenanceCapacity(entry: ScopeEntry): void {
    if (
      entry.maintenanceCapacityWake ||
      !entry.maintenanceCapacityChats.size ||
      !this.accepting ||
      entry.lifecycle !== 'ready' ||
      entry.deleting
    )
      return;
    entry.maintenanceCapacityWake =
      entry.backend.onArtifactMaintenanceCapacityAvailable(() => {
        entry.maintenanceCapacityWake?.();
        entry.maintenanceCapacityWake = undefined;
        if (!this.accepting || entry.lifecycle !== 'ready') return;
        for (const chatId of Array.from(entry.maintenanceCapacityChats)) {
          entry.maintenanceDeferred.delete(chatId);
          entry.maintenanceChats.add(chatId);
        }
        entry.maintenanceCapacityChats.clear();
        this.armArtifactMaintenance(entry);
      });
  }

  private async runArtifactMaintenanceChunk(entry: ScopeEntry): Promise<void> {
    if (entry.lifecycle !== 'ready' || entry.deleting) return;
    const chatId = entry.maintenanceChats.values().next().value;
    if (chatId === undefined) return;
    if (!entry.backend.artifactMaintenanceEligible(chatId)) {
      entry.maintenanceChats.delete(chatId);
      try {
        await entry.backend.abandonArtifactMaintenance(chatId);
      } catch (error) {
        this.recordArtifactMaintenanceFailure(entry, chatId, error);
      }
      return;
    }
    let progress: Awaited<ReturnType<ChatStateV2Backend['maintainArtifacts']>>;
    try {
      progress = await entry.backend.maintainArtifacts(chatId, 64 * 1024);
    } catch (error) {
      entry.maintenanceChats.delete(chatId);
      entry.maintenanceDeferred.add(chatId);
      if (!(error instanceof ArtifactMaintenanceCapacityError))
        this.recordArtifactMaintenanceFailure(entry, chatId, error);
      // Every scope shares the maintenance slots, so waiting for one is
      // backpressure, not a failure: it is retried when a slot frees and
      // never reported as `artifact_maintenance_failed`.
      else if (this.accepting && entry.lifecycle === 'ready') {
        entry.maintenanceCapacityChats.add(chatId);
        this.armArtifactMaintenanceCapacity(entry);
      }
      throw error;
    }
    if (progress.complete) entry.maintenanceChats.delete(chatId);
    if (entry.maintenanceFailedChatId === chatId) {
      entry.maintenanceFailedChatId = undefined;
      entry.maintenanceFailure = undefined;
    }
  }

  private armArtifactMaintenance(entry: ScopeEntry): void {
    if (
      entry.maintenanceImmediate ||
      !this.accepting ||
      entry.lifecycle !== 'ready' ||
      entry.deleting ||
      !entry.maintenanceChats.size
    )
      return;
    entry.maintenanceImmediate = setImmediate(() => {
      entry.maintenanceImmediate = undefined;
      if (!this.accepting) return;
      void this.serialized(entry, () => this.runArtifactMaintenanceChunk(entry))
        .then(() => this.armArtifactMaintenance(entry))
        .catch(() => {
          // Keep candidates for a later eligible trigger; never spin on EIO.
          this.armArtifactMaintenance(entry);
        });
    });
  }

  private async requestArtifactMaintenance(
    entry: ScopeEntry,
    hints?: readonly string[],
  ): Promise<void> {
    if (!this.accepting || entry.lifecycle !== 'ready' || entry.deleting)
      return;
    try {
      const tracked = hints
        ? new Set(hints)
        : new Set([
            ...Array.from(entry.maintenanceChats),
            ...Array.from(entry.maintenanceDeferred),
            ...Array.from(entry.maintenanceCapacityChats),
            ...(entry.maintenanceFailedChatId
              ? [entry.maintenanceFailedChatId]
              : []),
          ]);
      for (const chatId of Array.from(tracked)) {
        if (
          !entry.maintenanceChats.has(chatId) &&
          !entry.maintenanceDeferred.has(chatId) &&
          !entry.maintenanceCapacityChats.has(chatId) &&
          entry.maintenanceFailedChatId !== chatId
        )
          continue;
        if (!entry.backend.artifactMaintenanceChatRetired(chatId)) continue;
        entry.maintenanceChats.delete(chatId);
        entry.maintenanceDeferred.delete(chatId);
        entry.maintenanceCapacityChats.delete(chatId);
        if (entry.maintenanceFailedChatId === chatId) {
          entry.maintenanceFailedChatId = undefined;
          entry.maintenanceFailure = undefined;
        }
        try {
          await entry.backend.abandonArtifactMaintenance(chatId);
        } catch (error) {
          this.recordArtifactMaintenanceFailure(entry, chatId, error);
        }
      }
      for (const chatId of await entry.backend.pendingArtifactMaintenanceChats(
        hints,
      )) {
        entry.maintenanceDeferred.delete(chatId);
        entry.maintenanceCapacityChats.delete(chatId);
        entry.maintenanceChats.add(chatId);
      }
      if (!entry.maintenanceCapacityChats.size) {
        entry.maintenanceCapacityWake?.();
        entry.maintenanceCapacityWake = undefined;
      }
      this.armArtifactMaintenance(entry);
    } catch (error) {
      this.recordArtifactMaintenanceFailure(entry, '', error);
    }
  }
  private async load(scope: ChatScopeKey, entry: ScopeEntry): Promise<void> {
    if (entry.lifecycle === 'disposed' || entry.lifecycle === 'draining')
      throw new Error('Chat scope is draining');
    if (entry.lifecycle === 'ready') return;
    // A failed recovery is sticky: re-running migration on every access would
    // repeat the same expensive, failing work. releaseScope is the retry.
    if (entry.loadError) throw entry.loadError;
    if (!entry.loading) {
      entry.lifecycle = 'loading';
      entry.loading = (async (): Promise<void> => {
        let transient = false;
        try {
          // A visual staging sweep of this directory finishes first.
          await this.sweepLocks
            .get(entry.store.directory)
            ?.catch(() => undefined);
          if (
            (await entry.store.authority()) === 'v1' &&
            (await this.options.hasLiveDependency?.(scope))
          ) {
            transient = true;
            throw new Error(
              'Chat migration is waiting for active turns to settle',
            );
          }
          const migration =
            (await entry.store.format()) === 'v3'
              ? undefined
              : await migrateLegacyChatScope(entry.store, entry.paths);
          if (migration?.revisionGapRecovery)
            this.recordStorageDiagnostic(entry, {
              kind: 'legacy_chat_revision_gap_recovered',
              occurredAt: new Date().toISOString(),
              storageAuthority: 'v2',
              ...scope,
              journalBytes: 0,
              revisionGap: migration.revisionGapRecovery,
            });
          const indexes = await entry.backend.load();
          const visualStaging = new VisualStagingStoreImpl(
            join(entry.store.directory, 'visual-staging'),
            { now: (): number => this.visualNow() },
          );
          await visualStaging.initialize(this.visualNow());
          entry.visualStaging = visualStaging;
          // Defer the local recovery module to break the chat-state/delegation cycle.
          // Verified in build:mac: Vite folds this local import into the packaged main bundle.
          const {
            hasDelegationRecoveryRecords,
            loadDelegationRecoveryMutations,
          } = await import('../agents/delegation/recovery');
          if (await hasDelegationRecoveryRecords(scope)) {
            const chatIds = [
              ...indexes.live.tabs.map((tab) => tab.id),
              ...indexes.archive.archived.map((archive) => archive.tab.id),
            ];
            const state = await entry.backend.state({
              chatIds,
              fullTranscript: true,
            });
            const mutations = await loadDelegationRecoveryMutations(
              scope,
              state.tabsFile,
              state.archivesFile,
            );
            if (mutations.length > 0) {
              const digest = createHash('sha256')
                .update(JSON.stringify(mutations))
                .digest('hex');
              await entry.backend.transact(() => mutations, {
                source: 'provider',
                chatIds,
                fullTranscript: true,
                mutationId: `delegation-recovery:${digest}`,
              });
            }
          }
          entry.lifecycle = 'ready';
          // Always promote writable scopes after any pending
          // version 2 transaction and the recovery above.
          if (this.promotable(scope) && !entry.backend.isDeltaJournal())
            await this.tryPromote(entry);
          await this.requestArtifactMaintenance(entry);
          this.scheduleJournalWork(entry);
        } catch (cause) {
          entry.visualStaging = undefined;
          entry.lifecycle = 'recovery_error';
          if (cause instanceof ChatStorageNewerFormatError)
            await this.recordNewerFormat(entry, scope);
          const error = new ChatStateRepositoryLoadError(
            `Unable to load chat scope ${scope.projectId}/${scope.worktreeId}: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          );
          // Waiting on a live host settles on its own, and an operating-system
          // I/O failure (EIO, EBUSY, EMFILE, ...) may clear; the next access
          // retries those. Integrity failures stay sticky until releaseScope.
          if (!transient && !isOperatingSystemFailure(cause))
            entry.loadError = error;
          throw error;
        } finally {
          entry.loading = undefined;
        }
      })();
    }
    try {
      await entry.loading;
    } finally {
      this.startVisualStagingSweep();
    }
  }

  private visualNow(): number {
    return this.options.now?.() ?? Date.now();
  }

  private startVisualStagingSweep(): void {
    if (this.visualStagingSweepStarted || !this.accepting) return;
    this.visualStagingSweepStarted = true;
    this.visualStagingSweep.start();
  }
  /** Ordered post-commit publication. Observers and projections cannot roll
   * back durable state, so a failing listener never rejects an applied commit.
   */
  private publish(entry: ScopeEntry, commit: ChatStateCommit): Promise<void> {
    const publication = entry.publishTail.then(async (): Promise<void> => {
      try {
        await this.onCommit?.(commit);
      } catch {
        // Post-commit observers cannot reject a durable commit.
      }
    });
    entry.publishTail = publication;
    return publication;
  }

  /**
   * Reserve a commit's place in the publication order while its lease turn
   * still runs, so the order is the revision order by construction even
   * when commits become durable together (group commit). The commit is
   * published once `durable` resolves; a commit whose batch failed was never
   * made durable and is not published. Used for delta-journal scopes; a
   * version 2 scope publishes after its lease turn, as before.
   */
  private reservePublication(
    entry: ScopeEntry,
    commit: ChatStateCommit,
    durable: Promise<void> | undefined,
    diagnostic?: ChatStateStorageDiagnostic,
  ): Promise<void> {
    const publication = entry.publishTail.then(async (): Promise<void> => {
      if (durable)
        try {
          await durable;
        } catch {
          return;
        }
      try {
        if (diagnostic) this.recordStorageDiagnostic(entry, diagnostic);
        await this.onCommit?.(commit);
      } catch {
        // Post-commit observers cannot reject a durable commit.
      }
    });
    entry.publishTail = publication;
    return publication;
  }
  private assertWritable(
    entry: ScopeEntry,
    allowDuringScopeDeletion = false,
  ): void {
    if (
      !this.accepting ||
      entry.lifecycle === 'draining' ||
      entry.lifecycle === 'disposed'
    )
      throw new Error('Chat state repository is draining');
    if (entry.deleting && !allowDuringScopeDeletion)
      throw new Error('Chat scope is being deleted');
  }

  public setCommitListener(
    listener: NonNullable<ChatStateRepositoryOptions['onCommit']>,
  ): void {
    this.onCommit = listener;
  }
  public async getState(
    scope: ChatScopeKey,
    selection: ChatReadSelection = {},
  ): Promise<CanonicalChatState> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.state(selection);
    });
  }
  public async getRevision(scope: ChatScopeKey): Promise<number> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.revision();
    });
  }
  public async assertExpectedRevision(
    scope: ChatScopeKey,
    expected: number | undefined,
  ): Promise<number> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      this.assertWritable(entry);
      await this.load(scope, entry);
      const actual = (await entry.backend.load()).live.revision;
      if (expected !== undefined && expected !== actual)
        throw new ChatStateRevisionConflictError(expected, actual);
      return actual;
    });
  }
  private async recovery(scope: ChatScopeKey): Promise<ChatRecoveryIndex> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return (await entry.backend.load()).recovery;
    });
  }
  public async getReceipt(
    scope: ChatScopeKey,
    commandId: string,
  ): Promise<PersistedCommandReceipt | undefined> {
    return (await this.recovery(scope)).receipts.find(
      (receipt) => receipt.commandId === commandId,
    );
  }
  public async getPortalSendReceipt(
    scope: ChatScopeKey,
    userMessageId: string,
  ): Promise<PersistedCommandReceipt | undefined> {
    return (await this.recovery(scope)).receipts.find(
      (receipt) => receipt.portalSend?.userMessageId === userMessageId,
    );
  }
  public async hasMutation(
    scope: ChatScopeKey,
    mutationId: string,
  ): Promise<boolean> {
    return (await this.recovery(scope)).mutationIds.includes(mutationId);
  }
  public async hasRemovedTab(
    scope: ChatScopeKey,
    tabId: string,
  ): Promise<boolean> {
    return (await this.recovery(scope)).removedTabIds.includes(tabId);
  }
  public async hasRemovedMessage(
    scope: ChatScopeKey,
    messageId: string,
  ): Promise<boolean> {
    return (await this.recovery(scope)).removedMessageIds.includes(messageId);
  }

  public async transact(
    scope: ChatScopeKey,
    mutations: readonly ChatCoreMutation[],
    options: V2MutationOptions,
  ): Promise<ChatStateCommit> {
    return this.transactWith(scope, () => [...mutations], options);
  }

  public async stageVisual(
    scope: ChatScopeKey,
    target: VisualStagingTarget,
    document: StageVisualDocument,
  ): Promise<VisualStagingSidecar> {
    const entry = this.entry(scope);
    this.assertWritable(entry);
    return this.serialized(entry, async () => {
      this.assertWritable(entry);
      await this.load(scope, entry);
      const staging = entry.visualStaging;
      if (!staging) throw new Error('Visual staging is not initialized');
      const indexes = await entry.backend.load();
      const chatExists =
        indexes.live.tabs.some((tab) => tab.id === target.chatId) ||
        indexes.archive.archived.some(
          (archive) => archive.tab.id === target.chatId,
        );
      if (!chatExists) throw new Error('Unknown chat');
      if (hasVisualOwner(indexes.recovery, target.chatId, document.visualId))
        throw new Error('Visual id is already owned by a transcript block');
      return withChatVisualStagingScopesMarker(
        () => staging.stage(target, document, this.visualNow()),
        getDataDir(),
      );
    });
  }

  public async transactWith(
    scope: ChatScopeKey,
    build: (
      current: CanonicalChatState,
      revision: number,
      context: ChatStateTransactionContext,
    ) => ChatCoreMutation[] | Promise<ChatCoreMutation[]>,
    options: ChatStateTransactionOptions,
  ): Promise<ChatStateCommit> {
    return this.transactInternal(scope, build, options);
  }

  public async transactProviderEventWith(
    scope: ChatScopeKey,
    build: (
      current: CanonicalChatState,
      revision: number,
      context: ChatStateTransactionContext,
    ) => ChatCoreMutation[] | Promise<ChatCoreMutation[]>,
    options: ChatStateTransactionOptions,
    admission: { resolveToolKey: VisualToolIdentityResolver },
  ): Promise<ChatStateCommit> {
    return this.transactInternal(scope, build, options, admission);
  }

  private async transactInternal(
    scope: ChatScopeKey,
    build: (
      current: CanonicalChatState,
      revision: number,
      context: ChatStateTransactionContext,
    ) => ChatCoreMutation[] | Promise<ChatCoreMutation[]>,
    options: ChatStateTransactionOptions,
    visualAdmission?: { resolveToolKey: VisualToolIdentityResolver },
  ): Promise<ChatStateCommit> {
    const { onQueued, ...mutationOptions } = options;
    const entry = this.entry(scope);
    this.assertWritable(entry, options.allowDuringScopeDeletion);
    const tracked: typeof build = (current, revision, context) => {
      const built = build(current, revision, context);
      if (Array.isArray(built)) {
        noteApprovalStateChanges(scope, current, built);
        return built;
      }
      return built.then((mutations) => {
        noteApprovalStateChanges(scope, current, mutations);
        return mutations;
      });
    };
    const turn = async (): Promise<{
      commit: ChatStateCommit;
      durable?: Promise<void>;
      published?: Promise<void>;
      promotedVisuals?: PromotedVisual[];
      deletedChatIds: string[];
    }> => {
      this.assertWritable(entry, options.allowDuringScopeDeletion);
      await this.load(scope, entry);
      const indexes = await entry.backend.load();
      if (
        options.expectedRevision !== undefined &&
        options.expectedRevision !== indexes.live.revision &&
        !indexes.recovery.mutationIds.includes(options.mutationId ?? '')
      )
        throw new ChatStateRevisionConflictError(
          options.expectedRevision,
          indexes.live.revision,
        );
      const journaled = entry.backend.isDeltaJournal();
      const staging = entry.visualStaging;
      if (visualAdmission && !staging)
        throw new Error('Visual staging is not initialized');
      const providerAdmission: ProviderVisualAdmission | undefined =
        visualAdmission && staging
          ? {
              staging,
              resolveToolKey: visualAdmission.resolveToolKey,
              now: () => this.visualNow(),
            }
          : undefined;
      const { commit: result, durable } = await entry.backend.admit(
        tracked,
        {
          ...mutationOptions,
          mutationId:
            options.mutationId ?? this.options.createId?.() ?? randomUUID(),
        },
        providerAdmission,
      );
      if (result.applied) {
        const affected: string[] = [];
        for (const mutation of result.record.mutations) {
          if ('chatId' in mutation) affected.push(mutation.chatId);
          else if (mutation.type === 'tab.created')
            affected.push(mutation.tab.id);
          else if (mutation.type === 'tab.removed')
            affected.push(mutation.tabId);
          else if (mutation.type === 'archive.upserted')
            affected.push(mutation.entry.tab.id);
        }
        if (affected.length)
          await this.requestArtifactMaintenance(entry, affected);
      }
      const commit = { ...result, ...scope };
      const deletedChatIds = result.applied
        ? removedVisualChats(result.record.mutations, result.state)
        : [];
      if (!durable && !journaled)
        return {
          commit,
          deletedChatIds,
          ...(result.promotedVisuals
            ? { promotedVisuals: result.promotedVisuals }
            : {}),
        };
      return {
        commit,
        deletedChatIds,
        ...(result.promotedVisuals
          ? { promotedVisuals: result.promotedVisuals }
          : {}),
        ...(durable ? { durable } : {}),
        ...(commit.applied
          ? {
              published: this.reservePublication(
                entry,
                commit,
                durable,
                this.commitDiagnostic(scope, commit),
              ),
            }
          : {}),
      };
    };
    // A commit whose publish hooks must run at the exact write boundary is
    // written alone, after every commit admitted before it is durable.
    const admitted =
      options.beforePublish || options.preparePublish
        ? this.serialized(entry, turn)
        : this.admission(entry, turn);
    // Its turn of the lease is queued: a caller may now submit the commit
    // that follows it in the caller's own order.
    onQueued?.();
    const { commit, durable, published, promotedVisuals, deletedChatIds } =
      await admitted;
    this.scheduleJournalWork(entry);
    let publication = published;
    if (commit.applied && !durable && !publication) {
      this.recordStorageDiagnostic(entry, this.commitDiagnostic(scope, commit));
      publication = this.publish(entry, commit);
    }
    if (publication && (promotedVisuals?.length || deletedChatIds.length))
      this.scheduleVisualStagingCleanup(
        entry,
        publication,
        durable,
        promotedVisuals ?? [],
        deletedChatIds,
      );
    // Group commit: acknowledged only once the commit's batch is durable.
    if (durable) await durable;
    if (publication) await publication;
    return commit;
  }

  private scheduleVisualStagingCleanup(
    entry: ScopeEntry,
    publication: Promise<void>,
    durable: Promise<void> | undefined,
    promotedVisuals: readonly PromotedVisual[],
    deletedChatIds: readonly string[],
  ): void {
    const cleanup = (): void => {
      void this.serialized(entry, () =>
        this.cleanupVisualStaging(entry, promotedVisuals, deletedChatIds),
      ).catch((error: unknown) =>
        this.recordVisualStagingFailure(entry, error),
      );
    };
    const publicationFailed = (error: unknown): void =>
      this.recordVisualStagingFailure(entry, error);
    if (durable) {
      void durable.then(
        () => void publication.then(cleanup, publicationFailed),
        () => undefined,
      );
      return;
    }
    void publication.then(cleanup, publicationFailed);
  }

  private async cleanupVisualStaging(
    entry: ScopeEntry,
    promotedVisuals: readonly PromotedVisual[],
    deletedChatIds: readonly string[],
  ): Promise<void> {
    if (
      entry.lifecycle !== 'ready' ||
      this.scopes.get(entry.store.directory) !== entry
    )
      return;
    const staging = entry.visualStaging;
    if (!staging) return;
    const removedVisuals = await Promise.allSettled(
      promotedVisuals.map((visual) => staging.remove(visual.visualId)),
    );
    removedVisuals.forEach((outcome) => {
      if (outcome.status === 'rejected')
        this.recordVisualStagingFailure(entry, outcome.reason);
    });
    const removedChats = await Promise.allSettled(
      deletedChatIds.map((chatId) => staging.removeChat(chatId)),
    );
    removedChats.forEach((outcome) => {
      if (outcome.status === 'rejected')
        this.recordVisualStagingFailure(entry, outcome.reason);
    });
  }

  private recordVisualStagingFailure(entry: ScopeEntry, error: unknown): void {
    this.recordStorageDiagnostic(entry, {
      kind: 'artifact_maintenance_failed',
      occurredAt: new Date().toISOString(),
      storageAuthority: 'v2',
      ...entry.scope,
      journalBytes: 0,
      maintenanceReason: isOperatingSystemFailure(error) ? 'io' : 'unknown',
    });
  }

  private commitDiagnostic(
    scope: ChatScopeKey,
    commit: ChatStateCommit,
  ): ChatStateStorageDiagnostic {
    return {
      kind: 'checkpoint_completed',
      occurredAt: commit.record.occurredAt,
      storageAuthority: 'v2',
      ...scope,
      journalBytes: 0,
      recordCount: 1,
    };
  }
  /**
   * A delta-journal scope this build reads but never writes: record the
   * refusal, and any unacknowledged journal tail replay excludes, as
   * content-free session diagnostics. Diagnostics never change the load.
   */
  private async recordNewerFormat(
    entry: ScopeEntry,
    scope: ChatScopeKey,
  ): Promise<void> {
    const occurredAt = new Date().toISOString();
    let summary: DeltaJournalSummary | undefined;
    try {
      summary = await summarizeDeltaJournal({
        directory: entry.store.directory,
        scopeId: entry.store.descriptor().scopeId,
      });
    } catch {
      // An unreadable journal is still a refused newer format.
    }
    this.recordStorageDiagnostic(entry, {
      kind: 'delta_journal_newer_format',
      occurredAt,
      storageAuthority: 'v2',
      ...scope,
      journalBytes: summary?.journalBytes ?? 0,
      ...(summary ? { recordCount: summary.recordCount } : {}),
    });
    if (summary?.tornTail)
      this.recordStorageDiagnostic(entry, {
        kind: 'delta_journal_torn_tail_dropped',
        occurredAt,
        storageAuthority: 'v2',
        ...scope,
        journalBytes: summary.validEnd,
        recordBytes: summary.tornTail.bytes,
        recordCount: summary.recordCount,
        journalTailReason: summary.tornTail.reason,
      });
  }

  private recordStorageDiagnostic(
    entry: ScopeEntry,
    diagnostic: ChatStateStorageDiagnostic,
  ): void {
    const retained = this.diagnostics.get(entry.store.directory) ?? [];
    this.diagnostics.set(
      entry.store.directory,
      [...retained, diagnostic].slice(-64),
    );
    for (const listener of Array.from(this.diagnosticListeners)) {
      try {
        listener(diagnostic);
      } catch {
        /* Diagnostics must not change commit acknowledgement or load. */
      }
    }
  }

  public async page(
    scope: ChatScopeKey,
    chatId: string,
    before?: number,
    expectedRevision?: number,
    options: TranscriptViewRequest = {},
  ): Promise<TranscriptPage> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.page(chatId, before, expectedRevision, options);
    });
  }
  /**
   * A chat's state and the end of its transcript, read under one scope lease
   * so that no commit lands between the two: `fromState` derives what the
   * read needs from the state, then transcript pages are read back from the
   * end until `reachedStart` accepts a page, or to the transcript's start.
   * Both callbacks run under the lease and must not call the repository.
   */
  public async readTranscriptTail<T>(
    scope: ChatScopeKey,
    chatId: string,
    selection: ChatReadSelection,
    reader: {
      fromState: (state: CanonicalChatState) => T;
      reachedStart: (
        value: T,
        page: readonly PersistedChatMessage[],
      ) => boolean;
    },
  ): Promise<{ value: T; messages: PersistedChatMessage[] }> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      const value = reader.fromState(await entry.backend.state(selection));
      let messages: PersistedChatMessage[] = [];
      let before: number | undefined;
      let transcriptRevision: number | undefined;
      do {
        const page = await entry.backend.page(
          chatId,
          before,
          transcriptRevision,
        );
        messages = [...page.messages, ...messages];
        if (reader.reachedStart(value, page.messages)) break;
        before = page.before;
        transcriptRevision = page.transcriptRevision;
      } while (before !== undefined);
      return { value, messages };
    });
  }
  public async hasMessage(
    scope: ChatScopeKey,
    chatId: string,
    messageId: string,
  ): Promise<boolean> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.hasMessage(chatId, messageId);
    });
  }
  /**
   * See {@link ChatStateV2Backend.appendDelegationItems}. Only the check that
   * the chat still exists takes the scope lease; the log writes and syncs run
   * after it, so they never hold chat commits back.
   */
  public async appendDelegationItems(
    scope: ChatScopeKey,
    chatId: string,
    runs: readonly DelegationRunItems[],
  ): Promise<boolean> {
    const entry = this.entry(scope);
    const listed = await this.serialized(entry, async () => {
      this.assertWritable(entry);
      await this.load(scope, entry);
      return entry.backend.listsDelegationChat(chatId);
    });
    if (!listed) return false;
    await entry.backend.appendDelegationLog(chatId, runs);
    return true;
  }
  public async readDelegationItems(
    scope: ChatScopeKey,
    chatId: string,
    run: DelegationRun,
  ): Promise<AgentDelegationTranscriptItem[]> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.readDelegationItems(chatId, run);
    });
  }
  public async toolOutput(
    scope: ChatScopeKey,
    chatId: string,
    messageId: string,
    toolUseId: string,
    reference: PersistedToolOutputReference,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<ChatToolOutputResponse> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.toolOutput(
        chatId,
        messageId,
        toolUseId,
        reference,
        offset,
        length,
        signal,
      );
    });
  }
  public async visual(
    scope: ChatScopeKey,
    chatId: string,
    messageId: string,
    toolUseId: string,
    reference: PersistedVisualReference,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ChatVisualReadResponse> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.visual(
        chatId,
        messageId,
        toolUseId,
        reference,
        offset,
        limit,
        signal,
      );
    });
  }
  /** The scope lease ends after the immutable handles are registered. Search
   * builds preview text outside it; deletion cancels handles without awaiting
   * a consumer callback that may itself be awaiting deletion.
   */
  public async consumeTranscriptPreview<T>(
    scope: ChatScopeKey,
    chatId: string,
    consume: (
      messages: AsyncIterable<PersistedChatMessage>,
      descriptor: TranscriptDescriptor,
      read: TranscriptPreviewRead,
    ) => Promise<T>,
    isCurrent?: () => boolean,
    options: TranscriptPreviewOptions = {},
  ): Promise<T> {
    const assertCurrent = (): void => {
      if (isCurrent && !isCurrent())
        throw new Error('Transcript preview was superseded');
    };
    assertCurrent();
    const entry = this.entry(scope, false);
    const captured = await this.serialized(entry, async () => {
      assertCurrent();
      if (
        !this.accepting ||
        entry.deleting ||
        entry.lifecycle === 'draining' ||
        entry.lifecycle === 'disposed'
      )
        throw new Error('Chat scope is draining');
      await this.load(scope, entry);
      assertCurrent();
      const preview = await entry.backend.captureTranscriptPreview(chatId);
      // Registration owns close retries even when cancellation arrives while
      // capture is awaiting the filesystem. A failed first close must remain
      // visible to drain/deletion rather than orphaning open handles.
      entry.previewReaders.add(preview);
      if (
        !this.accepting ||
        entry.deleting ||
        entry.lifecycle !== 'ready' ||
        (isCurrent && !isCurrent())
      ) {
        try {
          await preview.close();
        } catch (error) {
          this.recordPreviewCloseFailure(entry);
          throw error;
        }
        entry.previewReaders.delete(preview);
        throw new Error('Chat scope is draining');
      }
      return preview;
    });
    let projected:
      | { success: true; value: T }
      | { success: false; error: unknown };
    try {
      assertCurrent();
      const descriptor = captured.descriptor;
      const committedIncluded =
        options.reuseCommittedPrefix?.(descriptor) !== true;
      const value = await consume(
        committedIncluded ? captured.messages() : captured.activeMessages(),
        descriptor,
        {
          committedIncluded,
          ...(captured.journalProjected ? { journalProjected: true } : {}),
        },
      );
      captured.assertComplete();
      assertCurrent();
      projected = { success: true, value };
    } catch (error) {
      projected = { success: false, error };
    }
    try {
      await captured.close();
    } catch (error) {
      this.recordPreviewCloseFailure(entry);
      throw errorFromUnknown(error);
    }
    entry.previewReaders.delete(captured);
    if (!projected.success) throw errorFromUnknown(projected.error);
    return projected.value;
  }

  /**
   * The rows a chat's in-progress turn changed since transcript revision
   * `since`, read from the delta journal in memory (chat search's
   * incremental projection). Undefined when only a full read can answer.
   */
  public async activeTurnDelta(
    scope: ChatScopeKey,
    chatId: string,
    since: number,
  ): Promise<
    { descriptor: TranscriptDescriptor; delta: ActiveTurnDelta } | undefined
  > {
    const entry = this.entry(scope, false);
    return this.serialized(entry, async () => {
      if (!this.accepting || entry.deleting || entry.lifecycle !== 'ready')
        return undefined;
      return entry.backend.activeTurnDelta(chatId, since);
    });
  }

  public async consumeTranscript<T>(
    scope: ChatScopeKey,
    chatId: string,
    fullOutputs: boolean,
    consume: (messages: AsyncIterable<PersistedChatMessage>) => Promise<T>,
    options?: TranscriptConsumeOptions,
  ): Promise<T> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      return entry.backend.consumeTranscript<T>(
        chatId,
        fullOutputs,
        consume,
        options,
      );
    });
  }

  public async captureScope(
    scope: ChatScopeKey,
    destination: ChatStorageV2,
    allowDuringScopeDeletion = false,
    captureExecutor: (
      source: ChatStorageV2,
      destination: ChatStorageV2,
    ) => Promise<void> = (source, target) => source.copyTo(target),
  ): Promise<void> {
    // Capture never re-admits a deleted scope: a retry must observe disposal.
    const entry = this.entry(scope, false);
    return this.serialized(entry, async () => {
      // A committed capture may be the only surviving payload after deletion
      // removed its live scope. A retry must not replace it with an empty one.
      const captured = (await destination.authority()) === 'v2';
      if (captured && entry.lifecycle === 'disposed') {
        await captureExecutor(destination, destination);
        return;
      }
      this.assertWritable(entry, allowDuringScopeDeletion);
      await this.load(scope, entry);
      await entry.backend.flush();
      const current = await entry.backend.load();
      if (
        captured &&
        !current.live.tabs.length &&
        !current.archive.archived.length
      ) {
        await captureExecutor(destination, destination);
        return;
      }
      await captureExecutor(entry.store, destination);
    });
  }

  public async importScope(
    scope: ChatScopeKey,
    source: ChatStorageV2,
    metadata: Pick<CanonicalChatState, 'tabsFile' | 'archivesFile'>,
    options: ChatStorageImportOptions = {},
  ): Promise<void> {
    const entry = this.entry(scope);
    const { commit, published } = await this.serialized(entry, async () => {
      this.assertWritable(entry);
      await this.load(scope, entry);
      const journaled = entry.backend.isDeltaJournal();
      markImportedApprovalState(scope, metadata);
      const result = await entry.backend.importScope(source, metadata, options);
      if (result.applied) await this.requestArtifactMaintenance(entry);
      const imported = { ...result, ...scope };
      return {
        commit: imported,
        // After commits whose group-committed publication is still queued.
        published:
          journaled && imported.applied
            ? this.reservePublication(entry, imported, undefined)
            : undefined,
      };
    });
    this.scheduleJournalWork(entry);
    if (published) await published;
    else if (commit.applied) await this.publish(entry, commit);
  }

  /** Copy selected chats under both scope leases in a stable order. This also
   * supports resumable startup splits without ever serializing sibling bodies.
   */
  public async copyChats(
    sourceScope: ChatScopeKey,
    destinationScope: ChatScopeKey,
    metadata: Pick<CanonicalChatState, 'tabsFile' | 'archivesFile'>,
    sourceChatIds?: Readonly<Record<string, string>>,
    transformMessage?: ChatStorageImportOptions['transformMessage'],
    throughMessageIds?: ChatStorageImportOptions['throughMessageIds'],
    beforePublish?: ChatStorageImportOptions['beforePublish'],
    preparePublish?: ChatStorageImportOptions['preparePublish'],
  ): Promise<void> {
    const source = this.entry(sourceScope);
    const destination = this.entry(destinationScope);
    if (source === destination)
      throw new Error('Cross-scope copy requires distinct scopes');
    const ordered = [source, destination].sort((a, b) =>
      a.store.directory.localeCompare(b.store.directory),
    );
    const { commit, published } = await this.serialized(ordered[0], () =>
      this.serialized(ordered[1], async () => {
        this.assertWritable(destination);
        this.assertWritable(source);
        await this.load(sourceScope, source);
        await this.load(destinationScope, destination);
        const journaled = destination.backend.isDeltaJournal();
        await source.backend.flush();
        const indexes = await source.backend.load();
        const ids = [
          ...metadata.tabsFile.tabs,
          ...metadata.archivesFile.archived.map((entry) => entry.tab),
        ].map((tab) => tab.id);
        const entries = [
          ...indexes.live.tabs,
          ...indexes.archive.archived.map((entry) => entry.tab),
        ].filter((tab) =>
          ids.some((id) => (sourceChatIds?.[id] ?? id) === tab.id),
        );
        const mutationId = `copy:${createHash('sha256')
          .update(
            JSON.stringify([
              source.store.directory,
              ids,
              sourceChatIds,
              entries.map((tab) => [tab.id, tab.transcript.transcriptRevision]),
            ]),
          )
          .digest('hex')}`;
        markImportedApprovalState(destinationScope, metadata);
        const result = await destination.backend.importScope(
          source.store,
          metadata,
          {
            merge: true,
            mutationId,
            sourceChatIds,
            settleFork: sourceChatIds !== undefined,
            transformMessage,
            throughMessageIds,
            preparePublish,
            beforePublish,
          },
        );
        if (result.applied)
          await this.requestArtifactMaintenance(destination, ids);
        const copied = { ...result, ...destinationScope };
        return {
          commit: copied,
          // After commits whose group-committed publication is still queued.
          published:
            journaled && copied.applied
              ? this.reservePublication(destination, copied, undefined)
              : undefined,
        };
      }),
    );
    this.scheduleJournalWork(source);
    this.scheduleJournalWork(destination);
    if (published) await published;
    else if (commit.applied) await this.publish(destination, commit);
  }

  /** Explicit import/compatibility command; omitted history is never deletion.
   * Only an authoritative restore may replace existing transcript contents.
   */
  public async replaceCompatibilityTabs(
    scope: ChatScopeKey,
    incoming: ChatTabsFile,
    options: {
      changedTabIds?: readonly string[];
      removedTabIds?: readonly string[];
      activeTabId?: string;
      authoritative?: boolean;
      source?: ChatJournalRecord['source'];
      mutationId?: string;
      beforePublish?: () => void;
      preparePublish?: () => Promise<void>;
    } = {},
  ): Promise<CanonicalChatState> {
    const commit = await this.transactWith(
      scope,
      (current, revision, context) => {
        const mutations: ChatCoreMutation[] = [];
        const fresh = incoming.revision === revision;
        const authoritative = options.authoritative === true;
        const changed = options.changedTabIds
          ? new Set(options.changedTabIds)
          : undefined;
        const remaining = new Set(current.tabsFile.tabs.map((tab) => tab.id));
        for (const incomingTab of incoming.tabs) {
          remaining.delete(incomingTab.id);
          if (changed && !changed.has(incomingTab.id)) continue;
          const existing = current.tabsFile.tabs.find(
            (tab) => tab.id === incomingTab.id,
          );
          if (
            !existing &&
            !authoritative &&
            context.hasRemovedTab(incomingTab.id)
          )
            continue;
          const hasBody = Object.prototype.propertyIsEnumerable.call(
            incomingTab,
            'messages',
          );
          if (
            authoritative &&
            (!hasBody ||
              incomingTab.transcriptLoaded === false ||
              incomingTab.transcriptWindow?.before !== undefined ||
              (incomingTab.transcript?.messageCount ??
                incomingTab.transcript?.committedMessageCount ??
                0) > incomingTab.messages.length)
          )
            throw new Error(
              'Authoritative import requires complete transcript contents',
            );
          const messages = hasBody
            ? authoritative
              ? incomingTab.messages
              : incomingTab.messages.filter(
                  (message) =>
                    !context.hasRemovedMessage(message.id) &&
                    (!existing || !isMcpActivationMessage(message)),
                )
            : undefined;
          let metadata =
            existing && !authoritative && !fresh && !changed
              ? existing
              : incomingTab;
          if (existing && !authoritative) {
            const preserved = { ...metadata };
            if (existing.automaticTitleState !== undefined) {
              preserved.automaticTitleState = existing.automaticTitleState;
            }
            for (const key of [
              'mcpActivation',
              'inputDelivery',
              'lastAcceptedUserMessageId',
              'unacceptedTurnEnds',
              'turnEnds',
              'interruptedTurns',
            ] as const) {
              if (existing[key] === undefined) delete preserved[key];
              else Object.assign(preserved, { [key]: existing[key] });
            }
            metadata = preserved;
          }
          mutations.push({
            type: 'tab.created',
            tab: { ...metadata, ...(messages ? { messages } : {}) },
          });
          if (authoritative && existing && messages)
            mutations.push({
              type: 'messages.replaced',
              chatId: existing.id,
              messages,
              removedMessageIds: existing.messages
                .filter(
                  (message) =>
                    !messages.some((candidate) => candidate.id === message.id),
                )
                .map((message) => message.id),
            });
        }
        const removed = new Set(options.removedTabIds ?? []);
        if (authoritative || (!changed && fresh))
          for (const id of Array.from(remaining)) removed.add(id);
        for (const id of Array.from(removed))
          if (current.tabsFile.tabs.some((tab) => tab.id === id))
            mutations.push({ type: 'tab.removed', tabId: id });
        if (authoritative || (!changed && fresh)) {
          const order = incoming.tabs
            .map((tab) => tab.id)
            .filter((id) => !removed.has(id));
          mutations.push({ type: 'tab.order_changed', tabIds: order });
          if (order.length)
            mutations.push({
              type: 'tab.active_changed',
              activeTabId: order.includes(incoming.activeTabId)
                ? incoming.activeTabId
                : (order[0] ?? ''),
              lastActiveEditableChatId: incoming.lastActiveEditableChatId,
              lastActiveChatProvider: incoming.lastActiveChatProvider,
            });
          for (const question of current.tabsFile.pendingQuestions ?? [])
            if (
              !incoming.pendingQuestions?.some(
                (candidate) => candidate.requestId === question.requestId,
              )
            )
              mutations.push({
                type: 'pending_question.removed',
                requestId: question.requestId,
                chatId: question.chatId,
              });
          for (const question of incoming.pendingQuestions ?? [])
            mutations.push({ type: 'pending_question.upserted', question });
        } else if (options.activeTabId !== undefined) {
          const activeTabExists = incoming.tabs.some(
            (tab) =>
              tab.id === options.activeTabId &&
              !removed.has(options.activeTabId),
          );
          if (!activeTabExists)
            throw new Error('Active tab must be present in imported tabs');
          mutations.push({
            type: 'tab.active_changed',
            activeTabId: options.activeTabId,
            lastActiveEditableChatId: incoming.lastActiveEditableChatId,
            lastActiveChatProvider: incoming.lastActiveChatProvider,
          });
        }
        return mutations;
      },
      {
        source: options.source ?? 'import',
        mutationId: options.mutationId,
        fullTranscript: options.authoritative,
        ...(options.authoritative
          ? { chatIds: incoming.tabs.map((tab) => tab.id) }
          : {}),
        beforePublish: options.beforePublish,
        preparePublish: options.preparePublish,
      },
    );
    return commit.state;
  }

  public async flushScope(
    scope: ChatScopeKey,
    options: { allowDuringScopeDeletion?: boolean } = {},
  ): Promise<void> {
    const entry = this.entry(scope);
    await this.serialized(entry, async () => {
      this.assertWritable(entry, options.allowDuringScopeDeletion);
      await this.load(scope, entry);
      await entry.backend.flush();
    });
  }
  public async runWithScopeDeletion<T>(
    scope: ChatScopeKey,
    operation: () => Promise<T>,
  ): Promise<T> {
    const entry = this.entry(scope);
    entry.deleting++;
    this.cancelArtifactMaintenance(entry);
    try {
      await this.serialized(entry, async () => {
        try {
          await this.closePreviewReaders(entry);
        } catch {
          // Close failures retain readers for drain/retry and emit diagnostics.
        }
        try {
          await entry.backend.disposeArtifactMaintenance();
        } catch (error) {
          // A derived close failure is reported, but cannot skip deletion.
          this.recordArtifactMaintenanceFailure(entry, '', error);
        }
      });
      return await operation();
    } finally {
      entry.deleting--;
      this.armArtifactMaintenanceCapacity(entry);
      this.armArtifactMaintenance(entry);
    }
  }
  public async deleteEmptyScope(scope: ChatScopeKey): Promise<void> {
    const entry = this.entry(scope);
    await this.serialized(entry, async () => {
      await this.load(scope, entry);
      const index = await entry.backend.load();
      if (
        index.live.tabs.length ||
        index.archive.archived.length ||
        index.live.pendingQuestions?.length ||
        Object.keys(index.live.runtimeByChatId).length
      )
        throw new Error(
          'Chat scope must be semantically empty before deleting sidecars',
        );
      this.cancelArtifactMaintenance(entry);
      this.clearJournalIdleTimer(entry);
      await this.closePreviewReaders(entry);
      await entry.backend.disposeArtifactMaintenance();
      entry.lifecycle = 'draining';
      // Empty metadata is already durable. Removing authority first ensures a
      // crash can leave only an unselected orphan, never a missing live log.
      await rm(entry.store.manifestPath, { force: true });
      await fsyncDirectory(dirname(entry.store.manifestPath));
      await rm(entry.store.directory, { recursive: true, force: true });
      await fsyncDirectory(dirname(entry.store.directory));
      entry.visualStaging = undefined;
      entry.lifecycle = 'disposed';
    });
  }
  public async evictScope(scope: ChatScopeKey): Promise<boolean> {
    const entry = this.entry(scope);
    return this.serialized(entry, async () => {
      await this.load(scope, entry);
      const index = await entry.backend.load();
      if (
        entry.deleting ||
        (await this.options.hasLiveDependency?.(scope)) ||
        index.live.pendingQuestions?.length ||
        Object.values(index.live.runtimeByChatId).some((runtime) =>
          [
            'queued',
            'starting',
            'streaming',
            'awaiting_input',
            'completing',
          ].includes(runtime.status),
        )
      )
        return false;
      this.cancelArtifactMaintenance(entry);
      this.clearJournalIdleTimer(entry);
      let previewCloseError: unknown;
      try {
        await this.closePreviewReaders(entry);
      } catch (error) {
        previewCloseError = error;
      }
      try {
        await this.runArtifactMaintenanceChunk(entry);
      } catch {
        /* Recorded by the chunk. */
      }
      let closeError: unknown;
      try {
        await entry.backend.disposeArtifactMaintenance();
      } catch (error) {
        closeError = error;
        this.recordArtifactMaintenanceFailure(entry, '', error);
      }
      await entry.backend.flush();
      if (closeError || previewCloseError) return false;
      entry.visualStaging = undefined;
      entry.lifecycle = 'disposed';
      this.scopes.delete(entry.store.directory);
      return true;
    });
  }
  /** The deliberate retry boundary for a cached recovery failure: drops the
   * failed entry so the next access re-runs migration and load from disk.
   */
  public async releaseScope(scope: ChatScopeKey): Promise<boolean> {
    const directory = ChatStorageV2.fromLegacyPaths(
      this.resolve(scope),
    ).directory;
    const entry = this.scopes.get(directory);
    if (!entry) return true;
    if (entry.lifecycle !== 'recovery_error' || entry.deleting) return false;
    this.cancelArtifactMaintenance(entry);
    await this.closePreviewReaders(entry);
    await entry.backend.disposeArtifactMaintenance();
    await entry.tail.catch(() => undefined);
    if (entry.lifecycle !== 'recovery_error' || entry.loading) return false;
    entry.visualStaging = undefined;
    if (this.scopes.get(directory) === entry) this.scopes.delete(directory);
    return true;
  }
  public async drainAll(): Promise<void> {
    this.accepting = false;
    await this.visualStagingSweep.stop();
    for (const entry of Array.from(this.scopes.values())) {
      this.cancelArtifactMaintenance(entry);
      this.clearJournalIdleTimer(entry);
    }
    // A sweep stops at its next scope; the one it is sweeping finishes.
    await Promise.allSettled(Array.from(this.sweeps));
    const outcomes = await Promise.allSettled(
      Array.from(this.scopes.values()).map((entry) =>
        this.serialized(entry, async () => {
          if (entry.lifecycle === 'ready' || entry.lifecycle === 'draining') {
            if (entry.lifecycle === 'ready') {
              try {
                await this.runArtifactMaintenanceChunk(entry);
              } catch {
                /* Recorded by the chunk. */
              }
            }
            entry.lifecycle = 'draining';
            let closeError: unknown;
            try {
              await this.closePreviewReaders(entry);
            } catch (error) {
              closeError = error;
            }
            try {
              await entry.backend.disposeArtifactMaintenance();
            } catch (error) {
              closeError ??= error;
              this.recordArtifactMaintenanceFailure(entry, '', error);
            }
            await entry.backend.flush();
            if (closeError) throw errorFromUnknown(closeError);
            entry.visualStaging = undefined;
            entry.lifecycle = 'disposed';
          }
        }),
      ),
    );
    const failures = outcomes
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      .map((result): unknown => result.reason);
    if (failures.length)
      throw aggregateFailure(failures, 'Chat scope drain failed');
  }
  public getLifecycle(scope: ChatScopeKey): ChatScopeLifecycle {
    return (
      this.scopes.get(
        ChatStorageV2.fromLegacyPaths(this.resolve(scope)).directory,
      )?.lifecycle ?? 'unloaded'
    );
  }
  public getArtifactMaintenanceStatus(scope: ChatScopeKey): {
    pendingChats: number;
    deferredChats: number;
    failure?: string;
  } {
    const entry = this.scopes.get(
      ChatStorageV2.fromLegacyPaths(this.resolve(scope)).directory,
    );
    return {
      pendingChats: entry?.maintenanceChats.size ?? 0,
      deferredChats: entry?.maintenanceDeferred.size ?? 0,
      ...(entry?.maintenanceFailure
        ? { failure: entry.maintenanceFailure }
        : {}),
    };
  }
  public getDiagnostics(scope: ChatScopeKey): readonly ChatJournalDiagnostic[] {
    const entry = this.scopes.get(
      ChatStorageV2.fromLegacyPaths(this.resolve(scope)).directory,
    );
    return entry?.loadError
      ? [{ kind: 'unrecoverable_journal', message: entry.loadError.message }]
      : [];
  }
  public getStorageDiagnostics(
    scope: ChatScopeKey,
  ): readonly ChatStateStorageDiagnostic[] {
    return (
      this.diagnostics.get(
        ChatStorageV2.fromLegacyPaths(this.resolve(scope)).directory,
      ) ?? []
    );
  }
  public subscribeStorageDiagnostics(
    listener: (diagnostic: ChatStateStorageDiagnostic) => void,
  ): () => void {
    this.diagnosticListeners.add(listener);
    return () => {
      this.diagnosticListeners.delete(listener);
    };
  }
}
