import type {
  WORKER_CODE_GRAPH_STREAM_DEFINITIONS,
  WorkerCodeGraphBuildQueue,
} from '@canopy/protocol/canopy-core';

import type { CanopyDispatcherStreamHandlerMap } from '../../runtime/types';

/*
 * `worker.codeGraph.buildQueue.events` (CAN-5628): a host's generation queue
 * after every change, and the current queue when a stream opens. Closing a
 * stream only unsubscribes; it never cancels builds.
 */

/** The queue and its change signal, as a host's build scheduler offers them. */
export interface CodeGraphBuildQueueEventSource {
  queue(): WorkerCodeGraphBuildQueue;
  /** Calls `listener` after every queue change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export interface WorkerCodeGraphQueueStreamHandlers {
  streams: CanopyDispatcherStreamHandlerMap<
    typeof WORKER_CODE_GRAPH_STREAM_DEFINITIONS
  >;
}

/** `worker.codeGraph.buildQueue.events` over one host's queue (CAN-5628). */
export function createWorkerCodeGraphQueueStreamHandlers(
  source: CodeGraphBuildQueueEventSource,
): WorkerCodeGraphQueueStreamHandlers {
  return {
    streams: {
      'worker.codeGraph.buildQueue.events': (
        _params,
        _context,
        sink,
      ): Promise<(() => void) | void> => {
        if (sink.emit({ queue: source.queue() }) === null)
          return Promise.resolve();
        let unsubscribe = (): void => undefined;
        unsubscribe = source.subscribe((): void => {
          // The sink refuses items once the stream has ended, including when
          // a slow client overflows its buffer.
          if (sink.emit({ queue: source.queue() }) === null) unsubscribe();
        });
        return Promise.resolve(unsubscribe);
      },
    },
  };
}

/** Fans one scheduler queue listener out to any number of subscribers. */
export function createCodeGraphQueueListeners(): {
  notify(): void;
  subscribe(listener: () => void): () => void;
} {
  const listeners = new Set<() => void>();
  return {
    notify: (): void => {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // A failing subscriber never stops the others or the scheduler.
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };
}
