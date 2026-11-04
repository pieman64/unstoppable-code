import type {
  CanopyCallerDescriptor,
  CanopyInstructionDefinitionMap,
} from '@canopy/protocol/canopy-core';
import type { CanopyDispatcher } from './types';
import type { LocalWorkerTransport } from './local-worker-transport';
import type { WorkerExecutorReceipts } from './worker-executor-receipts';
import { CanopyOperationError, canopyUnavailableError } from './errors';
import {
  connectLocalWorkerBinding,
  type LocalWorkerBindingClient,
} from './local-worker-binding-client';
import { serveLocalWorkerBinding } from './local-worker-binding-server';
import type {
  WorkerBindingDefinitions,
  WorkerBindingPair,
} from './local-worker-binding-wire';

export type {
  WorkerBindingConnection,
  WorkerBindingDefinitions,
  WorkerBindingPair,
} from './local-worker-binding-wire';
export type { InProcessWorkerBindingForwarders } from './local-worker-binding-client';

/** Both halves of a local worker binding in one process. */
export type InProcessWorkerBinding = Omit<LocalWorkerBindingClient, 'close'> & {
  close(): void;
};

export interface CreateInProcessWorkerBindingOptions {
  readonly dispatcher: CanopyDispatcher;
  /** The worker dispatcher's maps; the dispatcher exposes only its queries. */
  readonly definitions: WorkerBindingDefinitions;
  readonly caller: CanopyCallerDescriptor;
  readonly pair: WorkerBindingPair;
  /**
   * The worker's executor receipts, recorded by its wrapped instruction
   * handlers. Without them every receipt lookup answers that nothing arrived.
   */
  readonly receipts?: WorkerExecutorReceipts;
}

function stopReason(signal: AbortSignal): CanopyOperationError {
  const reason: unknown = signal.reason;
  return reason instanceof CanopyOperationError
    ? reason
    : canopyUnavailableError();
}

/**
 * Carries worker queries, instructions and streams over a host-injected
 * serializing pair: the worker half serves `pair.server` and the core half
 * drives `pair.client`, exactly as a separate worker process would. Both
 * sides check grants; either side stopping stops both with its reason.
 */
export function createInProcessWorkerBinding({
  dispatcher,
  definitions,
  caller,
  pair,
  receipts,
}: CreateInProcessWorkerBindingOptions): InProcessWorkerBinding {
  const server = serveLocalWorkerBinding({
    dispatcher,
    definitions,
    caller,
    connection: pair.server,
    ...(receipts && { receipts }),
  });
  const client = connectLocalWorkerBinding({
    definitions,
    caller,
    connection: pair.client,
  });
  const link = (
    from: AbortSignal,
    stop: (error: CanopyOperationError) => void,
  ): void => {
    if (from.aborted) stop(stopReason(from));
    else
      from.addEventListener('abort', () => stop(stopReason(from)), {
        once: true,
      });
  };
  link(server.signal, (error) => client.close(error));
  link(client.signal, (error) => server.close(error));
  return {
    forwarders: client.forwarders,
    signal: client.signal,
    query: (name, params, options) => client.query(name, params, options),
    instruction: (name, params, options) =>
      client.instruction(name, params, options),
    openStream: (name, params, options) =>
      client.openStream(name, params, options),
    receipt: (operation, key) => client.receipt(operation, key),
    releaseReceipt: (operation, key): void =>
      client.releaseReceipt(operation, key),
    close: (): void => client.close(canopyUnavailableError()),
  };
}

/** The core's dispatch transport over a local worker binding (CAN-4132). */
export function localWorkerTransportOf(
  binding: Pick<
    LocalWorkerBindingClient,
    'instruction' | 'receipt' | 'releaseReceipt'
  >,
  instructions: CanopyInstructionDefinitionMap,
): LocalWorkerTransport {
  return {
    instructions,
    instruction: (name, params, options) =>
      binding.instruction(name, params, options),
    receipt: (operation, key) => binding.receipt(operation, key),
    releaseReceipt: (operation, key): void =>
      binding.releaseReceipt(operation, key),
  };
}
