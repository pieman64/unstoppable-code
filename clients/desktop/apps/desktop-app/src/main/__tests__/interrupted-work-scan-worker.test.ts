import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanInterruptedWork } from '../lib/interrupted-work-scan-worker';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { scopeSource } from './helpers/chat-delta-journal-harness';

describe('interrupted work startup scan', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'interrupted-work-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it('finds journal-only and legacy timer/terminal work while excluding settled history and archives', async () => {
    const workspace = join(root, 'workspaces', 'workspace');
    await mkdir(join(workspace, 'chats'), { recursive: true });
    await mkdir(join(workspace, 'chat-journals'), { recursive: true });
    await mkdir(join(workspace, 'archived-containers', 'archived', 'chats'), {
      recursive: true,
    });
    const open = {
      tabs: [
        {
          id: 'chat',
          messages: [{ blocks: [{ type: 'turn_timer', completedAt: null }] }],
        },
      ],
    };
    await writeFile(
      join(workspace, 'chats', 'legacy.json'),
      JSON.stringify(open),
    );
    await writeFile(
      join(workspace, 'chats', 'terminal.json'),
      JSON.stringify({ tabs: [{ claudeTerminal: { turnState: 'running' } }] }),
    );
    await writeFile(
      join(
        workspace,
        'archived-containers',
        'archived',
        'chats',
        'ignored.json',
      ),
      JSON.stringify(open),
    );
    const runtime = (status: string): string =>
      JSON.stringify({
        mutations: [
          { type: 'runtime.patched', chatId: 'chat', runtime: { status } },
        ],
      }) + '\n';
    await writeFile(
      join(workspace, 'chat-journals', 'journal.jsonl'),
      runtime('streaming') + '{"torn',
    );
    await writeFile(
      join(workspace, 'chat-journals', 'done.jsonl'),
      runtime('streaming') + runtime('completed'),
    );
    await writeFile(
      join(workspace, 'chat-journals', 'removed.jsonl'),
      runtime('streaming') +
        JSON.stringify({
          mutations: [{ type: 'tab.removed', tabId: 'chat' }],
        }) +
        '\n',
    );
    const found = await scanInterruptedWork(
      [join(root, 'workspaces'), join(root, 'missing')],
      join(root, 'pipelines'),
    );
    expect(found.chatScopes.map((scope) => scope.worktreeId).sort()).toEqual([
      'journal',
      'legacy',
      'terminal',
    ]);
    expect(found.errors).toEqual([]);
  });

  it('does not treat an intentionally paused timer as interrupted work', async () => {
    const workspace = join(root, 'workspaces', 'workspace');
    await mkdir(join(workspace, 'chats'), { recursive: true });
    await writeFile(
      join(workspace, 'chats', 'paused.json'),
      JSON.stringify({
        tabs: [
          {
            id: 'chat',
            messages: [
              {
                blocks: [
                  {
                    type: 'turn_timer',
                    completedAt: null,
                    pausedAt: 20,
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    const found = await scanInterruptedWork(
      [join(root, 'workspaces')],
      join(root, 'pipelines'),
    );

    expect(found.chatScopes).toEqual([]);
    expect(found.errors).toEqual([]);
  });

  it('distinguishes anchored sidecars from unfinished ordinary parent rows, with legacy fallback', async () => {
    const workspace = join(root, 'workspaces', 'workspace');
    for (const [id, ordinary] of [
      ['anchored-only', false],
      ['ordinary-tail', true],
      ['legacy-tail', undefined],
    ] as const) {
      const directory = join(workspace, 'chat-storage-v2', id);
      await mkdir(directory, { recursive: true });
      await mkdir(join(workspace, 'chat-storage-manifests'), {
        recursive: true,
      });
      await writeFile(
        join(workspace, 'chat-storage-manifests', `${id}.json`),
        JSON.stringify({ version: 2, scopeId: id }),
      );
      await writeFile(
        join(directory, 'live-index.json'),
        JSON.stringify({
          version: 2,
          tabs: [
            {
              id: 'chat',
              transcript: {
                hasActiveSidecar: true,
                ...(ordinary === undefined
                  ? {}
                  : { hasOrdinaryActiveRows: ordinary }),
              },
            },
          ],
          runtimeByChatId: {},
        }),
      );
      await writeFile(join(directory, 'metadata-journal.jsonl'), '');
    }
    const found = await scanInterruptedWork(
      [join(root, 'workspaces')],
      join(root, 'executions'),
    );
    expect(found.chatScopes.map((scope) => scope.worktreeId).sort()).toEqual([
      'legacy-tail',
      'ordinary-tail',
    ]);
    expect(found.errors).toEqual([]);
  });

  it('reports corrupt items and keeps discovering valid work', async () => {
    const executions = join(root, 'executions');
    await mkdir(executions);
    await writeFile(join(executions, 'bad.json'), '{');
    await writeFile(
      join(executions, 'active.json'),
      JSON.stringify({ status: 'running' }),
    );
    await writeFile(
      join(executions, 'queued.json'),
      JSON.stringify({ status: 'pending' }),
    );
    await writeFile(
      join(executions, 'finished.json'),
      JSON.stringify({ status: 'success' }),
    );
    const found = await scanInterruptedWork([], executions);
    expect(found.pipelineIds.sort()).toEqual(['active', 'queued']);
    expect(found.errors).toEqual([expect.stringContaining('bad.json')]);
  });

  it('discovers authoritative v2 runtimes and pending transactions without legacy files', async () => {
    const workspace = join(root, 'workspaces', 'workspace');
    const appWorkspace = join(root, 'app-workspaces', 'app-advisor');
    const seed = async (
      base: string,
      id: string,
      runtime: unknown,
      journal = '',
    ): Promise<void> => {
      const directory = join(base, 'chat-storage-v2', id);
      await mkdir(directory, { recursive: true });
      await mkdir(join(base, 'chat-storage-manifests'), { recursive: true });
      await writeFile(
        join(base, 'chat-storage-manifests', `${id}.json`),
        JSON.stringify({ version: 2, scopeId: id }),
      );
      await writeFile(
        join(directory, 'live-index.json'),
        JSON.stringify({
          version: 2,
          tabs: [{ id: 'chat' }],
          runtimeByChatId: { chat: runtime },
        }),
      );
      await writeFile(join(directory, 'metadata-journal.jsonl'), journal);
    };
    await seed(workspace, 'streaming', {
      status: 'streaming',
      queuedMessageIds: [],
    });
    await seed(workspace, 'queued', {
      status: 'idle',
      queuedMessageIds: ['pending'],
    });
    await seed(
      workspace,
      'transaction',
      { status: 'completed' },
      '{"pending":true}\n',
    );
    await seed(workspace, 'settled', {
      status: 'completed',
      queuedMessageIds: [],
    });
    await mkdir(join(workspace, 'chats'), { recursive: true });
    await writeFile(
      join(workspace, 'chats', 'settled.json'),
      JSON.stringify({ tabs: [{ claudeTerminal: { turnState: 'running' } }] }),
    );
    await seed(workspace, 'active-sidecar', { status: 'idle' });
    await writeFile(
      join(workspace, 'chat-storage-v2', 'active-sidecar', 'live-index.json'),
      JSON.stringify({
        version: 2,
        tabs: [{ id: 'chat', transcript: { hasActiveSidecar: true } }],
        runtimeByChatId: {},
      }),
    );
    await seed(workspace, 'terminal-v2', { status: 'idle' });
    await writeFile(
      join(workspace, 'chat-storage-v2', 'terminal-v2', 'live-index.json'),
      JSON.stringify({
        version: 2,
        tabs: [{ id: 'chat', claudeTerminal: { turnState: 'starting' } }],
        runtimeByChatId: {},
      }),
    );
    await seed(appWorkspace, 'advisor-entry', { status: 'awaiting_input' });
    // An unselected staging/orphan directory is not storage authority.
    await seed(workspace, 'orphan', { status: 'streaming' });
    await rm(join(workspace, 'chat-storage-manifests', 'orphan.json'));
    const found = await scanInterruptedWork(
      [join(root, 'workspaces'), join(root, 'app-workspaces')],
      join(root, 'executions'),
    );
    expect(found.chatScopes).toEqual(
      expect.arrayContaining([
        { projectId: 'workspace', worktreeId: 'streaming' },
        { projectId: 'workspace', worktreeId: 'queued' },
        { projectId: 'workspace', worktreeId: 'transaction' },
        { projectId: 'app-advisor', worktreeId: 'advisor-entry' },
        { projectId: 'workspace', worktreeId: 'active-sidecar' },
        { projectId: 'workspace', worktreeId: 'terminal-v2' },
      ]),
    );
    expect(found.chatScopes).toHaveLength(6);
    expect(found.errors).toEqual([]);
  });

  it('replays a delta journal whose records no checkpoint holds yet', async () => {
    const workspace = join(root, 'workspaces', 'workspace');
    const pathsFor = (
      worktreeId: string,
    ): {
      tabs: string;
      archives: string;
      journal: string;
    } => ({
      tabs: join(workspace, 'chats', `${worktreeId}.json`),
      archives: join(workspace, 'chat-archives', `${worktreeId}.json`),
      journal: join(workspace, 'chat-journals', `${worktreeId}.jsonl`),
    });
    for (const id of ['journaled', 'checkpointed'])
      await ChatStorageV2.fromLegacyPaths(pathsFor(id)).migrate(
        scopeSource([{ id: 'chat', messages: [] }]),
      );

    const repository = new ChatStateV2Repository({
      resolvePaths: (scope): ReturnType<typeof pathsFor> =>
        pathsFor(scope.worktreeId),
      deltaJournalIdleCheckpointMs: 60_000,
    });
    try {
      const streaming = {
        type: 'runtime.patched' as const,
        chatId: 'chat',
        runtime: { status: 'streaming' as const, queuedMessageIds: [] },
      };
      // The streaming runtime exists only in a journal record.
      await repository.transact(
        { projectId: 'workspace', worktreeId: 'journaled' },
        [streaming],
        { source: 'provider', mutationId: 'streaming' },
      );
      // A settled scope whose journal holds nothing after its checkpoint.
      await repository.transact(
        { projectId: 'workspace', worktreeId: 'checkpointed' },
        [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat',
            patch: { unread: true },
          },
        ],
        { source: 'provider', mutationId: 'unread' },
      );
      await repository.flushScope({
        projectId: 'workspace',
        worktreeId: 'checkpointed',
      });
      const found = await scanInterruptedWork(
        [join(root, 'workspaces')],
        join(root, 'executions'),
      );
      expect(found.chatScopes).toEqual([
        { projectId: 'workspace', worktreeId: 'journaled' },
      ]);
      expect(found.errors).toEqual([]);
    } finally {
      await repository.drainAll();
    }
  });
});
