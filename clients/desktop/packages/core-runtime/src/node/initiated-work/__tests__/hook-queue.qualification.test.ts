import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_INITIATED_WORK_RUN_KIND } from '@canopy/protocol/canopy-core';
import { OperationService } from '../../operations';
import { OperationLedger } from '../../operations/ledger';
import { InitiatedWorkEngine } from '../engine';
import {
  HookQueue,
  type HookQueueEnqueueRequest,
  type HookQueueHost,
  type HookQueueResumption,
  type HookQueueReconciliation,
  type HookQueueEntryRef,
} from '../hook-queue';
import { HookQueuePayloadStore } from '../hook-queue-store';

let dir: string;
let now: number;
let operations: OperationService;
let queue: HookQueue;
let payloads: HookQueuePayloadStore;
let request: HookQueueEnqueueRequest;

function host(): jest.Mocked<HookQueueHost> {
  return {
    reserve: jest.fn(),
    release: jest.fn(),
    resume: jest
      .fn<Promise<HookQueueResumption>, Parameters<HookQueueHost['resume']>>()
      .mockResolvedValue({ status: 'queued' }),
    reconcile: jest
      .fn<
        Promise<HookQueueReconciliation>,
        Parameters<HookQueueHost['reconcile']>
      >()
      .mockResolvedValue({ status: 'lost' }),
    cancel: jest
      .fn<Promise<void>, [HookQueueEntryRef]>()
      .mockResolvedValue(undefined),
  };
}
function open(): void {
  operations = new OperationService({
    openLedger: (): OperationLedger =>
      OperationLedger.open(join(dir, 'operations.sqlite'), {
        clock: (): number => now,
        retryWindowMs: 1_000,
      }),
    clock: (): number => now,
  });
  new InitiatedWorkEngine({ operations });
  payloads = new HookQueuePayloadStore({
    directory: (): string => join(dir, 'hook-queue'),
    writeFileAtomically: (path, text): Promise<void> => writeFile(path, text),
    quarantine: (path): Promise<void> => rename(path, `${path}.damaged-${now}`),
  });
  queue = new HookQueue({ operations, payloads });
}
async function enqueue(input = request): Promise<string> {
  const result = await queue.enqueue(input);
  if (result.status !== 'queued') throw new Error('Expected a new entry');
  return result.operationId;
}
async function restart(nextHost = host()): Promise<jest.Mocked<HookQueueHost>> {
  operations.close();
  open();
  queue.registerHost('chat', nextHost);
  await operations.whenReconciled();
  await queue.sweep();
  return nextHost;
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hook-queue-'));
  now = Date.parse('2026-11-05T08:00:00Z');
  open();
  const run = await operations.admit({
    kind: CORE_INITIATED_WORK_RUN_KIND,
    status: 'running',
    origin: {
      kind: 'hook',
      sourceId: 'project:pr:create',
      occurrenceKey: 'occ-1',
    },
    owner: { kind: 'principal', id: 'local' },
    scope: { workspaceId: 'p', worktreeId: 'a' },
  });
  request = {
    kind: 'chat',
    queueId: 'queued-hook-op-1-0',
    runOperationId: run.operation.operationId,
    actionIndex: 0,
    scope: { workspaceId: 'p', worktreeId: 'a', chatId: 'chat-hook-op-1-0' },
    payload: { prompt: 'Private queued prompt' },
  };
});
afterEach(() => {
  operations.close();
  rmSync(dir, { recursive: true, force: true });
});

