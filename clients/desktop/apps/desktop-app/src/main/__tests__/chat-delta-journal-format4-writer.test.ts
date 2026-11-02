import { createHash } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import {
  ChatDeltaJournalWriter,
  promoteToDeltaJournal,
  promoteToFormat4Journal,
  transitionFormat4ToCheckpointed,
  type DeltaJournalBoundary,
} from '../lib/chat-delta-journal/writer';
import {
  message,
  toolMessage,
  scopeSource,
  treeDigests,
} from './helpers/chat-delta-journal-harness';
import { TOOL_OUTPUT_INLINE_BYTES } from '@canopy/agent-transcript/transcript-storage';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import { TranscriptStreamStore } from '../lib/chat-transcript-log';
import { ChatTranscriptArtifacts } from '../lib/chat-transcript-artifacts';
import { assertChatStorageIndexes } from '../lib/chat-storage-v2';
import { openReplayedChatScope } from '../lib/chat-delta-journal/reader';
import * as streamRegistry from '../lib/chat-delta-journal/stream-registry';
import { delegationStreamKey } from '../lib/transcript-stream-paths';
import {
  ChatDeltaJournalIntegrityError,
  decodeDeltaJournalV2Record,
  type DeltaJournalFrame,
  type DeltaJournalV2Record,
} from '../lib/chat-delta-journal/format';
import {
  parseStreamCatalog,
  parseStreamRegistry,
  streamCatalogPath,
  streamRegistryPaths,
} from '../lib/chat-delta-journal/stream-registry';

async function collectPendingChildArtifactRefs(
  writer: ChatDeltaJournalWriter,
): Promise<Array<{ parentChatId: string; path: string }>> {
  const references: Array<{ parentChatId: string; path: string }> = [];
  for await (const reference of writer.pendingChildArtifactRefs())
    references.push(reference);
  return references;
}

function decodeChildRowEffect(row: unknown): DeltaJournalV2Record {
  const record = {
    type: 'commit',
    v: 2,
    prev: '0'.repeat(64),
    fromRevision: 0,
    toRevision: 1,
    mutationIds: ['child'],
    delta: {},
    transcripts: [
      {
        kind: 'child-upsert',
        target: {
          kind: 'delegation',
          chatId: 'chat',
          delegationId: 'child',
          runGeneration: 0,
        },
        rows: [row],
      },
    ],
    streamRegistrations: [],
    descriptorUpdates: [],
  };
  const frame: DeltaJournalFrame = {
    offset: 0,
    end: 0,
    digest: '',
    payload: Buffer.from(JSON.stringify(record)),
  };
  return decodeDeltaJournalV2Record(frame);
}

async function format4Scope(
  root: string,
): Promise<{ store: ChatStorageV2; writer: ChatDeltaJournalWriter }> {
  const store = new ChatStorageV2(root, 'scope', undefined, {
    maxManifestVersion: 4,
  });
  await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
  await promoteToDeltaJournal(store);
  const writer = await promoteToFormat4Journal(store);
  return { store, writer };
}

