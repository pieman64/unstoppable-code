import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { getStandaloneHistoryStorage } from '../lib/standalone-history';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { DELTA_JOURNAL_FILE_NAME } from '../lib/chat-delta-journal/format';
import { ChatTranscriptIntegrityError } from '../lib/chat-transcript-log';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import type { Dirent } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  createThreadedChatSearchIndexer,
  type ThreadedChatSearchIndexer,
} from './threaded-indexer';
import { BrowserWindow } from 'electron';
import {
  APP_ADVISOR_PROJECT_ID,
  COWORK_HOME_WORKTREE_ID,
  IPC_CHANNELS,
  STANDALONE_CHAT_PROJECT_ID,
  type ChatSearchCatalogEntry,
  type ChatSearchQueryRequest,
  type ChatSearchResult,
  type ChatTabsFile,
  type ArchivedChatsFile,
  type ArchivedContainerManifest,
  type PersistedChatMessage,
  type PersistedChatTab,
  type TrackedPlanReviewStatus,
  type WorkspaceContext,
  type WorkspaceOwnerBinding,
  type WorktreeSummaryData,
} from '@canopy/desktop-shared/types';
import { workspaceOwnerMatchesContext } from '@canopy/desktop-shared/lib/workspace-owner';
import {
  getAppManagedChatWorkspaceDir,
  getArchivedContainerManifestPath,
  getArchivedContainerSummaryPath,
  getArchivedContainersRootDir,
  getChatSearchIndexPath,
  getWorkspaceChatArchivesFilePath,
  getWorkspaceChatHistoryDir,
  getWorkspaceChatHistoryRootDir,
  getWorkspaceChatTabsFilePath,
  getWorkspaceDir,
  getWorkspacesRootDir,
  getWorkspaceTrackedPlansFilePath,
} from '../lib/paths';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { isErrnoException, isRecord } from '../lib/type-guards';
import { validateId } from '../lib/validation';
import { readChatTabsFileForIndex } from '../lib/chat-tabs-reader';
import { readChatArchivesFileForIndex } from '../lib/chat-archives';
import {
  readArchiveMetaForIndex,
  readArchiveSnapshotForIndex,
} from '../lib/standalone-history';
import {
  type ChatSearchIndexer,
  buildChatSearchDoc,
  buildArchivedContainerEntityDoc,
  buildPlanSearchDoc,
  committedTranscriptFingerprint,
  extractChatSearchBody,
  transcriptFingerprint,
  type ChatSearchDoc,
  type ChatSearchSource,
  type SourceFingerprint,
  type TrackedPlanIndexEntry,
} from './indexer';
import { openChatSearchDatabase } from './schema';
import { requireSqliteRow } from './sqlite-rows';
import {
  readArchivedContainerChatArchives,
  getArchivedContainerChatStorage,
  readArchivedContainerChats,
  readArchivedContainerManifest,
  readArchivedContainerTrackedPlans,
} from '../lib/archived-containers';
import { isWorktreeSummaryData } from '../lib/worktree-summary-persistence';
import {
  chatSearchQueryExceedsBodyThreshold,
  mapChatSearchCatalogRow,
  normalizeQueryRequest,
  queryChatSearchDatabase,
} from './query';
import { ChatSearchQueryRunner } from './query-runner';
import { ActiveTurnSearchText } from './active-turn-text';
import type { ActiveTurnDelta } from '../lib/chat-delta-journal/active-turn';
import { sendToWebContents } from '../lib/web-contents-send';
import { readWorkspaceConfigDetailed } from '../lib/workspace-persistence';

const DEFAULT_CATALOG_LIMIT = 2_000;
const DEFAULT_BROADCAST_DEBOUNCE_MS = 50;
const LARGE_QUERY_BODY_THRESHOLD_BYTES = 16 * 1024 * 1024;

class StaleSearchProjectionError extends Error {}

type SourceKind = ChatSearchSource;

const CHAT_SEARCH_SOURCES: readonly ChatSearchSource[] = [
  'live',
  'worktree-archive',
  'cowork-archive',
  'plan',
  'archived-container',
];

function isChatSearchSource(value: unknown): value is ChatSearchSource {
  return (
    typeof value === 'string' &&
    CHAT_SEARCH_SOURCES.some((source) => source === value)
  );
}

const PLAN_REVIEW_STATUSES: readonly TrackedPlanReviewStatus[] = [
  'pending',
  'approved',
  'dismissed',
];

function asPlanReviewStatus(value: unknown): TrackedPlanReviewStatus | null {
  return PLAN_REVIEW_STATUSES.find((status) => status === value) ?? null;
}

interface SourceDescriptor {
  fileKey: string;
  kind: SourceKind;
  projectId: string;
  worktreeId: string;
  worktreeGeneration: number;
  archiveContentEpoch?: number;
  chatId?: string;
  fingerprint: SourceFingerprint;
}

interface PendingUpdate {
  timer: ReturnType<typeof setTimeout>;
  task: () => Promise<void> | void;
  liveTabsUpdate?: PendingLiveTabsUpdate;
}

interface PendingLiveTabChanges {
  kind: 'delta';
  generation: number;
  contentEpoch: number;
  tabsById: Map<string, PersistedChatTab | null>;
}

interface PendingFullLiveTabsUpdate {
  kind: 'full';
  generation: number;
  contentEpoch: number;
}

type PendingLiveTabsUpdate = PendingLiveTabChanges | PendingFullLiveTabsUpdate;

type SearchWorkspaceOwner = Pick<
  WorkspaceOwnerBinding,
  'type' | 'organizationId'
>;
/**
 * `undefined` is a Personal workspace; `null` means no workspace config exists.
 * Scoped search hides the latter because its owner cannot be established. The
 * intentional App Advisor exception is handled explicitly by project id.
 */
type ResolveWorkspaceOwner = (
  workspaceId: string,
) => Promise<SearchWorkspaceOwner | undefined | null>;

export interface ChatSearchServiceOptions {
  dbPath?: string;
  /** Explicit deterministic adapter for repository/unit tests. Production always uses the thread. */
  indexerFactory?: (db: DatabaseSync) => ChatSearchIndexer;
  /** Creates the worker-backed indexer; replaceable so tests can fail it. */
  threadedIndexerFactory?: (dbPath: string) => ThreadedChatSearchIndexer;
  debounceMs?: number;
  broadcastDebounceMs?: number;
  broadcastUpdated?: () => void;
  /**
   * Aggregate ranked-body size that routes a query to the utility worker.
   * Overridable so tests can exercise the worker and recovery paths without
   * materializing multi-megabyte transcripts.
   */
  largeQueryBodyThresholdBytes?: number;
  /** Injectable authoritative owner lookup for context-scoping tests. */
  resolveWorkspaceOwner?: ResolveWorkspaceOwner;
}

async function resolvePersistedWorkspaceOwner(
  workspaceId: string,
): Promise<WorkspaceOwnerBinding | undefined | null> {
  if (workspaceId === APP_ADVISOR_PROJECT_ID) return null;
  const { config, authority, ownerMalformed } =
    await readWorkspaceConfigDetailed(workspaceId);
  return authority !== 'ok' || ownerMalformed ? null : config.owner;
}

function broadcastChatSearchUpdated(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      sendToWebContents(window.webContents, IPC_CHANNELS.chatSearchUpdated);
    }
  }
}

export { parseChatSearchSnippet, sanitizeChatSearchQuery } from './query';

async function safeReadDir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }
}

async function readArchivedSummaryForIndex(
  projectId: string,
  containerId: string,
): Promise<WorktreeSummaryData | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(
        getArchivedContainerSummaryPath(projectId, containerId),
        'utf8',
      ),
    );
    if (
      isRecord(parsed) &&
      'summary' in parsed &&
      isWorktreeSummaryData(parsed.summary)
    ) {
      return parsed.summary;
    }
  } catch {
    // Captured summaries are optional derived context for search.
  }
  return null;
}

