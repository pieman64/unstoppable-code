import { cp, open, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { isCostWorkScope } from '@canopy/desktop-shared/lib/cost-scope';
import type { AgentAuditEntry } from '@canopy/desktop-shared/types';
import {
  costScopeKey,
  type CostChatRequest,
  type CostChatView,
  type CostPipelineRunRequest,
  type CostRefreshReceipt,
  type CostRefreshRequest,
  type CostScopeRef,
  type CostScopeRequest,
  type CostScopeView,
  type CostViewResult,
  type CostViewUnavailableReason,
  type CostErrorReason,
  type PipelineRunCostView,
} from '@canopy/protocol/cost-view';
import { normalizeAuditEntry } from '../observability/audit-entry-parser';
import {
  sameAuditDayFileIdentity,
  type AuditDayFileIdentity,
} from '../observability/audit-stream-hooks';
import { BillingEvidencePass } from './billing-evidence';
import { emitCostUpdated } from './events';
import {
  aggregateRecords,
  buildPipelineRunViews,
  buildSummary,
  emptyChatAggregate,
  projectChatView,
  projectPipelineRunView,
  projectScopeView,
} from './read-model';
import { classifyAuditEntry } from './classifier';
import {
  isCostUnattachedFile,
  readChatFile,
  readCheckpointFile,
  readJsonFile,
  readScopeFiles,
  readSummaryFile,
  writeChatFile,
  writeCheckpointFile,
  writeSummaryFile,
  writeUnattachedFile,
} from './persistence';
import type {
  CostChatAggregate,
  CostChatFile,
  CostIndexCheckpoint,
  CostInternalTrigger,
  CostIndexHost,
  CostScopeLocation,
  CostSummaryFile,
  CostTurnRecord,
  CostUnattachedFile,
} from './types';
import {
  chatViewNamesProxyAccounts,
  labelChatView,
  labelPipelineRunView,
  labelScopeView,
  pipelineRunViewNamesProxyAccounts,
  scopeViewNamesProxyAccounts,
} from './proxy-account-labels';

const CURRENT_GENERATION = 3;
/**
 * Each slice runs on Electron main between yields, and a keystroke crosses
 * main several times, so a slice is kept under a millisecond of indexing.
 */
const MAX_AUDIT_SLICE_BYTES = 64 * 1024;
const OPEN_REFRESH_STALE_MS = 2 * 60 * 1000;

interface ScopeState {
  readonly location: CostScopeLocation;
  summary: CostSummaryFile | null;
  readonly chatFiles: Map<string, MutableCostChatFile>;
  readonly originalChats: Map<string, string>;
  readonly recordLocationsByEntryId: Map<string, Map<string, RecordLocation>>;
  readonly sealedEntryIds: Set<string>;
  /** Updated in place: a week of helper lines upserts these records over and over. */
  unattached: MutableCostUnattachedFile;
  originalUnattached: string | null;
  readonly touchedChats: Set<string>;
  unattachedTouched: boolean;
  forceWrite: boolean;
}

type RecordLocation =
  | { readonly kind: 'chat'; readonly chatId: string }
  | { readonly kind: 'unattached' };

interface MutableCostChatFile extends Omit<CostChatFile, 'records'> {
  records: Record<string, CostTurnRecord>;
}

interface MutableCostUnattachedFile extends Omit<
  CostUnattachedFile,
  'records'
> {
  records: Record<string, CostTurnRecord>;
}

interface AuditFile {
  readonly filename: string;
  readonly filePath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino?: number;
  readonly cursor: CostIndexCheckpoint['audit'][string] | undefined;
  readonly startOffset: number;
  readonly reset: boolean;
}

interface RefreshPassResult {
  readonly checkpoint: CostIndexCheckpoint;
  readonly changed: readonly {
    readonly scope: CostScopeRef;
    readonly revision: number;
    readonly updatedAt: string | null;
  }[];
  readonly linesRead: number;
  readonly forceReplay: boolean;
}

function scopeId(scope: CostScopeRef): string {
  return scope.kind === 'entry' ? scope.worktreeId : scope.containerId;
}

function recordLocationKey(location: RecordLocation): string {
  return location.kind === 'unattached'
    ? 'unattached'
    : JSON.stringify(['chat', location.chatId]);
}

function indexRecordLocation(
  index: Map<string, Map<string, RecordLocation>>,
  entryId: string,
  location: RecordLocation,
): void {
  const locations = index.get(entryId) ?? new Map<string, RecordLocation>();
  locations.set(recordLocationKey(location), location);
  index.set(entryId, locations);
}

function validRemovalIdentity(
  entry: AgentAuditEntry,
): { readonly entryId: string; readonly scope: CostScopeRef } | null {
  const entryId = entry.id.trim();
  const hasControlCharacter = Array.from(entryId).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (
    entryId.length === 0 ||
    entryId.length > 512 ||
    entryId.startsWith('/') ||
    entryId.includes('\\') ||
    hasControlCharacter ||
    entryId.split('/').some((part) => part === '.' || part === '..') ||
    !Number.isFinite(Date.parse(entry.startedAt))
  ) {
    return null;
  }
  const projectId = entry.projectId?.trim();
  const worktreeId = entry.worktreeId?.trim();
  if (
    projectId === undefined ||
    worktreeId === undefined ||
    !/^[a-z0-9][a-z0-9-]*$/.test(projectId) ||
    !/^[a-z0-9][a-z0-9-]*$/.test(worktreeId) ||
    !isCostWorkScope(projectId, worktreeId)
  ) {
    return null;
  }
  return {
    entryId,
    scope: { kind: 'entry', projectId, worktreeId },
  };
}

function emptyUnattached(): MutableCostUnattachedFile {
  return { version: 1, records: {} };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function parseDayFilename(filename: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(filename);
  if (match === null) return null;
  const parsed = new Date(`${match[1]}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== match[1]
    ? null
    : match[1];
}

function dateIsBefore(a: string, b: string): boolean {
  const parsedA = new Date(a).getTime();
  const parsedB = new Date(b).getTime();
  return (
    Number.isFinite(parsedA) && Number.isFinite(parsedB) && parsedA < parsedB
  );
}

function clampRetentionDays(value: number): number {
  if (!Number.isFinite(value)) return 7;
  return Math.min(90, Math.max(1, Math.floor(value)));
}

function frozen<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) frozen(nested);
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function emptyChatFile(chatId: string): MutableCostChatFile {
  return { version: 1, chatId, records: {} };
}

function latestActivity(
  chatFiles: readonly CostChatFile[],
  unattached: CostUnattachedFile,
): string | null {
  const values: string[] = [];
  const collect = (records: Readonly<Record<string, CostTurnRecord>>): void => {
    for (const record of Object.values(records)) {
      values.push(record.completedAt ?? record.startedAt);
    }
  };
  const collectAggregate = (aggregate: CostChatAggregate | undefined): void => {
    if (aggregate?.lastActivityAt !== undefined)
      values.push(aggregate.lastActivityAt);
  };
  for (const chat of chatFiles) {
    collect(chat.records);
    collectAggregate(chat.sealed);
  }
  collect(unattached.records);
  collectAggregate(unattached.sealedUnattached);
  // Sealed pipeline records live on only as run views, which carry no end time.
  if (unattached.sealedRunsLastActivityAt !== undefined)
    values.push(unattached.sealedRunsLastActivityAt);
  if (values.length === 0) return null;
  values.sort((left, right) => Date.parse(left) - Date.parse(right));
  return values[values.length - 1] ?? null;
}

/** The latest activity once `records` join the already sealed pipeline runs. */
function sealedRunActivity(
  previous: string | undefined,
  records: readonly CostTurnRecord[],
): string | undefined {
  let latest = previous;
  for (const record of records) {
    const at = record.completedAt ?? record.startedAt;
    if (latest === undefined || Date.parse(at) > Date.parse(latest))
      latest = at;
  }
  return latest;
}

function sealedRunActivityField(
  previous: string | undefined,
  records: readonly CostTurnRecord[],
): { readonly sealedRunsLastActivityAt?: string } {
  const latest = sealedRunActivity(previous, records);
  return latest === undefined ? {} : { sealedRunsLastActivityAt: latest };
}

/** Some filesystems report 0 for every file; that is no identity at all. */
function knownInode(value: unknown): number | undefined {
  return typeof value === 'number' && value !== 0 ? value : undefined;
}

function fileIdentityMatches(
  cursor: CostIndexCheckpoint['audit'][string] | undefined,
  inode: number | undefined,
): boolean {
  if (cursor === undefined) return false;
  const cursorInode = knownInode(cursor.ino);
  const fileInode = knownInode(inode);
  return (
    cursorInode === undefined ||
    fileInode === undefined ||
    cursorInode === fileInode
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function resultError<Value>(
  reason: CostErrorReason,
  message: string,
): CostViewResult<Value> {
  return frozen({ status: 'error', reason, message });
}

function resultUnavailable<Value>(
  reason: CostViewUnavailableReason,
): CostViewResult<Value> {
  return frozen({ status: 'unavailable', reason });
}

function resultOk<Value>(value: Value): CostViewResult<Value> {
  return frozen({ status: 'ok', value });
}

/**
 * The local cost projection. Audit lines are the source of truth; all writes
 * are content-free per-entry files and the global cursor is committed last.
 */
export class CostIndexStore {
  private activeRefresh: Promise<CostRefreshReceipt> | null = null;
  private writerTail: Promise<void> = Promise.resolve();
  private readonly pendingRefreshes = new Map<
    string,
    { trigger: CostInternalTrigger; scope?: CostScopeRef }
  >();
  private replayRequested = false;
  private replayVersion = 0;
  private replayTimer: ReturnType<typeof setTimeout> | null = null;
  private replayTask: Promise<void> | null = null;
  /**
   * Whether a pass this session has read every audit line from the start. A
   * file still missing after one belongs to a scope with no cost, so reads stop
   * requesting replays and no longer report the first build as running.
   */
  private fullScanCompleted = false;
  /** Scopes that read a missing file before the full scan finished. */
  private readonly scopesAwaitingFullScan = new Map<string, CostScopeRef>();
  private readonly scopedRefreshAt = new Map<string, number>();
  private retainedFillTimer: ReturnType<typeof setTimeout> | null = null;
  private retainedFillRunning = false;
  private retainedFillTask: Promise<void> | null = null;
  private retainedFillFailed = false;
  /**
   * Retired scope keys with the incarnation that was retired, or `null` when
   * the entry was already gone. A worktree id can be reused in the same
   * session; the fence applies to the retired incarnation only.
   */
  private readonly retiredScopes = new Map<
    string,
    { readonly incarnation: string | null; readonly retiredAtMs: number }
  >();
  /** Scopes whose files a restore is replacing; fenced whatever their identity. */
  private readonly restoringScopes = new Set<string>();
  private readonly sealedScopes = new Set<string>();
  /**
   * Live entries an archive in this process has sealed and not yet reopened.
   * A live entry sealed on disk without one is an archive that was interrupted.
   */
  private readonly archivingScopes = new Set<string>();
  /**
   * Entries where work finished while no view was showing them. Their next
   * `open` refresh runs even inside the open window, after a flush.
   */
  private readonly staleScopes = new Set<string>();
  /**
   * The scheduler marks scopes stale from its startup pass on. Before it, work
   * that finished went unrecorded, so every `open` refresh runs.
   */
  private finishedWorkTracked = false;
  private lateEntriesDropped = 0;

  public constructor(private readonly host: CostIndexHost) {}

  public async getScope(
    request: CostScopeRequest,
  ): Promise<CostViewResult<CostScopeView>> {
    try {
      const location = await this.host.resolveScope(request.scope);
      if (location === null) return resultUnavailable('no_scope');
      if (request.scope.kind === 'entry' && this.isRetired(location)) {
        return resultUnavailable('no_scope');
      }
      const summary = await this.readSummaryForLocation(location);
      const identities = await this.host.readChats(request.scope);
      const retentionDays = clampRetentionDays(
        await Promise.resolve(this.host.retentionDays()),
      );
      const projected = projectScopeView(
        summary,
        request.scope,
        identities,
        retentionDays,
        {
          ...(summary === null
            ? { emptyState: await this.missingSummaryState() }
            : summary.updatedAt === null
              ? { emptyState: await this.emptySummaryState() }
              : {}),
          ...(request.scope.kind === 'entry' &&
          summary !== null &&
          summary.pipelineRuns.length > 0 &&
          this.host.readPipelineRunStates !== undefined
            ? {
                runStates: await this.host.readPipelineRunStates(request.scope),
              }
            : {}),
        },
      );
      const value = scopeViewNamesProxyAccounts(projected)
        ? labelScopeView(projected, await this.readProxyAccountLabels())
        : projected;
      return resultOk(value);
    } catch (error) {
      return resultError('UNKNOWN', errorMessage(error));
    }
  }

  /** Labels never block a view: one that cannot be read leaves them empty. */
  private async readProxyAccountLabels(): Promise<ReadonlyMap<string, string>> {
    try {
      return (await this.host.readProxyAccountLabels?.()) ?? new Map();
    } catch {
      return new Map();
    }
  }

  public async getChat(
    request: CostChatRequest,
  ): Promise<CostViewResult<CostChatView>> {
    try {
      const location = await this.host.resolveScope(request.scope);
      if (location === null) return resultUnavailable('no_scope');
      if (request.scope.kind === 'entry' && this.isRetired(location)) {
        return resultUnavailable('no_scope');
      }
      const [summaryRead, chatRead, identities] = await Promise.all([
        this.readSummaryForLocation(location).then((summary) => ({ summary })),
        readChatFile(location.directory, request.chatId),
        this.host.readChats(request.scope),
      ]);
      const identity = identities.find(
        (candidate) => candidate.chatId === request.chatId,
      );
      if (chatRead.corrupt) {
        this.replayForCorrupt(request.scope);
      } else if (chatRead.value === null) {
        this.replayForMissing(request.scope);
      }
      if (identity === undefined) {
        return resultError('NOT_FOUND', 'Chat cost was not found');
      }
      const chatFile = chatRead.value ?? emptyChatFile(request.chatId);
      const value = projectChatView(
        chatFile,
        chatRead.value === null ? null : summaryRead.summary,
        request.scope,
        identity,
        request,
      );
      if (value === null)
        return resultError('NOT_FOUND', 'Chat cost was not found');
      return resultOk(
        chatViewNamesProxyAccounts(value)
          ? labelChatView(value, await this.readProxyAccountLabels())
          : value,
      );
    } catch (error) {
      return resultError('UNKNOWN', errorMessage(error));
    }
  }

  public async getPipelineRun(
    request: CostPipelineRunRequest,
  ): Promise<CostViewResult<PipelineRunCostView>> {
    try {
      const location = await this.host.resolveScope(request.scope);
      if (location === null) return resultUnavailable('no_scope');
      if (request.scope.kind === 'entry' && this.isRetired(location)) {
        return resultUnavailable('no_scope');
      }
      const summary = await this.readSummaryForLocation(location);
      const unattachedRead = await readJsonFile(
        path.join(location.directory, 'unattached.json'),
        isCostUnattachedFile,
      );
      if (unattachedRead.corrupt) {
        this.replayForCorrupt(request.scope);
      } else if (unattachedRead.value === null) {
        this.replayForMissing(request.scope);
      }
      const unattached = unattachedRead.value ?? emptyUnattached();
      const projected = projectPipelineRunView(
        unattached,
        summary,
        request.scope,
        request.executionId,
        await this.host.readPipelineRun(request.scope, request.executionId),
      );
      if (projected === null)
        return resultError('NOT_FOUND', 'Workflow run cost was not found');
      return resultOk(
        pipelineRunViewNamesProxyAccounts(projected)
          ? labelPipelineRunView(projected, await this.readProxyAccountLabels())
          : projected,
      );
    } catch (error) {
      return resultError('UNKNOWN', errorMessage(error));
    }
  }

  public async refresh(
    request: CostRefreshRequest,
  ): Promise<CostViewResult<CostRefreshReceipt>> {
    try {
      const location = await this.host.resolveScope(request.scope);
      if (location === null) return resultUnavailable('no_scope');
      if (request.scope.kind === 'retained') {
        return resultError(
          'SCOPE_SEALED',
          'Retained cost scopes cannot be refreshed',
        );
      }
      if (this.isRetired(location)) {
        return resultUnavailable('no_scope');
      }
      if (request.trigger === 'open' && !this.finishedWorkTracked) {
        this.staleScopes.add(costScopeKey(request.scope));
      }
      if (request.trigger === 'open') {
        const checkpoint = await this.readCheckpoint();
        const globalAt = checkpoint?.lastRefresh?.completedAt;
        const scopedAt = this.scopedRefreshAt.get(costScopeKey(request.scope));
        const globalMs = globalAt === undefined ? 0 : Date.parse(globalAt);
        const latestRefresh = Math.max(globalMs, scopedAt ?? 0);
        if (
          !this.replayRequested &&
          !this.staleScopes.has(costScopeKey(request.scope)) &&
          latestRefresh > 0 &&
          this.now().getTime() - latestRefresh < OPEN_REFRESH_STALE_MS
        ) {
          const updatedAt =
            globalMs >= (scopedAt ?? 0)
              ? (globalAt ?? new Date(latestRefresh).toISOString())
              : new Date(scopedAt ?? latestRefresh).toISOString();
          return resultOk({
            ran: false,
            updatedAt,
            revision:
              (await this.readSummaryForLocation(location))?.revision ?? 0,
          });
        }
      }
      const receipt = await this.refreshInternal(
        request.trigger,
        request.scope,
      );
      return resultOk(receipt);
    } catch (error) {
      return resultError('UNKNOWN', errorMessage(error));
    }
  }

  /**
   * Work finished in an entry that no view is showing. Nothing is read now;
   * the entry's next `open` refresh is not skipped.
   */
  public markScopeStale(scope: CostScopeRef): void {
    if (scope.kind === 'entry') this.staleScopes.add(costScopeKey(scope));
  }

  /** Scoped passes leave the global checkpoint unchanged for the next full scan. */
  public refreshInternal(
    trigger: CostInternalTrigger,
    scope?: CostScopeRef,
  ): Promise<CostRefreshReceipt> {
    // Only the scheduler queues `startup`, as it subscribes to finished work.
    if (trigger === 'startup') this.finishedWorkTracked = true;
    if (this.activeRefresh !== null) {
      this.enqueueRefresh({
        trigger,
        ...(scope === undefined ? {} : { scope }),
      });
      return this.activeRefresh;
    }
    this.pendingRefreshes.clear();
    this.enqueueRefresh({ trigger, ...(scope === undefined ? {} : { scope }) });
    const run = async (): Promise<CostRefreshReceipt> => {
      let receipt: CostRefreshReceipt = {
        ran: false,
        updatedAt: null,
        revision: 0,
      };
      let current = this.takeNextRefresh();
      while (current !== null) {
        receipt = await this.performRefresh(current.trigger, current.scope);
        current = this.takeNextRefresh();
      }
      return frozen(receipt);
    };
    this.activeRefresh = run().finally((): void => {
      this.activeRefresh = null;
      this.pendingRefreshes.clear();
    });
    return this.activeRefresh;
  }

  /** Wait for refreshes, scheduled repair/fill work, and the final writer barrier. */
  public async waitForIdle(): Promise<void> {
    for (;;) {
      const refresh = this.activeRefresh;
      if (refresh !== null) await refresh;
      const replay = this.replayTask;
      if (replay !== null) await replay;
      const retainedFill = this.retainedFillTask;
      if (retainedFill !== null) await retainedFill;
      await this.withWriterLock(() => Promise.resolve());
      if (
        this.activeRefresh === null &&
        this.replayTask === null &&
        this.retainedFillTask === null &&
        this.replayTimer === null &&
        this.retainedFillTimer === null &&
        !this.retainedFillRunning
      )
        break;
    }
    if (this.retainedFillFailed)
      throw new Error('Initial retained cost fill did not complete');
  }

  private enqueueRefresh(request: {
    readonly trigger: CostInternalTrigger;
    readonly scope?: CostScopeRef;
  }): void {
    // One global pass covers every queued scope. It keeps the strongest
    // trigger among the requests it stands in for, so a folded manual or
    // archive request still flushes observability before it reads.
    const global = this.pendingRefreshes.get('*');
    if (request.scope === undefined) {
      let strongest: { trigger: CostInternalTrigger } = {
        trigger: request.trigger,
      };
      this.pendingRefreshes.forEach((pending): void => {
        strongest = choosePendingTrigger(strongest, {
          trigger: pending.trigger,
        });
      });
      this.pendingRefreshes.clear();
      this.pendingRefreshes.set('*', { trigger: strongest.trigger });
      return;
    }
    if (global !== undefined) {
      this.pendingRefreshes.set(
        '*',
        choosePendingTrigger(global, { trigger: request.trigger }),
      );
      return;
    }
    const key = costScopeKey(request.scope);
    this.pendingRefreshes.set(
      key,
      choosePendingTrigger(this.pendingRefreshes.get(key) ?? null, request),
    );
  }

  private takeNextRefresh(): {
    readonly trigger: CostInternalTrigger;
    readonly scope?: CostScopeRef;
  } | null {
    const global = this.pendingRefreshes.get('*');
    if (global !== undefined) {
      this.pendingRefreshes.clear();
      return global;
    }
    const first = Array.from(this.pendingRefreshes.entries())[0];
    if (first === undefined) return null;
    this.pendingRefreshes.delete(first[0]);
    return first[1];
  }

  /**
   * Called by audit retention before unlinking a day file; this never flushes
   * observability. Resolves with the identity of the file it consumed
   * completely, or null when the file may still hold unread lines.
   */
  public async catchUpAndSealDay(
    dayFilename: string,
  ): Promise<AuditDayFileIdentity | null> {
    const day = parseDayFilename(dayFilename);
    if (day === null) return null;
    try {
      await this.refreshInternal('idle');
      await this.waitForIdle();
      const auditDirectory = this.host.auditDirectory();
      const filePath = path.join(auditDirectory, dayFilename);
      const before = await this.withWriterLock(async () => {
        const fileStats = await stat(filePath);
        const checkpoint = await this.readCheckpoint();
        const cursor = checkpoint?.audit[dayFilename];
        const inode = knownInode(fileStats.ino);
        if (
          cursor === undefined ||
          cursor.offset < fileStats.size ||
          !fileIdentityMatches(cursor, inode)
        )
          return null;
        return {
          size: fileStats.size,
          mtimeMs: fileStats.mtimeMs,
          ...(inode === undefined ? {} : { ino: inode }),
        };
      });
      if (before === null) return null;
      const targets = await this.scopesMentionedInDay(
        filePath,
        before.size,
        day,
      );
      for (const location of targets) await this.sealDayInScope(location, day);
      return this.withWriterLock(async () => {
        const after = await stat(filePath);
        const inode = knownInode(after.ino);
        if (
          !sameAuditDayFileIdentity(before, {
            size: after.size,
            mtimeMs: after.mtimeMs,
            ...(inode === undefined ? {} : { ino: inode }),
          })
        )
          return null;
        const checkpoint = await this.readCheckpoint();
        const cursor = checkpoint?.audit[dayFilename];
        return cursor !== undefined &&
          cursor.offset >= after.size &&
          fileIdentityMatches(cursor, inode)
          ? before
          : null;
      });
    } catch {
      return null;
    }
  }

  public async sealScope(scope: CostScopeRef): Promise<void> {
    const key = costScopeKey(scope);
    if (scope.kind === 'entry') this.archivingScopes.add(key);
    if (this.sealedScopes.has(key)) return;
    // Fence first, then drain the current writer. This closes the gap between
    // archive's refresh and its capture/removal operation.
    this.sealedScopes.add(key);
    await this.activeRefresh;
    const location = await this.host.resolveScope(scope);
    if (location === null) return;
    await this.host.withRetainedLock(scope, async (): Promise<void> => {
      await this.withWriterLock(async (): Promise<void> => {
        const currentLocation = await this.host.resolveScope(scope);
        if (
          currentLocation === null ||
          currentLocation.incarnation !== location.incarnation ||
          currentLocation.directory !== location.directory
        )
          return;
        const { state } = await this.loadScopeState(currentLocation);
        if (state.summary?.sealedAt !== undefined) {
          this.sealedScopes.add(key);
          return;
        }
        await this.sealAllState(state);
        await this.persistFilesOnly(state);
        const sealedAt = this.now().toISOString();
        state.summary = await this.rebuildSummary(state, {
          updatedAt: latestActivity(
            Array.from(state.chatFiles.values()),
            state.unattached,
          ),
          sealedAt,
          forceRevision: true,
        });
        await writeSummaryFile(currentLocation.directory, state.summary);
        this.sealedScopes.add(key);
        emitUpdate(scope, state.summary.revision);
      });
    });
  }

  /**
   * Undo the temporary archive seal when the surrounding transaction rolls
   * back (or after its retained copy is durable). Aggregates and tombstones
   * remain compacted, but the canonical live identity becomes writable again.
   */
  public async resumeScope(scope: CostScopeRef): Promise<void> {
    if (scope.kind !== 'entry') return;
    const key = costScopeKey(scope);
    this.sealedScopes.add(key);
    let sameEntry = false;
    try {
      await this.drainActiveRefresh();
      const location = await this.host.resolveScope(scope);
      if (location === null) return;
      await this.host.withRetainedLock(scope, async (): Promise<void> => {
        await this.withWriterLock(async (): Promise<void> => {
          const currentLocation = await this.host.resolveScope(scope);
          if (
            currentLocation === null ||
            currentLocation.incarnation !== location.incarnation ||
            currentLocation.directory !== location.directory
          )
            throw new Error('Cost scope incarnation changed before resume');
          const read = await readSummaryFile(location.directory);
          const summary = read.value;
          // Never unseal a copied/reused directory under a different canonical
          // incarnation. The lifecycle caller may be unwinding an old operation.
          if (
            summary === null ||
            summary.incarnation !== location.incarnation ||
            summary.projectId !== scope.projectId ||
            summary.scopeId !== scope.worktreeId
          ) {
            throw new Error('Cost scope incarnation changed before resume');
          }
          sameEntry = true;
          if (summary.sealedAt !== undefined) {
            const resumed = reopenedSummary(summary);
            await writeSummaryFile(location.directory, resumed);
            emitUpdate(scope, resumed.revision);
          }
          this.sealedScopes.delete(key);
        });
      });
    } catch (error) {
      // The reopen did not land, but the entry is still the sealed one: lift
      // the fence so the next load reopens it instead of dropping its turns.
      if (sameEntry) this.sealedScopes.delete(key);
      throw error;
    } finally {
      // The archive is over either way. A seal still on disk is now an
      // interrupted one.
      this.archivingScopes.delete(key);
    }
  }

  /** Fence the scope before cleanup, then wait until every in-flight writer has finished. */
  public async retireScope(scope: CostScopeRef): Promise<void> {
    const key = costScopeKey(scope);
    // Fence at once; the incarnation is filled in after the lookup.
    const retiredAtMs = this.now().getTime();
    this.retiredScopes.set(key, { incarnation: null, retiredAtMs });
    this.sealedScopes.add(key);
    this.archivingScopes.delete(key);
    this.staleScopes.delete(key);
    const location = await this.host.resolveScope(scope).catch(() => null);
    if (
      location !== null &&
      this.retiredScopes.get(key)?.retiredAtMs === retiredAtMs
    ) {
      this.retiredScopes.set(key, {
        incarnation: location.incarnation,
        retiredAtMs,
      });
    }
    await this.activeRefresh;
    await this.withWriterLock(() => Promise.resolve());
  }

  /** Wait out the refresh in flight. Its failure belongs to its own caller. */
  private async drainActiveRefresh(): Promise<void> {
    await this.activeRefresh?.catch(() => undefined);
  }

  /**
   * Whether this location is the incarnation that was retired. A new entry
   * that took the same id lifts both fences and is indexed like any other.
   */
  private isRetired(location: CostScopeLocation): boolean {
    const key = costScopeKey(location.scope);
    if (this.restoringScopes.has(key)) return true;
    const retired = this.retiredScopes.get(key);
    if (retired === undefined) return false;
    const isNewEntry =
      retired.incarnation === null
        ? Date.parse(location.createdAt) > retired.retiredAtMs
        : location.incarnation !== retired.incarnation;
    if (!isNewEntry) return true;
    this.retiredScopes.delete(key);
    this.sealedScopes.delete(key);
    return false;
  }

  /** Copy retained JSON back under the restored live identity and reopen its writer. */
  public async restoreScope(
    directory: string,
    scope: CostScopeRef,
    incarnation: string,
  ): Promise<void> {
    if (scope.kind !== 'entry')
      throw new Error('Restore destination must be a live entry');
    const key = costScopeKey(scope);
    // Fence readers and writers until the restored files are in place.
    this.restoringScopes.add(key);
    this.sealedScopes.add(key);
    try {
      await this.drainActiveRefresh();
      await this.withWriterLock(async (): Promise<void> => {
        const location = await this.host.resolveScope(scope);
        if (location === null)
          throw new Error('Restored cost scope is not available');
        if (path.resolve(directory) !== path.resolve(location.directory)) {
          await rm(location.directory, { recursive: true, force: true });
          await cp(directory, location.directory, {
            recursive: true,
            force: true,
          });
        }
        const loaded = await readSummaryFile(location.directory);
        if (loaded.value !== null) {
          const rewritten: CostSummaryFile = {
            version: loaded.value.version,
            projectId: scope.projectId,
            scopeId: scope.worktreeId,
            incarnation,
            updatedAt: loaded.value.updatedAt,
            ...(loaded.value.coverageStart === undefined
              ? {}
              : { coverageStart: loaded.value.coverageStart }),
            retentionDays: loaded.value.retentionDays,
            revision: loaded.value.revision,
            totals: loaded.value.totals,
            chats: loaded.value.chats,
            pipelineRuns: loaded.value.pipelineRuns,
            ...(loaded.value.unattached === undefined
              ? {}
              : { unattached: loaded.value.unattached }),
            hasCodexEstimate: loaded.value.hasCodexEstimate,
          };
          await writeSummaryFile(location.directory, rewritten);
        }
        // Lifted under the lock, so the next writer finds the entry open.
        this.sealedScopes.delete(key);
        this.archivingScopes.delete(key);
        this.retiredScopes.delete(key);
        this.restoringScopes.delete(key);
      });
    } finally {
      // A restore that fails leaves an entry without its earlier cost, never
      // a fenced one: files of another incarnation are discarded on load.
      this.restoringScopes.delete(key);
      this.sealedScopes.delete(key);
      this.archivingScopes.delete(key);
    }
  }

  /** Fast stat-only check used by the idle scheduler. */
  public async hasAuditGrowth(): Promise<boolean> {
    const checkpoint = await this.readCheckpoint();
    let filenames: string[];
    try {
      filenames = await readdir(this.host.auditDirectory());
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    for (const filename of filenames) {
      if (parseDayFilename(filename) === null) continue;
      let fileStats;
      try {
        fileStats = await stat(path.join(this.host.auditDirectory(), filename));
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      const cursor = checkpoint?.audit[filename];
      // A trailing partial JSONL line sits behind the byte cursor. Wait for
      // stat growth instead of rescanning that same partial line every tick.
      if (fileStats.size > (cursor?.size ?? 0)) {
        return true;
      }
    }
    return false;
  }

  private async performRefresh(
    trigger: CostInternalTrigger,
    scope?: CostScopeRef,
  ): Promise<CostRefreshReceipt> {
    return this.withWriterLock(() =>
      this.performRefreshWhileLocked(trigger, scope),
    );
  }

  private async performRefreshWhileLocked(
    trigger: CostInternalTrigger,
    scope?: CostScopeRef,
  ): Promise<CostRefreshReceipt> {
    if (scope !== undefined && trigger !== 'startup' && trigger !== 'idle') {
      return this.performScopedRefresh(trigger, scope);
    }
    if (trigger === 'manual' || trigger === 'archive') await this.host.flush();
    const startedAt = this.now().toISOString();
    const startedMs = this.now().getTime();
    const replayVersion = this.replayVersion;
    const replaying = this.replayRequested;
    let checkpoint = await this.loadOrCreateCheckpoint();
    if (replaying) checkpoint = { ...checkpoint, audit: {} };
    let pass = await this.runRefreshPass(checkpoint);
    let fullScan = Object.keys(checkpoint.audit).length === 0;
    if (pass.forceReplay) {
      checkpoint = { ...pass.checkpoint, audit: {} };
      pass = await this.runRefreshPass(checkpoint);
      fullScan = true;
    }

    const shouldScheduleRetainedFill =
      !pass.checkpoint.retainedFillComplete && trigger !== 'archive';
    checkpoint = pass.checkpoint;

    const completedAt = this.now().toISOString();
    const completedMs = this.now().getTime();
    checkpoint = {
      ...checkpoint,
      lastRefresh: {
        trigger,
        startedAt,
        completedAt,
        linesRead: pass.linesRead,
        durationMs: Math.max(0, completedMs - startedMs),
      },
    };
    await writeCheckpointFile(this.host.checkpointPath(), checkpoint);
    if (this.replayVersion === replayVersion) this.replayRequested = false;
    const confirmedScopes = fullScan ? this.completeFullScan() : [];
    if (shouldScheduleRetainedFill) {
      this.scheduleInitialRetainedFill(checkpoint.firstBuild.coverageStart);
    }
    for (const changed of pass.changed)
      emitUpdate(changed.scope, changed.revision);
    // Views of a scope the replay confirmed empty reload out of `building`.
    for (const scope of confirmedScopes) emitUpdate(scope, 0);
    const summary = pass.changed[pass.changed.length - 1];
    return {
      ran: true,
      updatedAt: summary?.updatedAt ?? completedAt,
      revision: summary?.revision ?? 0,
    };
  }

  /**
   * Consume audit slices for one live scope only. The global cursor is not
   * advanced: a later idle/startup pass safely consumes every other scope.
   */
  private async performScopedRefresh(
    trigger: CostInternalTrigger,
    scope: CostScopeRef,
  ): Promise<CostRefreshReceipt> {
    const key = costScopeKey(scope);
    // A turn refresh runs as the turn's entry is queued, and a stale scope has
    // entries queued since its last read: both need them on disk first.
    if (
      trigger === 'manual' ||
      trigger === 'archive' ||
      trigger === 'turn' ||
      this.staleScopes.has(key)
    ) {
      await this.host.flush();
    }
    this.staleScopes.delete(key);
    if (scope.kind !== 'entry') {
      return { ran: false, updatedAt: null, revision: 0 };
    }
    const location = await this.host.resolveScope(scope);
    if (location === null) return { ran: false, updatedAt: null, revision: 0 };
    if (this.isRetired(location) || this.sealedScopes.has(key)) {
      return { ran: false, updatedAt: null, revision: 0 };
    }
    const checkpoint = await this.loadOrCreateCheckpoint();
    const existing = await readScopeFiles(location.directory);
    const existingSummary = existing.summary.value;
    const hasMissingChat =
      existingSummary !== null &&
      existingSummary.chats.some(
        (chat) => !existing.chats.some((file) => file.chatId === chat.chatId),
      );
    const needsReplay =
      existingSummary === null ||
      existing.corrupt ||
      hasMissingChat ||
      existingSummary.incarnation !== location.incarnation ||
      existingSummary.projectId !== scope.projectId ||
      existingSummary.scopeId !== scopeId(scope);
    const { files } = await this.listAuditFiles(
      needsReplay ? { ...checkpoint, audit: {} } : checkpoint,
    );
    const states = new Map<string, ScopeState>();
    for (const file of files) {
      const billingEvidence = new BillingEvidencePass();
      await this.readAuditLines(
        file,
        file.reset ? 0 : file.startOffset,
        async (line): Promise<void> => {
          const entry = parseAuditLine(line);
          if (entry === null) return;
          const repairedEntry = billingEvidence.apply(entry);
          const record = classifyAuditEntry(repairedEntry);
          if (record === null) {
            const identity = validRemovalIdentity(entry);
            if (
              identity === null ||
              costScopeKey(identity.scope) !== key ||
              dateIsBefore(entry.startedAt, location.createdAt) ||
              this.isRetired(location) ||
              this.sealedScopes.has(key)
            ) {
              return;
            }
            const stateResult = await this.stateFor(location, states);
            const state = stateResult.state;
            if (state.summary?.sealedAt !== undefined) {
              this.sealedScopes.add(key);
              return;
            }
            this.removeUnsealedRecord(state, identity.entryId);
            return;
          }
          const auditScope = scopeFromAudit(entry);
          if (
            auditScope === null ||
            costScopeKey(auditScope) !== key ||
            dateIsBefore(record.startedAt, location.createdAt)
          )
            return;
          if (this.isRetired(location) || this.sealedScopes.has(key)) return;
          const stateResult = await this.stateFor(location, states);
          const state = stateResult.state;
          if (state.summary?.sealedAt !== undefined) {
            this.sealedScopes.add(key);
            return;
          }
          this.upsertRecord(state, record);
        },
      );
    }

    let state = states.get(key);
    if (
      state === undefined &&
      existingSummary === null &&
      !this.isRetired(location) &&
      !this.sealedScopes.has(key)
    ) {
      // The replay found nothing for this entry. An empty summary records
      // that, so the next refresh reads only what was appended since instead
      // of every audit file again.
      state = { ...this.emptyScopeState(location), forceWrite: false };
    }
    let summary: CostSummaryFile | null = null;
    if (state !== undefined) {
      summary = await this.persistScopeState(
        state,
        checkpoint.firstBuild.coverageStart,
      );
    }
    const completedAt = this.now();
    this.scopedRefreshAt.set(key, completedAt.getTime());
    if (summary !== null) emitUpdate(scope, summary.revision);
    return {
      ran: true,
      updatedAt: summary?.updatedAt ?? completedAt.toISOString(),
      revision: summary?.revision ?? state?.summary?.revision ?? 0,
    };
  }

  private async runRefreshPass(
    currentCheckpoint: CostIndexCheckpoint,
  ): Promise<RefreshPassResult> {
    const { files: fileRecords, present } =
      await this.listAuditFiles(currentCheckpoint);
    // A cursor for a day file that is gone (retention deleted it) has nothing
    // left to resume; keeping it would grow the checkpoint forever.
    const audit: Record<string, CostIndexCheckpoint['audit'][string]> =
      Object.fromEntries(
        Object.entries(currentCheckpoint.audit).filter(([filename]) =>
          present.has(filename),
        ),
      );
    const scopeStates = new Map<string, ScopeState>();
    const resolved = new Map<string, Promise<CostScopeLocation | null>>();
    let forceReplay = false;
    let linesRead = 0;

    for (const file of fileRecords) {
      const billingEvidence = new BillingEvidencePass();
      const cursorOffset = file.reset ? 0 : file.startOffset;
      if (file.reset) {
        audit[file.filename] = {
          offset: 0,
          size: file.size,
          mtimeMs: file.mtimeMs,
          ...(file.ino === undefined ? {} : { ino: file.ino }),
        };
      }
      const result = await this.readAuditLines(
        file,
        cursorOffset,
        async (line): Promise<void> => {
          linesRead += 1;
          const entry = parseAuditLine(line);
          if (entry === null) return;
          const repairedEntry = billingEvidence.apply(entry);
          const record = classifyAuditEntry(repairedEntry);
          const identity = record === null ? validRemovalIdentity(entry) : null;
          const scope =
            record === null ? identity?.scope : scopeFromAudit(entry);
          if (scope === null || scope === undefined) return;
          const key = costScopeKey(scope);
          const locationPromise =
            resolved.get(key) ?? this.host.resolveScope(scope);
          resolved.set(key, locationPromise);
          const location = await locationPromise;
          if (location === null) {
            if (record !== null) this.lateEntriesDropped += 1;
            return;
          }
          if (this.isRetired(location) || this.sealedScopes.has(key)) {
            if (record !== null) this.lateEntriesDropped += 1;
            return;
          }
          if (
            dateIsBefore(
              record === null ? entry.startedAt : record.startedAt,
              location.createdAt,
            )
          ) {
            return;
          }
          const stateResult = await this.stateFor(location, scopeStates);
          if (record !== null && stateResult.corrupt) {
            forceReplay = true;
          }
          const state = stateResult.state;
          if (state.summary?.sealedAt !== undefined) {
            this.sealedScopes.add(key);
            if (record !== null) this.lateEntriesDropped += 1;
            return;
          }
          if (record === null) {
            if (identity !== null) {
              this.removeUnsealedRecord(state, identity.entryId);
            }
            return;
          }
          this.upsertRecord(state, record);
        },
      );
      const offset = result.offset;
      audit[file.filename] = {
        offset,
        size: file.size,
        mtimeMs: file.mtimeMs,
        ...(file.ino === undefined ? {} : { ino: file.ino }),
      };
    }

    const changed: {
      scope: CostScopeRef;
      revision: number;
      updatedAt: string | null;
    }[] = [];
    for (const state of Array.from(scopeStates.values())) {
      const summary = await this.persistScopeState(
        state,
        currentCheckpoint.firstBuild.coverageStart,
      );
      if (summary !== null)
        changed.push({
          scope: state.location.scope,
          revision: summary.revision,
          updatedAt: summary.updatedAt,
        });
    }
    const checkpoint: CostIndexCheckpoint = {
      ...currentCheckpoint,
      generation: CURRENT_GENERATION,
      audit,
      lastRefresh: currentCheckpoint.lastRefresh,
    };
    // This result object is not written until all scope files and summaries are durable.
    return { checkpoint, changed, linesRead, forceReplay };
  }

  /** The day files to read, and the names of every day file that exists. */
  private async listAuditFiles(checkpoint: CostIndexCheckpoint): Promise<{
    readonly files: AuditFile[];
    readonly present: ReadonlySet<string>;
  }> {
    const directory = this.host.auditDirectory();
    const present = new Set<string>();
    let filenames: string[];
    try {
      filenames = await readdir(directory);
    } catch (error) {
      if (isMissing(error)) return { files: [], present };
      throw error;
    }
    const files: AuditFile[] = [];
    for (const filename of filenames.sort()) {
      if (parseDayFilename(filename) === null) continue;
      const filePath = path.join(directory, filename);
      let fileStats;
      try {
        fileStats = await stat(filePath);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      present.add(filename);
      const inode = knownInode(fileStats.ino);
      const cursor = checkpoint.audit[filename];
      const reset =
        cursor !== undefined &&
        (fileStats.size < cursor.offset ||
          fileStats.size < cursor.size ||
          !fileIdentityMatches(cursor, inode) ||
          (fileStats.size === cursor.size &&
            fileStats.mtimeMs !== cursor.mtimeMs));
      const unchanged =
        cursor !== undefined &&
        !reset &&
        cursor.size === fileStats.size &&
        cursor.mtimeMs === fileStats.mtimeMs &&
        fileIdentityMatches(cursor, inode);
      if (unchanged) continue;
      files.push({
        filename,
        filePath,
        size: fileStats.size,
        mtimeMs: fileStats.mtimeMs,
        ...(inode === undefined ? {} : { ino: inode }),
        cursor,
        startOffset: reset ? 0 : (cursor?.offset ?? 0),
        reset,
      });
    }
    return { files, present };
  }

  private async readAuditLines(
    file: AuditFile,
    offset: number,
    visit: (line: string) => Promise<void> | void,
  ): Promise<{ readonly offset: number }> {
    const handle = await open(file.filePath, 'r');
    let readPosition = offset;
    let consumedOffset = offset;
    let pending = Buffer.alloc(0);
    try {
      while (readPosition < file.size) {
        const beforeSlice = performance.now();
        const buffer = Buffer.alloc(
          Math.min(MAX_AUDIT_SLICE_BYTES, file.size - readPosition),
        );
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.byteLength,
          readPosition,
        );
        if (bytesRead === 0) break;
        readPosition += bytesRead;
        const input =
          pending.length === 0
            ? buffer.subarray(0, bytesRead)
            : Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
        let lineStart = 0;
        for (let index = 0; index < input.length; index += 1) {
          if (input[index] !== 0x0a) continue;
          const line = input
            .subarray(lineStart, index)
            .toString('utf8')
            .replace(/\r$/, '');
          if (line.length > 0) await visit(line);
          lineStart = index + 1;
        }
        consumedOffset = readPosition - (input.length - lineStart);
        pending = input.subarray(lineStart);
        this.host.onSlice?.(performance.now() - beforeSlice, bytesRead);
        await this.yieldToMain();
      }
    } finally {
      await handle.close();
    }
    return { offset: consumedOffset };
  }

  private async stateFor(
    location: CostScopeLocation,
    states: Map<string, ScopeState>,
  ): Promise<{ readonly state: ScopeState; readonly corrupt: boolean }> {
    const key = costScopeKey(location.scope);
    const present = states.get(key);
    if (present !== undefined) return { state: present, corrupt: false };
    const loaded = await this.loadScopeState(location);
    states.set(key, loaded.state);
    return { state: loaded.state, corrupt: loaded.corrupt };
  }

  private async loadScopeState(
    location: CostScopeLocation,
  ): Promise<{ readonly state: ScopeState; readonly corrupt: boolean }> {
    const files = await readScopeFiles(location.directory);
    let summary = files.summary.value;
    const expectedId = scopeId(location.scope);
    if (
      summary !== null &&
      (summary.incarnation !== location.incarnation ||
        summary.projectId !== location.scope.projectId ||
        summary.scopeId !== expectedId)
    ) {
      await rm(location.directory, { recursive: true, force: true });
      return { state: this.emptyScopeState(location), corrupt: true };
    }
    if (
      summary !== null &&
      summary.sealedAt !== undefined &&
      location.scope.kind === 'entry' &&
      !this.archivingScopes.has(costScopeKey(location.scope))
    ) {
      // Only an archive seals a live entry, and it reopens the entry when it
      // ends. This one never did (the app exited, or the reopen failed), so
      // reopen it here, before any turn is dropped as arriving after the seal.
      summary = reopenedSummary(summary);
      await writeSummaryFile(location.directory, summary);
      emitUpdate(location.scope, summary.revision);
    }
    const chatFiles = new Map<string, MutableCostChatFile>();
    const originalChats = new Map<string, string>();
    for (const chat of files.chats) {
      chatFiles.set(chat.chatId, { ...chat, records: { ...chat.records } });
      originalChats.set(chat.chatId, stableJson(chat));
    }
    const unattached: MutableCostUnattachedFile =
      files.unattached.value === null
        ? emptyUnattached()
        : {
            ...files.unattached.value,
            records: { ...files.unattached.value.records },
          };
    const recordLocationsByEntryId = new Map<
      string,
      Map<string, RecordLocation>
    >();
    const sealedEntryIds = new Set<string>();
    chatFiles.forEach((chat, chatId) => {
      for (const entryId of chat.sealedEntryIds ?? []) {
        sealedEntryIds.add(entryId);
      }
      for (const record of Object.values(chat.records)) {
        indexRecordLocation(recordLocationsByEntryId, record.entryId, {
          kind: 'chat',
          chatId,
        });
      }
    });
    for (const entryId of unattached.sealedEntryIds ?? []) {
      sealedEntryIds.add(entryId);
    }
    for (const record of Object.values(unattached.records)) {
      indexRecordLocation(recordLocationsByEntryId, record.entryId, {
        kind: 'unattached',
      });
    }
    return {
      state: {
        location,
        summary,
        chatFiles,
        originalChats,
        recordLocationsByEntryId,
        sealedEntryIds,
        unattached,
        originalUnattached:
          files.unattached.value === null ? null : stableJson(unattached),
        touchedChats: new Set(),
        unattachedTouched: false,
        forceWrite: files.corrupt,
      },
      corrupt: files.corrupt,
    };
  }

  private emptyScopeState(location: CostScopeLocation): ScopeState {
    return {
      location,
      summary: null,
      chatFiles: new Map(),
      originalChats: new Map(),
      recordLocationsByEntryId: new Map(),
      sealedEntryIds: new Set(),
      unattached: emptyUnattached(),
      originalUnattached: null,
      touchedChats: new Set(),
      unattachedTouched: false,
      forceWrite: true,
    };
  }

  private upsertRecord(state: ScopeState, record: CostTurnRecord): void {
    if (state.sealedEntryIds.has(record.entryId)) return;
    if (
      record.pipeline === undefined &&
      record.chatId !== undefined &&
      record.chatId.length > 0
    ) {
      const existing =
        state.chatFiles.get(record.chatId) ?? emptyChatFile(record.chatId);
      indexRecordLocation(state.recordLocationsByEntryId, record.entryId, {
        kind: 'chat',
        chatId: record.chatId,
      });
      const previous = existing.records[record.entryId];
      if (previous !== undefined && sameJson(previous, record)) return;
      existing.records[record.entryId] = record;
      state.chatFiles.set(record.chatId, existing);
      state.touchedChats.add(record.chatId);
      return;
    }
    indexRecordLocation(state.recordLocationsByEntryId, record.entryId, {
      kind: 'unattached',
    });
    const previous = state.unattached.records[record.entryId];
    if (previous !== undefined && sameJson(previous, record)) return;
    // In place, as chat records are: copying every record on each upsert grew
    // a week's index build with the number of helper records.
    state.unattached.records[record.entryId] = record;
    state.unattachedTouched = true;
  }

  private removeUnsealedRecord(state: ScopeState, entryId: string): boolean {
    if (state.sealedEntryIds.has(entryId)) return false;
    const locations = state.recordLocationsByEntryId.get(entryId);
    if (locations === undefined) return false;

    let removed = false;
    Array.from(locations.values()).forEach((location) => {
      if (location.kind === 'chat') {
        const chat = state.chatFiles.get(location.chatId);
        if (chat?.records[entryId] === undefined) return;
        delete chat.records[entryId];
        state.touchedChats.add(location.chatId);
        removed = true;
        return;
      }
      if (state.unattached.records[entryId] === undefined) return;
      delete state.unattached.records[entryId];
      state.unattachedTouched = true;
      removed = true;
    });
    state.recordLocationsByEntryId.delete(entryId);
    return removed;
  }

  private async persistScopeState(
    state: ScopeState,
    coverageStart: string,
  ): Promise<CostSummaryFile | null> {
    const directory = state.location.directory;
    for (const [chatId, chat] of Array.from(state.chatFiles.entries())) {
      const current = stableJson(chat);
      if (
        state.forceWrite ||
        state.touchedChats.has(chatId) ||
        state.originalChats.get(chatId) !== current
      ) {
        if (state.originalChats.get(chatId) !== current || state.forceWrite) {
          await writeChatFile(directory, chat);
          state.originalChats.set(chatId, current);
        }
      }
    }
    const unattachedJson = stableJson(state.unattached);
    if (
      (state.unattachedTouched || state.forceWrite) &&
      (state.originalUnattached !== unattachedJson || state.forceWrite)
    ) {
      await writeUnattachedFile(directory, state.unattached);
      state.originalUnattached = unattachedJson;
    }
    const latest = latestActivity(
      Array.from(state.chatFiles.values()),
      state.unattached,
    );
    const chatCoverage =
      state.summary?.coverageStart ??
      (dateIsBefore(state.location.createdAt, coverageStart)
        ? coverageStart
        : undefined);
    const retentionDays =
      state.summary?.retentionDays ??
      clampRetentionDays(await Promise.resolve(this.host.retentionDays()));
    const summary = await this.rebuildSummary(state, {
      updatedAt: latest,
      ...(chatCoverage === undefined ? {} : { coverageStart: chatCoverage }),
      retentionDays,
    });
    if (state.summary === null || !sameJson(state.summary, summary)) {
      state.summary = summary;
      await writeSummaryFile(directory, summary);
      state.forceWrite = false;
      return summary;
    }
    state.summary = summary;
    state.forceWrite = false;
    return null;
  }

  private async rebuildSummary(
    state: ScopeState,
    metadata: {
      readonly updatedAt: string | null;
      readonly coverageStart?: string;
      readonly retentionDays?: number;
      readonly sealedAt?: string;
      readonly forceRevision?: boolean;
    },
  ): Promise<CostSummaryFile> {
    const chats = Array.from(state.chatFiles.values()).sort((left, right) =>
      left.chatId.localeCompare(right.chatId),
    );
    const sealedAt = metadata.sealedAt ?? state.summary?.sealedAt;
    // A rebuild never drops the boundary of an entry's partial history.
    const coverageStart =
      metadata.coverageStart ?? state.summary?.coverageStart;
    const current = buildSummary(state.location, chats, state.unattached, {
      updatedAt: metadata.updatedAt,
      ...(coverageStart === undefined ? {} : { coverageStart }),
      retentionDays:
        metadata.retentionDays ??
        state.summary?.retentionDays ??
        clampRetentionDays(await Promise.resolve(this.host.retentionDays())),
      revision: state.summary?.revision ?? 0,
      ...(sealedAt === undefined ? {} : { sealedAt }),
    });
    if (
      state.summary === null ||
      metadata.forceRevision === true ||
      !sameJson(state.summary, current)
    ) {
      return buildSummary(state.location, chats, state.unattached, {
        updatedAt: metadata.updatedAt,
        ...(coverageStart === undefined ? {} : { coverageStart }),
        retentionDays:
          metadata.retentionDays ??
          state.summary?.retentionDays ??
          clampRetentionDays(await Promise.resolve(this.host.retentionDays())),
        revision: (state.summary?.revision ?? 0) + 1,
        ...(sealedAt === undefined ? {} : { sealedAt }),
      });
    }
    return current;
  }

  private async sealAllState(state: ScopeState): Promise<void> {
    const newlySealed: CostTurnRecord[] = [];
    for (const [chatId, file] of Array.from(state.chatFiles.entries())) {
      const records = Object.values(file.records);
      newlySealed.push(...records);
      if (records.length === 0) continue;
      const sealed = aggregateRecords(
        records,
        file.sealed ?? emptyChatAggregate(),
      );
      state.chatFiles.set(chatId, {
        ...file,
        records: {},
        sealed,
        sealedEntryIds: sortedUniqueIds([
          ...(file.sealedEntryIds ?? []),
          ...records.map((record) => record.entryId),
        ]),
      });
      state.touchedChats.add(chatId);
    }
    const unattachedRecords = Object.values(state.unattached.records);
    newlySealed.push(...unattachedRecords);
    const pipelineRecords = newlySealed.filter(
      (record) => record.pipeline !== undefined,
    );
    const initiallySealedRuns =
      pipelineRecords.length === 0
        ? state.unattached.sealedRuns
        : asRunRecord(
            buildPipelineRunViews(pipelineRecords, state.unattached.sealedRuns),
          );
    const sealedRunViews: PipelineRunCostView[] = [];
    for (const view of Object.values(initiallySealedRuns ?? {})) {
      const pipelineState = await this.host.readPipelineRun(
        state.location.scope,
        view.run.executionId,
      );
      const run = {
        ...view.run,
        ...(pipelineState?.status === undefined
          ? {}
          : { status: pipelineState.status }),
        ...(pipelineState?.pipelineName?.trim()
          ? { pipelineName: pipelineState.pipelineName.trim() }
          : {}),
      };
      sealedRunViews.push({
        ...view,
        run,
        ...(pipelineState?.nonAgentStepCount === undefined
          ? {}
          : { nonAgentStepCount: pipelineState.nonAgentStepCount }),
      });
    }
    const sealedRuns =
      sealedRunViews.length === 0
        ? initiallySealedRuns
        : asRunRecord(sealedRunViews);
    const runsChanged = !sameJson(
      state.unattached.sealedRuns ?? {},
      sealedRuns ?? {},
    );
    const sealedUnattached =
      unattachedRecords.length === 0
        ? state.unattached.sealedUnattached
        : aggregateRecords(
            // Pipeline work is folded into sealedRuns, never counted twice
            // in the entry's unattached-helper aggregate.
            unattachedRecords.filter((record) => record.pipeline === undefined),
            state.unattached.sealedUnattached ?? emptyChatAggregate(),
          );
    if (
      unattachedRecords.length > 0 ||
      pipelineRecords.length > 0 ||
      runsChanged
    ) {
      state.unattached = {
        ...state.unattached,
        records: {},
        sealedEntryIds: sortedUniqueIds([
          ...(state.unattached.sealedEntryIds ?? []),
          ...unattachedRecords.map((record) => record.entryId),
        ]),
        ...(sealedUnattached === undefined ? {} : { sealedUnattached }),
        ...(sealedRuns === undefined ? {} : { sealedRuns }),
        ...sealedRunActivityField(
          state.unattached.sealedRunsLastActivityAt,
          pipelineRecords,
        ),
      };
      state.unattachedTouched = true;
    }
  }

  private async sealDayInScope(
    location: CostScopeLocation,
    day: string,
  ): Promise<void> {
    await this.host.withRetainedLock(
      location.scope,
      async (): Promise<void> => {
        await this.withWriterLock(async (): Promise<void> => {
          const loaded = await this.loadScopeState(location);
          const state = loaded.state;
          let changed = false;
          const newlySealed: CostTurnRecord[] = [];
          // A turn still running keeps its record. Its completion updates the
          // same id in this day's file, and a later pass seals it.
          const sealsNow = (record: CostTurnRecord): boolean =>
            record.day === day && record.status !== 'running';
          for (const [chatId, file] of Array.from(state.chatFiles.entries())) {
            const toSeal = Object.values(file.records).filter(sealsNow);
            if (toSeal.length === 0) continue;
            const keep = Object.fromEntries(
              Object.entries(file.records).filter(
                ([, record]) => !sealsNow(record),
              ),
            );
            const sealed = aggregateRecords(
              toSeal,
              file.sealed ?? emptyChatAggregate(),
            );
            state.chatFiles.set(chatId, {
              ...file,
              records: keep,
              sealed,
              sealedEntryIds: sortedUniqueIds([
                ...(file.sealedEntryIds ?? []),
                ...toSeal.map((record) => record.entryId),
              ]),
            });
            state.touchedChats.add(chatId);
            newlySealed.push(...toSeal);
            changed = true;
          }
          const unattachedToSeal = Object.values(
            state.unattached.records,
          ).filter(sealsNow);
          if (unattachedToSeal.length > 0) {
            const keep = Object.fromEntries(
              Object.entries(state.unattached.records).filter(
                ([, record]) => !sealsNow(record),
              ),
            );
            const sealedUnattached = aggregateRecords(
              unattachedToSeal.filter(
                (record) => record.pipeline === undefined,
              ),
              state.unattached.sealedUnattached ?? emptyChatAggregate(),
            );
            state.unattached = {
              ...state.unattached,
              records: keep,
              sealedUnattached,
              sealedEntryIds: sortedUniqueIds([
                ...(state.unattached.sealedEntryIds ?? []),
                ...unattachedToSeal.map((record) => record.entryId),
              ]),
            };
            state.unattachedTouched = true;
            newlySealed.push(...unattachedToSeal);
            changed = true;
          }
          const pipelineRecords = newlySealed.filter(
            (record) => record.pipeline !== undefined,
          );
          if (pipelineRecords.length > 0) {
            state.unattached = {
              ...state.unattached,
              sealedRuns: asRunRecord(
                buildPipelineRunViews(
                  pipelineRecords,
                  state.unattached.sealedRuns,
                ),
              ),
              ...sealedRunActivityField(
                state.unattached.sealedRunsLastActivityAt,
                pipelineRecords,
              ),
            };
            state.unattachedTouched = true;
            changed = true;
          }
          if (!changed && state.summary === null) return;
          const latest = latestActivity(
            Array.from(state.chatFiles.values()),
            state.unattached,
          );
          const summary = await this.rebuildSummary(state, {
            updatedAt: latest,
            ...(state.summary?.coverageStart === undefined
              ? {}
              : { coverageStart: state.summary.coverageStart }),
            retentionDays: state.summary?.retentionDays,
          });
          if (
            !changed &&
            state.summary !== null &&
            sameJson(state.summary, summary)
          )
            return;
          await this.persistFilesOnly(state);
          if (state.summary === null || !sameJson(state.summary, summary)) {
            state.summary = summary;
            await writeSummaryFile(location.directory, summary);
            emitUpdate(location.scope, summary.revision);
          }
        });
      },
    );
  }

  private async persistFilesOnly(state: ScopeState): Promise<void> {
    for (const chatId of Array.from(state.touchedChats)) {
      const file = state.chatFiles.get(chatId);
      if (file !== undefined)
        await writeChatFile(state.location.directory, file);
    }
    if (state.unattachedTouched)
      await writeUnattachedFile(state.location.directory, state.unattached);
  }

  private async scopesMentionedInDay(
    filePath: string,
    fileSize: number,
    day: string,
  ): Promise<CostScopeLocation[]> {
    const found = new Map<string, CostScopeLocation>();
    const references = new Map<string, CostScopeRef>();
    await this.readAuditLines(
      {
        filename: `${day}.jsonl`,
        filePath,
        size: fileSize,
        mtimeMs: 0,
        cursor: undefined,
        startOffset: 0,
        reset: true,
      },
      0,
      (line): void => {
        const entry = parseAuditLine(line);
        if (entry === null || classifyAuditEntry(entry) === null) return;
        const scope = scopeFromAudit(entry);
        if (scope !== null) references.set(costScopeKey(scope), scope);
      },
    );
    for (const [key, scope] of Array.from(references.entries())) {
      const live = await this.host.resolveScope(scope);
      if (live !== null) found.set(key, live);
    }
    const retainedScopes = await this.host.listRetainedScopes();
    for (const [, scope] of Array.from(references.entries())) {
      if (scope.kind !== 'entry') continue;
      const retained = retainedScopes.find(
        (location) =>
          location.scope.kind === 'retained' &&
          location.scope.projectId === scope.projectId &&
          location.scope.containerId === scope.worktreeId,
      );
      if (retained !== undefined)
        found.set(costScopeKey(retained.scope), retained);
    }
    return Array.from(found.values());
  }

  private scheduleInitialRetainedFill(coverageStart: string): void {
    if (this.retainedFillTimer !== null || this.retainedFillRunning) return;
    this.retainedFillFailed = false;
    let complete: () => void = (): void => undefined;
    const task = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.retainedFillTask = task;
    this.retainedFillTimer = setTimeout((): void => {
      this.retainedFillTimer = null;
      this.retainedFillRunning = true;
      void this.fillInitialRetainedScopes(coverageStart)
        .catch(() => {
          // Leave the checkpoint incomplete; a later full pass retries.
          this.retainedFillFailed = true;
        })
        .finally((): void => {
          this.retainedFillRunning = false;
          complete();
          if (this.retainedFillTask === task) this.retainedFillTask = null;
        });
    }, 0);
    this.retainedFillTimer.unref?.();
  }

  private async fillInitialRetainedScopes(
    coverageStart: string,
  ): Promise<void> {
    const retained = await this.host.listRetainedScopes();
    if (retained.length === 0) {
      await this.markRetainedFillComplete();
      return;
    }
    const byEntry = new Map<string, CostScopeLocation>();
    for (const location of retained) {
      if (location.scope.kind !== 'retained') continue;
      const entryScope: CostScopeRef = {
        kind: 'entry',
        projectId: location.scope.projectId,
        worktreeId: location.scope.containerId,
      };
      byEntry.set(costScopeKey(entryScope), location);
    }
    const filenames = await this.auditFilenames();
    const buckets = new Map<
      string,
      { location: CostScopeLocation; records: CostTurnRecord[] }
    >();
    for (const filename of filenames) {
      const filePath = path.join(this.host.auditDirectory(), filename);
      let fileStats;
      try {
        fileStats = await stat(filePath);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      const billingEvidence = new BillingEvidencePass();
      await this.readAuditLines(
        {
          filename,
          filePath,
          size: fileStats.size,
          mtimeMs: fileStats.mtimeMs,
          ...(typeof fileStats.ino === 'number' ? { ino: fileStats.ino } : {}),
          cursor: undefined,
          startOffset: 0,
          reset: true,
        },
        0,
        async (line): Promise<void> => {
          const entry = parseAuditLine(line);
          if (entry === null) return;
          const repairedEntry = billingEvidence.apply(entry);
          const record = classifyAuditEntry(repairedEntry);
          if (record === null) return;
          const entryScope = scopeFromAudit(entry);
          if (entryScope === null) return;
          const retainedLocation = byEntry.get(costScopeKey(entryScope));
          if (
            retainedLocation === undefined ||
            dateIsBefore(record.startedAt, retainedLocation.createdAt)
          )
            return;
          const live = await this.host.resolveScope(entryScope);
          if (live !== null) return;
          const key = costScopeKey(retainedLocation.scope);
          const bucket = buckets.get(key) ?? {
            location: retainedLocation,
            records: [],
          };
          bucket.records.push(record);
          buckets.set(key, bucket);
        },
      );
    }
    for (const { location, records } of Array.from(buckets.values())) {
      await this.host.withRetainedLock(
        location.scope,
        async (): Promise<void> => {
          await this.withWriterLock(async (): Promise<void> => {
            const currentLocation = await this.host.resolveScope(
              location.scope,
            );
            if (
              currentLocation === null ||
              currentLocation.incarnation !== location.incarnation ||
              currentLocation.directory !== location.directory
            ) {
              return;
            }
            const loaded = await this.loadScopeState(currentLocation);
            const state = loaded.state;
            if (state.summary?.sealedAt !== undefined) return;
            for (const record of records) this.upsertRecord(state, record);
            await this.sealAllState(state);
            await this.persistFilesOnly(state);
            const entryCoverage =
              state.summary?.coverageStart ??
              (dateIsBefore(currentLocation.createdAt, coverageStart)
                ? coverageStart
                : undefined);
            const summary = await this.rebuildSummary(state, {
              updatedAt: latestActivity(
                Array.from(state.chatFiles.values()),
                state.unattached,
              ),
              ...(entryCoverage === undefined
                ? {}
                : { coverageStart: entryCoverage }),
              retentionDays:
                state.summary?.retentionDays ??
                clampRetentionDays(
                  await Promise.resolve(this.host.retentionDays()),
                ),
              sealedAt: this.now().toISOString(),
              forceRevision: true,
            });
            state.summary = summary;
            await writeSummaryFile(currentLocation.directory, summary);
            this.sealedScopes.add(costScopeKey(currentLocation.scope));
            emitUpdate(currentLocation.scope, summary.revision);
          });
        },
      );
    }
    await this.markRetainedFillComplete();
  }

  private async markRetainedFillComplete(): Promise<void> {
    await this.withWriterLock(async (): Promise<void> => {
      const checkpoint = await this.readCheckpoint();
      if (checkpoint === null || checkpoint.retainedFillComplete === true)
        return;
      await writeCheckpointFile(this.host.checkpointPath(), {
        ...checkpoint,
        retainedFillComplete: true,
      });
    });
  }

  private async auditFilenames(): Promise<string[]> {
    try {
      return (await readdir(this.host.auditDirectory()))
        .filter((filename) => parseDayFilename(filename) !== null)
        .sort();
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private async loadOrCreateCheckpoint(): Promise<CostIndexCheckpoint> {
    const read = await readCheckpointFile(this.host.checkpointPath());
    const loaded = read.value;
    if (loaded !== null && loaded.generation === CURRENT_GENERATION)
      return loaded;
    if (loaded !== null) {
      return {
        ...loaded,
        generation: CURRENT_GENERATION,
        audit: {},
      };
    }
    // A later release wrote this one. Its cursors mean nothing here, so every
    // remaining day file is read again, but the history it built is kept.
    const preserved = read.newer?.preserved;
    return {
      version: 1,
      generation: CURRENT_GENERATION,
      firstBuild: preserved?.firstBuild ?? (await this.newFirstBuild()),
      ...(preserved?.retainedFillComplete === undefined
        ? {}
        : { retainedFillComplete: preserved.retainedFillComplete }),
      audit: {},
    };
  }

  private async newFirstBuild(): Promise<CostIndexCheckpoint['firstBuild']> {
    const filenames = await this.auditFilenames();
    const now = this.now();
    return {
      at: now.toISOString(),
      coverageStart:
        filenames[0]?.slice(0, 10) ?? now.toISOString().slice(0, 10),
    };
  }

  private async readCheckpoint(): Promise<CostIndexCheckpoint | null> {
    const read = await readCheckpointFile(this.host.checkpointPath());
    return read.value;
  }

  private async readSummaryForLocation(
    location: CostScopeLocation,
  ): Promise<CostSummaryFile | null> {
    const read = await readSummaryFile(location.directory);
    const summary = read.value;
    if (read.corrupt) this.replayForCorrupt(location.scope);
    else if (summary === null) this.replayForMissing(location.scope);
    if (
      summary !== null &&
      (summary.incarnation !== location.incarnation ||
        summary.projectId !== location.scope.projectId ||
        summary.scopeId !== scopeId(location.scope))
    ) {
      let discarded = false;
      await this.withWriterLock(async (): Promise<void> => {
        const currentLocation = await this.host.resolveScope(location.scope);
        if (
          currentLocation === null ||
          currentLocation.incarnation !== location.incarnation ||
          currentLocation.directory !== location.directory
        )
          return;
        const latest = await readSummaryFile(location.directory);
        if (
          latest.value !== null &&
          (latest.value.incarnation !== currentLocation.incarnation ||
            latest.value.projectId !== currentLocation.scope.projectId ||
            latest.value.scopeId !== scopeId(currentLocation.scope))
        ) {
          await rm(location.directory, { recursive: true, force: true });
          discarded = true;
        }
      });
      if (discarded) this.replayForCorrupt(location.scope);
      return null;
    }
    return summary;
  }

  /** Files consumed before a lost write are rebuilt once from the audit. */
  private replayForMissing(scope: CostScopeRef): void {
    if (this.fullScanCompleted) return;
    this.scopesAwaitingFullScan.set(costScopeKey(scope), scope);
    if (scope.kind !== 'retained') this.scheduleReplay();
  }

  /**
   * A retained scope is sealed: a replay never writes it, so its unreadable
   * file is kept aside (once) and read as missing without any audit work.
   */
  private replayForCorrupt(scope: CostScopeRef): void {
    if (scope.kind !== 'retained') this.scheduleReplay();
  }

  /** Returns the scopes whose views should reload now that the scan is done. */
  private completeFullScan(): CostScopeRef[] {
    this.fullScanCompleted = true;
    const scopes = Array.from(this.scopesAwaitingFullScan.values());
    this.scopesAwaitingFullScan.clear();
    return scopes;
  }

  /** An empty scope is building only until a full scan finds nothing for it. */
  private async missingSummaryState(): Promise<{
    readonly building: boolean;
    readonly updatedAt: string | null;
  }> {
    if (!this.fullScanCompleted) return { building: true, updatedAt: null };
    const checkpoint = await this.readCheckpoint();
    return {
      building: false,
      updatedAt: checkpoint?.lastRefresh?.completedAt ?? null,
    };
  }

  /**
   * A summary on disk with no activity. It is written only after the entry's
   * audit was read and nothing was found, so the entry is known to be empty
   * in every app session, not only the one whose scan set the flag above.
   */
  private async emptySummaryState(): Promise<{
    readonly building: boolean;
    readonly updatedAt: string | null;
  }> {
    const checkpoint = await this.readCheckpoint();
    return {
      building: false,
      updatedAt: checkpoint?.lastRefresh?.completedAt ?? null,
    };
  }

  /** A public read never scans the audit; it queues one asynchronous repair. */
  private scheduleReplay(): void {
    this.replayRequested = true;
    this.replayVersion += 1;
    if (this.replayTimer !== null) return;
    let complete: () => void = (): void => undefined;
    const task = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.replayTask = task;
    this.replayTimer = setTimeout((): void => {
      this.replayTimer = null;
      void this.refreshInternal('idle')
        .catch(() => {
          // Keep replayRequested set so the next read/open/idle pass retries.
        })
        .finally((): void => {
          complete();
          if (this.replayTask === task) this.replayTask = null;
        });
    }, 0);
    this.replayTimer.unref?.();
  }

  private async yieldToMain(): Promise<void> {
    if (this.host.yield !== undefined) {
      await this.host.yield();
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /** All per-entry files, summaries, checkpoints and compactions have one writer. */
  private async withWriterLock<Value>(
    action: () => Promise<Value>,
  ): Promise<Value> {
    const previous = this.writerTail;
    let release = (): void => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.writerTail = previous.then(
      () => barrier,
      () => barrier,
    );
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  private now(): Date {
    const date = this.host.now?.() ?? new Date();
    return new Date(date.getTime());
  }
}

/** The same summary as a live, writable one: aggregates and tombstones stay. */
function reopenedSummary(summary: CostSummaryFile): CostSummaryFile {
  return {
    version: summary.version,
    projectId: summary.projectId,
    scopeId: summary.scopeId,
    incarnation: summary.incarnation,
    updatedAt: summary.updatedAt,
    ...(summary.coverageStart === undefined
      ? {}
      : { coverageStart: summary.coverageStart }),
    retentionDays: summary.retentionDays,
    revision: summary.revision + 1,
    totals: summary.totals,
    chats: summary.chats,
    pipelineRuns: summary.pipelineRuns,
    ...(summary.unattached === undefined
      ? {}
      : { unattached: summary.unattached }),
    hasCodexEstimate: summary.hasCodexEstimate,
  };
}

function scopeFromAudit(entry: AgentAuditEntry): CostScopeRef | null {
  if (entry.projectId === undefined || entry.worktreeId === undefined)
    return null;
  return {
    kind: 'entry',
    projectId: entry.projectId,
    worktreeId: entry.worktreeId,
  };
}

function parseAuditLine(line: string): AgentAuditEntry | null {
  try {
    const value: unknown = JSON.parse(line);
    return normalizeAuditEntry(value);
  } catch {
    return null;
  }
}

function asRunRecord(
  views: readonly PipelineRunCostView[],
): Readonly<Record<string, PipelineRunCostView>> {
  return Object.fromEntries(views.map((view) => [view.run.executionId, view]));
}

function sortedUniqueIds(ids: readonly string[]): readonly string[] {
  return Array.from(new Set(ids)).sort((left, right) =>
    left.localeCompare(right),
  );
}

function choosePendingTrigger(
  current: { trigger: CostInternalTrigger; scope?: CostScopeRef } | null,
  next: { trigger: CostInternalTrigger; scope?: CostScopeRef },
): { trigger: CostInternalTrigger; scope?: CostScopeRef } {
  const priority: Record<CostInternalTrigger, number> = {
    startup: 0,
    idle: 1,
    open: 2,
    turn: 3,
    manual: 4,
    archive: 5,
  };
  if (current === null || priority[next.trigger] >= priority[current.trigger])
    return next;
  return current;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Cost index operation failed';
}

function emitUpdate(scope: CostScopeRef, revision: number): void {
  emitCostUpdated({ scopes: [scope], revision });
}

export function resetCostIndexStoreForTest(): void {
  // Test-only hook intentionally doesn't touch durable files.
}
