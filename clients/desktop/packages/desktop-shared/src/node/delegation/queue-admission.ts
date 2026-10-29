export const DELEGATION_ADMISSION_LIMITS: Readonly<{
  hostCapacity: 64;
  waitingPerBucket: 128;
  waitingPerApplication: 512;
}> = {
  hostCapacity: 64,
  waitingPerBucket: 128,
  waitingPerApplication: 512,
};

/** Buckets are keyed by the root chat in this release. */
export interface DelegationAdmissionBucket {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

export interface DelegationAdmissionRequest {
  /** Unique per run generation, e.g. `${delegationId}:${runGeneration}`. */
  readonly ticketId: string;
  readonly bucket: DelegationAdmissionBucket;
  readonly ifBusy: 'queue' | 'reject';
  /** FIFO key in ms (the time the work was accepted). Ties break by request order. */
  readonly queuedAt: number;
  /** Execution target; 'local' when omitted. */
  readonly workerId?: string;
  /** Called (via the scheduler) when a waiting ticket is granted; never for an immediate grant. */
  readonly onGranted: (lease: DelegationAdmissionLease) => void;
}

export type DelegationAdmissionDecision =
  | { readonly kind: 'granted'; readonly lease: DelegationAdmissionLease }
  | { readonly kind: 'waiting'; readonly ticket: DelegationAdmissionTicket }
  | { readonly kind: 'rejected'; readonly reason: 'busy' | 'queue_full' };

export interface DelegationAdmissionPosition {
  readonly position: number;
  readonly waitingFor: 'queue' | 'app';
}

export interface DelegationAdmissionTicket {
  readonly ticketId: string;
  /** Withdraw a waiting ticket. Idempotent; no-op once granted or cancelled. */
  cancel(): void;
  /** Undefined once granted or cancelled. */
  position(): DelegationAdmissionPosition | undefined;
}

export interface DelegationAdmissionLease {
  readonly ticketId: string;
  /** Free the slot. Idempotent. Triggers a pump. */
  release(): void;
  /**
   * Hand this slot to the next run of the same delegation (a follow-up accepted while
   * this run was active). Keeps the slot when the bucket is still within its (possibly
   * lowered) limit; otherwise releases it and queues `next` by its own queuedAt.
   * The old lease is consumed either way.
   */
  transfer(next: {
    readonly ticketId: string;
    readonly queuedAt: number;
    readonly onGranted: (lease: DelegationAdmissionLease) => void;
  }): DelegationAdmissionDecision;
}

export interface DelegationAdmissionBucketState {
  readonly running: number;
  readonly waiting: number;
  readonly limit: number;
}

export interface DelegationAdmissionController {
  request(request: DelegationAdmissionRequest): DelegationAdmissionDecision;
  bucketState(
    bucket: DelegationAdmissionBucket,
  ): DelegationAdmissionBucketState;
  /** Re-evaluate after a limit change (e.g. the user raised the setting). Never preempts. */
  refresh(): void;
  readonly activeCount: number;
  readonly waitingCount: number;
}

export interface DelegationAdmissionControllerOptions {
  /** Live per-bucket limit (clamp to 1–64). Default 5. */
  readonly limitForBucket?: (bucket: DelegationAdmissionBucket) => number;
  /** Live per-worker cap. Default DELEGATION_ADMISSION_LIMITS.hostCapacity. */
  readonly hostCapacity?: (workerId: string) => number;
  /** Defaults to queueMicrotask. Tests inject a synchronous or manual scheduler. */
  readonly schedule?: (callback: () => void) => void;
}

type EntryStatus = 'waiting' | 'active' | 'done';

interface WorkerState {
  readonly workerId: string;
  readonly buckets: BucketStateInternal[];
  running: number;
}

interface BucketStateInternal {
  readonly key: string;
  readonly bucket: DelegationAdmissionBucket;
  readonly waiters: AdmissionEntry[];
  running: number;
  limit: number;
  heapIndex: number | undefined;
  heapWorker: WorkerState | undefined;
}

interface AdmissionEntry {
  readonly ticketId: string;
  readonly bucketState: BucketStateInternal;
  readonly workerState: WorkerState;
  readonly queuedAt: number;
  readonly sequence: number;
  readonly onGranted: (lease: DelegationAdmissionLease) => void;
  status: EntryStatus;
  ticket: DelegationAdmissionTicket | undefined;
}

const DEFAULT_BUCKET_LIMIT = 5;
const LOCAL_WORKER_ID = 'local';

/**
 * Synchronous admission decisions with event-driven queue pumping. Bucket heads
 * live in per-worker heaps so an arrival does not need to scan unrelated queues.
 */
export function createDelegationAdmissionController(
  options: DelegationAdmissionControllerOptions = {},
): DelegationAdmissionController {
  const buckets = new Map<string, BucketStateInternal>();
  const workers = new Map<string, WorkerState>();
  const tickets = new Map<string, AdmissionEntry>();
  const schedule = options.schedule ?? queueMicrotask;
  let activeCount = 0;
  let waitingCount = 0;
  let sequence = 0;
  let invocationDepth = 0;
  let pumpPending = false;

  const withInvocation = <T>(operation: () => T): T => {
    invocationDepth += 1;
    try {
      return operation();
    } finally {
      invocationDepth -= 1;
    }
  };

  const scheduleSafely = (callback: () => void): void => {
    schedule(() => {
      if (invocationDepth > 0) {
        queueMicrotask(() => withInvocation(callback));
        return;
      }
      withInvocation(callback);
    });
  };

  const bucketKey = (bucket: DelegationAdmissionBucket): string =>
    JSON.stringify([bucket.projectId, bucket.worktreeId, bucket.chatId]);

  const readBucketLimit = (bucket: DelegationAdmissionBucket): number => {
    const configured = options.limitForBucket?.(bucket) ?? DEFAULT_BUCKET_LIMIT;
    if (!Number.isFinite(configured)) return DEFAULT_BUCKET_LIMIT;
    return Math.max(1, Math.min(64, Math.floor(configured)));
  };

  const readHostCapacity = (workerId: string): number => {
    const configured =
      options.hostCapacity?.(workerId) ??
      DELEGATION_ADMISSION_LIMITS.hostCapacity;
    if (!Number.isFinite(configured))
      return DELEGATION_ADMISSION_LIMITS.hostCapacity;
    return Math.max(0, Math.floor(configured));
  };

  const getOrCreateWorker = (workerId: string): WorkerState => {
    const existing = workers.get(workerId);
    if (existing) return existing;
    const created: WorkerState = { workerId, buckets: [], running: 0 };
    workers.set(workerId, created);
    return created;
  };

  const getOrCreateBucket = (
    bucket: DelegationAdmissionBucket,
  ): BucketStateInternal => {
    const key = bucketKey(bucket);
    const existing = buckets.get(key);
    if (existing) return existing;
    const created: BucketStateInternal = {
      key,
      bucket: { ...bucket },
      waiters: [],
      running: 0,
      limit: readBucketLimit(bucket),
      heapIndex: undefined,
      heapWorker: undefined,
    };
    buckets.set(key, created);
    return created;
  };

  const compareEntries = (
    left: AdmissionEntry,
    right: AdmissionEntry,
  ): number => {
    if (left.queuedAt < right.queuedAt) return -1;
    if (left.queuedAt > right.queuedAt) return 1;
    return left.sequence - right.sequence;
  };

  const compareBuckets = (
    left: BucketStateInternal,
    right: BucketStateInternal,
  ): number => {
    const leftHead = left.waiters[0];
    const rightHead = right.waiters[0];
    if (!leftHead) return rightHead ? 1 : 0;
    if (!rightHead) return -1;
    return compareEntries(leftHead, rightHead);
  };

  const swapHeapItems = (
    worker: WorkerState,
    firstIndex: number,
    secondIndex: number,
  ): void => {
    const first = worker.buckets[firstIndex];
    const second = worker.buckets[secondIndex];
    if (!first || !second) return;
    worker.buckets[firstIndex] = second;
    worker.buckets[secondIndex] = first;
    second.heapIndex = firstIndex;
    first.heapIndex = secondIndex;
  };

  const bubbleUp = (worker: WorkerState, initialIndex: number): void => {
    let index = initialIndex;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parent = worker.buckets[parentIndex];
      const current = worker.buckets[index];
      if (!parent || !current || compareBuckets(parent, current) <= 0) return;
      swapHeapItems(worker, parentIndex, index);
      index = parentIndex;
    }
  };

