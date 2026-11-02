import { createHash } from 'node:crypto';
import {
  buildDelegationNoticeMessage,
  type DelegationNotice,
} from '@canopy/agent-actions';
import { BRAND } from '@canopy/brand/current';
import type {
  StoredDelegateOutput,
  StoredDelegation,
} from '@canopy/desktop-shared/node/delegation/broker';
import type { DelegationParentContext } from '@canopy/desktop-shared/node/delegation';
import { ChildMessageAdmissionRefusedError } from './child-messages';
import type { ManagedChildMessageInbox } from './child-messages';
import {
  DelegationNoticeBatcher,
  type BatchableNotice,
} from './notice-batcher';
import {
  noticeBatchId,
  noticeId,
  type DelegationNoticeAckStore,
  type OwedNotice,
  type PendingNoticeBatch,
} from './notice-acks';
import {
  deliverGeneratedWatcherMessageToChat,
  type GeneratedWatcherMessageDeliveryOutcome,
} from '../../services/watcher-chat-delivery';

const CHILD_PARENT_NOT_READY_MESSAGE =
  'The owning parent session is not ready.';
const CHILD_DELIVERY_FAILURE_MESSAGE =
  'The delegate completion notice could not be delivered.';
// App shutdown defers delivery to the next start rather than acknowledging.
const APP_SHUTDOWN = 'shutdown';
const SUPPRESSED_TEARDOWN_REASONS = new Set([
  'parent_cancelled',
  'ancestor_stopped',
  'shutdown',
  'policy_revoked',
]);

type NoticeMessage = NonNullable<PendingNoticeBatch['message']>;

interface NoticeEntry extends BatchableNotice {
  readonly parentKey: string;
  readonly record: StoredDelegation;
  readonly output: StoredDelegateOutput;
  readonly notice: DelegationNotice;
}

interface DeliveryBatch {
  readonly batchId: string;
  readonly parentKey: string;
  readonly noticeIds: readonly string[];
  readonly entries: readonly NoticeEntry[];
  readonly message: NoticeMessage;
}

interface BatchJob {
  readonly batch: DeliveryBatch;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  persisted: boolean;
  started: boolean;
  handingOff: boolean;
  cancelled: boolean;
  /** Hand-offs that threw; each retry needs its own broker operation ID. */
  attempt: number;
  /** Whether a thrown hand-off already retried without waiting for a trigger. */
  retriedAtOnce: boolean;
}

interface SettlementEvent {
  readonly parent: DelegationParentContext;
  readonly delegationId: string;
  readonly result: StoredDelegateOutput;
}

export interface DelegationNoticeDeliveryOptions {
  readonly store: DelegationNoticeAckStore;
  readonly records: () => Promise<readonly StoredDelegation[]>;
  readonly results: (
    record: StoredDelegation,
  ) => Promise<readonly StoredDelegateOutput[]>;
  readonly childMessages: Pick<ManagedChildMessageInbox, 'deliver'>;
  readonly onError: (error: unknown) => void;
}

export function delegationNoticeRootParentKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return `root:${projectId}/${worktreeId}/${chatId}`;
}

function childParentKey(delegationId: string): string {
  return `delegate:${delegationId}`;
}

function parentKeyForRecord(record: StoredDelegation): string {
  if (record.parentDelegationId)
    return childParentKey(record.parentDelegationId);
  return delegationNoticeRootParentKey(
    record.parent.projectId,
    record.parent.worktreeId,
    record.parent.chatId,
  );
}

function outputNotice(
  record: StoredDelegation,
  output: StoredDelegateOutput,
): NoticeEntry {
  const id = noticeId(
    record.state.delegationId,
    output.runGeneration,
    output.resultIndex,
  );
  const notice: DelegationNotice = {
    noticeId: id,
    delegationId: record.state.delegationId,
    ...(record.task.name !== undefined ? { name: record.task.name } : {}),
    description: record.task.description,
    runGeneration: output.runGeneration,
    resultIndex: output.resultIndex,
    status: output.status,
    ...(output.stopReason !== undefined
      ? { exitReason: output.stopReason }
      : {}),
    settledAt: output.settledAt,
    outputTruncated: output.outputTruncated,
    ...(output.error ? { errorCode: output.error.code } : {}),
  };
  return {
    noticeId: id,
    settledAt: output.settledAt,
    parentKey: parentKeyForRecord(record),
    record,
    output,
    notice,
  };
}

function snapshotMessage(message: {
  readonly text: string;
  readonly hiddenContextText: string;
  readonly watcherFired: { readonly kind: string };
}): NoticeMessage {
  return {
    text: message.text,
    hiddenContextText: message.hiddenContextText,
    watcherFired: { kind: message.watcherFired.kind },
  };
}

/**
 * The broker stores a host delivery as a control whose operationId must be a
 * UUID. Derived from the batch, so a retried batch keeps its ID and dedupes.
 */
