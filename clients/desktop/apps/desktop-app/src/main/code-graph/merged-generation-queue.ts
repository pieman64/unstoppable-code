import { randomUUID } from 'node:crypto';
import { CanopyClientError } from '@canopy/core-client';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  codeGraphQueueChangedError,
  codeGraphQueueItemNotFoundError,
  codeGraphQueueOrderInvalidError,
  codeGraphQueueUnavailableError,
  createCodeGraphBuildQueueWorker,
  type CodeGraphBuildQueueWorker,
} from '@canopy/core-runtime/node/code-graph';
import {
  WORKER_CODE_GRAPH_QUEUE_MAX_ITEMS,
  type WorkerCodeGraphBuildCancelResult,
  type WorkerCodeGraphBuildQueue,
  type WorkerCodeGraphQueueItem,
} from '@canopy/protocol/canopy-core';
import {
  getDaemonCodeGraphQueue,
  type DaemonCodeGraphQueueSource,
} from '../canopy-runtime/daemon-code-graph-queue';
import { daemonUnreachableReason } from '../canopy-runtime/electron-daemon-connection';
import {
  cancelCodeGraphQueueItem,
  getCodeGraphBuildQueueStatus,
  reorderCodeGraphGenerationQueue,
  setCodeGraphGenerationQueueListener,
} from './build-runner';

/*
 * Electron main's one generation queue across both graph hosts (CAN-5628):
 * its own scheduler, which still runs workspace base and fallback builds,
 * and the daemon's, which it follows on the code-graph session it already
 * holds. Running items come first (both hosts, by start time, the daemon's
 * first on a tie), then the daemon's queued items in its order, then
 * Electron main's. The revision is a counter that moves whenever either
 * half's revision changes or the daemon half attaches or detaches. A reorder
 * applies each host's items in the requested order, daemon first; the two
 * schedulers cannot commit together, so a later refusal after an earlier
 * success answers `queueChanged` and leaves the applied order in place.
 */

/** Electron main's own half: its scheduler's queue and controls. */
export interface LocalGenerationQueue {
  queue(): WorkerCodeGraphBuildQueue;
  reorder: CodeGraphBuildQueueWorker['reorder'];
  cancel: CodeGraphBuildQueueWorker['cancel'];
}
export interface MergedGenerationQueue {
  /** Both hosts' queues as one revisioned queue (CAN-5628). */
  queue(): WorkerCodeGraphBuildQueue;
  /** Throws `codeGraphQueueChangedError` or `codeGraphQueueOrderInvalidError`. */
  reorder(
    expectedRevision: number,
    orderedQueueItemIds: readonly string[],
  ): Promise<WorkerCodeGraphBuildQueue>;
  /** Throws `codeGraphQueueItemNotFoundError` or `codeGraphQueueUnavailableError`. */
  cancel(queueItemId: string): Promise<WorkerCodeGraphBuildCancelResult>;
  /** Electron main's scheduler changed its queue. */
  noteLocalChange(): void;
  /** Called with the merged queue whenever its revision changes. */
  subscribe(listener: (queue: WorkerCodeGraphBuildQueue) => void): () => void;
}

type Host = 'local' | 'daemon';

interface MergedView {
  readonly queue: WorkerCodeGraphBuildQueue;
  readonly local: WorkerCodeGraphBuildQueue;
  readonly daemon: WorkerCodeGraphBuildQueue | null;
  readonly owner: ReadonlyMap<string, Host>;
  /** Queued ids the item cap cut from the view, per host, in host order. */
  readonly cut: Readonly<Record<Host, readonly string[]>>;
}

const queuedIds = (queue: WorkerCodeGraphBuildQueue): string[] =>
  queue.items
    .filter((item) => item.state === 'queued')
    .map((item) => item.queueItemId);

const sameOrder = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((id, index) => id === right[index]);

