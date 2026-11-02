import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import type { CardStateV1 } from '@canopy/protocol/canopy-core';
import { delegationTranscriptSettlementDigest } from '@canopy/desktop-shared/node/delegation/settlement-identity';
import type { DelegationTranscriptSettleRequest } from '@canopy/desktop-shared/node/delegation/transcript-port';
import {
  assertChatStorageIndexes,
  ChatStorageV2,
} from '../lib/chat-storage-v2';
import {
  ChatDeltaJournalWriter,
  promoteToDeltaJournal,
  promoteToFormat4Journal,
  transitionFormat4ToCheckpointed,
  type DeltaJournalCommitInput,
  type DeltaJournalBoundary,
} from '../lib/chat-delta-journal/writer';
import { streamRegistryPaths } from '../lib/chat-delta-journal/stream-registry';
import { openDelegationRegistryReadView } from '../lib/chat-delta-journal/reader';
import { delegationStreamKey } from '../lib/transcript-stream-paths';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';

type TestTarget = {
  readonly kind: 'delegation';
  readonly chatId: string;
  readonly delegationId: string;
  readonly runGeneration: number;
};

function nextRevision(
  writer: ChatDeltaJournalWriter,
  mutationId: string,
): Pick<DeltaJournalCommitInput, 'expectedRevision' | 'next'> {
  const current = writer.indexes();
  const revision = current.live.revision + 1;
  return {
    expectedRevision: current.live.revision,
    next: {
      live: { ...current.live, revision },
      archive: { ...current.archive, revision },
      recovery: {
        ...current.recovery,
        mutationIds: [...current.recovery.mutationIds, mutationId],
      },
    },
  };
}

async function format4Scope(
  root: string,
  onBoundary?: (boundary: DeltaJournalBoundary) => Promise<void>,
): Promise<{ store: ChatStorageV2; writer: ChatDeltaJournalWriter }> {
  const store = new ChatStorageV2(root, 'scope', undefined, {
    maxManifestVersion: 4,
  });
  await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
  await promoteToDeltaJournal(store);
  const writer = await promoteToFormat4Journal(store, { onBoundary });
  return { store, writer };
}

async function registerStream(
  writer: ChatDeltaJournalWriter,
  target: TestTarget,
): Promise<void> {
  const input = nextRevision(writer, 'register-stream');
  await writer.commit({
    ...input,
    writes: [],
    mutationIds: ['register-stream'],
    streamRegistrations: [
      { target, streamKey: delegationStreamKey(target), openedAt: 3 },
    ],
  });
  expect(await writer.childDescriptor(target)).toMatchObject({ openedAt: 3 });
}

function cardState(finalPreview: string): CardStateV1 {
  return {
    version: 1,
    status: 'running',
    resultIndex: null,
    error: null,
    usage: null,
    workspaceRevision: null,
    workspaceDiscarded: false,
    stopOutcome: null,
    controlOutcome: null,
    attribution: null,
    capabilitySummary: null,
    nestedChildSummary: null,
    partialPreview: null,
    finalPreview,
  };
}

