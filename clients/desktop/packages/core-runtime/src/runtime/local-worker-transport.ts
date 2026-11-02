import type {
  CanopyCallerDescriptor,
  CanopyInstructionDefinitionMap,
  CanopyRequestMetadata,
} from '@canopy/protocol/canopy-core';

import type { CanopyDispatcher } from './types';
import type {
  WorkerExecutorReceipt,
  WorkerExecutorReceipts,
} from './worker-executor-receipts';

/**
 * How the core reaches the builtin local worker (`in_process_worker`): the
 * daemon's bundled binding over its serialized pair, or the desktop's direct
 * call into the worker handlers on its own dispatcher. Dispatch records do
 * not depend on which one carries the work.
 */
export interface LocalWorkerTransport {
  /** The worker instructions this transport carries. */
  readonly instructions: CanopyInstructionDefinitionMap;
  instruction(
    name: string,
    params: unknown,
    options: { metadata?: CanopyRequestMetadata; signal?: AbortSignal },
  ): Promise<unknown>;
  /**
   * How a keyed instruction the worker was sent settled, waiting for a
   * running one; null when the worker never received it. Never sends it
   * again.
   */
  receipt(
    operation: string,
    idempotencyKey: string,
  ): Promise<WorkerExecutorReceipt | null>;
  /** The core recorded the outcome; the worker may forget its receipt. */
  releaseReceipt(operation: string, idempotencyKey: string): void;
}

/**
 * The direct transport for a host whose single dispatcher holds the worker
 * handlers too (Electron main). The worker caller is the trusted owning core;
 * the receipts must be the ones wrapping those handlers.
 */
export function createDirectLocalWorkerTransport(options: {
  dispatcher: Pick<CanopyDispatcher, 'instruction'>;
  instructions: CanopyInstructionDefinitionMap;
  caller: CanopyCallerDescriptor;
  receipts: WorkerExecutorReceipts;
}): LocalWorkerTransport {
  const { dispatcher, caller, receipts } = options;
  return {
    instructions: options.instructions,
    instruction: (name, params, { metadata, signal }) =>
      dispatcher.instruction(name, params, { caller, metadata, signal }),
    receipt: (operation, idempotencyKey) =>
      receipts.settled(caller.principalId, operation, idempotencyKey),
    releaseReceipt: (operation, idempotencyKey): void =>
      receipts.release(caller.principalId, operation, idempotencyKey),
  };
}
