import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import {
  ChatDeltaJournalWriter,
  promoteToDeltaJournal,
  promoteToFormat4Journal,
  type DeltaJournalBoundary,
} from '../lib/chat-delta-journal/writer';
import { delegationStreamKey } from '../lib/transcript-stream-paths';
import { streamRegistryPaths } from '../lib/chat-delta-journal/stream-registry';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';
import { toolMessage } from './helpers/chat-delta-journal-harness';
import { assertChatStorageIndexes } from '../lib/chat-storage-v2';
import { openReplayedChatScope } from '../lib/chat-delta-journal/reader';
import { TOOL_OUTPUT_INLINE_BYTES } from '@canopy/agent-transcript/transcript-storage';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';

it.each<DeltaJournalBoundary>([
  'checkpoint-child-append-prepared',
  'checkpoint-transcripts-applied',
  'checkpoint-metadata-staged',
  'checkpoint-descriptors-published',
  'checkpoint-journal-rotated',
])(
  'finalizes a child behind an open row exactly once after %s crash and two reopens',
  async (seam) => {
    const root = await mkdtemp(join(tmpdir(), 'child-finalization-'));
    try {
      const store = new ChatStorageV2(root, 'scope', undefined, {
        maxManifestVersion: 4,
      });
      await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
      await promoteToDeltaJournal(store);
      const writer = await promoteToFormat4Journal(store);
      const target = {
        kind: 'delegation' as const,
        chatId: 'chat',
        delegationId: 'd',
        runGeneration: 0,
      };
      const next = writer.indexes();
      await writer.commit({
        expectedRevision: next.live.revision,
        next: {
          live: { ...next.live, revision: next.live.revision + 1 },
          archive: { ...next.archive, revision: next.live.revision + 1 },
          recovery: {
            ...next.recovery,
            mutationIds: [...next.recovery.mutationIds, 'child-open'],
          },
        },
        writes: [],
        mutationIds: ['child-open'],
        streamRegistrations: [
          { target, streamKey: delegationStreamKey(target) },
        ],
        childWrites: [
          {
            target,
            rows: [
              {
                ...message('a:open', 'open'),
                parentBlockId: 'a',
                delegationSequence: 0,
                itemRevision: 0,
                final: false,
              },
              {
                ...message('a:final', 'final'),
                parentBlockId: 'a',
                delegationSequence: 1,
                itemRevision: 0,
                final: true,
              },
            ],
          },
        ],
      });
      const faulted = await ChatDeltaJournalWriter.open(store, {
        maxManifestVersion: 4,
        onBoundary: (boundary) =>
          boundary === seam
            ? Promise.reject(new Error(`fault:${seam}`))
            : Promise.resolve(),
      });
      await expect(faulted.checkpoint()).rejects.toThrow(`fault:${seam}`);
      for (let reopen = 0; reopen < 2; reopen += 1)
        await ChatDeltaJournalWriter.open(store, { maxManifestVersion: 4 });
      const paths = streamRegistryPaths(
        join(store.directory, 'transcripts'),
        'chat',
        delegationStreamKey(target),
      );
      const committed = await readFile(paths.log, 'utf8');
      expect(committed.trim().split('\n')).toHaveLength(1);
      expect(committed).toContain('a:final');
      expect(
        await readFile(
          `${paths.streamDirectory}/transcript.active.json`,
          'utf8',
        ),
      ).toContain('a:open');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('keeps final row bodies out of the child sidecar across checkpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'child-open-bytes-'));
  try {
    const store = new ChatStorageV2(root, 'scope', undefined, {
      maxManifestVersion: 4,
    });
    await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
    await promoteToDeltaJournal(store);
    const writer = await promoteToFormat4Journal(store);
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'large',
      runGeneration: 0,
    };
    const apply = async (
      key: string,
      rows: Array<{
        id: string;
        text: string;
        sequence: number;
        final: boolean;
      }>,
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
        childWrites: [
          {
            target,
            rows: rows.map((row) => ({
              ...message(row.id, row.text),
              parentBlockId: 'delegated-agent-large',
              delegationSequence: row.sequence,
              itemRevision: 0,
              final: row.final,
            })),
          },
        ],
      });
      await writer.checkpoint();
    };
    await apply('seed', [
      { id: 'a:open', text: 'open', sequence: 0, final: false },
    ]);
    const paths = streamRegistryPaths(
      join(store.directory, 'transcripts'),
      'chat',
      delegationStreamKey(target),
    );
    resetWorkCounters();
    for (let index = 0; index < 4; index += 1)
      await apply(`final-${index}`, [
        {
          id: `a:final-${index}`,
          text: 'x'.repeat(16 * 1024),
          sequence: index + 1,
          final: true,
        },
      ]);
    const counters = snapshotWorkCounters().chatStorage;
    const sidecarBytes = counters['written.childActiveSidecar.bytes'] ?? 0;
    const transcriptBytes = counters['written.childTranscript.bytes'] ?? 0;
    expect(sidecarBytes).toBeLessThan(transcriptBytes / 8);
    expect(
      (await stat(`${paths.streamDirectory}/transcript.active.json`)).size,
    ).toBeLessThan(2048);
    expect((await readFile(paths.log, 'utf8')).trim().split('\n')).toHaveLength(
      4,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each<DeltaJournalBoundary>([
  'checkpoint-transcripts-applied',
  'checkpoint-metadata-staged',
  'checkpoint-descriptors-published',
])(
  'resumes rev0-to-final and a second child after %s without duplicate appends',
  async (seam) => {
    const root = await mkdtemp(join(tmpdir(), 'child-revision-resume-'));
    try {
      const store = new ChatStorageV2(root, 'scope', undefined, {
        maxManifestVersion: 4,
      });
      await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
      await promoteToDeltaJournal(store);
      const writer = await promoteToFormat4Journal(store);
      const a = {
        kind: 'delegation' as const,
        chatId: 'chat',
        delegationId: 'a',
        runGeneration: 0,
      };
      const b = {
        kind: 'delegation' as const,
        chatId: 'chat',
        delegationId: 'b',
        runGeneration: 0,
      };
      const commit = async (
        key: string,
        childWrites: NonNullable<
          Parameters<typeof writer.commit>[0]['childWrites']
        >,
        register = false,
      ): Promise<void> => {
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
          childWrites,
          ...(register
            ? {
                streamRegistrations: [a, b].map((target) => ({
                  target,
                  streamKey: delegationStreamKey(target),
                })),
              }
            : {}),
        });
      };
      await commit(
        'open',
        [
          {
            target: a,
            rows: [
              {
                ...message('a:item', 'draft'),
                parentBlockId: 'a',
                delegationSequence: 0,
                itemRevision: 0,
                final: false,
              },
            ],
          },
        ],
        true,
      );
      await commit('final', [
        {
          target: a,
          rows: [
            {
              ...message('a:item', 'done'),
              parentBlockId: 'a',
              delegationSequence: 0,
              itemRevision: 1,
              final: true,
            },
          ],
        },
        {
          target: b,
          rows: [
            {
              ...message('b:item', 'done'),
              parentBlockId: 'b',
              delegationSequence: 0,
              itemRevision: 0,
              final: true,
            },
          ],
        },
      ]);
      const faulted = await ChatDeltaJournalWriter.open(store, {
        maxManifestVersion: 4,
        onBoundary: (point) =>
          point === seam
            ? Promise.reject(new Error(`fault:${seam}`))
            : Promise.resolve(),
      });
      await expect(faulted.checkpoint()).rejects.toThrow(`fault:${seam}`);
      for (let index = 0; index < 2; index += 1)
        await ChatDeltaJournalWriter.open(store, { maxManifestVersion: 4 });
      for (const target of [a, b]) {
        const path = streamRegistryPaths(
          join(store.directory, 'transcripts'),
          'chat',
          delegationStreamKey(target),
        ).log;
        expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(
          1,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each<DeltaJournalBoundary>([
  'checkpoint-transcripts-applied',
  'checkpoint-metadata-staged',
])('resumes a child revised while open after %s', async (seam) => {
  const root = await mkdtemp(join(tmpdir(), 'child-open-revision-resume-'));
  try {
    const store = new ChatStorageV2(root, 'scope', undefined, {
      maxManifestVersion: 4,
    });
    await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
    await promoteToDeltaJournal(store);
    const writer = await promoteToFormat4Journal(store);
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'd',
      runGeneration: 0,
    };
    const drafts = ['draft', 'longer draft'];
    for (
      let itemRevision = 0;
      itemRevision < drafts.length;
      itemRevision += 1
    ) {
      const text = drafts[itemRevision];
      const key = `open-${itemRevision}`;
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
        ...(itemRevision === 0
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
                ...message('d:item', text),
                parentBlockId: 'd',
                delegationSequence: 0,
                itemRevision,
                final: false,
              },
            ],
          },
        ],
      });
    }
    const faulted = await ChatDeltaJournalWriter.open(store, {
      maxManifestVersion: 4,
      onBoundary: (point) =>
        point === seam
          ? Promise.reject(new Error(`fault:${seam}`))
          : Promise.resolve(),
    });
    await expect(faulted.checkpoint()).rejects.toThrow(`fault:${seam}`);
    for (let index = 0; index < 2; index += 1)
      await ChatDeltaJournalWriter.open(store, { maxManifestVersion: 4 });
    const paths = streamRegistryPaths(
      join(store.directory, 'transcripts'),
      'chat',
      delegationStreamKey(target),
    );
    expect(await readFile(paths.log, 'utf8')).toBe('');
    expect(
      await readFile(`${paths.streamDirectory}/transcript.active.json`, 'utf8'),
    ).toContain('longer draft');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each<DeltaJournalBoundary | 'none'>([
  'none',
  'checkpoint-transcripts-applied',
])(
  'deletes a parent with pending artifact-bearing child rows (crash: %s)',
  async (seam) => {
    const root = await mkdtemp(join(tmpdir(), 'child-parent-delete-'));
    try {
      const store = new ChatStorageV2(root, 'scope', undefined, {
        maxManifestVersion: 4,
      });
      await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
      await promoteToDeltaJournal(store);
      const writer = await promoteToFormat4Journal(store);
      const target = {
        kind: 'delegation' as const,
        chatId: 'chat',
        delegationId: 'd',
        runGeneration: 0,
      };
      let current = writer.indexes();
      await writer.commit({
        expectedRevision: current.live.revision,
        next: {
          live: { ...current.live, revision: current.live.revision + 1 },
          archive: { ...current.archive, revision: current.live.revision + 1 },
          recovery: {
            ...current.recovery,
            mutationIds: [...current.recovery.mutationIds, 'child'],
          },
        },
        writes: [],
        mutationIds: ['child'],
        streamRegistrations: [
          { target, streamKey: delegationStreamKey(target) },
        ],
        childWrites: [
          {
            target,
            rows: [
              {
                ...toolMessage(
                  'd:item',
                  'x'.repeat(TOOL_OUTPUT_INLINE_BYTES + 1024),
                ),
                parentBlockId: 'd',
                delegationSequence: 0,
                itemRevision: 0,
                final: true,
              },
            ],
          },
        ],
      });
      current = writer.indexes();
      await writer.commit({
        expectedRevision: current.live.revision,
        next: {
          live: {
            ...current.live,
            revision: current.live.revision + 1,
            tabs: [],
            activeTabId: '',
            runtimeByChatId: {},
          },
          archive: { ...current.archive, revision: current.live.revision + 1 },
          recovery: {
            ...current.recovery,
            mutationIds: [...current.recovery.mutationIds, 'delete'],
          },
        },
        writes: [{ chatId: 'chat', kind: 'delete' }],
        mutationIds: ['delete'],
      });
      // Before the checkpoint, a lease-free view must not serve the deleted parent's child stream.
      const view = await openReplayedChatScope(
        { directory: store.directory, scopeId: 'scope' },
        assertChatStorageIndexes,
        { maxManifestVersion: 4 },
      );
      try {
        await expect(view.stream(target)).rejects.toThrow(
          'Unknown child stream',
        );
      } finally {
        await view.dispose();
      }
      if (seam === 'none') await writer.checkpoint();
      else {
        const faulted = await ChatDeltaJournalWriter.open(store, {
          maxManifestVersion: 4,
          onBoundary: (point) =>
            point === seam
              ? Promise.reject(new Error(`fault:${seam}`))
              : Promise.resolve(),
        });
        await expect(faulted.checkpoint()).rejects.toThrow(`fault:${seam}`);
      }
      for (let index = 0; index < 2; index += 1) {
        const reopened = await ChatDeltaJournalWriter.open(store, {
          maxManifestVersion: 4,
        });
        expect(reopened.indexes().live.tabs).toHaveLength(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('recovers a child append intent after its sidecar was published', async () => {
  const root = await mkdtemp(join(tmpdir(), 'child-intent-checkpoint-'));
  try {
    const store = new ChatStorageV2(root, 'scope', undefined, {
      maxManifestVersion: 4,
    });
    await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
    await promoteToDeltaJournal(store);
    const writer = await promoteToFormat4Journal(store);
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'intent',
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
          mutationIds: [...current.recovery.mutationIds, 'intent'],
        },
      },
      writes: [],
      mutationIds: ['intent'],
      streamRegistrations: [{ target, streamKey: delegationStreamKey(target) }],
      childWrites: [
        {
          target,
          rows: [
            {
              ...message('intent:item', 'final'),
              parentBlockId: 'intent',
              delegationSequence: 0,
              itemRevision: 0,
              final: true,
            },
          ],
        },
      ],
    });
    const faulty = await ChatDeltaJournalWriter.open(store, {
      maxManifestVersion: 4,
      onBoundary: (point) =>
        point === 'checkpoint-child-append-prepared'
          ? Promise.reject(new Error('child intent published'))
          : Promise.resolve(),
    });
    await expect(faulty.checkpoint()).rejects.toThrow('child intent published');
    for (let index = 0; index < 2; index += 1)
      await ChatDeltaJournalWriter.open(store, { maxManifestVersion: 4 });
    const path = streamRegistryPaths(
      join(store.directory, 'transcripts'),
      'chat',
      delegationStreamKey(target),
    ).log;
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