/** A daemon item's timing as of `now`, as Electron main times its own. */
function retimed(
  item: WorkerCodeGraphQueueItem,
  now: number,
): WorkerCodeGraphQueueItem {
  const enqueuedAt = Date.parse(item.enqueuedAt);
  const startedAt = item.startedAt === null ? null : Date.parse(item.startedAt);
  return {
    ...item,
    timing: {
      queueWaitMs: Math.max(0, (startedAt ?? now) - enqueuedAt),
      runningMs: startedAt === null ? null : Math.max(0, now - startedAt),
    },
  };
}

export function createMergedGenerationQueue(input: {
  local: LocalGenerationQueue;
  daemon: DaemonCodeGraphQueueSource;
  now?: () => number;
}): MergedGenerationQueue {
  const now = input.now ?? Date.now;
  const listeners = new Set<(queue: WorkerCodeGraphBuildQueue) => void>();
  let revision = 0;
  let changeKey: string | null = null;
  let notifiedRevision: number | null = null;
  // The daemon's items when its queue was last attached; while detached,
  // controls for them answer queueUnavailable rather than reaching local.
  let daemonIds: ReadonlySet<string> = new Set();

  const view = (): MergedView => {
    const local = input.local.queue();
    const daemon = input.daemon.current();
    if (daemon !== null)
      daemonIds = new Set(daemon.items.map((item) => item.queueItemId));
    const key = `${local.revision}:${daemon === null ? 'none' : daemon.revision}`;
    if (key !== changeKey) {
      changeKey = key;
      revision += 1;
    }
    const at = now();
    const owner = new Map<string, Host>();
    const daemonItems = (daemon?.items ?? []).map((item) => {
      owner.set(item.queueItemId, 'daemon');
      return retimed(item, at);
    });
    for (const item of local.items) owner.set(item.queueItemId, 'local');
    const running = [
      ...daemonItems.filter((item) => item.state === 'running'),
      ...local.items.filter((item) => item.state === 'running'),
    ];
    // A stable sort keeps the daemon's running items first on a tie.
    running.sort(
      (left, right) =>
        Date.parse(left.startedAt ?? left.enqueuedAt) -
        Date.parse(right.startedAt ?? right.enqueuedAt),
    );
    const queued = [
      ...daemonItems.filter((item) => item.state === 'queued'),
      ...local.items.filter((item) => item.state === 'queued'),
    ];
    const items = [...running, ...queued];
    const kept = items.slice(0, WORKER_CODE_GRAPH_QUEUE_MAX_ITEMS);
    const cut: Record<Host, string[]> = { local: [], daemon: [] };
    for (const item of items.slice(WORKER_CODE_GRAPH_QUEUE_MAX_ITEMS))
      if (item.state === 'queued')
        cut[owner.get(item.queueItemId) ?? 'local'].push(item.queueItemId);
    return {
      queue: { revision, items: kept },
      local,
      daemon,
      owner,
      cut,
    };
  };

  const publish = (): void => {
    const { queue } = view();
    if (queue.revision === notifiedRevision) return;
    notifiedRevision = queue.revision;
    for (const listener of Array.from(listeners)) {
      try {
        listener(queue);
      } catch {
        // A failing subscriber never stops delivery to the others.
      }
    }
  };

  const reorderDaemon = async (
    daemon: WorkerCodeGraphBuildQueue,
    ordered: readonly string[],
  ): Promise<void> => {
    const client = input.daemon.client();
    if (client === null) throw codeGraphQueueChangedError();
    let reordered: WorkerCodeGraphBuildQueue;
    try {
      reordered = await client.instruction(
        'worker.codeGraph.buildQueue.update',
        {
          expectedRevision: daemon.revision,
          orderedQueueItemIds: [...ordered],
        },
        { metadata: { idempotencyKey: randomUUID() } },
      );
    } catch (error) {
      // A connection that dropped under the request fails it untagged.
      if (daemonUnreachableReason(error) !== null || client.signal.aborted)
        throw codeGraphQueueChangedError();
      if (!(error instanceof CanopyClientError)) throw error;
      if (
        error.payload.code === 'worker.codeGraph.queueChanged' ||
        error.payload.code === 'worker.codeGraph.queueOrderInvalid'
      )
        throw codeGraphQueueChangedError();
      throw new CanopyOperationError(error.payload, error);
    }
    // A daemon half that detached meanwhile no longer holds what was asked.
    if (input.daemon.client() !== client) throw codeGraphQueueChangedError();
    input.daemon.note(reordered);
  };

  input.daemon.subscribe(publish);

  return {
    queue: () => view().queue,
    async reorder(expectedRevision, orderedQueueItemIds) {
      const current = view();
      if (expectedRevision !== current.queue.revision)
        throw codeGraphQueueChangedError();
      const visible = queuedIds(current.queue);
      if (
        new Set(orderedQueueItemIds).size !== orderedQueueItemIds.length ||
        orderedQueueItemIds.length !== visible.length ||
        !visible.every((id) => orderedQueueItemIds.includes(id))
      )
        throw codeGraphQueueOrderInvalidError();
      const split: Record<Host, string[]> = { local: [], daemon: [] };
      for (const id of orderedQueueItemIds)
        split[current.owner.get(id) ?? 'local'].push(id);
      split.daemon.push(...current.cut.daemon);
      split.local.push(...current.cut.local);
      if (
        current.daemon !== null &&
        !sameOrder(split.daemon, queuedIds(current.daemon))
      )
        await reorderDaemon(current.daemon, split.daemon);
      if (!sameOrder(split.local, queuedIds(current.local))) {
        const outcome = input.local.reorder(
          current.local.revision,
          split.local,
        );
        if (!outcome.ok)
          throw outcome.refusal === 'changed'
            ? codeGraphQueueChangedError(outcome.message)
            : codeGraphQueueOrderInvalidError(outcome.message);
      }
      return view().queue;
    },
    async cancel(queueItemId) {
      const current = view();
      const owner =
        current.owner.get(queueItemId) ??
        (current.daemon === null && daemonIds.has(queueItemId)
          ? 'daemon'
          : 'local');
      if (owner === 'daemon') {
        const client = input.daemon.client();
        if (client === null) throw codeGraphQueueUnavailableError();
        try {
          return await client.instruction(
            'worker.codeGraph.build.cancel',
            { queueItemId },
            { metadata: { idempotencyKey: randomUUID() } },
          );
        } catch (error) {
          if (daemonUnreachableReason(error) !== null || client.signal.aborted)
            throw codeGraphQueueUnavailableError(error);
          if (error instanceof CanopyClientError)
            throw new CanopyOperationError(error.payload, error);
          throw error;
        }
      }
      const canceled = await input.local.cancel(queueItemId);
      if (canceled === null) throw codeGraphQueueItemNotFoundError();
      return canceled;
    },
    noteLocalChange: publish,
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

let desktop: MergedGenerationQueue | undefined;

/** Electron main's one merged queue, over its build runner and the daemon source. */
export function getDesktopGenerationQueue(): MergedGenerationQueue {
  if (desktop) return desktop;
  // Only the queue, reorder and cancel of the local half are used.
  const local = createCodeGraphBuildQueueWorker({
    queueStatus: getCodeGraphBuildQueueStatus,
    reorderQueue: reorderCodeGraphGenerationQueue,
    cancelQueueItem: cancelCodeGraphQueueItem,
    build: () => Promise.reject(codeGraphQueueUnavailableError()),
    cancelWorktree: () => Promise.reject(codeGraphQueueUnavailableError()),
  });
  const merged = createMergedGenerationQueue({
    local,
    daemon: getDaemonCodeGraphQueue(),
  });
  setCodeGraphGenerationQueueListener(() => merged.noteLocalChange());
  desktop = merged;
  return merged;
}