it('commits a queued entry after its details are saved', async () => {
  const admit = operations.admit.bind(operations);
  jest.spyOn(operations, 'admit').mockImplementation(async (input) => {
    expect(await payloads.read(request.queueId)).toMatchObject({
      status: 'ok',
      entry: { revision: 1 },
    });
    return admit(input);
  });
  const id = await enqueue();
  const operation = await operations.get(id);
  expect(operation).toMatchObject({
    status: 'queued',
    kind: 'core.initiatedWork.queuedHookChat',
    scope: request.scope,
    parentOperationId: null,
    origin: { kind: 'hook', sourceId: 'project:pr:create' },
    owner: { kind: 'principal', id: 'local' },
  });
  expect(operation?.origin.occurrenceKey).toBeUndefined();
  expect(JSON.stringify(operation)).not.toContain('Private queued prompt');
});
it('answers a repeated enqueue with the existing entry and keeps its edited details', async () => {
  const id = await enqueue();
  const saved = await payloads.read(request.queueId);
  if (saved.status !== 'ok') throw new Error('Missing details');
  await queue.saveEdit({
    ...saved.entry,
    revision: 2,
    payload: { prompt: 'Edited' },
  });
  expect(await queue.enqueue(request)).toMatchObject({
    status: 'existing',
    operation: { operationId: id },
  });
  expect(await payloads.read(request.queueId)).toMatchObject({
    status: 'ok',
    entry: { revision: 2, payload: { prompt: 'Edited' } },
  });
});
it('removes the saved details when the ledger refuses the entry', async () => {
  jest
    .spyOn(operations, 'admit')
    .mockRejectedValueOnce(new Error('Ledger refused'));
  await expect(queue.enqueue(request)).rejects.toThrow('Ledger refused');
  expect(await payloads.read(request.queueId)).toEqual({ status: 'missing' });
});
it.each([false, true])(
  'preserves accepted edits during a concurrent retry (conflicting: %s)',
  async (conflicting) => {
    const editsSaved = Promise.withResolvers<void>();
    const lookup = queue.lookup.bind(queue);
    let calls = 0;
    jest.spyOn(queue, 'lookup').mockImplementation(async (...args) => {
      const call = ++calls;
      const result = await lookup(...args);
      if (call === 2) await editsSaved.promise;
      return result;
    });
    const first = queue.enqueue(request);
    const retry = queue.enqueue({
      ...request,
      actionIndex: conflicting ? 1 : 0,
    });
    const accepted = await first;
    expect(accepted.status).toBe('queued');
    const saved = await payloads.read(request.queueId);
    if (saved.status !== 'ok') throw new Error('Missing accepted details');
    await queue.saveEdit({
      ...saved.entry,
      revision: 2,
      payload: { prompt: 'Edited after acceptance' },
    });
    editsSaved.resolve();
    if (conflicting)
      await expect(retry).rejects.toMatchObject({ refusal: 'key-reused' });
    else expect(await retry).toMatchObject({ status: 'existing' });
    expect(await payloads.read(request.queueId)).toMatchObject({
      status: 'ok',
      entry: { revision: 2, payload: { prompt: 'Edited after acceptance' } },
    });
  },
);
it.each(['started', 'invalidated'])(
  'keeps recovery details when the terminal ledger write fails (%s)',
  async (disposition) => {
    const id = await enqueue();
    if (disposition === 'started') await queue.markStarting(id);
    operations.close();
    open();
    const ledger = await operations.ready();
    const finish = ledger.finish.bind(ledger);
    const failingFinish = jest
      .spyOn(ledger, 'finish')
      .mockImplementation((operationId, terminal) => {
        if (operationId === id)
          throw new Error('Simulated terminal write failure');
        return finish(operationId, terminal);
      });
    const nextHost = host();
    nextHost.reconcile.mockResolvedValue({
      status: 'started',
      outcome: { kind: 'chat', chatId: 'chat-hook-op-1-0', result: 'started' },
    });
    nextHost.resume.mockResolvedValue({
      status: 'invalidated',
      message: 'The recorded target is gone.',
    });
    queue.registerHost('chat', nextHost);
    await operations.whenReconciled();
    expect(await operations.get(id)).toMatchObject({ status: 'paused' });
    expect(await payloads.read(request.queueId)).toMatchObject({
      status: 'ok',
    });
    failingFinish.mockRestore();
    await restart(nextHost);
    expect(await operations.get(id)).toMatchObject(
      disposition === 'started'
        ? { status: 'completed', outcome: { result: 'started' } }
        : {
            status: 'failed',
            error: { code: 'core.initiatedWork.hookQueue.invalidated' },
          },
    );
    if (disposition === 'started')
      expect(nextHost.resume.mock.calls).toHaveLength(0);
    await queue.sweep();
    expect(await payloads.read(request.queueId)).toEqual({ status: 'missing' });
  },
);
it('resumes a queued entry after a restart, in accepted order', async () => {
  const ids = [
    await enqueue(),
    await enqueue({
      ...request,
      queueId: 'queued-hook-op-1-1',
      actionIndex: 1,
    }),
    await enqueue({
      ...request,
      queueId: 'queued-hook-op-1-2',
      actionIndex: 2,
      scope: { workspaceId: 'p', worktreeId: 'b' },
    }),
  ];
  const nextHost = host();
  const releases: Promise<void>[] = [];
  nextHost.resume.mockImplementation(async (ref, _saved, released) => {
    expect(nextHost.reserve.mock.calls).toHaveLength(3);
    let releasedAlready = false;
    void released.then(() => {
      releasedAlready = true;
    });
    await Promise.resolve();
    expect(releasedAlready).toBe(false);
    releases.push(
      released.then(async () => {
        expect(await operations.get(ref.operationId)).toMatchObject({
          status: 'queued',
          restart: { disposition: 'resumed' },
        });
      }),
    );
    return { status: 'queued' };
  });
  await restart(nextHost);
  expect(nextHost.reserve.mock.calls.map(([ref]) => ref.operationId)).toEqual(
    ids,
  );
  await Promise.all(releases);
  for (const id of ids) {
    expect((await operations.ready()).statusBeforeRestart(id)).toBe('queued');
    expect(await operations.get(id)).toMatchObject({
      status: 'queued',
      restart: { disposition: 'resumed' },
    });
  }
});
it('ends an entry cancelled before the restart as cancelled and never resumes it', async () => {
  const id = await enqueue();
  queue.registerHost('chat', host());
  await operations.cancel(id, { requestedBy: 'client', reason: 'Stop' });
  const nextHost = await restart();
  expect(nextHost.resume.mock.calls).toHaveLength(0);
  expect(
    await queue.lookup('chat', request.queueId, request.runOperationId, 0),
  ).toMatchObject({ status: 'ended', operation: { status: 'cancelled' } });
});
it('reconciles an entry that may have started instead of resuming it', async () => {
  const id = await enqueue();
  const lost = await enqueue({
    ...request,
    queueId: 'queued-hook-op-1-1',
    actionIndex: 1,
  });
  expect(await queue.markStarting(id)).toBe('started');
  expect(await queue.markStarting(lost)).toBe('started');
  const nextHost = host();
  nextHost.reconcile.mockImplementation(
    (ref): Promise<HookQueueReconciliation> =>
      Promise.resolve(
        ref.operationId === id
          ? {
              status: 'started',
              outcome: {
                kind: 'chat',
                chatId: 'chat-hook-op-1-0',
                result: 'started',
              },
            }
          : { status: 'lost' },
      ),
  );
  await restart(nextHost);
  expect((await operations.get(id))?.error).toBeNull();
  expect(nextHost.resume.mock.calls).toHaveLength(0);
  expect(nextHost.reconcile.mock.calls).toHaveLength(2);
  expect(await operations.get(id)).toMatchObject({
    status: 'completed',
    outcome: { result: 'started' },
  });
  expect(await operations.get(lost)).toMatchObject({
    status: 'failed',
    error: { code: 'core.operation.interrupted' },
  });
  expect(await payloads.list()).toEqual([]);
});
it('ends an entry whose details are damaged or missing as invalidated', async () => {
  const id = await enqueue();
  const missing = await enqueue({
    ...request,
    queueId: 'queued-hook-op-1-1',
    actionIndex: 1,
  });
  await writeFile(join(dir, 'hook-queue', `${request.queueId}.json`), '{');
  await rm(join(dir, 'hook-queue', 'queued-hook-op-1-1.json'));
  const nextHost = await restart();
  for (const op of [id, missing])
    expect(await operations.get(op)).toMatchObject({
      status: 'failed',
      error: { code: 'core.initiatedWork.hookQueue.invalidated' },
    });
  expect(nextHost.release.mock.calls).toHaveLength(2);
  expect(
    (await readdir(join(dir, 'hook-queue'))).some((name) =>
      name.includes('.damaged-'),
    ),
  ).toBe(true);
});
it('leaves a newer saved entry untouched', async () => {
  const id = await enqueue();
  const path = join(dir, 'hook-queue', `${request.queueId}.json`);
  const newer = JSON.stringify({ version: 2, future: 'data' });
  await writeFile(path, newer);
  await restart();
  await queue.sweep();
  expect(await operations.get(id)).toMatchObject({
    status: 'failed',
    error: {
      message:
        'This queued hook work was saved by a newer version of the app, so it was not run.',
    },
  });
  expect(await readFile(path, 'utf8')).toBe(newer);
});
it('invalidates a saved entry whose action index was tampered with', async () => {
  const id = await enqueue();
  const saved = await payloads.read(request.queueId);
  if (saved.status !== 'ok') throw new Error('Missing details');
  await payloads.write({
    ...saved.entry,
    actionIndex: saved.entry.actionIndex + 1,
  });
  const nextHost = await restart();
  expect(await operations.get(id)).toMatchObject({
    status: 'failed',
    error: { code: 'core.initiatedWork.hookQueue.invalidated' },
  });
  expect(nextHost.resume.mock.calls).toHaveLength(0);
  expect(nextHost.reconcile.mock.calls).toHaveLength(0);
  expect(nextHost.release.mock.calls).toHaveLength(1);
});
it('waits for its host before recovering', async () => {
  await enqueue();
  operations.close();
  open();
  let settled = false;
  const reconciled = operations.whenReconciled().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(settled).toBe(false);
  queue.registerHost('chat', host());
  await reconciled;
  expect(settled).toBe(true);
});
it('sweeps saved details whose entry is finished or absent', async () => {
  const id = await enqueue();
  const saved = await payloads.read(request.queueId);
  if (saved.status !== 'ok') throw new Error('Missing details');
  await payloads.write({ ...saved.entry, queueId: 'orphan' });
  await enqueue({ ...request, queueId: 'waiting', actionIndex: 1 });
  await operations.finish(id, { status: 'cancelled' });
  await queue.sweep();
  expect(await payloads.list()).toEqual(['waiting']);
});
it('does not sweep replacement details while their admission is pending', async () => {
  await payloads.write({
    version: 1,
    kind: request.kind,
    queueId: request.queueId,
    runOperationId: request.runOperationId,
    actionIndex: request.actionIndex,
    revision: 1,
    savedAt: new Date(now).toISOString(),
    payload: { prompt: 'Orphan' },
  });
  const reading = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  const releaseAdmission = Promise.withResolvers<void>();
  const read = payloads.read.bind(payloads);
  jest.spyOn(payloads, 'read').mockImplementationOnce(async (queueId) => {
    const result = await read(queueId);
    reading.resolve();
    await releaseRead.promise;
    return result;
  });
  jest.spyOn(payloads, 'write').mockImplementation((entry): Promise<void> => {
    writeFileSync(
      join(dir, 'hook-queue', `${entry.queueId}.json`),
      JSON.stringify(entry),
    );
    return Promise.resolve();
  });
  const admit = operations.admit.bind(operations);
  jest.spyOn(operations, 'admit').mockImplementation(async (input) => {
    await releaseAdmission.promise;
    return admit(input);
  });
  const sweeping = queue.sweep();
  await reading.promise;
  const admission = queue.enqueue(request);
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseRead.resolve();
  await sweeping;
  releaseAdmission.resolve();
  const accepted = await admission;
  expect(accepted.status).toBe('queued');
  expect(await payloads.read(request.queueId)).toMatchObject({
    status: 'ok',
    entry: { payload: request.payload },
  });
});
it('keeps a cancelled identity after its outcome expired', async () => {
  const id = await enqueue();
  queue.registerHost('chat', host());
  await operations.cancel(id, { requestedBy: 'client', reason: 'Stop' });
  now += 1_001;
  (await operations.ready()).compact();
  expect(
    await queue.lookup('chat', request.queueId, request.runOperationId, 0),
  ).toMatchObject({ status: 'ended', operation: { status: 'cancelled' } });
});
