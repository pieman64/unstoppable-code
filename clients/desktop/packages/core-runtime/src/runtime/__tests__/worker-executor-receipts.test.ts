import {
  CanopyErrorPayloadSchema,
  CanopyStreamCursorSchema,
  WorkerFilesystemFileReadResultSchema,
  defineCanopyInstruction,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';

import { createCanopyDispatcher } from '../dispatcher';
import {
  createInProcessWorkerBinding,
  localWorkerTransportOf,
} from '../in-process-worker-binding';
import type { CanopyHandlerContext } from '../types';
import { createWorkerExecutorReceipts } from '../worker-executor-receipts';
import { serializingWorkerPair } from './serializing-worker-pair';
import {
  WORKER_EXAMPLE_EFFECT_INSTRUCTIONS,
  WORKER_EXAMPLE_INSTRUCTIONS,
} from './worker-example-definitions';

const WRITE = 'worker.example.write';
const APPEND = 'worker.example.append';
const instructions = {
  [WRITE]: WORKER_EXAMPLE_INSTRUCTIONS[WRITE],
  [APPEND]: WORKER_EXAMPLE_EFFECT_INSTRUCTIONS[APPEND],
};
const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'binding',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: ['worker.example.write'],
};
const cursor = { daemonEpoch: 'epoch', sequence: 1 };

function context(idempotencyKey?: string): CanopyHandlerContext {
  return {
    requestId: 'request',
    caller,
    metadata: idempotencyKey === undefined ? {} : { idempotencyKey },
    signal: new AbortController().signal,
  };
}

describe('worker executor receipts', () => {
  it('records the handler settlement under the caller, operation and key', async () => {
    const receipts = createWorkerExecutorReceipts(instructions);
    let release = (): void => undefined;
    const handlers = receipts.wrap({
      [WRITE]: () =>
        new Promise((resolve) => {
          release = (): void => resolve({ daemonEpoch: 'done', sequence: 2 });
        }),
    });
    const running = handlers[WRITE](cursor, context('key-1'));
    const settled = receipts.settled('core', WRITE, 'key-1');
    await expect(receipts.settled('core', WRITE, 'other')).resolves.toBeNull();
    await expect(receipts.settled('peer', WRITE, 'key-1')).resolves.toBeNull();
    release();
    await running;
    await expect(settled).resolves.toEqual({
      state: 'completed',
      result: { daemonEpoch: 'done', sequence: 2 },
    });
    receipts.release('core', WRITE, 'key-1');
    await expect(receipts.settled('core', WRITE, 'key-1')).resolves.toBeNull();
  });

  it('runs a repeated key as before and keeps the first receipt', async () => {
    const receipts = createWorkerExecutorReceipts(instructions);
    const handler = jest
      .fn()
      .mockResolvedValueOnce({ daemonEpoch: 'first', sequence: 1 })
      .mockResolvedValueOnce({ daemonEpoch: 'second', sequence: 1 });
    const handlers = receipts.wrap({ [WRITE]: handler });
    await handlers[WRITE](cursor, context('key-1'));
    await expect(handlers[WRITE](cursor, context('key-1'))).resolves.toEqual({
      daemonEpoch: 'second',
      sequence: 1,
    });
    expect(handler).toHaveBeenCalledTimes(2);
    await expect(receipts.settled('core', WRITE, 'key-1')).resolves.toEqual({
      state: 'completed',
      result: { daemonEpoch: 'first', sequence: 1 },
    });
  });

  it('records the dispatcher error for a failure and runs unkeyed work as is', async () => {
    const receipts = createWorkerExecutorReceipts(instructions);
    const handlers = receipts.wrap({
      [WRITE]: () =>
        Promise.reject(new Error('raw failure with /private/path')),
      [APPEND]: () => Promise.resolve(cursor),
    });
    await expect(handlers[WRITE](cursor, context('key-1'))).rejects.toThrow();
    await expect(receipts.settled('core', WRITE, 'key-1')).resolves.toEqual({
      state: 'failed',
      error: {
        kind: 'internal',
        message: 'The operation failed.',
        retry: { kind: 'never' },
      },
    });
    await handlers[APPEND](cursor, context());
    await expect(receipts.settled('core', APPEND, 'none')).resolves.toBeNull();
  });

  it('records a completed result too large to keep as completed without it', async () => {
    const LARGE = 'worker.example.large';
    const receipts = createWorkerExecutorReceipts({
      [LARGE]: defineCanopyInstruction({
        plane: 'worker',
        domain: 'example',
        version: 1,
        placement: 'worker-only',
        idempotency: 'keyed',
        requiredGrants: ['worker.example.write'],
        params: CanopyStreamCursorSchema,
        // A result schema that admits more than 32 KiB of content.
        result: WorkerFilesystemFileReadResultSchema,
        error: CanopyErrorPayloadSchema,
      }),
    });
    const handlers = receipts.wrap({
      [LARGE]: () =>
        Promise.resolve({
          fileRootId: 'root',
          relativePath: 'notes.txt',
          name: 'notes.txt',
          contentKind: 'text',
          encoding: 'utf8',
          content: 'x'.repeat(40_000),
          sizeBytes: 40_000,
          returnedBytes: 40_000,
          truncated: false,
          modifiedAt: '2026-10-28T00:00:00.000Z',
          version: 'v1',
        }),
    });
    await handlers[LARGE](cursor, context('key-1'));
    await expect(receipts.settled('core', LARGE, 'key-1')).resolves.toEqual({
      state: 'completed',
    });
  });

  it('keeps at most the bound of settled, unreleased receipts', async () => {
    const receipts = createWorkerExecutorReceipts(instructions, { max: 2 });
    const handlers = receipts.wrap({ [WRITE]: () => Promise.resolve(cursor) });
    for (const key of ['a', 'b', 'c'])
      await handlers[WRITE](cursor, context(key));
    await expect(receipts.settled('core', WRITE, 'a')).resolves.toBeNull();
    await expect(receipts.settled('core', WRITE, 'c')).resolves.toMatchObject({
      state: 'completed',
    });
  });
});

