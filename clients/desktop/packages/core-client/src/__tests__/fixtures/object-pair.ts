import type {
  CanopyByteChannel,
  CanopyFramedConnection,
} from '@canopy/core-transport/types';
import type {
  CanopyErrorPayload,
  CanopyJsonRpcMessage,
} from '@canopy/protocol/canopy-core';

class ObjectPairError extends Error {
  constructor(readonly payload: CanopyErrorPayload) {
    super(payload.message);
  }
}

const failure = (
  kind: CanopyErrorPayload['kind'],
  message: string,
): ObjectPairError =>
  new ObjectPairError({ kind, message, retry: { kind: 'never' } });

type Waiter = (outcome: CanopyJsonRpcMessage | ObjectPairError) => void;

/**
 * One end of a framed pair that hands message objects to its peer by
 * reference: no codec, so large padded frames cost no copies in transit.
 */
class ObjectEnd implements CanopyFramedConnection {
  readonly signal: AbortSignal;
  peer: ObjectEnd | null = null;
  private readonly controller = new AbortController();
  private readonly inbox: CanopyJsonRpcMessage[] = [];
  private readonly waiters = new Set<Waiter>();
  private closeError = failure('unavailable', 'The connection closed.');

  constructor(readonly connectionId: string) {
    this.signal = this.controller.signal;
  }

  send(message: CanopyJsonRpcMessage): Promise<void> {
    if (this.signal.aborted) return Promise.reject(this.closeError);
    this.peer?.deliver(message);
    return Promise.resolve();
  }

  receive(options?: {
    readonly signal?: AbortSignal;
  }): Promise<CanopyJsonRpcMessage> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    if (this.signal.aborted) return Promise.reject(this.closeError);
    const signal = options?.signal;
    if (signal?.aborted)
      return Promise.reject(failure('cancelled', 'The receive was cancelled.'));
    return new Promise((resolve, reject) => {
      const settle: Waiter = (outcome) => {
        this.waiters.delete(settle);
        signal?.removeEventListener('abort', onAbort);
        if (outcome instanceof ObjectPairError) reject(outcome);
        else resolve(outcome);
      };
      const onAbort = (): void =>
        settle(failure('cancelled', 'The receive was cancelled.'));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(settle);
    });
  }

  openChannel(): Promise<CanopyByteChannel> {
    return Promise.reject(
      failure('capability_unavailable', 'Object pairs carry no channels.'),
    );
  }

  onChannel(): () => void {
    return () => {};
  }

  /** Closes both ends; pending and later receives reject with the reason. */
  close(error?: CanopyErrorPayload): void {
    if (this.signal.aborted) return;
    if (error) this.closeError = new ObjectPairError(error);
    this.inbox.length = 0;
    this.controller.abort(this.closeError);
    Array.from(this.waiters).forEach((settle) => settle(this.closeError));
    this.peer?.close(error);
  }

  private deliver(message: CanopyJsonRpcMessage): void {
    if (this.signal.aborted) return;
    const settle = this.waiters.values().next().value;
    if (settle) settle(message);
    else this.inbox.push(message);
  }
}

export interface ObjectFramedPair {
  readonly client: CanopyFramedConnection;
  readonly server: CanopyFramedConnection;
  close(): void;
}

export function createObjectFramedPair(): ObjectFramedPair {
  const client = new ObjectEnd('object-pair-client');
  const server = new ObjectEnd('object-pair-server');
  client.peer = server;
  server.peer = client;
  return { client, server, close: () => client.close() };
}
