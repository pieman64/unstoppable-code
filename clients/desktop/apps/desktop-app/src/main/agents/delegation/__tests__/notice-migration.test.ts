import { mkdtemp, rm, writeFile as writeTestFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DelegationNoticeAckStore,
  noticeId,
  type OwedNotice,
} from '../notice-acks';
import {
  migrateDelegateWatchersToNotices,
  type LegacyDelegateWatcher,
} from '../notice-migration';

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), 'delegation-notice-migration-'),
  );
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

function watcher(
  id: string,
  delivered: boolean,
  targets: LegacyDelegateWatcher['targets'],
): LegacyDelegateWatcher {
  return { id, delivered, targets };
}

function owedNotice(
  delegationId: string,
  runGeneration: number,
  resultIndex: number,
): OwedNotice {
  return {
    noticeId: noticeId(delegationId, runGeneration, resultIndex),
    delegationId,
    runGeneration,
    resultIndex,
  };
}

describe('migrateDelegateWatchersToNotices', () => {
  it('baselines results, owes each distinct undelivered settled target, then removes all listed watchers', async () => {
    const directory = await makeTemporaryDirectory();
    const store = new DelegationNoticeAckStore(directory);
    await store.load();
    store.acknowledge('delegation-1', 4);

    const listedWatchers = [
      watcher('watcher-undelivered-1', false, [
        {
          delegationId: 'delegation-1',
          runGeneration: 5,
          resultIndex: 8,
        },
        {
          delegationId: 'delegation-2',
          runGeneration: 2,
          resultIndex: null,
        },
      ]),
      watcher('watcher-undelivered-2', false, [
        {
          delegationId: 'delegation-1',
          runGeneration: 5,
          resultIndex: 8,
        },
      ]),
      watcher('watcher-delivered', true, [
        {
          delegationId: 'delegation-3',
          runGeneration: 1,
          resultIndex: 11,
        },
      ]),
    ];
    const events: string[] = [];

    const result = await migrateDelegateWatchersToNotices({
      store,
      records: [
        { delegationId: 'delegation-1', latestResultIndex: 8 },
        { delegationId: 'delegation-2', latestResultIndex: null },
        { delegationId: 'delegation-3', latestResultIndex: 11 },
        { delegationId: 'delegation-4', latestResultIndex: 3 },
      ],
      watchers: {
        list: () => Promise.resolve(listedWatchers),
        remove: (ids) => {
          events.push('remove');
          expect(ids).toEqual([
            'watcher-undelivered-1',
            'watcher-undelivered-2',
            'watcher-delivered',
          ]);
          return Promise.resolve();
        },
      },
    });

    expect(result).toEqual({ owed: 1, removed: 3 });
    expect(events).toEqual(['remove']);
    expect(store.ack('delegation-1')).toEqual({ resultIndex: 8 });
    expect(store.ack('delegation-2')).toBeUndefined();
    expect(store.ack('delegation-3')).toEqual({ resultIndex: 11 });
    expect(store.ack('delegation-4')).toEqual({ resultIndex: 3 });
    expect(store.owed()).toEqual([owedNotice('delegation-1', 5, 8)]);

    const restored = new DelegationNoticeAckStore(directory);
    await expect(restored.load()).resolves.toEqual({ baselined: true });
    expect(restored.owed()).toEqual([owedNotice('delegation-1', 5, 8)]);
  });

  it('owes a settled target whose watcher index stayed null after a crash, from durable results', async () => {
    const store = new DelegationNoticeAckStore(await makeTemporaryDirectory());

    const result = await migrateDelegateWatchersToNotices({
      store,
      records: [
        {
          delegationId: 'delegation-5',
          latestResultIndex: 2,
          results: [
            { runGeneration: 1, resultIndex: 1 },
            { runGeneration: 2, resultIndex: 2 },
          ],
        },
        {
          delegationId: 'delegation-6',
          latestResultIndex: 1,
          results: [{ runGeneration: 1, resultIndex: 1 }],
        },
      ],
      watchers: {
        list: () =>
          Promise.resolve([
            watcher('watcher-stale', false, [
              {
                delegationId: 'delegation-5',
                runGeneration: 2,
                resultIndex: null,
              },
              // Generation 2 of delegation-6 has not settled yet.
              {
                delegationId: 'delegation-6',
                runGeneration: 2,
                resultIndex: null,
              },
            ]),
          ]),
        remove: () => Promise.resolve(),
      },
    });

    expect(result).toEqual({ owed: 1, removed: 1 });
    expect(store.owed()).toEqual([owedNotice('delegation-5', 2, 2)]);
  });

  it('baselines acknowledgements without marking the migration done when listing legacy watchers fails', async () => {
    const directory = await makeTemporaryDirectory();
    const store = new DelegationNoticeAckStore(directory);
    await store.load();

    await expect(
      migrateDelegateWatchersToNotices({
        store,
        records: [
          { delegationId: 'delegation-1', latestResultIndex: 3 },
          { delegationId: 'delegation-2', latestResultIndex: null },
        ],
        watchers: {
          list: () => Promise.reject(new Error('watchers.json is corrupt')),
          remove: () => Promise.resolve(),
        },
      }),
    ).rejects.toThrow('watchers.json is corrupt');

    expect(store.isBaselined()).toBe(false);
    const restored = new DelegationNoticeAckStore(directory);
    await expect(restored.load()).resolves.toEqual({ baselined: false });
    expect(restored.ack('delegation-1')).toEqual({ resultIndex: 3 });
    expect(restored.ack('delegation-2')).toBeUndefined();
  });

  it('keeps the watcher and leaves the migration unmarked when a stale target cannot be resolved', async () => {
    const directory = await makeTemporaryDirectory();
    const store = new DelegationNoticeAckStore(directory);
    await store.load();
    const staleWatcher = watcher('watcher-unreadable', false, [
      { delegationId: 'delegation-7', runGeneration: 2, resultIndex: null },
    ]);
    const remove = jest.fn(() => Promise.resolve());

    await expect(
      migrateDelegateWatchersToNotices({
        store,
        records: [
          {
            delegationId: 'delegation-7',
            latestResultIndex: 2,
            resultsUnavailable: true,
          },
        ],
        watchers: { list: () => Promise.resolve([staleWatcher]), remove },
      }),
    ).rejects.toThrow();

    expect(remove).not.toHaveBeenCalled();
    expect(store.isBaselined()).toBe(false);
    expect(store.owed()).toEqual([]);

    await migrateDelegateWatchersToNotices({
      store,
      records: [
        {
          delegationId: 'delegation-7',
          latestResultIndex: 2,
          results: [{ runGeneration: 2, resultIndex: 2 }],
        },
      ],
      watchers: { list: () => Promise.resolve([staleWatcher]), remove },
    });
    expect(store.owed()).toEqual([owedNotice('delegation-7', 2, 2)]);
    expect(remove).toHaveBeenCalledWith(['watcher-unreadable']);
  });

  it('reuses the first baseline on retry so a result settled in between is still announced', async () => {
    const directory = await makeTemporaryDirectory();
    const store = new DelegationNoticeAckStore(directory);
    await store.load();
    await expect(
      migrateDelegateWatchersToNotices({
        store,
        records: [{ delegationId: 'delegation-8', latestResultIndex: 1 }],
        watchers: {
          list: () => Promise.reject(new Error('watchers.json is corrupt')),
          remove: () => Promise.resolve(),
        },
      }),
    ).rejects.toThrow();

    // A crash later: result 2 settled but was never journaled or owed.
    const restarted = new DelegationNoticeAckStore(directory);
    await restarted.load();
    await migrateDelegateWatchersToNotices({
      store: restarted,
      records: [{ delegationId: 'delegation-8', latestResultIndex: 2 }],
      watchers: {
        list: () => Promise.resolve([]),
        remove: () => Promise.resolve(),
      },
    });

    expect(restarted.isBaselined()).toBe(true);
    expect(restarted.ack('delegation-8')).toEqual({ resultIndex: 1 });
  });

  it('does not lower acknowledgements while baselining', async () => {
    const store = new DelegationNoticeAckStore(await makeTemporaryDirectory());
    store.acknowledge('delegation-1', 9);

    await migrateDelegateWatchersToNotices({
      store,
      records: [{ delegationId: 'delegation-1', latestResultIndex: 6 }],
      watchers: {
        list: () => Promise.resolve([]),
        remove: () => Promise.resolve(),
      },
    });

    expect(store.ack('delegation-1')).toEqual({ resultIndex: 9 });
  });

  it('only removes leftover watchers when the durable migration baseline already exists', async () => {
    const directory = await makeTemporaryDirectory();
    const writeFile = jest.fn((): Promise<void> => Promise.resolve());
    const store = new DelegationNoticeAckStore(directory, { writeFile });
    const previouslyOwed = owedNotice('delegation-1', 4, 12);
    store.acknowledge('delegation-1', 12);
    store.owe([previouslyOwed]);
    store.markBaselined();
    await store.flush();
    writeFile.mockClear();
    const remove = jest.fn((): Promise<void> => Promise.resolve());

    const result = await migrateDelegateWatchersToNotices({
      store,
      records: [{ delegationId: 'delegation-1', latestResultIndex: 1 }],
      watchers: {
        list: () =>
          Promise.resolve([
            watcher('leftover-watcher', false, [
              {
                delegationId: 'delegation-1',
                runGeneration: 5,
                resultIndex: 13,
              },
            ]),
          ]),
        remove,
      },
    });

    expect(result).toEqual({ owed: 0, removed: 1 });
    expect(store.ack('delegation-1')).toEqual({ resultIndex: 12 });
    expect(store.owed()).toEqual([previouslyOwed]);
    expect(remove).toHaveBeenCalledWith(['leftover-watcher']);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('persists baselining even when there are no records or watchers', async () => {
    const directory = await makeTemporaryDirectory();
    const store = new DelegationNoticeAckStore(directory);

    await expect(
      migrateDelegateWatchersToNotices({
        store,
        records: [],
        watchers: {
          list: () => Promise.resolve([]),
          remove: (ids) => {
            expect(ids).toEqual([]);
            return Promise.resolve();
          },
        },
      }),
    ).resolves.toEqual({ owed: 0, removed: 0 });

    const restored = new DelegationNoticeAckStore(directory);
    await expect(restored.load()).resolves.toEqual({ baselined: true });
  });

  it('flushes the baseline and owed notices before removing watcher ids', async () => {
    const directory = await makeTemporaryDirectory();
    const events: string[] = [];
    const store = new DelegationNoticeAckStore(directory, {
      writeFile: (): Promise<void> => {
        events.push('flush');
        return Promise.resolve();
      },
    });

    await migrateDelegateWatchersToNotices({
      store,
      records: [{ delegationId: 'delegation-1', latestResultIndex: 2 }],
      watchers: {
        list: () =>
          Promise.resolve([
            watcher('watcher-1', false, [
              {
                delegationId: 'delegation-1',
                runGeneration: 2,
                resultIndex: 2,
              },
            ]),
          ]),
        remove: (): Promise<void> => {
          events.push('remove');
          return Promise.resolve();
        },
      },
    });

    expect(events).toEqual(['flush', 'remove']);
  });

  it('rethrows a failed flush without removing any watchers', async () => {
    const directory = await makeTemporaryDirectory();
    const error = new Error('flush failed');
    const remove = jest.fn((): Promise<void> => Promise.resolve());
    const store = new DelegationNoticeAckStore(directory, {
      writeFile: (): Promise<void> => Promise.reject(error),
    });

    await expect(
      migrateDelegateWatchersToNotices({
        store,
        records: [{ delegationId: 'delegation-1', latestResultIndex: 2 }],
        watchers: {
          list: () =>
            Promise.resolve([
              watcher('watcher-1', false, [
                {
                  delegationId: 'delegation-1',
                  runGeneration: 2,
                  resultIndex: 2,
                },
              ]),
            ]),
          remove,
        },
      }),
    ).rejects.toBe(error);

    expect(remove).not.toHaveBeenCalled();
    expect(store.isBaselined()).toBe(true);
    expect(store.ack('delegation-1')).toEqual({ resultIndex: 2 });
    expect(store.owed()).toEqual([owedNotice('delegation-1', 2, 2)]);
  });

  it('retries a failed baseline flush on the same store before listing or removing leftovers', async () => {
    const directory = await makeTemporaryDirectory();
    const error = new Error('first flush failed');
    const events: string[] = [];
    let shouldFail = true;
    const writeFile = jest.fn((path: string, data: string): Promise<void> => {
      events.push('flush');
      if (shouldFail) return Promise.reject(error);
      return writeTestFile(path, data, 'utf8');
    });
    const store = new DelegationNoticeAckStore(directory, { writeFile });
    const listedWatchers = [
      watcher('watcher-1', false, [
        {
          delegationId: 'delegation-1',
          runGeneration: 2,
          resultIndex: 2,
        },
      ]),
    ];
    const list = jest.fn((): Promise<readonly LegacyDelegateWatcher[]> => {
      events.push('list');
      return Promise.resolve(listedWatchers);
    });
    const remove = jest.fn((): Promise<void> => {
      events.push('remove');
      return Promise.resolve();
    });
    const options = {
      store,
      records: [{ delegationId: 'delegation-1', latestResultIndex: 2 }],
      watchers: { list, remove },
    };

    await expect(migrateDelegateWatchersToNotices(options)).rejects.toBe(error);
    expect(remove).not.toHaveBeenCalled();
    expect(store.ack('delegation-1')).toEqual({ resultIndex: 2 });
    expect(store.owed()).toEqual([owedNotice('delegation-1', 2, 2)]);

    shouldFail = false;
    events.splice(0);
    await expect(migrateDelegateWatchersToNotices(options)).resolves.toEqual({
      owed: 0,
      removed: 1,
    });

    expect(events).toEqual(['flush', 'list', 'remove']);
    expect(list).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(store.owed()).toEqual([owedNotice('delegation-1', 2, 2)]);
    const restored = new DelegationNoticeAckStore(directory);
    await expect(restored.load()).resolves.toEqual({ baselined: true });
    expect(restored.owed()).toEqual([owedNotice('delegation-1', 2, 2)]);
  });
});