describe('bundled binding receipts', () => {
  it('answers a receipt lookup across the serialized pair and releases it', async () => {
    const receipts = createWorkerExecutorReceipts(instructions);
    let finish = (): void => undefined;
    const definitions = { queries: {}, instructions, streams: {} };
    const worker = createCanopyDispatcher({
      profile: 'worker',
      definitions,
      handlers: {
        queries: {},
        instructions: receipts.wrap({
          [WRITE]: () =>
            new Promise((resolve) => {
              finish = (): void =>
                resolve({ daemonEpoch: 'late', sequence: 1 });
            }),
          [APPEND]: () => Promise.resolve(cursor),
        }),
        streams: {},
      },
    });
    const binding = createInProcessWorkerBinding({
      dispatcher: worker,
      definitions,
      caller,
      pair: serializingWorkerPair(),
      receipts,
    });
    const transport = localWorkerTransportOf(binding, instructions);
    const abort = new AbortController();
    const call = transport.instruction(WRITE, cursor, {
      metadata: { idempotencyKey: 'key-1' },
      signal: abort.signal,
    });
    await expect(transport.receipt(WRITE, 'never-sent')).resolves.toBeNull();
    abort.abort();
    await expect(call).rejects.toMatchObject({
      payload: { kind: 'cancelled' },
    });
    const receipt = transport.receipt(WRITE, 'key-1');
    finish();
    await expect(receipt).resolves.toEqual({
      state: 'completed',
      result: { daemonEpoch: 'late', sequence: 1 },
    });
    transport.releaseReceipt(WRITE, 'key-1');
    await expect(transport.receipt(WRITE, 'key-1')).resolves.toBeNull();
    binding.close();
    await expect(transport.receipt(WRITE, 'key-1')).rejects.toMatchObject({
      payload: { kind: 'unavailable' },
    });
    await worker.shutdown();
  });
});
