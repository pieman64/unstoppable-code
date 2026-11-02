import { createCoreChatStateAdapter } from '../canopy-runtime/core-chat-state-adapter';
import { createCoreChatReadAdapter } from '../canopy-runtime/core-chat-read-adapter';
import type { ChatStateCommandPort } from '@canopy/desktop-shared/types';
import type { CanopyHandlerContext } from '@canopy/core-runtime';
jest.mock('../ipc/chat-state', () => ({ getChatStateCommandPort: jest.fn() }));
import {
  parseProjectDiscoveryAction,
  type ProjectsListTaskChatsAction,
  type ProjectsListTasksAction,
} from '@canopy/desktop-shared/lib/project-discovery';
import type {
  ChatQueueUpdatedEvent,
  ChatRuntimeState,
  ChatStateSnapshot,
  ClaudeTerminalTurnState,
  CoworkWorkEntriesFile,
  CoworkWorkEntryData,
  PersistedChatTab,
  ProjectOwnerContext,
  SidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { COWORK_HOME_WORKTREE_ID } from '@canopy/desktop-shared/types';
import { DiscoveryError } from '../project-discovery/errors';
import {
  requireAuthorizedProject,
  type AuthorizedProject,
} from '../project-discovery/owner-policy';
import { listChatRows } from '../project-discovery/chats-list';
import { resolveAuthorizedChat } from '../project-discovery/chat-target';
import { listTaskRows } from '../project-discovery/tasks-list';
import { readWorkEntriesFileStrict } from '../lib/cowork-work-entries';
import type { LegacyReadAuthority } from '../project-discovery/sources';
import {
  runtimeStateFromEvidence,
  projectRuntimeEvidence,
  hasRunningChats,
} from '../project-discovery/runtime-state';
import type { ProjectDiscoveryCaller } from '../project-discovery';

jest.mock('../project-discovery/owner-policy');
jest.mock(
  '../canopy-runtime/desktop-runtime',
  (): { getActiveDesktopRuntime: () => RuntimeDispatcherMock } => ({
    getActiveDesktopRuntime: (): RuntimeDispatcherMock => mockRuntime,
  }),
);
jest.mock('../lib/cowork-work-entries');
const mockTerminalTurnStates = new Map<string, ClaudeTerminalTurnState>();
jest.mock('../lib/terminal-driven-chat', () => ({
  claudeTerminalTurnStates: (): Promise<
    (chat: {
      projectId: string;
      worktreeId: string;
      chatId: string;
    }) => ClaudeTerminalTurnState | undefined
  > =>
    Promise.resolve((chat) =>
      mockTerminalTurnStates.get(
        `${chat.projectId}/${chat.worktreeId}/${chat.chatId}`,
      ),
    ),
}));
jest.mock(
  '../lib/cowork-migration-map',
  (): { resolveCoworkWorkspaceId: (projectId: string) => string } => ({
    resolveCoworkWorkspaceId: (projectId: string): string => projectId,
  }),
);

const caller = {
  kind: 'app_advisor',
  chatId: 'advisor-chat',
} satisfies ProjectDiscoveryCaller;

const personalOwner = { kind: 'personal' } satisfies ProjectOwnerContext;

const codeItem = {
  type: 'single-repo',
  id: 'code-project',
  name: 'Code Project',
  repoPath: '/not-used-by-discovery',
  color: 'blue',
  worktrees: [],
  collapsed: false,
  order: 0,
} satisfies SidebarItem;

const coworkItem = {
  type: 'cowork',
  id: 'cowork-project',
  name: 'Cowork Project',
  color: 'purple',
  collapsed: false,
  order: 0,
} satisfies SidebarItem;

function authorizedProject(
  item: SidebarItem,
  projectId: string,
  name: string,
): AuthorizedProject {
  return {
    item,
    type: item.type === 'cowork' ? 'cowork' : 'code',
    purpose: 'project',
    owner: personalOwner,
    readiness: 'ready',
    projectId,
    name,
    displayName: name,
    incarnation: `incarnation:${projectId}`,
    isDefault: false,
    synthetic: false,
    inventoryAuthority: 'ok',
    inventoryOwnerMalformed: false,
  };
}

function taskAction(
  fields: Omit<Partial<ProjectsListTasksAction>, 'type'> = {},
): ProjectsListTasksAction {
  const parsed = parseProjectDiscoveryAction({
    type: 'projects.list_tasks',
    projectId: 'code-project',
    ...fields,
  });
  if (!parsed.ok || parsed.action.type !== 'projects.list_tasks')
    throw new Error('Test action is invalid');
  return parsed.action;
}

function chatAction(
  fields: Omit<Partial<ProjectsListTaskChatsAction>, 'type'> = {},
): ProjectsListTaskChatsAction {
  const parsed = parseProjectDiscoveryAction({
    type: 'projects.list_task_chats',
    projectId: 'code-project',
    ...fields,
  });
  if (!parsed.ok || parsed.action.type !== 'projects.list_task_chats')
    throw new Error('Test action is invalid');
  return parsed.action;
}

function worktree(
  id: string,
  overrides: Partial<WorktreeData> = {},
): WorktreeData {
  return {
    id,
    branchName: `branch/${id}`,
    createdAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

function workEntry(
  id: string,
  overrides: Partial<CoworkWorkEntryData> = {},
): CoworkWorkEntryData {
  return {
    id,
    createdAt: '2026-10-03T00:00:00.000Z',
    ...overrides,
  };
}

function chatTab(
  id: string,
  overrides: Partial<PersistedChatTab> = {},
): PersistedChatTab {
  return {
    id,
    title: `Chat ${id}`,
    createdAt: '2026-10-04T00:00:00.000Z',
    messages: [],
    ...overrides,
  };
}

function chatSnapshot(
  projectId: string,
  worktreeId: string,
  tabs: PersistedChatTab[] = [],
  runtimeByChatId: Record<string, ChatRuntimeState> = {},
  queue: ChatQueueUpdatedEvent[] = [],
): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId,
    worktreeId,
    revision: 1,
    tabsFile: {
      version: 1,
      tabs,
      activeTabId: tabs[0]?.id ?? '',
    },
    archives: [],
    runtimeByChatId,
    queue,
  };
}

const mockedRequireAuthorizedProject = jest.mocked(requireAuthorizedProject);
const mockedReadWorkEntriesFileStrict = jest.mocked(readWorkEntriesFileStrict);

type WorktreeRequest = { scope: { workspaceId: string } };
type ChatSnapshotRequest = {
  scope: { workspaceId: string; worktreeId: string };
};
type LegacyAuthorityResponse<T> = {
  legacyAuthority?: {
    authority: LegacyReadAuthority;
    ownerMalformed?: boolean;
  };
  legacyResult: T;
};
type RuntimeDispatcherMock = {
  queryWorktreeListForLegacyIpc: jest.Mock<
    Promise<LegacyAuthorityResponse<WorktreeData[]>>,
    [WorktreeRequest, unknown]
  >;
  queryChatStateForLegacyIpc: jest.Mock<
    Promise<{ legacyResult: ChatStateSnapshot }>,
    [ChatSnapshotRequest, unknown]
  >;
};

let mockRuntime: RuntimeDispatcherMock;

function createMockRuntime(): RuntimeDispatcherMock {
  return {
    queryWorktreeListForLegacyIpc: jest.fn<
      Promise<LegacyAuthorityResponse<WorktreeData[]>>,
      [WorktreeRequest, unknown]
    >(),
    queryChatStateForLegacyIpc: jest.fn<
      Promise<{ legacyResult: ChatStateSnapshot }>,
      [ChatSnapshotRequest, unknown]
    >(),
  };
}

function mockWorktrees(
  rows: WorktreeData[],
  authority: LegacyReadAuthority = 'ok',
): void {
  mockRuntime.queryWorktreeListForLegacyIpc.mockResolvedValue({
    legacyAuthority: { authority },
    legacyResult: rows,
  });
}

function mockEntries(entries: CoworkWorkEntryData[]): void {
  const file: CoworkWorkEntriesFile = { version: 1, entries };
  mockedReadWorkEntriesFileStrict.mockResolvedValue(file);
}

function dispatcherOptionsHaveGrant(options: unknown, grant: string): boolean {
  if (typeof options !== 'object' || options === null || !('caller' in options))
    return false;
  const callerOptions = options.caller;
  if (
    typeof callerOptions !== 'object' ||
    callerOptions === null ||
    !('grants' in callerOptions) ||
    !Array.isArray(callerOptions.grants)
  )
    return false;
  return callerOptions.grants.some((candidate: unknown) => candidate === grant);
}

function mockSnapshots(
  snapshotFor: (scope: ChatSnapshotRequest['scope']) => ChatStateSnapshot,
): void {
  mockRuntime.queryChatStateForLegacyIpc.mockImplementation((request) =>
    Promise.resolve({ legacyResult: snapshotFor(request.scope) }),
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  mockTerminalTurnStates.clear();
  mockRuntime = createMockRuntime();
  mockedRequireAuthorizedProject.mockResolvedValue(
    authorizedProject(codeItem, 'code-project', 'Code Project'),
  );
  mockWorktrees([]);
  mockEntries([]);
  mockSnapshots(({ workspaceId, worktreeId }) =>
    chatSnapshot(workspaceId, worktreeId),
  );
});

describe('project discovery runtime evidence', () => {
  it('does not treat the synthesized bare idle state as measured idle', () => {
    expect(
      runtimeStateFromEvidence({ status: 'idle', queuedMessageIds: [] }),
    ).toBe('unknown');
    expect(runtimeStateFromEvidence(undefined)).toBe('unknown');
  });

  it('recognizes queued-only evidence from the snapshot queue even with a synthetic idle runtime', () => {
    const snapshot = chatSnapshot(
      'code-project',
      'task-1',
      [chatTab('chat')],
      { chat: { status: 'idle', queuedMessageIds: [] } },
      [
        {
          projectId: 'code-project',
          worktreeId: 'task-1',
          chatId: 'chat',
          queue: [
            {
              id: 'q',
              text: 'not inspected',
              origin: 'desktop',
              enqueuedAtMs: 1,
            },
          ],
        },
      ],
    );
    expect(projectRuntimeEvidence(snapshot, 'chat')).toMatchObject({
      runtimeState: 'queued',
      queuedMessageCount: 1,
    });
    expect(hasRunningChats(snapshot, ['chat'])).toBe(false);
    snapshot.runtimeByChatId.chat = {
      status: 'streaming',
      queuedMessageIds: [],
    };
    expect(projectRuntimeEvidence(snapshot, 'chat').runtimeState).toBe(
      'running',
    );
  });
  it('uses explicit runtime evidence and keeps queued separate from running', () => {
    expect(
      runtimeStateFromEvidence({
        status: 'idle',
        queuedMessageIds: [],
        lastActivityAt: 0,
      }),
    ).toBe('idle');
    expect(
      runtimeStateFromEvidence({ status: 'queued', queuedMessageIds: ['q1'] }),
    ).toBe('queued');
    expect(
      runtimeStateFromEvidence({ status: 'streaming', queuedMessageIds: [] }),
    ).toBe('running');
    expect(
      runtimeStateFromEvidence({
        status: 'interrupted',
        queuedMessageIds: [],
      }),
    ).toBe('interrupted');
    expect(
      runtimeStateFromEvidence({ status: 'failed', queuedMessageIds: [] }),
    ).toBe('error');
    expect(
      runtimeStateFromEvidence({
        status: 'awaiting_input',
        queuedMessageIds: [],
      }),
    ).toBe('unknown');
    expect(
      runtimeStateFromEvidence({ status: 'cancelled', queuedMessageIds: [] }),
    ).toBe('unknown');
    expect(
      runtimeStateFromEvidence({
        status: 'cancelled',
        queuedMessageIds: [],
        error: {
          code: 'interrupted',
          message: 'interrupted',
          retryable: false,
          occurredAt: '2026-10-10T00:00:00.000Z',
        },
      }),
    ).toBe('interrupted');
  });
});

describe('project task listing', () => {
  it('projects persistent code statuses, ignores file tabs, and never calls a task snapshot twice', async () => {
    const worktrees = [
      worktree('active-task', {
        status: 'active',
        lastTouchedAt: '2026-10-08',
      }),
      worktree('done-task', { status: 'done' }),
    ];
    mockWorktrees(worktrees);
    mockSnapshots(({ workspaceId, worktreeId }) =>
      chatSnapshot(
        workspaceId,
        worktreeId,
        [chatTab('queued-chat'), chatTab('file-tab', { kind: 'file' })],
        {
          'queued-chat': { status: 'queued', queuedMessageIds: ['queued-1'] },
        },
      ),
    );

    const result = await listTaskRows(taskAction(), caller);

    expect(result.projectType).toBe('code');
    expect(result.items.map((row) => [row.taskId, row.status])).toEqual([
      ['active-task', 'active'],
      ['done-task', 'done'],
    ]);
    expect(result.items[0]?.chatCount).toBe(1);
    expect(result.items[0]?.hasRunningChats).toBe(false);
    expect(mockRuntime.queryChatStateForLegacyIpc).toHaveBeenCalledTimes(2);
    expect(
      mockRuntime.queryChatStateForLegacyIpc.mock.calls.map(
        ([request]) => request.scope.worktreeId,
      ),
    ).toEqual(['active-task', 'done-task']);
  });

  it('projects a chat whose managed terminal turn is running as running', async () => {
    mockWorktrees([worktree('task-1')]);
    mockSnapshots(({ workspaceId, worktreeId }) =>
      chatSnapshot(workspaceId, worktreeId, [chatTab('terminal-chat')], {
        // A terminal turn never reports to the host runtime record.
        'terminal-chat': {
          status: 'completed',
          queuedMessageIds: [],
          lastActivityAt: 1,
        },
      }),
    );
    expect((await listTaskRows(taskAction(), caller)).items[0]).toMatchObject({
      hasRunningChats: false,
    });

    mockTerminalTurnStates.set('code-project/task-1/terminal-chat', 'running');

    expect((await listTaskRows(taskAction(), caller)).items[0]).toMatchObject({
      hasRunningChats: true,
    });
    expect(await listChatRows(chatAction(), caller)).toMatchObject([
      { chatId: 'terminal-chat', runtimeState: 'running' },
    ]);
  });

  it('keeps unknown runtime evidence nullable and applies persistent status/name/query filters', async () => {
    mockWorktrees([
      worktree('task-1', { label: 'Feature One' }),
      worktree('task-2', { status: 'done', label: 'Feature Two' }),
    ]);
    mockSnapshots(({ workspaceId, worktreeId }) =>
      chatSnapshot(
        workspaceId,
        worktreeId,
        worktreeId === 'task-1' ? [chatTab('chat-without-runtime')] : [],
      ),
    );

    const result = await listTaskRows(
      taskAction({
        statuses: ['active'],
        name: 'feature one',
        query: 'branch/task-1',
      }),
      caller,
    );

    expect(result.items.map((row) => row.taskId)).toEqual(['task-1']);
    expect(result.items[0]?.hasRunningChats).toBeNull();
  });

  it('excludes hidden and internal sentinel worktrees before snapshots and counts', async () => {
    mockWorktrees([
      worktree('visible-task'),
      worktree('hidden-task', { hidden: true }),
      worktree(COWORK_HOME_WORKTREE_ID),
    ]);

    const result = await listTaskRows(taskAction(), caller);

    expect(result.items.map((row) => row.taskId)).toEqual(['visible-task']);
    expect(mockRuntime.queryChatStateForLegacyIpc).toHaveBeenCalledTimes(1);
    expect(
      mockRuntime.queryChatStateForLegacyIpc.mock.calls[0]?.[0].scope,
    ).toEqual({ workspaceId: 'code-project', worktreeId: 'visible-task' });
  });

  it('projects cowork entries without inferring shared-run authorization', async () => {
    mockedRequireAuthorizedProject.mockResolvedValue(
      authorizedProject(coworkItem, 'cowork-project', 'Cowork Project'),
    );
    mockEntries([
      workEntry(COWORK_HOME_WORKTREE_ID),
      workEntry('entry-1', {
        pinned: true,
        title: 'Pinned title',
        status: 'done',
        summary: {
          version: 1,
          title: 'Derived title',
          chatCount: 2,
          lastMessageAt: '2026-10-10T12:00:00.000Z',
          sharedRun: {
            externalId: 'run-1',
            shareScope: 'organization',
            sharedAt: '2026-10-10T12:00:00.000Z',
            commentRevision: 1,
            unreadCommentCount: 0,
          },
          chats: [],
        },
      }),
    ]);
    mockSnapshots(({ workspaceId, worktreeId }) =>
      chatSnapshot(workspaceId, worktreeId),
    );

    const result = await listTaskRows(
      taskAction({ projectId: 'cowork-project', pinned: true }),
      caller,
    );

    expect(result.projectType).toBe('cowork');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      taskId: 'entry-1',
      title: 'Pinned title',
      status: 'done',
      chatCount: 0,
      details: {
        kind: 'work_entry',
        pinned: true,
        titleOverride: 'Pinned title',
      },
    });
    expect(result.items[0]?.details.kind).toBe('work_entry');
    if (result.items[0]?.details.kind === 'work_entry')
      expect(result.items[0].details.sharedRun).toBeUndefined();
    expect(mockedReadWorkEntriesFileStrict).toHaveBeenCalledWith(
      'cowork-project',
    );
    expect(mockRuntime.queryChatStateForLegacyIpc).toHaveBeenCalledTimes(1);
  });

  it('rejects archived retention and type-incompatible filters as typed errors', async () => {
    await expect(
      listTaskRows(taskAction({ retentionStates: ['archived'] }), caller),
    ).rejects.toMatchObject({ code: 'unsupported_filter' });
    await expect(
      listTaskRows(taskAction({ pinned: true }), caller),
    ).rejects.toMatchObject({
      code: 'invalid_payload',
    });

    mockedRequireAuthorizedProject.mockResolvedValue(
      authorizedProject(coworkItem, 'cowork-project', 'Cowork Project'),
    );
    await expect(
      listTaskRows(
        taskAction({ projectId: 'cowork-project', branchName: 'main' }),
        caller,
      ),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('propagates unreliable source authority instead of silently returning an empty list', async () => {
    mockWorktrees([], 'partial');

    await expect(listTaskRows(taskAction(), caller)).rejects.toMatchObject({
      code: 'execution_failed',
      message: 'Project worktrees could not be read.',
    });
  });

  it('does not read a project list for a rejected project authorization', async () => {
    const failure = new DiscoveryError('not_found', 'Project was not found.');
    mockedRequireAuthorizedProject.mockRejectedValue(failure);

    await expect(listTaskRows(taskAction(), caller)).rejects.toBe(failure);
    expect(mockRuntime.queryWorktreeListForLegacyIpc).not.toHaveBeenCalled();
    expect(mockedReadWorkEntriesFileStrict).not.toHaveBeenCalled();
    expect(mockRuntime.queryChatStateForLegacyIpc).not.toHaveBeenCalled();
  });

  it('treats only an explicitly absent worktree registry as a reliable empty list', async () => {
    mockRuntime.queryWorktreeListForLegacyIpc.mockResolvedValue({
      legacyAuthority: { authority: 'absent' },
      legacyResult: [],
    });

    const rows = await listTaskRows(taskAction(), caller);

    expect(rows.items).toEqual([]);
    expect(
      dispatcherOptionsHaveGrant(
        mockRuntime.queryWorktreeListForLegacyIpc.mock.calls[0]?.[1],
        'core.worktree.read',
      ),
    ).toBe(true);
  });
});

describe('project task chat listing', () => {
  it.each([
    ['description', 'DESCRIPTION-NEEDLE', ['metadata-chat']],
    ['providerType', 'CLAUDE', ['metadata-chat']],
    ['model', 'MODEL-NEEDLE', ['metadata-chat']],
    ['executionHarness', 'CODEX', ['metadata-chat']],
    ['non-match', 'only-message-text', []],
  ])(
    'query searches %s metadata without reading message text',
    async (_field, query, expected) => {
      mockWorktrees([worktree('task-1')]);
      const tab = chatTab('metadata-chat', {
        title: 'Neutral title',
        description: 'description-needle',
        providerType: 'claude',
        model: 'model-needle',
        executionHarness: 'codex',
      });
      const readMessages = jest.fn(() => {
        throw new Error('Message text must not be read');
      });
      Object.defineProperty(tab, 'messages', { get: readMessages });
      mockSnapshots(({ workspaceId, worktreeId }) =>
        chatSnapshot(workspaceId, worktreeId, [tab]),
      );
      const rows = await listChatRows(chatAction({ query }), caller);
      expect(rows.map((row) => row.chatId)).toEqual(expected);
      expect(readMessages).not.toHaveBeenCalled();
    },
  );
  it('keeps Work Entry and chat IDs distinct and omits unindexed previews even when requested', async () => {
    mockedRequireAuthorizedProject.mockResolvedValue(
      authorizedProject(coworkItem, 'cowork-project', 'Cowork Project'),
    );
    mockEntries([
      workEntry('entry-1', {
        summary: {
          version: 1,
          title: 'Entry title',
          chatCount: 1,
          chats: [],
        },
      }),
    ]);
    const tab = chatTab('chat-1', {
      title: 'Compact chat title',
      description: 'Compact description',
      providerType: 'codex',
      executionHarness: 'codex',
      model: 'gpt-5-codex',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
      },
    });
    Object.defineProperty(tab, 'messages', {
      configurable: true,
      get: () => {
        throw new Error('Transcript history must not be read');
      },
    });
    mockSnapshots(({ workspaceId, worktreeId }) =>
      chatSnapshot(workspaceId, worktreeId, [tab], {
        'chat-1': { status: 'streaming', queuedMessageIds: [] },
      }),
    );

    const rows = await listChatRows(
      chatAction({
        projectId: 'cowork-project',
        taskId: 'entry-1',
        name: 'compact chat title',
        includeLastUserMessage: true,
      }),
      caller,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: 'cowork-project',
      taskId: 'entry-1',
      chatId: 'chat-1',
      title: 'Compact chat title',
      description: 'Compact description',
      providerType: 'codex',
      executionHarness: 'codex',
      runtimeState: 'running',
      hasPluginSelections: true,
      capabilities: {
        canRead: true,
        canSend: true,
        canWatch: true,
        canSteerQueuedMessage: false,
        unavailableReason: 'no_queued_message',
      },
      session: { state: 'active', expired: false, readOnly: false },
    });
    expect(rows[0]?.lastUserMessage).toBeUndefined();
    expect(mockRuntime.queryChatStateForLegacyIpc).toHaveBeenCalledTimes(1);
    expect(
      mockRuntime.queryChatStateForLegacyIpc.mock.calls[0]?.[0].scope,
    ).toEqual({ workspaceId: 'cowork-project', worktreeId: 'entry-1' });
  });

  it('filters by runtime, provider, harness, and queued evidence without treating queued as running', async () => {
    mockWorktrees([worktree('task-1')]);
    mockSnapshots(({ workspaceId, worktreeId }) =>
      chatSnapshot(
        workspaceId,
        worktreeId,
        [
          chatTab('queued-chat', {
            providerType: 'claude',
            executionHarness: 'claude',
          }),
          chatTab('unknown-chat', {
            providerType: 'codex',
            executionHarness: 'codex',
          }),
        ],
        {
          'queued-chat': {
            status: 'queued',
            queuedMessageIds: ['q1'],
            steeringCapabilities: {
              provider: 'claude',
              generation: 'test-generation',
              steer: true,
              withdraw: false,
              interrupt: false,
            },
          },
        },
        [
          {
            projectId: 'code-project',
            worktreeId: 'task-1',
            chatId: 'queued-chat',
            queue: [
              {
                id: 'q1',
                text: 'do not read this queued payload',
                origin: 'desktop',
                enqueuedAtMs: 1,
              },
            ],
          },
        ],
      ),
    );

    const queued = await listChatRows(
      chatAction({
        runtimeStates: ['queued'],
        providerTypes: ['claude'],
        executionHarnesses: ['claude'],
        hasQueuedMessages: true,
      }),
      caller,
    );

    expect(queued.map((row) => [row.chatId, row.runtimeState])).toEqual([
      ['queued-chat', 'queued'],
    ]);
    expect(queued[0]?.queuedMessageCount).toBe(1);
    expect(queued[0]?.capabilities.canSteerQueuedMessage).toBe(true);
  });

  it('reads each retained task snapshot once when listing many tasks', async () => {
    const tasks = Array.from({ length: 24 }, (_, index) =>
      worktree(`task-${index}`),
    );
    mockWorktrees(tasks);

    const rows = await listChatRows(chatAction(), caller);

    expect(rows).toHaveLength(0);
    expect(mockRuntime.queryChatStateForLegacyIpc).toHaveBeenCalledTimes(
      tasks.length,
    );
    expect(
      new Set(
        mockRuntime.queryChatStateForLegacyIpc.mock.calls.map(
          ([request]) => request.scope.worktreeId,
        ),
      ),
    ).toEqual(new Set(tasks.map((task) => task.id)));
  });

  it('rejects archived chat filters and preserves strict source failures', async () => {
    await expect(
      listChatRows(chatAction({ retentionStates: ['archived'] }), caller),
    ).rejects.toMatchObject({ code: 'unsupported_filter' });

    mockWorktrees([worktree('task-1')]);
    mockRuntime.queryChatStateForLegacyIpc.mockRejectedValue(
      new DiscoveryError('execution_failed', 'Chat state could not be read.'),
    );
    await expect(listChatRows(chatAction(), caller)).rejects.toMatchObject({
      code: 'execution_failed',
    });
  });

  it('returns not_found for task IDs outside the authorized retained inventory', async () => {
    mockWorktrees([worktree('visible-task')]);

    await expect(
      listChatRows(chatAction({ taskId: 'not-visible' }), caller),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(mockRuntime.queryChatStateForLegacyIpc).not.toHaveBeenCalled();
  });

  it('rejects incomplete or mis-scoped task snapshots', async () => {
    mockWorktrees([worktree('task-1')]);
    mockRuntime.queryChatStateForLegacyIpc.mockResolvedValue({
      legacyResult: {
        ...chatSnapshot('different-project', 'task-1'),
      },
    });

    await expect(listChatRows(chatAction(), caller)).rejects.toMatchObject({
      code: 'execution_failed',
      message: 'Task runtime snapshot did not match the requested task.',
    });
  });

  it('rejects snapshots with a recovery warning instead of projecting empty chats', async () => {
    mockWorktrees([worktree('task-1')]);
    mockRuntime.queryChatStateForLegacyIpc.mockResolvedValue({
      legacyResult: {
        ...chatSnapshot('code-project', 'task-1'),
        recoveryError: 'partial recovery',
      },
    });

    await expect(listChatRows(chatAction(), caller)).rejects.toMatchObject({
      code: 'execution_failed',
      message: 'Task runtime snapshot could not be read.',
    });
  });

  it('reports session expiry/read-only without exposing dropped text or session ids', async () => {
    mockWorktrees([worktree('task-1')]);
    mockSnapshots(({ workspaceId, worktreeId }) =>
      chatSnapshot(workspaceId, worktreeId, [
        chatTab('chat-1', {
          readOnly: true,
          staleSessionDetected: {
            droppedMessageText: 'private dropped content',
            droppedInputMode: 'typed',
          },
        }),
      ]),
    );

    const rows = await listChatRows(chatAction(), caller);
    const row = rows[0];

    expect(row?.capabilities).toMatchObject({
      canRead: true,
      canWatch: true,
      canSend: false,
    });
    expect(row?.session).toMatchObject({
      state: 'expired',
      expired: true,
      readOnly: true,
      // Matches the hand-off action, which accepts expired sessions.
      canHandOff: true,
      undeliveredMessagePresent: true,
      undeliveredMessageLength: 'private dropped content'.length,
      undeliveredInputMode: 'typed',
    });
    expect(JSON.stringify(row)).not.toContain('private dropped content');
    expect(JSON.stringify(row)).not.toContain('sessionId');
  });

  it('reports no hand-off for a healthy session', async () => {
    mockWorktrees([worktree('task-1')]);
    mockSnapshots(({ workspaceId, worktreeId }) =>
      chatSnapshot(workspaceId, worktreeId, [chatTab('chat-1')]),
    );

    const rows = await listChatRows(chatAction(), caller);

    expect(rows[0]?.session).toMatchObject({
      expired: false,
      canHandOff: false,
    });
  });
});

describe('authorized chat resolution for reads', () => {
  it('resolves a code chat to its canonical scope and public row', async () => {
    mockWorktrees([worktree('task-1')]);
    mockSnapshots(({ workspaceId, worktreeId }) =>
      chatSnapshot(workspaceId, worktreeId, [chatTab('chat-1')]),
    );

    const context = await resolveAuthorizedChat(
      { projectId: 'code-project', taskId: 'task-1', chatId: 'chat-1' },
      caller,
    );

    expect(context).toMatchObject({
      address: {
        projectId: 'code-project',
        taskId: 'task-1',
        chatId: 'chat-1',
      },
      projectType: 'code',
      scope: {
        workspaceId: 'code-project',
        worktreeId: 'task-1',
        chatId: 'chat-1',
      },
      row: { chatId: 'chat-1', title: 'Chat chat-1' },
    });
  });

  it('resolves a cowork chat through its Work Entry', async () => {
    mockedRequireAuthorizedProject.mockResolvedValue(
      authorizedProject(coworkItem, 'cowork-project', 'Cowork Project'),
    );
    mockEntries([workEntry('entry-1')]);
    mockSnapshots(({ workspaceId, worktreeId }) =>
      chatSnapshot(workspaceId, worktreeId, [chatTab('chat-1')]),
    );

    await expect(
      resolveAuthorizedChat(
        { projectId: 'cowork-project', taskId: 'entry-1', chatId: 'chat-1' },
        caller,
      ),
    ).resolves.toMatchObject({
      projectType: 'cowork',
      scope: {
        workspaceId: 'cowork-project',
        worktreeId: 'entry-1',
        chatId: 'chat-1',
      },
    });
  });

  it.each([
    ['a chat that lives under another task', 'task-1', 'chat-2'],
    ['a file tab', 'task-1', 'file-1'],
    ['a task that is not discoverable', 'hidden-task', 'chat-1'],
    ['the cowork home slot', COWORK_HOME_WORKTREE_ID, 'chat-1'],
  ])('reports %s as not found', async (_case, taskId, chatId) => {
    mockWorktrees([
      worktree('task-1'),
      worktree('task-2'),
      worktree('hidden-task', { hidden: true }),
    ]);
    mockSnapshots(({ workspaceId, worktreeId }) =>
      chatSnapshot(
        workspaceId,
        worktreeId,
        worktreeId === 'task-2'
          ? [chatTab('chat-2')]
          : [chatTab('chat-1'), chatTab('file-1', { kind: 'file' })],
      ),
    );

    await expect(
      resolveAuthorizedChat(
        { projectId: 'code-project', taskId, chatId },
        caller,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports a cross-owner project exactly like an unknown one', async () => {
    mockedRequireAuthorizedProject.mockRejectedValue(
      new DiscoveryError('not_found', 'Project was not found.'),
    );

    await expect(
      resolveAuthorizedChat(
        { projectId: 'other-owner', taskId: 'task-1', chatId: 'chat-1' },
        caller,
      ),
    ).rejects.toMatchObject({
      code: 'not_found',
      message: 'Project was not found.',
    });
    expect(mockRuntime.queryChatStateForLegacyIpc).not.toHaveBeenCalled();
  });
});

describe('Advisor storage scope through canonical chat adapters', () => {
  function fixturePort(): jest.Mocked<ChatStateCommandPort> {
    return {
      getState: jest
        .fn()
        .mockResolvedValue(
          chatSnapshot('app-advisor', 'entry-1', [
            chatTab('chat-1'),
            chatTab('chat-2'),
          ]),
        ),
      getTranscriptPage: jest.fn().mockResolvedValue({
        messages: [],
        totalMessages: 0,
        transcriptRevision: 7,
      }),
      searchTranscript: jest.fn(),
      readToolOutput: jest.fn(),
      readVisual: jest.fn(),
      command: jest.fn(),
      subscribe: jest.fn().mockReturnValue(() => undefined),
    };
  }
  const context: CanopyHandlerContext = {
    requestId: 'advisor-read-test',
    caller: {
      principalId: 'test',
      clientInstanceId: 'test',
      authorityId: 'local-desktop',
      interfaceKind: 'test',
      grants: ['core.chat.read'],
    },
    metadata: {},
    signal: new AbortController().signal,
  };
  const scope = {
    workspaceId: 'app-advisor',
    worktreeId: 'entry-1',
    chatId: 'chat-1',
  };

  it('projects retained Advisor tabs through the snapshot adapter without a workspace-owner lookup', async () => {
    const port = fixturePort();
    const adapter = createCoreChatStateAdapter(() => port);
    const snapshot = await adapter['core.chat.snapshot.get'](
      { scope, chatId: 'chat-1' },
      context,
    );
    expect(jest.spyOn(port, 'getState')).toHaveBeenCalledWith({
      projectId: 'app-advisor',
      worktreeId: 'entry-1',
    });
    expect(snapshot).toMatchObject({
      workspaceId: 'app-advisor',
      worktreeId: 'entry-1',
      tabs: { items: [{ chatId: 'chat-1' }] },
    });
    expect(snapshot.tabs.items).toHaveLength(1);
    expect(mockedRequireAuthorizedProject).not.toHaveBeenCalled();
  });

  it('forwards the complete Advisor transcript scope to the canonical read port', async () => {
    const port = fixturePort();
    const adapter = createCoreChatReadAdapter({ getPort: () => port });
    await expect(
      adapter['core.chat.transcript.page'](
        { scope, transcriptRevision: 7 },
        context,
      ),
    ).resolves.toMatchObject({ messages: [], transcriptRevision: 7 });
    expect(jest.spyOn(port, 'getTranscriptPage')).toHaveBeenCalledWith({
      projectId: 'app-advisor',
      worktreeId: 'entry-1',
      chatId: 'chat-1',
      transcriptRevision: 7,
    });
    expect(mockedRequireAuthorizedProject).not.toHaveBeenCalled();
  });

  it('propagates Advisor snapshot and transcript read failures instead of presenting empty success', async () => {
    const port = fixturePort();
    port.getState = jest
      .fn()
      .mockRejectedValue(new Error('unreadable snapshot'));
    port.getTranscriptPage = jest
      .fn()
      .mockRejectedValue(new Error('unreadable transcript'));
    const state = createCoreChatStateAdapter(() => port);
    const read = createCoreChatReadAdapter({ getPort: () => port });
    await expect(
      state['core.chat.snapshot.get']({ scope, chatId: 'chat-1' }, context),
    ).rejects.toThrow();
    await expect(
      read['core.chat.transcript.page']({ scope }, context),
    ).rejects.toThrow();
  });
});
