import { readFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import * as workCounters from '@canopy/desktop-shared/node/work-counters';
import {
  DelegationRegistryStore,
  enumerateDelegationRegistryAnswerReferences,
  registrySnapshotDigest,
} from '../lib/chat-delta-journal/delegation-registry-store';
import { createDelegationRegistryReader } from '../lib/chat-delta-journal/delegation-registry-reader';
import type { DelegationRegistryJournalEffect } from '../lib/chat-delta-journal/delegation-registry-api';

// Counts file reads for the work-bound test; every call passes through.
const mockFsReads = { count: 0 };
// Fails a rename when set: a crash just before that file is published.
const mockFsFaults: { failRename?: (from: string, to: string) => boolean } = {};
jest.mock('node:fs/promises', () => {
  const actual: typeof FsPromises = jest.requireActual('node:fs/promises');
  const counted = <T extends (...args: never[]) => unknown>(fn: T): T =>
    new Proxy(fn, {
      apply(target, thisArg, args: unknown[]): unknown {
        mockFsReads.count += 1;
        return Reflect.apply(target, thisArg, args);
      },
    });
  return {
    ...actual,
    readFile: counted(actual.readFile),
    open: counted(actual.open),
    rename: (from: string, to: string): Promise<void> =>
      mockFsFaults.failRename?.(from, to)
        ? Promise.reject(new Error('simulated crash before rename'))
        : actual.rename(from, to),
  };
});

const chatId = 'chat-registry-1';
const delegationId = 'delegation/opaque';
const identity = { chatId, delegationId };
const target = {
  kind: 'delegation' as const,
  chatId,
  delegationId,
  runGeneration: 1,
};
const answerRef = {
  version: 1 as const,
  artifactId: 'answer-content-1',
  byteLength: 5,
  sha256: 'a'.repeat(64),
  encoding: 'utf-8' as const,
  mediaType: 'text/plain' as const,
};
const generationEffect: DelegationRegistryJournalEffect = {
  kind: 'delegation-generation',
  identity,
  entry: {
    version: 1,
    kind: 'generation',
    chatId,
    delegationId,
    runGeneration: 1,
    createdAt: 10,
    store: 'stream',
    origin: { kind: 'launch' },
    executionMode: 'background',
  },
};
const resultEffect: DelegationRegistryJournalEffect = {
  kind: 'delegation-result',
  target,
  entry: {
    version: 1,
    kind: 'result',
    resultIndex: 1,
    runGeneration: 1,
    settlementKey: 'settlement-key-1',
    settlementDigest: 'b'.repeat(64),
    outcome: { status: 'completed', finishedAt: 20 },
    answer: {
      kind: 'body',
      role: 'final',
      byteLength: 5,
      encoding: 'utf8',
      sha256: 'a'.repeat(64),
      ref: answerRef,
    },
    settlement: {
      streamRevision: 2,
      contentRevision: 2,
      finalItemCount: 0,
      finalItemsDigest: 'c'.repeat(64),
    },
  },
};

describe('delegation registry storage', () => {
  let transcriptsRoot: string;

  beforeEach(async () => {
    transcriptsRoot = await mkdtemp(join(tmpdir(), 'delegation-registry-'));
  });

  afterEach(async () => {
    mockFsFaults.failRename = undefined;
    await rm(transcriptsRoot, { recursive: true, force: true });
  }, 60_000);

  it('starts a recreated identity fresh after its chat registry is removed', async () => {
    const store = new DelegationRegistryStore(transcriptsRoot);
    await store.append(chatId, [generationEffect, resultEffect]);
    await store.checkpoint(await store.highWater(identity));
    // As checkpoint publication removes a deleted parent's tree.
    await rm(join(transcriptsRoot, 'delegations', chatId), {
      recursive: true,
      force: true,
    });
    store.forgetChat(chatId);
    await store.append(chatId, [generationEffect, resultEffect]);
    const recreated = await store.highWater(identity);
    expect(recreated.highWater).toBe(2);
    await store.checkpoint(recreated);
    for (const reader of [store, new DelegationRegistryStore(transcriptsRoot)])
      await expect(
        reader.result({ ...identity, resultIndex: 1 }),
      ).resolves.toEqual(resultEffect.entry);
  });

  it('syncs new segment and registry directory entries before publishing the head', async () => {
    const events: string[] = [];
    const synced = jest
      .spyOn(workCounters, 'recordChatStorageDirectorySync')
      .mockImplementation((path) => {
        events.push(`sync ${path}`);
      });
    mockFsFaults.failRename = (_from, to): boolean => {
      events.push(`rename ${to}`);
      return false;
    };
    try {
      const writer = new DelegationRegistryStore(transcriptsRoot);
      await writer.append(chatId, [generationEffect, resultEffect]);
      await writer.checkpoint(await writer.highWater(identity));
    } finally {
      synced.mockRestore();
    }
    const heads = events.flatMap((event, index) =>
      event.startsWith('rename ') && event.endsWith(`${sep}head.json`)
        ? [index]
        : [],
    );
    const finalHead = heads[heads.length - 1];
    const directory = dirname(events[finalHead].slice('rename '.length));
    const before = events.slice(0, finalHead);
    // The segment's entry, and every directory created on the way to it.
    for (const path of [
      join(directory, 'segments'),
      directory,
      dirname(directory),
      join(transcriptsRoot, 'delegations'),
      transcriptsRoot,
    ])
      expect(before).toContain(`sync ${path}`);
  });

  it('recovers when the first checkpoint stops before publishing its head', async () => {
    const writer = new DelegationRegistryStore(transcriptsRoot);
    await writer.append(chatId, [generationEffect, resultEffect]);
    const checkpoint = await writer.highWater(identity);
    mockFsFaults.failRename = (from, to): boolean => {
      if (!to.endsWith(`${sep}head.json`)) return false;
      const head: unknown = JSON.parse(readFileSync(from, 'utf8'));
      return (
        typeof head === 'object' &&
        head !== null &&
        'highWater' in head &&
        head.highWater !== 0
      );
    };
    await expect(writer.checkpoint(checkpoint)).rejects.toThrow(
      'simulated crash before rename',
    );
    mockFsFaults.failRename = undefined;

    // Recovery replays the intact journal into a new store.
    const recovered = new DelegationRegistryStore(transcriptsRoot);
    await recovered.append(chatId, [generationEffect, resultEffect]);
    const replayed = await recovered.highWater(identity);
    expect(replayed).toEqual(checkpoint);
    await expect(recovered.checkpoint(replayed)).resolves.toEqual(checkpoint);
    await expect(
      new DelegationRegistryStore(transcriptsRoot).result({
        ...identity,
        resultIndex: 1,
      }),
    ).resolves.toEqual(resultEffect.entry);
  });

  it('checkpoints canonical entries and answer-only references for bounded reopen reads', async () => {
    const writer = new DelegationRegistryStore(transcriptsRoot);
    const beforeAppend = await registrySnapshotDigest(transcriptsRoot, chatId);
    await writer.append(chatId, [generationEffect, resultEffect]);
    await expect(registrySnapshotDigest(transcriptsRoot, chatId)).resolves.toBe(
      beforeAppend,
    );
    const checkpoint = await writer.highWater(identity);
    await expect(writer.checkpoint(checkpoint)).resolves.toEqual(checkpoint);

    const checkpointDigest = await registrySnapshotDigest(
      transcriptsRoot,
      chatId,
    );
    const reopened = new DelegationRegistryStore(transcriptsRoot);
    await expect(
      reopened.result({ ...identity, resultIndex: 1 }),
    ).resolves.toEqual(resultEffect.entry);
    await expect(
      reopened.resultBySettlementKey({
        ...identity,
        settlementKey: 'settlement-key-1',
      }),
    ).resolves.toEqual(resultEffect.entry);
    await expect(
      reopened.resultByGeneration({ ...identity, runGeneration: 1 }),
    ).resolves.toEqual(resultEffect.entry);
    await expect(
      reopened.generation({ ...identity, runGeneration: 1 }),
    ).resolves.toMatchObject({
      entry: generationEffect.entry,
      stream: null,
      result: resultEffect.entry,
    });

    const references = [];
    for await (const reference of enumerateDelegationRegistryAnswerReferences(
      transcriptsRoot,
      chatId,
    ))
      references.push(reference);
    expect(references).toEqual([answerRef]);
    await expect(registrySnapshotDigest(transcriptsRoot, chatId)).resolves.toBe(
      checkpointDigest,
    );
  });

  it('rejects malformed or conflicting effect identities rather than indexing them', async () => {
    const store = new DelegationRegistryStore(transcriptsRoot);
    const conflictingResult: DelegationRegistryJournalEffect = {
      ...resultEffect,
      entry: {
        ...resultEffect.entry,
        settlementKey: 'settlement-key-other',
      },
    };
    await store.append(chatId, [generationEffect, resultEffect]);
    await expect(
      store.append(chatId, [conflictingResult]),
    ).rejects.toMatchObject({
      failure: { code: 'conflict' },
    });
    await expect(
      store.append('../unsafe', [generationEffect]),
    ).rejects.toMatchObject({
      failure: { code: 'invalid_request' },
    });
  });

  it('returns the stored generation on replay when only write-time metadata differs', async () => {
    const store = new DelegationRegistryStore(transcriptsRoot);
    await store.append(chatId, [generationEffect]);
    const checkpoint = await store.highWater(identity);
    await store.checkpoint(checkpoint);
    const digestBeforeReplay = await registrySnapshotDigest(
      transcriptsRoot,
      chatId,
    );

    const replayedGeneration: DelegationRegistryJournalEffect = {
      ...generationEffect,
      entry: {
        ...generationEffect.entry,
        createdAt: generationEffect.entry.createdAt + 1,
      },
    };
    await store.append(chatId, [replayedGeneration]);
    await expect(store.highWater(identity)).resolves.toEqual(checkpoint);
    await expect(store.checkpoint(checkpoint)).resolves.toEqual(checkpoint);
    await expect(
      store.generationEntry({ ...identity, runGeneration: 1 }),
    ).resolves.toEqual(generationEffect.entry);
    await expect(registrySnapshotDigest(transcriptsRoot, chatId)).resolves.toBe(
      digestBeforeReplay,
    );
  });

  it('retains pending effects across more than the bounded head cache and keys admissions by run generation', async () => {
    const store = new DelegationRegistryStore(transcriptsRoot);
    const many: DelegationRegistryJournalEffect[] = [];
    for (let index = 0; index < 65; index += 1) {
      const delegationId = `delegation-${index}`;
      many.push({
        kind: 'delegation-generation',
        identity: { chatId, delegationId },
        entry: {
          ...generationEffect.entry,
          delegationId,
          runGeneration: 1,
        },
      });
    }
    await store.append(chatId, many);
    const firstIdentity = { chatId, delegationId: 'delegation-0' };
    const lastIdentity = { chatId, delegationId: 'delegation-64' };
    const firstCheckpoint = await store.highWater(firstIdentity);
    const lastCheckpoint = await store.highWater(lastIdentity);
    const cachedHeads: unknown = Reflect.get(store, 'heads');
    const cachedIndexes: unknown = Reflect.get(store, 'ephemeralIndexes');
    const indexedDelegations: unknown = Reflect.get(store, 'indexed');
    expect(
      cachedHeads instanceof Map ? cachedHeads.size : Number.POSITIVE_INFINITY,
    ).toBeLessThanOrEqual(64);
    expect(
      cachedIndexes instanceof Map
        ? cachedIndexes.size
        : Number.POSITIVE_INFINITY,
    ).toBeLessThanOrEqual(64);
    expect(
      indexedDelegations instanceof Map
        ? indexedDelegations.size
        : Number.POSITIVE_INFINITY,
    ).toBeLessThanOrEqual(64);
    await store.checkpoint(firstCheckpoint);
    await store.checkpoint(lastCheckpoint);
    const reopened = new DelegationRegistryStore(transcriptsRoot);
    await expect(
      reopened.generationEntry({ ...firstIdentity, runGeneration: 1 }),
    ).resolves.toMatchObject({ delegationId: 'delegation-0' });
    await expect(
      reopened.generationEntry({ ...lastIdentity, runGeneration: 1 }),
    ).resolves.toMatchObject({ delegationId: 'delegation-64' });

    const targetFor = (runGeneration: number): typeof target => ({
      ...target,
      runGeneration,
    });
    const admissionFor = (
      runGeneration: number,
      mutationKey: string,
    ): DelegationRegistryJournalEffect => ({
      kind: 'child-admission',
      target: targetFor(runGeneration),
      items: [
        {
          id: 'same-child-item',
          itemRevision: 0,
          admittingStreamRevision: 1,
          mutationKey,
        },
      ],
    });
    await store.append(chatId, [
      admissionFor(1, 'first-key'),
      admissionFor(2, 'second-key'),
    ]);
    await expect(
      store.itemAdmission({
        target: targetFor(1),
        messageId: 'same-child-item',
        itemRevision: 0,
      }),
    ).resolves.toMatchObject({ mutationKey: 'first-key' });
    await expect(
      store.itemAdmission({
        target: targetFor(2),
        messageId: 'same-child-item',
        itemRevision: 0,
      }),
    ).resolves.toMatchObject({ mutationKey: 'second-key' });
  });

  it('uses all-effect high-water for page fencing and makes verified replay overlays read-only and idempotent', async () => {
    const writer = new DelegationRegistryStore(transcriptsRoot);
    await writer.append(chatId, [generationEffect]);
    const generationCheckpoint = await writer.highWater(identity);
    await writer.checkpoint(generationCheckpoint);
    await writer.append(chatId, [resultEffect]);
    const resultCheckpoint = await writer.highWater(identity);
    await writer.checkpoint(resultCheckpoint);

    const store = new DelegationRegistryStore(transcriptsRoot);
    const beforeReplay = await registrySnapshotDigest(transcriptsRoot, chatId);
    const replay = new DelegationRegistryStore(transcriptsRoot, {
      pendingEffects: function* (): Generator<DelegationRegistryJournalEffect> {
        yield generationEffect;
        yield resultEffect;
      },
    });
    await expect(replay.highWater(identity)).resolves.toEqual(resultCheckpoint);
    await expect(
      replay.result({ ...identity, resultIndex: 1 }),
    ).resolves.toEqual(resultEffect.entry);
    const replayReferences = [];
    for await (const reference of replay.answerReferences(chatId))
      replayReferences.push(reference);
    expect(replayReferences).toEqual([answerRef]);
    await expect(registrySnapshotDigest(transcriptsRoot, chatId)).resolves.toBe(
      beforeReplay,
    );
    await expect(
      store.readPage(
        identity,
        'results',
        0,
        generationCheckpoint.highWater,
        10,
      ),
    ).resolves.toMatchObject({ entries: [], hasMore: false });
  });

  it('exposes a checkpoint reader with empty-answer ranges and strict cursor scope', async () => {
    const store = new DelegationRegistryStore(transcriptsRoot);
    const emptyResult: DelegationRegistryJournalEffect = {
      ...resultEffect,
      entry: {
        ...resultEffect.entry,
        answer: { kind: 'empty', role: 'final' },
      },
    };
    const secondEmptyResult: DelegationRegistryJournalEffect = {
      ...emptyResult,
      target: { ...target, runGeneration: 2 },
      entry: {
        ...emptyResult.entry,
        resultIndex: 2,
        runGeneration: 2,
        settlementKey: 'settlement-key-2',
      },
    };
    await store.append(chatId, [emptyResult, secondEmptyResult]);
    const reader = createDelegationRegistryReader({
      store,
      readDescriptor: () => Promise.resolve(undefined),
      readAnswerRange: () =>
        Promise.resolve({
          text: 'should not be read',
          byteLength: 0,
          encoding: 'utf8',
        }),
    });
    const context = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      archive: { kind: 'live' as const },
      storageIdentity: 'copy-1',
    };
    await expect(
      reader.resultAnswerRange({
        ...identity,
        resultIndex: 1,
        offset: 0,
        limit: 4,
      }),
    ).resolves.toEqual({ text: '', byteLength: 0, encoding: 'utf8' });
    // Same byte rules as contentRange, over zero bytes.
    await expect(
      reader.resultAnswerRange({
        ...identity,
        resultIndex: 1,
        offset: 9,
        limit: 0,
      }),
    ).rejects.toMatchObject({ failure: { code: 'invalid_request' } });
    const page = await reader.resultsPage({ ...identity, limit: 1 }, context);
    expect(page.results).toHaveLength(1);
    if (page.cursor) {
      await expect(
        reader.resultsPage(
          { ...identity, limit: 1, cursor: page.cursor },
          { ...context, storageIdentity: 'copy-2' },
        ),
      ).rejects.toMatchObject({ failure: { code: 'invalid_request' } });
      const future = Buffer.from(
        JSON.stringify({
          version: 1,
          scopeIdentity: '0'.repeat(64),
          identity,
          kind: 'results',
          position: 0,
          highWater: Number.MAX_SAFE_INTEGER,
        }),
        'utf8',
      ).toString('base64url');
      await expect(
        reader.resultsPage({ ...identity, limit: 1, cursor: future }, context),
      ).rejects.toMatchObject({ failure: { code: 'invalid_request' } });
    }
  });

  it('keeps generation-page result projections behind the captured all-effect watermark', async () => {
    const store = new DelegationRegistryStore(transcriptsRoot);
    const secondGeneration: DelegationRegistryJournalEffect = {
      ...generationEffect,
      entry: { ...generationEffect.entry, runGeneration: 2 },
    };
    await store.append(chatId, [generationEffect, secondGeneration]);
    const reader = createDelegationRegistryReader({
      store,
      readDescriptor: () => Promise.resolve(undefined),
      readAnswerRange: () =>
        Promise.resolve({
          text: '',
          byteLength: 0,
          encoding: 'utf8',
        }),
    });
    const context = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      archive: { kind: 'live' as const },
      storageIdentity: 'copy-1',
    };
    const firstPage = await reader.generationsPage(
      { ...identity, limit: 1 },
      context,
    );
    expect(firstPage.generations[0]?.entry.runGeneration).toBe(1);
    expect(firstPage.cursor).toBeDefined();

    const laterResult: DelegationRegistryJournalEffect = {
      ...resultEffect,
      target: { ...target, runGeneration: 2 },
      entry: { ...resultEffect.entry, runGeneration: 2 },
    };
    await store.append(chatId, [laterResult]);
    const secondPage = await reader.generationsPage(
      { ...identity, limit: 1, cursor: firstPage.cursor },
      context,
    );
    expect(secondPage.generations[0]?.entry.runGeneration).toBe(2);
    expect(secondPage.generations[0]?.result).toBeNull();
  });

  it('reads bounded pages and point lookups after checkpointing 1,000 indexed generations', async () => {
    const store = new DelegationRegistryStore(transcriptsRoot);
    const effects: DelegationRegistryJournalEffect[] = Array.from(
      { length: 1000 },
      (_, index) => ({
        kind: 'delegation-generation',
        identity,
        entry: {
          ...generationEffect.entry,
          runGeneration: index + 1,
          createdAt: index + 10,
        },
      }),
    );
    await store.append(chatId, effects);
    const checkpoint = await store.highWater(identity);
    expect(checkpoint.highWater).toBe(1000);
    await store.checkpoint(checkpoint);

    const reopened = new DelegationRegistryStore(transcriptsRoot);
    await expect(
      reopened.generationEntry({ ...identity, runGeneration: 1000 }),
    ).resolves.toMatchObject({ runGeneration: 1000 });
    const page = await reopened.readPage(
      identity,
      'generations',
      990,
      checkpoint.highWater,
      10,
    );
    expect(page.entries).toHaveLength(10);
    expect(page.entries[0]?.runGeneration).toBe(991);
    expect(page.entries[9]?.runGeneration).toBe(1000);
    expect(page.hasMore).toBe(false);
  }, 120_000);

  it('rejects a torn committed segment as corruption on point reads', async () => {
    const store = new DelegationRegistryStore(transcriptsRoot);
    await store.append(chatId, [generationEffect, resultEffect]);
    const checkpoint = await store.highWater(identity);
    await store.checkpoint(checkpoint);
    const registryRoot = join(
      transcriptsRoot,
      'delegations',
      chatId,
      'registry',
    );
    const [directoryName] = await readdir(registryRoot);
    if (!directoryName)
      throw new Error('Expected one delegation registry directory');
    const segment = join(
      registryRoot,
      directoryName,
      'segments',
      'segment-00000000.jsonl',
    );
    await writeFile(segment, Buffer.from('torn\n', 'utf8'));
    await expect(
      new DelegationRegistryStore(transcriptsRoot).result({
        ...identity,
        resultIndex: 1,
      }),
    ).rejects.toMatchObject({
      failure: { code: 'corruption' },
    });
  });

  it('keeps append, checkpoint and point-read work independent of registry size (N = 1,000 vs 2N)', async () => {
    interface FileState {
      readonly size: number;
      readonly mtimeMs: number;
      readonly ino: number;
    }
    async function files(root: string): Promise<Map<string, FileState>> {
      const out = new Map<string, FileState>();
      async function walk(directory: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await walk(path);
          else {
            const info = await stat(path);
            out.set(path, {
              size: info.size,
              mtimeMs: info.mtimeMs,
              ino: info.ino,
            });
          }
        }
      }
      await walk(root);
      return out;
    }
    function generation(
      runGeneration: number,
    ): DelegationRegistryJournalEffect {
      return {
        kind: 'delegation-generation',
        identity,
        entry: {
          version: 1,
          kind: 'generation',
          chatId,
          delegationId,
          runGeneration,
          createdAt: runGeneration + 10,
          store: 'stream',
          origin: { kind: 'launch' },
          executionMode: 'background',
        },
      };
    }
    async function measure(
      n: number,
    ): Promise<{ written: number; pointReads: number; pageReads: number }> {
      const root = await mkdtemp(join(tmpdir(), 'delegation-registry-scale-'));
      try {
        const store = new DelegationRegistryStore(root);
        await store.append(
          chatId,
          Array.from({ length: n }, (_, index) => generation(index + 1)),
        );
        await store.checkpoint(await store.highWater(identity));
        const before = await files(root);
        await store.append(chatId, [generation(n + 1)]);
        const head = await store.highWater(identity);
        await store.checkpoint(head);
        const after = await files(root);
        // Bytes written by one append and checkpoint: new files whole, segments
        // by growth (they are append-only), any other rewritten file whole.
        let written = 0;
        for (const [path, now] of Array.from(after.entries())) {
          const prior = before.get(path);
          if (!prior || prior.ino !== now.ino) written += now.size;
          else if (path.includes(`${sep}segments${sep}`))
            written += Math.max(0, now.size - prior.size);
          else if (prior.mtimeMs !== now.mtimeMs || prior.size !== now.size)
            written += now.size;
        }
        const reopened = new DelegationRegistryStore(root);
        await reopened.generationEntry({ ...identity, runGeneration: 1 });
        mockFsReads.count = 0;
        await expect(
          reopened.generationEntry({
            ...identity,
            runGeneration: Math.floor(n / 2),
          }),
        ).resolves.toMatchObject({ runGeneration: Math.floor(n / 2) });
        const pointReads = mockFsReads.count;
        mockFsReads.count = 0;
        const page = await reopened.readPage(
          identity,
          'generations',
          Math.floor(n / 2),
          head.highWater,
          10,
        );
        expect(page.entries).toHaveLength(10);
        const pageReads = mockFsReads.count;
        return { written, pointReads, pageReads };
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    const small = await measure(1000);
    const large = await measure(2000);
    // Independent of N: identical file operations, and written bytes within
    // the size jitter of one entry's decimal digits.
    // The counter is live, so equal counts are not vacuous.
    expect(small.pointReads).toBeGreaterThan(0);
    expect(small.pageReads).toBeGreaterThan(0);
    expect(large.pointReads).toBe(small.pointReads);
    expect(large.pageReads).toBeLessThanOrEqual(small.pageReads + 1);
    expect(large.written).toBeLessThanOrEqual(small.written + 512);
    expect(small.written).toBeLessThan(64 * 1024);
  }, 240_000);
});