async function safeFingerprint(
  path: string,
): Promise<SourceFingerprint | null> {
  try {
    const info = await stat(path);
    return {
      mtimeMs: Math.trunc(info.mtimeMs),
      sizeBytes: info.size,
    };
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function coworkArchiveFingerprint(
  directory: string,
): Promise<SourceFingerprint | null> {
  const fingerprints = await Promise.all(
    [
      directory,
      join(directory, 'meta.json'),
      join(directory, 'conversation.json'),
    ].map(safeFingerprint),
  );
  const existing = fingerprints.filter(
    (value): value is SourceFingerprint => value !== null,
  );
  if (existing.length === 0) return null;
  return {
    mtimeMs: Math.max(...existing.map((value) => value.mtimeMs)),
    sizeBytes: existing.reduce((total, value) => total + value.sizeBytes, 0),
  };
}

function yieldToMainLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function getWorkerDatabasePath(database: DatabaseSync): string | null {
  const rows: unknown[] = database.prepare('PRAGMA database_list').all();
  const main = rows
    .map((row) => requireSqliteRow(row))
    .find((row) => row.name === 'main');
  return typeof main?.file === 'string' && main.file.length > 0
    ? main.file
    : null;
}

/**
 * Strict tracked-plans reader for the index's own scan path. Deliberately
 * does not import `plan-persistence` (which hooks back into this service on
 * write) and validates only the fields the index consumes. File-level parse
 * and schema failures abort indexing so retained rows are not erased, while
 * individually malformed plan entries are skipped.
 */
async function readTrackedPlansForIndex(
  filePath: string,
): Promise<TrackedPlanIndexEntry[]> {
  const contents = await readFile(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`Invalid tracked plans JSON: ${filePath}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Invalid tracked plans file: ${filePath}`);
  }
  const plansValue: unknown = parsed.plans;
  if (!Array.isArray(plansValue)) {
    throw new Error(`Invalid tracked plans file: ${filePath}`);
  }
  const plans: unknown[] = plansValue;
  const entries: TrackedPlanIndexEntry[] = [];
  for (const candidate of plans) {
    if (!isRecord(candidate)) continue;
    const plan = candidate;
    if (
      typeof plan.id !== 'string' ||
      typeof plan.title !== 'string' ||
      typeof plan.content !== 'string'
    ) {
      continue;
    }
    const reviewStatus = asPlanReviewStatus(plan.reviewStatus);
    entries.push({
      id: plan.id,
      title: plan.title,
      content: plan.content,
      ...(typeof plan.hidden === 'boolean' ? { hidden: plan.hidden } : {}),
      ...(typeof plan.createdAt === 'string'
        ? { createdAt: plan.createdAt }
        : {}),
      ...(typeof plan.updatedAt === 'string'
        ? { updatedAt: plan.updatedAt }
        : {}),
      ...(reviewStatus ? { reviewStatus } : {}),
    });
  }
  return entries;
}

/** A transcript projected through a captured preview. */
interface TranscriptPreviewProjection {
  descriptor: NonNullable<PersistedChatTab['transcript']>;
  /** Committed-prefix text; undefined when only the active sidecar was read. */
  committedBody: string | undefined;
  /** Text of the active sidecar's in-flight rows. */
  activeBody: string;
  /** Each in-flight row's text, in order, when the read included them. */
  activeRows?: Array<{ id: string; text: string }>;
  /** The in-flight rows came from a delta journal's in-memory projection. */
  journalProjected?: boolean;
}

function staleProjectionGuard(isCurrent?: () => boolean): () => void {
  return (): void => {
    if (isCurrent && !isCurrent())
      throw new StaleSearchProjectionError('Search projection was superseded');
  };
}

function withTranscriptSplit(
  doc: ChatSearchDoc,
  activeBody: string | undefined,
  committedFingerprint: string | undefined,
): ChatSearchDoc {
  return {
    ...doc,
    ...(activeBody ? { activeBody } : {}),
    ...(committedFingerprint === undefined ? {} : { committedFingerprint }),
  };
}

/**
 * Indexes committed text as the body and in-flight text as a separate row, so
 * an active-sidecar revision can later replace only the in-flight row.
 */
function buildPreviewSearchDoc(
  projectId: string,
  worktreeId: string,
  source: ChatSearchSource,
  tab: PersistedChatTab,
  projection: TranscriptPreviewProjection,
  archivedAt?: string,
  expiresAt?: string,
): ChatSearchDoc {
  return withTranscriptSplit(
    buildChatSearchDoc(
      projectId,
      worktreeId,
      source,
      { ...tab, transcript: projection.descriptor },
      archivedAt,
      expiresAt,
      projection.committedBody ?? '',
    ),
    projection.activeBody,
    committedTranscriptFingerprint(projection.descriptor),
  );
}

/** First wait before replacing a failed index worker; doubles per failure. */
export const CHAT_SEARCH_INDEXER_RECOVERY_DELAY_MS = 30_000;
const CHAT_SEARCH_INDEXER_RECOVERY_MAX_DELAY_MS = 10 * 60_000;

export class ChatSearchService {
  private db: DatabaseSync | null = null;
  private indexer: ChatSearchIndexer | ThreadedChatSearchIndexer | null = null;
  private readonly indexerFactory: ChatSearchServiceOptions['indexerFactory'];
  private readonly threadedIndexerFactory: (
    dbPath: string,
  ) => ThreadedChatSearchIndexer;
  private indexerRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private indexerRecoveryAttempts = 0;
  private readonly hiddenLiveScopes = new Set<string>();
  private readonly dbPath: string;
  private readonly debounceMs: number;
  private readonly broadcastDebounceMs: number;
  private readonly broadcastUpdated: () => void;
  private readonly pendingUpdates = new Map<string, PendingUpdate>();
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private initialScanPromise: Promise<void> | null = null;
  private activeScanPromise: Promise<void> | null = null;
  private activeScanSourceKeys: Set<string> | null = null;
  private closed = false;
  private readonly deletedWorkspaces = new Set<string>();
  private readonly deletedWorktrees = new Set<string>();
  private readonly deletedCoworkArchives = new Set<string>();
  private readonly worktreeGenerations = new Map<string, number>();
  private readonly liveContentEpochs = new Map<string, number>();
  private readonly archiveContentEpochs = new Map<string, number>();
  private queryRunner: ChatSearchQueryRunner | null = null;
  private workerDatabasePath: string | null = null;
  /** In-flight row text of live delta-journal chats (`active-turn-text.ts`). */
  private readonly activeTurnText = new ActiveTurnSearchText((message) =>
    extractChatSearchBody([message]),
  );
  private readonly largeQueryBodyThresholdBytes: number;
  private readonly resolveWorkspaceOwner: ResolveWorkspaceOwner;

  constructor(options: ChatSearchServiceOptions = {}) {
    this.indexerFactory = options.indexerFactory;
    this.threadedIndexerFactory =
      options.threadedIndexerFactory ?? createThreadedChatSearchIndexer;
    this.dbPath = options.dbPath ?? getChatSearchIndexPath();
    this.largeQueryBodyThresholdBytes =
      options.largeQueryBodyThresholdBytes ?? LARGE_QUERY_BODY_THRESHOLD_BYTES;
    this.resolveWorkspaceOwner =
      options.resolveWorkspaceOwner ?? resolvePersistedWorkspaceOwner;
    this.debounceMs = options.debounceMs ?? 500;
    this.broadcastDebounceMs =
      options.broadcastDebounceMs ?? DEFAULT_BROADCAST_DEBOUNCE_MS;
    this.broadcastUpdated =
      options.broadcastUpdated ?? broadcastChatSearchUpdated;
  }

  ensureInitialScan(): void {
    if (this.closed || this.initialScanPromise !== null) return;
    const scan = yieldToMainLoop().then(() => this.scanAllSources());
    this.initialScanPromise = scan;
    void scan.catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Chat search initial scan failed:', error);
      this.recoverFailedIndexer();
      if (this.initialScanPromise === scan) this.initialScanPromise = null;
    });
  }

  async waitForInitialScan(): Promise<void> {
    await this.initialScanPromise;
  }

  async scanAllSources(): Promise<void> {
    if (this.closed) return;
    if (this.activeScanPromise) return this.activeScanPromise;
    const scan = this.performFullScan();
    this.activeScanPromise = scan;
    try {
      await scan;
    } finally {
      if (this.activeScanPromise === scan) this.activeScanPromise = null;
    }
  }

  getCatalog(limit = DEFAULT_CATALOG_LIMIT): ChatSearchCatalogEntry[] {
    if (this.closed) return [];
    const normalizedLimit = Number.isFinite(limit)
      ? Math.max(0, Math.trunc(limit))
      : DEFAULT_CATALOG_LIMIT;
    if (normalizedLimit === 0) return [];
    const database = this.getDatabase();
    const now = Date.now();
    return this.collectVisiblePage(normalizedLimit, (offset) => {
      const rows: unknown[] = database
        .prepare(
          `SELECT doc_id, project_id, worktree_id, chat_id, source, title,
                  document_kind, description, provider_type, updated_at, archived_at,
                  expires_at, message_count, review_status
           FROM chat_docs
           WHERE expires_at IS NULL OR expires_at > ?
           ORDER BY updated_at DESC
           LIMIT ? OFFSET ?`,
        )
        .all(now, normalizedLimit, offset);
      return rows.map((row) => mapChatSearchCatalogRow(requireSqliteRow(row)));
    });
  }

  async getCatalogScoped(
    context: WorkspaceContext | undefined,
    limit = DEFAULT_CATALOG_LIMIT,
    linkedPersonalWorkspaceIds: readonly string[] = [],
  ): Promise<ChatSearchCatalogEntry[]> {
    if (context === undefined) return this.getCatalog(limit);
    if (this.closed) return [];
    const normalizedLimit = Number.isFinite(limit)
      ? Math.max(0, Math.trunc(limit))
      : DEFAULT_CATALOG_LIMIT;
    if (normalizedLimit === 0) return [];
    const database = this.getDatabase();
    const now = Date.now();
    const isVisible = this.createContextVisibilityPredicate(
      context,
      linkedPersonalWorkspaceIds,
    );
    return this.collectVisiblePageAsync(
      normalizedLimit,
      (offset) => {
        const rows: unknown[] = database
          .prepare(
            `SELECT doc_id, project_id, worktree_id, chat_id, source, title,
                    document_kind, description, provider_type, updated_at, archived_at,
                    expires_at, message_count, review_status
             FROM chat_docs
             WHERE expires_at IS NULL OR expires_at > ?
             ORDER BY updated_at DESC
             LIMIT ? OFFSET ?`,
          )
          .all(now, normalizedLimit, offset);
        return Promise.resolve(
          rows.map((row) => mapChatSearchCatalogRow(requireSqliteRow(row))),
        );
      },
      isVisible,
    );
  }

  query(request: ChatSearchQueryRequest): ChatSearchResult[] {
    if (this.closed) return [];
    const normalized = normalizeQueryRequest(request);
    if (!normalized) return [];
    const database = this.getDatabase();
    const now = Date.now();
    const pageRequest = { ...request, limit: normalized.limit };
    return this.collectVisiblePage(normalized.limit, (offset) =>
      queryChatSearchDatabase(database, pageRequest, now, offset),
    );
  }

  async queryResponsive(
    request: ChatSearchQueryRequest,
    context?: WorkspaceContext,
    linkedPersonalWorkspaceIds: readonly string[] = [],
  ): Promise<ChatSearchResult[]> {
    if (this.closed) return [];
    const database = this.getDatabase();
    const normalized = normalizeQueryRequest(request);
    if (!normalized) return [];
    const pageRequest = { ...request, limit: normalized.limit };
    const hasVisibilityExclusions =
      this.deletedWorkspaces.size > 0 ||
      this.deletedWorktrees.size > 0 ||
      this.deletedCoworkArchives.size > 0 ||
      this.hiddenLiveScopes.size > 0;
    const exceedsWorkerThreshold =
      hasVisibilityExclusions ||
      chatSearchQueryExceedsBodyThreshold(
        database,
        pageRequest,
        this.largeQueryBodyThresholdBytes,
      );
    if (!exceedsWorkerThreshold || this.workerDatabasePath === null) {
      // The recovery database is in-memory and has no path a utility process
      // can reopen. Preserve its populated results on the active connection;
      // file-backed oversized queries still use worker isolation below.
      const now = Date.now();
      if (context !== undefined) {
        return this.collectVisiblePageAsync(
          normalized.limit,
          (offset) =>
            Promise.resolve(
              queryChatSearchDatabase(database, pageRequest, now, offset),
            ),
          this.createContextVisibilityPredicate(
            context,
            linkedPersonalWorkspaceIds,
          ),
        );
      }
      return this.collectVisiblePage(normalized.limit, (offset) =>
        queryChatSearchDatabase(database, pageRequest, now, offset),
      );
    }
    this.queryRunner ??= new ChatSearchQueryRunner();
    const queryRunner = this.queryRunner;
    const workerDatabasePath = this.workerDatabasePath;
    try {
      const now = Date.now();
      return await this.collectVisiblePageAsync(
        normalized.limit,
        (offset) =>
          queryRunner.run(workerDatabasePath, pageRequest, now, offset),
        context === undefined
          ? undefined
          : this.createContextVisibilityPredicate(
              context,
              linkedPersonalWorkspaceIds,
            ),
      );
    } catch (error) {
      // `close()` cancels in-flight worker queries. Re-running an oversized
      // projection in-process during shutdown would block the main loop while
      // quitting and race `close()` closing `this.db`, so a cancellation
      // resolves as empty instead of being treated as a worker failure.
      if (this.closed) return [];
      // A missing, timed-out, or failed utility process degrades this one
      // oversized response instead of re-running the expensive SQLite snippet
      // projection synchronously on Electron main. A later settled query gets
      // a fresh one-shot worker attempt through the reusable runner. The
      // failure is still logged: an empty response reads as "no matches",
      // which once hid every oversized query throwing on this path.
      // eslint-disable-next-line no-console
      console.error('Chat search query failed:', error);
      return [];
    }
  }

  indexLiveTabs(
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
  ): void {
    const scope = this.normalizeLiveScope(projectId, worktreeId);
    this.reactivateScope(scope.projectId, scope.worktreeId);
    const generation = this.worktreeGeneration(
      scope.projectId,
      scope.worktreeId,
    );
    const contentEpoch = this.advanceLiveContentEpoch(
      scope.projectId,
      scope.worktreeId,
    );
    const fileKey = this.liveFilePath(scope.projectId, scope.worktreeId);
    this.activeScanSourceKeys?.add(fileKey);
    this.enqueue(
      this.liveUpdateKey(scope.projectId, scope.worktreeId),
      async () => {
        if (
          !this.isWorktreeGenerationCurrent(
            scope.projectId,
            scope.worktreeId,
            generation,
          )
        ) {
          return;
        }
        await this.replaceLiveScope(
          scope.projectId,
          scope.worktreeId,
          data,
          contentEpoch,
        );
        if (
          !this.isLiveContentEpochCurrent(
            scope.projectId,
            scope.worktreeId,
            contentEpoch,
          )
        ) {
          return;
        }
        await this.refreshFingerprint(
          fileKey,
          scope.projectId,
          scope.worktreeId,
          generation,
        );
      },
      { kind: 'full', generation, contentEpoch },
    );
  }

  indexLiveTabChanges(
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
    changedTabIds: readonly string[],
    removedTabIds: readonly string[],
  ): void {
    if (changedTabIds.length === 0 && removedTabIds.length === 0) return;
    const scope = this.normalizeLiveScope(projectId, worktreeId);
    this.reactivateScope(scope.projectId, scope.worktreeId);
    const generation = this.worktreeGeneration(
      scope.projectId,
      scope.worktreeId,
    );
    const contentEpoch = this.advanceLiveContentEpoch(
      scope.projectId,
      scope.worktreeId,
    );
    const fileKey = this.liveFilePath(scope.projectId, scope.worktreeId);
    this.activeScanSourceKeys?.add(fileKey);
    const updateKey = this.liveUpdateKey(scope.projectId, scope.worktreeId);
    const pending = this.pendingUpdates.get(updateKey)?.liveTabsUpdate;
    if (pending?.kind === 'full' && pending.generation === generation) {
      this.indexLiveTabs(scope.projectId, scope.worktreeId, data);
      return;
    }
    const changes =
      pending?.kind === 'delta' && pending.generation === generation
        ? pending
        : {
            kind: 'delta' as const,
            generation,
            contentEpoch,
            tabsById: new Map<string, PersistedChatTab | null>(),
          };
    changes.contentEpoch = contentEpoch;
    const changedIds = new Set(changedTabIds);
    for (const tab of data.tabs) {
      if ((tab.kind ?? 'chat') === 'chat' && changedIds.has(tab.id)) {
        changes.tabsById.set(tab.id, tab);
      }
    }
    for (const chatId of removedTabIds) {
      changes.tabsById.set(chatId, null);
    }
    this.enqueue(
      updateKey,
      async () => {
        const isCurrent = (): boolean =>
          this.isWorktreeGenerationCurrent(
            scope.projectId,
            scope.worktreeId,
            generation,
          ) &&
          this.isLiveContentEpochCurrent(
            scope.projectId,
            scope.worktreeId,
            changes.contentEpoch,
          );
        if (!isCurrent()) return;
        const indexer = this.getIndexer();
        for (const [chatId, tab] of Array.from(changes.tabsById.entries())) {
          await yieldToEventLoop();
          if (!isCurrent()) return;
          if (tab) {
            await this.upsertLiveChat(
              scope.projectId,
              scope.worktreeId,
              tab,
              changes.contentEpoch,
            );
          } else {
            this.activeTurnText.delete(
              `${scope.projectId}/${scope.worktreeId}/${chatId}/live`,
            );
            await indexer.deleteChatDoc(
              scope.projectId,
              scope.worktreeId,
              chatId,
              'live',
            );
          }
        }
        if (!isCurrent()) return;
        await this.refreshFingerprint(
          fileKey,
          scope.projectId,
          scope.worktreeId,
          generation,
        );
      },
      changes,
    );
  }

  worktreeChatArchived(
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): void {
    this.indexWorktreeArchives(projectId, worktreeId);
    const generation = this.worktreeGeneration(projectId, worktreeId);
    const contentEpoch = this.advanceLiveContentEpoch(projectId, worktreeId);
    this.enqueue(this.liveUpdateKey(projectId, worktreeId), async () => {
      if (
        !this.isWorktreeGenerationCurrent(projectId, worktreeId, generation) ||
        !this.isLiveContentEpochCurrent(projectId, worktreeId, contentEpoch)
      ) {
        return;
      }
      await this.getIndexer().deleteChatDoc(
        projectId,
        worktreeId,
        chatId,
        'live',
      );
    });
  }

  worktreeChatRestored(
    projectId: string,
    worktreeId: string,
    tab: PersistedChatTab,
  ): void {
    this.reactivateScope(projectId, worktreeId);
    this.indexWorktreeArchives(projectId, worktreeId);
    const generation = this.worktreeGeneration(projectId, worktreeId);
    const contentEpoch = this.advanceLiveContentEpoch(projectId, worktreeId);
    this.activeScanSourceKeys?.add(this.liveFilePath(projectId, worktreeId));
    this.enqueue(this.liveUpdateKey(projectId, worktreeId), async () => {
      if (
        !this.isWorktreeGenerationCurrent(projectId, worktreeId, generation) ||
        !this.isLiveContentEpochCurrent(projectId, worktreeId, contentEpoch)
      ) {
        return;
      }
      await this.upsertLiveChat(projectId, worktreeId, tab, contentEpoch);
    });
  }

  indexWorktreeArchives(projectId: string, worktreeId: string): void {
    this.reactivateScope(projectId, worktreeId);
    const generation = this.worktreeGeneration(projectId, worktreeId);
    const contentEpoch = this.advanceArchiveContentEpoch(projectId, worktreeId);
    this.activeScanSourceKeys?.add(
      this.worktreeArchiveFilePath(projectId, worktreeId),
    );
    this.enqueue(`archive:${projectId}/${worktreeId}`, async () => {
      if (
        !this.isWorktreeGenerationCurrent(projectId, worktreeId, generation) ||
        !this.isArchiveContentEpochCurrent(projectId, worktreeId, contentEpoch)
      ) {
        return;
      }
      const fileKey = this.worktreeArchiveFilePath(projectId, worktreeId);
      const data = await readChatArchivesFileForIndex(projectId, worktreeId);
      if (
        this.closed ||
        !this.isWorktreeGenerationCurrent(projectId, worktreeId, generation) ||
        !this.isArchiveContentEpochCurrent(projectId, worktreeId, contentEpoch)
      ) {
        return;
      }
      await this.replaceArchiveScope(projectId, worktreeId, data, contentEpoch);
      await this.refreshFingerprint(
        fileKey,
        projectId,
        worktreeId,
        generation,
        contentEpoch,
      );
    });
  }

  /**
   * Debounced tracked-plans reindex for one worktree. `plans` is the freshly
   * written file content when the caller has it (the persistence write hook);
   * omitted, the file is re-read from disk (scan path).
   */
  indexWorktreePlans(
    projectId: string,
    worktreeId: string,
    plans?: readonly TrackedPlanIndexEntry[],
  ): void {
    this.reactivateScope(projectId, worktreeId);
    const generation = this.worktreeGeneration(projectId, worktreeId);
    const fileKey = this.plansFilePath(projectId, worktreeId);
    this.activeScanSourceKeys?.add(fileKey);
    this.enqueue(`plans:${projectId}/${worktreeId}`, async () => {
      if (
        !this.isWorktreeGenerationCurrent(projectId, worktreeId, generation)
      ) {
        return;
      }
      const entries = plans ?? (await readTrackedPlansForIndex(fileKey));
      if (
        this.closed ||
        !this.isWorktreeGenerationCurrent(projectId, worktreeId, generation)
      ) {
        return;
      }
      await this.getIndexer().replaceWorktreePlans(
        projectId,
        worktreeId,
        entries,
      );
      await this.refreshFingerprint(fileKey, projectId, worktreeId, generation);
    });
  }

  async worktreeContainerArchived(
    projectId: string,
    containerId: string,
  ): Promise<void> {
    this.reactivateScope(projectId, containerId);
    this.hiddenLiveScopes.add(`${projectId}/${containerId}`);
    this.advanceWorktreeGeneration(projectId, containerId);
    this.cancelPending(
      (key) =>
        key === this.liveUpdateKey(projectId, containerId) ||
        key === `archive:${projectId}/${containerId}` ||
        key === `plans:${projectId}/${containerId}` ||
        key === `archived-container:${projectId}/${containerId}`,
    );
    const indexer = this.getIndexer();
    await indexer.deleteWorktreeDocs(projectId, containerId);
    await indexer.deleteSourceFile(this.liveFilePath(projectId, containerId));
    await indexer.deleteSourceFile(
      this.worktreeArchiveFilePath(projectId, containerId),
    );
    await indexer.deleteSourceFile(this.plansFilePath(projectId, containerId));
    this.indexArchivedContainer(projectId, containerId);
  }

  async worktreeContainerRestored(
    projectId: string,
    containerId: string,
    destinationId: string,
  ): Promise<void> {
    try {
      await this.worktreeContainerPurged(projectId, containerId);
    } catch (error) {
      // Archived search rows are rebuildable. A closing or saturated worker
      // must not reject a completed restore or skip the destination refresh.
      // eslint-disable-next-line no-console
      console.error(
        '[chat-search] Failed to remove restored archive search rows',
        error,
      );
    }
    this.reactivateScope(projectId, destinationId);
    const generation = this.advanceWorktreeGeneration(projectId, destinationId);
    const archiveContentEpoch = this.advanceArchiveContentEpoch(
      projectId,
      destinationId,
    );
    try {
      const [tabs, archives] = await Promise.all([
        readChatTabsFileForIndex(projectId, destinationId),
        readChatArchivesFileForIndex(projectId, destinationId),
      ]);
      if (
        !this.isWorktreeGenerationCurrent(projectId, destinationId, generation)
      ) {
        return;
      }
      this.indexLiveTabs(projectId, destinationId, tabs);
      await this.replaceArchiveScope(
        projectId,
        destinationId,
        archives,
        archiveContentEpoch,
      );
      this.scheduleUpdatedBroadcast();
    } catch {
      // Search is disposable derived data; restore must still succeed when a
      // best-effort index refresh cannot read the restored chat files.
    }
  }

  async worktreeContainerPurged(
    projectId: string,
    containerId: string,
  ): Promise<void> {
    this.advanceWorktreeGeneration(projectId, containerId);
    this.deletedWorktrees.add(`${projectId}/${containerId}`);
    this.cancelPending(
      (key) => key === `archived-container:${projectId}/${containerId}`,
    );
    const indexer = this.getIndexer();
    await indexer.deleteArchivedContainerDocs(projectId, containerId);
    await indexer.deleteSourceFile(
      getArchivedContainerManifestPath(projectId, containerId),
    );
    this.scheduleUpdatedBroadcast();
  }

  archivedContainerUpdated(projectId: string, containerId: string): void {
    this.advanceWorktreeGeneration(projectId, containerId);
    this.cancelPending(
      (key) => key === `archived-container:${projectId}/${containerId}`,
    );
    this.indexArchivedContainer(projectId, containerId);
  }

  indexArchivedContainer(projectId: string, containerId: string): void {
    const generation = this.worktreeGeneration(projectId, containerId);
    const fileKey = getArchivedContainerManifestPath(projectId, containerId);
    this.activeScanSourceKeys?.add(fileKey);
    this.enqueue(`archived-container:${projectId}/${containerId}`, async () => {
      const [manifest, summary, chats, archives, plans] = await Promise.all([
        readArchivedContainerManifest(projectId, containerId),
        readArchivedSummaryForIndex(projectId, containerId),
        readArchivedContainerChats(projectId, containerId),
        readArchivedContainerChatArchives(projectId, containerId),
        readArchivedContainerTrackedPlans(projectId, containerId),
      ]);
      if (
        this.closed ||
        !this.isWorktreeGenerationCurrent(projectId, containerId, generation)
      ) {
        return;
      }
      await this.replaceContainerScope(
        manifest,
        summary,
        chats,
        archives,
        plans.plans,
        manifest.lockedAt ? undefined : manifest.expiresAt,
      );
      if (
        this.closed ||
        !this.isWorktreeGenerationCurrent(projectId, containerId, generation)
      ) {
        return;
      }
      await this.refreshFingerprint(
        fileKey,
        projectId,
        containerId,
        generation,
      );
    });
  }

  indexCoworkArchive(
    projectId: string,
    tab: PersistedChatTab,
    archivedAt: string,
  ): void {
    const workspaceId = resolveCoworkWorkspaceId(projectId);
    this.deletedCoworkArchives.delete(
      this.coworkArchiveKey(workspaceId, tab.id),
    );
    this.reactivateScope(workspaceId, COWORK_HOME_WORKTREE_ID);
    this.enqueue(
      this.liveUpdateKey(workspaceId, COWORK_HOME_WORKTREE_ID),
      async () => {
        if (this.isScopeDeleted(workspaceId, COWORK_HOME_WORKTREE_ID)) return;
        await this.getIndexer().deleteChatDoc(
          workspaceId,
          COWORK_HOME_WORKTREE_ID,
          tab.id,
          'live',
        );
      },
    );
    const archiveDirectory = this.coworkArchiveDir(workspaceId, tab.id);
    this.activeScanSourceKeys?.add(archiveDirectory);
    this.enqueue(`cowork-archive:${workspaceId}/${tab.id}`, async () => {
      if (this.isScopeDeleted(workspaceId, COWORK_HOME_WORKTREE_ID)) return;
      await this.getIndexer().upsertCoworkArchive(
        workspaceId,
        COWORK_HOME_WORKTREE_ID,
        tab,
        archivedAt,
      );
      const fingerprint = await coworkArchiveFingerprint(archiveDirectory);
      if (fingerprint && !this.closed) {
        await this.getIndexer().setSourceFingerprint(
          archiveDirectory,
          fingerprint,
        );
      }
    });
  }

  async deleteCoworkArchive(projectId: string, chatId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const workspaceId = resolveCoworkWorkspaceId(projectId);
    const key = `cowork-archive:${workspaceId}/${chatId}`;
    const archiveDirectory = this.coworkArchiveDir(workspaceId, chatId);
    this.deletedCoworkArchives.add(this.coworkArchiveKey(workspaceId, chatId));
    this.activeScanSourceKeys?.delete(archiveDirectory);
    this.cancelPending((pendingKey) => pendingKey === key);
    await this.getIndexer().deleteChatDoc(
      workspaceId,
      COWORK_HOME_WORKTREE_ID,
      chatId,
      'cowork-archive',
    );
    await this.getIndexer().deleteSourceFile(archiveDirectory);
    this.scheduleUpdatedBroadcast();
    return Promise.resolve();
  }

  async deleteWorktreeDocs(
    projectId: string,
    worktreeId: string,
  ): Promise<void> {
    this.advanceWorktreeGeneration(projectId, worktreeId);
    this.deletedWorktrees.add(`${projectId}/${worktreeId}`);
    this.cancelPending(
      (key) =>
        key === this.liveUpdateKey(projectId, worktreeId) ||
        key === `archive:${projectId}/${worktreeId}` ||
        key === `plans:${projectId}/${worktreeId}` ||
        (worktreeId === COWORK_HOME_WORKTREE_ID &&
          key.startsWith(`cowork-archive:${projectId}/`)),
    );
    const indexer = this.getIndexer();
    await indexer.deleteWorktreeDocs(projectId, worktreeId);
    await indexer.deleteSourceFile(this.liveFilePath(projectId, worktreeId));
    await indexer.deleteSourceFile(
      this.worktreeArchiveFilePath(projectId, worktreeId),
    );
    await indexer.deleteSourceFile(this.plansFilePath(projectId, worktreeId));
    if (worktreeId === COWORK_HOME_WORKTREE_ID) {
      const historyRoot = `${getWorkspaceChatHistoryRootDir(projectId)}${sep}`;
      for (const fileKey of await indexer.listSourceFileKeys()) {
        if (fileKey.startsWith(historyRoot))
          await indexer.deleteSourceFile(fileKey);
      }
    }
    this.scheduleUpdatedBroadcast();
  }

  async deleteWorkspaceDocs(projectId: string): Promise<void> {
    this.deletedWorkspaces.add(projectId);
    this.cancelPending(
      (key) =>
        key.startsWith(`live:${projectId}/`) ||
        key.startsWith(`archive:${projectId}/`) ||
        key.startsWith(`plans:${projectId}/`) ||
        key.startsWith(`cowork-archive:${projectId}/`),
    );
    const indexer = this.getIndexer();
    await indexer.deleteWorkspaceDocs(projectId);
    const workspaceRoot = `${getWorkspaceDir(projectId)}${sep}`;
    const appWorkspaceRoot = `${getAppManagedChatWorkspaceDir(projectId)}${sep}`;
    for (const fileKey of await indexer.listSourceFileKeys()) {
      if (
        fileKey.startsWith(workspaceRoot) ||
        fileKey.startsWith(appWorkspaceRoot)
      ) {
        await indexer.deleteSourceFile(fileKey);
      }
    }
    this.scheduleUpdatedBroadcast();
  }

  async flushPendingUpdates(): Promise<void> {
    const pending = Array.from(this.pendingUpdates.values());
    this.pendingUpdates.clear();
    for (const update of pending) clearTimeout(update.timer);
    let completedAny = false;
    try {
      for (const update of pending) {
        if (this.closed) return;
        try {
          await update.task();
        } catch (error) {
          if (!(error instanceof StaleSearchProjectionError)) throw error;
          continue;
        }
        completedAny = true;
      }
    } catch (error) {
      this.recoverFailedIndexer();
      throw error;
    } finally {
      // An explicit flush is one batch. Scheduling after the batch prevents a
      // slow later update from letting an earlier update's timer fire midway.
      await this.flushIndexer();
      if (completedAny) this.scheduleUpdatedBroadcast();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.indexerRecoveryTimer) {
      clearTimeout(this.indexerRecoveryTimer);
      this.indexerRecoveryTimer = null;
    }
    this.queryRunner?.close();
    this.queryRunner = null;
    this.cancelPending(() => true);
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    if (this.indexer && 'close' in this.indexer) {
      this.db?.close();
      this.db = null;
      await this.indexer.close();
    }
    await Promise.allSettled(
      [this.activeScanPromise, this.initialScanPromise].filter(
        (value): value is Promise<void> => value !== null,
      ),
    );
    this.db?.close();
    this.db = null;
    this.indexer = null;
    this.workerDatabasePath = null;
  }

  private getDatabase(): DatabaseSync {
    if (this.closed) throw new Error('Chat search service is closed');
    if (this.db === null) {
      if (this.indexerFactory) {
        this.db = openChatSearchDatabase(this.dbPath);
        this.workerDatabasePath = getWorkerDatabasePath(this.db);
      } else {
        // Reads remain immediately available while the thread opens, repairs or
        // rebuilds the derived index. This tiny empty connection never receives bodies.
        this.db = openChatSearchDatabase(':memory:');
        const indexer = this.threadedIndexerFactory(this.dbPath);
        this.indexer = indexer;
        void indexer.ready
          .then((file): void => {
            if (this.closed) return;
            const reader = new DatabaseSync(file, { readOnly: true });
            reader.exec('PRAGMA busy_timeout = 0;');
            this.db?.close();
            this.db = reader;
            this.workerDatabasePath = file;
            this.scheduleUpdatedBroadcast();
          })
          .catch((error: unknown): void => {
            // eslint-disable-next-line no-console
            console.error('Search index reader could not open:', error);
          });
      }
    }
    return this.db;
  }

  private async projectedChat(
    projectId: string,
    worktreeId: string,
    source: ChatSearchSource,
    tab: PersistedChatTab,
    archivedAt?: string,
    expiresAt?: string,
    isCurrent?: () => boolean,
  ): Promise<ChatSearchDoc> {
    const assertCurrent = staleProjectionGuard(isCurrent);
    assertCurrent();
    if (!tab.transcript)
      return buildChatSearchDoc(
        projectId,
        worktreeId,
        source,
        tab,
        archivedAt,
        expiresAt,
      );
    // A scope replacement re-projects every chat in the scope. Carry forward
    // bodies whose transcript is already indexed instead of re-reading each
    // JSONL and artifact under the scope lease.
    const indexed =
      this.closed || !tab.transcript.committedDigest
        ? null
        : await this.getIndexer().getIndexedBodiesIfTranscriptUnchanged(
            `${projectId}/${worktreeId}/${tab.id}/${source}`,
            transcriptFingerprint(tab.transcript),
          );
    assertCurrent();
    if (indexed !== null)
      return withTranscriptSplit(
        buildChatSearchDoc(
          projectId,
          worktreeId,
          source,
          tab,
          archivedAt,
          expiresAt,
          indexed.body,
        ),
        indexed.activeBody,
        indexed.committedFingerprint,
      );
    const consume = async (
      rows: AsyncIterable<PersistedChatMessage>,
    ): Promise<string> => {
      const text: string[] = [];
      for await (const message of rows) {
        assertCurrent();
        const body = extractChatSearchBody([message]);
        if (body) text.push(body);
      }
      return text.join('\n\n');
    };
    let body: string;
    if (source === 'archived-container') {
      const store = await getArchivedContainerChatStorage(
        projectId,
        worktreeId,
      );
      body = await new ChatStateV2Backend(store).consumeTranscript(
        tab.id,
        false,
        consume,
      );
    } else if (source === 'cowork-archive') {
      const store = await getStandaloneHistoryStorage(projectId, tab.id);
      if (!store) throw new Error('Archive disappeared while indexing');
      body = await new ChatStateV2Backend(store).consumeTranscript(
        tab.id,
        false,
        consume,
      );
    } else {
      const projection = await this.projectTranscriptPreview(
        projectId,
        worktreeId,
        tab,
        assertCurrent,
        isCurrent,
      );
      assertCurrent();
      if (source === 'live')
        this.rememberActiveTurnText(projectId, worktreeId, tab.id, projection);
      return buildPreviewSearchDoc(
        projectId,
        worktreeId,
        source,
        tab,
        projection,
        archivedAt,
        expiresAt,
      );
    }
    assertCurrent();
    return buildChatSearchDoc(
      projectId,
      worktreeId,
      source,
      tab,
      archivedAt,
      expiresAt,
      body,
    );
  }

  /**
   * Projects a live or worktree-archive transcript through a captured
   * preview, keeping committed and in-flight text apart. With
   * `reuseCommitted`, a descriptor whose committed prefix has that identity
   * streams only the active sidecar rows.
   */
  private async projectTranscriptPreview(
    projectId: string,
    worktreeId: string,
    tab: PersistedChatTab,
    assertCurrent: () => void,
    isCurrent?: () => boolean,
    reuseCommitted?: string,
  ): Promise<TranscriptPreviewProjection> {
    // Defer the heavy state service to the live V2 transcript branch.
    const { getChatStateService } =
      await import('../services/chat-state-service');
    try {
      return await getChatStateService().consumeTranscriptPreview(
        { projectId, worktreeId },
        tab.id,
        async (messages, descriptor, read) => {
          const committedText: string[] = [];
          const activeText: string[] = [];
          const activeRows: Array<{ id: string; text: string }> = [];
          // An active-only read starts after the committed prefix.
          let position = read.committedIncluded
            ? 0
            : descriptor.committedMessageCount;
          for await (const message of messages) {
            assertCurrent();
            const text = extractChatSearchBody([message]);
            const committed = position < descriptor.committedMessageCount;
            if (!committed) activeRows.push({ id: message.id, text });
            if (text) (committed ? committedText : activeText).push(text);
            position += 1;
          }
          return {
            descriptor,
            committedBody: read.committedIncluded
              ? committedText.join('\n\n')
              : undefined,
            activeBody: activeText.join('\n\n'),
            activeRows,
            ...(read.journalProjected ? { journalProjected: true } : {}),
          };
        },
        isCurrent,
        reuseCommitted === undefined
          ? {}
          : {
              reuseCommittedPrefix: (descriptor): boolean =>
                committedTranscriptFingerprint(descriptor) === reuseCommitted,
            },
      );
    } catch (error) {
      // Deletion can close a captured handle before the next row check.
      // Only a stale generation converts that cancellation into a no-op.
      staleProjectionGuard(isCurrent)();
      throw error;
    }
  }

  /**
   * An active-sidecar revision leaves a live transcript's committed prefix
   * unchanged. When the index holds that prefix, read only the sidecar and
   * replace only the chat's in-flight row. False means nothing was written
   * and the whole transcript must be projected.
   */
  private async replaceLiveActiveText(
    projectId: string,
    worktreeId: string,
    tab: PersistedChatTab,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    const transcript = tab.transcript;
    if (!transcript?.committedDigest || !isCurrent()) return false;
    const indexer = this.getIndexer();
    const indexedCommitted = await indexer.getIndexedCommittedFingerprint(
      `${projectId}/${worktreeId}/${tab.id}/live`,
    );
    if (
      indexedCommitted !== committedTranscriptFingerprint(transcript) ||
      !isCurrent()
    )
      return false;
    const fromJournal = await this.replaceLiveActiveTextFromJournal(
      projectId,
      worktreeId,
      tab,
      indexedCommitted,
      isCurrent,
    );
    if (fromJournal !== undefined) return fromJournal;
    let projection: TranscriptPreviewProjection;
    try {
      projection = await this.projectTranscriptPreview(
        projectId,
        worktreeId,
        tab,
        staleProjectionGuard(isCurrent),
        isCurrent,
        indexedCommitted,
      );
    } catch (error) {
      // An active-only read never checks the committed bytes, so it refuses
      // a committed log that changed after capture. Project the whole
      // transcript instead; a persistent integrity failure surfaces there.
      if (error instanceof ChatTranscriptIntegrityError) return false;
      throw error;
    }
    // A superseded projection is dropped; the newer update indexes the chat.
    if (!isCurrent()) return true;
    this.rememberActiveTurnText(projectId, worktreeId, tab.id, projection);
    const doc = buildPreviewSearchDoc(
      projectId,
      worktreeId,
      'live',
      tab,
      projection,
    );
    if (projection.committedBody === undefined)
      return indexer.replaceActiveBodyIfCommittedUnchanged(doc);
    // The prefix changed after the lookup, so the preview read all of it.
    await indexer.upsertDoc(doc);
    return true;
  }

  /**
   * Cache a journal-projected read's in-flight rows, so the chat's next
   * updates re-extract only the rows its turn changed.
   */
  private rememberActiveTurnText(
    projectId: string,
    worktreeId: string,
    chatId: string,
    projection: TranscriptPreviewProjection,
  ): void {
    const key = `${projectId}/${worktreeId}/${chatId}/live`;
    if (!projection.journalProjected || !projection.activeRows) {
      this.activeTurnText.delete(key);
      return;
    }
    this.activeTurnText.reset(
      key,
      {
        committedFingerprint: committedTranscriptFingerprint(
          projection.descriptor,
        ),
        transcriptRevision: projection.descriptor.transcriptRevision,
      },
      projection.activeRows,
    );
  }

  /**
   * A delta-journal chat's in-flight text from the rows its turn changed
   * since the cached revision, read from the journal writer's memory: no
   * preview capture, no journal replay. Undefined when no cached state or
   * delta applies; the caller then reads the active rows whole.
   */
  private async replaceLiveActiveTextFromJournal(
    projectId: string,
    worktreeId: string,
    tab: PersistedChatTab,
    indexedCommitted: string,
    isCurrent: () => boolean,
  ): Promise<boolean | undefined> {
    const key = `${projectId}/${worktreeId}/${tab.id}/live`;
    const cached = this.activeTurnText.state(key);
    if (!cached || cached.committedFingerprint !== indexedCommitted)
      return undefined;
    let answer:
      | {
          descriptor: TranscriptPreviewProjection['descriptor'];
          delta: ActiveTurnDelta;
        }
      | undefined;
    try {
      // The same deferred import as projectTranscriptPreview's.
      const { getChatStateService } =
        await import('../services/chat-state-service');
      answer = await getChatStateService().activeTurnDelta(
        { projectId, worktreeId },
        tab.id,
        cached.transcriptRevision,
      );
    } catch {
      answer = undefined;
    }
    if (!isCurrent()) return true;
    const body =
      answer &&
      committedTranscriptFingerprint(answer.descriptor) === indexedCommitted
        ? this.activeTurnText.apply(
            key,
            indexedCommitted,
            cached.transcriptRevision,
            answer.delta,
          )
        : undefined;
    if (!answer || body === undefined) {
      this.activeTurnText.delete(key);
      return undefined;
    }
    return this.getIndexer().replaceActiveBodyIfCommittedUnchanged(
      buildPreviewSearchDoc(projectId, worktreeId, 'live', tab, {
        descriptor: answer.descriptor,
        committedBody: undefined,
        activeBody: body,
      }),
    );
  }

  private async upsertLiveChat(
    projectId: string,
    worktreeId: string,
    tab: PersistedChatTab,
    contentEpoch: number,
  ): Promise<void> {
    if ((tab.kind ?? 'chat') !== 'chat') return;
    const generation = this.worktreeGeneration(projectId, worktreeId);
    const isCurrent = (): boolean =>
      !this.closed &&
      this.isWorktreeGenerationCurrent(projectId, worktreeId, generation) &&
      this.isLiveContentEpochCurrent(projectId, worktreeId, contentEpoch);
    if (
      !!tab.transcript?.committedDigest &&
      isCurrent() &&
      (await this.getIndexer().updateDocMetadataIfTranscriptUnchanged(
        buildChatSearchDoc(
          projectId,
          worktreeId,
          'live',
          tab,
          undefined,
          undefined,
          '',
        ),
      ))
    )
      return;
    if (await this.replaceLiveActiveText(projectId, worktreeId, tab, isCurrent))
      return;
    const doc = await this.projectedChat(
      projectId,
      worktreeId,
      'live',
      tab,
      undefined,
      undefined,
      isCurrent,
    );
    if (isCurrent()) await this.getIndexer().upsertDoc(doc);
  }

  private async replaceLiveScope(
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
    contentEpoch: number,
  ): Promise<void> {
    // A whole-scope projection re-reads or reuses every chat; cached
    // in-flight rows are seeded again by its journal-projected reads.
    this.activeTurnText.deletePrefix(`${projectId}/${worktreeId}/`);
    const projectChat = this.projectedChat.bind(this);
    const generation = this.worktreeGeneration(projectId, worktreeId);
    const isCurrent = (): boolean =>
      !this.closed &&
      this.isWorktreeGenerationCurrent(projectId, worktreeId, generation) &&
      this.isLiveContentEpochCurrent(projectId, worktreeId, contentEpoch);
    await this.getIndexer().replaceStreamedScope(
      projectId,
      worktreeId,
      'live',
      (async function* (): AsyncGenerator<ChatSearchDoc> {
        for (const tab of data.tabs)
          if ((tab.kind ?? 'chat') === 'chat')
            yield await projectChat(
              projectId,
              worktreeId,
              'live',
              tab,
              undefined,
              undefined,
              isCurrent,
            );
      })(),
      isCurrent,
    );
  }

  private async replaceArchiveScope(
    projectId: string,
    worktreeId: string,
    data: ArchivedChatsFile,
    contentEpoch: number,
  ): Promise<void> {
    const projectChat = this.projectedChat.bind(this);
    const generation = this.worktreeGeneration(projectId, worktreeId);
    await this.getIndexer().replaceStreamedScope(
      projectId,
      worktreeId,
      'worktree-archive',
      (async function* (): AsyncGenerator<ChatSearchDoc> {
        for (const entry of data.archived)
          yield await projectChat(
            projectId,
            worktreeId,
            'worktree-archive',
            entry.tab,
            entry.archivedAt,
          );
      })(),
      () =>
        !this.closed &&
        this.isWorktreeGenerationCurrent(projectId, worktreeId, generation) &&
        this.isArchiveContentEpochCurrent(projectId, worktreeId, contentEpoch),
    );
  }

  private async replaceContainerScope(
    manifest: ArchivedContainerManifest,
    summary: WorktreeSummaryData | null,
    chats: ChatTabsFile,
    archives: ArchivedChatsFile,
    plans: readonly TrackedPlanIndexEntry[],
    expiresAt?: string,
  ): Promise<void> {
    const projectChat = this.projectedChat.bind(this);
    const { projectId, id: worktreeId } = manifest;
    const generation = this.worktreeGeneration(projectId, worktreeId);
    const entries = new Map(
      archives.archived.map((entry) => [entry.tab.id, entry]),
    );
    for (const tab of chats.tabs)
      if ((tab.kind ?? 'chat') === 'chat')
        entries.set(tab.id, {
          tab,
          archivedAt: manifest.archivedAt,
          turnCount: 0,
        });
    const count = Array.from(entries.values()).reduce(
      (total, entry) =>
        total +
        (entry.tab.transcript?.messageCount ??
          entry.tab.transcript?.committedMessageCount ??
          entry.tab.messages.length),
      0,
    );
    await this.getIndexer().replaceStreamedScope(
      projectId,
      worktreeId,
      'archived-container',
      (async function* (): AsyncGenerator<ChatSearchDoc> {
        yield buildArchivedContainerEntityDoc(
          manifest,
          summary,
          count,
          expiresAt,
        );
        for (const entry of Array.from(entries.values()))
          yield await projectChat(
            projectId,
            worktreeId,
            'archived-container',
            entry.tab,
            entry.archivedAt,
            expiresAt,
          );
        if (manifest.kind === 'worktree')
          for (const plan of plans)
            if (!plan.hidden)
              yield buildPlanSearchDoc(projectId, worktreeId, plan, {
                source: 'archived-container',
                archivedAt: manifest.archivedAt,
                expiresAt,
              });
      })(),
      () =>
        !this.closed &&
        this.isWorktreeGenerationCurrent(projectId, worktreeId, generation),
    );
  }

  private getIndexer(): ChatSearchIndexer | ThreadedChatSearchIndexer {
    if (!this.indexer) {
      const database = this.getDatabase();
      this.indexer ??= this.indexerFactory
        ? this.indexerFactory(database)
        : this.threadedIndexerFactory(this.dbPath);
    }
    return this.indexer;
  }

  /**
   * A failed index worker rejects every later request, so without replacement
   * search would stay stale until restart. Replace it after a backoff and
   * rescan; source fingerprints limit the rescan to what changed.
   */
  private recoverFailedIndexer(): void {
    const failed = this.indexer;
    if (
      this.closed ||
      this.indexerRecoveryTimer !== null ||
      failed === null ||
      !('isFailed' in failed) ||
      !failed.isFailed()
    ) {
      return;
    }
    const delayMs = Math.min(
      CHAT_SEARCH_INDEXER_RECOVERY_DELAY_MS * 2 ** this.indexerRecoveryAttempts,
      CHAT_SEARCH_INDEXER_RECOVERY_MAX_DELAY_MS,
    );
    this.indexerRecoveryAttempts += 1;
    this.indexerRecoveryTimer = setTimeout(() => {
      this.indexerRecoveryTimer = null;
      if (this.closed || this.indexer !== failed) return;
      this.indexer = null;
      this.db?.close();
      this.db = null;
      this.workerDatabasePath = null;
      void failed.close().catch(() => undefined);
      void this.scanAllSources().then(
        () => {
          this.indexerRecoveryAttempts = 0;
        },
        (error: unknown) => {
          // eslint-disable-next-line no-console
          console.error('Chat search recovery scan failed:', error);
          this.recoverFailedIndexer();
        },
      );
    }, delayMs);
    this.indexerRecoveryTimer.unref?.();
  }

  private async flushIndexer(): Promise<void> {
    if (this.indexer && 'flush' in this.indexer) await this.indexer.flush();
  }

  private isVisibleEntry(entry: ChatSearchCatalogEntry): boolean {
    return (
      !this.isScopeDeleted(entry.projectId, entry.worktreeId) &&
      (entry.source !== 'cowork-archive' ||
        !this.isCoworkArchiveDeleted(entry.projectId, entry.chatId)) &&
      !(
        entry.source !== 'archived-container' &&
        this.hiddenLiveScopes.has(`${entry.projectId}/${entry.worktreeId}`)
      )
    );
  }

  private createContextVisibilityPredicate(
    context: WorkspaceContext,
    linkedPersonalWorkspaceIds: readonly string[] = [],
  ): (entry: ChatSearchCatalogEntry) => Promise<boolean> {
    const linkedPersonalIds = new Set(linkedPersonalWorkspaceIds);
    const owners = new Map<
      string,
      Promise<SearchWorkspaceOwner | undefined | null>
    >();
    return async (entry): Promise<boolean> => {
      if (!this.isVisibleEntry(entry)) return false;
      if (entry.projectId === APP_ADVISOR_PROJECT_ID) return true;
      let owner = owners.get(entry.projectId);
      if (!owner) {
        owner = this.resolveWorkspaceOwner(entry.projectId);
        owners.set(entry.projectId, owner);
      }
      const resolved = await owner;
      // A stale index row must not reveal a title after its ownership metadata
      // disappears. Unscoped callers still retain the legacy catalog above.
      if (resolved === null) return false;
      if (
        context.kind === 'organization' &&
        resolved === undefined &&
        linkedPersonalIds.has(entry.projectId)
      ) {
        return true;
      }
      return workspaceOwnerMatchesContext(resolved, context);
    };
  }

  private collectVisiblePage<T extends ChatSearchCatalogEntry>(
    limit: number,
    fetchPage: (offset: number) => T[],
  ): T[] {
    const visible: T[] = [];
    let offset = 0;
    while (visible.length < limit) {
      const page = fetchPage(offset);
      if (page.length === 0) break;
      offset += page.length;
      visible.push(...page.filter((entry) => this.isVisibleEntry(entry)));
      if (page.length < limit) break;
    }
    return visible.slice(0, limit);
  }

  private async collectVisiblePageAsync<T extends ChatSearchCatalogEntry>(
    limit: number,
    fetchPage: (offset: number) => Promise<T[]>,
    isVisible?: (entry: T) => boolean | Promise<boolean>,
  ): Promise<T[]> {
    // Not a parameter default: the bytecode main build's arrow transform
    // leaves `this` unbound in one (main-bytecode-arrow-defaults.test.ts).
    const isEntryVisible =
      isVisible ?? ((entry: T): boolean => this.isVisibleEntry(entry));
    const visible: T[] = [];
    let offset = 0;
    while (visible.length < limit) {
      const page = await fetchPage(offset);
      if (page.length === 0) break;
      offset += page.length;
      const pageVisibility = await Promise.all(
        page.map((entry) => Promise.resolve(isEntryVisible(entry))),
      );
      visible.push(
        ...page.filter((_entry, index) => pageVisibility[index] === true),
      );
      if (page.length < limit) break;
    }
    return visible.slice(0, limit);
  }

  private enqueue(
    key: string,
    task: () => Promise<void> | void,
    liveTabsUpdate?: PendingLiveTabsUpdate,
  ): void {
    if (this.closed) return;
    const existing = this.pendingUpdates.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const pending = this.pendingUpdates.get(key);
      if (!pending || pending.timer !== timer) return;
      this.pendingUpdates.delete(key);
      void this.runIncrementalTask(pending.task).catch((error: unknown) => {
        if (error instanceof StaleSearchProjectionError) return;
        // The index is disposable derived data; persistence must not fail when
        // an incremental refresh cannot complete.
        // eslint-disable-next-line no-console
        console.error('Chat search incremental update failed:', error);
      });
    }, this.debounceMs);
    timer.unref?.();
    this.pendingUpdates.set(key, { timer, task, liveTabsUpdate });
  }

  private cancelPending(predicate: (key: string) => boolean): void {
    for (const [key, update] of Array.from(this.pendingUpdates.entries())) {
      if (!predicate(key)) continue;
      clearTimeout(update.timer);
      this.pendingUpdates.delete(key);
    }
  }

  private async performFullScan(): Promise<void> {
    const sourceKeys = new Set<string>();
    this.activeScanSourceKeys = sourceKeys;
    try {
      const descriptors = await this.enumerateSources();
      if (this.closed) return;
      for (const descriptor of descriptors) {
        sourceKeys.add(descriptor.fileKey);
      }
      for (const descriptor of descriptors) {
        if (this.closed) return;
        if (this.isScopeDeleted(descriptor.projectId, descriptor.worktreeId)) {
          continue;
        }
        const previous = await this.getIndexer().getSourceFingerprint(
          descriptor.fileKey,
        );
        if (
          previous?.mtimeMs === descriptor.fingerprint.mtimeMs &&
          previous.sizeBytes === descriptor.fingerprint.sizeBytes
        ) {
          await yieldToMainLoop();
          continue;
        }
        await this.indexSource(descriptor);
        await yieldToMainLoop();
      }
      if (this.closed) return;
      await this.pruneMissingSources(sourceKeys);
      await this.getIndexer().setMetadata(
        'last_full_scan_at',
        String(Date.now()),
      );
      this.scheduleUpdatedBroadcast();
    } finally {
      if (this.activeScanSourceKeys === sourceKeys) {
        this.activeScanSourceKeys = null;
      }
    }
  }

  private async enumerateSources(): Promise<SourceDescriptor[]> {
    const descriptors: SourceDescriptor[] = [];
    const workspacesRoot = getWorkspacesRootDir();
    const workspaceEntries = await safeReadDir(workspacesRoot);
    for (const workspaceEntry of workspaceEntries) {
      if (!workspaceEntry.isDirectory()) continue;
      const projectId = workspaceEntry.name;
      await this.enumerateFlatJsonSources(
        descriptors,
        dirname(getWorkspaceChatTabsFilePath(projectId, 'placeholder')),
        'live',
        projectId,
      );
      await this.enumerateFlatJsonSources(
        descriptors,
        dirname(getWorkspaceChatArchivesFilePath(projectId, 'placeholder')),
        'worktree-archive',
        projectId,
      );
      await this.enumerateFlatJsonSources(
        descriptors,
        dirname(getWorkspaceTrackedPlansFilePath(projectId, 'placeholder')),
        'plan',
        projectId,
      );
      const archiveEntries = await safeReadDir(
        getWorkspaceChatHistoryRootDir(projectId),
      );
      for (const archiveEntry of archiveEntries) {
        if (!archiveEntry.isDirectory()) continue;
        const fileKey = getWorkspaceChatHistoryDir(
          projectId,
          archiveEntry.name,
        );
        const worktreeGeneration = this.worktreeGeneration(
          projectId,
          COWORK_HOME_WORKTREE_ID,
        );
        const fingerprint = await coworkArchiveFingerprint(fileKey);
        if (!fingerprint) continue;
        descriptors.push({
          fileKey,
          kind: 'cowork-archive',
          projectId,
          worktreeId: COWORK_HOME_WORKTREE_ID,
          worktreeGeneration,
          chatId: archiveEntry.name,
          fingerprint,
        });
      }
      await this.enumerateArchivedContainers(descriptors, projectId);
    }

    await this.enumerateFlatJsonSources(
      descriptors,
      dirname(
        getWorkspaceChatTabsFilePath(APP_ADVISOR_PROJECT_ID, 'placeholder'),
      ),
      'live',
      APP_ADVISOR_PROJECT_ID,
    );
    await this.enumerateFlatJsonSources(
      descriptors,
      dirname(
        getWorkspaceChatArchivesFilePath(APP_ADVISOR_PROJECT_ID, 'placeholder'),
      ),
      'worktree-archive',
      APP_ADVISOR_PROJECT_ID,
    );
    await this.enumerateArchivedContainers(descriptors, APP_ADVISOR_PROJECT_ID);
    return descriptors;
  }

  private async enumerateArchivedContainers(
    descriptors: SourceDescriptor[],
    projectId: string,
  ): Promise<void> {
    try {
      validateId(projectId, 'projectId');
    } catch {
      return;
    }
    for (const entry of await safeReadDir(
      getArchivedContainersRootDir(projectId),
    )) {
      if (!entry.isDirectory()) continue;
      try {
        validateId(entry.name, 'containerId');
      } catch {
        continue;
      }
      const fileKey = getArchivedContainerManifestPath(projectId, entry.name);
      const worktreeGeneration = this.worktreeGeneration(projectId, entry.name);
      const fingerprint = await safeFingerprint(fileKey);
      if (!fingerprint) continue;
      descriptors.push({
        fileKey,
        kind: 'archived-container',
        projectId,
        worktreeId: entry.name,
        worktreeGeneration,
        fingerprint,
      });
    }
  }

  private async enumerateFlatJsonSources(
    descriptors: SourceDescriptor[],
    directory: string,
    kind: 'live' | 'worktree-archive' | 'plan',
    projectId: string,
  ): Promise<void> {
    const entries = await safeReadDir(directory);
    const ids = new Set(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => basename(entry.name, '.json')),
    );
    if (kind !== 'plan') {
      for (const entry of await safeReadDir(
        join(dirname(directory), 'chat-storage-manifests'),
      )) {
        if (
          entry.isFile() &&
          entry.name.endsWith('.json') &&
          !entry.name.startsWith('plan-explore-chats-')
        )
          ids.add(basename(entry.name, '.json'));
      }
    }
    for (const worktreeId of Array.from(ids)) {
      const fileKey = join(directory, `${worktreeId}.json`);
      const worktreeGeneration = this.worktreeGeneration(projectId, worktreeId);
      const archiveContentEpoch =
        kind === 'worktree-archive'
          ? this.archiveContentEpoch(projectId, worktreeId)
          : undefined;
      const fingerprint = await this.sourceFingerprint(
        fileKey,
        projectId,
        worktreeId,
      );
      if (!fingerprint) continue;
      descriptors.push({
        fileKey,
        kind,
        projectId,
        worktreeId,
        worktreeGeneration,
        ...(archiveContentEpoch !== undefined ? { archiveContentEpoch } : {}),
        fingerprint,
      });
    }
  }

  private async indexSource(descriptor: SourceDescriptor): Promise<void> {
    try {
      await this.indexCurrentSource(descriptor);
    } catch (error) {
      // An explicit deletion or a newer live projection can supersede this
      // source while its transcript is being read. Continue the full scan.
      if (
        error instanceof StaleSearchProjectionError ||
        this.closed ||
        !this.isWorktreeGenerationCurrent(
          descriptor.projectId,
          descriptor.worktreeId,
          descriptor.worktreeGeneration,
        ) ||
        this.isCoworkArchiveDeleted(descriptor.projectId, descriptor.chatId)
      )
        return;
      throw error;
    }
  }

  private async indexCurrentSource(
    descriptor: SourceDescriptor,
  ): Promise<void> {
    const indexer = this.getIndexer();
    const generation = descriptor.worktreeGeneration;
    if (descriptor.kind === 'live') {
      const contentEpoch = this.liveContentEpoch(
        descriptor.projectId,
        descriptor.worktreeId,
      );
      const data = await readChatTabsFileForIndex(
        descriptor.projectId,
        descriptor.worktreeId,
      );
      if (
        this.closed ||
        !this.isWorktreeGenerationCurrent(
          descriptor.projectId,
          descriptor.worktreeId,
          generation,
        )
      ) {
        return;
      }
      await this.replaceLiveScope(
        descriptor.projectId,
        descriptor.worktreeId,
        data,
        contentEpoch,
      );
      if (
        !this.isLiveContentEpochCurrent(
          descriptor.projectId,
          descriptor.worktreeId,
          contentEpoch,
        )
      ) {
        return;
      }
    } else if (descriptor.kind === 'worktree-archive') {
      const contentEpoch =
        descriptor.archiveContentEpoch ??
        this.archiveContentEpoch(descriptor.projectId, descriptor.worktreeId);
      const data = await readChatArchivesFileForIndex(
        descriptor.projectId,
        descriptor.worktreeId,
      );
      if (
        this.closed ||
        !this.isWorktreeGenerationCurrent(
          descriptor.projectId,
          descriptor.worktreeId,
          generation,
        ) ||
        !this.isArchiveContentEpochCurrent(
          descriptor.projectId,
          descriptor.worktreeId,
          contentEpoch,
        )
      ) {
        return;
      }
      await this.replaceArchiveScope(
        descriptor.projectId,
        descriptor.worktreeId,
        data,
        contentEpoch,
      );
    } else if (descriptor.kind === 'plan') {
      const entries = await readTrackedPlansForIndex(descriptor.fileKey);
      if (
        this.closed ||
        !this.isWorktreeGenerationCurrent(
          descriptor.projectId,
          descriptor.worktreeId,
          generation,
        )
      ) {
        return;
      }
      await indexer.replaceWorktreePlans(
        descriptor.projectId,
        descriptor.worktreeId,
        entries,
      );
    } else if (descriptor.kind === 'archived-container') {
      const manifest = await readArchivedContainerManifest(
        descriptor.projectId,
        descriptor.worktreeId,
      );
      if (
        this.closed ||
        !this.isWorktreeGenerationCurrent(
          descriptor.projectId,
          descriptor.worktreeId,
          generation,
        )
      ) {
        return;
      }
      if (manifest.restoredTo) {
        await indexer.deleteArchivedContainerDocs(
          descriptor.projectId,
          descriptor.worktreeId,
        );
      } else {
        const [summary, chats, archives, plans] = await Promise.all([
          readArchivedSummaryForIndex(
            descriptor.projectId,
            descriptor.worktreeId,
          ),
          readArchivedContainerChats(
            descriptor.projectId,
            descriptor.worktreeId,
          ),
          readArchivedContainerChatArchives(
            descriptor.projectId,
            descriptor.worktreeId,
          ),
          readArchivedContainerTrackedPlans(
            descriptor.projectId,
            descriptor.worktreeId,
          ),
        ]);
        await this.replaceContainerScope(
          manifest,
          summary,
          chats,
          archives,
          plans.plans,
          manifest.lockedAt ? undefined : manifest.expiresAt,
        );
      }
    } else if (descriptor.chatId) {
      await this.indexCoworkArchiveSource(descriptor, generation);
    }
    if (
      !this.closed &&
      this.isWorktreeGenerationCurrent(
        descriptor.projectId,
        descriptor.worktreeId,
        generation,
      ) &&
      (descriptor.kind !== 'worktree-archive' ||
        this.isArchiveContentEpochCurrent(
          descriptor.projectId,
          descriptor.worktreeId,
          descriptor.archiveContentEpoch ?? 0,
        )) &&
      !this.isCoworkArchiveDeleted(descriptor.projectId, descriptor.chatId)
    ) {
      await indexer.setSourceFingerprint(
        descriptor.fileKey,
        descriptor.fingerprint,
      );
    }
  }

  private async indexCoworkArchiveSource(
    descriptor: SourceDescriptor,
    generation: number,
  ): Promise<void> {
    const chatId = descriptor.chatId;
    if (!chatId) return;
    const [snapshot, meta] = await Promise.all([
      readArchiveSnapshotForIndex(descriptor.projectId, chatId),
      readArchiveMetaForIndex(descriptor.projectId, chatId),
    ]);
    if (
      this.closed ||
      !this.isWorktreeGenerationCurrent(
        descriptor.projectId,
        descriptor.worktreeId,
        generation,
      ) ||
      this.isCoworkArchiveDeleted(descriptor.projectId, chatId)
    ) {
      return;
    }
    if (!snapshot && meta?.archived !== true) {
      await this.getIndexer().deleteChatDoc(
        descriptor.projectId,
        descriptor.worktreeId,
        chatId,
        'cowork-archive',
      );
      return;
    }
    const baseTab: PersistedChatTab = snapshot?.tab ?? {
      id: chatId,
      title: meta?.title ?? meta?.description ?? chatId,
      description: meta?.description,
      messages: [],
      createdAt: meta?.createdAt ?? new Date(0).toISOString(),
      providerType: meta?.providerType,
    };
    const tab: PersistedChatTab = {
      ...baseTab,
      ...(meta?.title ? { title: meta.title } : {}),
      ...(meta?.description ? { description: meta.description } : {}),
      ...(meta?.providerType ? { providerType: meta.providerType } : {}),
    };
    const doc = await this.projectedChat(
      descriptor.projectId,
      descriptor.worktreeId,
      'cowork-archive',
      tab,
      meta?.archivedAt ??
        snapshot?.archivedAt ??
        meta?.createdAt ??
        tab.createdAt,
    );
    if (
      !this.closed &&
      this.isWorktreeGenerationCurrent(
        descriptor.projectId,
        descriptor.worktreeId,
        generation,
      ) &&
      !this.isCoworkArchiveDeleted(descriptor.projectId, chatId)
    )
      await this.getIndexer().upsertDoc(doc);
  }

  private async pruneMissingSources(sourceKeys: Set<string>): Promise<void> {
    const indexer = this.getIndexer();
    for (const fileKey of await indexer.listSourceFileKeys()) {
      if (!sourceKeys.has(fileKey)) await indexer.deleteSourceFile(fileKey);
    }
    const rows: unknown[] = this.getDatabase()
      .prepare(
        'SELECT doc_id, project_id, worktree_id, chat_id, source FROM chat_docs',
      )
      .all();
    for (const result of rows) {
      const row = requireSqliteRow(result);
      if (
        typeof row.doc_id !== 'string' ||
        typeof row.project_id !== 'string' ||
        typeof row.worktree_id !== 'string' ||
        typeof row.chat_id !== 'string' ||
        !isChatSearchSource(row.source)
      ) {
        continue;
      }
      const fileKey = this.sourceKeyForDoc(
        row.project_id,
        row.worktree_id,
        row.chat_id,
        row.source,
      );
      if (!sourceKeys.has(fileKey)) {
        await indexer.deleteDocById(row.doc_id);
      }
    }
  }

  private sourceKeyForDoc(
    projectId: string,
    worktreeId: string,
    chatId: string,
    source: ChatSearchSource,
  ): string {
    if (source === 'live') return this.liveFilePath(projectId, worktreeId);
    if (source === 'worktree-archive') {
      return this.worktreeArchiveFilePath(projectId, worktreeId);
    }
    if (source === 'plan') return this.plansFilePath(projectId, worktreeId);
    if (source === 'archived-container') {
      return getArchivedContainerManifestPath(projectId, worktreeId);
    }
    return this.coworkArchiveDir(projectId, chatId);
  }

  private normalizeLiveScope(
    projectId: string,
    worktreeId: string,
  ): { projectId: string; worktreeId: string } {
    if (projectId !== STANDALONE_CHAT_PROJECT_ID) {
      return { projectId, worktreeId };
    }
    return {
      projectId: resolveCoworkWorkspaceId(worktreeId),
      worktreeId: COWORK_HOME_WORKTREE_ID,
    };
  }

  private reactivateScope(projectId: string, worktreeId: string): void {
    this.hiddenLiveScopes.delete(`${projectId}/${worktreeId}`);
    this.deletedWorkspaces.delete(projectId);
    this.deletedWorktrees.delete(`${projectId}/${worktreeId}`);
  }

  private worktreeGeneration(projectId: string, worktreeId: string): number {
    return this.worktreeGenerations.get(`${projectId}/${worktreeId}`) ?? 0;
  }

  private liveContentEpoch(projectId: string, worktreeId: string): number {
    return this.liveContentEpochs.get(`${projectId}/${worktreeId}`) ?? 0;
  }

  private advanceLiveContentEpoch(
    projectId: string,
    worktreeId: string,
  ): number {
    const epoch = this.liveContentEpoch(projectId, worktreeId) + 1;
    this.liveContentEpochs.set(`${projectId}/${worktreeId}`, epoch);
    return epoch;
  }

  private isLiveContentEpochCurrent(
    projectId: string,
    worktreeId: string,
    epoch: number,
  ): boolean {
    return this.liveContentEpoch(projectId, worktreeId) === epoch;
  }

  private archiveContentEpoch(projectId: string, worktreeId: string): number {
    return this.archiveContentEpochs.get(`${projectId}/${worktreeId}`) ?? 0;
  }

  private advanceArchiveContentEpoch(
    projectId: string,
    worktreeId: string,
  ): number {
    const epoch = this.archiveContentEpoch(projectId, worktreeId) + 1;
    this.archiveContentEpochs.set(`${projectId}/${worktreeId}`, epoch);
    return epoch;
  }

  private isArchiveContentEpochCurrent(
    projectId: string,
    worktreeId: string,
    epoch: number,
  ): boolean {
    return this.archiveContentEpoch(projectId, worktreeId) === epoch;
  }

  private advanceWorktreeGeneration(
    projectId: string,
    worktreeId: string,
  ): number {
    const generation = this.worktreeGeneration(projectId, worktreeId) + 1;
    this.worktreeGenerations.set(`${projectId}/${worktreeId}`, generation);
    return generation;
  }

  private isWorktreeGenerationCurrent(
    projectId: string,
    worktreeId: string,
    generation: number,
  ): boolean {
    return (
      !this.isScopeDeleted(projectId, worktreeId) &&
      this.worktreeGeneration(projectId, worktreeId) === generation
    );
  }

  private isScopeDeleted(projectId: string, worktreeId: string): boolean {
    return (
      this.deletedWorkspaces.has(projectId) ||
      this.deletedWorktrees.has(`${projectId}/${worktreeId}`)
    );
  }

  private coworkArchiveKey(projectId: string, chatId: string): string {
    return `${projectId}/${chatId}`;
  }

  private isCoworkArchiveDeleted(
    projectId: string,
    chatId: string | undefined,
  ): boolean {
    return (
      chatId !== undefined &&
      this.deletedCoworkArchives.has(this.coworkArchiveKey(projectId, chatId))
    );
  }

  private async sourceFingerprint(
    fileKey: string,
    projectId: string,
    worktreeId: string,
  ): Promise<SourceFingerprint | null> {
    const live = fileKey === this.liveFilePath(projectId, worktreeId);
    const archive =
      fileKey === this.worktreeArchiveFilePath(projectId, worktreeId);
    if (live || archive) {
      const store = new ChatStorageV2(
        dirname(dirname(this.liveFilePath(projectId, worktreeId))),
        worktreeId,
      );
      const format = await store.format();
      if (format !== 'v1') {
        const index = await safeFingerprint(
          join(
            store.directory,
            live ? 'live-index.json' : 'archive-index.json',
          ),
        );
        if (format === 'v2' || !index) return index;
        // A delta-journal scope's index file is only its last checkpoint;
        // every commit appends to the journal, and a checkpoint replaces it.
        const journal = await safeFingerprint(
          join(store.directory, DELTA_JOURNAL_FILE_NAME),
        );
        if (!journal) return index;
        return {
          mtimeMs: Math.max(index.mtimeMs, journal.mtimeMs),
          sizeBytes: index.sizeBytes + journal.sizeBytes,
        };
      }
    }
    return safeFingerprint(fileKey);
  }

  private async refreshFingerprint(
    fileKey: string,
    projectId: string,
    worktreeId: string,
    generation: number,
    archiveContentEpoch?: number,
  ): Promise<void> {
    const fingerprint = await this.sourceFingerprint(
      fileKey,
      projectId,
      worktreeId,
    );
    if (
      fingerprint &&
      !this.closed &&
      this.isWorktreeGenerationCurrent(projectId, worktreeId, generation) &&
      (archiveContentEpoch === undefined ||
        this.isArchiveContentEpochCurrent(
          projectId,
          worktreeId,
          archiveContentEpoch,
        ))
    ) {
      await this.getIndexer().setSourceFingerprint(fileKey, fingerprint);
    }
  }

  private async runIncrementalTask(
    task: () => Promise<void> | void,
  ): Promise<void> {
    try {
      await task();
      await this.flushIndexer();
    } catch (error) {
      this.recoverFailedIndexer();
      throw error;
    }
    this.scheduleUpdatedBroadcast();
  }

  private scheduleUpdatedBroadcast(): void {
    if (this.closed) return;
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      if (this.closed) return;
      try {
        this.broadcastUpdated();
      } catch (error) {
        // Search remains usable even if a renderer is being torn down while
        // the coalesced notification fires.
        // eslint-disable-next-line no-console
        console.error('Chat search update broadcast failed:', error);
      }
    }, this.broadcastDebounceMs);
    this.broadcastTimer.unref?.();
  }

  private liveUpdateKey(projectId: string, worktreeId: string): string {
    return `live:${projectId}/${worktreeId}`;
  }

  private liveFilePath(projectId: string, worktreeId: string): string {
    return getWorkspaceChatTabsFilePath(projectId, worktreeId);
  }

  private worktreeArchiveFilePath(
    projectId: string,
    worktreeId: string,
  ): string {
    return getWorkspaceChatArchivesFilePath(projectId, worktreeId);
  }

  private plansFilePath(projectId: string, worktreeId: string): string {
    return getWorkspaceTrackedPlansFilePath(projectId, worktreeId);
  }

  private coworkArchiveDir(projectId: string, chatId: string): string {
    return getWorkspaceChatHistoryDir(projectId, chatId);
  }
}

let service: ChatSearchService | null = null;

export function getChatSearchService(): ChatSearchService {
  service ??= new ChatSearchService();
  return service;
}

/** Does not instantiate the index during shutdown if search was never used. */
export async function closeChatSearchService(): Promise<void> {
  const current = service;
  service = null;
  await current?.close();
}
