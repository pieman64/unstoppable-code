export {
  ChatScopeLifecycle,
  ChatScopeKey,
  ChatStateCommit,
  ChatMutationOptions,
  ChatStateRevisionConflictError,
  ScopePaths,
  ChatStateRepositoryOptions,
  ChatStateStorageDiagnostic,
  ChatStateTransactionContext,
  ChatStateRepositoryLoadError,
} from './chat-state-contracts';
import {
  type ChatScopeLifecycle,
  type ChatScopeKey,
  type ChatStateCommit,
  type ChatMutationOptions,
  ChatStateRevisionConflictError,
  type ScopePaths,
  type ChatStateRepositoryOptions,
  type ChatStateStorageDiagnostic,
  type ChatStateTransactionContext,
  ChatStateRepositoryLoadError,
} from './chat-state-contracts';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  ArchivedChatsFile,
  ChatCoreMutation,
  ChatJournalRecord,
  ChatRuntimeState,
  ChatTabSettingsPatch,
  ChatTabsFile,
  PersistedChatTab,
  PersistedCommandReceipt,
} from '@canopy/desktop-shared/types';
import { CHAT_TAB_SETTINGS_PATCH_KEYS } from '@canopy/desktop-shared/types';
import {
  createEmptyArchivedChatsFile,
  createEmptyChatTabsFile,
  mergePersistedMessagesById,
  normalizeLegacyChatTabsFile,
  normalizeLegacyPersistedChatTab,
  persistedFileRevision,
} from '@canopy/desktop-shared/persisted-chat-state';
import {
  isArchivedSnapshot,
  isChatTabsSnapshot,
  isRecord,
  repairLegacySnapshots,
} from '../lib/chat-state-snapshots';
import {
  appendChatJournalRecord,
  fileSize,
  fsyncDirectory,
  preserveSnapshotConflict,
  readChatJournal,
  replaceChatJournal,
  replaceSnapshotWithBackup,
  restoreSnapshotPrimary,
  writeSyncedJsonTemp,
  type ChatJournalDiagnostic,
} from '../lib/chat-state-journal';
import { isCooperativeJsonWriteAbortedError } from '../lib/cooperative-json';
import { buildPersistedTurnInterruptedMutations } from '../lib/persisted-chat-settle';
import { isErrnoException } from '../lib/type-guards';
import {
  getChatStateBackupFilePath,
  getChatStateConflictFilePath,
} from '../lib/paths';
import {
  resolveChatArchivesFilePath,
  resolveChatJournalFilePath,
  resolveChatTabsFilePath,
} from '../lib/resolve-worktree';
import {
  reduceChatState,
  validateCanonicalChatState,
  type CanonicalChatState,
} from './chat-state-reducer';

const CHECKPOINT_IDLE_MS = 1_000;
const CHECKPOINT_BOUNDARY_DELAY_MS = 25;
const CHECKPOINT_RECORD_LIMIT = 500;
const CHECKPOINT_BYTE_LIMIT = 4 * 1024 * 1024;
const CHECKPOINT_MAX_ABORTS = 3;
const CHECKPOINT_MAX_DEFERRAL_MS = 30_000;
const RECEIPT_RETENTION = 256;
const TOMBSTONE_RETENTION = 1_024;
const RECENT_MUTATION_RETENTION = 4_096;

interface LoadedSnapshot<T> {
  value?: T;
  primaryError?: unknown;
  usedBackup: boolean;
}

interface ScopeEntry {
  key: ChatScopeKey;
  lifecycle: ChatScopeLifecycle;
  state?: CanonicalChatState;
  revision: number;
  loadPromise?: Promise<void>;
  tail: Promise<void>;
  records: ChatJournalRecord[];
  journalBytes: number;
  tabsSnapshotRevision: number;
  archivesSnapshotRevision: number;
  receipts: Map<string, PersistedCommandReceipt>;
  mutationIds: Set<string>;
  removedTabIds: Set<string>;
  removedArchiveEntryIds: Set<string>;
  removedMessageIds: Set<string>;
  removedMessageKeys: Set<string>;
  diagnostics: ChatJournalDiagnostic[];
  storageDiagnostics: ChatStateStorageDiagnostic[];
  checkpointTimer?: ReturnType<typeof setTimeout>;
  checkpointTimerRequired?: boolean;
  checkpointInProgress?: boolean;
  checkpointAbortRequested?: boolean;
  checkpointRequiredSince?: number;
  checkpointAbortCount: number;
  loadError?: ChatStateRepositoryLoadError;
  /** Corrupt primary/backup files are preserved until explicit recovery. */
  writeProtected?: boolean;
}

function scopeId(scope: ChatScopeKey): string {
  return `${scope.projectId}\u0000${scope.worktreeId}`;
}

function defaultResolvePaths(scope: ChatScopeKey): ScopePaths {
  return {
    tabs: resolveChatTabsFilePath(scope.projectId, scope.worktreeId),
    archives: resolveChatArchivesFilePath(scope.projectId, scope.worktreeId),
    journal: resolveChatJournalFilePath(scope.projectId, scope.worktreeId),
  };
}

async function readSnapshot<T>(
  primaryPath: string,
  validate: (value: unknown) => value is T,
): Promise<LoadedSnapshot<T>> {
  const read = async (filePath: string): Promise<T> => {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!validate(parsed)) throw new Error(`Invalid snapshot: ${filePath}`);
    return parsed;
  };

  try {
    return { value: await read(primaryPath), usedBackup: false };
  } catch (primaryError) {
    const missing = isRecord(primaryError) && primaryError.code === 'ENOENT';
    try {
      return {
        value: await read(getChatStateBackupFilePath(primaryPath)),
        primaryError: missing ? undefined : primaryError,
        usedBackup: true,
      };
    } catch (backupError) {
      if (missing && isRecord(backupError) && backupError.code === 'ENOENT') {
        return { usedBackup: false };
      }
      return {
        primaryError: missing ? backupError : primaryError,
        usedBackup: false,
      };
    }
  }
}

function initialRuntime(
  tabsFile: ChatTabsFile,
): Record<string, ChatRuntimeState> {
  return Object.fromEntries(
    tabsFile.tabs
      .filter((tab) => tab.kind !== 'file')
      .map((tab) => {
        const lastMessage = tab.messages[tab.messages.length - 1];
        return [
          tab.id,
          {
            status: 'idle' as const,
            queuedMessageIds: [],
            ...(lastMessage?.timestamp
              ? { lastActivityAt: lastMessage.timestamp }
              : {}),
          },
        ];
      }),
  );
}

function mutationComponent(
  mutation: ChatCoreMutation,
): 'tabs' | 'archives' | 'runtime' {
  if (mutation.type.startsWith('archive.')) return 'archives';
  if (mutation.type === 'runtime.patched') return 'runtime';
  return 'tabs';
}

