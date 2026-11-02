import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatArtifactMaintenance } from '../lib/chat-artifact-maintenance';
import { ChatStorageTransactions } from '../lib/chat-storage-transactions';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { scopeSource } from './helpers/chat-delta-journal-harness';

jest.mock(
  '../lib/chat-delta-journal/delegation-registry-store',
  () => ({
    enumerateDelegationRegistryAnswerReferences:
      function (): AsyncIterable<never> {
        return {
          [Symbol.asyncIterator]: (): AsyncIterator<never> => ({
            next: (): Promise<IteratorResult<never>> =>
              Promise.resolve({ done: true, value: undefined }),
          }),
        };
      },
    scanDelegationRegistryAnswerReferences: function (): AsyncIterable<never> {
      return {
        [Symbol.asyncIterator]: (): AsyncIterator<never> => ({
          next: (): Promise<IteratorResult<never>> =>
            Promise.resolve({ done: true, value: undefined }),
        }),
      };
    },
    registrySnapshotDigest: (): Promise<string> =>
      Promise.resolve('empty-registry'),
  }),
  { virtual: true },
);

it('retains an answer-only registry reference during artifact maintenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-registry-answer-gc-'));
  const store = new ChatStorageV2(root, 'scope');
  await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
  const transactions = new ChatStorageTransactions(store);
  const maintenance = new ChatArtifactMaintenance(
    transactions,
    store.directory,
  );
  try {
    const ref = await transactions.transcripts.artifacts.put(
      'chat',
      'only the result references this answer',
    );
    // The registry contributes no logical transcript row. This source isolates
    // maintenance from the independently tested segment/index implementation.
    Object.assign(transactions, {
      async *registryAnswerReferences(): AsyncIterable<typeof ref> {
        yield await Promise.resolve(ref);
      },
    });
    let complete = false;
    for (let attempt = 0; attempt < 32 && !complete; attempt++)
      complete = (await maintenance.maintain('chat', 1024)).complete;
    expect(complete).toBe(true);
    await expect(
      transactions.transcripts.artifacts.verify('chat', ref),
    ).resolves.toBeUndefined();
  } finally {
    await maintenance.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('bounds registry reference work and closes the scan when invalidated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-registry-scan-'));
  const store = new ChatStorageV2(root, 'scope');
  await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
  const transactions = new ChatStorageTransactions(store);
  const maintenance = new ChatArtifactMaintenance(
    transactions,
    store.directory,
  );
  let visited = 0;
  let closed = false;
  try {
    const ref = await transactions.transcripts.artifacts.put('chat', 'kept');
    Object.assign(transactions, {
      async *registryAnswerReferences(): AsyncIterable<typeof ref> {
        try {
          for (let index = 0; index < 1000; index++) {
            visited++;
            yield await Promise.resolve(ref);
          }
        } finally {
          closed = true;
        }
      },
    });
    for (let attempt = 0; attempt < 8 && visited === 0; attempt++)
      await maintenance.maintain('chat', 1024);
    expect(visited).toBe(2);
    expect(closed).toBe(false);
    await maintenance.invalidate('chat');
    expect(closed).toBe(true);
    await expect(
      transactions.transcripts.artifacts.verify('chat', ref),
    ).resolves.toBeUndefined();
  } finally {
    await maintenance.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('never reclaims while pending admission may own an answer reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-registry-pending-'));
  const store = new ChatStorageV2(root, 'scope');
  await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
  const transactions = new ChatStorageTransactions(store);
  const maintenance = new ChatArtifactMaintenance(
    transactions,
    store.directory,
  );
  try {
    const ref = await transactions.transcripts.artifacts.put(
      'chat',
      'pending answer',
    );
    jest.spyOn(transactions, 'journalIsClear').mockResolvedValue(false);
    await expect(maintenance.maintain('chat', 1024)).rejects.toThrow(
      'replay is pending',
    );
    await expect(
      transactions.transcripts.artifacts.verify('chat', ref),
    ).resolves.toBeUndefined();
  } finally {
    jest.restoreAllMocks();
    await maintenance.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('never treats a failed registry scan as a complete reachability proof on retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-registry-failed-scan-'));
  const store = new ChatStorageV2(root, 'scope');
  await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
  const transactions = new ChatStorageTransactions(store);
  const maintenance = new ChatArtifactMaintenance(
    transactions,
    store.directory,
  );
  try {
    const first = await transactions.transcripts.artifacts.put(
      'chat',
      'first retained answer',
    );
    const second = await transactions.transcripts.artifacts.put(
      'chat',
      'second retained answer',
    );
    Object.assign(transactions, {
      async *registryAnswerReferences(): AsyncIterable<typeof first> {
        yield await Promise.resolve(first);
        throw new Error('registry segment unreadable');
      },
    });
    let failed = false;
    for (let attempt = 0; attempt < 8 && !failed; attempt++) {
      try {
        await maintenance.maintain('chat', 1024);
      } catch (error) {
        expect(error).toEqual(new Error('registry segment unreadable'));
        failed = true;
      }
    }
    expect(failed).toBe(true);
    let failedAgain = false;
    for (let attempt = 0; attempt < 8 && !failedAgain; attempt++) {
      try {
        expect((await maintenance.maintain('chat', 1024)).complete).toBe(false);
      } catch (error) {
        expect(error).toEqual(new Error('registry segment unreadable'));
        failedAgain = true;
      }
    }
    expect(failedAgain).toBe(true);
    await expect(
      transactions.transcripts.artifacts.verify('chat', second),
    ).resolves.toBeUndefined();
  } finally {
    await maintenance.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('charges linear registry closure work at N=1000 and 2N without retaining a registry-sized array', async () => {
  const charges: number[] = [];
  for (const count of [1000, 2000]) {
    const root = await mkdtemp(join(tmpdir(), 'chat-registry-linear-scan-'));
    const store = new ChatStorageV2(root, 'scope');
    await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
    const transactions = new ChatStorageTransactions(store);
    const maintenance = new ChatArtifactMaintenance(
      transactions,
      store.directory,
    );
    let visited = 0;
    let scannedBytes = 0;
    try {
      const ref = await transactions.transcripts.artifacts.put(
        'chat',
        'kept answer',
      );
      Object.assign(transactions, {
        async *registryAnswerReferences(): AsyncIterable<typeof ref> {
          for (let index = 0; index < count; index++) {
            visited++;
            yield await Promise.resolve(ref);
          }
        },
      });
      let complete = false;
      for (let attempt = 0; attempt < 150 && !complete; attempt++) {
        const slice = await maintenance.maintain('chat', 16 * 1024);
        complete = slice.complete;
        scannedBytes += slice.scannedBytes;
      }
      expect(complete).toBe(true);
      expect(visited).toBe(count);
      charges.push(scannedBytes);
    } finally {
      await maintenance.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }
  expect(charges[1]).toBe(2 * charges[0]);
});
