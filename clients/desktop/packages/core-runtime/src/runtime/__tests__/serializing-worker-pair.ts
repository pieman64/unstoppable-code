import {
  CanopyJsonRpcMessageSchema,
  CanopyJsonValueSchema,
  type CanopyJsonRpcMessage,
} from '@canopy/protocol/canopy-core';
import { canopyUnavailableError } from '../errors';
import type { WorkerBindingConnection } from '../in-process-worker-binding';

interface SerializingConnection extends WorkerBindingConnection {
  send: jest.Mock<Promise<void>, [CanopyJsonRpcMessage]>;
}
interface SerializingPair {
  client: SerializingConnection;
  server: SerializingConnection;
}

/** Test host adapter: each send validates and serializes the whole envelope. */
export function serializingWorkerPair(): SerializingPair {
  const controller = new AbortController();
  const queues: CanopyJsonRpcMessage[][] = [[], []];
  const listeners: Array<
    ((message: CanopyJsonRpcMessage) => void) | undefined
  > = [];
  const rejects: Array<((error: Error) => void) | undefined> = [];
  const close = (): void => {
    if (controller.signal.aborted) return;
    controller.abort();
    for (const reject of rejects) reject?.(canopyUnavailableError());
  };
  const endpoint = (index: number): SerializingConnection => ({
    signal: controller.signal,
    close,
    send: jest.fn(
      (message: CanopyJsonRpcMessage): Promise<void> =>
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw canopyUnavailableError();
          CanopyJsonValueSchema.parse(message);
          const decoded = CanopyJsonRpcMessageSchema.parse(
            JSON.parse(JSON.stringify(message)),
          );
          const peer = 1 - index;
          const listener = listeners[peer];
          if (listener) {
            listeners[peer] = undefined;
            rejects[peer] = undefined;
            listener(decoded);
          } else queues[peer].push(decoded);
        }),
    ),
    receive: (): Promise<CanopyJsonRpcMessage> => {
      if (controller.signal.aborted)
        return Promise.reject(canopyUnavailableError());
      const queued = queues[index].shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        listeners[index] = resolve;
        rejects[index] = reject;
      });
    },
  });
  return { client: endpoint(0), server: endpoint(1) };
}
