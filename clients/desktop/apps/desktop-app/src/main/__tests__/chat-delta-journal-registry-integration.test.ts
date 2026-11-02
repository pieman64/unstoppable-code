import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import type { DelegationTranscriptSettleRequest } from '@canopy/desktop-shared/node/delegation/transcript-port';
import { delegationTranscriptSettlementDigest } from '@canopy/desktop-shared/node/delegation/settlement-identity';
import {
  ChatStorageV2,
  assertChatStorageIndexes,
} from '../lib/chat-storage-v2';
import {
  ChatDeltaJournalWriter,
  promoteToDeltaJournal,
  promoteToFormat4Journal,
  type DeltaJournalBoundary,
} from '../lib/chat-delta-journal/writer';
import { openDelegationRegistryReadView } from '../lib/chat-delta-journal/reader';
import { delegationStreamKey } from '../lib/transcript-stream-paths';
import { scopeSource } from './helpers/chat-delta-journal-harness';

const target = {
  kind: 'delegation',
  chatId: 'chat',
  delegationId: 'child',
  runGeneration: 0,
} as const;
const identity = { chatId: 'chat', delegationId: 'child' };
const row: DelegationChildRow = {
  id: 'final-a',
  role: 'assistant',
  timestamp: 10,
  blocks: [{ type: 'text', text: 'final row' }],
  parentBlockId: 'child',
  delegationSequence: 0,
  itemRevision: 0,
  final: true,
};

async function setup(
  root: string,
  boundaries: DeltaJournalBoundary[] = [],
): Promise<{ store: ChatStorageV2; writer: ChatDeltaJournalWriter }> {
  const store = new ChatStorageV2(root, 'scope', undefined, {
    maxManifestVersion: 4,
  });
  await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
  await promoteToDeltaJournal(store);
  const writer = await promoteToFormat4Journal(store, {
    onBoundary: (point): Promise<void> => {
      boundaries.push(point);
      return Promise.resolve();
    },
  });
  const current = writer.indexes();
  await writer.commit({
    expectedRevision: current.live.revision,
    next: {
      live: { ...current.live, revision: current.live.revision + 1 },
      archive: { ...current.archive, revision: current.live.revision + 1 },
      recovery: {
        ...current.recovery,
        mutationIds: [...current.recovery.mutationIds, 'register'],
      },
    },
    writes: [],
    mutationIds: ['register'],
    streamRegistrations: [
      { target, streamKey: delegationStreamKey(target), openedAt: 3 },
    ],
  });
  return { store, writer };
}

function settle(
  writer: ChatDeltaJournalWriter,
  rows: readonly DelegationChildRow[] = [row],
): ReturnType<ChatDeltaJournalWriter['settleDelegationResult']> {
  const request: DelegationTranscriptSettleRequest = {
    target,
    settlementKey: 'settlement',
    resultIndex: 1,
    outcome: { status: 'completed', finishedAt: 20 },
    finalChanges: rows.map((item) => ({ row: item })),
    answer: { role: 'final', text: 'answer only in result' },
  };
  return writer.settleDelegationResult({
    target,
    mutationId: 'settlement-mutation',
    mutationKey: 'settlement',
    finalRows: rows,
    descriptorSettle: { expectedStreamRevision: 0 },
    resultEntry: {
      version: 1,
      kind: 'result',
      resultIndex: 1,
      runGeneration: 0,
      settlementKey: request.settlementKey,
      settlementDigest: delegationTranscriptSettlementDigest(request),
      outcome: request.outcome,
    },
    answerBody: request.answer,
    openRows: 'reject',
  });
}

jest.setTimeout(60_000);

describe('real registry writer admission', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-registry-writer-integration-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('admits a registration-only commit without optional childWrites', async () => {
    const { writer } = await setup(root);
    expect(await writer.childDescriptor(target)).toMatchObject({
      status: 'open',
      streamRevision: 0,
      openedAt: 3,
    });
    expect((await writer.childPage(target)).rows).toEqual([]);
  });

  it('fires publication boundaries exactly once in order and recovers rows, result and admissions atomically', async () => {
    const boundaries: DeltaJournalBoundary[] = [];
    const { store, writer } = await setup(root, boundaries);
    const settled = await settle(writer);
    expect(boundaries.filter((point) => point.startsWith('registry-'))).toEqual(
      ['registry-answer-published', 'registry-settle-admitted'],
    );
    const reopened = await ChatDeltaJournalWriter.open(store);
    expect(await reopened.result({ ...identity, resultIndex: 1 })).toEqual(
      settled.result,
    );
    expect((await reopened.childPage(target)).rows).toEqual([row]);
    expect(
      await reopened.itemAdmission({
        target,
        messageId: row.id,
        itemRevision: row.itemRevision,
      }),
    ).toEqual({
      id: row.id,
      itemRevision: 0,
      admittingStreamRevision: 1,
      mutationKey: 'settlement',
    });
    const view = await openDelegationRegistryReadView(
      { directory: store.directory, scopeId: 'scope' },
      assertChatStorageIndexes,
      { maxManifestVersion: 4 },
    );
    try {
      expect(
        await view.registry.result({ ...identity, resultIndex: 1 }),
      ).toEqual(settled.result);
      expect(await view.descriptor(target)).toMatchObject({
        status: 'settled',
        streamRevision: 1,
        latestRowTimestamp: 10,
        openedAt: 3,
      });
    } finally {
      await view.dispose();
    }
    await reopened.checkpoint();
    expect((await settle(reopened)).settlement.replayed).toBe(true);
  });

  it('validates and reopens a generation-only registry mutation with matching live/archive revisions', async () => {
    const { store, writer } = await setup(root);
    const registered = await writer.registerGeneration({
      mutationId: 'generation-only',
      registration: {
        ...identity,
        runGeneration: 4,
        createdAt: 30,
        store: 'stream',
        origin: { kind: 'follow_up' },
        executionMode: 'background',
      },
    });
    expect(registered.replayed).toBe(false);
    const indexes = writer.indexes();
    assertChatStorageIndexes(indexes);
    expect(indexes.archive.revision).toBe(indexes.live.revision);
    const reopened = await ChatDeltaJournalWriter.open(store);
    expect(
      (await reopened.generation({ ...identity, runGeneration: 4 }))?.entry,
    ).toEqual(registered.entry);
  });

  it('leaves no partially admitted final rows or result after invalid mixed settlement', async () => {
    const { writer } = await setup(root);
    await expect(
      settle(writer, [
        row,
        {
          ...row,
          id: 'bad-new-revision',
          delegationSequence: 1,
          itemRevision: 1,
        },
      ]),
    ).rejects.toThrow();
    expect((await writer.childPage(target)).rows).toEqual([]);
    expect(
      await writer.result({ ...identity, resultIndex: 1 }),
    ).toBeUndefined();
    expect(await writer.childDescriptor(target)).toMatchObject({
      status: 'open',
      streamRevision: 0,
    });
  });
});