  const bubbleDown = (worker: WorkerState, initialIndex: number): void => {
    let index = initialIndex;
    while (true) {
      const leftIndex = index * 2 + 1;
      const rightIndex = leftIndex + 1;
      let smallestIndex = index;
      const smallest = worker.buckets[smallestIndex];
      const left = worker.buckets[leftIndex];
      const right = worker.buckets[rightIndex];
      if (left && smallest && compareBuckets(left, smallest) < 0)
        smallestIndex = leftIndex;
      const currentSmallest = worker.buckets[smallestIndex];
      if (
        right &&
        currentSmallest &&
        compareBuckets(right, currentSmallest) < 0
      )
        smallestIndex = rightIndex;
      if (smallestIndex === index) return;
      swapHeapItems(worker, index, smallestIndex);
      index = smallestIndex;
    }
  };

  const fixHeapItem = (worker: WorkerState, index: number): void => {
    const parentIndex = Math.floor((index - 1) / 2);
    const parent = worker.buckets[parentIndex];
    const current = worker.buckets[index];
    if (index > 0 && parent && current && compareBuckets(current, parent) < 0) {
      bubbleUp(worker, index);
      return;
    }
    bubbleDown(worker, index);
  };

  const removeFromHeap = (
    bucket: BucketStateInternal,
    worker: WorkerState,
  ): void => {
    const index = bucket.heapIndex;
    if (index === undefined) return;
    const last = worker.buckets.pop();
    bucket.heapIndex = undefined;
    bucket.heapWorker = undefined;
    if (!last || last === bucket) return;
    worker.buckets[index] = last;
    last.heapIndex = index;
    fixHeapItem(worker, index);
  };

