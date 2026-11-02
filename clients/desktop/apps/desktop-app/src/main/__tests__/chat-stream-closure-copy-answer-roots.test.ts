import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  CardStateCanonical,
  TranscriptStreamDescriptor,
  TranscriptTarget,
} from '@canopy/protocol/canopy-core';
import { ChatArtifactMaintenance } from '../lib/chat-artifact-maintenance';
import { ChatStorageTransactions } from '../lib/chat-storage-transactions';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import {
  applyStreamDescriptorUpdate,
  encodeStreamDescriptor,
  parseStreamDescriptor,
  streamRegistryPaths,
} from '../lib/chat-delta-journal/stream-registry';
import { delegationStreamKey } from '../lib/transcript-stream-paths';
import { format4Scope } from './helpers/chat-format4-scope';
import { scopeSource } from './helpers/chat-delta-journal-harness';

const answerText = 'settled answer only in descriptor metadata';
const target: Extract<TranscriptTarget, { kind: 'delegation' }> = {
  kind: 'delegation',
  chatId: 'chat',
  delegationId: 'delegate',
  runGeneration: 1,
};

async function seedDescriptorOnlyAnswer(
  root: string,
  answerField: 'finalTextRef' | 'partialTextRef' = 'finalTextRef',
): Promise<{
  store: ChatStorageV2;
  transactions: ChatStorageTransactions;
  answerPath: string;
  answerBytes: Buffer;
}> {
  const { store, backend } = await format4Scope(
    root,
    'source',
    scopeSource([{ id: 'chat', messages: [] }]),
  );
  await backend.registerTranscriptStream(target);
  await backend.demoteFromDeltaJournal();

  const transactions = new ChatStorageTransactions(store);
  const answer = await transactions.transcripts.artifacts.put(
    'chat',
    answerText,
  );
  const streamRoot = join(store.directory, 'transcripts');
  const paths = streamRegistryPaths(
    streamRoot,
    target.chatId,
    delegationStreamKey(target),
  );
  const initialDescriptor = parseStreamDescriptor(
    await readFile(paths.descriptor),
  );
  const canonical: CardStateCanonical =
    answerField === 'finalTextRef'
      ? {
          status: 'completed',
          resultIndex: 1,
          finalText: answerText,
          finalTextRef: answer,
        }
      : {
          status: 'completed',
          resultIndex: 1,
          partialText: answerText,
          partialTextRef: answer,
        };
  const cardState: NonNullable<TranscriptStreamDescriptor['cardState']> = {
    version: 2,
    cardRevision: 1,
    canonical,
  };
  const nextStreamRevision = initialDescriptor.streamRevision + 1;
  const descriptor = applyStreamDescriptorUpdate(initialDescriptor, {
    version: 1,
    target,
    expectedStreamRevision: initialDescriptor.streamRevision,
    nextStreamRevision,
    status: 'settled',
    cardState,
    settleReceipt: {
      mutationId: 'descriptor-answer-settlement',
      scopeRevision: initialDescriptor.checkpointRevision,
      streamRevision: nextStreamRevision,
      committedRowCount: initialDescriptor.committedRowCount,
      committedByteLength: initialDescriptor.committedByteLength,
      committedSha256: initialDescriptor.committedSha256,
    },
  });
  await writeFile(paths.descriptor, encodeStreamDescriptor(descriptor));

  const answerPath = join(
    store.directory,
    'transcripts',
    'tool-output',
    target.chatId,
    `${answer.artifactId}.txt`,
  );
  return {
    store,
    transactions,
    answerPath,
    answerBytes: await readFile(answerPath),
  };
}

describe('descriptor answer roots for stream closure copies', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-stream-answer-roots-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ['final', 'finalTextRef'],
    ['partial', 'partialTextRef'],
  ] as const)(
    'keeps a descriptor-only %s answer body during artifact maintenance',
    async (_answerName, answerField) => {
      const seeded = await seedDescriptorOnlyAnswer(root, answerField);
      const maintenance = new ChatArtifactMaintenance(
        seeded.transactions,
        seeded.store.directory,
      );
      try {
        let complete = false;
        for (let attempt = 0; attempt < 32 && !complete; attempt++)
          complete = (await maintenance.maintain('chat', 1024)).complete;

        expect(complete).toBe(true);
        await expect(readFile(seeded.answerPath)).resolves.toEqual(
          seeded.answerBytes,
        );
      } finally {
        await maintenance.dispose();
      }
    },
  );

  it.each([
    ['final', 'finalTextRef'],
    ['partial', 'partialTextRef'],
  ] as const)(
    'retains descriptor-only %s answer bodies after source deletion and a second capture',
    async (_answerName, answerField) => {
      const seeded = await seedDescriptorOnlyAnswer(root, answerField);
      const destination = new ChatStorageV2(
        join(root, 'captured'),
        'copy',
        undefined,
        { maxManifestVersion: 4 },
      );

      await seeded.store.copyTo(destination);

      const indexes = await seeded.store.indexes();
      const expectedRevision = indexes.live.revision;
      indexes.live.tabs = indexes.live.tabs.filter((tab) => tab.id !== 'chat');
      indexes.live.activeTabId = indexes.live.tabs[0]?.id ?? '';
      delete indexes.live.runtimeByChatId.chat;
      indexes.live.revision += 1;
      indexes.archive.revision = indexes.live.revision;
      indexes.recovery.removedTabIds = [
        ...indexes.recovery.removedTabIds,
        'chat',
      ];
      await seeded.transactions.commit(expectedRevision, indexes, [
        { chatId: 'chat', kind: 'delete' },
      ]);
      await expect(readFile(seeded.answerPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const secondCapture = new ChatStorageV2(
        join(root, 'second-capture'),
        'copy-2',
        undefined,
        { maxManifestVersion: 4 },
      );
      await destination.copyTo(secondCapture);

      const capturedAnswerPath = join(
        secondCapture.directory,
        'transcripts',
        'tool-output',
        target.chatId,
        basename(seeded.answerPath),
      );
      await expect(readFile(capturedAnswerPath)).resolves.toEqual(
        seeded.answerBytes,
      );
    },
  );
});
