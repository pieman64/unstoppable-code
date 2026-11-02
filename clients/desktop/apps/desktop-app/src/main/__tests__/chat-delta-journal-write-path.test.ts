/**
 * The phase 09 write path with default journal storage:
 * commits append one delta record and sync the journal once; the index and
 * transcript files are lazy checkpoints.
 *
 * - Counters: a streamed tool result issues one sync and writes O(delta)
 *   bytes (red against the version 2 path), and a message send does no more
 *   sync or write work than the direct version 2 backend.
 * - Views: every state and page a sequence produces equals the version 2
 *   path's, step by step, while records are journaled.
 * - Triggers: inline checkpoints for committed-row records, the idle and
 *   size triggers, flush.
 * - Restart without a checkpoint keeps receipts, tombstones and dedup.
 * - Publication guards, large mutations and imports.
 */
import type * as NativeFs from 'node:fs/promises';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatCoreMutation } from '@canopy/desktop-shared/types';
import { summarizeDeltaJournal } from '../lib/chat-delta-journal/reader';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import type { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import {
  setChatTranscriptRewriteDiagnosticsForTests,
  type ChatTranscriptFullRewriteDiagnostic,
} from '../services/chat-transcript-rewrite-diagnostics';
import { createV2Scope } from './helpers/chat-delta-journal-harness';
import {
  drainOpenRepositories,
  idle,
  manifestVersion,
  measureWork,
  repositoryAt,
  storeAt,
  streaming,
  text,
  toolResult,
  upsert,
} from './helpers/chat-delta-journal-scope';

const nativeFs = jest.requireActual<typeof NativeFs>('node:fs/promises');
const SCOPE = { projectId: 'workspace', worktreeId: 'scope' };

/** A direct V2 oracle; canonical repositories always exercise the journal. */
type ComparedStorage = Pick<
  ChatStateV2Repository,
  'transact' | 'getState' | 'page' | 'flushScope' | 'drainAll'
>;
function comparedStorage(root: string, journal: boolean): ComparedStorage {
  if (journal) return repositoryAt(root);
  const backend = new ChatStateV2Backend(storeAt(root, 'scope'));
  return {
    transact: async (scope, mutations, options) => ({
      ...(await backend.transact(() => [...mutations], options)),
      ...scope,
    }),
    getState: (_scope, options) => backend.state(options),
    page: (_scope, chatId, before, expectedRevision, options) =>
      backend.page(chatId, before, expectedRevision, options),
    flushScope: () => backend.flush(),
    drainAll: () => backend.flush(),
  };
}

async function seed(root: string): Promise<void> {
  await createV2Scope(root, 'scope', [
    {
      id: 'chat',
      messages: [text('m0', 'hello', 'user'), text('m1', 'answer')],
    },
  ]);
}

async function pendingRecords(root: string): Promise<number> {
  const store = storeAt(root, 'scope');
  return (
    await summarizeDeltaJournal({
      directory: store.directory,
      scopeId: 'scope',
    })
  ).recordCount;
}

async function eventually(
  condition: () => Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let ordinal = 0;
function commit(
  repository: Pick<ChatStateV2Repository, 'transact'>,
  mutations: ChatCoreMutation[],
  options: { commandId?: string; mutationId?: string } = {},
): ReturnType<ChatStateV2Repository['transact']> {
  ordinal += 1;
  return repository.transact(SCOPE, mutations, {
    source: 'provider',
    mutationId: options.mutationId ?? `mutation-${ordinal}`,
    chatIds: ['chat'],
    ...(options.commandId
      ? {
          commandResult: {
            commandId: options.commandId,
            outcome: 'applied',
          },
        }
      : {}),
  });
}

/** A turn started and `steps` tool results streamed into it. */
async function streamTurn(
  repository: Pick<ChatStateV2Repository, 'transact'>,
  turn: string,
  steps: number,
): Promise<void> {
  await commit(repository, [
    streaming('chat', `${turn}-p`),
    upsert('chat', text(`${turn}-p`, `prompt ${turn}`, 'user')),
  ]);
  for (let step = 0; step < steps; step += 1) {
    await commit(repository, [
      upsert('chat', text(`${turn}-a${step}`, `step ${step} of ${turn}`)),
    ]);
    await commit(repository, [
      upsert(
        'chat',
        toolResult(`${turn}-t${step}`, `output ${step} `.repeat(30)),
      ),
    ]);
  }
}

describe('delta journal write path', () => {
  let root: string;
  // Every commit syncs real files; the version 2 runs are slower.
  jest.setTimeout(180_000);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-delta-journal-write-path-'));
    ordinal = 0;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await drainOpenRepositories();
    await rm(root, { recursive: true, force: true });
  });

  it('commits a streamed tool result with one sync and O(delta) bytes', async () => {
    await seed(root);
    const repository = repositoryAt(root);
    await repository.getState(SCOPE);
    // A long active turn: its rewrite would cost far more than the delta.
    await streamTurn(repository, 'turn', 60);
    const result = toolResult('streamed', 'one more tool result '.repeat(10));
    const delta = JSON.stringify(result).length;
    const done = measureWork();
    await commit(repository, [upsert('chat', result)]);
    const work = done();
    expect({
      syncs: work.syncs,
      journalSyncs: work.journalSyncs,
      commits: work.commits,
      checkpoints: work.checkpoints,
    }).toEqual({ syncs: 1, journalSyncs: 1, commits: 1, checkpoints: 0 });
    // The record carries the new row plus framing and a small index delta.
    expect(work.written).toBeLessThan(delta + 2048);
    expect(Object.keys(work.writtenByClass)).toEqual(['deltaJournal']);
    expect(await manifestVersion(storeAt(root, 'scope'))).toBe(3);
    await repository.drainAll();
  });

  it('does no more sync or write work for a message send than the direct version 2 backend', async () => {
    const measureSend = async (
      enabled: boolean,
    ): Promise<{
      syncs: number;
      written: number;
    }> => {
      const scopeRoot = join(root, enabled ? 'on' : 'off');
      await seed(scopeRoot);
      const repository = comparedStorage(scopeRoot, enabled);
      await repository.getState(SCOPE);
      await streamTurn(repository, 'first', 5);
      await commit(repository, [idle('chat')]);
      await repository.flushScope(SCOPE);
      const done = measureWork();
      await commit(repository, [
        streaming('chat', 'send'),
        upsert('chat', text('send', 'the next prompt', 'user')),
      ]);
      const work = done();
      await repository.drainAll();
      return { syncs: work.syncs, written: work.written };
    };
    const off = await measureSend(false);
    const on = await measureSend(true);
    expect(on.syncs).toBeLessThanOrEqual(off.syncs);
    expect(on.written).toBeLessThanOrEqual(off.written);
  });

  it('serves every state and page the version 2 path serves', async () => {
    const big = (id: string, label: string): ReturnType<typeof toolResult> =>
      toolResult(id, `${label} 🌲\n`.repeat(9000));
    const steps: Array<{
      mutations: ChatCoreMutation[];
      options?: { commandId?: string };
    }> = [
      {
        mutations: [
          streaming('chat', 'p1'),
          upsert('chat', text('p1', 'prompt é', 'user')),
        ],
      },
      { mutations: [upsert('chat', text('a1', 'partial'))] },
      { mutations: [upsert('chat', text('a1', 'partial, then more'))] },
      { mutations: [upsert('chat', big('t1', 'externalized'))] },
      { mutations: [upsert('chat', toolResult('t2', 'short'))] },
      {
        mutations: [
          upsert('chat', text('a2', 'answer')),
          { type: 'message.removed', chatId: 'chat', messageId: 't2' },
        ],
      },
      {
        mutations: [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat',
            patch: { title: 'Renamed', unread: true },
          },
        ],
        options: { commandId: 'rename' },
      },
      { mutations: [idle('chat')] },
      {
        mutations: [
          {
            type: 'tab.created',
            tab: {
              id: 'second',
              title: 'Second',
              createdAt: '2026-10-01',
              messages: [text('s0', 'second chat', 'user')],
            },
          },
        ],
      },
      {
        mutations: [
          streaming('second', 's1'),
          upsert('second', text('s1', 'again', 'user')),
          upsert('second', text('s2', 'mixed commit')),
        ],
      },
      {
        mutations: [
          { type: 'message.removed', chatId: 'chat', messageId: 'm1' },
        ],
      },
      { mutations: [{ type: 'tab.removed', tabId: 'second' }] },
    ];
    const run = async (enabled: boolean): Promise<string[]> => {
      const scopeRoot = join(root, enabled ? 'on' : 'off');
      await seed(scopeRoot);
      const repository = comparedStorage(scopeRoot, enabled);
      await repository.getState(SCOPE);
      const views: string[] = [];
      let index = 0;
      for (const step of steps) {
        index += 1;
        const result = await repository.transact(SCOPE, step.mutations, {
          source: 'provider',
          mutationId: `step-${index}`,
          chatIds: ['chat', 'second'],
          ...(step.options?.commandId
            ? {
                commandResult: {
                  commandId: step.options.commandId,
                  outcome: 'applied',
                },
              }
            : {}),
        });
        const state = await repository.getState(SCOPE, {
          chatIds: ['chat', 'second'],
        });
        const pages = [];
        for (const tab of state.tabsFile.tabs) {
          const messagePage = await repository.page(SCOPE, tab.id);
          const turnPage = await repository.page(
            SCOPE,
            tab.id,
            undefined,
            undefined,
            { view: 'turns' },
          );
          // Each path must still expose one consistent transcript revision.
          expect(messagePage.transcriptRevision).toBe(
            tab.transcript?.transcriptRevision,
          );
          expect(turnPage.transcriptRevision).toBe(
            tab.transcript?.transcriptRevision,
          );
          pages.push(messagePage, turnPage);
        }
        views.push(
          JSON.stringify(
            {
              revision: result.revision,
              record: result.record.mutations,
              state,
              transcripts: state.tabsFile.tabs.map((tab) => tab.transcript),
              pages,
            },
            (key, value: unknown) =>
              // Phase 25 deliberately appends journal-off mixed tails while
              // journal-on keeps replacing. These log-operation counters need
              // not match; scope revisions, state and page contents still must.
              key === 'transcriptRevision' ? undefined : value,
          ),
        );
      }
      await repository.drainAll();
      return views;
    };
    const off = await run(false);
    const on = await run(true);
    expect(on).toHaveLength(off.length);
    for (let step = 0; step < off.length; step += 1)
      expect({ step, view: on[step] }).toEqual({ step, view: off[step] });
  });

  it('checkpoints records that change committed rows before acknowledging them', async () => {
    await seed(root);
    const repository = repositoryAt(root);
    await repository.getState(SCOPE);
    // Turn start appends the prompt: checkpointed inline.
    const turnStart = measureWork();
    await commit(repository, [
      streaming('chat', 'p'),
      upsert('chat', text('p', 'prompt', 'user')),
    ]);
    expect(await pendingRecords(root)).toBe(0);
    expect(turnStart().checkpoints).toBe(1);
    // Streaming and metadata stay journaled.
    await commit(repository, [upsert('chat', text('a', 'reply'))]);
    await commit(repository, [
      {
        type: 'tab.metadata_patched',
        tabId: 'chat',
        patch: { unread: true },
      },
    ]);
    expect(await pendingRecords(root)).toBe(2);
    // Turn end finalizes the rows: checkpointed inline.
    await commit(repository, [idle('chat')]);
    expect(await pendingRecords(root)).toBe(0);
    await repository.drainAll();
  });

  it('reports a full committed rewrite the same way as the direct version 2 backend', async () => {
    // A patch to a committed row is journaled, then checkpointed before it
    // is acknowledged, and that checkpoint rewrites the committed log through
    // the same replacement the version 2 path runs. The rewrite diagnostic
    // describes the mutation, so it must not depend on the storage format.
    const reported = async (
      enabled: boolean,
    ): Promise<ChatTranscriptFullRewriteDiagnostic[]> => {
      const scopeRoot = join(root, enabled ? 'on' : 'off');
      await seed(scopeRoot);
      const repository = comparedStorage(scopeRoot, enabled);
      await repository.getState(SCOPE);
      const records: ChatTranscriptFullRewriteDiagnostic[] = [];
      setChatTranscriptRewriteDiagnosticsForTests({
        sink: (record): void => {
          records.push(record);
        },
      });
      try {
        await commit(repository, [
          upsert('chat', text('m1', 'answer, edited after it was committed')),
        ]);
        if (enabled) expect(await pendingRecords(scopeRoot)).toBe(0);
      } finally {
        setChatTranscriptRewriteDiagnosticsForTests();
        await repository.drainAll();
      }
      return records;
    };

    const off = await reported(false);
    const on = await reported(true);
    expect(off).toHaveLength(1);
    for (const record of [...off, ...on]) {
      expect(Number.isFinite(record.chatTranscriptRewriteDurationMs)).toBe(
        true,
      );
      expect(record.chatTranscriptRewriteDurationMs).toBeGreaterThanOrEqual(0);
    }
    expect(off[0]).toMatchObject({
      kind: 'chat_transcript_full_rewrite',
      reason: 'patch',
      chatTranscriptRewriteCommittedRows: 2,
      chatTranscriptRewritePatchedRows: 1,
      chatTranscriptRewriteRemovedRows: 0,
    });
    const comparable = (
      record: ChatTranscriptFullRewriteDiagnostic,
    ): Omit<
      ChatTranscriptFullRewriteDiagnostic,
      'timestamp' | 'chatTranscriptRewriteDurationMs'
    > => {
      const {
        timestamp: _timestamp,
        chatTranscriptRewriteDurationMs: _duration,
        ...rest
      } = record;
      void _timestamp;
      void _duration;
      return rest;
    };
    expect(on.map(comparable)).toEqual(off.map(comparable));
  });

  it('checkpoints after about a second of idle and past the size threshold', async () => {
    await seed(root);
    const idleRepository = repositoryAt(root, {
      deltaJournalIdleCheckpointMs: 20,
    });
    await idleRepository.getState(SCOPE);
    await commit(idleRepository, [streaming('chat', 'p')]);
    expect(await pendingRecords(root)).toBe(1);
    await eventually(
      async () => (await pendingRecords(root)) === 0,
      'idle checkpoint',
    );
    await idleRepository.drainAll();

    const sizeRepository = repositoryAt(root, {
      deltaJournalIdleCheckpointMs: 60_000,
      deltaJournalCheckpointBytes: 1,
    });
    await sizeRepository.getState(SCOPE);
    await commit(sizeRepository, [upsert('chat', text('a', 'reply'))]);
    await eventually(
      async () => (await pendingRecords(root)) === 0,
      'size checkpoint',
    );
    await sizeRepository.drainAll();
  });

  it('keeps receipts, tombstones and retry dedup across a restart before any checkpoint', async () => {
    await seed(root);
    // Several repositories share this scope; none checkpoints on its own.
    const inert = { deltaJournalIdleCheckpointMs: 3_600_000 };
    const first = repositoryAt(root, inert);
    await first.getState(SCOPE);
    await commit(first, [streaming('chat', 'p')]);
    await commit(first, [upsert('chat', text('a', 'reply'))]);
    await commit(
      first,
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { title: 'Receipt' },
        },
      ],
      { commandId: 'command-1', mutationId: 'retried' },
    );
    expect(await pendingRecords(root)).toBe(3);
    const before = JSON.stringify(
      await first.getState(SCOPE, { chatIds: ['chat'] }),
    );
    // The process dies: no drain, no checkpoint.
    const second = repositoryAt(root, inert);
    expect(
      JSON.stringify(await second.getState(SCOPE, { chatIds: ['chat'] })),
    ).toBe(before);
    expect(await second.getReceipt(SCOPE, 'command-1')).toEqual(
      expect.objectContaining({ commandId: 'command-1', outcome: 'applied' }),
    );
    expect(await second.hasMutation(SCOPE, 'retried')).toBe(true);
    const retry = await commit(
      second,
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { title: 'Receipt' },
        },
      ],
      { commandId: 'command-1', mutationId: 'retried' },
    );
    expect(retry.applied).toBe(false);
    // A removal tombstone recorded only in the journal survives too.
    await commit(second, [
      { type: 'message.removed', chatId: 'chat', messageId: 'a' },
    ]);
    const third = repositoryAt(root, inert);
    expect(await third.hasRemovedMessage(SCOPE, 'a')).toBe(true);
    await second.drainAll();
    await third.drainAll();
  });

  it('never deletes an artifact a journal record references; maintenance waits for the checkpoint', async () => {
    await seed(root);
    const store = storeAt(root, 'scope');
    const backend = new ChatStateV2Backend(store, { deltaJournal: {} });
    await backend.load();
    await backend.promoteToDeltaJournal();
    let id = 0;
    const transact = (mutations: ChatCoreMutation[]): Promise<unknown> => {
      id += 1;
      return backend.transact(() => mutations, {
        source: 'provider',
        mutationId: `maintenance-${id}`,
        chatIds: ['chat'],
      });
    };
    const outputs = join(store.directory, 'transcripts', 'tool-output', 'chat');
    const artifacts = async (): Promise<string[]> => {
      try {
        return (await readdir(outputs)).sort();
      } catch {
        return [];
      }
    };
    await transact([
      streaming('chat', 'p'),
      upsert('chat', text('p', 'prompt', 'user')),
    ]);
    await transact([upsert('chat', text('a', 'running a tool'))]);
    // Two outputs for one row: only journal records reference either.
    await transact([
      upsert('chat', toolResult('t', 'first 🌲\n'.repeat(9000))),
    ]);
    const first = await artifacts();
    await transact([
      upsert('chat', toolResult('t', 'second 🌲\n'.repeat(9000))),
    ]);
    const both = await artifacts();
    expect(first).toHaveLength(1);
    expect(both).toHaveLength(2);
    expect(backend.pendingJournalRecords()).toBeGreaterThan(0);
    // The files reference neither output, so a scan now would delete the
    // live one: maintenance must not run.
    expect(await backend.pendingArtifactMaintenanceChats()).toEqual([]);
    await expect(backend.maintainArtifacts('chat')).rejects.toThrow(
      'replay is pending',
    );
    expect(await artifacts()).toEqual(both);
    // The turn ends: its rows are checkpointed with the second output.
    await transact([idle('chat')]);
    expect(backend.pendingJournalRecords()).toBe(0);
    expect(await backend.pendingArtifactMaintenanceChats()).toEqual(['chat']);
    for (let chunk = 0; chunk < 50; chunk += 1)
      if ((await backend.maintainArtifacts('chat')).complete) break;
    const kept = await artifacts();
    expect(kept).toHaveLength(1);
    expect(kept).not.toEqual(first);
    const page = await backend.page('chat');
    const result = page.messages.find((row) => row.id === 't')?.blocks[0];
    expect(
      result?.type === 'tool_result'
        ? result.fullOutputRef?.artifactId
        : undefined,
    ).toBe(kept[0].replace(/\.txt$/, ''));
    await backend.disposeArtifactMaintenance();
  });

  it('honors the publication guards and keeps nothing a refused commit created', async () => {
    await seed(root);
    const repository = repositoryAt(root);
    await repository.getState(SCOPE);
    await commit(repository, [streaming('chat', 'p')]);
    const store = storeAt(root, 'scope');
    const before = (await stat(join(store.directory, 'delta-journal.log')))
      .size;
    const order: string[] = [];
    await expect(
      repository.transact(
        SCOPE,
        [upsert('chat', toolResult('big', 'refused 🌲\n'.repeat(9000)))],
        {
          source: 'provider',
          mutationId: 'refused',
          preparePublish: async (): Promise<void> => {
            order.push('prepare');
            await Promise.resolve();
          },
          beforePublish: (): void => {
            order.push('before');
            throw new Error('not authorized');
          },
        },
      ),
    ).rejects.toThrow('not authorized');
    expect(order).toEqual(['prepare', 'before']);
    expect((await stat(join(store.directory, 'delta-journal.log'))).size).toBe(
      before,
    );
    let artifacts: string[] = [];
    try {
      artifacts = await readdir(
        join(store.directory, 'transcripts', 'tool-output', 'chat'),
      );
    } catch {
      artifacts = [];
    }
    expect(artifacts).toEqual([]);
    await repository.drainAll();
  });

  it('takes the version 2 path for a large mutation and promotes again', async () => {
    await seed(root);
    const repository = repositoryAt(root, { deltaJournalLargeRecordBytes: 64 });
    await repository.getState(SCOPE);
    await commit(repository, [streaming('chat', 'p')]);
    await commit(repository, [
      upsert('chat', text('large', 'a row larger than the threshold')),
    ]);
    // The large commit ran as version 2; the scope is version 3 again once
    // its reconcile turn runs.
    await eventually(
      async () => (await manifestVersion(storeAt(root, 'scope'))) === 3,
      're-promotion',
    );
    const state = await repository.getState(SCOPE, { chatIds: ['chat'] });
    expect(state.tabsFile.tabs[0].messages.map((row) => row.id)).toContain(
      'large',
    );
    await repository.drainAll();
  });

  it('imports into a version 3 scope through one version 2 transaction', async () => {
    await seed(root);
    const sourceRoot = join(root, 'source');
    const source = await createV2Scope(sourceRoot, 'source', [
      { id: 'imported', messages: [text('i0', 'imported', 'user')] },
    ]);

    const repository = repositoryAt(root);
    await repository.getState(SCOPE);
    await commit(repository, [upsert('chat', text('m2', 'journaled'))]);
    const metadata = await new ChatStateV2Backend(source).state();
    await repository.importScope(
      SCOPE,
      source,
      { tabsFile: metadata.tabsFile, archivesFile: metadata.archivesFile },
      { merge: true, mutationId: 'import' },
    );
    await eventually(
      async () => (await manifestVersion(storeAt(root, 'scope'))) === 3,
      're-promotion after import',
    );
    const state = await repository.getState(SCOPE, {
      chatIds: ['chat', 'imported'],
    });
    expect(state.tabsFile.tabs.map((tab) => tab.id).sort()).toEqual([
      'chat',
      'imported',
    ]);
    expect(
      state.tabsFile.tabs
        .find((tab) => tab.id === 'chat')
        ?.messages.map((row) => row.id),
    ).toContain('m2');
    await repository.drainAll();
  });

  // Jest runs later test files in the same process: an idle checkpoint left
  // armed fires during another file and opens files that its spies count.
  it('cancels an armed idle checkpoint at a drain, after which no storage work runs', async () => {
    await seed(root);
    const repository = repositoryAt(root, {
      deltaJournalIdleCheckpointMs: 100,
    });
    await repository.getState(SCOPE);
    await commit(repository, [streaming('chat', 'p')]);
    expect(await pendingRecords(root)).toBe(1);
    await repository.drainAll();
    // The drain checkpointed what the idle trigger would have.
    expect(await pendingRecords(root)).toBe(0);
    const open = jest.spyOn(nativeFs, 'open');
    await expect(commit(repository, [idle('chat')])).rejects.toThrow(
      'draining',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(open).not.toHaveBeenCalled();
  });
});
