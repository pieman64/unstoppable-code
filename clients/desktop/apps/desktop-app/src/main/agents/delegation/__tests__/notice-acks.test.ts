import {
  mkdtemp,
  readFile,
  rm,
  writeFile as writeTestFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DelegationNoticeAckStore,
  noticeBatchId,
  noticeId,
  type OwedNotice,
  type PendingNoticeBatch,
} from '../notice-acks';

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'delegation-notice-acks-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function parseJsonValue(value: string): unknown {
  return JSON.parse(value);
}

interface ControlledWrite {
  readonly path: string;
  readonly data: string;
  readonly resolve: () => void;
  readonly reject: (reason?: unknown) => void;
}

function controlledWriter(): {
  readonly writes: ControlledWrite[];
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly nextWrite: (index: number) => Promise<ControlledWrite>;
} {
  const writes: ControlledWrite[] = [];
  const waiters = new Map<number, Array<(write: ControlledWrite) => void>>();
  const writeFile = (path: string, data: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const write: ControlledWrite = { path, data, resolve, reject };
      const index = writes.push(write) - 1;
      for (const waiter of waiters.get(index) ?? []) waiter(write);
      waiters.delete(index);
    });
  const nextWrite = (index: number): Promise<ControlledWrite> => {
    const existing = writes[index];
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const queued = waiters.get(index) ?? [];
      queued.push(resolve);
      waiters.set(index, queued);
    });
  };
  return { writes, writeFile, nextWrite };
}

const pendingBatch = (
  batchId: string,
  noticeIds: readonly string[],
): PendingNoticeBatch => ({
  batchId,
  parentKey: 'parent-1',
  noticeIds,
});

const owedNotice = (id: string): OwedNotice => ({
  noticeId: id,
  delegationId: `delegation-${id}`,
  runGeneration: 3,
  resultIndex: 1,
});

