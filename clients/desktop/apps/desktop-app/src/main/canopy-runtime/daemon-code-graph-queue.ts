import type { CanopyClientStreamHandle } from '@canopy/core-client';
import type {
  WorkerCodeGraphBuildCancelParams,
  WorkerCodeGraphBuildCancelResult,
  WorkerCodeGraphBuildQueue,
  WorkerCodeGraphBuildQueueEventsItem,
  WorkerCodeGraphBuildQueueUpdateParams,
} from '@canopy/protocol/canopy-core';

/*
 * The daemon's half of Electron main's merged generation queue (CAN-5628).
 * It rides the code-graph session Electron main already holds and never
 * opens, leases or starts one, so it never keeps a daemon alive (CAN-5690's
 * rule). While that session is live it follows
 * `worker.codeGraph.buildQueue.events` on its connection. A daemon that does
 * not serve the stream (an older build) refuses it, and that connection is
 * not asked again; neither is one whose stream ended. With no stream the
 * daemon queue is null and the merged view shows Electron main's alone.
 */

/** The stream and queue controls the source uses, on a daemon session's connection. */
interface QueueClient {
  readonly signal: AbortSignal;
  openStream(
    name: 'worker.codeGraph.buildQueue.events',
    params: { cursor: null },
  ): Promise<
    CanopyClientStreamHandle<WorkerCodeGraphBuildQueueEventsItem, unknown>
  >;
  instruction(
    name: 'worker.codeGraph.buildQueue.update',
    params: WorkerCodeGraphBuildQueueUpdateParams,
    options: { metadata: { idempotencyKey: string } },
  ): Promise<WorkerCodeGraphBuildQueue>;
  instruction(
    name: 'worker.codeGraph.build.cancel',
    params: WorkerCodeGraphBuildCancelParams,
    options: { metadata: { idempotencyKey: string } },
  ): Promise<WorkerCodeGraphBuildCancelResult>;
}
export interface DaemonCodeGraphQueueSession {
  readonly client: QueueClient;
  readonly lease: { readonly state: string };
}
export interface DaemonCodeGraphQueueSource {
  /** Notes a live session; never opens one. */
  observe(session: DaemonCodeGraphQueueSession): void;
  /** The daemon's last queue while its stream is open, otherwise null. */
  current(): WorkerCodeGraphBuildQueue | null;
  /** The attached connection, for reorder and cancel; null while detached. */
  client(): QueueClient | null;
  /** Takes a queue an instruction answered with, ahead of the stream. */
  note(queue: WorkerCodeGraphBuildQueue): void;
  subscribe(listener: () => void): () => void;
  close(): void;
}

export function createDaemonCodeGraphQueueSource(): DaemonCodeGraphQueueSource {
  const sessions = new Set<DaemonCodeGraphQueueSession>();
  const listeners = new Set<() => void>();
  // Connections whose daemon refused or ended the stream.
  const settled = new WeakSet<QueueClient>();
  let attached: { client: QueueClient; close(): void } | null = null;
  let opening: QueueClient | null = null;
  let queue: WorkerCodeGraphBuildQueue | null = null;
  let closed = false;

  const notify = (): void => {
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch {
        // A failing listener never stops delivery to the others.
      }
    }
  };

  const take = (next: WorkerCodeGraphBuildQueue): void => {
    if (queue !== null && next.revision <= queue.revision) return;
    queue = next;
    notify();
  };

  /** The session's live connection, or null; forgets an ended session. */
  const liveClient = (
    session: DaemonCodeGraphQueueSession,
  ): QueueClient | null => {
    try {
      const { state } = session.lease;
      if (state === 'failed' || state === 'released') {
        sessions.delete(session);
        return null;
      }
      if (state !== 'active') return null;
      const { client } = session;
      return client.signal.aborted || settled.has(client) ? null : client;
    } catch {
      sessions.delete(session);
      return null;
    }
  };

  const detach = (client: QueueClient): void => {
    if (attached?.client !== client) return;
    const current = attached;
    attached = null;
    current.close();
    queue = null;
    notify();
    ensure();
  };

  const open = (client: QueueClient): void => {
    opening = client;
    void client
      .openStream('worker.codeGraph.buildQueue.events', { cursor: null })
      .then(
        (handle) => {
          opening = null;
          if (closed || client.signal.aborted) {
            handle.close();
            if (!closed) ensure();
            return;
          }
          // A dropped connection ends the stream without an end frame.
          const lost = (): void => detach(client);
          client.signal.addEventListener('abort', lost, { once: true });
          let unsubscribe = (): void => undefined;
          attached = {
            client,
            close: (): void => {
              client.signal.removeEventListener('abort', lost);
              unsubscribe();
              handle.close();
            },
          };
          // A new connection may be a restarted daemon whose revisions
          // start again, so its first queue replaces whatever came before.
          queue = null;
          unsubscribe = handle.onFrame((frame) => {
            if (attached?.client !== client) return;
            if (frame.kind === 'item') {
              take(frame.item.queue);
              return;
            }
            settled.add(client);
            detach(client);
          });
        },
        () => {
          opening = null;
          if (!client.signal.aborted) settled.add(client);
          ensure();
        },
      );
  };

  function ensure(): void {
    if (closed || opening) return;
    if (attached) {
      if (!attached.client.signal.aborted) return;
      detach(attached.client);
    }
    for (const session of Array.from(sessions)) {
      const client = liveClient(session);
      if (!client) continue;
      open(client);
      return;
    }
  }

  return {
    observe(session): void {
      if (closed) return;
      sessions.add(session);
      ensure();
    },
    current: () => (attached === null ? null : queue),
    client: () => attached?.client ?? null,
    note(next): void {
      if (attached === null) return;
      take(next);
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close(): void {
      closed = true;
      sessions.clear();
      const current = attached;
      attached = null;
      current?.close();
      queue = null;
      listeners.clear();
    },
  };
}

let source: DaemonCodeGraphQueueSource | undefined;

/** Electron main's one source. */
export function getDaemonCodeGraphQueue(): DaemonCodeGraphQueueSource {
  source ??= createDaemonCodeGraphQueueSource();
  return source;
}