export function noticeDeliveryOperationId(
  batchId: string,
  attempt = 0,
): string {
  const hex = createHash('sha256')
    .update(
      attempt === 0
        ? `delegation-notice:${batchId}`
        : `delegation-notice:${batchId}:${String(attempt)}`,
    )
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function isActive(status: string): boolean {
  return status === 'pending' || status === 'running';
}

function hasTransientParentNotReadyRefusal(error: {
  readonly code: string;
  readonly message: string;
}): boolean {
  return (
    error.code === 'parent_unavailable' &&
    error.message === CHILD_PARENT_NOT_READY_MESSAGE
  );
}

/**
 * Bridges immutable broker results to durable, idempotent parent notices.
 * Settlements only enqueue work; the per-parent sender owns the hand-off tail.
 */
export class DelegationNoticeDelivery {
  private readonly store: DelegationNoticeAckStore;
  private readonly recordsSource: () => Promise<readonly StoredDelegation[]>;
  private readonly resultsSource: (
    record: StoredDelegation,
  ) => Promise<readonly StoredDelegateOutput[]>;
  private readonly childMessages: Pick<ManagedChildMessageInbox, 'deliver'>;
  private readonly onError: (error: unknown) => void;
  private readonly catalog = new Map<string, StoredDelegation>();
  private readonly resultsByDelegation = new Map<
    string,
    readonly StoredDelegateOutput[]
  >();
  private readonly statusByDelegation = new Map<string, string>();
  private readonly settlementOverrides = new Map<
    string,
    { readonly runGeneration: number; readonly status: string }
  >();
  private readonly windowEntries = new Map<string, Map<string, NoticeEntry>>();
  private readonly queues = new Map<string, BatchJob[]>();
  private readonly activeJobs = new Map<string, BatchJob>();
  private readonly jobsByBatchId = new Map<string, BatchJob>();
  private readonly blockedParents = new Set<string>();
  /** Root keys that got a new notice while a hand-off was in flight. */
  private readonly retryTriggers = new Set<string>();
  /** Delegates fenced by Stop all: idle ones refuse notices until resumed. */
  private readonly stopFence = new Set<string>();
  /** Batches still in the store's memory whose journal write failed. */
  private readonly unjournaledBatchIds = new Set<string>();
  private readonly closingReasons = new Map<string, string>();
  private readonly bufferedSettlements: SettlementEvent[] = [];
  private readonly batcher: DelegationNoticeBatcher<NoticeEntry>;
  private settlementTail: Promise<void> = Promise.resolve();
  private startPromise: Promise<void> | undefined;
  private ready = false;
  private closed = false;

  constructor(options: DelegationNoticeDeliveryOptions) {
    this.store = options.store;
    this.recordsSource = options.records;
    this.resultsSource = options.results;
    this.childMessages = options.childMessages;
    this.onError = options.onError;
    this.batcher = new DelegationNoticeBatcher<NoticeEntry>({
      hasOtherActive: (key: string): boolean => this.hasOtherActive(key),
      fits: (entries: readonly NoticeEntry[]): boolean => this.fits(entries),
      flush: (key: string, entries: readonly NoticeEntry[]): void =>
        this.flushWindow(key, entries),
    });
  }

  /**
   * Loads the current metadata view, replays the immutable journal first, then
   * enqueues migration-owed and unacknowledged settled results.
   */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.initialize().catch((error: unknown) => {
      this.reportError(error);
      this.ready = true;
      this.drainBufferedSettlements();
    });
    return this.startPromise;
  }

  /**
   * Buffers a completion and returns after it is queued. Suppression is the
   * exception: its acknowledgement is flushed before the broker callback ends.
   */
  settled(
    parent: DelegationParentContext,
    delegationId: string,
    result: StoredDelegateOutput,
  ): Promise<void> {
    const event: SettlementEvent = { parent, delegationId, result };
    if (!this.ready) {
      this.bufferedSettlements.push(event);
      return Promise.resolve();
    }
    return this.enqueueSettlement(event);
  }

  /**
   * Replays only pending child-parent batches belonging to this root chat.
   * An active startup hand-off is shared rather than sent a second time.
   */
  async replayForChat(target: {
    readonly projectId: string;
    readonly worktreeId: string;
    readonly chatId: string;
  }): Promise<void> {
    await this.start();
    if (this.closed) return;
    const rootKey = delegationNoticeRootParentKey(
      target.projectId,
      target.worktreeId,
      target.chatId,
    );
    for (const key of Array.from(this.parentTreeKeys(rootKey)))
      this.closingReasons.delete(key);
    // Reattaching retries a root batch whose hand-off failed.
    if (this.blockedParents.delete(rootKey)) this.pumpParent(rootKey);
    const candidates = new Map<string, DeliveryBatch[]>();
    for (const pending of this.store.pending()) {
      if (
        pending.parentKey === rootKey ||
        !pending.parentKey.startsWith('delegate:')
      )
        continue;
      const entries = this.entriesForIds(pending.noticeIds);
      if (
        entries.length !== pending.noticeIds.length ||
        !entries.every(({ record }) => this.recordBelongsToChat(record, target))
      ) {
        continue;
      }
      const batch = this.batchFromPending(pending, entries);
      if (!batch) continue;
      const batches = candidates.get(batch.parentKey) ?? [];
      batches.push(batch);
      candidates.set(batch.parentKey, batches);
    }
    const jobs: Promise<void>[] = [];
    for (const [parentKey, batches] of Array.from(candidates.entries())) {
      this.blockedParents.add(parentKey);
      for (const batch of Array.from(batches).reverse()) {
        const pending = this.store
          .pending()
          .find(({ batchId }) => batchId === batch.batchId);
        jobs.push(
          this.enqueueBatch(batch, true, pending?.message === undefined, true),
        );
      }
      this.blockedParents.delete(parentKey);
      this.pumpParent(parentKey);
    }
    await Promise.all(jobs);

    // A startup replay can still own the same batch when this method is called
    // during root attachment. Join that in-flight attempt above, then make one
    // fresh pass for child batches that remain pending (typically because the
    // child parent was not attached yet when startup replay reached it).
    const retryJobs: Promise<void>[] = [];
    for (const pending of this.store.pending()) {
      if (
        pending.parentKey === rootKey ||
        !pending.parentKey.startsWith('delegate:')
      )
        continue;
      const entries = this.entriesForIds(pending.noticeIds);
      if (
        entries.length !== pending.noticeIds.length ||
        !entries.every(({ record }) => this.recordBelongsToChat(record, target))
      ) {
        continue;
      }
      const batch = this.batchFromPending(pending, entries);
      if (!batch) continue;
      this.blockedParents.add(batch.parentKey);
      retryJobs.push(
        this.enqueueBatch(batch, true, pending.message === undefined, true),
      );
      this.blockedParents.delete(batch.parentKey);
      this.pumpParent(batch.parentKey);
    }
    await Promise.all(retryJobs);
  }

  /**
   * Stops buffered and queued windows in a parent tree without waiting for an
   * active child inbox or root-dispatch hand-off. The owner stops the broker
   * tree next; close() drains those hand-offs after broker.close().
   */
  async closeParent(parentKey: string, reason = 'parent_gone'): Promise<void> {
    if (!this.closingReasons.has(parentKey))
      this.closingReasons.set(parentKey, reason);
    await this.start();
    const affectedKeys = this.parentTreeKeys(parentKey);
    for (const key of Array.from(affectedKeys)) {
      if (!this.closingReasons.has(key)) this.closingReasons.set(key, reason);
    }

    // On app shutdown, unacknowledged results and journaled batches stay as
    // they are, so the next start delivers them.
    const deferToRestart = reason === APP_SHUTDOWN;
    const deferred: NoticeEntry[] = [];
    const suppressed: NoticeEntry[] = [];
    const suppressedBatchIds = new Set<string>();
    const activeBatchIds = new Set<string>();
    for (const key of Array.from(affectedKeys)) {
      this.batcher.close(key);
      const window = this.windowEntries.get(key);
      if (window) {
        (deferToRestart ? deferred : suppressed).push(
          ...Array.from(window.values()),
        );
        this.windowEntries.delete(key);
      }

      const queue = this.queues.get(key);
      if (!queue) continue;
      const active = this.activeJobs.get(key);
      if (active?.handingOff) activeBatchIds.add(active.batch.batchId);
      const retained: BatchJob[] = [];
      for (const job of queue) {
        if (job === active && job.handingOff) {
          retained.push(job);
          continue;
        }
        job.cancelled = true;
        if (!deferToRestart) {
          suppressed.push(...job.batch.entries);
          suppressedBatchIds.add(job.batch.batchId);
        } else if (!job.persisted) {
          deferred.push(...job.batch.entries);
        }
        this.jobsByBatchId.delete(job.batch.batchId);
        job.resolve();
      }
      if (retained.length > 0) this.queues.set(key, retained);
      else this.queues.delete(key);
    }

    for (const pending of deferToRestart ? [] : this.store.pending()) {
      if (
        !affectedKeys.has(pending.parentKey) ||
        activeBatchIds.has(pending.batchId) ||
        suppressedBatchIds.has(pending.batchId)
      ) {
        continue;
      }
      const entries = this.entriesForIds(pending.noticeIds);
      if (entries.length !== pending.noticeIds.length) {
        this.reportError(
          new Error(
            `Delegation notice batch ${pending.batchId} is missing result metadata; leaving it pending.`,
          ),
        );
        continue;
      }
      suppressed.push(...entries);
      suppressedBatchIds.add(pending.batchId);
    }
    for (const batchId of Array.from(suppressedBatchIds))
      this.store.clearPending(batchId);
    await this.deferEntries(deferred);
    await this.suppressEntries(suppressed, reason);
  }

  /**
   * Fences every delegate of a chat before Stop all, so a stopped child's
   * notice never resumes an idle parent.
   */
  async fenceChat(target: {
    readonly projectId: string;
    readonly worktreeId: string;
    readonly chatId: string;
  }): Promise<void> {
    await this.start();
    await this.refreshCatalog(undefined, false);
    for (const record of Array.from(this.catalog.values()))
      if (this.recordBelongsToChat(record, target))
        this.stopFence.add(record.state.delegationId);
  }

  /**
   * Revocation suppresses notices buffered for the revoked tree, then lets
   * delegates started under new authority notify the same chat.
   */
  async revokeParent(parentKey: string, reason: string): Promise<void> {
    await this.closeParent(parentKey, reason);
    for (const key of Array.from(this.parentTreeKeys(parentKey)))
      this.closingReasons.delete(key);
  }

  /** Called by actor shutdown after the broker has stopped its trees. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.start();

    const keys = new Set<string>([
      ...Array.from(this.windowEntries.keys()),
      ...Array.from(this.queues.keys()),
      ...Array.from(this.activeJobs.keys()),
      ...this.store.pending().map(({ parentKey }) => parentKey),
    ]);
    for (const record of Array.from(this.catalog.values())) {
      keys.add(parentKeyForRecord(record));
      keys.add(
        delegationNoticeRootParentKey(
          record.parent.projectId,
          record.parent.worktreeId,
          record.parent.chatId,
        ),
      );
    }
    for (const key of Array.from(keys)) await this.closeParent(key, 'shutdown');
    this.batcher.dispose();

    await Promise.all(
      Array.from(this.activeJobs.values()).map(({ promise }) => promise),
    );
    await this.flushStore();
  }

  private async initialize(): Promise<void> {
    await this.refreshCatalog();

    const pending = this.store.pending();
    const pendingNoticeIds = new Set(
      pending.flatMap(({ noticeIds }) => noticeIds),
    );
    for (const batch of pending) {
      const entries = this.entriesForIds(batch.noticeIds);
      if (entries.length !== batch.noticeIds.length) {
        this.reportError(
          new Error(
            `Delegation notice batch ${batch.batchId} is missing result metadata; leaving it pending.`,
          ),
        );
        continue;
      }
      const teardownEntry = entries.find(({ output }) =>
        this.isTeardownReason(output.stopReason),
      );
      if (teardownEntry) {
        await this.suppressEntries(
          entries,
          teardownEntry.output.stopReason ?? 'shutdown',
          batch.batchId,
        );
        continue;
      }
      const replay = this.batchFromPending(batch, entries);
      if (!replay) continue;
      void this.enqueueBatch(replay, true, !batch.message, false);
    }

    const owed = this.store.owed();
    const owedIds = new Set(owed.map(({ noticeId: id }) => id));
    const startupNotices = new Map<string, NoticeEntry>();
    for (const owedNotice of owed) {
      if (pendingNoticeIds.has(owedNotice.noticeId)) continue;
      const entry = this.entryForOwed(owedNotice);
      if (!entry) {
        this.reportError(
          new Error(
            `Delegation notice ${owedNotice.noticeId} is missing result metadata; leaving it owed.`,
          ),
        );
        continue;
      }
      startupNotices.set(entry.noticeId, entry);
    }

    for (const [delegationId, results] of Array.from(
      this.resultsByDelegation.entries(),
    )) {
      const record = this.catalog.get(delegationId);
      if (!record) continue;
      const ack = this.store.ack(delegationId);
      for (const result of results) {
        const entry = outputNotice(record, result);
        if (pendingNoticeIds.has(entry.noticeId)) continue;
        if (owedIds.has(entry.noticeId)) {
          startupNotices.set(entry.noticeId, entry);
          continue;
        }
        if (ack && result.resultIndex <= ack.resultIndex) continue;
        startupNotices.set(entry.noticeId, entry);
      }
    }

    const orderedStartupNotices = Array.from(startupNotices.values()).sort(
      (left, right) =>
        left.output.settledAt - right.output.settledAt ||
        left.output.resultIndex - right.output.resultIndex,
    );
    let suppressedAtStartup = false;
    for (const entry of orderedStartupNotices) {
      const reason = entry.output.stopReason;
      if (this.isTeardownReason(reason)) {
        this.store.acknowledge(
          entry.notice.delegationId,
          entry.notice.resultIndex,
          reason,
        );
        this.store.settleOwed(entry.noticeId);
        suppressedAtStartup = true;
      } else {
        this.addToWindow(entry);
      }
    }
    if (suppressedAtStartup) await this.flushStore();

    this.ready = true;
    this.drainBufferedSettlements();
  }

  private drainBufferedSettlements(): void {
    const buffered = this.bufferedSettlements.splice(0);
    for (const event of buffered) {
      void this.enqueueSettlement(event).catch((error: unknown) =>
        this.reportError(error),
      );
    }
  }

  private enqueueSettlement(event: SettlementEvent): Promise<void> {
    const next = this.settlementTail
      .catch(() => undefined)
      .then(() => this.processSettlement(event));
    this.settlementTail = next.catch((error: unknown) => {
      this.reportError(error);
    });
    return next;
  }

  private processSettlement(event: SettlementEvent): Promise<void> {
    this.statusByDelegation.set(event.delegationId, event.result.status);
    this.settlementOverrides.set(event.delegationId, {
      runGeneration: event.result.runGeneration,
      status: event.result.status,
    });
    const record = this.catalog.get(event.delegationId);
    if (record) {
      this.resultsByDelegation.set(event.delegationId, [
        ...(this.resultsByDelegation.get(event.delegationId) ?? []).filter(
          ({ resultIndex, runGeneration }) =>
            resultIndex !== event.result.resultIndex ||
            runGeneration !== event.result.runGeneration,
        ),
        event.result,
      ]);
    }
    return this.handleSettlement(event);
  }

  private async handleSettlement(event: SettlementEvent): Promise<void> {
    // A delegate parent whose run just ended can take a hand-off it refused
    // while running, even when no other child notice follows.
    const ownParentKey = childParentKey(event.delegationId);
    if (!this.closed && this.blockedParents.delete(ownParentKey)) {
      if (this.activeJobs.has(ownParentKey))
        this.retryTriggers.add(ownParentKey);
      this.pumpParent(ownParentKey);
    }
    const record = await this.refreshCatalog(event.delegationId, false);
    if (!record) {
      this.reportError(
        new Error(
          `Delegation ${event.delegationId} is missing record metadata; its notice remains unacknowledged.`,
        ),
      );
      return;
    }

    // The result callback is the authoritative live result. Cache it only after
    // refreshing the catalog so a delegate first seen after actor startup is
    // reconstructible during this process's retry/attach replay.
    const cachedResults =
      this.resultsByDelegation.get(event.delegationId) ?? [];
    this.resultsByDelegation.set(event.delegationId, [
      ...cachedResults.filter(
        ({ resultIndex, runGeneration }) =>
          resultIndex !== event.result.resultIndex ||
          runGeneration !== event.result.runGeneration,
      ),
      event.result,
    ]);
    if (record.state.runGeneration === event.result.runGeneration) {
      this.statusByDelegation.set(event.delegationId, event.result.status);
    }

    const entry = outputNotice(record, event.result);
    const teardownReason = event.result.stopReason;
    if (teardownReason && SUPPRESSED_TEARDOWN_REASONS.has(teardownReason)) {
      await this.suppressEntries([entry], teardownReason);
      return;
    }

    if (this.closed) {
      await this.deferEntries([entry]);
      return;
    }

    const closingReason = this.closingReasonForEntry(entry);
    if (closingReason) {
      if (closingReason === APP_SHUTDOWN) await this.deferEntries([entry]);
      else await this.suppressEntries([entry], closingReason);
      return;
    }

    const ack = this.store.ack(event.delegationId);
    if (
      ack &&
      event.result.resultIndex <= ack.resultIndex &&
      !this.store.owed().some(({ noticeId: id }) => id === entry.noticeId)
    ) {
      return;
    }
    if (
      this.store
        .pending()
        .some(({ noticeIds }) => noticeIds.includes(entry.noticeId)) ||
      this.hasBufferedOrQueued(entry.noticeId)
    ) {
      return;
    }

    this.addToWindow(entry);
  }

  private async refreshCatalog(
    requestedDelegationId?: string,
    includeResults = true,
  ): Promise<StoredDelegation | undefined> {
    try {
      const records = await this.recordsSource();
      await Promise.all(
        records.map(async (record) => {
          const delegationId = record.state.delegationId;
          this.catalog.set(delegationId, record);
          let results = this.resultsByDelegation.get(delegationId) ?? [];
          if (includeResults) {
            try {
              results = await this.resultsSource(record);
              this.resultsByDelegation.set(delegationId, results);
            } catch (error) {
              this.reportError(error);
            }
          }
          const override = this.settlementOverrides.get(delegationId);
          if (override?.runGeneration === record.state.runGeneration) {
            this.statusByDelegation.set(delegationId, override.status);
            return;
          }
          if (override) this.settlementOverrides.delete(delegationId);
          this.statusByDelegation.set(delegationId, record.state.status);
          const latest = results[results.length - 1];
          if (
            includeResults &&
            latest &&
            latest.runGeneration === record.state.runGeneration &&
            record.state.status === 'running'
          ) {
            this.statusByDelegation.set(delegationId, latest.status);
          }
        }),
      );
      return requestedDelegationId
        ? this.catalog.get(requestedDelegationId)
        : undefined;
    } catch (error) {
      this.reportError(error);
      return requestedDelegationId
        ? this.catalog.get(requestedDelegationId)
        : undefined;
    }
  }

  private addToWindow(entry: NoticeEntry): void {
    const closingReason = this.closed
      ? 'shutdown'
      : this.closingReasonForEntry(entry);
    if (closingReason) {
      void (closingReason === APP_SHUTDOWN
        ? this.deferEntries([entry])
        : this.suppressEntries([entry], closingReason));
      return;
    }
    let window = this.windowEntries.get(entry.parentKey);
    if (!window) {
      window = new Map<string, NoticeEntry>();
      this.windowEntries.set(entry.parentKey, window);
    }
    if (window.has(entry.noticeId)) return;
    window.set(entry.noticeId, entry);
    this.batcher.add(entry.parentKey, entry);
  }

  private flushWindow(
    parentKey: string,
    entries: readonly NoticeEntry[],
  ): void {
    const window = this.windowEntries.get(parentKey);
    for (const entry of entries) window?.delete(entry.noticeId);
    if (window?.size === 0) this.windowEntries.delete(parentKey);

    const message = this.buildMessage(entries);
    if (!message) return;
    const noticeIds = entries.map(({ noticeId: id }) => id);
    const batch: DeliveryBatch = {
      batchId: noticeBatchId(noticeIds),
      parentKey,
      noticeIds,
      entries: [...entries],
      message,
    };
    void this.enqueueBatch(batch, false, false);
  }

  private buildMessage(
    entries: readonly NoticeEntry[],
    reportFailure = true,
  ): NoticeMessage | undefined {
    if (entries.length === 0) return undefined;
    const noticeIds = new Set(entries.map(({ notice }) => notice.delegationId));
    const parentKey = entries[0]?.parentKey;
    if (!parentKey) return undefined;
    const stillRunning = Array.from(this.catalog.values())
      .filter(
        (record) =>
          parentKeyForRecord(record) === parentKey &&
          !noticeIds.has(record.state.delegationId) &&
          isActive(
            this.statusByDelegation.get(record.state.delegationId) ??
              record.state.status,
          ),
      )
      .map((record) => ({
        delegationId: record.state.delegationId,
        name: record.task.name?.trim() || record.task.description,
      }));
    const built = buildDelegationNoticeMessage({
      brand: {
        displayName: BRAND.displayName,
        toolNamespace: BRAND.tools.namespace,
      },
      notices: entries.map(({ notice }) => notice),
      stillRunning,
    });
    if (!built.ok) {
      if (reportFailure) {
        this.reportError(
          new Error(
            `Unable to build a delegation notice message: ${built.reason}.`,
          ),
        );
      }
      return undefined;
    }
    return snapshotMessage(built);
  }

  private fits(entries: readonly NoticeEntry[]): boolean {
    return this.buildMessage(entries, false) !== undefined;
  }

  private hasOtherActive(parentKey: string): boolean {
    return Array.from(this.catalog.values()).some(
      (record) =>
        parentKeyForRecord(record) === parentKey &&
        isActive(
          this.statusByDelegation.get(record.state.delegationId) ??
            record.state.status,
        ),
    );
  }

  private batchFromPending(
    pending: PendingNoticeBatch,
    entries: readonly NoticeEntry[],
  ): DeliveryBatch | undefined {
    if (entries.length !== pending.noticeIds.length) return undefined;
    if (entries.some(({ parentKey }) => parentKey !== pending.parentKey)) {
      this.reportError(
        new Error(
          `Delegation notice batch ${pending.batchId} has inconsistent parent metadata; leaving it pending.`,
        ),
      );
      return undefined;
    }
    const message = pending.message ?? this.buildMessage(entries);
    if (!message) {
      this.reportError(
        new Error(
          `Delegation notice batch ${pending.batchId} cannot be rebuilt; leaving it pending.`,
        ),
      );
      return undefined;
    }
    return {
      batchId: pending.batchId,
      parentKey: pending.parentKey,
      noticeIds: [...pending.noticeIds],
      entries: [...entries],
      message: snapshotMessage(message),
    };
  }

  private entriesForIds(noticeIds: readonly string[]): NoticeEntry[] {
    const entries: NoticeEntry[] = [];
    for (const id of noticeIds) {
      let found: NoticeEntry | undefined;
      for (const [delegationId, results] of Array.from(
        this.resultsByDelegation.entries(),
      )) {
        const record = this.catalog.get(delegationId);
        if (!record) continue;
        found = results
          .map((result) => outputNotice(record, result))
          .find((entry) => entry.noticeId === id);
        if (found) break;
      }
      if (!found) return [];
      entries.push(found);
    }
    return entries;
  }

  private entryForOwed(owed: OwedNotice): NoticeEntry | undefined {
    const record = this.catalog.get(owed.delegationId);
    const result = this.resultsByDelegation
      .get(owed.delegationId)
      ?.find(
        (candidate) =>
          candidate.runGeneration === owed.runGeneration &&
          candidate.resultIndex === owed.resultIndex,
      );
    if (!record || !result) return undefined;
    const entry = outputNotice(record, result);
    return entry.noticeId === owed.noticeId ? entry : undefined;
  }

  private hasBufferedOrQueued(noticeIdValue: string): boolean {
    for (const window of Array.from(this.windowEntries.values())) {
      if (window.has(noticeIdValue)) return true;
    }
    for (const job of Array.from(this.jobsByBatchId.values())) {
      if (job.batch.noticeIds.includes(noticeIdValue)) return true;
    }
    return false;
  }

  private enqueueBatch(
    batch: DeliveryBatch,
    persisted: boolean,
    upgradeLegacyJournal: boolean,
    atFront = persisted,
  ): Promise<void> {
    const current = this.jobsByBatchId.get(batch.batchId);
    if (current) return current.promise;

    let resolve = (): void => undefined;
    const promise = new Promise<void>((complete) => {
      resolve = complete;
    });
    const job: BatchJob = {
      batch,
      promise,
      resolve,
      persisted:
        persisted &&
        !upgradeLegacyJournal &&
        !this.unjournaledBatchIds.has(batch.batchId),
      started: false,
      handingOff: false,
      cancelled: false,
      attempt: 0,
      retriedAtOnce: false,
    };
    this.jobsByBatchId.set(batch.batchId, job);
    const queue = this.queues.get(batch.parentKey) ?? [];
    if (atFront) queue.unshift(job);
    else queue.push(job);
    this.queues.set(batch.parentKey, queue);
    // A new notice retries the parent's failed batch first; replayForChat
    // retries it too.
    this.blockedParents.delete(batch.parentKey);
    if (this.activeJobs.has(batch.parentKey))
      this.retryTriggers.add(batch.parentKey);
    this.pumpParent(batch.parentKey);
    return promise;
  }

  private pumpParent(parentKey: string): void {
    if (
      this.closed ||
      this.activeJobs.has(parentKey) ||
      this.blockedParents.has(parentKey) ||
      this.closingReasons.has(parentKey)
    ) {
      return;
    }
    const queue = this.queues.get(parentKey);
    const job = queue?.[0];
    if (!job) return;
    job.started = true;
    this.activeJobs.set(parentKey, job);
    void this.runJob(job).then(
      (retry) => this.finishJob(job, retry),
      () => this.finishJob(job, false),
    );
  }

  /** Resolves true when a failed hand-off stays queued for a retry. */
  private async runJob(job: BatchJob): Promise<boolean> {
    const { batch } = job;
    if (job.cancelled) return false;
    const reasonBeforeJournal = this.closed
      ? APP_SHUTDOWN
      : this.closingReasonForBatch(batch);
    if (reasonBeforeJournal) {
      await this.suppressBatch(batch, reasonBeforeJournal);
      return false;
    }
    try {
      if (!job.persisted) {
        await this.store.recordPending({
          batchId: batch.batchId,
          parentKey: batch.parentKey,
          noticeIds: batch.noticeIds,
          message: snapshotMessage(batch.message),
        });
        job.persisted = true;
        this.unjournaledBatchIds.delete(batch.batchId);
      }
    } catch (error) {
      // The store keeps the batch in memory; replay must journal it again.
      this.unjournaledBatchIds.add(batch.batchId);
      this.reportError(error);
      this.blockedParents.add(batch.parentKey);
      return true;
    }

    const closingReason = this.closed
      ? APP_SHUTDOWN
      : this.closingReasonForBatch(batch);
    if (job.cancelled || closingReason) {
      await this.suppressBatch(batch, closingReason ?? 'parent_gone');
      return false;
    }

    job.handingOff = true;
    try {
      const outcome = await this.deliverBatch(batch, job.attempt);
      const reasonAfterHandoff = this.closed
        ? APP_SHUTDOWN
        : this.closingReasonForBatch(batch);
      if (outcome === 'transient') {
        if (reasonAfterHandoff) {
          await this.suppressBatch(batch, reasonAfterHandoff);
          return false;
        }
        this.blockedParents.add(batch.parentKey);
        return true;
      }
      await this.acknowledgeBatch(batch, outcome.suppressedReason);
      return false;
    } catch (error) {
      const reasonAfterHandoff = this.closed
        ? APP_SHUTDOWN
        : this.closingReasonForBatch(batch);
      if (reasonAfterHandoff) {
        await this.suppressBatch(batch, reasonAfterHandoff);
        return false;
      }
      if (error instanceof ChildMessageAdmissionRefusedError) {
        await this.suppressBatch(batch, 'parent_stopped');
        return false;
      }
      this.reportError(error);
      this.blockedParents.add(batch.parentKey);
      // The broker may have recorded a delegate hand-off's control as failed,
      // and it replays that failure for the same ID, so retry under a new one.
      if (batch.parentKey.startsWith('delegate:')) {
        job.attempt += 1;
        if (!job.retriedAtOnce) {
          job.retriedAtOnce = true;
          this.retryTriggers.add(batch.parentKey);
        }
      }
      return true;
    }
  }

  private async deliverBatch(
    batch: DeliveryBatch,
    attempt: number,
  ): Promise<
    | { readonly suppressedReason?: undefined }
    | { readonly suppressedReason: string }
    | 'transient'
  > {
    if (batch.parentKey.startsWith('root:')) {
      const [projectId, worktreeId, chatId] = batch.parentKey
        .slice('root:'.length)
        .split('/');
      if (!projectId || !worktreeId || !chatId) {
        return { suppressedReason: 'parent_gone' };
      }
      const outcome: GeneratedWatcherMessageDeliveryOutcome =
        await deliverGeneratedWatcherMessageToChat({
          projectId,
          worktreeId,
          chatId,
          userMessageId: batch.batchId,
          text: batch.message.text,
          hiddenContextText: batch.message.hiddenContextText,
          watcherFired: { kind: batch.message.watcherFired.kind },
          delegationNoticeBatchId: batch.batchId,
        });
      if (outcome === 'submitted' || outcome === 'already_delivered') return {};
      return {
        suppressedReason:
          outcome === 'terminal_presenter'
            ? 'terminal_presenter_unsupported'
            : 'parent_gone',
      };
    }

    if (!batch.parentKey.startsWith('delegate:'))
      return { suppressedReason: 'parent_gone' };
    const parentDelegationId = batch.parentKey.slice('delegate:'.length);
    if (!parentDelegationId) return { suppressedReason: 'parent_gone' };
    const message = batch.message.hiddenContextText;
    // Checked after the inbox wait: a notice never resumes a stopped parent.
    const result = await this.childMessages.deliver(
      parentDelegationId,
      message,
      noticeDeliveryOperationId(batch.batchId, attempt),
      CHILD_DELIVERY_FAILURE_MESSAGE,
      () => !this.isStopped(parentDelegationId),
    );
    if (result.ok) return {};
    if (hasTransientParentNotReadyRefusal(result.error)) return 'transient';
    return { suppressedReason: 'parent_gone' };
  }

  private async acknowledgeBatch(
    batch: DeliveryBatch,
    suppressedReason?: string,
  ): Promise<void> {
    for (const entry of batch.entries) {
      this.store.acknowledge(
        entry.notice.delegationId,
        entry.notice.resultIndex,
        suppressedReason,
      );
      this.store.settleOwed(entry.noticeId);
    }
    this.store.clearPending(batch.batchId);
    await this.flushStore();
  }

  private async suppressBatch(
    batch: DeliveryBatch,
    reason: string,
  ): Promise<void> {
    // App shutdown keeps a journaled batch for the next start, and owes the
    // entries of one that was never journaled.
    if (reason === APP_SHUTDOWN) {
      if (
        !this.store.pending().some(({ batchId }) => batchId === batch.batchId)
      )
        await this.deferEntries(batch.entries);
      return;
    }
    await this.suppressEntries(batch.entries, reason, batch.batchId);
  }

  /**
   * Owes notices deferred by app shutdown. Owed notices survive a later
   * shutdown acknowledgement of the same delegation's next generation.
   */
  private async deferEntries(entries: readonly NoticeEntry[]): Promise<void> {
    if (entries.length === 0) return;
    this.store.owe(
      entries.map(({ noticeId: id, notice }) => ({
        noticeId: id,
        delegationId: notice.delegationId,
        runGeneration: notice.runGeneration,
        resultIndex: notice.resultIndex,
      })),
    );
    await this.flushStore();
  }

  private async suppressEntries(
    entries: readonly NoticeEntry[],
    reason: string,
    batchId?: string,
  ): Promise<void> {
    for (const entry of entries) {
      this.store.acknowledge(
        entry.notice.delegationId,
        entry.notice.resultIndex,
        reason,
      );
      this.store.settleOwed(entry.noticeId);
    }
    if (batchId) this.store.clearPending(batchId);
    await this.flushStore();
  }

  private async flushStore(): Promise<void> {
    try {
      await this.store.flush();
    } catch (error) {
      this.reportError(error);
    }
  }

  private finishJob(job: BatchJob, retry: boolean): void {
    const { batch } = job;
    if (retry && !job.cancelled) {
      // Stays at the front of its blocked queue until the next trigger.
      if (this.activeJobs.get(batch.parentKey) === job)
        this.activeJobs.delete(batch.parentKey);
      job.started = false;
      job.handingOff = false;
      job.resolve();
      // A notice that arrived during the failed hand-off is its retry trigger.
      if (this.retryTriggers.delete(batch.parentKey)) {
        this.blockedParents.delete(batch.parentKey);
        this.pumpParent(batch.parentKey);
      }
      return;
    }
    this.retryTriggers.delete(batch.parentKey);
    const queue = this.queues.get(batch.parentKey);
    if (queue) {
      const remaining = queue.filter((candidate) => candidate !== job);
      if (remaining.length > 0) this.queues.set(batch.parentKey, remaining);
      else this.queues.delete(batch.parentKey);
    }
    if (this.activeJobs.get(batch.parentKey) === job)
      this.activeJobs.delete(batch.parentKey);
    if (this.jobsByBatchId.get(batch.batchId) === job)
      this.jobsByBatchId.delete(batch.batchId);
    job.resolve();
    this.pumpParent(batch.parentKey);
  }

  private parentTreeKeys(parentKey: string): Set<string> {
    const keys = new Set([parentKey]);
    if (parentKey.startsWith('root:')) {
      const [projectId, worktreeId, chatId] = parentKey
        .slice('root:'.length)
        .split('/');
      const records = Array.from(this.catalog.values()).filter(
        (record) =>
          record.parent.projectId === projectId &&
          record.parent.worktreeId === worktreeId &&
          record.parent.chatId === chatId,
      );
      const childIds = new Set<string>();
      for (const record of records) {
        if (record.parentDelegationId) childIds.add(record.parentDelegationId);
        childIds.add(record.state.delegationId);
      }
      for (const id of Array.from(childIds)) keys.add(childParentKey(id));
      return keys;
    }

    if (!parentKey.startsWith('delegate:')) return keys;
    const descendants = new Set([parentKey.slice('delegate:'.length)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of Array.from(this.catalog.values())) {
        if (
          record.parentDelegationId &&
          descendants.has(record.parentDelegationId) &&
          !descendants.has(record.state.delegationId)
        ) {
          descendants.add(record.state.delegationId);
          changed = true;
        }
      }
    }
    for (const id of Array.from(descendants)) keys.add(childParentKey(id));
    return keys;
  }

  private recordBelongsToChat(
    record: StoredDelegation,
    target: {
      readonly projectId: string;
      readonly worktreeId: string;
      readonly chatId: string;
    },
  ): boolean {
    return (
      record.parent.projectId === target.projectId &&
      record.parent.worktreeId === target.worktreeId &&
      record.parent.chatId === target.chatId
    );
  }

  private isStopped(delegationId: string): boolean {
    const status =
      this.statusByDelegation.get(delegationId) ??
      this.catalog.get(delegationId)?.state.status;
    if (status === 'cancelled' || status === 'deadline_exceeded') return true;
    // A follow-up that resumed a fenced delegate lifts its fence.
    if (status !== undefined && isActive(status))
      this.stopFence.delete(delegationId);
    return this.stopFence.has(delegationId);
  }

  private isTeardownReason(reason: string | undefined): boolean {
    return reason !== undefined && SUPPRESSED_TEARDOWN_REASONS.has(reason);
  }

  private closingReasonForEntry(entry: NoticeEntry): string | undefined {
    const directReason = this.closingReasons.get(entry.parentKey);
    if (directReason) return directReason;
    const { projectId, worktreeId, chatId } = entry.record.parent;
    return this.closingReasons.get(
      delegationNoticeRootParentKey(projectId, worktreeId, chatId),
    );
  }

  private closingReasonForBatch(batch: DeliveryBatch): string | undefined {
    const directReason = this.closingReasons.get(batch.parentKey);
    if (directReason) return directReason;
    for (const entry of batch.entries) {
      const reason = this.closingReasonForEntry(entry);
      if (reason) return reason;
    }
    return undefined;
  }

  private reportError(error: unknown): void {
    try {
      this.onError(error);
    } catch {
      // Reporting must not perturb broker settlement or delivery recovery.
    }
  }
}
