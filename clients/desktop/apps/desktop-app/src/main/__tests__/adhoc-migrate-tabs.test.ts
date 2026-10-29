import { join, sep } from 'node:path';
import {
  initCodexModels,
  type ChatAdhocMigrateTabsRequest,
  type ChatTabsFile,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { forkCodexThreadByIdViaOneShot } from '../codex/fork-thread';
import { adhocMigrateWorktreeTabs } from '../lib/adhoc-migrate-tabs';

initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);

const SOURCE_ROOT = join(sep, 'worktrees', 'source');
const DEST_ROOT = join(sep, 'workspaces', 'adhoc', 'worktrees', 'combined');

function chatTab(
  id: string,
  providerType: 'claude' | 'codex' | 'opencode',
  overrides: Partial<PersistedChatTab> = {},
): PersistedChatTab {
  return {
    id,
    title: `Chat ${id}`,
    messages: [
      {
        id: `${id}-user`,
        role: 'user',
        blocks: [{ type: 'text', text: `hello from ${id}` }],
        timestamp: 1,
      },
    ],
    createdAt: '2026-08-01T00:00:00.000Z',
    providerType,
    ...overrides,
  };
}

function fileTab(id: string, filePath: string): PersistedChatTab {
  return {
    id,
    title: filePath,
    kind: 'file',
    filePath,
    description: filePath,
    fileViewMode: 'rich',
    messages: [],
    createdAt: '2026-08-01T00:00:00.000Z',
  };
}

function request(
  overrides: Partial<ChatAdhocMigrateTabsRequest> = {},
): ChatAdhocMigrateTabsRequest {
  return {
    sourceWorkspaceId: 'source-ws',
    sourceWorktreeId: 'source-wt',
    destinationWorkspaceId: 'dest-ws',
    destinationWorktreeId: 'dest-wt',
    filePathRewrites: [
      { fromRoot: SOURCE_ROOT, toRoot: join(DEST_ROOT, 'repos', 'moved') },
    ],
    selectedRepoIdRewrites: {},
    ...overrides,
  };
}

type ForkCodexThread = typeof forkCodexThreadByIdViaOneShot;

interface Harness {
  written: ChatTabsFile | undefined;
  copyTabs: jest.Mock<
    Promise<void>,
    [
      ChatAdhocMigrateTabsRequest,
      ChatTabsFile,
      Readonly<Record<string, string>>,
    ]
  >;
  forkCodexThread: jest.Mock<Promise<string>, [Parameters<ForkCodexThread>[0]]>;
  run: (
    req: ChatAdhocMigrateTabsRequest,
  ) => ReturnType<typeof adhocMigrateWorktreeTabs>;
}

function harness(
  source: ChatTabsFile,
  destination: ChatTabsFile = { version: 1, tabs: [], activeTabId: '' },
): Harness {
  let nextId = 0;
  const forkCodexThread: Harness['forkCodexThread'] = jest.fn(() =>
    Promise.resolve('forked-codex-thread'),
  );
  const state: Harness = {
    written: undefined,
    copyTabs: jest.fn<Promise<void>, Parameters<Harness['copyTabs']>>(
      (_request, data) => {
        state.written = {
          ...data,
          tabs: [...(state.written ?? destination).tabs, ...data.tabs],
        };
        return Promise.resolve();
      },
    ),
    forkCodexThread,
    run: (req) =>
      adhocMigrateWorktreeTabs(req, {
        readTabs: (_projectId, worktreeId) =>
          Promise.resolve(
            worktreeId === 'source-wt'
              ? source
              : (state.written ?? destination),
          ),
        updateTabs: (_projectId, _worktreeId, update) => {
          state.written = update(state.written ?? destination);
          return Promise.resolve(state.written);
        },
        copyTabs: (req, data, sourceChatIds) =>
          state.copyTabs(req, data, sourceChatIds),
        resolveCwd: (_projectId, _worktreeId, repoId) =>
          repoId ? join(DEST_ROOT, 'repos', repoId) : DEST_ROOT,
        forkCodexThread,
        nextId: () => `migrated-${String(++nextId)}`,
        now: () => new Date('2026-08-02T00:00:00.000Z'),
      }),
  };
  return state;
}