  const syncBucketHeap = (bucket: BucketStateInternal): void => {
    const head = bucket.waiters[0];
    const shouldBeIndexed = head !== undefined && bucket.running < bucket.limit;
    const targetWorker = shouldBeIndexed ? head.workerState : undefined;
    if (bucket.heapWorker && bucket.heapWorker !== targetWorker)
      removeFromHeap(bucket, bucket.heapWorker);
    if (!targetWorker) return;
    if (bucket.heapIndex === undefined) {
      bucket.heapWorker = targetWorker;
      bucket.heapIndex = targetWorker.buckets.length;
      targetWorker.buckets.push(bucket);
      bubbleUp(targetWorker, bucket.heapIndex);
      return;
    }
    fixHeapItem(targetWorker, bucket.heapIndex);
  };

  const updateBucketLimit = (bucket: BucketStateInternal): void => {
    bucket.limit = readBucketLimit(bucket.bucket);
    syncBucketHeap(bucket);
  };

  const updateAllBucketLimits = (): void => {
    for (const bucket of Array.from(buckets.values()))
      updateBucketLimit(bucket);
  };

  const makeEntry = (
    ticketId: string,
    bucketState: BucketStateInternal,
    workerState: WorkerState,
    queuedAt: number,
    onGranted: (lease: DelegationAdmissionLease) => void,
  ): AdmissionEntry => {
    sequence += 1;
    return {
      ticketId,
      bucketState,
      workerState,
      queuedAt,
      sequence,
      onGranted,
      status: 'waiting',
      ticket: undefined,
    };
  };

