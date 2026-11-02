import type {
  CanopyClient,
  DelegationBlocksPage,
  DelegationBlocksRequest,
  DelegationPage,
  DelegationPageRequest,
  DelegationReadTarget,
  TranscriptContentRange,
  TranscriptContentRequest,
  TranscriptReadResult,
  TranscriptReadSource,
} from '@canopy/app-core';
import { create } from 'zustand';
import { useCanopyClientStore } from '../CanopyClientProvider';
import {
  CLIENT_STORE_ACTIVATE,
  CLIENT_STORE_DISPOSE,
  type ClientStore,
} from '../client-store-lifecycle';

const MAX_CACHED_PAGES = 24;
const MAX_CACHED_BYTES = 12 * 1024 * 1024;
const MAX_IN_FLIGHT_READS = 2;
const MAX_QUEUED_READS = 32;

/** The newest page or one older page in a transcript chain. */
export interface DelegationPageReadRequest {
  readonly source: TranscriptReadSource;
  readonly target: DelegationReadTarget;
  readonly cursor: string;
  /** Scope lifecycle epoch; older-epoch cache entries are unreachable. */
  readonly epoch: number;
  /** Latest accepted stream revision hint, when available. */
  readonly streamRevisionHint?: number;
}

/** One bounded row page. Epoch and revision never cross the transport seam. */
export interface DelegationBlocksReadRequest extends DelegationBlocksRequest {
  readonly epoch: number;
  readonly streamRevisionHint?: number;
}

/** Omitted epoch retains the legacy reader's epoch zero identity. */
export interface DelegationContentReadRequest extends TranscriptContentRequest {
  readonly epoch?: number;
  /** UI-local transcript fence; never sent to the transport. */
  readonly streamRevision?: number;
}

export interface DelegationTargetLeaseRequest {
  readonly source: TranscriptReadSource;
  readonly target: DelegationReadTarget;
  readonly epoch: number;
}

export interface DelegationRevisionAdvanceRequest extends DelegationTargetLeaseRequest {
  readonly streamRevisionHint: number;
}

/** The client-bound page and full-content reader store. */
export interface DelegationPagesState {
  /** Retain the target's revision fence for as long as its reader is mounted. */
  retainTarget?(this: void, request: DelegationTargetLeaseRequest): () => void;
  /** Advance a history target's fence without making a transport read. */
  advanceRevision?(this: void, request: DelegationRevisionAdvanceRequest): void;
  readPage(
    request: DelegationPageReadRequest,
    signal: AbortSignal,
  ): Promise<TranscriptReadResult<DelegationPage>>;
  readBlocks(
    request: DelegationBlocksReadRequest,
    signal: AbortSignal,
  ): Promise<TranscriptReadResult<DelegationBlocksPage>>;
  readContent(
    request: DelegationContentReadRequest,
    signal: AbortSignal,
  ): Promise<TranscriptReadResult<TranscriptContentRange>>;
}

interface PageCacheEntry {
  readonly kind: 'page';
  readonly baseKey: string;
  readonly targetKey: string;
  readonly cursor: string;
  readonly revision: number;
  readonly result: TranscriptReadResult<DelegationPage>;
  readonly bytes: number;
}

interface BlocksCacheEntry {
  readonly kind: 'blocks';
  readonly baseKey: string;
  readonly targetKey: string;
  readonly cursor: string;
  readonly revision: number;
  readonly result: TranscriptReadResult<DelegationBlocksPage>;
  readonly bytes: number;
}
type CacheEntry = PageCacheEntry | BlocksCacheEntry;
interface BlocksSubscriber {
  settle(result: TranscriptReadResult<DelegationBlocksPage>): void;
}
interface BlocksJob extends ReadJobBase {
  readonly kind: 'blocks';
  readonly baseKey: string;
  readonly targetKey: string;
  readonly flightKey: string;
  readonly request: DelegationBlocksReadRequest;
  readonly revisionFence: number | undefined;
  readonly subscribers: Set<BlocksSubscriber>;
}

interface PageSubscriber {
  settle(result: TranscriptReadResult<DelegationPage>): void;
}

interface ContentSubscriber {
  settle(result: TranscriptReadResult<TranscriptContentRange>): void;
}

interface ReadJobBase {
  readonly controller: AbortController;
  readonly generation: number;
  started: boolean;
  invalidated: boolean;
}