function sameRecord(a: ChatJournalRecord, b: ChatJournalRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function addBounded(set: Set<string>, value: string, limit: number): void {
  set.delete(value);
  set.add(value);
  while (set.size > limit) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

function compatibilityMetadataPatch(
  current: PersistedChatTab,
  next: PersistedChatTab,
): ChatTabSettingsPatch | undefined {
  if (!isDeepStrictEqual(current.messages, next.messages)) return undefined;
  const currentRest: Record<string, unknown> = { ...current };
  const nextRest: Record<string, unknown> = { ...next };
  Reflect.deleteProperty(currentRest, 'messages');
  Reflect.deleteProperty(nextRest, 'messages');
  const patch: ChatTabSettingsPatch = {};
  let changed = false;
  for (const key of CHAT_TAB_SETTINGS_PATCH_KEYS) {
    const currentValue = currentRest[key];
    const nextValue = nextRest[key];
    Reflect.deleteProperty(currentRest, key);
    Reflect.deleteProperty(nextRest, key);
    if (isDeepStrictEqual(currentValue, nextValue)) continue;
    // `undefined` is ignored by the reducer and therefore cannot represent a
    // deletion. Nullable patch fields already arrive as an explicit null.
    if (nextValue === undefined) return undefined;
    if (
      key === 'modelConfig' &&
      currentValue !== null &&
      typeof currentValue === 'object' &&
      nextValue !== null &&
      typeof nextValue === 'object' &&
      Object.keys(currentValue).some(
        (modelConfigKey) => !(modelConfigKey in nextValue),
      )
    ) {
      // The reducer intentionally merges partial modelConfig patches. A
      // compatibility snapshot that removes a nested key therefore needs the
      // whole-tab replacement path to preserve authoritative snapshot state.
      return undefined;
    }
    Reflect.set(patch, key, nextValue);
    changed = true;
  }
  if (!isDeepStrictEqual(currentRest, nextRest)) return undefined;
  const illegalPatchKey = Object.keys(patch).some((key) =>
    next.kind === 'file'
      ? key !== 'pinned' && key !== 'fileViewMode' && key !== 'fileDiffContext'
      : key === 'fileViewMode' || key === 'fileDiffContext',
  );
  if (illegalPatchKey) return undefined;
  return changed ? patch : {};
}

function hasTranscriptBearingTabMutation(
  mutations: readonly ChatCoreMutation[],
): boolean {
  return mutations.some(
    (mutation) =>
      (mutation.type === 'tab.created' && mutation.tab.messages.length > 0) ||
      (mutation.type === 'archive.upserted' &&
        mutation.entry.tab.messages.length > 0),
  );
}

export class ChatStateRepository {
  private readonly scopes = new Map<string, ScopeEntry>();
  private readonly deletingScopeIds = new Map<string, number>();
  private acceptingScopes = true;
  private readonly resolvePaths: (scope: ChatScopeKey) => ScopePaths;
  private readonly now: () => number;
  private readonly createId: () => string;
  private onCommit?: (commit: ChatStateCommit) => void | Promise<void>;
  private readonly hasLiveDependency: (scope: ChatScopeKey) => boolean;
  private readonly writeSyncedJsonTemp: typeof writeSyncedJsonTemp;
  private readonly checkpointIdleMs: number;
  private readonly checkpointBoundaryDelayMs: number;
  private readonly maxCheckpointAborts: number;
  private readonly maxCheckpointDeferralMs: number;
  private readonly storageDiagnosticListeners: Array<
    (diagnostic: ChatStateStorageDiagnostic) => void
  > = [];

  public constructor(options: ChatStateRepositoryOptions = {}) {
    this.resolvePaths = options.resolvePaths ?? defaultResolvePaths;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.onCommit = options.onCommit;
    this.hasLiveDependency =
      options.hasLiveDependency ?? ((): boolean => false);
    this.writeSyncedJsonTemp =
      options.writeSyncedJsonTemp ?? writeSyncedJsonTemp;
    this.checkpointIdleMs = options.checkpointIdleMs ?? CHECKPOINT_IDLE_MS;
    this.checkpointBoundaryDelayMs =
      options.checkpointBoundaryDelayMs ?? CHECKPOINT_BOUNDARY_DELAY_MS;
    this.maxCheckpointAborts =
      options.maxCheckpointAborts ?? CHECKPOINT_MAX_ABORTS;
    this.maxCheckpointDeferralMs =
      options.maxCheckpointDeferralMs ?? CHECKPOINT_MAX_DEFERRAL_MS;
    if (options.onStorageDiagnostic) {
      this.storageDiagnosticListeners.push(options.onStorageDiagnostic);
    }
  }

  public setCommitListener(
    listener: (commit: ChatStateCommit) => void | Promise<void>,
  ): void {
    this.onCommit = listener;
  }

  /**
   * Block every ordinary transaction for a scope while its persisted state is
   * being removed. The counter keeps nested worktree/chat cleanup boundaries
   * active until their outermost owner completes.
   */
  public async runWithScopeDeletion<T>(
    scope: ChatScopeKey,
    operation: () => Promise<T>,
  ): Promise<T> {
    const id = scopeId(scope);
    this.deletingScopeIds.set(id, (this.deletingScopeIds.get(id) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const remaining = (this.deletingScopeIds.get(id) ?? 1) - 1;
      if (remaining <= 0) {
        this.deletingScopeIds.delete(id);
      } else {
        this.deletingScopeIds.set(id, remaining);
      }
    }
  }

  public async getState(
    scope: ChatScopeKey,
    _selection?: {
      chatIds?: readonly string[];
      fullTranscript?: boolean;
      pageOnly?: boolean;
    },
  ): Promise<CanonicalChatState> {
    void _selection;
    const entry = this.getEntry(scope);
    if (entry.lifecycle === 'recovery_error') {
      await this.serialize(entry, async () => {
        if (entry.lifecycle !== 'recovery_error') return;
        this.resetFailedLoad(entry);
        await this.ensureLoaded(entry);
      });
    } else {
      await this.ensureLoaded(entry);
    }
    if (!entry.state)
      throw entry.loadError ?? new Error('Chat scope is unavailable');
    return entry.state;
  }

  public async getRevision(scope: ChatScopeKey): Promise<number> {
    const entry = this.getEntry(scope);
    await this.ensureLoaded(entry);
    return entry.revision;
  }

  /**
   * Validate a caller's observed revision at the serialized repository
   * boundary without holding that boundary across host/provider side effects.
   * Queue commands use this before cancellation or dispatch, then commit their
   * commutative runtime projection against whatever newer state exists.
   */
  public async assertExpectedRevision(
    scope: ChatScopeKey,
    expectedRevision: number | undefined,
  ): Promise<number> {
    const entry = this.getEntry(scope);
    await this.ensureLoaded(entry);
    return this.serialize(entry, () => {
      if (entry.lifecycle === 'draining' || entry.lifecycle === 'disposed') {
        throw new Error('Chat scope is draining');
      }
      if (entry.lifecycle !== 'ready' || !entry.state) {
        throw entry.loadError ?? new Error('Chat scope is not writable');
      }
      if (
        expectedRevision !== undefined &&
        expectedRevision !== entry.revision
      ) {
        throw new ChatStateRevisionConflictError(
          expectedRevision,
          entry.revision,
        );
      }
      return Promise.resolve(entry.revision);
    });
  }

  public async getReceipt(
    scope: ChatScopeKey,
    commandId: string,
  ): Promise<PersistedCommandReceipt | undefined> {
    const entry = this.getEntry(scope);
    await this.ensureLoaded(entry);
    return entry.receipts.get(commandId);
  }

  public async getPortalSendReceipt(
    scope: ChatScopeKey,
    userMessageId: string,
  ): Promise<PersistedCommandReceipt | undefined> {
    const entry = this.getEntry(scope);
    await this.ensureLoaded(entry);
    return Array.from(entry.receipts.values()).find(
      (receipt) => receipt.portalSend?.userMessageId === userMessageId,
    );
  }

  public async hasMutation(
    scope: ChatScopeKey,
    mutationId: string,
  ): Promise<boolean> {
    const entry = this.getEntry(scope);
    await this.ensureLoaded(entry);
    return entry.mutationIds.has(mutationId);
  }

  public async hasRemovedTab(
    scope: ChatScopeKey,
    tabId: string,
  ): Promise<boolean> {
    const entry = this.getEntry(scope);
    await this.ensureLoaded(entry);
    return entry.removedTabIds.has(tabId);
  }

  public async hasRemovedMessage(
    scope: ChatScopeKey,
    messageId: string,
  ): Promise<boolean> {
    const entry = this.getEntry(scope);
    await this.ensureLoaded(entry);
    return entry.removedMessageIds.has(messageId);
  }

  public async transact(
    scope: ChatScopeKey,
    mutations: readonly ChatCoreMutation[],
    options: ChatMutationOptions,
  ): Promise<ChatStateCommit> {
    return this.transactWith(scope, () => [...mutations], options);
  }

  public async transactWith(
    scope: ChatScopeKey,
    build: (
      current: CanonicalChatState,
      revision: number,
      context: ChatStateTransactionContext,
    ) => ChatCoreMutation[] | Promise<ChatCoreMutation[]>,
    options: ChatMutationOptions,
  ): Promise<ChatStateCommit> {
    this.assertScopeMutationAllowed(scope, options);
    if (!this.acceptingScopes) {
      throw new Error('Chat state repository is draining');
    }
    const entry = this.getEntry(scope);
    this.preemptScheduledCheckpoint(entry);
    return this.serialize(entry, async () => {
      this.assertScopeMutationAllowed(scope, options);
      await this.ensureLoaded(entry);
      if (entry.writeProtected) {
        throw new ChatStateRepositoryLoadError(
          `Chat scope ${scope.projectId}/${scope.worktreeId} is write-protected after snapshot recovery failed`,
        );
      }
      if (entry.lifecycle === 'draining' || entry.lifecycle === 'disposed') {
        throw new Error('Chat scope is draining');
      }
      if (entry.lifecycle !== 'ready' || !entry.state) {
        throw entry.loadError ?? new Error('Chat scope is not writable');
      }
      const mutationId = options.mutationId ?? this.createId();
      const retainedRecord = entry.records.find(
        (candidate) => candidate.mutationId === mutationId,
      );
      if (retainedRecord) {
        return {
          projectId: scope.projectId,
          worktreeId: scope.worktreeId,
          baseRevision: retainedRecord.revision - 1,
          revision: retainedRecord.revision,
          record: retainedRecord,
          state: entry.state,
          applied: false,
        };
      }
      if (entry.mutationIds.has(mutationId)) {
        // The journal record may have been compacted after its snapshot became
        // durable. Keep live-process retries idempotent without inventing a
        // second persisted revision or re-broadcasting the mutation.
        return {
          projectId: scope.projectId,
          worktreeId: scope.worktreeId,
          baseRevision: entry.revision,
          revision: entry.revision,
          record: {
            v: 1,
            revision: entry.revision,
            mutationId,
            occurredAt: new Date(this.now()).toISOString(),
            source: options.source,
            mutations: [],
          },
          state: entry.state,
          applied: false,
        };
      }
      if (
        options.expectedRevision !== undefined &&
        options.expectedRevision !== entry.revision
      ) {
        throw new ChatStateRevisionConflictError(
          options.expectedRevision,
          entry.revision,
        );
      }

      const mutations = await build(entry.state, entry.revision, {
        hasRemovedTab: (tabId) => entry.removedTabIds.has(tabId),
        hasRemovedArchiveEntry: (archiveEntryId) =>
          entry.removedArchiveEntryIds.has(archiveEntryId),
        getPortalSendReceipt: (userMessageId) =>
          Array.from(entry.receipts.values()).find(
            (receipt) => receipt.portalSend?.userMessageId === userMessageId,
          ),
        hasRemovedMessage: (messageId, chatId) =>
          chatId === undefined
            ? entry.removedMessageIds.has(messageId)
            : entry.removedMessageKeys.has(JSON.stringify([chatId, messageId])),
      });
      this.assertScopeMutationAllowed(scope, options);
      if (mutations.length === 0) {
        // Internal compare-and-create adapters use an empty build result when
        // another serialized writer already established the desired state.
        // This is a true no-op: do not allocate a revision, append a journal
        // record, or notify post-commit observers.
        return {
          projectId: scope.projectId,
          worktreeId: scope.worktreeId,
          baseRevision: entry.revision,
          revision: entry.revision,
          record: {
            v: 1,
            revision: entry.revision,
            mutationId,
            occurredAt: new Date(this.now()).toISOString(),
            source: options.source,
            mutations: [],
          },
          state: entry.state,
          applied: false,
        };
      }
      const baseRevision = entry.revision;
      const revision = baseRevision + 1;
      const nextState = reduceChatState(entry.state, mutations);
      const commandResult: PersistedCommandReceipt | undefined =
        options.commandResult
          ? { ...options.commandResult, revision }
          : undefined;
      const record: ChatJournalRecord = {
        v: 1,
        revision,
        mutationId,
        occurredAt: new Date(this.now()).toISOString(),
        source: options.source,
        mutations,
        ...(commandResult ? { commandResult } : {}),
      };

      const paths = this.resolvePaths(scope);
      await options.preparePublish?.();
      options.beforePublish?.();
      // This append includes fsync and is the commit boundary. Snapshot
      // checkpointing below may batch materialization, but never WAL durability.
      const recordBytes = await appendChatJournalRecord(paths.journal, record);
      entry.journalBytes += recordBytes;
      entry.records.push(record);
      entry.mutationIds.add(mutationId);
      entry.revision = revision;
      entry.state = {
        ...nextState,
        tabsFile: { ...nextState.tabsFile, revision },
        archivesFile: { ...nextState.archivesFile, revision },
      };
      this.indexRecord(entry, record);
      this.emitStorageDiagnostic(entry, {
        kind: 'journal_growth',
        journalBytes: entry.journalBytes,
        recordBytes,
        recordCount: entry.records.length,
      });
      if (hasTranscriptBearingTabMutation(mutations)) {
        this.emitStorageDiagnostic(entry, {
          kind: 'transcript_bearing_mutation',
          journalBytes: entry.journalBytes,
          recordBytes,
          recordCount: entry.records.length,
        });
      }

      const commit: ChatStateCommit = {
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        baseRevision,
        revision,
        record,
        state: entry.state,
        applied: true,
      };
      try {
        await this.onCommit?.(commit);
      } catch {
        // Observers and projections are post-commit and cannot roll back state.
      }

      const explicitBoundary =
        options.checkpoint === true ||
        mutations.some((mutation) => mutation.type.startsWith('archive.'));
      const maintenanceCheckpoint =
        entry.records.length >= CHECKPOINT_RECORD_LIMIT ||
        entry.journalBytes >= CHECKPOINT_BYTE_LIMIT;
      // The journal record is already fsynced before this point. Keep boundary
      // materialization within the provider batching ceiling. Terminal-only
      // and size-triggered maintenance commits use the idle window: their
      // journal is already durable, and a follow-up turn must not repeatedly
      // restart multi-megabyte snapshots between its staging commits. Once a
      // threshold timer exists, later commits do not postpone it. Explicit
      // flushes and orderly drains still checkpoint immediately.
      this.scheduleCheckpoint(
        entry,
        explicitBoundary
          ? this.checkpointBoundaryDelayMs
          : this.checkpointIdleMs,
        explicitBoundary || maintenanceCheckpoint,
        maintenanceCheckpoint && !explicitBoundary,
      );
      return commit;
    });
  }

  private assertScopeMutationAllowed(
    scope: ChatScopeKey,
    options: ChatMutationOptions,
  ): void {
    if (
      options.allowDuringScopeDeletion !== true &&
      this.deletingScopeIds.has(scopeId(scope))
    ) {
      throw new Error('Chat scope is being deleted');
    }
  }

  public async replaceCompatibilityTabs(
    scope: ChatScopeKey,
    incoming: ChatTabsFile,
    options: {
      changedTabIds?: readonly string[];
      removedTabIds?: readonly string[];
      authoritative?: boolean;
      source?: ChatJournalRecord['source'];
      mutationId?: string;
      beforePublish?: () => void;
      preparePublish?: () => Promise<void>;
    } = {},
  ): Promise<CanonicalChatState> {
    const loaded = await this.getState(scope);
    if (incoming.tabs.length === 0 && loaded.tabsFile.tabs.length === 0) {
      return loaded;
    }
    const commit = await this.transactWith(
      scope,
      (current, _revision, transaction) => {
        const mutations: ChatCoreMutation[] = [];
        const changedTabIds = options.changedTabIds
          ? new Set(options.changedTabIds)
          : undefined;
        const freshCompatibilitySnapshot =
          incoming.revision !== undefined &&
          incoming.revision === current.tabsFile.revision;
        const replacesOmittedTabs =
          options.authoritative === true ||
          (changedTabIds === undefined && freshCompatibilitySnapshot);
        const currentById = new Map(
          current.tabsFile.tabs.map((tab) => [tab.id, tab]),
        );
        const incomingTabIds = new Set(incoming.tabs.map((tab) => tab.id));
        for (const incomingTab of incoming.tabs) {
          if (changedTabIds && !changedTabIds.has(incomingTab.id)) continue;
          const compatibleIncomingTab =
            options.authoritative === true
              ? incomingTab
              : {
                  ...incomingTab,
                  messages: incomingTab.messages.filter(
                    (message) => !transaction.hasRemovedMessage(message.id),
                  ),
                };
          const canonical = currentById.get(incomingTab.id);
          if (
            !canonical &&
            options.authoritative !== true &&
            transaction.hasRemovedTab(incomingTab.id)
          ) {
            continue;
          }
          const mergedTab =
            canonical && options.authoritative !== true
              ? freshCompatibilitySnapshot
                ? {
                    ...compatibleIncomingTab,
                    messages: mergePersistedMessagesById(
                      canonical.messages,
                      compatibleIncomingTab.messages,
                    ),
                  }
                : changedTabIds === undefined
                  ? {
                      ...canonical,
                      messages: mergePersistedMessagesById(
                        canonical.messages,
                        compatibleIncomingTab.messages,
                      ),
                    }
                  : {
                      ...canonical,
                      ...compatibleIncomingTab,
                      messages: mergePersistedMessagesById(
                        canonical.messages,
                        compatibleIncomingTab.messages,
                      ),
                    }
              : compatibleIncomingTab;
          // Delivery evidence belongs to the host ledger. Compatibility
          // writers may omit it (older clients) or carry an earlier copy;
          // neither can replace facts committed since their snapshot. Only
          // the explicit authoritative restore path may replace this history.
          let tab = mergedTab;
          if (canonical && options.authoritative !== true) {
            tab = { ...mergedTab };
            for (const key of [
              'mcpActivation',
              'inputDelivery',
              'lastAcceptedUserMessageId',
              'unacceptedTurnEnds',
              'turnEnds',
              'interruptedTurns',
            ] as const) {
              if (canonical[key] === undefined) delete tab[key];
              else Object.assign(tab, { [key]: canonical[key] });
            }
          }
          const metadataPatch = canonical
            ? compatibilityMetadataPatch(canonical, tab)
            : undefined;
          if (metadataPatch && Object.keys(metadataPatch).length > 0) {
            mutations.push({
              type: 'tab.metadata_patched',
              tabId: tab.id,
              patch: metadataPatch,
            });
          } else if (!metadataPatch) {
            mutations.push({ type: 'tab.created', tab });
          }
          currentById.delete(tab.id);
        }
        const removed = new Set(options.removedTabIds ?? []);
        if (replacesOmittedTabs) {
          for (const tabId of Array.from(currentById.keys())) {
            if (!incomingTabIds.has(tabId)) {
              removed.add(tabId);
            }
          }
        }
        for (const tabId of Array.from(removed)) {
          if (current.tabsFile.tabs.some((tab) => tab.id === tabId)) {
            mutations.push({ type: 'tab.removed', tabId });
          }
        }

        const order = changedTabIds
          ? current.tabsFile.tabs
              .map((tab) => tab.id)
              .filter((id) => !removed.has(id))
          : !replacesOmittedTabs
            ? current.tabsFile.tabs
                .map((tab) => tab.id)
                .filter((id) => !removed.has(id))
            : [
                ...incoming.tabs.map((tab) => tab.id),
                ...current.tabsFile.tabs
                  .map((tab) => tab.id)
                  .filter(
                    (id) =>
                      !removed.has(id) &&
                      !incoming.tabs.some((tab) => tab.id === id),
                  ),
              ];
        if (order.length > 0 && !changedTabIds && replacesOmittedTabs) {
          mutations.push({ type: 'tab.order_changed', tabIds: order });
          const activeTabId = order.includes(incoming.activeTabId)
            ? incoming.activeTabId
            : order[0];
          mutations.push({
            type: 'tab.active_changed',
            activeTabId,
            ...(incoming.lastActiveEditableChatId
              ? { lastActiveEditableChatId: incoming.lastActiveEditableChatId }
              : {}),
            ...(incoming.lastActiveChatProvider
              ? { lastActiveChatProvider: incoming.lastActiveChatProvider }
              : {}),
          });
        }

        if (options.authoritative === true || freshCompatibilitySnapshot) {
          const canonicalQuestions = new Map(
            (current.tabsFile.pendingQuestions ?? []).map((question) => [
              question.requestId,
              question,
            ]),
          );
          for (const question of incoming.pendingQuestions ?? []) {
            mutations.push({ type: 'pending_question.upserted', question });
            canonicalQuestions.delete(question.requestId);
          }
          if (options.authoritative === true || replacesOmittedTabs) {
            for (const question of Array.from(canonicalQuestions.values())) {
              mutations.push({
                type: 'pending_question.removed',
                requestId: question.requestId,
                chatId: question.chatId,
              });
            }
          }
        }
        return mutations;
      },
      {
        source: options.source ?? 'migration',
        ...(options.mutationId ? { mutationId: options.mutationId } : {}),
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
    const id = scopeId(scope);
    if (
      options.allowDuringScopeDeletion !== true &&
      this.deletingScopeIds.has(id)
    ) {
      return;
    }
    const entry = this.getEntry(scope);
    await this.ensureLoaded(entry);
    if (entry.checkpointTimer) {
      clearTimeout(entry.checkpointTimer);
      delete entry.checkpointTimer;
      delete entry.checkpointTimerRequired;
    }
    this.preemptScheduledCheckpoint(entry);
    await this.serialize(entry, async () => {
      if (
        (options.allowDuringScopeDeletion !== true &&
          this.deletingScopeIds.has(id)) ||
        entry.lifecycle === 'disposed'
      ) {
        return;
      }
      await this.checkpointEntry(entry);
    });
  }

  public async drainAll(): Promise<void> {
    this.acceptingScopes = false;
    const entries = Array.from(this.scopes.values()).filter(
      (entry) => entry.lifecycle !== 'disposed',
    );
    for (const entry of entries) {
      if (entry.checkpointTimer) {
        clearTimeout(entry.checkpointTimer);
        delete entry.checkpointTimer;
        delete entry.checkpointTimerRequired;
      }
      this.preemptScheduledCheckpoint(entry);
    }
    await Promise.all(
      entries.map(async (entry) => {
        await entry.loadPromise?.catch(() => undefined);
        await this.serialize(entry, async () => {
          if (entry.lifecycle === 'ready') entry.lifecycle = 'draining';
          await this.checkpointEntry(entry);
        }).catch(() => undefined);
        entry.lifecycle = 'disposed';
      }),
    );
  }

  public async evictScope(scope: ChatScopeKey): Promise<boolean> {
    const entry = this.scopes.get(scopeId(scope));
    if (!entry) return true;
    await this.ensureLoaded(entry);
    const hasNonterminal = Object.values(
      entry.state?.runtimeByChatId ?? {},
    ).some((runtime) =>
      [
        'queued',
        'starting',
        'streaming',
        'awaiting_input',
        'completing',
      ].includes(runtime.status),
    );
    if (
      hasNonterminal ||
      (entry.state?.tabsFile.pendingQuestions?.length ?? 0) > 0 ||
      this.hasLiveDependency(scope)
    ) {
      return false;
    }
    await this.flushScope(scope);
    entry.lifecycle = 'disposed';
    this.scopes.delete(scopeId(scope));
    return true;
  }

  /**
   * Permanently remove an already-empty scope after its semantic removals
   * have committed. Draining and clearing the checkpoint timer before file
   * deletion prevents a queued checkpoint from recreating deleted sidecars.
   */
  public async deleteEmptyScope(scope: ChatScopeKey): Promise<void> {
    const id = scopeId(scope);
    const entry = this.getEntry(scope);
    await this.ensureLoaded(entry);
    if (entry.checkpointTimer) {
      clearTimeout(entry.checkpointTimer);
      delete entry.checkpointTimer;
      delete entry.checkpointTimerRequired;
    }
    this.preemptScheduledCheckpoint(entry);
    entry.lifecycle = 'draining';
    try {
      await this.serialize(entry, async () => {
        const state = entry.state;
        if (
          !state ||
          state.tabsFile.tabs.length > 0 ||
          state.archivesFile.archived.length > 0 ||
          (state.tabsFile.pendingQuestions?.length ?? 0) > 0 ||
          Object.keys(state.runtimeByChatId).length > 0
        ) {
          throw new Error(
            'Chat scope must be semantically empty before deleting sidecars',
          );
        }
        await this.checkpointEntry(entry);
        const paths = this.resolvePaths(scope);
        await Promise.all([
          this.deletePersistedFileFamily(paths.tabs),
          this.deletePersistedFileFamily(paths.archives),
          this.deletePersistedFileFamily(paths.journal),
        ]);
      });
    } catch (error) {
      entry.lifecycle = 'ready';
      throw error;
    }
    entry.lifecycle = 'disposed';
    this.scopes.delete(id);
  }

  public getLifecycle(scope: ChatScopeKey): ChatScopeLifecycle {
    return this.scopes.get(scopeId(scope))?.lifecycle ?? 'unloaded';
  }

  public getDiagnostics(scope: ChatScopeKey): readonly ChatJournalDiagnostic[] {
    return this.scopes.get(scopeId(scope))?.diagnostics ?? [];
  }

  public getStorageDiagnostics(
    scope: ChatScopeKey,
  ): readonly ChatStateStorageDiagnostic[] {
    return this.scopes.get(scopeId(scope))?.storageDiagnostics ?? [];
  }

  public subscribeStorageDiagnostics(
    listener: (diagnostic: ChatStateStorageDiagnostic) => void,
  ): () => void {
    this.storageDiagnosticListeners.push(listener);
    return () => {
      const index = this.storageDiagnosticListeners.indexOf(listener);
      if (index >= 0) this.storageDiagnosticListeners.splice(index, 1);
    };
  }

  private getEntry(scope: ChatScopeKey): ScopeEntry {
    const id = scopeId(scope);
    let entry = this.scopes.get(id);
    if (!entry) {
      if (!this.acceptingScopes) {
        throw new Error('Chat state repository is draining');
      }
      entry = {
        key: { ...scope },
        lifecycle: 'unloaded',
        revision: 0,
        tail: Promise.resolve(),
        records: [],
        journalBytes: 0,
        tabsSnapshotRevision: 0,
        archivesSnapshotRevision: 0,
        receipts: new Map(),
        mutationIds: new Set(),
        removedTabIds: new Set(),
        removedArchiveEntryIds: new Set(),
        removedMessageIds: new Set(),
        removedMessageKeys: new Set(),
        diagnostics: [],
        storageDiagnostics: [],
        checkpointAbortCount: 0,
      };
      this.scopes.set(id, entry);
    }
    return entry;
  }

  private async ensureLoaded(entry: ScopeEntry): Promise<void> {
    if (entry.lifecycle === 'ready' || entry.lifecycle === 'draining') return;
    if (entry.lifecycle === 'recovery_error') {
      throw (
        entry.loadError ??
        new ChatStateRepositoryLoadError('Chat scope recovery failed')
      );
    }
    if (entry.lifecycle === 'disposed')
      throw new Error('Chat scope is disposed');
    if (!entry.loadPromise) {
      entry.lifecycle = 'loading';
      entry.loadPromise = this.loadEntry(entry).catch((error: unknown) => {
        entry.lifecycle = 'recovery_error';
        entry.loadError =
          error instanceof ChatStateRepositoryLoadError
            ? error
            : new ChatStateRepositoryLoadError(
                `Unable to recover chat state for ${entry.key.projectId}/${entry.key.worktreeId}`,
                { cause: error },
              );
        throw entry.loadError;
      });
    }
    await entry.loadPromise;
  }

  /**
   * A snapshot query is the explicit recovery retry boundary. Mutating APIs
   * continue to call ensureLoaded directly and therefore fail closed while a
   * scope is in recovery_error; only a subsequent read may discard the cached
   * failed-load bookkeeping and re-read repaired/transiently unavailable
   * sidecars.
   */
  private resetFailedLoad(entry: ScopeEntry): void {
    entry.lifecycle = 'unloaded';
    entry.state = undefined;
    entry.revision = 0;
    entry.records = [];
    entry.journalBytes = 0;
    entry.tabsSnapshotRevision = 0;
    entry.archivesSnapshotRevision = 0;
    entry.receipts.clear();
    entry.mutationIds.clear();
    entry.removedTabIds.clear();
    entry.removedArchiveEntryIds.clear();
    entry.removedMessageIds.clear();
    entry.removedMessageKeys.clear();
    entry.diagnostics = [];
    entry.storageDiagnostics = [];
    entry.checkpointAbortCount = 0;
    delete entry.checkpointRequiredSince;
    delete entry.checkpointTimerRequired;
    delete entry.loadPromise;
    delete entry.loadError;
    delete entry.writeProtected;
  }

  private async loadEntry(entry: ScopeEntry): Promise<void> {
    const paths = this.resolvePaths(entry.key);
    const [tabsResult, archivesResult, journal] = await Promise.all([
      readSnapshot(paths.tabs, isChatTabsSnapshot),
      readSnapshot(paths.archives, isArchivedSnapshot),
      readChatJournal(paths.journal),
    ]);
    entry.diagnostics.push(...journal.diagnostics);
    entry.records = journal.records;
    entry.journalBytes = journal.byteLength;
    this.emitStorageDiagnostic(entry, {
      kind: 'journal_loaded',
      journalBytes: journal.byteLength,
      recordCount: journal.stats.recordCount,
      maxRecordBytes: journal.stats.maxRecordBytes,
      meanRecordBytes: journal.stats.meanRecordBytes,
    });

    let tabs = tabsResult.value;
    let archives = archivesResult.value;
    let hasUnrecoverableSnapshot = false;
    if (!tabs && tabsResult.primaryError !== undefined) {
      hasUnrecoverableSnapshot = true;
      entry.writeProtected = true;
      entry.diagnostics.push({
        kind: 'unrecoverable_snapshot',
        message: `Unable to recover chat snapshot for ${entry.key.projectId}/${entry.key.worktreeId}; writes are blocked until recovery succeeds`,
      });
    }
    if (!archives && archivesResult.primaryError !== undefined) {
      hasUnrecoverableSnapshot = true;
      entry.writeProtected = true;
      entry.diagnostics.push({
        kind: 'unrecoverable_snapshot',
        message: `Unable to recover archive snapshot for ${entry.key.projectId}/${entry.key.worktreeId}; writes are blocked until recovery succeeds`,
      });
    }
    if (hasUnrecoverableSnapshot) {
      throw new ChatStateRepositoryLoadError(
        `Unable to recover canonical chat snapshots for ${entry.key.projectId}/${entry.key.worktreeId}`,
      );
    }
    if (tabsResult.usedBackup && tabs) {
      await preserveSnapshotConflict(
        paths.tabs,
        getChatStateConflictFilePath(paths.tabs),
      ).catch(() => undefined);
      await restoreSnapshotPrimary(paths.tabs, tabs);
    }
    if (archivesResult.usedBackup && archives) {
      await preserveSnapshotConflict(
        paths.archives,
        getChatStateConflictFilePath(paths.archives),
      ).catch(() => undefined);
      await restoreSnapshotPrimary(paths.archives, archives);
    }
    const maxJournalRevision =
      journal.records[journal.records.length - 1]?.revision ?? 0;
    if (tabs && !tabsResult.usedBackup) {
      const backup = await readSnapshot(
        getChatStateBackupFilePath(paths.tabs),
        isChatTabsSnapshot,
      ).catch((): LoadedSnapshot<ChatTabsFile> => ({ usedBackup: false }));
      if (
        backup.value &&
        persistedFileRevision(backup.value) > persistedFileRevision(tabs) &&
        maxJournalRevision >= persistedFileRevision(backup.value)
      ) {
        const primaryRevision = persistedFileRevision(tabs);
        const backupRevision = persistedFileRevision(backup.value);
        await preserveSnapshotConflict(
          paths.tabs,
          getChatStateConflictFilePath(paths.tabs),
        );
        tabs = backup.value;
        await restoreSnapshotPrimary(paths.tabs, tabs);
        entry.diagnostics.push({
          kind: 'regressed_snapshot',
          message: `Recovered chat snapshot revision ${backupRevision} after the primary moved backward to revision ${primaryRevision}`,
        });
      }
    }
    if (archives && !archivesResult.usedBackup) {
      const backup = await readSnapshot(
        getChatStateBackupFilePath(paths.archives),
        isArchivedSnapshot,
      ).catch((): LoadedSnapshot<ArchivedChatsFile> => ({ usedBackup: false }));
      if (
        backup.value &&
        persistedFileRevision(backup.value) > persistedFileRevision(archives) &&
        maxJournalRevision >= persistedFileRevision(backup.value)
      ) {
        const primaryRevision = persistedFileRevision(archives);
        const backupRevision = persistedFileRevision(backup.value);
        await preserveSnapshotConflict(
          paths.archives,
          getChatStateConflictFilePath(paths.archives),
        );
        archives = backup.value;
        await restoreSnapshotPrimary(paths.archives, archives);
        entry.diagnostics.push({
          kind: 'regressed_snapshot',
          message: `Recovered archive snapshot revision ${backupRevision} after the primary moved backward to revision ${primaryRevision}`,
        });
      }
    }

    const tabsRevision = tabs ? persistedFileRevision(tabs) : 0;
    const archivesRevision = archives ? persistedFileRevision(archives) : 0;
    entry.tabsSnapshotRevision = tabsRevision;
    entry.archivesSnapshotRevision = archivesRevision;
    // Canonicalize legacy pre-rename tab fields on load, exactly as the
    // pre-cutover renderer hydration used to (and then persisted back).
    const normalizedTabs = normalizeLegacyChatTabsFile(
      tabs ?? createEmptyChatTabsFile(),
    );
    const normalizedArchives = archives ?? createEmptyArchivedChatsFile();
    const repairedSnapshots = repairLegacySnapshots(normalizedTabs, {
      ...normalizedArchives,
      archived: normalizedArchives.archived.map((entry) => {
        const tab = normalizeLegacyPersistedChatTab(entry.tab);
        return tab === entry.tab ? entry : { ...entry, tab };
      }),
    });
    if (repairedSnapshots.repaired) {
      entry.diagnostics.push({
        kind: 'repaired_snapshot',
        message: `Repaired legacy chat snapshot invariants for ${entry.key.projectId}/${entry.key.worktreeId}`,
      });
    }
    let state: CanonicalChatState = {
      tabsFile: repairedSnapshots.tabsFile,
      archivesFile: repairedSnapshots.archivesFile,
      runtimeByChatId: initialRuntime(repairedSnapshots.tabsFile),
    };

    const byRevision = new Map<number, ChatJournalRecord>();
    for (const record of journal.records) {
      const duplicate = byRevision.get(record.revision);
      if (duplicate && !sameRecord(duplicate, record)) {
        this.fallbackFromCorruptJournal(
          entry,
          `Conflicting duplicate chat revision ${record.revision}`,
        );
        return;
      }
      byRevision.set(record.revision, record);
    }
    const ordered = Array.from(byRevision.values()).sort(
      (a, b) => a.revision - b.revision,
    );
    const latestTabLifecycle = new Map<
      string,
      {
        type: 'tab.created' | 'tab.removed';
        revision: number;
        mutationIndex: number;
      }
    >();
    for (const record of ordered) {
      record.mutations.forEach((mutation, mutationIndex) => {
        if (mutation.type === 'tab.created') {
          const priorLifecycle = latestTabLifecycle.get(mutation.tab.id);
          if (!priorLifecycle || priorLifecycle.type === 'tab.removed') {
            latestTabLifecycle.set(mutation.tab.id, {
              type: mutation.type,
              revision: record.revision,
              mutationIndex,
            });
          }
        } else if (mutation.type === 'tab.removed') {
          latestTabLifecycle.set(mutation.tabId, {
            type: mutation.type,
            revision: record.revision,
            mutationIndex,
          });
        }
      });
    }
    const replayFloor = Math.min(tabsRevision, archivesRevision);
    const newer = ordered.filter((record) => record.revision > replayFloor);
    const replayedMutations: ChatCoreMutation[] = [];
    const replayedDurableMutations: ChatCoreMutation[] = [];
    let expected = replayFloor + 1;
    for (const record of newer) {
      if (record.revision !== expected) {
        this.fallbackFromCorruptJournal(
          entry,
          `Chat journal revision gap: expected ${expected}, found ${record.revision}`,
        );
        return;
      }
      expected += 1;
    }

    for (const record of journal.records) {
      this.indexRecord(entry, record);
    }

    const revision = Math.max(
      tabsRevision,
      archivesRevision,
      ordered[ordered.length - 1]?.revision ?? 0,
    );
    try {
      for (const record of ordered) {
        const mutations = record.mutations.filter((mutation, mutationIndex) => {
          const component = mutationComponent(mutation);
          if (component === 'runtime') {
            if (mutation.type !== 'runtime.patched') return true;
            const lifecycle = latestTabLifecycle.get(mutation.chatId);
            if (!lifecycle) {
              return state.tabsFile.tabs.some(
                (tab) => tab.id === mutation.chatId,
              );
            }
            if (lifecycle.type === 'tab.removed') return false;
            return (
              record.revision > lifecycle.revision ||
              (record.revision === lifecycle.revision &&
                mutationIndex > lifecycle.mutationIndex)
            );
          }
          if (component === 'tabs') return record.revision > tabsRevision;
          return record.revision > archivesRevision;
        });
        if (mutations.length > 0) {
          state = reduceChatState(state, mutations);
          replayedMutations.push(...mutations);
          replayedDurableMutations.push(
            ...mutations.filter(
              (mutation) => mutationComponent(mutation) !== 'runtime',
            ),
          );
        }
      }

      state = {
        ...state,
        tabsFile: { ...state.tabsFile, ...(revision ? { revision } : {}) },
        archivesFile: {
          ...state.archivesFile,
          ...(revision ? { revision } : {}),
        },
      };
      validateCanonicalChatState(state);
    } catch (error) {
      this.fallbackFromCorruptJournal(
        entry,
        `Unable to replay chat journal: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (!entry.writeProtected) {
      const completedAt = this.now();
      const interruptedMutations: ChatCoreMutation[] = Object.entries(
        this.hasLiveDependency(entry.key) ? {} : state.runtimeByChatId,
      ).flatMap(([chatId, runtime]) => {
        if (
          !['starting', 'streaming', 'awaiting_input', 'completing'].includes(
            runtime.status,
          )
        ) {
          return [];
        }
        const tab = state.tabsFile.tabs.find(
          (candidate) => candidate.id === chatId,
        );
        return buildPersistedTurnInterruptedMutations(
          chatId,
          tab && tab.kind !== 'file' ? tab.messages : [],
          runtime,
          completedAt,
          runtime.queuedMessageIds,
          tab && tab.kind !== 'file' ? tab : undefined,
        );
      });
      // Managed child evidence outlives root turns. Replay only on a cold scope,
      // without acquiring credentials, native workers, or delivery claims.
      const { loadDelegationRecoveryMutations } =
        await import('../agents/delegation/recovery');
      const settledState = reduceChatState(state, interruptedMutations);
      interruptedMutations.push(
        ...(await loadDelegationRecoveryMutations(
          entry.key,
          settledState.tabsFile,
          settledState.archivesFile,
        )),
      );
      if (interruptedMutations.length > 0) {
        const recoveryRevision = revision + 1;
        const recoveryRecord: ChatJournalRecord = {
          v: 1,
          revision: recoveryRevision,
          mutationId: `startup-reconcile:${recoveryRevision}`,
          occurredAt: new Date(this.now()).toISOString(),
          source: 'provider',
          mutations: interruptedMutations,
        };
        entry.journalBytes += await appendChatJournalRecord(
          paths.journal,
          recoveryRecord,
        );
        entry.records.push(recoveryRecord);
        this.indexRecord(entry, recoveryRecord);
        state = reduceChatState(state, interruptedMutations);
        replayedMutations.push(...interruptedMutations);
        state = {
          ...state,
          tabsFile: { ...state.tabsFile, revision: recoveryRevision },
          archivesFile: { ...state.archivesFile, revision: recoveryRevision },
        };
        entry.revision = recoveryRevision;
      }
    }
    entry.state = state;
    if (entry.revision === 0) entry.revision = revision;
    if (!entry.writeProtected && replayedDurableMutations.length > 0) {
      await this.checkpointEntry(entry);
    }
    entry.lifecycle = 'ready';
    if (
      entry.revision > replayFloor &&
      replayedMutations.length > 0 &&
      entry.state
    ) {
      const recoveryRecord: ChatJournalRecord = {
        v: 1,
        revision: entry.revision,
        mutationId: `startup-materialize:${entry.revision}`,
        occurredAt: new Date(this.now()).toISOString(),
        source: 'migration',
        mutations: replayedMutations,
      };
      try {
        await this.onCommit?.({
          projectId: entry.key.projectId,
          worktreeId: entry.key.worktreeId,
          baseRevision: replayFloor,
          revision: entry.revision,
          record: recoveryRecord,
          state: entry.state,
          applied: false,
        });
      } catch {
        // Recovery is durable; derived projections are post-commit observers.
      }
    }
  }

  private fallbackFromCorruptJournal(entry: ScopeEntry, message: string): void {
    entry.writeProtected = true;
    entry.diagnostics.push({
      kind: 'unrecoverable_journal',
      message: `${message}; preserving the corrupt journal and refusing to fabricate empty chat state`,
    });
    entry.records = [];
    entry.tabsSnapshotRevision = 0;
    entry.archivesSnapshotRevision = 0;
    entry.receipts.clear();
    entry.mutationIds.clear();
    entry.removedTabIds.clear();
    entry.removedArchiveEntryIds.clear();
    entry.removedMessageIds.clear();
    entry.removedMessageKeys.clear();
    entry.revision = 0;
    entry.state = undefined;
    entry.loadError = new ChatStateRepositoryLoadError(message);
    entry.lifecycle = 'recovery_error';
  }

  private indexRecord(entry: ScopeEntry, record: ChatJournalRecord): void {
    addBounded(entry.mutationIds, record.mutationId, RECENT_MUTATION_RETENTION);
    if (record.commandResult) {
      entry.receipts.delete(record.commandResult.commandId);
      entry.receipts.set(record.commandResult.commandId, record.commandResult);
      while (entry.receipts.size > RECEIPT_RETENTION) {
        const oldestCommandId = entry.receipts.keys().next().value;
        if (oldestCommandId === undefined) break;
        entry.receipts.delete(oldestCommandId);
      }
    }
    for (const mutation of record.mutations) {
      if (mutation.type === 'tab.removed') {
        addBounded(entry.removedTabIds, mutation.tabId, TOMBSTONE_RETENTION);
      } else if (mutation.type === 'archive.removed') {
        addBounded(
          entry.removedArchiveEntryIds,
          mutation.archiveEntryId,
          TOMBSTONE_RETENTION,
        );
      } else if (mutation.type === 'message.removed') {
        addBounded(
          entry.removedMessageKeys,
          JSON.stringify([mutation.chatId, mutation.messageId]),
          TOMBSTONE_RETENTION,
        );
        addBounded(
          entry.removedMessageIds,
          mutation.messageId,
          TOMBSTONE_RETENTION,
        );
      } else if (mutation.type === 'messages.replaced') {
        for (const messageId of mutation.removedMessageIds) {
          addBounded(
            entry.removedMessageKeys,
            JSON.stringify([mutation.chatId, messageId]),
            TOMBSTONE_RETENTION,
          );
          addBounded(entry.removedMessageIds, messageId, TOMBSTONE_RETENTION);
        }
      }
    }
  }

  private emitStorageDiagnostic(
    entry: ScopeEntry,
    diagnostic: Omit<
      ChatStateStorageDiagnostic,
      'occurredAt' | 'storageAuthority' | 'projectId' | 'worktreeId'
    >,
  ): void {
    const event: ChatStateStorageDiagnostic = {
      ...diagnostic,
      occurredAt: new Date(this.now()).toISOString(),
      storageAuthority: 'v1',
      projectId: entry.key.projectId,
      worktreeId: entry.key.worktreeId,
    };
    entry.storageDiagnostics.push(event);
    if (entry.storageDiagnostics.length > 256) {
      entry.storageDiagnostics.splice(0, entry.storageDiagnostics.length - 256);
    }
    for (const listener of this.storageDiagnosticListeners) {
      try {
        listener(event);
      } catch {
        // Diagnostics are best-effort and cannot alter durability outcomes.
      }
    }
  }

  private serialize<T>(entry: ScopeEntry, work: () => Promise<T>): Promise<T> {
    const result = entry.tail.then(work, work);
    entry.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private preemptScheduledCheckpoint(entry: ScopeEntry): void {
    if (entry.checkpointInProgress) entry.checkpointAbortRequested = true;
  }

  private scheduleCheckpoint(
    entry: ScopeEntry,
    delayMs: number,
    required = false,
    preserveExisting = false,
  ): void {
    if (required && entry.checkpointRequiredSince === undefined) {
      entry.checkpointRequiredSince = this.now();
    }
    if (entry.checkpointTimer) {
      if (
        preserveExisting ||
        (entry.checkpointRequiredSince !== undefined &&
          entry.checkpointTimerRequired === true)
      ) {
        return;
      }
      clearTimeout(entry.checkpointTimer);
    }
    entry.checkpointTimerRequired =
      required || entry.checkpointRequiredSince !== undefined;
    entry.checkpointTimer = setTimeout(() => {
      delete entry.checkpointTimer;
      delete entry.checkpointTimerRequired;
      const requiredForMs =
        entry.checkpointRequiredSince === undefined
          ? 0
          : Math.max(0, this.now() - entry.checkpointRequiredSince);
      const forced =
        entry.checkpointRequiredSince !== undefined &&
        (entry.checkpointAbortCount >= this.maxCheckpointAborts ||
          requiredForMs >= this.maxCheckpointDeferralMs);
      if (forced) {
        const details = {
          journalBytes: entry.journalBytes,
          recordCount: entry.records.length,
          checkpointAbortCount: entry.checkpointAbortCount,
        };
        this.emitStorageDiagnostic(entry, {
          kind: 'checkpoint_starvation',
          ...details,
        });
        this.emitStorageDiagnostic(entry, {
          kind: 'checkpoint_forced',
          ...details,
        });
      }
      entry.checkpointInProgress = true;
      entry.checkpointAbortRequested = false;
      void this.serialize(entry, () => this.checkpointEntry(entry, !forced))
        .catch(() => undefined)
        .finally(() => {
          entry.checkpointInProgress = false;
          entry.checkpointAbortRequested = false;
        });
    }, delayMs);
    entry.checkpointTimer.unref?.();
  }

  private handleCheckpointAbort(
    entry: ScopeEntry,
    checkpointStartedAt: number,
  ): void {
    entry.checkpointAbortCount += 1;
    this.emitStorageDiagnostic(entry, {
      kind: 'checkpoint_aborted',
      journalBytes: entry.journalBytes,
      recordCount: entry.records.length,
      checkpointAbortCount: entry.checkpointAbortCount,
      checkpointDurationMs: Math.max(0, this.now() - checkpointStartedAt),
    });
    if (entry.lifecycle === 'ready' && this.acceptingScopes) {
      this.scheduleCheckpoint(entry, this.checkpointIdleMs, true, true);
    }
  }

  private async deletePersistedFileFamily(filePath: string): Promise<void> {
    const directory = dirname(filePath);
    const fileName = basename(filePath);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry === fileName ||
            entry === `${fileName}.bak` ||
            entry.startsWith(`${fileName}.conflict-`) ||
            entry.startsWith(`${fileName}.quarantine-`) ||
            (entry.startsWith(`.${fileName}.`) && entry.endsWith('.tmp')),
        )
        .map((entry) => rm(join(directory, entry), { force: true })),
    );
    await fsyncDirectory(directory);
  }

  private async checkpointEntry(
    entry: ScopeEntry,
    abortible = false,
  ): Promise<void> {
    if (!entry.state || entry.revision === 0 || entry.writeProtected) return;
    const checkpointStartedAt = this.now();
    const paths = this.resolvePaths(entry.key);
    const checkpointRevision = entry.revision;
    const backupRecoveryFloor = Math.min(
      entry.tabsSnapshotRevision,
      entry.archivesSnapshotRevision,
    );
    const tabs = { ...entry.state.tabsFile, revision: checkpointRevision };
    const archives = {
      ...entry.state.archivesFile,
      revision: checkpointRevision,
    };
    const shouldAbort = (): boolean =>
      abortible && entry.checkpointAbortRequested === true;
    const writeOptions = abortible ? { shouldAbort } : {};
    const tempResults = await Promise.allSettled([
      this.writeSyncedJsonTemp(paths.tabs, tabs, writeOptions),
      this.writeSyncedJsonTemp(paths.archives, archives, writeOptions),
    ]);
    const completedTemps = tempResults.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const failedTemp = tempResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failedTemp || shouldAbort()) {
      await Promise.all(
        completedTemps.map((tempPath) =>
          rm(tempPath, { force: true }).catch(() => undefined),
        ),
      );
      if (
        shouldAbort() ||
        (failedTemp && isCooperativeJsonWriteAbortedError(failedTemp.reason))
      ) {
        this.handleCheckpointAbort(entry, checkpointStartedAt);
        return;
      }
      throw failedTemp?.reason;
    }
    const [tabsTemp, archivesTemp] = completedTemps;
    if (!tabsTemp || !archivesTemp) {
      throw new Error('Chat checkpoint did not materialize both components');
    }
    await replaceSnapshotWithBackup(
      tabsTemp,
      paths.tabs,
      getChatStateBackupFilePath(paths.tabs),
    );
    await replaceSnapshotWithBackup(
      archivesTemp,
      paths.archives,
      getChatStateBackupFilePath(paths.archives),
    );
    await Promise.all(
      Array.from(new Set([dirname(paths.tabs), dirname(paths.archives)])).map(
        fsyncDirectory,
      ),
    );
    entry.tabsSnapshotRevision = checkpointRevision;
    entry.archivesSnapshotRevision = checkpointRevision;
    entry.state = { ...entry.state, tabsFile: tabs, archivesFile: archives };
    const retained = this.compactionRecords(entry.records, backupRecoveryFloor);
    try {
      await replaceChatJournal(paths.journal, retained, writeOptions);
    } catch (error) {
      if (isCooperativeJsonWriteAbortedError(error)) {
        this.handleCheckpointAbort(entry, checkpointStartedAt);
        return;
      }
      throw error;
    }
    entry.records = retained;
    entry.journalBytes = await fileSize(paths.journal);
    entry.checkpointAbortCount = 0;
    delete entry.checkpointRequiredSince;
    this.emitStorageDiagnostic(entry, {
      kind: 'checkpoint_completed',
      journalBytes: entry.journalBytes,
      recordCount: entry.records.length,
      checkpointDurationMs: Math.max(0, this.now() - checkpointStartedAt),
    });
  }

  private compactionRecords(
    records: readonly ChatJournalRecord[],
    backupRecoveryFloor: number,
  ): ChatJournalRecord[] {
    const keep = new Set<ChatJournalRecord>();
    for (const record of records) {
      if (record.revision > backupRecoveryFloor) keep.add(record);
    }
    const receipts = records.filter((record) => record.commandResult);
    for (const record of receipts.slice(-RECEIPT_RETENTION)) keep.add(record);
    const removals = records.filter((record) =>
      record.mutations.some(
        (mutation) =>
          mutation.type === 'tab.removed' ||
          mutation.type === 'archive.removed' ||
          mutation.type === 'message.removed' ||
          (mutation.type === 'messages.replaced' &&
            mutation.removedMessageIds.length > 0),
      ),
    );
    for (const record of removals.slice(-TOMBSTONE_RETENTION)) keep.add(record);
    const latestLifecycle = new Map<
      string,
      { type: 'tab.created' | 'tab.removed'; revision: number }
    >();
    for (const record of records) {
      for (const mutation of record.mutations) {
        if (mutation.type === 'tab.created') {
          const previous = latestLifecycle.get(mutation.tab.id);
          if (!previous || previous.type === 'tab.removed') {
            latestLifecycle.set(mutation.tab.id, {
              type: mutation.type,
              revision: record.revision,
            });
          }
        } else if (mutation.type === 'tab.removed') {
          latestLifecycle.set(mutation.tabId, {
            type: mutation.type,
            revision: record.revision,
          });
        }
      }
    }
    const latestRuntime = new Map<string, ChatJournalRecord>();
    for (const record of records) {
      for (const mutation of record.mutations) {
        if (mutation.type === 'runtime.patched') {
          const lifecycle = latestLifecycle.get(mutation.chatId);
          if (
            lifecycle?.type === 'tab.removed' ||
            (lifecycle?.type === 'tab.created' &&
              record.revision < lifecycle.revision)
          ) {
            continue;
          }
          latestRuntime.set(mutation.chatId, record);
        }
      }
    }
    for (const record of Array.from(latestRuntime.values())) keep.add(record);
    return records.filter((record) => keep.has(record));
  }
}