  const positionOf = (
    entry: AdmissionEntry,
  ): DelegationAdmissionPosition | undefined => {
    if (entry.status !== 'waiting') return undefined;
    const ownBucket = entry.bucketState;
    if (ownBucket.running >= ownBucket.limit) {
      const ownIndex = ownBucket.waiters.indexOf(entry);
      if (ownIndex < 0) return undefined;
      return { position: ownIndex + 1, waitingFor: 'queue' };
    }
    let ahead = 0;
    for (const bucket of Array.from(buckets.values())) {
      if (bucket.running >= bucket.limit) continue;
      for (const waiter of bucket.waiters) {
        if (
          waiter.workerState === entry.workerState &&
          compareEntries(waiter, entry) < 0
        ) {
          ahead += 1;
        }
      }
    }
    return { position: ahead + 1, waitingFor: 'app' };
  };

  const cancelWaitingEntry = (entry: AdmissionEntry): void => {
    if (entry.status !== 'waiting') return;
    const waiters = entry.bucketState.waiters;
    const index = waiters.indexOf(entry);
    if (index < 0) return;
    waiters.splice(index, 1);
    entry.status = 'done';
    waitingCount -= 1;
    tickets.delete(entry.ticketId);
    updateAllBucketLimits();
    requestPump();
  };

  const makeTicket = (entry: AdmissionEntry): DelegationAdmissionTicket => {
    const ticket: DelegationAdmissionTicket = {
      ticketId: entry.ticketId,
      cancel: (): void => withInvocation(() => cancelWaitingEntry(entry)),
      position: (): DelegationAdmissionPosition | undefined =>
        positionOf(entry),
    };
    return ticket;
  };

  const enqueue = (entry: AdmissionEntry): DelegationAdmissionTicket => {
    const waiters = entry.bucketState.waiters;
    let insertionIndex = waiters.length;
    while (insertionIndex > 0) {
      const previous = waiters[insertionIndex - 1];
      if (!previous || compareEntries(entry, previous) >= 0) break;
      insertionIndex -= 1;
    }
    waiters.splice(insertionIndex, 0, entry);
    entry.status = 'waiting';
    waitingCount += 1;
    entry.ticket = makeTicket(entry);
    tickets.set(entry.ticketId, entry);
    syncBucketHeap(entry.bucketState);
    return entry.ticket;
  };

  const activate = (entry: AdmissionEntry): DelegationAdmissionLease => {
    entry.status = 'active';
    entry.bucketState.running += 1;
    entry.workerState.running += 1;
    activeCount += 1;
    tickets.set(entry.ticketId, entry);
    syncBucketHeap(entry.bucketState);
    return makeLease(entry);
  };

  const finishActive = (entry: AdmissionEntry): void => {
    if (entry.status !== 'active') return;
    entry.status = 'done';
    tickets.delete(entry.ticketId);
    entry.bucketState.running -= 1;
    entry.workerState.running -= 1;
    activeCount -= 1;
    syncBucketHeap(entry.bucketState);
  };

  const queueCapacityAvailable = (bucket: BucketStateInternal): boolean =>
    bucket.waiters.length < DELEGATION_ADMISSION_LIMITS.waitingPerBucket &&
    waitingCount < DELEGATION_ADMISSION_LIMITS.waitingPerApplication;

  const findGrantableHead = (): AdmissionEntry | undefined => {
    let oldest: AdmissionEntry | undefined;
    for (const worker of Array.from(workers.values())) {
      if (worker.running >= readHostCapacity(worker.workerId)) continue;
      const headBucket = worker.buckets[0];
      const head = headBucket?.waiters[0];
      if (head && (!oldest || compareEntries(head, oldest) < 0)) oldest = head;
    }
    return oldest;
  };

  const pump = (): void => {
    let next = findGrantableHead();
    while (next) {
      const entry = next;
      const bucket = entry.bucketState;
      const index = bucket.waiters.indexOf(entry);
      if (index < 0) {
        syncBucketHeap(bucket);
        next = findGrantableHead();
        continue;
      }
      bucket.waiters.splice(index, 1);
      waitingCount -= 1;
      const lease = activate(entry);
      scheduleSafely(() => entry.onGranted(lease));
      next = findGrantableHead();
    }
  };

  function requestPump(): void {
    if (pumpPending) return;
    pumpPending = true;
    scheduleSafely(() => {
      pumpPending = false;
      pump();
    });
  }