describe('delegation notice acknowledgement identifiers', () => {
  it('creates stable identifiers that distinguish each input', () => {
    const first = noticeId('delegation-a', 2, 4);

    expect(first).toBe(noticeId('delegation-a', 2, 4));
    expect(first).not.toBe(noticeId('delegation-b', 2, 4));
    expect(first).not.toBe(noticeId('delegation-a', 3, 4));
    expect(first).not.toBe(noticeId('delegation-a', 2, 5));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('creates order-insensitive batch identifiers that distinguish content', () => {
    expect(noticeBatchId(['one', 'two'])).toBe(noticeBatchId(['two', 'one']));
    expect(noticeBatchId(['one', 'two'])).not.toBe(
      noticeBatchId(['one', 'three']),
    );
    expect(noticeBatchId(['one', 'two'])).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('DelegationNoticeAckStore', () => {
  it('journals an immutable exact message snapshot and restores it for replay', async () => {
    const directory = await makeTemporaryDirectory();
    const store = new DelegationNoticeAckStore(directory);
    await store.load();
    const message = {
      text: 'Brand delegate finished.\nOriginal task: completed',
      hiddenContextText:
        '<system_instruction>original sibling list</system_instruction>',
      watcherFired: { kind: 'Delegate finished' },
    };
    const expected = structuredClone(message);
    const batch = { ...pendingBatch('batch-snapshot', ['notice-a']), message };
    await store.recordPending(batch);
    message.text = 'Changed task';
    message.watcherFired.kind = 'Changed kind';
    expect(store.pending()[0]).toEqual({ ...batch, message: expected });

    const restored = new DelegationNoticeAckStore(directory);
    await restored.load();
    expect(restored.pending()).toEqual([{ ...batch, message: expected }]);
    const snapshot = restored.pending()[0]?.message;
    if (!snapshot) throw new Error('Missing restored message');
    // Even returned snapshots must not mutate the journal retained for replay.
    Reflect.set(snapshot, 'hiddenContextText', 'changed after read');
    expect(restored.pending()[0]?.message).toEqual(expected);
  });

  it('round trips acknowledgements, pending and owed notices, and baselining', async () => {
    const directory = join(await makeTemporaryDirectory(), 'nested');
    const store = new DelegationNoticeAckStore(directory);
    const batch = pendingBatch('batch-1', ['notice-1', 'notice-2']);

    store.acknowledge('delegation-1', 4, 'not dispatched');
    await store.recordPending(batch);
    store.owe([owedNotice('notice-1')]);
    store.markBaselined();
    await store.flush();

    const restored = new DelegationNoticeAckStore(directory);
    await expect(restored.load()).resolves.toEqual({ baselined: true });
    expect(restored.ack('delegation-1')).toEqual({
      resultIndex: 4,
      suppressedReason: 'not dispatched',
    });
    expect(restored.pending()).toEqual([batch]);
    expect(restored.owed()).toEqual([owedNotice('notice-1')]);
    expect(restored.isBaselined()).toBe(true);
    await expect(
      readFile(join(directory, 'notice-acks.json'), 'utf8'),
    ).resolves.toContain('"version": 1');
  });

  it('treats a missing file as an empty, unbaselined store', async () => {
    const directory = await makeTemporaryDirectory();
    const onError = jest.fn();
    const store = new DelegationNoticeAckStore(directory, { onError });

    const result = await store.load();

    expect(result).toEqual({ baselined: false });
    expect(store.ack('missing')).toBeUndefined();
    expect(store.pending()).toEqual([]);
    expect(store.owed()).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    ['corrupt JSON', '{not json'],
    [
      'an invalid shape',
      JSON.stringify({
        version: 1,
        baselined: 'yes',
        acks: {},
        pending: [],
        owed: [],
      }),
    ],
  ])('reports %s and recovers to empty state', async (_name, contents) => {
    const directory = await makeTemporaryDirectory();
    await writeTestFile(join(directory, 'notice-acks.json'), contents, 'utf8');
    const onError = jest.fn();
    const store = new DelegationNoticeAckStore(directory, { onError });

    await expect(store.load()).resolves.toEqual({ baselined: false });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(store.ack('missing')).toBeUndefined();
    expect(store.pending()).toEqual([]);
    expect(store.owed()).toEqual([]);
    expect(store.isBaselined()).toBe(false);
  });

  it('keeps acknowledgement indexes monotonic and replaces or clears suppression reasons', () => {
    const store = new DelegationNoticeAckStore('/unused');

    store.acknowledge('delegation-1', 4, 'earlier suppression');
    store.acknowledge('delegation-1', 3, 'stale suppression');
    expect(store.ack('delegation-1')).toEqual({
      resultIndex: 4,
      suppressedReason: 'earlier suppression',
    });

    store.acknowledge('delegation-1', 4, 'updated suppression');
    expect(store.ack('delegation-1')).toEqual({
      resultIndex: 4,
      suppressedReason: 'updated suppression',
    });

    store.acknowledge('delegation-1', 5);
    expect(store.ack('delegation-1')).toEqual({ resultIndex: 5 });
  });

  it('waits for the write containing each pending batch, including an in-flight follow-up', async () => {
    const directory = await makeTemporaryDirectory();
    const writer = controlledWriter();
    const store = new DelegationNoticeAckStore(directory, {
      writeFile: writer.writeFile,
    });
    const firstBatch = pendingBatch('batch-1', ['notice-1']);
    const firstRecord = store.recordPending(firstBatch);
    const firstWrite = await writer.nextWrite(0);
    let secondResolved = false;
    const secondRecord = store
      .recordPending(pendingBatch('batch-2', ['notice-2']))
      .then(() => {
        secondResolved = true;
      });

    expect(parseJsonValue(firstWrite.data)).toEqual(
      expect.objectContaining({ pending: [firstBatch] }),
    );
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    firstWrite.resolve();
    await expect(firstRecord).resolves.toBeUndefined();
    const secondWrite = await writer.nextWrite(1);
    expect(parseJsonValue(secondWrite.data)).toEqual(
      expect.objectContaining({
        pending: [firstBatch, pendingBatch('batch-2', ['notice-2'])],
      }),
    );
    expect(secondResolved).toBe(false);

    secondWrite.resolve();
    await expect(secondRecord).resolves.toBeUndefined();
    expect(secondResolved).toBe(true);
    expect(writer.writes).toHaveLength(2);
  });

  it('rejects and reports failed writes, then retries the dirty state on flush', async () => {
    const directory = await makeTemporaryDirectory();
    const writer = controlledWriter();
    const onError = jest.fn();
    const store = new DelegationNoticeAckStore(directory, {
      onError,
      writeFile: writer.writeFile,
    });
    store.markBaselined();

    const failedFlush = store.flush();
    const firstWrite = await writer.nextWrite(0);
    const failure = new Error('disk unavailable');
    firstWrite.reject(failure);
    await expect(failedFlush).rejects.toBe(failure);
    expect(onError).toHaveBeenCalledWith(failure);

    const retry = store.flush();
    const retryWrite = await writer.nextWrite(1);
    expect(parseJsonValue(retryWrite.data)).toEqual(
      expect.objectContaining({ baselined: true }),
    );
    retryWrite.resolve();
    await expect(retry).resolves.toBeUndefined();
    expect(writer.writes).toHaveLength(2);
  });

  it('coalesces rapid flush calls into no more than one follow-up write', async () => {
    const directory = await makeTemporaryDirectory();
    const writer = controlledWriter();
    const store = new DelegationNoticeAckStore(directory, {
      writeFile: writer.writeFile,
    });
    store.markBaselined();

    const initialFlush = store.flush();
    const firstWrite = await writer.nextWrite(0);
    store.acknowledge('delegation-1', 7);
    const coalescedFlushes = Array.from({ length: 12 }, () => store.flush());
    firstWrite.resolve();
    await expect(initialFlush).resolves.toBeUndefined();

    const followUpWrite = await writer.nextWrite(1);
    expect(parseJsonValue(followUpWrite.data)).toEqual(
      expect.objectContaining({
        acks: { 'delegation-1': { resultIndex: 7 } },
      }),
    );
    followUpWrite.resolve();
    await expect(Promise.all(coalescedFlushes)).resolves.toEqual(
      Array.from({ length: 12 }, () => undefined),
    );
    expect(writer.writes).toHaveLength(2);
  });

  it('deduplicates owed notices by notice id and settles them', () => {
    const store = new DelegationNoticeAckStore('/unused');
    const first = owedNotice('notice-1');

    store.owe([first, { ...first, resultIndex: 8 }, owedNotice('notice-2')]);
    expect(store.owed()).toEqual([first, owedNotice('notice-2')]);

    store.settleOwed('notice-1');
    expect(store.owed()).toEqual([owedNotice('notice-2')]);
  });
});
