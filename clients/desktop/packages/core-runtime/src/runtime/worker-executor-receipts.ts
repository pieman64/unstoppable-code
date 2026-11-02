import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  safeParseCanopySchema,
  type CanopyErrorPayload,
  type CanopyInstructionDefinitionMap,
  type CanopyJsonValue,
} from '@canopy/protocol/canopy-core';

import { translateCanopyHandlerError } from './dispatcher';
import { canopyInvalidHandlerResultError } from './errors';
import type { CanopyHandlerContext } from './types';

/**
 * What the worker knows about one keyed instruction it received: still
 * running, or how its handler settled. The handler's own settlement, not the
 * reply the dispatcher sent, which a cancel or deadline can cut short.
 */
export type WorkerExecutorReceipt =
  | { state: 'running' }
  /** `result` is absent when it is not bounded JSON (32 KiB). */
  | { state: 'completed'; result?: CanopyJsonValue }
  | { state: 'failed'; error: CanopyErrorPayload };

/** A receipt that crossed the worker pair, or undefined when malformed. */
export function parseWorkerExecutorReceipt(
  value: unknown,
): WorkerExecutorReceipt | undefined {
  if (typeof value !== 'object' || value === null || !('state' in value))
    return undefined;
  if (value.state === 'running') return { state: 'running' };
  if (value.state === 'completed') {
    if (!('result' in value)) return { state: 'completed' };
    const result = CanopyJsonValueSchema.safeParse(value.result);
    return result.success
      ? { state: 'completed', result: result.data }
      : undefined;
  }
  if (value.state === 'failed' && 'error' in value) {
    const error = CanopyErrorPayloadSchema.safeParse(value.error);
    return error.success ? { state: 'failed', error: error.data } : undefined;
  }
  return undefined;
}

// Method-derived, so typed instruction handler maps widen without casts.
type InstructionHandler = {
  run(params: unknown, context: CanopyHandlerContext): unknown;
}['run'];

interface Entry {
  /** Resolves when the handler settles; the receipt is final from then on. */
  readonly settled: Promise<void>;
  receipt: WorkerExecutorReceipt;
}

/** Settled receipts the core has not released yet, beyond which the oldest go. */
export const WORKER_EXECUTOR_RECEIPTS_MAX = 4_096;

export interface WorkerExecutorReceipts {
  /**
   * Wraps the worker's instruction handlers. A keyed request is recorded
   * under its caller, operation and idempotency key before its handler runs.
   * Recording changes nothing about how the request runs: a repeated key
   * reaches its handler as before, and only the first is recorded.
   */
  wrap<H extends Readonly<Record<string, InstructionHandler>>>(
    handlers: H,
  ): Record<string, InstructionHandler>;
  /**
   * The receipt for a keyed request once its handler settles; null when the
   * worker never received it. Waits for a running handler.
   */
  settled(
    principalId: string,
    operation: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<WorkerExecutorReceipt | null>;
  /** The core recorded this outcome; the worker forgets it. */
  release(principalId: string, operation: string, idempotencyKey: string): void;
}

const keyOf = (principalId: string, operation: string, key: string): string =>
  JSON.stringify([principalId, operation, key]);

/**
 * The executor half of shared idempotency (`execution-targets.yaml`
 * `shared_idempotency`): the bundled worker remembers each keyed instruction
 * it received, so the core can resolve an unknown reply by asking for it
 * instead of sending it again (`unknown_outcome`). In memory: the bundled
 * worker shares the core's process, so a restart loses both, and the core's
 * operation ledger reconciles the interrupted work. A worker in its own
 * process needs these to persist (CAN-5073).
 */
export function createWorkerExecutorReceipts(
  definitions: CanopyInstructionDefinitionMap,
  options: { max?: number } = {},
): WorkerExecutorReceipts {
  const max = options.max ?? WORKER_EXECUTOR_RECEIPTS_MAX;
  const entries = new Map<string, Entry>();
  // Settlement order, for eviction past the bound.
  const settledOrder = new Set<string>();
  const run = (
    name: string,
    handler: InstructionHandler,
    params: unknown,
    context: CanopyHandlerContext,
  ): unknown => {
    const key = context.metadata.idempotencyKey;
    const definition = definitions[name];
    if (key === undefined || definition === undefined)
      return handler(params, context);
    const id = keyOf(context.caller.principalId, name, key);
    if (entries.has(id)) return handler(params, context);
    let markSettled: () => void = () => undefined;
    const entry: Entry = {
      settled: new Promise<void>((resolve) => {
        markSettled = resolve;
      }),
      receipt: { state: 'running' },
    };
    entries.set(id, entry);
    const settle = (receipt: WorkerExecutorReceipt): void => {
      entry.receipt = receipt;
      settledOrder.add(id);
      while (settledOrder.size > max) {
        const oldest = settledOrder.values().next().value;
        if (oldest === undefined) break;
        settledOrder.delete(oldest);
        entries.delete(oldest);
      }
      markSettled();
    };
    return Promise.resolve()
      .then(() => handler(params, context))
      .then(
        (raw) => {
          const parsed = safeParseCanopySchema(definition.result, raw);
          if (!parsed.success)
            settle({
              state: 'failed',
              error: canopyInvalidHandlerResultError().payload,
            });
          else {
            // The work completed either way; only a bounded result is kept.
            const json = CanopyJsonValueSchema.safeParse(parsed.data);
            settle(
              json.success
                ? { state: 'completed', result: json.data }
                : { state: 'completed' },
            );
          }
          return raw;
        },
        (error: unknown) => {
          settle({
            state: 'failed',
            error: translateCanopyHandlerError(definition, error).payload,
          });
          throw error;
        },
      );
  };
  return {
    wrap: (handlers) =>
      Object.fromEntries(
        Object.entries(handlers).map(([name, handler]) => [
          name,
          (params: unknown, context: CanopyHandlerContext): unknown =>
            run(name, handler, params, context),
        ]),
      ),
    settled: async (
      principalId,
      operation,
      idempotencyKey,
      signal,
    ): Promise<WorkerExecutorReceipt | null> => {
      const entry = entries.get(keyOf(principalId, operation, idempotencyKey));
      if (!entry) return null;
      if (entry.receipt.state === 'running') {
        signal?.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void =>
            reject(
              signal?.reason instanceof Error
                ? signal.reason
                : new Error('The receipt wait was aborted.'),
            );
          signal?.addEventListener('abort', onAbort, { once: true });
          void entry.settled.then(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          });
        });
      }
      return entry.receipt;
    },
    release: (principalId, operation, idempotencyKey): void => {
      const id = keyOf(principalId, operation, idempotencyKey);
      const entry = entries.get(id);
      if (!entry || entry.receipt.state === 'running') return;
      entries.delete(id);
      settledOrder.delete(id);
    },
  };
}