describe('adhocMigrateWorktreeTabs', () => {
  it.each(['inline', 'canonical'])(
    'starts a migrated OpenCode fork without its source plan approval using %s storage',
    async (storage) => {
      const sourceTab = chatTab('opencode-chat', 'opencode', {
        model: 'opencode:fixture%2Fmodel',
        sdkSessionId: 'source-session',
        planMode: true,
        proposalMode: 'required',
        pendingPlanExit: { source: 'opencode', plan: 'Source proposal' },
        pendingPlanExitRequestId: 'source-request',
        trackedPlanId: 'source-plan',
        trackedPlanSource: 'opencode',
        trackedPlanReviewStatus: 'pending',
        hasOutstandingProposal: true,
        latestRevisionNumber: 3,
        ...(storage === 'canonical'
          ? {
              messages: [],
              transcript: {
                format: 'complete-message-jsonl-v1',
                committedMessageCount: 1,
                committedByteLength: 100,
                transcriptRevision: 1,
                hasActiveSidecar: false,
                lastMessageId: 'opencode-chat-user',
              },
            }
          : {}),
      });
      const source: ChatTabsFile = {
        version: 1,
        tabs: [sourceTab],
        activeTabId: sourceTab.id,
      };
      const original = structuredClone(source);
      const h = harness(source);

      await expect(h.run(request())).resolves.toEqual({
        migratedTabIds: ['migrated-1'],
      });

      const migrated = h.written?.tabs[0];
      expect(migrated).toMatchObject({
        id: 'migrated-1',
        providerType: 'opencode',
        model: sourceTab.model,
        planMode: true,
        proposalMode: 'required',
        messages: sourceTab.messages,
        forkedFrom: {
          projectId: 'source-ws',
          worktreeId: 'source-wt',
          chatId: sourceTab.id,
          atMessageId: 'opencode-chat-user',
          modelContext: 'visible-transcript',
        },
      });
      expect(migrated?.sdkSessionId).toBeUndefined();
      expect(source).toEqual(original);
      if (storage === 'canonical') {
        expect(h.copyTabs).toHaveBeenCalledWith(
          request(),
          expect.objectContaining({ tabs: [migrated] }),
          { 'migrated-1': sourceTab.id },
        );
      } else {
        expect(h.copyTabs).not.toHaveBeenCalled();
      }
      for (const field of [
        'pendingPlanExit',
        'pendingPlanExitRequestId',
        'trackedPlanId',
        'trackedPlanSource',
        'trackedPlanReviewStatus',
        'hasOutstandingProposal',
        'latestRevisionNumber',
      ]) {
        expect(migrated).not.toHaveProperty(field);
      }
    },
  );

  it('preserves chat content and configuration, remaps repos, and records migration identity', async () => {
    const source: ChatTabsFile = {
      version: 1,
      tabs: [
        chatTab('claude-chat', 'claude', {
          sdkSessionId: 'claude-session',
          selectedRepoId: 'old-repo',
          planMode: true,
          pendingPlanExit: { plan: 'Claude proposal' },
          trackedPlanId: 'claude-plan',
          trackedPlanSource: 'claude',
          trackedPlanReviewStatus: 'pending',
          hasOutstandingProposal: true,
          latestRevisionNumber: 2,
          thinkingLevel: 'high',
          pluginSelections: { skills: ['skill-a'] },
          agentArtifactCarryByTurn: {
            'claude-chat-user': [
              {
                version: 1,
                kind: 'pipeline_run',
                operation: 'pipeline.run',
                dedupeKey: 'canopy:pipeline_run:worktree:execution-1',
                createdAt: '2026-08-04T20:00:00.000Z',
                executionId: 'execution-1',
                pipelineId: 'pipeline-1',
                pipelineName: 'Build',
                initialStatus: 'pending',
                queuedAt: '2026-08-04T20:00:00.000Z',
                projectId: 'source-ws',
                worktreeId: 'source-wt',
                navigationTarget: {
                  kind: 'pipeline_execution',
                  executionId: 'execution-1',
                  projectId: 'source-ws',
                  worktreeId: 'source-wt',
                },
              },
            ],
          },
          unread: true,
          scheduledSendDraft: { runAt: '2026-08-03T00:00:00.000Z' },
        }),
      ],
      activeTabId: 'claude-chat',
    };
    const h = harness(source);

    const result = await h.run(
      request({ selectedRepoIdRewrites: { 'old-repo': 'new-repo' } }),
    );

    expect(result.migratedTabIds).toEqual(['migrated-1']);
    const migrated = h.written?.tabs.find((tab) => tab.id === 'migrated-1');
    expect(migrated).toMatchObject({
      title: 'Chat claude-chat',
      providerType: 'claude',
      planMode: true,
      pendingPlanExit: { plan: 'Claude proposal' },
      trackedPlanId: 'claude-plan',
      trackedPlanSource: 'claude',
      trackedPlanReviewStatus: 'pending',
      hasOutstandingProposal: true,
      latestRevisionNumber: 2,
      thinkingLevel: 'high',
      selectedRepoId: 'new-repo',
      sdkSessionId: 'claude-session',
      claudeForkSessionOnNextSend: true,
      forkedFrom: {
        projectId: 'source-ws',
        worktreeId: 'source-wt',
        chatId: 'claude-chat',
        atMessageId: 'claude-chat-user',
        resumePointRequired: true,
      },
      adhocMigrationSource: {
        projectId: 'source-ws',
        worktreeId: 'source-wt',
        tabId: 'claude-chat',
      },
    });
    expect(migrated?.messages.map(({ id }) => id)).toEqual([
      'claude-chat-user',
    ]);
    expect(migrated?.pluginSelections).toEqual({ skills: ['skill-a'] });
    expect(migrated?.agentArtifactCarryByTurn).toEqual({
      'claude-chat-user': [
        {
          version: 1,
          kind: 'pipeline_run',
          operation: 'pipeline.run',
          dedupeKey: 'canopy:pipeline_run:worktree:execution-1',
          createdAt: '2026-08-04T20:00:00.000Z',
          executionId: 'execution-1',
          pipelineId: 'pipeline-1',
          pipelineName: 'Build',
          initialStatus: 'pending',
          queuedAt: '2026-08-04T20:00:00.000Z',
          projectId: 'source-ws',
          worktreeId: 'source-wt',
          navigationTarget: {
            kind: 'pipeline_execution',
            executionId: 'execution-1',
            projectId: 'source-ws',
            worktreeId: 'source-wt',
          },
        },
      ],
    });
    // Delivery/attention lifecycle does not migrate.
    expect(migrated?.unread).toBeUndefined();
    expect(migrated?.scheduledSendDraft).toBeUndefined();
    expect(h.written?.activeTabId).toBe('migrated-1');
  });

  it('maps root-scoped single-repo chats through sourceRootRepoIdRewrite', async () => {
    const source: ChatTabsFile = {
      version: 1,
      tabs: [chatTab('root-chat', 'claude')],
      activeTabId: 'root-chat',
    };
    const h = harness(source);

    await h.run(request({ sourceRootRepoIdRewrite: 'moved-repo' }));

    expect(h.written?.tabs[0]?.selectedRepoId).toBe('moved-repo');
  });

  it('rewrites file-tab paths, drops unmapped files, and relabels titles', async () => {
    const source: ChatTabsFile = {
      version: 1,
      tabs: [
        fileTab('inside-file', join(SOURCE_ROOT, 'src', 'index.ts')),
        fileTab('outside-file', join(sep, 'tmp', 'notes.md')),
      ],
      activeTabId: 'inside-file',
    };
    const h = harness(source);

    const result = await h.run(request());

    expect(result.migratedTabIds).toEqual(['migrated-1']);
    const migrated = h.written?.tabs.find((tab) => tab.kind === 'file');
    expect(migrated?.filePath).toBe(
      join(DEST_ROOT, 'repos', 'moved', 'src', 'index.ts'),
    );
    expect(migrated?.description).toBe(migrated?.filePath);
    // Relabelled to the shortest unique suffix among destination file tabs.
    expect(migrated?.title).toBe('index.ts');
    expect(
      h.written?.tabs.some((tab) => tab.filePath?.endsWith('notes.md')),
    ).toBe(false);
  });

  it('forks Codex threads into the destination and degrades to a fresh session on failure', async () => {
    const source: ChatTabsFile = {
      version: 1,
      tabs: [
        chatTab('codex-ok', 'codex', {
          sdkSessionId: 'thread-ok',
          selectedRepoId: 'old-repo',
        }),
        chatTab('codex-broken', 'codex', { sdkSessionId: 'thread-broken' }),
      ],
      activeTabId: 'codex-ok',
    };
    const h = harness(source);
    h.forkCodexThread.mockImplementation((opts) =>
      opts.sourceThreadId === 'thread-ok'
        ? Promise.resolve('forked-ok')
        : Promise.reject(new Error('fork failed')),
    );

    await h.run(
      request({ selectedRepoIdRewrites: { 'old-repo': 'new-repo' } }),
    );

    expect(h.forkCodexThread).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'dest-ws',
        worktreeId: 'dest-wt',
        chatId: 'migrated-1',
        sourceThreadId: 'thread-ok',
        sourceProjectId: 'source-ws',
        sourceWorktreeId: 'source-wt',
        sourceChatId: 'codex-ok',
        cwd: join(DEST_ROOT, 'repos', 'new-repo'),
      }),
    );
    const ok = h.written?.tabs.find(
      (tab) => tab.adhocMigrationSource?.tabId === 'codex-ok',
    );
    const broken = h.written?.tabs.find(
      (tab) => tab.adhocMigrationSource?.tabId === 'codex-broken',
    );
    expect(ok?.sdkSessionId).toBe('forked-ok');
    // The transcript still transfers; the next turn starts a fresh thread.
    expect(broken?.sdkSessionId).toBeUndefined();
    expect(broken?.messages).toHaveLength(1);
  });

  it('keeps each migrated chat exact Codex speed and retained speed', async () => {
    const source: ChatTabsFile = {
      version: 1,
      tabs: [
        chatTab('codex-ultra', 'codex', {
          sdkSessionId: 'thread-ultra',
          modelConfig: {
            thinkingLevel: 'high',
            speed: 'ultrafast',
            fastMode: false,
          },
        }),
        chatTab('codex-legacy-fast', 'codex', { codexFastModeEnabled: true }),
        chatTab('codex-inherited', 'codex'),
        chatTab('claude-retained', 'claude', {
          modelConfig: {
            thinkingLevel: 'high',
            speed: 'standard',
            fastMode: false,
          },
          retainedCodexSpeed: 'ultrafast',
        }),
      ],
      activeTabId: 'codex-ultra',
    };
    const h = harness(source);

    await h.run(request());

    const migrated = (sourceId: string): PersistedChatTab | undefined =>
      h.written?.tabs.find(
        (tab) => tab.adhocMigrationSource?.tabId === sourceId,
      );
    expect(migrated('codex-ultra')?.modelConfig).toEqual({
      thinkingLevel: 'high',
      speed: 'ultrafast',
      fastMode: false,
    });
    expect(migrated('codex-ultra')?.codexFastModeEnabled).toBe(false);
    expect(h.forkCodexThread).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceThreadId: 'thread-ultra',
        modelConfig: {
          thinkingLevel: 'high',
          speed: 'ultrafast',
          fastMode: false,
        },
      }),
    );
    // The deprecated alias migrates as the exact speed it requested.
    expect(migrated('codex-legacy-fast')).toMatchObject({
      modelConfig: { speed: 'fast', fastMode: true },
      codexFastModeEnabled: true,
    });
    // A chat that inherited the provider default keeps inheriting it instead
    // of gaining an explicit Regular choice.
    expect(migrated('codex-inherited')?.modelConfig).toBeUndefined();
    expect(migrated('codex-inherited')?.codexFastModeEnabled).toBeUndefined();
    expect(migrated('claude-retained')).toMatchObject({
      providerType: 'claude',
      modelConfig: {
        thinkingLevel: 'high',
        speed: 'standard',
        fastMode: false,
      },
      retainedCodexSpeed: 'ultrafast',
    });
  });

  it('merges into an existing destination without clobbering it and keeps its active tab', async () => {
    const destinationTab = chatTab('existing-dest', 'claude');
    const source: ChatTabsFile = {
      version: 1,
      tabs: [chatTab('incoming', 'claude')],
      activeTabId: 'incoming',
    };
    const h = harness(source, {
      version: 1,
      tabs: [destinationTab],
      activeTabId: 'existing-dest',
      lastActiveEditableChatId: 'existing-dest',
    });

    await h.run(request());

    expect(h.written?.tabs.map(({ id }) => id)).toEqual([
      'existing-dest',
      'migrated-1',
    ]);
    expect(h.written?.activeTabId).toBe('existing-dest');
    expect(h.written?.lastActiveEditableChatId).toBe('existing-dest');
  });

  it('is idempotent when the same source tabs are migrated again', async () => {
    const source: ChatTabsFile = {
      version: 1,
      tabs: [
        chatTab('retry-chat', 'claude'),
        fileTab('retry-file', join(SOURCE_ROOT, 'src', 'index.ts')),
      ],
      activeTabId: 'retry-chat',
    };
    const h = harness(source);

    const first = await h.run(request());
    expect(first.migratedTabIds).toHaveLength(2);

    // The retry reads the destination this test already wrote.
    const second = await h.run(request());
    expect(second.migratedTabIds).toEqual([]);
    expect(h.written?.tabs).toHaveLength(2);
  });

  it('migrates nothing when the source has no tabs', async () => {
    const h = harness({ version: 1, tabs: [], activeTabId: '' });

    const result = await h.run(request());

    expect(result.migratedTabIds).toEqual([]);
    expect(h.written).toBeUndefined();
  });

  it('merges against destination changes committed while a Codex fork is pending', async () => {
    let resolveFork!: (value: string) => void;
    const fork = new Promise<string>((resolve) => {
      resolveFork = resolve;
    });
    let destination: ChatTabsFile = {
      version: 1,
      tabs: [chatTab('existing', 'claude')],
      activeTabId: 'existing',
    };
    const run = adhocMigrateWorktreeTabs(request(), {
      readTabs: (_projectId, worktreeId) =>
        Promise.resolve(
          worktreeId === 'source-wt'
            ? {
                version: 1,
                tabs: [
                  chatTab('source-codex', 'codex', {
                    sdkSessionId: 'codex-thread',
                  }),
                ],
                activeTabId: 'source-codex',
              }
            : destination,
        ),
      updateTabs: (_projectId, _worktreeId, update) => {
        destination = update(destination);
        return Promise.resolve(destination);
      },
      resolveCwd: () => DEST_ROOT,
      forkCodexThread: jest.fn(() => fork),
      nextId: () => 'migrated-codex',
      now: () => new Date('2026-08-02T00:00:00.000Z'),
    });

    await Promise.resolve();
    destination = {
      ...destination,
      tabs: [...destination.tabs, chatTab('concurrent', 'claude')],
    };
    resolveFork('forked-thread');
    await run;

    expect(destination.tabs.map(({ id }) => id)).toEqual([
      'existing',
      'concurrent',
      'migrated-codex',
    ]);
  });
});