  const makeLease = (entry: AdmissionEntry): DelegationAdmissionLease => {
    let consumed = false;
    const lease: DelegationAdmissionLease = {
      ticketId: entry.ticketId,
      release: (): void =>
        withInvocation(() => {
          if (consumed) return;
          consumed = true;
          if (entry.status !== 'active') return;
          finishActive(entry);
          updateAllBucketLimits();
          requestPump();
        }),
      transfer: (next: {
        readonly ticketId: string;
        readonly queuedAt: number;
        readonly onGranted: (lease: DelegationAdmissionLease) => void;
      }): DelegationAdmissionDecision =>
        withInvocation(() => {
          if (consumed || entry.status !== 'active')
            throw new Error('Admission lease is no longer active');
          if (tickets.has(next.ticketId))
            throw new Error(`Duplicate admission ticket: ${next.ticketId}`);
          updateBucketLimit(entry.bucketState);
          consumed = true;
          if (entry.bucketState.running <= entry.bucketState.limit) {
            tickets.delete(entry.ticketId);
            entry.status = 'done';
            const transferred = makeEntry(
              next.ticketId,
              entry.bucketState,
              entry.workerState,
              next.queuedAt,
              next.onGranted,
            );
            transferred.status = 'active';
            tickets.set(transferred.ticketId, transferred);
            const transferredLease = makeLease(transferred);
            syncBucketHeap(entry.bucketState);
            requestPump();
            return { kind: 'granted', lease: transferredLease };
          }
          finishActive(entry);
          const transferred = makeEntry(
            next.ticketId,
            entry.bucketState,
            entry.workerState,
            next.queuedAt,
            next.onGranted,
          );
          if (!queueCapacityAvailable(entry.bucketState)) {
            updateAllBucketLimits();
            requestPump();
            return { kind: 'rejected', reason: 'queue_full' };
          }
          const ticket = enqueue(transferred);
          updateAllBucketLimits();
          requestPump();
          return { kind: 'waiting', ticket };
        }),
    };
    return lease;
  };

  const request = (
    requestValue: DelegationAdmissionRequest,
  ): DelegationAdmissionDecision =>
    withInvocation(() => {
      if (tickets.has(requestValue.ticketId))
        throw new Error(`Duplicate admission ticket: ${requestValue.ticketId}`);
      const bucket = getOrCreateBucket(requestValue.bucket);
      const worker = getOrCreateWorker(
        requestValue.workerId ?? LOCAL_WORKER_ID,
      );
      const entry = makeEntry(
        requestValue.ticketId,
        bucket,
        worker,
        requestValue.queuedAt,
        requestValue.onGranted,
      );
      const head = worker.buckets[0]?.waiters[0];
      const priorInBucket = bucket.waiters[0];
      const hasEarlierWaiter =
        (priorInBucket !== undefined &&
          compareEntries(priorInBucket, entry) < 0) ||
        (head !== undefined && compareEntries(head, entry) < 0);
      if (
        bucket.running < bucket.limit &&
        worker.running < readHostCapacity(worker.workerId) &&
        !hasEarlierWaiter
      ) {
        return { kind: 'granted', lease: activate(entry) };
      }
      if (requestValue.ifBusy === 'reject')
        return { kind: 'rejected', reason: 'busy' };
      if (!queueCapacityAvailable(bucket))
        return { kind: 'rejected', reason: 'queue_full' };
      const ticket = enqueue(entry);
      return { kind: 'waiting', ticket };
    });

  const bucketState = (
    bucket: DelegationAdmissionBucket,
  ): DelegationAdmissionBucketState => {
    const state = getOrCreateBucket(bucket);
    return {
      running: state.running,
      waiting: state.waiters.length,
      limit: state.limit,
    };
  };

  const refresh = (): void =>
    withInvocation(() => {
      updateAllBucketLimits();
      requestPump();
    });

  const controller: DelegationAdmissionController = {
    request,
    bucketState,
    refresh,
    get activeCount(): number {
      return activeCount;
    },
    get waitingCount(): number {
      return waitingCount;
    },
  };
  return controller;
}