it('transitions format 4 with an open writer and retires that generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'format4-writer-'));
  try {
    const { store, writer } = await format4Scope(root);
    expect(writer.isOpen()).toBe(true);
    expect(await transitionFormat4ToCheckpointed(store, { writer })).toBe(true);
    expect(writer.isOpen()).toBe(false);
    const manifest: unknown = JSON.parse(
      await readFile(store.manifestPath, 'utf8'),
    );
    expect(manifest).toEqual(
      expect.objectContaining({ version: 4, cleanupComplete: true }),
    );
    expect(
      typeof manifest === 'object' &&
        manifest !== null &&
        'journal' in manifest,
    ).toBe(false);
    expect(await store.format()).toBe('v4');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each<DeltaJournalBoundary>([
  'catalog-temp-written',
  'catalog-temp-synced',
  'segment-temp-written',
  'segment-temp-synced',
  'segment-renamed',
  'segment-directory-synced',
  'manifest-temp-written',
  'manifest-temp-synced',
  'manifest-published',
  'manifest-directory-synced',
  'writer-reopened',
])('promotion retries safely after %s', async (seam) => {
  const root = await mkdtemp(join(tmpdir(), 'format4-promote-fault-'));
  try {
    const store = new ChatStorageV2(root, 'scope', undefined, {
      maxManifestVersion: 4,
    });
    await store.migrate(
      scopeSource([
        { id: 'chat', messages: [message('m1', 'one'), message('m2', 'two')] },
      ]),
    );
    await promoteToDeltaJournal(store);
    const primary = (): Promise<Record<string, string>> =>
      treeDigests(join(store.directory, 'transcripts'), (name) =>
        name.startsWith('delegations/'),
      );
    const before = await primary();
    const old = await ChatDeltaJournalWriter.open(store);
    await expect(
      promoteToFormat4Journal(store, {
        writer: old,
        onBoundary: (point) =>
          point === seam
            ? Promise.reject(new Error(`fault:${seam}`))
            : Promise.resolve(),
      }),
    ).rejects.toThrow(`fault:${seam}`);
    expect(old.isOpen()).toBe(false);
    const version = await store.format();
    if (seam.startsWith('catalog-')) expect(version).toBe('v3');
    else expect(['v3', 'v4']).toContain(version);
    // Resume twice: the first retry completes, the second is a re-open.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reopened = await promoteToFormat4Journal(store);
      expect(reopened.isOpen()).toBe(true);
      expect(await store.format()).toBe('v4');
    }
    expect(await primary()).toEqual(before);
    const indexes = await store.indexes();
    expect(indexes.live.tabs.map((tab) => tab.id)).toEqual(['chat']);
    await expect(
      old.commit({
        expectedRevision: indexes.live.revision,
        next: indexes,
        writes: [],
        mutationIds: ['stale-writer'],
      }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('journals registration without forcing a primary-row checkpoint, then publishes metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'format4-register-'));
  try {
    const { store, writer } = await format4Scope(root);
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'delegate',
      runGeneration: 0,
    };
    const streamKey = delegationStreamKey(target);
    const current = writer.indexes();
    const revision = current.live.revision + 1;
    await writer.commit({
      expectedRevision: current.live.revision,
      next: {
        live: { ...current.live, revision },
        archive: { ...current.archive, revision },
        recovery: {
          ...current.recovery,
          mutationIds: [...current.recovery.mutationIds, 'register'],
        },
      },
      writes: [],
      mutationIds: ['register'],
      streamRegistrations: [{ target, streamKey }],
    });
    expect(writer.hasCommittedRowChanges()).toBe(false);
    expect(writer.pendingRecordCount).toBe(1);
    expect(writer.pendingPrimaryRecordCount()).toBe(0);
    expect(writer.childOpenBytes()).toBe(0);
    expect(Array.from(writer.childTargets())).toEqual([target]);
    expect(await collectPendingChildArtifactRefs(writer)).toEqual([]);
    await writer.checkpoint();
    expect(Array.from(writer.childTargets())).toEqual([target]);
    const registryPath = streamRegistryPaths(
      join(store.directory, 'transcripts'),
      'chat',
      streamKey,
    );
    expect(
      parseStreamRegistry(await readFile(registryPath.registry), 'chat')
        .entries,
    ).toHaveLength(1);
    expect(
      parseStreamCatalog(
        await readFile(streamCatalogPath(join(store.directory, 'transcripts'))),
      ).parents.chat?.entryCount,
    ).toBe(1);
    await rm(registryPath.index, { force: true });
    const beforeRead = await treeDigests(store.directory);
    const view = await openReplayedChatScope(
      { directory: store.directory, scopeId: 'scope' },
      assertChatStorageIndexes,
      { maxManifestVersion: 4 },
    );
    expect(view.streamRegistrations).toHaveLength(1);
    expect(await view.stream(target)).toEqual({ rows: [] });
    await view.dispose();
    expect(await treeDigests(store.directory)).toEqual(beforeRead);
    const next = writer.indexes();
    const laterRevision = next.live.revision + 1;
    await writer.commit({
      expectedRevision: next.live.revision,
      next: {
        live: { ...next.live, revision: laterRevision },
        archive: { ...next.archive, revision: laterRevision },
        recovery: {
          ...next.recovery,
          mutationIds: [...next.recovery.mutationIds, 'later'],
        },
      },
      writes: [],
      mutationIds: ['later'],
    });
    await writer.checkpoint();
    const laterView = await openReplayedChatScope(
      { directory: store.directory, scopeId: 'scope' },
      assertChatStorageIndexes,
      { maxManifestVersion: 4 },
    );
    expect(laterView.streamRegistrations).toHaveLength(1);
    await laterView.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects delegation content before publishing a frame', async () => {
  const root = await mkdtemp(join(tmpdir(), 'format4-child-refusal-'));
  try {
    const { store, writer } = await format4Scope(root);
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'd',
      runGeneration: 0,
    };
    const current = writer.indexes();
    const before = await readFile(
      join(store.directory, 'delta-journal-v2.log'),
    );
    const revision = current.live.revision + 1;
    await expect(
      writer.commit({
        expectedRevision: current.live.revision,
        next: {
          live: { ...current.live, revision },
          archive: { ...current.archive, revision },
          recovery: {
            ...current.recovery,
            mutationIds: [...current.recovery.mutationIds, 'child'],
          },
        },
        writes: [
          {
            chatId: 'chat',
            target,
            kind: 'append',
            messages: [message('child-row', 'content')],
          },
        ],
        mutationIds: ['child'],
      }),
    ).rejects.toThrow('Delegation transcript content is not supported');
    expect(
      await readFile(join(store.directory, 'delta-journal-v2.log')),
    ).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('journals a registered child row without changing the parent transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'format4-child-upsert-'));
  try {
    const { store, writer } = await format4Scope(root);
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'd',
      runGeneration: 0,
    };
    const register = writer.indexes();
    await writer.commit({
      expectedRevision: register.live.revision,
      next: {
        live: { ...register.live, revision: register.live.revision + 1 },
        archive: { ...register.archive, revision: register.live.revision + 1 },
        recovery: {
          ...register.recovery,
          mutationIds: [...register.recovery.mutationIds, 'register-child'],
        },
      },
      writes: [],
      mutationIds: ['register-child'],
      streamRegistrations: [{ target, streamKey: delegationStreamKey(target) }],
    });
    const parentRevision =
      writer.indexes().live.tabs[0].transcript?.transcriptRevision;
    const current = writer.indexes();
    await writer.commit({
      expectedRevision: current.live.revision,
      next: {
        live: { ...current.live, revision: current.live.revision + 1 },
        archive: { ...current.archive, revision: current.live.revision + 1 },
        recovery: {
          ...current.recovery,
          mutationIds: [...current.recovery.mutationIds, 'upsert-child'],
        },
      },
      writes: [],
      mutationIds: ['upsert-child'],
      childWrites: [
        {
          target,
          rows: [
            {
              ...message('delegated-agent-d:item', 'hello'),
              parentBlockId: 'delegated-agent-d',
              delegationSequence: 0,
              itemRevision: 0,
              final: false,
            },
          ],
        },
      ],
    });
    expect(writer.pendingPrimaryRecordCount()).toBe(0);
    expect(writer.childOpenBytes()).toBeGreaterThan(0);
    expect(writer.hasCommittedRowChanges()).toBe(false);
    expect(writer.indexes().live.tabs[0].transcript?.transcriptRevision).toBe(
      parentRevision,
    );
    expect(writer.pendingRecordCount).toBe(2);
    const pendingView = await openReplayedChatScope(
      { directory: store.directory, scopeId: 'scope' },
      assertChatStorageIndexes,
      { maxManifestVersion: 4 },
    );
    expect(
      (await pendingView.stream(target)).rows.map((row) => row.id),
    ).toEqual(['delegated-agent-d:item']);
    await pendingView.dispose();
    await writer.checkpoint();
    const paths = streamRegistryPaths(
      join(store.directory, 'transcripts'),
      'chat',
      delegationStreamKey(target),
    );
    const descriptor: unknown = JSON.parse(
      await readFile(paths.descriptor, 'utf8'),
    );
    expect(descriptor).toEqual(
      expect.objectContaining({ committedRowCount: 0 }),
    );
    const sidecar = await readFile(
      `${paths.streamDirectory}/transcript.active.json`,
      'utf8',
    );
    expect(sidecar).toContain('delegated-agent-d:item');
    const afterOpen = writer.indexes();
    await writer.commit({
      expectedRevision: afterOpen.live.revision,
      next: {
        live: { ...afterOpen.live, revision: afterOpen.live.revision + 1 },
        archive: {
          ...afterOpen.archive,
          revision: afterOpen.live.revision + 1,
        },
        recovery: {
          ...afterOpen.recovery,
          mutationIds: [...afterOpen.recovery.mutationIds, 'final-child'],
        },
      },
      writes: [],
      mutationIds: ['final-child'],
      childWrites: [
        {
          target,
          rows: [
            {
              ...message('delegated-agent-d:item', 'hello'),
              parentBlockId: 'delegated-agent-d',
              delegationSequence: 0,
              itemRevision: 1,
              final: true,
            },
          ],
        },
      ],
    });
    await writer.checkpoint();
    const committed = await readFile(paths.log, 'utf8');
    expect(committed.trim().split('\n')).toHaveLength(1);
    expect(committed).toContain('"itemRevision":1');
    await writer.checkpoint();
    expect(await readFile(paths.log, 'utf8')).toBe(committed);
    const replayIndexes = writer.indexes();
    const replayRow = {
      ...message('delegated-agent-d:item', 'hello'),
      parentBlockId: 'delegated-agent-d',
      delegationSequence: 0,
      itemRevision: 1,
      final: true,
    };
    expect(
      await writer.commit({
        expectedRevision: 0,
        next: replayIndexes,
        writes: [],
        mutationIds: ['final-child'],
        childWrites: [{ target, rows: [replayRow] }],
      }),
    ).toEqual({ applied: false, revision: replayIndexes.live.revision });
    await expect(
      writer.commit({
        expectedRevision: 0,
        next: replayIndexes,
        writes: [],
        mutationIds: ['final-child'],
        childWrites: [
          {
            target,
            rows: [
              { ...replayRow, blocks: [{ type: 'text', text: 'conflict' }] },
            ],
          },
        ],
      }),
    ).rejects.toThrow('Final child row is immutable');
    void store;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('pages a checkpointed child stream from its sequence index without changing source bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'format4-child-page-'));
  try {
    const { store, writer } = await format4Scope(root);
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'many',
      runGeneration: 0,
    };
    const current = writer.indexes();
    await writer.commit({
      expectedRevision: current.live.revision,
      next: {
        live: { ...current.live, revision: current.live.revision + 1 },
        archive: { ...current.archive, revision: current.live.revision + 1 },
        recovery: {
          ...current.recovery,
          mutationIds: [...current.recovery.mutationIds, 'many'],
        },
      },
      writes: [],
      mutationIds: ['many'],
      streamRegistrations: [{ target, streamKey: delegationStreamKey(target) }],
      childWrites: [
        {
          target,
          rows: Array.from({ length: 1001 }, (_, sequence) => ({
            ...message(`delegated-agent-many:item-${sequence}`, 'x'),
            parentBlockId: 'delegated-agent-many',
            delegationSequence: sequence,
            itemRevision: 0,
            final: true,
          })),
        },
      ],
    });
    await writer.checkpoint();
    const paths = streamRegistryPaths(
      join(store.directory, 'transcripts'),
      'chat',
      delegationStreamKey(target),
    );
    expect(
      (await stat(`${paths.streamDirectory}/transcript.sequence-index.json`))
        .size,
    ).toBeGreaterThan(0);
    const before = await treeDigests(store.directory);
    const view = await openReplayedChatScope(
      { directory: store.directory, scopeId: 'scope' },
      assertChatStorageIndexes,
      { maxManifestVersion: 4 },
    );
    const page = await view.stream(target, { limit: 100 });
    expect(page.rows).toHaveLength(100);
    expect(page.rows[0].delegationSequence).toBe(901);
    expect(page.nextBefore).toBe(901);
    await view.dispose();
    expect(await treeDigests(store.directory)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('recognizes an identical externalized child tool row replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'format4-child-tool-replay-'));
  try {
    const { writer } = await format4Scope(root);
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'tool',
      runGeneration: 0,
    };
    const current = writer.indexes();
    const row = {
      ...toolMessage(
        'delegated-agent-tool:item',
        'x'.repeat(TOOL_OUTPUT_INLINE_BYTES + 1024),
      ),
      parentBlockId: 'delegated-agent-tool',
      delegationSequence: 0,
      itemRevision: 0,
      final: true,
    };
    const first = await writer.commit({
      expectedRevision: current.live.revision,
      next: {
        live: { ...current.live, revision: current.live.revision + 1 },
        archive: { ...current.archive, revision: current.live.revision + 1 },
        recovery: {
          ...current.recovery,
          mutationIds: [...current.recovery.mutationIds, 'tool-first'],
        },
      },
      writes: [],
      mutationIds: ['tool-first'],
      streamRegistrations: [{ target, streamKey: delegationStreamKey(target) }],
      childWrites: [{ target, rows: [row] }],
    });
    expect(first.applied).toBe(true);
    const references = await collectPendingChildArtifactRefs(writer);
    expect(references).toHaveLength(1);
    expect(references[0]?.parentChatId).toBe('chat');
    expect(references[0]?.path).toMatch(
      /^transcripts\/tool-output\/chat\/sha256-v1-.*\.txt$/,
    );
    await writer.checkpoint();
    const afterCheckpoint = writer.indexes();
    const evictIds = Array.from(
      { length: 4096 },
      (_, index) => `evict-${index}`,
    );
    await writer.commit({
      expectedRevision: afterCheckpoint.live.revision,
      next: {
        live: {
          ...afterCheckpoint.live,
          revision: afterCheckpoint.live.revision + 1,
        },
        archive: {
          ...afterCheckpoint.archive,
          revision: afterCheckpoint.live.revision + 1,
        },
        recovery: { ...afterCheckpoint.recovery, mutationIds: evictIds },
      },
      writes: [],
      mutationIds: evictIds,
    });
    expect(writer.hasMutation('tool-first')).toBe(false);
    expect(writer.pendingPrimaryRecordCount()).toBe(0);
    const before = writer.journalBytes;
    expect(
      await writer.commit({
        expectedRevision: current.live.revision,
        next: writer.indexes(),
        writes: [],
        mutationIds: ['tool-first'],
        childWrites: [{ target, rows: [row] }],
      }),
    ).toEqual({ applied: false, revision: writer.revision });
    expect(writer.journalBytes).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('accepts valid paged child references but rejects malformed reference shapes', () => {
  const sha256 = 'a'.repeat(64);
  const row = {
    id: 'child:item',
    role: 'assistant',
    timestamp: 1,
    parentBlockId: 'child',
    delegationSequence: 0,
    blocks: [],
    blocksRef: {
      version: 1,
      manifest: {
        version: 1,
        artifactId: `sha256-v1-${sha256}`,
        byteLength: 1,
        sha256,
        encoding: 'utf-8',
        mediaType: 'text/plain',
      },
      blockCount: 1,
    },
    itemRevision: 0,
    final: true,
  };

  expect(decodeChildRowEffect(row)).toMatchObject({
    type: 'commit',
    transcripts: [{ rows: [row] }],
  });
  expect(() =>
    decodeChildRowEffect({
      ...row,
      blocksRef: { ...row.blocksRef, blockCount: 0 },
    }),
  ).toThrow(ChatDeltaJournalIntegrityError);
  expect(() =>
    decodeChildRowEffect({
      ...row,
      blocksRef: { ...row.blocksRef, future: true },
    }),
  ).toThrow(ChatDeltaJournalIntegrityError);
});

it('includes every paged child dependency in pending artifact references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'format4-child-paged-refs-'));
  const artifacts = jest
    .spyOn(ChatTranscriptArtifacts.prototype, 'referenceClosure')
    .mockImplementation(async function* () {
      // The artifacts codec yields the block manifest, block page, and bodies
      // in their closure. This exercises the writer's handoff to that closure
      // without duplicating the codec's page-format tests here.
      await Promise.resolve();
      for (const digit of ['1', '2', '3'])
        yield {
          version: 1,
          artifactId: `sha256-v1-${digit.repeat(64)}`,
          byteLength: 1,
          sha256: digit.repeat(64),
          encoding: 'utf-8',
          mediaType: 'text/plain',
        };
    });
  try {
    const { writer } = await format4Scope(root);
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'paged',
      runGeneration: 0,
    };
    const current = writer.indexes();
    const revision = current.live.revision + 1;
    await writer.commit({
      expectedRevision: current.live.revision,
      next: {
        live: { ...current.live, revision },
        archive: { ...current.archive, revision },
        recovery: {
          ...current.recovery,
          mutationIds: [...current.recovery.mutationIds, 'paged-child'],
        },
      },
      writes: [],
      mutationIds: ['paged-child'],
      streamRegistrations: [{ target, streamKey: delegationStreamKey(target) }],
      childWrites: [
        {
          target,
          rows: [
            {
              ...message('delegated-agent-paged:item', 'body'),
              parentBlockId: 'delegated-agent-paged',
              delegationSequence: 0,
              itemRevision: 0,
              final: true,
            },
          ],
        },
      ],
    });

    expect(await collectPendingChildArtifactRefs(writer)).toEqual(
      ['1', '2', '3'].map((digit) => ({
        parentChatId: 'chat',
        path: join(
          'transcripts',
          'tool-output',
          'chat',
          `sha256-v1-${digit.repeat(64)}.txt`,
        ),
      })),
    );
    expect(artifacts).toHaveBeenCalledTimes(1);
  } finally {
    artifacts.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('reads a mixed committed-row replay and new child without duplicating the committed row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'child-mixed-replay-'));
  try {
    const { store, writer } = await format4Scope(root);
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'mixed',
      runGeneration: 0,
    };
    const committed = {
      ...message('mixed:old', 'old'),
      parentBlockId: 'mixed',
      delegationSequence: 0,
      itemRevision: 0,
      final: true,
    };
    let current = writer.indexes();
    await writer.commit({
      expectedRevision: current.live.revision,
      next: {
        live: { ...current.live, revision: current.live.revision + 1 },
        archive: { ...current.archive, revision: current.live.revision + 1 },
        recovery: {
          ...current.recovery,
          mutationIds: [...current.recovery.mutationIds, 'seed'],
        },
      },
      writes: [],
      mutationIds: ['seed'],
      streamRegistrations: [{ target, streamKey: delegationStreamKey(target) }],
      childWrites: [{ target, rows: [committed] }],
    });
    await writer.checkpoint();
    current = writer.indexes();
    await writer.commit({
      expectedRevision: current.live.revision,
      next: {
        live: { ...current.live, revision: current.live.revision + 1 },
        archive: { ...current.archive, revision: current.live.revision + 1 },
        recovery: {
          ...current.recovery,
          mutationIds: [...current.recovery.mutationIds, 'mixed'],
        },
      },
      writes: [],
      mutationIds: ['mixed'],
      childWrites: [
        {
          target,
          rows: [
            committed,
            {
              ...message('mixed:new', 'new'),
              parentBlockId: 'mixed',
              delegationSequence: 1,
              itemRevision: 0,
              final: false,
            },
          ],
        },
      ],
    });
    const view = await openReplayedChatScope(
      { directory: store.directory, scopeId: 'scope' },
      assertChatStorageIndexes,
      { maxManifestVersion: 4 },
    );
    try {
      expect((await view.stream(target)).rows.map((row) => row.id)).toEqual([
        'mixed:old',
        'mixed:new',
      ]);
    } finally {
      await view.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('replays a turn finalized into a field reference after a checkpoint stops once its transcripts are applied', async () => {
  const root = await mkdtemp(join(tmpdir(), 'format4-finalized-turn-'));
  try {
    const { store, writer } = await format4Scope(root);
    const body = `open ${'🌲 body\n'.repeat(12_000)}end`;
    const open = message('open', body);
    for (const [key, kind] of [
      ['draft', 'active'],
      ['final', 'append'],
    ] as const) {
      const current = writer.indexes();
      const revision = current.live.revision + 1;
      await writer.commit({
        expectedRevision: current.live.revision,
        next: {
          live: { ...current.live, revision },
          archive: { ...current.archive, revision },
          recovery: {
            ...current.recovery,
            mutationIds: [...current.recovery.mutationIds, key],
          },
        },
        // The open row is journaled inline; the append publishes its text.
        writes: [{ chatId: 'chat', kind, messages: [open] }],
        mutationIds: [key],
      });
    }
    const faulted = await ChatDeltaJournalWriter.open(store, {
      maxManifestVersion: 4,
      onBoundary: (point) =>
        point === 'checkpoint-transcripts-applied'
          ? Promise.reject(new Error('fault'))
          : Promise.resolve(),
    });
    await expect(faulted.checkpoint()).rejects.toThrow('fault');
    // The log holds the final row; a lease-free reader replays the open one.
    const view = await openReplayedChatScope(
      { directory: store.directory, scopeId: 'scope' },
      assertChatStorageIndexes,
      { maxManifestVersion: 4 },
    );
    try {
      const page = await view.transcript('chat').page('chat');
      expect(page.messages.map((row) => row.id)).toEqual(['open']);
      const [row] = page.messages;
      expect(
        row?.blocks.map((block) => block.type === 'text' && block.textRef),
      ).toEqual([
        expect.objectContaining({ byteLength: Buffer.byteLength(body) }),
      ]);
      expect(view.indexes.live.tabs[0]?.transcript.committedMessageCount).toBe(
        1,
      );
    } finally {
      await view.dispose();
    }
    // A writer resumes the checkpoint over the same applied transcripts.
    const recovered = await ChatDeltaJournalWriter.open(store, {
      maxManifestVersion: 4,
    });
    await recovered.checkpoint();
    expect(recovered.pendingRecordCount).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each<[DeltaJournalBoundary, boolean]>([
  ['checkpoint-child-append-prepared', false],
  ['checkpoint-transcripts-applied', false],
  ['checkpoint-metadata-staged', false],
  ['checkpoint-publishing-marked', false],
  ['checkpoint-descriptors-published', false],
  // The view opens before the checkpoint starts, then reads after it stops.
  ['checkpoint-child-append-prepared', true],
  ['checkpoint-transcripts-applied', true],
])(
  'reads a checkpointed child stream after a checkpoint stops at %s (view opened first: %s)',
  async (seam, openFirst) => {
    const root = await mkdtemp(join(tmpdir(), 'child-publishing-read-'));
    try {
      const { store, writer } = await format4Scope(root);
      const target = {
        kind: 'delegation' as const,
        chatId: 'chat',
        delegationId: 'pub',
        runGeneration: 0,
      };
      const row = (
        id: string,
        sequence: number,
        itemRevision: number,
        final: boolean,
      ): DelegationChildRow => ({
        ...message(`pub:${id}`, `${id}@${itemRevision}`),
        parentBlockId: 'pub',
        delegationSequence: sequence,
        itemRevision,
        final,
      });
      // The window after the first checkpoint finalizes a row and revises an open one.
      const commits: Array<[string, DelegationChildRow[]]> = [
        ['seed', [row('seed', 0, 0, true)]],
        ['draft', [row('next', 1, 0, true), row('open', 2, 0, false)]],
        ['revise', [row('open', 2, 1, false)]],
      ];
      for (let index = 0; index < commits.length; index += 1) {
        const [key, rows] = commits[index];
        const current = writer.indexes();
        await writer.commit({
          expectedRevision: current.live.revision,
          next: {
            live: { ...current.live, revision: current.live.revision + 1 },
            archive: {
              ...current.archive,
              revision: current.live.revision + 1,
            },
            recovery: {
              ...current.recovery,
              mutationIds: [...current.recovery.mutationIds, key],
            },
          },
          writes: [],
          mutationIds: [key],
          ...(index === 0
            ? {
                streamRegistrations: [
                  { target, streamKey: delegationStreamKey(target) },
                ],
              }
            : {}),
          childWrites: [{ target, rows }],
        });
        if (index === 0) await writer.checkpoint();
      }
      const faulted = await ChatDeltaJournalWriter.open(store, {
        maxManifestVersion: 4,
        onBoundary: (point) =>
          point === seam
            ? Promise.reject(new Error(`fault:${seam}`))
            : Promise.resolve(),
      });
      const open = (): ReturnType<typeof openReplayedChatScope> =>
        openReplayedChatScope(
          { directory: store.directory, scopeId: 'scope' },
          assertChatStorageIndexes,
          { maxManifestVersion: 4 },
        );
      const early = openFirst ? await open() : undefined;
      await expect(faulted.checkpoint()).rejects.toThrow(`fault:${seam}`);
      const view = early ?? (await open());
      try {
        const { rows } = await view.stream(target);
        expect(rows.map((item) => [item.id, item.itemRevision])).toEqual([
          ['pub:seed', 0],
          ['pub:next', 0],
          ['pub:open', 1],
        ]);
        if (seam === 'checkpoint-child-append-prepared') {
          // The read recovers the intent on a copy; the canonical files keep it.
          const active = await readFile(
            join(
              streamRegistryPaths(
                join(store.directory, 'transcripts'),
                'chat',
                delegationStreamKey(target),
              ).streamDirectory,
              'transcript.active.json',
            ),
            'utf8',
          );
          expect(active.split('\n', 1)[0]).toContain('"finalizing"');
        }
      } finally {
        await view.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('rereads a child stream when checkpoints advance past an open view', async () => {
  const root = await mkdtemp(join(tmpdir(), 'child-stale-view-'));
  try {
    const { store, writer } = await format4Scope(root);
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'stale',
      runGeneration: 0,
    };
    const commit = async (
      journal: ChatDeltaJournalWriter,
      key: string,
      sequence: number,
    ): Promise<void> => {
      const current = journal.indexes();
      await journal.commit({
        expectedRevision: current.live.revision,
        next: {
          live: { ...current.live, revision: current.live.revision + 1 },
          archive: { ...current.archive, revision: current.live.revision + 1 },
          recovery: {
            ...current.recovery,
            mutationIds: [...current.recovery.mutationIds, key],
          },
        },
        writes: [],
        mutationIds: [key],
        ...(sequence === 0
          ? {
              streamRegistrations: [
                { target, streamKey: delegationStreamKey(target) },
              ],
            }
          : {}),
        childWrites: [
          {
            target,
            rows: [
              {
                ...message(`stale:${key}`, key),
                parentBlockId: 'stale',
                delegationSequence: sequence,
                itemRevision: 0,
                final: true,
              },
            ],
          },
        ],
      });
    };
    await commit(writer, 'a', 0);
    const faulted = await ChatDeltaJournalWriter.open(store, {
      maxManifestVersion: 4,
      onBoundary: (point) =>
        point === 'checkpoint-publishing-marked'
          ? Promise.reject(new Error('fault'))
          : Promise.resolve(),
    });
    await expect(faulted.checkpoint()).rejects.toThrow('fault');
    const view = await openReplayedChatScope(
      { directory: store.directory, scopeId: 'scope' },
      assertChatStorageIndexes,
      { maxManifestVersion: 4 },
    );
    try {
      const recovered = await ChatDeltaJournalWriter.open(store, {
        maxManifestVersion: 4,
      });
      await commit(recovered, 'b', 1);
      await recovered.checkpoint();
      expect((await view.stream(target)).rows.map((row) => row.id)).toEqual([
        'stale:a',
        'stale:b',
      ]);
    } finally {
      await view.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('appends a later final row after a child index rebuild raises its revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'child-rebuilt-revision-'));
  try {
    const { store, writer } = await format4Scope(root);
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'rebuilt',
      runGeneration: 0,
    };
    const commit = async (
      key: string,
      rows: DelegationChildRow[],
    ): Promise<void> => {
      const current = writer.indexes();
      await writer.commit({
        expectedRevision: current.live.revision,
        next: {
          live: { ...current.live, revision: current.live.revision + 1 },
          archive: { ...current.archive, revision: current.live.revision + 1 },
          recovery: {
            ...current.recovery,
            mutationIds: [...current.recovery.mutationIds, key],
          },
        },
        writes: [],
        mutationIds: [key],
        ...(key === 'seed'
          ? {
              streamRegistrations: [
                { target, streamKey: delegationStreamKey(target) },
              ],
            }
          : {}),
        childWrites: [{ target, rows }],
      });
    };
    const final = (sequence: number): DelegationChildRow => ({
      ...message(`rebuilt:${sequence}`, `${sequence}`),
      parentBlockId: 'rebuilt',
      delegationSequence: sequence,
      itemRevision: 0,
      final: true,
    });
    // More committed rows than scope revisions, so a rebuilt index outruns the scope.
    await commit(
      'seed',
      Array.from({ length: 20 }, (_, sequence) => final(sequence)),
    );
    await writer.checkpoint();
    const paths = streamRegistryPaths(
      join(store.directory, 'transcripts'),
      'chat',
      delegationStreamKey(target),
    );
    await rm(join(paths.streamDirectory, 'transcript.index.json'));
    await commit('later', [final(20)]);
    expect(writer.indexes().live.revision).toBeLessThan(20);
    await writer.checkpoint();
    const committed = (await readFile(paths.log, 'utf8')).trim().split('\n');
    expect(committed).toHaveLength(21);
    expect(committed[20]).toContain('rebuilt:20');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('retries a child stream read when a checkpoint publishes an append intent mid-read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'child-intent-mid-read-'));
  try {
    const { store, writer } = await format4Scope(root);
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'mid',
      runGeneration: 0,
    };
    const row = (id: string, sequence: number): DelegationChildRow => ({
      ...message(`mid:${id}`, id),
      parentBlockId: 'mid',
      delegationSequence: sequence,
      itemRevision: 0,
      final: true,
    });
    for (const [key, rows] of [
      ['seed', [row('a', 0)]],
      ['next', [row('b', 1)]],
    ] as const) {
      const current = writer.indexes();
      await writer.commit({
        expectedRevision: current.live.revision,
        next: {
          live: { ...current.live, revision: current.live.revision + 1 },
          archive: { ...current.archive, revision: current.live.revision + 1 },
          recovery: {
            ...current.recovery,
            mutationIds: [...current.recovery.mutationIds, key],
          },
        },
        writes: [],
        mutationIds: [key],
        ...(key === 'seed'
          ? {
              streamRegistrations: [
                { target, streamKey: delegationStreamKey(target) },
              ],
            }
          : {}),
        childWrites: [{ target, rows: [...rows] }],
      });
      if (key === 'seed') await writer.checkpoint();
    }
    const faulted = await ChatDeltaJournalWriter.open(store, {
      maxManifestVersion: 4,
      onBoundary: (point) =>
        point === 'checkpoint-child-append-prepared'
          ? Promise.reject(new Error('fault'))
          : Promise.resolve(),
    });
    const view = await openReplayedChatScope(
      { directory: store.directory, scopeId: 'scope' },
      assertChatStorageIndexes,
      { maxManifestVersion: 4 },
    );
    const activeMessages = jest
      .spyOn(TranscriptStreamStore.prototype, 'activeMessages')
      .mockImplementationOnce(async function (
        this: TranscriptStreamStore,
        key: string,
      ) {
        // The view has validated its target; now a checkpoint leaves an intent.
        activeMessages.mockRestore();
        await expect(faulted.checkpoint()).rejects.toThrow('fault');
        return this.activeMessages(key);
      });
    try {
      expect((await view.stream(target)).rows.map((item) => item.id)).toEqual([
        'mid:a',
        'mid:b',
      ]);
    } finally {
      activeMessages.mockRestore();
      await view.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('removes the child replay scratch copy when copying the stream fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'child-scratch-cleanup-'));
  const scratchRoot = await mkdtemp(join(tmpdir(), 'child-scratch-root-'));
  const target = {
    kind: 'delegation' as const,
    chatId: 'chat',
    delegationId: 'copy',
    runGeneration: 0,
  };
  let unreadable: string | undefined;
  try {
    const { store, writer } = await format4Scope(root);
    for (const key of ['seed', 'next']) {
      const current = writer.indexes();
      await writer.commit({
        expectedRevision: current.live.revision,
        next: {
          live: { ...current.live, revision: current.live.revision + 1 },
          archive: { ...current.archive, revision: current.live.revision + 1 },
          recovery: {
            ...current.recovery,
            mutationIds: [...current.recovery.mutationIds, key],
          },
        },
        writes: [],
        mutationIds: [key],
        ...(key === 'seed'
          ? {
              streamRegistrations: [
                { target, streamKey: delegationStreamKey(target) },
              ],
            }
          : {}),
        childWrites: [
          {
            target,
            rows: [
              {
                ...message(`copy:${key}`, key),
                parentBlockId: 'copy',
                delegationSequence: key === 'seed' ? 0 : 1,
                itemRevision: 0,
                final: true,
              },
            ],
          },
        ],
      });
      if (key === 'seed') await writer.checkpoint();
    }
    const faulted = await ChatDeltaJournalWriter.open(store, {
      maxManifestVersion: 4,
      onBoundary: (point) =>
        point === 'checkpoint-child-append-prepared'
          ? Promise.reject(new Error('fault'))
          : Promise.resolve(),
    });
    await expect(faulted.checkpoint()).rejects.toThrow('fault');
    unreadable = streamRegistryPaths(
      join(store.directory, 'transcripts'),
      'chat',
      delegationStreamKey(target),
    ).log;
    // A copy error other than absence, as a full disk would cause.
    await chmod(unreadable, 0o000);
    const view = await openReplayedChatScope(
      { directory: store.directory, scopeId: 'scope' },
      assertChatStorageIndexes,
      { maxManifestVersion: 4, scratchRoot },
    );
    try {
      await expect(view.stream(target)).rejects.toMatchObject({
        code: 'EACCES',
      });
    } finally {
      await view.dispose();
    }
    expect(
      (await readdir(scratchRoot)).filter((name) =>
        name.startsWith('chat-child-replay-'),
      ),
    ).toEqual([]);
  } finally {
    if (unreadable) await chmod(unreadable, 0o644);
    await rm(scratchRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

describe('child stream integrity across checkpoints', () => {
  const targetFor = (
    delegationId: string,
  ): {
    kind: 'delegation';
    chatId: string;
    delegationId: string;
    runGeneration: number;
  } => ({
    kind: 'delegation' as const,
    chatId: 'chat',
    delegationId,
    runGeneration: 0,
  });
  const final = (
    delegationId: string,
    id: string,
    sequence: number,
  ): DelegationChildRow => ({
    ...message(`${delegationId}:${id}`, id),
    parentBlockId: delegationId,
    delegationSequence: sequence,
    itemRevision: 0,
    final: true,
  });
  const commit = async (
    writer: ChatDeltaJournalWriter,
    key: string,
    childWrites: NonNullable<
      Parameters<ChatDeltaJournalWriter['commit']>[0]['childWrites']
    >,
    register = false,
  ): Promise<void> => {
    const current = writer.indexes();
    await writer.commit({
      expectedRevision: current.live.revision,
      next: {
        live: { ...current.live, revision: current.live.revision + 1 },
        archive: { ...current.archive, revision: current.live.revision + 1 },
        recovery: {
          ...current.recovery,
          mutationIds: [...current.recovery.mutationIds, key],
        },
      },
      writes: [],
      mutationIds: [key],
      ...(register
        ? {
            streamRegistrations: childWrites.map(({ target }) => ({
              target,
              streamKey: delegationStreamKey(target),
            })),
          }
        : {}),
      childWrites,
    });
  };

  it('keeps a child descriptor latest timestamp when only an older row is revised', async () => {
    const root = await mkdtemp(join(tmpdir(), 'child-latest-timestamp-'));
    try {
      const { store, writer } = await format4Scope(root);
      const target = targetFor('ts');
      const a = { ...final('ts', 'a', 0), final: false, timestamp: 1 };
      const b = { ...final('ts', 'b', 1), timestamp: 2 };
      await commit(writer, 'w1', [{ target, rows: [a, b] }], true);
      await writer.checkpoint();
      await commit(writer, 'w2', [
        { target, rows: [{ ...a, itemRevision: 1, final: true }] },
      ]);
      await writer.checkpoint();
      const descriptor: unknown = JSON.parse(
        await readFile(
          streamRegistryPaths(
            join(store.directory, 'transcripts'),
            'chat',
            delegationStreamKey(target),
          ).descriptor,
          'utf8',
        ),
      );
      expect(descriptor).toMatchObject({ latestRowTimestamp: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reopens a scope whose child log grows from a checkpoint started mid-open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'child-open-race-'));
    try {
      const { store, writer } = await format4Scope(root);
      const target = targetFor('race');
      await commit(
        writer,
        'seed',
        [{ target, rows: [final('race', 'a', 0)] }],
        true,
      );
      await writer.checkpoint();
      await commit(writer, 'next', [{ target, rows: [final('race', 'b', 1)] }]);
      const faulted = await ChatDeltaJournalWriter.open(store, {
        maxManifestVersion: 4,
        onBoundary: (point: DeltaJournalBoundary): Promise<void> =>
          point === 'checkpoint-transcripts-applied'
            ? Promise.reject(new Error('stop'))
            : Promise.resolve(),
      });
      const loadCatalog = jest
        .spyOn(streamRegistry, 'loadStreamCatalog')
        .mockImplementationOnce(async (catalogRoot: string) => {
          loadCatalog.mockRestore();
          // The open has read its checkpoint state; now a checkpoint appends finals.
          await expect(faulted.checkpoint()).rejects.toThrow('stop');
          return streamRegistry.loadStreamCatalog(catalogRoot);
        });
      const view = await openReplayedChatScope(
        { directory: store.directory, scopeId: 'scope' },
        assertChatStorageIndexes,
        { maxManifestVersion: 4 },
      );
      try {
        expect((await view.stream(target)).rows.map((row) => row.id)).toEqual([
          'race:a',
          'race:b',
        ]);
      } finally {
        loadCatalog.mockRestore();
        await view.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an applied mutation ID reused with a changed child row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'child-mutation-reuse-'));
    try {
      const { writer } = await format4Scope(root);
      const target = targetFor('reuse');
      const open = (
        text: string,
        itemRevision: number,
      ): DelegationChildRow => ({
        ...message('reuse:item', text),
        parentBlockId: 'reuse',
        delegationSequence: 0,
        itemRevision,
        final: false,
      });
      await commit(writer, 'm1', [{ target, rows: [open('draft', 0)] }], true);
      await expect(
        commit(writer, 'm1', [{ target, rows: [open('changed', 1)] }]),
      ).rejects.toThrow('different child content');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to re-sign a committed child log altered since its checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'child-prefix-verify-'));
    try {
      const { store, writer } = await format4Scope(root);
      const target = targetFor('sig');
      await commit(
        writer,
        'seed',
        [{ target, rows: [final('sig', 'seed', 0)] }],
        true,
      );
      await writer.checkpoint();
      const paths = streamRegistryPaths(
        join(store.directory, 'transcripts'),
        'chat',
        delegationStreamKey(target),
      );
      const signed = await readFile(paths.descriptor, 'utf8');
      // Same length, still valid JSON: shallow checks cannot see it.
      const log = await readFile(paths.log, 'utf8');
      await writeFile(paths.log, log.replace('"text":"seed"', '"text":"SEED"'));
      await commit(writer, 'next', [
        { target, rows: [final('sig', 'next', 1)] },
      ]);
      await expect(writer.checkpoint()).rejects.toThrow(
        'Committed child log changed since its checkpoint',
      );
      expect(await readFile(paths.descriptor, 'utf8')).toBe(signed);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rereads a child stream whose final is appended between its count and open rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'child-count-race-'));
    try {
      const { store, writer } = await format4Scope(root);
      const first = targetFor('first');
      const read = targetFor('read');
      await commit(
        writer,
        'seed',
        [
          { target: first, rows: [final('first', 'a', 0)] },
          { target: read, rows: [final('read', 'a', 0)] },
        ],
        true,
      );
      await writer.checkpoint();
      await commit(writer, 'next', [
        { target: first, rows: [final('first', 'b', 1)] },
        { target: read, rows: [final('read', 'b', 1)] },
      ]);
      const stopAt = (
        seam: DeltaJournalBoundary,
      ): Parameters<typeof ChatDeltaJournalWriter.open>[1] => ({
        maxManifestVersion: 4,
        onBoundary: (point: DeltaJournalBoundary): Promise<void> =>
          point === seam ? Promise.reject(new Error(seam)) : Promise.resolve(),
      });
      // The checkpoint stops on the first stream's append; the read stream has none yet.
      const faulted = await ChatDeltaJournalWriter.open(
        store,
        stopAt('checkpoint-child-append-prepared'),
      );
      await expect(faulted.checkpoint()).rejects.toThrow();
      const view = await openReplayedChatScope(
        { directory: store.directory, scopeId: 'scope' },
        assertChatStorageIndexes,
        { maxManifestVersion: 4 },
      );
      const activeMessages = jest
        .spyOn(TranscriptStreamStore.prototype, 'activeMessages')
        .mockImplementationOnce(async function (
          this: TranscriptStreamStore,
          key: string,
        ) {
          activeMessages.mockRestore();
          // The same checkpoint resumes and appends the read stream's final.
          await expect(
            ChatDeltaJournalWriter.open(
              store,
              stopAt('checkpoint-transcripts-applied'),
            ),
          ).rejects.toThrow();
          return this.activeMessages(key);
        });
      try {
        expect((await view.stream(read)).rows.map((row) => row.id)).toEqual([
          'read:a',
          'read:b',
        ]);
      } finally {
        activeMessages.mockRestore();
        await view.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('child settlement admission', () => {
  const target = {
    kind: 'delegation' as const,
    chatId: 'chat',
    delegationId: 'settle',
    runGeneration: 0,
  };
  const row = (
    id: string,
    sequence: number,
    final: boolean,
  ): DelegationChildRow => ({
    ...message(`settle:${id}`, id),
    parentBlockId: 'settle',
    delegationSequence: sequence,
    itemRevision: 0,
    final,
  });
  const lines = (rows: readonly DelegationChildRow[]): Buffer =>
    Buffer.concat(rows.map((item) => Buffer.from(`${JSON.stringify(item)}\n`)));
  const commit = (
    writer: ChatDeltaJournalWriter,
    key: string,
    rows: DelegationChildRow[],
    settleTotals?: Buffer,
    settleRows = 0,
  ): Promise<unknown> => {
    const current = writer.indexes();
    const scopeRevision = current.live.revision + 1;
    const streamRevision = key === 'seed' ? 0 : 1;
    return writer.commit({
      expectedRevision: current.live.revision,
      next: {
        live: { ...current.live, revision: scopeRevision },
        archive: { ...current.archive, revision: scopeRevision },
        recovery: {
          ...current.recovery,
          mutationIds: [...current.recovery.mutationIds, key],
        },
      },
      writes: [],
      mutationIds: [key],
      ...(key === 'seed'
        ? {
            streamRegistrations: [
              { target, streamKey: delegationStreamKey(target) },
            ],
          }
        : {}),
      childWrites: [
        {
          target,
          rows,
          ...(settleTotals
            ? {
                settle: {
                  key,
                  descriptorUpdate: {
                    version: 1 as const,
                    target,
                    expectedStreamRevision: streamRevision,
                    nextStreamRevision: streamRevision + 1,
                    status: 'settled' as const,
                    settleReceipt: {
                      mutationId: key,
                      scopeRevision,
                      streamRevision: streamRevision + 1,
                      committedRowCount: settleRows,
                      committedByteLength: settleTotals.length,
                      committedSha256: createHash('sha256')
                        .update(settleTotals)
                        .digest('hex'),
                    },
                  },
                },
              }
            : {}),
        },
      ],
    });
  };

  it('rejects a resent settlement key whose receipt changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'child-settle-replay-'));
    try {
      const { writer } = await format4Scope(root);
      const seed = row('seed', 0, true);
      const last = row('last', 1, true);
      await commit(writer, 'seed', [seed]);
      await writer.checkpoint();
      await commit(writer, 'settle', [last], lines([seed, last]), 2);
      await expect(
        commit(writer, 'settle', [last], lines([seed]), 1),
      ).rejects.toThrow('different child content');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a settlement that leaves an admitted row open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'child-settle-open-'));
    try {
      const { writer } = await format4Scope(root);
      await commit(writer, 'seed', [row('open', 0, false)]);
      await expect(commit(writer, 'settle', [], lines([]), 0)).rejects.toThrow(
        'Invalid child settlement',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects receipt totals that omit the settling rows and checkpoints matching ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'child-settle-receipt-'));
    try {
      const { store, writer } = await format4Scope(root);
      const seed = row('seed', 0, true);
      const last = row('last', 1, true);
      await commit(writer, 'seed', [seed]);
      await writer.checkpoint();
      await expect(
        commit(writer, 'stale', [last], lines([seed]), 1),
      ).rejects.toThrow('Child settlement receipt disagrees with its stream');
      await commit(writer, 'settle', [last], lines([seed, last]), 2);
      await writer.checkpoint();
      const paths = streamRegistryPaths(
        join(store.directory, 'transcripts'),
        'chat',
        delegationStreamKey(target),
      );
      expect(await readFile(paths.log)).toEqual(lines([seed, last]));
      expect(
        JSON.parse(await readFile(paths.descriptor, 'utf8')),
      ).toMatchObject({ status: 'settled', committedRowCount: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('admits after 1,000 committed child rows without iterating their history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'child-bounded-overlay-'));
  try {
    const { store, writer } = await format4Scope(root);
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'bounded',
      runGeneration: 0,
    };
    const current = writer.indexes();
    await writer.commit({
      expectedRevision: current.live.revision,
      next: {
        live: { ...current.live, revision: current.live.revision + 1 },
        archive: { ...current.archive, revision: current.live.revision + 1 },
        recovery: {
          ...current.recovery,
          mutationIds: [...current.recovery.mutationIds, 'seed'],
        },
      },
      writes: [],
      mutationIds: ['seed'],
      streamRegistrations: [{ target, streamKey: delegationStreamKey(target) }],
      childWrites: [
        {
          target,
          rows: Array.from({ length: 1000 }, (_, index) => ({
            ...message(`bounded:${index}`, 'x'),
            parentBlockId: 'bounded',
            delegationSequence: index,
            itemRevision: 0,
            final: true,
          })),
        },
      ],
    });
    await writer.checkpoint();
    const iterate = jest.spyOn(TranscriptStreamStore.prototype, 'iterate');
    try {
      const reopened = await ChatDeltaJournalWriter.open(store, {
        maxManifestVersion: 4,
      });
      const next = reopened.indexes();
      await reopened.commit({
        expectedRevision: next.live.revision,
        next: {
          live: { ...next.live, revision: next.live.revision + 1 },
          archive: { ...next.archive, revision: next.live.revision + 1 },
          recovery: {
            ...next.recovery,
            mutationIds: [...next.recovery.mutationIds, 'new'],
          },
        },
        writes: [],
        mutationIds: ['new'],
        childWrites: [
          {
            target,
            rows: [
              {
                ...message('bounded:1000', 'new'),
                parentBlockId: 'bounded',
                delegationSequence: 1000,
                itemRevision: 0,
                final: false,
              },
            ],
          },
        ],
      });
      expect(iterate).not.toHaveBeenCalled();
    } finally {
      iterate.mockRestore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('replays a format-4 scope without changing source bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'format4-readonly-'));
  try {
    const { store } = await format4Scope(root);
    const before = await treeDigests(store.directory);
    const view = await openReplayedChatScope(
      { directory: store.directory, scopeId: 'scope' },
      assertChatStorageIndexes,
      { maxManifestVersion: 4 },
    );
    expect(view.streamRegistrations).toEqual([]);
    await view.dispose();
    expect(await treeDigests(store.directory)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each<DeltaJournalBoundary>([
  'checkpoint-transcripts-applied',
  'checkpoint-metadata-staged',
  'checkpoint-publishing-marked',
  'checkpoint-descriptors-published',
  'checkpoint-registries-published',
  'checkpoint-catalog-published',
  'checkpoint-indexes-published',
  'checkpoint-journal-rotated',
])('recovers a registration checkpoint after %s', async (seam) => {
  const root = await mkdtemp(join(tmpdir(), 'format4-checkpoint-fault-'));
  try {
    const { store, writer } = await format4Scope(root);
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'd',
      runGeneration: 0,
    };
    const streamKey = delegationStreamKey(target);
    const current = writer.indexes();
    const revision = current.live.revision + 1;
    await writer.commit({
      expectedRevision: current.live.revision,
      next: {
        live: { ...current.live, revision },
        archive: { ...current.archive, revision },
        recovery: {
          ...current.recovery,
          mutationIds: [...current.recovery.mutationIds, 'register'],
        },
      },
      writes: [],
      mutationIds: ['register'],
      streamRegistrations: [{ target, streamKey }],
    });
    const faulty = await ChatDeltaJournalWriter.open(store, {
      onBoundary: (point) =>
        point === seam
          ? Promise.reject(new Error(`fault:${seam}`))
          : Promise.resolve(),
    });
    await expect(faulty.checkpoint()).rejects.toThrow(`fault:${seam}`);
    if (seam === 'checkpoint-catalog-published') {
      const beforeRead = await treeDigests(store.directory);
      const view = await openReplayedChatScope(
        { directory: store.directory, scopeId: 'scope' },
        assertChatStorageIndexes,
        { maxManifestVersion: 4 },
      );
      expect(view.streamRegistrations).toHaveLength(1);
      await view.dispose();
      expect(await treeDigests(store.directory)).toEqual(beforeRead);
    }
    const recovered = await ChatDeltaJournalWriter.open(store);
    if (recovered.pendingRecordCount > 0) await recovered.checkpoint();
    expect(recovered.pendingRecordCount).toBe(0);
    expect(recovered.indexes().live.revision).toBe(revision);
    const paths = streamRegistryPaths(
      join(store.directory, 'transcripts'),
      'chat',
      streamKey,
    );
    expect(
      parseStreamRegistry(await readFile(paths.registry), 'chat').entries,
    ).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses to replace a catalogued registry that has gone missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'format4-missing-registry-'));
  try {
    const { store, writer } = await format4Scope(root);
    const register = async (delegationId: string): Promise<void> => {
      const target = {
        kind: 'delegation' as const,
        chatId: 'chat',
        delegationId,
        runGeneration: 0,
      };
      const current = writer.indexes();
      const revision = current.live.revision + 1;
      await writer.commit({
        expectedRevision: current.live.revision,
        next: {
          live: { ...current.live, revision },
          archive: { ...current.archive, revision },
          recovery: {
            ...current.recovery,
            mutationIds: [...current.recovery.mutationIds, delegationId],
          },
        },
        writes: [],
        mutationIds: [delegationId],
        streamRegistrations: [
          { target, streamKey: delegationStreamKey(target) },
        ],
      });
    };
    await register('first');
    await writer.checkpoint();
    const transcripts = join(store.directory, 'transcripts');
    const catalog = await readFile(streamCatalogPath(transcripts), 'utf8');
    await rm(streamRegistryPaths(transcripts, 'chat', '0'.repeat(64)).registry);
    await register('second');
    await expect(writer.checkpoint()).rejects.toThrow(
      'Missing known stream registry',
    );
    expect(await readFile(streamCatalogPath(transcripts), 'utf8')).toBe(
      catalog,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('finishes registered-parent deletion after interrupted catalog publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'format4-delete-'));
  try {
    const { store, writer } = await format4Scope(root);
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'd',
      runGeneration: 0,
    };
    const streamKey = delegationStreamKey(target);
    const current = writer.indexes();
    let revision = current.live.revision + 1;
    await writer.commit({
      expectedRevision: current.live.revision,
      next: {
        live: { ...current.live, revision },
        archive: { ...current.archive, revision },
        recovery: {
          ...current.recovery,
          mutationIds: [...current.recovery.mutationIds, 'register'],
        },
      },
      writes: [],
      mutationIds: ['register'],
      streamRegistrations: [{ target, streamKey }],
    });
    await writer.checkpoint();
    const before = writer.indexes();
    revision = before.live.revision + 1;
    await writer.commit({
      expectedRevision: before.live.revision,
      next: {
        live: {
          ...before.live,
          revision,
          tabs: [],
          activeTabId: '',
          runtimeByChatId: {},
        },
        archive: { ...before.archive, revision },
        recovery: {
          ...before.recovery,
          mutationIds: [...before.recovery.mutationIds, 'delete'],
        },
      },
      writes: [{ chatId: 'chat', kind: 'delete' }],
      mutationIds: ['delete'],
    });
    const path = streamRegistryPaths(
      join(store.directory, 'transcripts'),
      'chat',
      streamKey,
    ).streamDirectory;
    const faulty = await ChatDeltaJournalWriter.open(store, {
      onBoundary: (point) =>
        point === 'checkpoint-catalog-published'
          ? Promise.reject(new Error('kill'))
          : Promise.resolve(),
    });
    await expect(faulty.checkpoint()).rejects.toThrow('kill');
    await stat(path);
    const recovered = await ChatDeltaJournalWriter.open(store);
    expect(recovered.indexes().live.tabs).toHaveLength(0);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses a same-length edit to a checkpointed child log on replay reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'format4-child-tamper-'));
  try {
    const { store, writer } = await format4Scope(root);
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'd',
      runGeneration: 0,
    };
    const streamKey = delegationStreamKey(target);
    const current = writer.indexes();
    let revision = current.live.revision + 1;
    await writer.commit({
      expectedRevision: current.live.revision,
      next: {
        live: { ...current.live, revision },
        archive: { ...current.archive, revision },
        recovery: {
          ...current.recovery,
          mutationIds: [...current.recovery.mutationIds, 'register'],
        },
      },
      writes: [],
      mutationIds: ['register'],
      streamRegistrations: [{ target, streamKey }],
    });
    const registered = writer.indexes();
    revision = registered.live.revision + 1;
    await writer.commit({
      expectedRevision: registered.live.revision,
      next: {
        live: { ...registered.live, revision },
        archive: { ...registered.archive, revision },
        recovery: {
          ...registered.recovery,
          mutationIds: [...registered.recovery.mutationIds, 'final-child'],
        },
      },
      writes: [],
      mutationIds: ['final-child'],
      childWrites: [
        {
          target,
          rows: [
            {
              ...message('delegated-agent-d:item', 'hello'),
              parentBlockId: 'delegated-agent-d',
              delegationSequence: 0,
              itemRevision: 0,
              final: true,
            },
          ],
        },
      ],
    });
    await writer.checkpoint();
    const log = streamRegistryPaths(
      join(store.directory, 'transcripts'),
      'chat',
      streamKey,
    ).log;
    const original = await readFile(log, 'utf8');
    expect(original).toContain('hello');
    await writeFile(log, original.replace('hello', 'jello'));
    const view = await openReplayedChatScope(
      { directory: store.directory, scopeId: 'scope' },
      assertChatStorageIndexes,
      { maxManifestVersion: 4 },
    );
    try {
      await expect(view.stream(target)).rejects.toThrow();
    } finally {
      await view.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('reopens a journal whose child row precedes the deletion of its parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'format4-delete-after-child-'));
  try {
    const { store, writer } = await format4Scope(root);
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'd',
      runGeneration: 0,
    };
    const streamKey = delegationStreamKey(target);
    const current = writer.indexes();
    let revision = current.live.revision + 1;
    await writer.commit({
      expectedRevision: current.live.revision,
      next: {
        live: { ...current.live, revision },
        archive: { ...current.archive, revision },
        recovery: {
          ...current.recovery,
          mutationIds: [...current.recovery.mutationIds, 'register'],
        },
      },
      writes: [],
      mutationIds: ['register'],
      streamRegistrations: [{ target, streamKey }],
    });
    await writer.checkpoint();
    const registered = writer.indexes();
    revision = registered.live.revision + 1;
    await writer.commit({
      expectedRevision: registered.live.revision,
      next: {
        live: { ...registered.live, revision },
        archive: { ...registered.archive, revision },
        recovery: {
          ...registered.recovery,
          mutationIds: [...registered.recovery.mutationIds, 'upsert-child'],
        },
      },
      writes: [],
      mutationIds: ['upsert-child'],
      childWrites: [
        {
          target,
          rows: [
            {
              ...message('delegated-agent-d:item', 'hello'),
              parentBlockId: 'delegated-agent-d',
              delegationSequence: 0,
              itemRevision: 0,
              final: false,
            },
          ],
        },
      ],
    });
    const before = writer.indexes();
    revision = before.live.revision + 1;
    await writer.commit({
      expectedRevision: before.live.revision,
      next: {
        live: {
          ...before.live,
          revision,
          tabs: [],
          activeTabId: '',
          runtimeByChatId: {},
        },
        archive: { ...before.archive, revision },
        recovery: {
          ...before.recovery,
          mutationIds: [...before.recovery.mutationIds, 'delete'],
        },
      },
      writes: [{ chatId: 'chat', kind: 'delete' }],
      mutationIds: ['delete'],
    });
    // A crash before the next checkpoint leaves both records to replay.
    const recovered = await ChatDeltaJournalWriter.open(store);
    expect(recovered.indexes().live.tabs).toHaveLength(0);
    expect(Array.from(recovered.childTargets())).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('counts every format-3 record as primary for the idle checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'format3-idle-primary-'));
  try {
    const store = new ChatStorageV2(root, 'scope');
    await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
    await promoteToDeltaJournal(store);
    const writer = await ChatDeltaJournalWriter.open(store);
    const current = writer.indexes();
    const revision = current.live.revision + 1;
    await writer.commit({
      expectedRevision: current.live.revision,
      next: {
        live: { ...current.live, revision },
        archive: { ...current.archive, revision },
        recovery: {
          ...current.recovery,
          mutationIds: [...current.recovery.mutationIds, 'revision-only'],
        },
      },
      writes: [],
      mutationIds: ['revision-only'],
    });
    // Format 3 keeps its idle checkpoint for every record, as before phase 06.
    expect(writer.pendingPrimaryRecordCount()).toBe(1);
    const reopened = await ChatDeltaJournalWriter.open(store);
    expect(reopened.pendingPrimaryRecordCount()).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
