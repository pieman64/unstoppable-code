import { mkdtemp, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DelegationTranscriptReceiptEntry,
  DelegationTranscriptResultEntry,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import {
  ChatStorageV2,
  assertChatStorageIndexes,
} from '../lib/chat-storage-v2';
import { ChatStorageTransactions } from '../lib/chat-storage-transactions';
import { ChatArtifactMaintenance } from '../lib/chat-artifact-maintenance';
import {
  ChatTranscriptArtifacts,
  CreatedArtifacts,
} from '../lib/chat-transcript-artifacts';
import { DelegationRegistryStore } from '../lib/chat-delta-journal/delegation-registry-store';
import {
  promoteToDeltaJournal,
  promoteToFormat4Journal,
} from '../lib/chat-delta-journal/writer';
import { openDelegationRegistryReadView } from '../lib/chat-delta-journal/reader';
import { scopeSource, treeDigests } from './helpers/chat-delta-journal-harness';

const identity = { chatId: 'chat', delegationId: 'child' };
const target = {
  kind: 'delegation',
  chatId: 'chat',
  delegationId: 'child',
  runGeneration: 0,
} as const;

async function sourceAt(
  root: string,
): Promise<{ store: ChatStorageV2; entry: DelegationTranscriptResultEntry }> {
  const store = new ChatStorageV2(root, 'source', undefined, {
    maxManifestVersion: 4,
  });
  await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
  await promoteToDeltaJournal(store);
  const writer = await promoteToFormat4Journal(store);
  await writer.checkpoint();
  const transcriptsRoot = join(store.directory, 'transcripts');
  const artifacts = new ChatTranscriptArtifacts(transcriptsRoot);
  const ref = await artifacts.put(
    'chat',
    'answer with no transcript row\n'.repeat(50),
  );
  const entry: DelegationTranscriptResultEntry = {
    version: 1,
    kind: 'result',
    resultIndex: 1,
    runGeneration: 0,
    settlementKey: 'settlement',
    settlementDigest: '1'.repeat(64),
    outcome: { status: 'completed', finishedAt: 10 },
    answer: {
      kind: 'body',
      role: 'final',
      ref,
      byteLength: ref.byteLength,
      sha256: ref.sha256,
      encoding: ref.encoding === 'utf-8' ? 'utf8' : 'utf16le',
    },
    settlement: {
      streamRevision: 1,
      contentRevision: 1,
      finalItemCount: 0,
      finalItemsDigest: '0'.repeat(64),
    },
  };
  const registry = new DelegationRegistryStore(transcriptsRoot);
  await registry.append('chat', [{ kind: 'delegation-result', target, entry }]);
  await registry.checkpoint(await registry.highWater(identity));
  return { store, entry };
}

describe('checkpointed delegation answer closure', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-registry-closure-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('retains answer-only bodies, reclaims orphans, and changes the maintenance identity', async () => {
    const { store, entry } = await sourceAt(root);
    if (entry.answer.kind !== 'body') throw new Error('body expected');
    const transactions = new ChatStorageTransactions(store);
    transactions.setDeltaJournalClear(() => true);
    const maintenance = new ChatArtifactMaintenance(
      transactions,
      store.directory,
    );
    try {
      await transactions.transcripts.artifacts.put('chat', 'orphan');
      let complete = false;
      for (let attempt = 0; attempt < 64 && !complete; attempt++)
        complete = (await maintenance.maintain('chat', 1024)).complete;
      expect(complete).toBe(true);
      await expect(
        transactions.transcripts.artifacts.verify('chat', entry.answer.ref),
      ).resolves.toBeUndefined();
      expect(
        await readdir(
          join(store.directory, 'transcripts', 'tool-output', 'chat'),
        ),
      ).toEqual([`${entry.answer.ref.artifactId}.txt`]);
      const before = await transactions.childArtifactSnapshot('chat');
      const registry = new DelegationRegistryStore(
        join(store.directory, 'transcripts'),
      );
      await registry.append('chat', [
        {
          kind: 'delegation-generation',
          identity,
          entry: {
            version: 1,
            kind: 'generation',
            chatId: 'chat',
            delegationId: 'child',
            runGeneration: 1,
            createdAt: 20,
            store: 'stream',
            origin: { kind: 'follow_up' },
            executionMode: 'background',
          },
        },
      ]);
      await registry.checkpoint(await registry.highWater(identity));
      expect(
        (await transactions.childArtifactSnapshot('chat')).identity,
      ).not.toBe(before.identity);
    } finally {
      await maintenance.dispose();
    }
  });

  it('charges registry records that carry no answer against the slice budget', async () => {
    const { store, entry } = await sourceAt(root);
    if (entry.answer.kind !== 'body') throw new Error('body expected');
    const registry = new DelegationRegistryStore(
      join(store.directory, 'transcripts'),
    );
    const generations = 200;
    await registry.append(
      'chat',
      Array.from({ length: generations }, (_, index) => ({
        kind: 'delegation-generation' as const,
        identity,
        entry: {
          version: 1 as const,
          kind: 'generation' as const,
          chatId: 'chat',
          delegationId: 'child',
          runGeneration: index + 1,
          createdAt: 20 + index,
          store: 'stream' as const,
          origin: { kind: 'follow_up' as const },
          executionMode: 'background' as const,
        },
      })),
    );
    await registry.checkpoint(await registry.highWater(identity));
    const transactions = new ChatStorageTransactions(store);
    transactions.setDeltaJournalClear(() => true);
    const maintenance = new ChatArtifactMaintenance(
      transactions,
      store.directory,
    );
    try {
      let slices = 0;
      let complete = false;
      while (!complete && slices < 1_000) {
        complete = (await maintenance.maintain('chat', 1024)).complete;
        slices += 1;
      }
      expect(complete).toBe(true);
      // 1 KiB charges two 512-byte records per slice, answer or not.
      expect(slices).toBeGreaterThan(generations / 2);
      await expect(
        transactions.transcripts.artifacts.verify('chat', entry.answer.ref),
      ).resolves.toBeUndefined();
    } finally {
      await maintenance.dispose();
    }
  }, 60_000);

  it('carries answer-only bodies through archive/copy and restore without the source', async () => {
    const { store, entry } = await sourceAt(root);
    if (entry.answer.kind !== 'body') throw new Error('body expected');
    const archive = new ChatStorageV2(root, 'archive', undefined, {
      maxManifestVersion: 4,
    });
    await store.copyTo(archive);
    const restored = new ChatStorageV2(root, 'restored', undefined, {
      maxManifestVersion: 4,
    });
    await archive.copyTo(restored);
    await rm(store.directory, { recursive: true, force: true });
    await rm(archive.directory, { recursive: true, force: true });
    await expect(
      new ChatTranscriptArtifacts(
        join(restored.directory, 'transcripts'),
        true,
      ).verify('chat', entry.answer.ref),
    ).resolves.toBeUndefined();
    expect(
      await new DelegationRegistryStore(
        join(restored.directory, 'transcripts'),
      ).result({ ...identity, resultIndex: 1 }),
    ).toEqual(entry);
    const before = await treeDigests(restored.directory);
    const view = await openDelegationRegistryReadView(
      { directory: restored.directory, scopeId: 'restored' },
      assertChatStorageIndexes,
      { maxManifestVersion: 4 },
    );
    try {
      expect(
        await view.registry.result({ ...identity, resultIndex: 1 }),
      ).toEqual(entry);
      expect(await view.descriptor(target)).toBeUndefined();
      const range = await view.registry.resultAnswerRange({
        ...identity,
        resultIndex: 1,
        offset: 0,
        limit: 64,
      });
      expect(range.text).toContain('answer with no transcript');
      expect(range.byteLength).toBe(entry.answer.byteLength);
    } finally {
      await view.dispose();
    }
    expect(await treeDigests(restored.directory)).toEqual(before);
  }, 30_000);

  it('retains receipt-only owners through archive/copy/restore and charges maintenance without descriptors', async () => {
    const source = new ChatStorageV2(root, 'receipt-source', undefined, {
      maxManifestVersion: 4,
    });
    await source.migrate(scopeSource([{ id: 'chat', messages: [] }]));
    await promoteToDeltaJournal(source);
    const writer = await promoteToFormat4Journal(source);
    await writer.checkpoint();
    const registry = new DelegationRegistryStore(
      join(source.directory, 'transcripts'),
    );
    const owner = { kind: 'chat_receipts', chatId: 'chat' } as const;
    const receipt: DelegationTranscriptReceiptEntry = {
      version: 1,
      kind: 'receipt',
      chatId: 'chat',
      receiptKind: 'stop',
      key: 'a'.repeat(64),
      delegationId: 'child',
      runGeneration: 1,
      operationId: '12345678-1234-4234-8234-123456789abc',
      requestHash: 'b'.repeat(64),
      operation: 'stop',
      admittedAt: 10,
      reply: { kind: 'stop', ackStatus: 'accepted', runGeneration: 1 },
    };
    const count = 10;
    await registry.append(
      'chat',
      Array.from({ length: count }, (_, index) => ({
        kind: 'delegation-receipt' as const,
        owner,
        entry: { ...receipt, key: index.toString(16).padStart(64, '0') },
      })),
    );
    await registry.checkpoint(await registry.highWater(owner));
    const archive = new ChatStorageV2(root, 'receipt-archive', undefined, {
      maxManifestVersion: 4,
    });
    await source.copyTo(archive);
    const restored = new ChatStorageV2(root, 'receipt-restored', undefined, {
      maxManifestVersion: 4,
    });
    await archive.copyTo(restored);
    await rm(source.directory, { recursive: true, force: true });
    await rm(archive.directory, { recursive: true, force: true });
    const before = await treeDigests(restored.directory);
    const view = await openDelegationRegistryReadView(
      { directory: restored.directory, scopeId: 'receipt-restored' },
      assertChatStorageIndexes,
      { maxManifestVersion: 4 },
    );
    try {
      expect(
        await view.registry.receipt({
          chatId: 'chat',
          receiptKind: 'stop',
          key: '0'.repeat(64),
        }),
      ).toEqual({ ...receipt, key: '0'.repeat(64) });
      expect((await view.registry.highWater(owner)).highWater).toBe(count);
      expect(await view.descriptor(target)).toBeUndefined();
    } finally {
      await view.dispose();
    }
    expect(await treeDigests(restored.directory)).toEqual(before);
    // GC only needs a canonical reference scan when there is a candidate.
    await new ChatTranscriptArtifacts(
      join(restored.directory, 'transcripts'),
    ).put('chat', 'orphan receipt fixture');
    const transactions = new ChatStorageTransactions(restored);
    transactions.setDeltaJournalClear(() => true);
    const maintenance = new ChatArtifactMaintenance(
      transactions,
      restored.directory,
    );
    try {
      let slices = 0;
      let complete = false;
      while (!complete && slices < 100) {
        complete = (await maintenance.maintain('chat', 1024)).complete;
        slices += 1;
      }
      expect(complete).toBe(true);
      expect(slices).toBeGreaterThan(count / 2);
    } finally {
      await maintenance.dispose();
    }
  }, 30_000);

  it('refuses capture when a known answer-only body is missing', async () => {
    const { store, entry } = await sourceAt(root);
    if (entry.answer.kind !== 'body') throw new Error('body expected');
    await unlink(
      join(
        store.directory,
        'transcripts',
        'tool-output',
        'chat',
        `${entry.answer.ref.artifactId}.txt`,
      ),
    );
    await expect(
      store.copyTo(
        new ChatStorageV2(root, 'broken-copy', undefined, {
          maxManifestVersion: 4,
        }),
      ),
    ).rejects.toThrow();
  });
});

it('does not discard a content-addressed answer reused by a later failed transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-registry-reused-answer-'));
  try {
    const { store, entry } = await sourceAt(root);
    if (entry.answer.kind !== 'body') throw new Error('body expected');
    const artifacts = new ChatTranscriptArtifacts(
      join(store.directory, 'transcripts'),
    );
    const created = new CreatedArtifacts();
    const reused = await artifacts.put(
      'chat',
      'answer with no transcript row\n'.repeat(50),
      created,
    );
    expect(reused).toEqual(entry.answer.ref);
    expect(created.size).toBe(0);
    await created.discard();
    await expect(
      artifacts.verify('chat', entry.answer.ref),
    ).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
