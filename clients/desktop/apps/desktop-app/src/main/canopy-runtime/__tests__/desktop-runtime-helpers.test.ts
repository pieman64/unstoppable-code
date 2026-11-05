import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableStringify } from '@canopy/protocol/plans';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from '../core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import {
  runHelperThroughWorker,
  HelperWorkerUnavailableError,
} from '../../helper-runs/helper-runs';
import { createWorkerAgentHelperAdapter } from '../worker-agent-helper-adapter';
import { desktopHelperWorker } from '../../helper-runs/helper-worker-host';
import { currentHelperWorkerContext } from '../../helper-runs/helper-worker-context';

let root: string;
let operations: CoreOperationAdapter;
let runtime: DesktopCanopyDispatcher;
const caller: CanopyCallerDescriptor = {
  principalId: 'another-client',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.operation.cancel'],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desktop-helpers-'));
  operations = createCoreOperationAdapter({
    ledgerPath: () => join(root, 'ledger.sqlite'),
  });
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    shutdownTimeoutMs: 25,
  });
});
afterEach(async () => {
  await runtime.shutdown();
  rmSync(root, { recursive: true, force: true });
});

it('runs a staged launch on the local worker and returns its own value', async () => {
  const value = { text: 'ready', usage: { inputTokens: 7 } };
  expect(
    await runHelperThroughWorker({
      kind: 'chat_summary',
      model: 'model',
      scope: { chatId: 'chat' },
      origin: 'client',
      launch: () => Promise.resolve(value),
      usageOf: (result) => result.usage,
    }),
  ).toBe(value);
  const [parent] = (
    await operations.service.list({ kinds: ['core.helper.run'], limit: 10 })
  ).items;
  expect(parent).toMatchObject({
    status: 'completed',
    outcome: {
      usage: { inputTokens: 7 },
      result: {
        sha256: `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`,
        bytes: Buffer.byteLength(stableStringify(value)),
      },
    },
  });
});

it("rethrows the launch's own error while the record keeps only the portable error", async () => {
  const error = new Error('provider /secret/path');
  await expect(
    runHelperThroughWorker({
      kind: 'chat_summary',
      model: 'model',
      scope: {},
      origin: 'system',
      launch: () => Promise.reject(error),
      usageOf: () => undefined,
    }),
  ).rejects.toBe(error);
  const [parent] = (
    await operations.service.list({ kinds: ['core.helper.run'], limit: 10 })
  ).items;
  expect(parent?.error).toEqual({
    kind: 'internal',
    code: 'worker.agent.helperFailed',
    message: 'The helper model call failed.',
    retry: { kind: 'never' },
  });
  expect(JSON.stringify(parent)).not.toContain('/secret/path');
});

it('cancels the launch when another client cancels its operation', async () => {
  const reason = new Error('stopped');
  let started = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const running = runHelperThroughWorker({
    kind: 'chat_summary',
    model: 'model',
    scope: {},
    origin: 'system',
    launch: (signal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(reason), { once: true });
        started();
      }),
    usageOf: () => undefined,
  });
  const rejected = expect(running).rejects.toBe(reason);
  await ready;
  const [parent] = (
    await operations.service.list({ kinds: ['core.helper.run'], limit: 10 })
  ).items;
  if (!parent) throw new Error('Missing parent');
  await runtime.instruction(
    'core.operation.cancel',
    { operationId: parent.operationId, reason: 'stop' },
    { caller },
  );
  await rejected;
  expect(await operations.service.get(parent.operationId)).toMatchObject({
    status: 'cancelled',
  });
});

it("never runs the launch when the caller aborted first, and throws the caller's reason", async () => {
  const reason = new Error('already stopped');
  const controller = new AbortController();
  controller.abort(reason);
  const launch = jest.fn(() => Promise.resolve('unused'));
  await expect(
    runHelperThroughWorker({
      kind: 'chat_summary',
      model: 'model',
      scope: {},
      origin: 'client',
      signal: controller.signal,
      launch,
      usageOf: () => undefined,
    }),
  ).rejects.toBe(reason);
  expect(launch).not.toHaveBeenCalled();
});

it('runs the launch inside the helper worker context', async () => {
  const context = await runHelperThroughWorker({
    kind: 'chat_summary',
    model: 'model',
    scope: {},
    origin: 'system',
    launch: () => Promise.resolve(currentHelperWorkerContext()),
    usageOf: () => undefined,
  });
  const runIdMatcher: unknown = expect.any(String);
  expect(context).toEqual({
    helperRunId: runIdMatcher,
    kind: 'chat_summary',
  });
  expect(currentHelperWorkerContext()).toBeUndefined();
});

it('refuses with HelperWorkerUnavailableError when the runtime is not accepting', async () => {
  await runtime.shutdown();
  const launch = jest.fn(() => Promise.resolve('unused'));
  await expect(
    runHelperThroughWorker({
      kind: 'chat_summary',
      model: 'model',
      scope: {},
      origin: 'client',
      launch,
      usageOf: () => undefined,
    }),
  ).rejects.toBeInstanceOf(HelperWorkerUnavailableError);
  expect(launch).not.toHaveBeenCalled();
});

it('settles as cancelled without launching when aborted during adapter loading', async () => {
  await runtime.shutdown();
  operations = createCoreOperationAdapter({
    ledgerPath: () => join(root, 'delayed-ledger.sqlite'),
  });
  let release = (): void => undefined;
  let started = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const loading = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    shutdownTimeoutMs: 25,
    workerAgentHelperAdapter: createWorkerAgentHelperAdapter(async () => {
      started();
      await loading;
      return desktopHelperWorker;
    }),
  });
  const launch = jest.fn(() => Promise.resolve('unused'));
  const running = runHelperThroughWorker({
    kind: 'chat_summary',
    model: 'model',
    scope: {},
    origin: 'system',
    launch,
    usageOf: () => undefined,
  }).catch(() => undefined);
  try {
    await ready;
    const [parent] = (
      await operations.service.list({ kinds: ['core.helper.run'], limit: 10 })
    ).items;
    if (!parent) throw new Error('Missing parent');
    await runtime.instruction(
      'core.operation.cancel',
      {
        operationId: parent.operationId,
        reason: 'stop during adapter loading',
      },
      { caller },
    );
    release();
    await running;
    expect(launch).not.toHaveBeenCalled();
    expect(await operations.service.get(parent.operationId)).toMatchObject({
      status: 'cancelled',
    });
    const [child] = (
      await operations.service.list({
        kinds: ['worker.agent.helper.run'],
        limit: 10,
      })
    ).items;
    expect(child).toMatchObject({
      status: 'cancelled',
      outcome: { status: 'cancelled', usage: {} },
    });
  } finally {
    release();
  }
});