it('journals card-only descriptor revisions with exact replay and checkpoint persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'delta-registry-card-state-'));
  try {
    const { store, writer } = await format4Scope(root);
    const target: TestTarget = {
      kind: 'delegation',
      chatId: 'chat',
      delegationId: 'card-state',
      runGeneration: 0,
    };
    await registerStream(writer, target);
    const update = {
      version: 1 as const,
      target,
      expectedStreamRevision: 0,
      nextStreamRevision: 1,
      cardState: cardState('In progress'),
    };
    const commit = nextRevision(writer, 'card-state-update');
    await expect(
      writer.commit({
        ...commit,
        writes: [],
        mutationIds: ['card-state-update'],
        streamDescriptorUpdates: [{ target, update }],
      }),
    ).resolves.toMatchObject({ applied: true });
    expect(await writer.childDescriptor(target)).toMatchObject({
      streamRevision: 1,
      cardState: update.cardState,
    });

    await expect(
      writer.commit({
        ...nextRevision(writer, 'card-state-update'),
        writes: [],
        mutationIds: ['card-state-update'],
        streamDescriptorUpdates: [{ target, update }],
      }),
    ).resolves.toMatchObject({ applied: false });

    const changed = {
      ...update,
      cardState: cardState('Different content'),
    };
    await expect(
      writer.commit({
        ...nextRevision(writer, 'card-state-update'),
        writes: [],
        mutationIds: ['card-state-update'],
        streamDescriptorUpdates: [{ target, update: changed }],
      }),
    ).rejects.toThrow();

    await writer.checkpoint();
    const descriptorPath = streamRegistryPaths(
      join(store.directory, 'transcripts'),
      target.chatId,
      delegationStreamKey(target),
    ).descriptor;
    const descriptor: unknown = JSON.parse(
      await readFile(descriptorPath, 'utf8'),
    );
    expect(descriptor).toMatchObject({
      streamRevision: 1,
      cardState: update.cardState,
    });
    await transitionFormat4ToCheckpointed(store, { writer });
    expect(await store.format()).toBe('v4');
    expect(await store.journalFile()).toBeUndefined();
    const noJournalDescriptor: unknown = JSON.parse(
      await readFile(descriptorPath, 'utf8'),
    );
    expect(noJournalDescriptor).toMatchObject({
      streamRevision: 1,
      cardState: update.cardState,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('recovers a generation-only registry record across writer restart and checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'delta-registry-generation-'));
  try {
    const { store, writer } = await format4Scope(root);
    const registration = {
      chatId: 'chat',
      delegationId: 'generation-only',
      runGeneration: 3,
      createdAt: 123,
      store: 'stream' as const,
      origin: { kind: 'launch' as const, anchorMessageId: 'anchor' },
      executionMode: 'background' as const,
    };
    const created = await writer.registerGeneration({
      mutationId: 'generation-only-registration',
      registration,
    });
    expect(created).toMatchObject({ replayed: false, entry: registration });

    const originWithOmittedOptionalField = {
      kind: 'launch' as const,
      anchorMessageId: 'anchor',
    };
    Object.defineProperty(originWithOmittedOptionalField, 'authoredItemId', {
      value: undefined,
      enumerable: true,
    });
    const replayableRegistration = {
      ...registration,
      origin: originWithOmittedOptionalField,
    };
    const firstReplayable = await writer.registerGeneration({
      mutationId: 'generation-optional-field',
      registration: {
        ...replayableRegistration,
        delegationId: 'generation-optional',
      },
    });
    const revisionBeforeReplay = writer.revision;
    const recordsBeforeReplay = writer.pendingRecordCount;
    const replayed = await writer.registerGeneration({
      mutationId: 'generation-optional-field-replay',
      registration: {
        ...replayableRegistration,
        delegationId: 'generation-optional',
      },
    });
    expect(replayed.replayed).toBe(true);
    expect(replayed.entry).toEqual(firstReplayable.entry);
    expect(
      Object.prototype.hasOwnProperty.call(
        replayed.entry.origin,
        'authoredItemId',
      ),
    ).toBe(false);
    expect(writer.revision).toBe(revisionBeforeReplay);
    expect(writer.pendingRecordCount).toBe(recordsBeforeReplay);

    const reopened = await ChatDeltaJournalWriter.open(store);
    expect(
      await reopened.generation({
        chatId: registration.chatId,
        delegationId: registration.delegationId,
        runGeneration: registration.runGeneration,
      }),
    ).toMatchObject({ entry: registration, stream: null, result: null });

    await reopened.checkpoint();
    const afterCheckpoint = await ChatDeltaJournalWriter.open(store);
    expect(
      await afterCheckpoint.generation({
        chatId: registration.chatId,
        delegationId: registration.delegationId,
        runGeneration: registration.runGeneration,
      }),
    ).toMatchObject({ entry: registration, stream: null, result: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('publishes answer then admits an atomic settle that survives writer restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'delta-registry-settle-'));
  const boundaries: DeltaJournalBoundary[] = [];
  try {
    const { store, writer } = await format4Scope(root, (boundary) => {
      boundaries.push(boundary);
      return Promise.resolve();
    });
    const target: TestTarget = {
      kind: 'delegation',
      chatId: 'chat',
      delegationId: 'settle-restart',
      runGeneration: 0,
    };
    await registerStream(writer, target);
    boundaries.length = 0;
    const row: DelegationChildRow = {
      ...message(
        'delegated-agent-settle-restart:item',
        'Completed item',
        'assistant',
        42,
      ),
      parentBlockId: 'delegated-agent-settle-restart',
      delegationSequence: 0,
      itemRevision: 0,
      final: true,
    };
    const request: DelegationTranscriptSettleRequest = {
      target,
      settlementKey: 'settlement-key',
      resultIndex: 1,
      outcome: { status: 'completed', finishedAt: 43 },
      finalChanges: [{ row }],
      answer: { role: 'final', text: 'The answer is durable.' },
    };
    const result = await writer.settleDelegationResult({
      target,
      mutationId: 'settlement-mutation',
      mutationKey: 'settlement-item-key',
      finalRows: [row],
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
    expect(
      boundaries.filter(
        (boundary) =>
          boundary === 'registry-answer-published' ||
          boundary === 'registry-settle-admitted',
      ),
    ).toEqual(['registry-answer-published', 'registry-settle-admitted']);
    expect(result.settlement).toMatchObject({
      streamRevision: 1,
      contentRevision: 1,
      finalItemCount: 1,
      replayed: false,
    });
    expect(result.result.answer).toMatchObject({ kind: 'body' });

    const reopened = await ChatDeltaJournalWriter.open(store, {
      onBoundary: (boundary) => {
        boundaries.push(boundary);
        return Promise.resolve();
      },
    });
    expect(
      await reopened.resultBySettlementKey({
        chatId: target.chatId,
        delegationId: target.delegationId,
        settlementKey: request.settlementKey,
      }),
    ).toEqual(result.result);
    await expect(
      reopened.resultAnswerRange({
        chatId: target.chatId,
        delegationId: target.delegationId,
        resultIndex: 1,
        offset: 0,
        limit: 64,
      }),
    ).resolves.toMatchObject({
      text: 'The answer is durable.',
      encoding: 'utf8',
    });
    expect((await reopened.childPage(target)).rows).toEqual([row]);
    expect(await reopened.childDescriptor(target)).toMatchObject({
      status: 'settled',
      streamRevision: 1,
      latestRowTimestamp: 42,
      openedAt: 3,
    });
    expect(
      boundaries.filter(
        (boundary) =>
          boundary === 'registry-answer-published' ||
          boundary === 'registry-settle-admitted',
      ),
    ).toEqual(['registry-answer-published', 'registry-settle-admitted']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('reads an answer range from a checkpoint-only registry view', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'delta-registry-checkpoint-answer-'),
  );
  try {
    const { store, writer } = await format4Scope(root);
    const target: TestTarget = {
      kind: 'delegation',
      chatId: 'chat',
      delegationId: 'checkpoint-answer',
      runGeneration: 0,
    };
    await registerStream(writer, target);
    const row: DelegationChildRow = {
      ...message(
        'delegated-agent-checkpoint-answer:item',
        'Done',
        'assistant',
        42,
      ),
      parentBlockId: 'delegated-agent-checkpoint-answer',
      delegationSequence: 0,
      itemRevision: 0,
      final: true,
    };
    const request: DelegationTranscriptSettleRequest = {
      target,
      settlementKey: 'checkpoint-settlement',
      resultIndex: 1,
      outcome: { status: 'completed', finishedAt: 43 },
      finalChanges: [{ row }],
      answer: { role: 'final', text: 'Checkpoint-only answer body.' },
    };
    await writer.settleDelegationResult({
      target,
      mutationId: 'checkpoint-settlement-mutation',
      mutationKey: 'checkpoint-settlement-item',
      finalRows: [row],
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
    await writer.checkpoint();
    await transitionFormat4ToCheckpointed(store, { writer });

    const view = await openDelegationRegistryReadView(
      { directory: store.directory, scopeId: 'scope' },
      assertChatStorageIndexes,
      { maxManifestVersion: 4 },
    );
    try {
      await expect(
        view.registry.resultAnswerRange({
          chatId: target.chatId,
          delegationId: target.delegationId,
          resultIndex: 1,
          offset: 0,
          limit: 64,
        }),
      ).resolves.toMatchObject({
        text: 'Checkpoint-only answer body.',
        encoding: 'utf8',
      });
    } finally {
      await view.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