interface PageJob extends ReadJobBase {
  readonly kind: 'page';
  readonly baseKey: string;
  readonly targetKey: string;
  readonly cursor: string;
  readonly flightKey: string;
  readonly revisionFence: number | undefined;
  readonly request: DelegationPageReadRequest;
  readonly subscribers: Set<PageSubscriber>;
}

interface ContentJob extends ReadJobBase {
  readonly kind: 'content';
  readonly targetKey: string;
  readonly flightKey: string;
  readonly request: DelegationContentReadRequest;
  readonly revisionFence: number | undefined;
  readonly subscribers: Set<ContentSubscriber>;
}

type ReadJob = PageJob | ContentJob | BlocksJob;

function sourceTargetKey(
  source: TranscriptReadSource,
  target: TranscriptContentRequest['target'],
  epoch: number,
): string {
  return JSON.stringify([sourceKey(source), stableSerialize(target), epoch]);
}

function sourceKey(source: TranscriptReadSource): string {
  return stableSerialize(source);
}

function stableSerialize(value: unknown): string {
  if (value === null) return '["null"]';
  if (typeof value === 'undefined') return '["undefined"]';
  if (typeof value === 'string') {
    return `["string",${JSON.stringify(value)}]`;
  }
  if (typeof value === 'number') {
    return `["number",${JSON.stringify(String(value))}]`;
  }
  if (typeof value === 'boolean') {
    return `["boolean",${String(value)}]`;
  }
  if (Array.isArray(value)) {
    return `["array",[${value
      .map((item) => stableSerialize(item))
      .join(',')}]]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `["object",{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableSerialize(Reflect.get(value, key))}`,
      )
      .join(',')}}]`;
  }
  return `["${typeof value}"]`;
}

function blocksReadSource(
  request: DelegationBlocksReadRequest,
): TranscriptReadSource {
  const {
    target,
    messageId,
    firstBlockOrdinal,
    cursor,
    limit,
    epoch,
    streamRevisionHint,
    ...source
  } = request;
  void target;
  void messageId;
  void firstBlockOrdinal;
  void cursor;
  void limit;
  void epoch;
  void streamRevisionHint;
  return source;
}

function contentReadSource(
  request: DelegationContentReadRequest,
): TranscriptReadSource {
  const {
    target,
    messageId,
    blockOrdinal,
    field,
    fieldSource,
    offset,
    limit,
    epoch,
    streamRevision,
    ...source
  } = request;
  void target;
  void messageId;
  void blockOrdinal;
  void field;
  void fieldSource;
  void offset;
  void limit;
  void epoch;
  void streamRevision;
  return source;
}

function isValidRevision(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function isValidEpoch(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidTarget(target: TranscriptContentRequest['target']): boolean {
  return (
    target.chatId.length > 0 &&
    (target.kind === 'primary' ||
      (target.delegationId.length > 0 &&
        Number.isSafeInteger(target.runGeneration) &&
        target.runGeneration >= 0))
  );
}

function isValidSource(source: TranscriptReadSource): boolean {
  return (
    source.scope.workspaceId.length > 0 &&
    source.scope.worktreeId.length > 0 &&
    source.scope.chatId.length > 0 &&
    (source.archivedContainerId === undefined ||
      source.archivedContainerId.length > 0)
  );
}

function isValidTargetRequest(
  source: TranscriptReadSource,
  target: TranscriptContentRequest['target'],
  epoch: number,
): boolean {
  return isValidSource(source) && isValidTarget(target) && isValidEpoch(epoch);
}

function contentKey(
  request: DelegationContentReadRequest,
  revisionFence: number | undefined,
): string {
  return JSON.stringify([
    sourceKey(contentReadSource(request)),
    stableSerialize(request.target),
    request.messageId,
    request.blockOrdinal,
    request.field,
    request.fieldSource ?? 'stored',
    request.epoch ?? 0,
    revisionFence ?? null,
    request.offset,
    request.limit,
  ]);
}

function pageClientRequest(
  request: DelegationPageReadRequest,
): DelegationPageRequest {
  return {
    ...request.source,
    target: request.target,
    ...(request.cursor === 'newest' ? {} : { cursor: request.cursor }),
  };
}

function contentClientRequest(
  request: DelegationContentReadRequest,
): TranscriptContentRequest {
  const { epoch, streamRevision, ...transport } = request;
  void epoch;
  void streamRevision;
  return transport;
}
function blocksClientRequest(
  request: DelegationBlocksReadRequest,
): DelegationBlocksRequest {
  const { epoch, streamRevisionHint, ...transport } = request;
  void epoch;
  void streamRevisionHint;
  return transport;
}
function blocksPosition(request: DelegationBlocksRequest): string {
  return JSON.stringify([
    request.cursor ?? null,
    request.firstBlockOrdinal ?? 0,
    request.limit,
    'bounded-v1',
  ]);
}

/** Create one provider-lifecycle transcript reader store for a client. */
export function createDelegationPagesStore(
  client: CanopyClient,
): ClientStore<DelegationPagesState> {
  const cache = new Map<string, CacheEntry>();
  const blocksJobs = new Map<string, BlocksJob>();
  const latestHints = new Map<string, number>();
  const targetLeaseCounts = new Map<string, number>();
  const pageJobs = new Map<string, PageJob>();
  const contentJobs = new Map<string, ContentJob>();
  const queue: ReadJob[] = [];
  const jobs = new Set<ReadJob>();
  let cachedBytes = 0;
  let activeReads = 0;
  let generation = 0;
  let disposed = false;

  function pruneUnusedHints(): void {
    for (const baseKey of Array.from(latestHints.keys())) {
      let retained = (targetLeaseCounts.get(baseKey) ?? 0) > 0;
      cache.forEach((entry: CacheEntry) => {
        if (entry.targetKey === baseKey) {
          retained = true;
        }
      });
      if (!retained) {
        jobs.forEach((job: ReadJob) => {
          if (job.targetKey === baseKey && !job.invalidated) {
            retained = true;
          }
        });
      }
      if (!retained) {
        latestHints.delete(baseKey);
      }
    }
  }

  const removeCacheEntry = (key: string, entry: CacheEntry): void => {
    if (cache.get(key) !== entry) {
      return;
    }
    cache.delete(key);
    cachedBytes -= entry.bytes;
  };

  const settlePageSubscribers = (
    job: PageJob,
    result: TranscriptReadResult<DelegationPage>,
  ): void => {
    for (const subscriber of Array.from(job.subscribers)) {
      job.subscribers.delete(subscriber);
      subscriber.settle(result);
    }
  };

  const settleContentSubscribers = (
    job: ContentJob,
    result: TranscriptReadResult<TranscriptContentRange>,
  ): void => {
    for (const subscriber of Array.from(job.subscribers)) {
      job.subscribers.delete(subscriber);
      subscriber.settle(result);
    }
  };

  const removeFromQueue = (job: ReadJob): void => {
    const index = queue.indexOf(job);
    if (index >= 0) {
      queue.splice(index, 1);
    }
  };

  const removeFlightIndex = (job: ReadJob): void => {
    if (job.kind === 'page') {
      if (pageJobs.get(job.flightKey) === job) {
        pageJobs.delete(job.flightKey);
      }
      return;
    }
    if (job.kind === 'blocks') {
      if (blocksJobs.get(job.flightKey) === job)
        blocksJobs.delete(job.flightKey);
      return;
    }
    if (contentJobs.get(job.flightKey) === job) {
      contentJobs.delete(job.flightKey);
    }
  };

  const abandonJob = (job: ReadJob): void => {
    removeFlightIndex(job);
    if (job.started) {
      // The adapter fences before and after its relay call; abort does not free
      // this permit until that underlying promise settles.
      job.controller.abort();
      return;
    }
    removeFromQueue(job);
    jobs.delete(job);
    drainQueue();
  };

  const subscribePage = (
    job: PageJob,
    signal: AbortSignal,
  ): Promise<TranscriptReadResult<DelegationPage>> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve({ ok: false, kind: 'cancelled' });
        return;
      }

      let settled = false;
      const subscriber: PageSubscriber = {
        settle(result): void {
          if (settled) {
            return;
          }
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
      };
      const onAbort = (): void => {
        if (!job.subscribers.delete(subscriber)) {
          return;
        }
        subscriber.settle({ ok: false, kind: 'cancelled' });
        if (job.subscribers.size === 0) {
          abandonJob(job);
        }
      };
      job.subscribers.add(subscriber);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });

  const subscribeBlocks = (
    job: BlocksJob,
    signal: AbortSignal,
  ): Promise<TranscriptReadResult<DelegationBlocksPage>> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve({ ok: false, kind: 'cancelled' });
        return;
      }

      let settled = false;
      const subscriber: BlocksSubscriber = {
        settle(result): void {
          if (settled) {
            return;
          }
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
      };
      const onAbort = (): void => {
        if (!job.subscribers.delete(subscriber)) {
          return;
        }
        subscriber.settle({ ok: false, kind: 'cancelled' });
        if (job.subscribers.size === 0) {
          abandonJob(job);
        }
      };
      job.subscribers.add(subscriber);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });

  const subscribeContent = (
    job: ContentJob,
    signal: AbortSignal,
  ): Promise<TranscriptReadResult<TranscriptContentRange>> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve({ ok: false, kind: 'cancelled' });
        return;
      }

      let settled = false;
      const subscriber: ContentSubscriber = {
        settle(result): void {
          if (settled) {
            return;
          }
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
      };
      const onAbort = (): void => {
        if (!job.subscribers.delete(subscriber)) {
          return;
        }
        subscriber.settle({ ok: false, kind: 'cancelled' });
        if (job.subscribers.size === 0) {
          abandonJob(job);
        }
      };
      job.subscribers.add(subscriber);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });

  const admitPage = (
    baseKey: string,
    cursor: string,
    result: TranscriptReadResult<DelegationPage>,
  ): void => {
    if (!result.ok) {
      return;
    }
    const revision = result.value.transcriptRevision;
    const key = JSON.stringify([baseKey, revision, cursor]);
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(result);
    } catch {
      return;
    }
    if (serialized === undefined) {
      return;
    }
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > MAX_CACHED_BYTES) {
      return;
    }

    const replaced = cache.get(key);
    if (replaced) {
      removeCacheEntry(key, replaced);
    }
    while (
      cache.size >= MAX_CACHED_PAGES ||
      cachedBytes + bytes > MAX_CACHED_BYTES
    ) {
      let evicted = false;
      cache.forEach((entry: CacheEntry, key: string) => {
        if (!evicted) {
          evicted = true;
          removeCacheEntry(key, entry);
        }
      });
      if (!evicted) {
        break;
      }
    }
    const entry: PageCacheEntry = {
      kind: 'page',
      baseKey,
      targetKey: baseKey,
      cursor,
      revision,
      result,
      bytes,
    };
    cache.set(key, entry);
    cachedBytes += bytes;
  };

  const findCachedPage = (
    baseKey: string,
    cursor: string,
    revisionFence: number | undefined,
  ): PageCacheEntry | undefined => {
    let matchKey: string | undefined;
    let matchEntry: PageCacheEntry | undefined;
    cache.forEach((entry: CacheEntry, key: string) => {
      if (
        entry.kind !== 'page' ||
        entry.baseKey !== baseKey ||
        entry.cursor !== cursor ||
        (revisionFence !== undefined && entry.revision < revisionFence)
      ) {
        return;
      }
      if (!matchEntry || entry.revision > matchEntry.revision) {
        matchKey = key;
        matchEntry = entry;
      }
    });
    if (matchKey === undefined || matchEntry === undefined) {
      return undefined;
    }
    cache.delete(matchKey);
    cache.set(matchKey, matchEntry);
    return matchEntry;
  };

  const invalidatePageJob = (job: PageJob): void => {
    invalidateJob(job, 'stale');
  };

  const invalidateJob = (job: ReadJob, kind: 'stale' | 'cancelled'): void => {
    job.invalidated = true;
    removeFlightIndex(job);
    if (job.started) {
      // Running transports keep their permit until the underlying promise settles.
      job.controller.abort();
    } else {
      removeFromQueue(job);
      jobs.delete(job);
    }
    if (job.kind === 'page') {
      settlePageSubscribers(job, { ok: false, kind });
    } else if (job.kind === 'blocks') {
      for (const subscriber of Array.from(job.subscribers)) {
        job.subscribers.delete(subscriber);
        subscriber.settle({ ok: false, kind });
      }
    } else {
      settleContentSubscribers(job, { ok: false, kind });
    }
  };

  const advanceFence = (
    targetKey: string,
    revision: number,
    except?: ReadJob,
  ): void => {
    const current = latestHints.get(targetKey);
    if (current !== undefined && revision <= current) {
      return;
    }
    // Keep the new fence visible while callers synchronously admit its job or
    // cache owner. Pruning here after invalidating older jobs could drop it.
    latestHints.set(targetKey, revision);
    for (const [key, entry] of Array.from(cache.entries())) {
      if (entry.targetKey === targetKey && entry.revision < revision) {
        removeCacheEntry(key, entry);
      }
    }
    for (const job of Array.from(jobs)) {
      if (
        job !== except &&
        job.targetKey === targetKey &&
        (job.revisionFence === undefined || job.revisionFence < revision)
      ) {
        invalidateJob(job, 'stale');
      }
    }
    drainQueue();
  };

  const clearTarget = (targetKey: string): void => {
    for (const [key, entry] of Array.from(cache.entries())) {
      if (entry.targetKey === targetKey) {
        removeCacheEntry(key, entry);
      }
    }
    for (const job of Array.from(jobs)) {
      if (job.targetKey === targetKey) {
        invalidateJob(job, 'cancelled');
      }
    }
    latestHints.delete(targetKey);
    drainQueue();
  };

  const invalidatePageChain = (baseKey: string, except?: PageJob): void => {
    for (const [key, entry] of Array.from(cache.entries())) {
      if (entry.baseKey === baseKey) {
        removeCacheEntry(key, entry);
      }
    }
    for (const job of Array.from(jobs)) {
      if (job.kind === 'page' && job !== except && job.baseKey === baseKey) {
        invalidatePageJob(job);
      }
    }
    drainQueue();
  };

  function drainQueue(): void {
    while (!disposed && activeReads < MAX_IN_FLIGHT_READS && queue.length > 0) {
      const job = queue.shift();
      if (!job) {
        return;
      }
      if (job.invalidated || job.subscribers.size === 0) {
        removeFlightIndex(job);
        jobs.delete(job);
        continue;
      }
      job.started = true;
      activeReads += 1;
      if (job.kind === 'page') {
        void runPageJob(job);
      } else if (job.kind === 'blocks') {
        void runBlocksJob(job);
      } else {
        void runContentJob(job);
      }
    }
  }

  const finishJob = (job: ReadJob): void => {
    removeFlightIndex(job);
    jobs.delete(job);
    if (job.started) {
      activeReads -= 1;
    }
    pruneUnusedHints();
    drainQueue();
  };

  const completePageJob = (
    job: PageJob,
    clientResult: TranscriptReadResult<DelegationPage>,
  ): void => {
    if (job.invalidated) {
      return;
    }
    if (disposed || job.generation !== generation) {
      settlePageSubscribers(job, { ok: false, kind: 'cancelled' });
      return;
    }
    if (clientResult.ok) {
      const responseRevision = clientResult.value.transcriptRevision;
      if (!isValidRevision(responseRevision)) {
        invalidatePageChain(job.baseKey, job);
        settlePageSubscribers(job, { ok: false, kind: 'stale' });
        return;
      }
      const latestHint = latestHints.get(job.targetKey);
      const revisionFence = Math.max(
        job.revisionFence ?? Number.NEGATIVE_INFINITY,
        latestHint ?? Number.NEGATIVE_INFINITY,
      );
      if (responseRevision < revisionFence) {
        invalidatePageChain(job.baseKey, job);
        settlePageSubscribers(job, { ok: false, kind: 'stale' });
        return;
      }
      if (!job.controller.signal.aborted) {
        advanceFence(job.targetKey, responseRevision, job);
        admitPage(job.baseKey, job.cursor, clientResult);
      }
      settlePageSubscribers(job, clientResult);
      return;
    }
    if (clientResult.kind === 'stale') {
      invalidatePageChain(job.baseKey, job);
    }
    settlePageSubscribers(job, clientResult);
  };

  async function runPageJob(job: PageJob): Promise<void> {
    let result: TranscriptReadResult<DelegationPage>;
    try {
      const transcripts = client.transcripts;
      result = transcripts
        ? await transcripts.delegationPage(
            pageClientRequest(job.request),
            job.controller.signal,
          )
        : { ok: false, kind: 'unavailable' };
    } catch {
      result = { ok: false, kind: 'failed' };
    }
    completePageJob(job, result);
    finishJob(job);
  }

  const clearBlocksChain = (baseKey: string, except?: BlocksJob): void => {
    for (const [key, entry] of Array.from(cache.entries())) {
      if (entry.kind === 'blocks' && entry.baseKey === baseKey)
        removeCacheEntry(key, entry);
    }
    for (const job of Array.from(jobs)) {
      if (job.kind !== 'blocks' || job.baseKey !== baseKey || job === except)
        continue;
      invalidateJob(job, 'stale');
    }
    drainQueue();
  };

  async function runBlocksJob(job: BlocksJob): Promise<void> {
    let result: TranscriptReadResult<DelegationBlocksPage>;
    let transport = blocksClientRequest(job.request);
    try {
      result = client.transcripts
        ? await client.transcripts.blocks(transport, job.controller.signal)
        : { ok: false, kind: 'unavailable' };
      if (
        !result.ok &&
        result.kind === 'stale' &&
        !job.controller.signal.aborted &&
        !job.invalidated
      ) {
        clearBlocksChain(job.baseKey, job);
        transport = { ...transport, cursor: undefined, firstBlockOrdinal: 0 };
        result = client.transcripts
          ? await client.transcripts.blocks(transport, job.controller.signal)
          : { ok: false, kind: 'unavailable' };
      }
    } catch {
      result = { ok: false, kind: 'failed' };
    }
    if (!job.invalidated) {
      if (
        disposed ||
        job.generation !== generation ||
        job.controller.signal.aborted
      ) {
        result = { ok: false, kind: 'cancelled' };
      } else if (
        result.ok &&
        (!isValidRevision(result.value.transcriptRevision) ||
          result.value.transcriptRevision <
            Math.max(
              job.revisionFence ?? Number.NEGATIVE_INFINITY,
              latestHints.get(job.targetKey) ?? Number.NEGATIVE_INFINITY,
            ))
      ) {
        clearBlocksChain(job.baseKey, job);
        result = { ok: false, kind: 'stale' };
      }
      if (result.ok) {
        advanceFence(job.targetKey, result.value.transcriptRevision, job);
        const cursor = blocksPosition(transport);
        const revision = result.value.transcriptRevision;
        const key = JSON.stringify(['blocks', job.baseKey, revision, cursor]);
        const bytes = new TextEncoder().encode(
          JSON.stringify(result),
        ).byteLength;
        if (bytes <= MAX_CACHED_BYTES) {
          const previous = cache.get(key);
          if (previous) removeCacheEntry(key, previous);
          while (
            cache.size >= MAX_CACHED_PAGES ||
            cachedBytes + bytes > MAX_CACHED_BYTES
          ) {
            const first = cache.entries().next().value;
            if (!first) break;
            removeCacheEntry(first[0], first[1]);
          }
          cache.set(key, {
            kind: 'blocks',
            baseKey: job.baseKey,
            targetKey: job.targetKey,
            cursor,
            revision,
            bytes,
            result,
          });
          cachedBytes += bytes;
        }
      }
      for (const subscriber of Array.from(job.subscribers)) {
        job.subscribers.delete(subscriber);
        subscriber.settle(result);
      }
    }
    finishJob(job);
  }

  const readBlocks = (
    request: DelegationBlocksReadRequest,
    signal: AbortSignal,
  ): Promise<TranscriptReadResult<DelegationBlocksPage>> => {
    if (signal.aborted || disposed)
      return Promise.resolve({ ok: false, kind: 'cancelled' });
    if (!client.transcripts)
      return Promise.resolve({ ok: false, kind: 'unavailable' });
    if (
      !isValidTargetRequest(request, request.target, request.epoch) ||
      !isValidRevision(request.streamRevisionHint) ||
      request.messageId.length === 0
    ) {
      return Promise.resolve({ ok: false, kind: 'stale' });
    }
    const source = blocksReadSource(request);
    const targetKey = sourceTargetKey(source, request.target, request.epoch);
    const seenHint = latestHints.get(targetKey);
    if (
      request.streamRevisionHint !== undefined &&
      seenHint !== undefined &&
      request.streamRevisionHint < seenHint
    ) {
      pruneUnusedHints();
      return Promise.resolve({ ok: false, kind: 'stale' });
    }
    if (
      request.streamRevisionHint !== undefined &&
      (seenHint === undefined || request.streamRevisionHint > seenHint)
    ) {
      advanceFence(targetKey, request.streamRevisionHint);
    }
    const revisionFence = latestHints.get(targetKey);
    const baseKey = JSON.stringify([targetKey, request.messageId]);
    const cursor = blocksPosition(request);
    let found: BlocksCacheEntry | undefined;
    let foundKey: string | undefined;
    cache.forEach((entry, key) => {
      if (
        entry.kind === 'blocks' &&
        entry.baseKey === baseKey &&
        entry.cursor === cursor &&
        entry.revision >= (revisionFence ?? Number.NEGATIVE_INFINITY) &&
        (!found || entry.revision > found.revision)
      ) {
        found = entry;
        foundKey = key;
      }
    });
    if (
      found &&
      foundKey !== undefined &&
      (request.cursor !== undefined || request.streamRevisionHint !== undefined)
    ) {
      cache.delete(foundKey);
      cache.set(foundKey, found);
      return Promise.resolve(found.result);
    }
    const flightKey = JSON.stringify([baseKey, cursor, revisionFence ?? null]);
    const existing = blocksJobs.get(flightKey);
    if (existing) return subscribeBlocks(existing, signal);
    if (queue.length >= MAX_QUEUED_READS) {
      pruneUnusedHints();
      return Promise.resolve({ ok: false, kind: 'failed' });
    }
    const job: BlocksJob = {
      kind: 'blocks',
      baseKey,
      targetKey,
      flightKey,
      request,
      revisionFence,
      controller: new AbortController(),
      generation,
      started: false,
      invalidated: false,
      subscribers: new Set<BlocksSubscriber>(),
    };
    blocksJobs.set(flightKey, job);
    jobs.add(job);
    const result = subscribeBlocks(job, signal);
    queue.push(job);
    drainQueue();
    return result;
  };

  async function runContentJob(job: ContentJob): Promise<void> {
    let result: TranscriptReadResult<TranscriptContentRange>;
    try {
      const transcripts = client.transcripts;
      result = transcripts
        ? await transcripts.content(
            contentClientRequest(job.request),
            job.controller.signal,
          )
        : { ok: false, kind: 'unavailable' };
    } catch {
      result = { ok: false, kind: 'failed' };
    }
    if (job.invalidated) {
      finishJob(job);
      return;
    }
    if (disposed || job.generation !== generation) {
      settleContentSubscribers(job, { ok: false, kind: 'cancelled' });
    } else {
      const latestHint = latestHints.get(job.targetKey);
      if (
        latestHint !== undefined &&
        (job.revisionFence === undefined || job.revisionFence < latestHint)
      ) {
        settleContentSubscribers(job, { ok: false, kind: 'stale' });
      } else {
        settleContentSubscribers(job, result);
      }
    }
    finishJob(job);
  }

  const readPage = (
    request: DelegationPageReadRequest,
    signal: AbortSignal,
  ): Promise<TranscriptReadResult<DelegationPage>> => {
    if (signal.aborted || disposed) {
      return Promise.resolve({ ok: false, kind: 'cancelled' });
    }
    if (!client.transcripts) {
      return Promise.resolve({ ok: false, kind: 'unavailable' });
    }
    if (
      !isValidTargetRequest(request.source, request.target, request.epoch) ||
      !isValidRevision(request.streamRevisionHint)
    ) {
      return Promise.resolve({ ok: false, kind: 'stale' });
    }

    const baseKey = sourceTargetKey(
      request.source,
      request.target,
      request.epoch,
    );
    const seenHint = latestHints.get(baseKey);
    if (
      request.streamRevisionHint !== undefined &&
      seenHint !== undefined &&
      request.streamRevisionHint < seenHint
    ) {
      pruneUnusedHints();
      return Promise.resolve({ ok: false, kind: 'stale' });
    }
    if (
      request.streamRevisionHint !== undefined &&
      (seenHint === undefined || request.streamRevisionHint > seenHint)
    ) {
      advanceFence(baseKey, request.streamRevisionHint);
    }
    const revisionFence = latestHints.get(baseKey);

    const cached = findCachedPage(baseKey, request.cursor, revisionFence);
    if (
      cached &&
      (request.cursor !== 'newest' || request.streamRevisionHint !== undefined)
    ) {
      return Promise.resolve(cached.result);
    }

    const flightKey = JSON.stringify([
      baseKey,
      request.cursor,
      revisionFence ?? null,
    ]);
    const existing = pageJobs.get(flightKey);
    if (existing) {
      return subscribePage(existing, signal);
    }
    if (queue.length >= MAX_QUEUED_READS) {
      pruneUnusedHints();
      return Promise.resolve({ ok: false, kind: 'failed' });
    }

    const job: PageJob = {
      kind: 'page',
      baseKey,
      targetKey: baseKey,
      cursor: request.cursor,
      flightKey,
      revisionFence,
      request,
      controller: new AbortController(),
      generation,
      started: false,
      invalidated: false,
      subscribers: new Set<PageSubscriber>(),
    };
    pageJobs.set(flightKey, job);
    jobs.add(job);
    const result = subscribePage(job, signal);
    queue.push(job);
    drainQueue();
    return result;
  };

  const readContent = (
    request: DelegationContentReadRequest,
    signal: AbortSignal,
  ): Promise<TranscriptReadResult<TranscriptContentRange>> => {
    if (signal.aborted || disposed) {
      return Promise.resolve({ ok: false, kind: 'cancelled' });
    }
    if (!client.transcripts) {
      return Promise.resolve({ ok: false, kind: 'unavailable' });
    }
    const epoch = request.epoch ?? 0;
    const source = contentReadSource(request);
    if (
      !isValidTargetRequest(source, request.target, epoch) ||
      !isValidRevision(request.streamRevision)
    ) {
      return Promise.resolve({ ok: false, kind: 'stale' });
    }
    const targetKey = sourceTargetKey(source, request.target, epoch);
    const seenHint = latestHints.get(targetKey);
    if (
      request.streamRevision !== undefined &&
      seenHint !== undefined &&
      request.streamRevision < seenHint
    ) {
      pruneUnusedHints();
      return Promise.resolve({ ok: false, kind: 'stale' });
    }
    if (
      request.streamRevision !== undefined &&
      (seenHint === undefined || request.streamRevision > seenHint)
    ) {
      advanceFence(targetKey, request.streamRevision);
    }
    const revisionFence = latestHints.get(targetKey);
    const flightKey = contentKey(request, revisionFence);
    const existing = contentJobs.get(flightKey);
    if (existing) {
      return subscribeContent(existing, signal);
    }
    if (queue.length >= MAX_QUEUED_READS) {
      pruneUnusedHints();
      return Promise.resolve({ ok: false, kind: 'failed' });
    }

    const job: ContentJob = {
      kind: 'content',
      targetKey,
      flightKey,
      request,
      revisionFence,
      controller: new AbortController(),
      generation,
      started: false,
      invalidated: false,
      subscribers: new Set<ContentSubscriber>(),
    };
    contentJobs.set(flightKey, job);
    jobs.add(job);
    const result = subscribeContent(job, signal);
    queue.push(job);
    drainQueue();
    return result;
  };

  const retainTarget = (
    request: DelegationTargetLeaseRequest,
  ): (() => void) => {
    if (
      disposed ||
      !isValidTargetRequest(request.source, request.target, request.epoch)
    ) {
      return (): void => {};
    }
    const targetKey = sourceTargetKey(
      request.source,
      request.target,
      request.epoch,
    );
    const lifecycleGeneration = generation;
    targetLeaseCounts.set(
      targetKey,
      (targetLeaseCounts.get(targetKey) ?? 0) + 1,
    );
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      if (lifecycleGeneration !== generation) return;
      const targetLeases = targetLeaseCounts.get(targetKey) ?? 0;
      if (targetLeases <= 1) {
        targetLeaseCounts.delete(targetKey);
        clearTarget(targetKey);
      } else {
        targetLeaseCounts.set(targetKey, targetLeases - 1);
      }
    };
  };

  const advanceRevision = (request: DelegationRevisionAdvanceRequest): void => {
    if (
      disposed ||
      !isValidTargetRequest(request.source, request.target, request.epoch) ||
      !isValidRevision(request.streamRevisionHint)
    ) {
      return;
    }
    const targetKey = sourceTargetKey(
      request.source,
      request.target,
      request.epoch,
    );
    const current = latestHints.get(targetKey);
    if (current !== undefined && request.streamRevisionHint < current) {
      return;
    }
    if (current === undefined || request.streamRevisionHint > current) {
      advanceFence(targetKey, request.streamRevisionHint);
    }
    pruneUnusedHints();
  };

  const store: ClientStore<DelegationPagesState> = create<DelegationPagesState>(
    () => ({
      retainTarget,
      advanceRevision,
      readPage,
      readBlocks,
      readContent,
    }),
  );
  store[CLIENT_STORE_ACTIVATE] = (): void => {
    disposed = false;
  };
  store[CLIENT_STORE_DISPOSE] = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    generation += 1;
    cache.clear();
    latestHints.clear();
    targetLeaseCounts.clear();
    cachedBytes = 0;
    pageJobs.clear();
    contentJobs.clear();
    blocksJobs.clear();
    for (const job of Array.from(jobs)) {
      invalidateJob(job, 'cancelled');
    }
  };
  return store;
}

const delegationPagesStoreKey = Symbol('delegation-pages-store');

/** Access the one transcript store owned by the current client provider. */
export function useDelegationPagesStore(): ClientStore<DelegationPagesState> {
  return useCanopyClientStore(
    delegationPagesStoreKey,
    createDelegationPagesStore,
  );
}

/** Explicit alias for call sites that prefer the `*StoreApi` naming pattern. */
export function useDelegationPagesStoreApi(): ClientStore<DelegationPagesState> {
  return useDelegationPagesStore();
}
