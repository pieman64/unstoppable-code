jest.mock('../project-discovery/owner-policy');
jest.mock('../lib/cowork-work-entries');
jest.mock('../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): RuntimeDispatcherMock => mockRuntime,
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): ContextServiceMock => mockContext,
}));

import type {
  ChatStateSnapshot,
  ProjectOwnerContext,
  CoworkSidebarItem,
  PersistedChatTab,
  SidebarItem,
  SingleRepoSidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import type {
  ProjectReadAction,
  ProjectsReadHistoryAction,
} from '@canopy/desktop-shared/lib/project-reads';
import type { ProjectDiscoveryCaller } from '../project-discovery';
import type { AuthorizedProject } from '../project-discovery/owner-policy';
import type { PersistedChatMessage } from '@canopy/agent-transcript';
import type {
  TranscriptPage,
  TranscriptTurnSummary,
} from '@canopy/agent-transcript/transcript-storage';
import type { CoreChatTranscriptPageParams } from '@canopy/protocol/canopy-core';
import type { CoworkWorkEntriesFile } from '@canopy/desktop-shared/types';
import { dispatchProjectReadAction } from '../project-discovery/reads';
import {
  getCallerOwner,
  requireAuthorizedProject,
} from '../project-discovery/owner-policy';
import { readWorkEntriesFileStrict } from '../lib/cowork-work-entries';

import { DiscoveryError } from '../project-discovery/errors';
import {
  ReadCursorStore,
  READ_CURSOR_TTL_MS,
} from '../project-discovery/reads/cursor-store';

const PROJECT = 'project';
const TASK = 'task';
const CHAT = 'chat';
const PERSONAL_OWNER: ProjectOwnerContext = {
  kind: 'personal',
};
const codeItem = {
  id: PROJECT,
  type: 'single-repo',
  name: 'Project',
  repoPath: '/unused/project',
  color: 'blue',
  worktrees: [],
  collapsed: false,
  order: 0,
} satisfies SingleRepoSidebarItem;
const coworkItem = {
  id: 'cowork',
  type: 'cowork',
  name: 'Cowork',
  color: 'purple',
  collapsed: false,
  order: 0,
} satisfies CoworkSidebarItem;
const caller = {
  kind: 'project_agent',
  projectId: PROJECT,
  worktreeId: TASK,
  chatId: CHAT,
} satisfies ProjectDiscoveryCaller;

type WorktreeRequest = { scope: { workspaceId: string } };
type SnapshotRequest = { scope: { workspaceId: string; worktreeId: string } };
type TranscriptRequest = CoreChatTranscriptPageParams;
type DispatcherOptions = {
  caller: {
    principalId: string;
    clientInstanceId: string;
    authorityId: string;
    interfaceKind: 'mcp';
    grants: string[];
  };
};
type RuntimeDispatcherMock = {
  queryWorktreeListForLegacyIpc: jest.Mock<
    Promise<{
      canonicalResult: { items: never[]; nextCursor: null };
      legacyResult: WorktreeData[];
      legacyAuthority: { authority: 'ok' };
    }>,
    [WorktreeRequest, DispatcherOptions]
  >;
  queryChatStateForLegacyIpc: jest.Mock<
    Promise<{ canonicalResult: object; legacyResult: ChatStateSnapshot }>,
    [SnapshotRequest, DispatcherOptions]
  >;
  queryChatTranscriptPageForLegacyIpc: jest.Mock<
    Promise<{
      canonicalResult: {
        messages: PersistedChatMessage[];
        totalMessages: number;
        transcriptRevision: number;
        view?: 'turns';
        turnId?: string;
        messageOrdinals?: Record<string, number>;
        turns?: TranscriptTurnSummary[];
        before?: number;
      };
      legacyResult: TranscriptPage;
    }>,
    [TranscriptRequest, DispatcherOptions]
  >;
};
type ContextServiceMock = {
  initialize: jest.Mock<Promise<void>, []>;
  whenIdle: jest.Mock<Promise<void>, []>;
  accountEpoch: () => number;
};
let mockRuntime: RuntimeDispatcherMock;
let mockContext: ContextServiceMock;
let accountEpoch = 1;
let readTranscript: (params: CoreChatTranscriptPageParams) => TranscriptPage;
let rawPageWidth = 2;

function createRuntime(): RuntimeDispatcherMock {
  const worktreeReader: RuntimeDispatcherMock['queryWorktreeListForLegacyIpc'] =
    jest.fn<
      ReturnType<RuntimeDispatcherMock['queryWorktreeListForLegacyIpc']>,
      Parameters<RuntimeDispatcherMock['queryWorktreeListForLegacyIpc']>
    >(() =>
      Promise.resolve({
        canonicalResult: { items: [], nextCursor: null },
        legacyResult: [worktree(TASK)],
        legacyAuthority: { authority: 'ok' },
      }),
    );
  const snapshotReader: RuntimeDispatcherMock['queryChatStateForLegacyIpc'] =
    jest.fn<
      ReturnType<RuntimeDispatcherMock['queryChatStateForLegacyIpc']>,
      Parameters<RuntimeDispatcherMock['queryChatStateForLegacyIpc']>
    >(({ scope }) =>
      Promise.resolve({
        canonicalResult: {
          workspaceId: scope.workspaceId,
          worktreeId: scope.worktreeId,
          revision: 1,
          tabs: {
            activeTabId: CHAT,
            items: [
              {
                chatId: CHAT,
                title: 'Chat',
                kind: 'chat',
                createdAt: '2026-10-01',
              },
            ],
          },
          archives: [],
          runtimeByChatId: {},
          queue: [],
        },
        legacyResult: snapshot(scope.workspaceId, scope.worktreeId),
      }),
    );
  const transcriptReader: RuntimeDispatcherMock['queryChatTranscriptPageForLegacyIpc'] =
    jest.fn<
      ReturnType<RuntimeDispatcherMock['queryChatTranscriptPageForLegacyIpc']>,
      Parameters<RuntimeDispatcherMock['queryChatTranscriptPageForLegacyIpc']>
    >((params) => {
      const page = readTranscript(params);
      return Promise.resolve({
        canonicalResult: {
          messages: page.messages,
          totalMessages: page.totalMessages,
          transcriptRevision: page.transcriptRevision,
          ...(page.view === 'turns' ? { view: page.view } : {}),
          ...(page.turnId ? { turnId: page.turnId } : {}),
          ...(page.messageOrdinals
            ? { messageOrdinals: page.messageOrdinals }
            : {}),
          ...(page.turns ? { turns: page.turns } : {}),
          ...(page.before !== undefined ? { before: page.before } : {}),
        },
        legacyResult: page,
      });
    });
  return {
    queryWorktreeListForLegacyIpc: worktreeReader,
    queryChatStateForLegacyIpc: snapshotReader,
    queryChatTranscriptPageForLegacyIpc: transcriptReader,
  };
}

function worktree(
  id: string,
  overrides: Partial<WorktreeData> = {},
): WorktreeData {
  return {
    id,
    branchName: `branch/${id}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function tab(
  id: string,
  overrides: Partial<PersistedChatTab> = {},
): PersistedChatTab {
  return {
    id,
    title: `Chat ${id}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    messages: [],
    ...overrides,
  };
}

function snapshot(
  projectId: string,
  worktreeId: string,
  tabs: PersistedChatTab[] = [tab(CHAT)],
): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId,
    worktreeId,
    revision: 1,
    tabsFile: { version: 1, tabs, activeTabId: tabs[0]?.id ?? '' },
    archives: [],
    runtimeByChatId: {},
    queue: [],
  };
}

function message(
  id: string,
  role: PersistedChatMessage['role'],
  text: string,
  extra: Partial<PersistedChatMessage> = {},
): PersistedChatMessage {
  return {
    id,
    role,
    timestamp: 1_791_000_000_000,
    blocks: text ? [{ type: 'text', text }] : [],
    ...extra,
  };
}

const emptyCounts: TranscriptTurnSummary['summary'] = {
  messages: 0,
  thinking: 0,
  bash: 0,
  read: 0,
  readLines: 0,
  writeEdit: 0,
  plan: 0,
  fileEdit: 0,
  fileAdd: 0,
  fileDelete: 0,
  search: 0,
  grep: 0,
  web: 0,
  agent: 0,
  workflow: 0,
  tasks: 0,
  taskStop: 0,
  skills: 0,
  monitor: 0,
  claude: 0,
  scheduleWakeup: 0,
  askUser: 0,
  scriptOutput: 0,
  watcher: 0,
  canopy: 0,
  graph: 0,
  appAdvisor: 0,
  pipelineEditor: 0,
  computerUse: 0,
  mcp: 0,
  other: 0,
};

function turn(
  id: string,
  start: number,
  end: number,
  finalMessageIds: string[] = [],
  complete = true,
): TranscriptTurnSummary {
  return { id, start, end, complete, finalMessageIds, summary: emptyCounts };
}

function pageForMessages(
  rows: PersistedChatMessage[],
  params: CoreChatTranscriptPageParams,
  width = rawPageWidth,
  revision = 1,
): TranscriptPage {
  const upper = params.before ?? rows.length;
  const start = Math.max(0, upper - width);
  const pageRows = rows.slice(start, upper);
  const page: TranscriptPage = {
    messages: pageRows,
    totalMessages: rows.length,
    transcriptRevision: revision,
    ...(start > 0 ? { before: start } : {}),
    ...(params.view === 'turns'
      ? {
          view: 'turns',
          messageOrdinals: Object.fromEntries(
            pageRows.map((row, index) => [row.id, start + index]),
          ),
          turns: pageRows.map((row, index) =>
            turn(
              `turn-${start + index}`,
              start + index,
              start + index + 1,
              row.role === 'assistant' ? [row.id] : [],
            ),
          ),
        }
      : {}),
  };
  return page;
}

function authorizedProject(
  type: 'code' | 'cowork' = 'code',
): AuthorizedProject {
  const item: SidebarItem = type === 'code' ? codeItem : coworkItem;
  return {
    item,
    projectId: item.id,
    type,
    purpose: 'project',
    name: item.name,
    displayName: item.name,
    incarnation: `${item.id}:incarnation`,
    isDefault: false,
    owner: PERSONAL_OWNER,
    readiness: 'ready',
    synthetic: false,
    inventoryAuthority: 'ok',
    inventoryOwnerMalformed: false,
  };
}

function historyAction(
  fields: Partial<ProjectsReadHistoryAction> = {},
): ProjectReadAction {
  return {
    type: 'projects.read_history',
    projectId: PROJECT,
    taskId: TASK,
    chatId: CHAT,
    pageSize: 2,
    order: 'desc',
    ...fields,
  };
}

const lastUserAction = {
  type: 'projects.get_last_user_message',
  projectId: PROJECT,
  taskId: TASK,
  chatId: CHAT,
} satisfies ProjectReadAction;
const lastAgentAction = {
  type: 'projects.get_last_agent_response',
  projectId: PROJECT,
  taskId: TASK,
  chatId: CHAT,
} satisfies ProjectReadAction;

beforeEach(() => {
  jest.resetAllMocks();
  accountEpoch = 1;
  mockContext = {
    initialize: jest.fn(() => Promise.resolve()),
    whenIdle: jest.fn(() => Promise.resolve()),
    accountEpoch: (): number => accountEpoch,
  };
  mockRuntime = createRuntime();
  rawPageWidth = 2;
  readTranscript = (params: CoreChatTranscriptPageParams): TranscriptPage =>
    pageForMessages([], params);
  jest.mocked(getCallerOwner).mockResolvedValue(PERSONAL_OWNER);
  jest
    .mocked(requireAuthorizedProject)
    .mockImplementation((projectId) =>
      Promise.resolve(
        projectId === 'cowork'
          ? authorizedProject('cowork')
          : authorizedProject('code'),
      ),
    );
  jest.mocked(readWorkEntriesFileStrict).mockResolvedValue({
    version: 1,
    entries: [{ id: TASK, createdAt: '2026-10-01T00:00:00.000Z' }],
  } satisfies CoworkWorkEntriesFile);
});

function useMessages(rows: PersistedChatMessage[], width = rawPageWidth): void {
  readTranscript = (params: CoreChatTranscriptPageParams): TranscriptPage =>
    pageForMessages(rows, params, width);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function successfulResult(
  response: Awaited<ReturnType<typeof dispatchProjectReadAction>>,
): Record<string, unknown> {
  if (!response.ok || !isRecord(response.result)) {
    throw new Error('Expected project read success result');
  }
  return response.result;
}

describe('project read actions', () => {
  test('returns the newest explicit self-chat user message through the dispatcher', async () => {
    useMessages([
      message('u1', 'user', 'older'),
      message('a1', 'assistant', 'reply'),
      message('u2', 'user', 'latest'),
    ]);
    const response = await dispatchProjectReadAction(lastUserAction, caller);
    expect(response).toMatchObject({
      ok: true,
      result: {
        address: { projectId: PROJECT, taskId: TASK, chatId: CHAT },
        message: { messageId: 'u2', role: 'user', text: 'latest' },
      },
    });
    const transcriptCall =
      mockRuntime.queryChatTranscriptPageForLegacyIpc.mock.calls[0];
    if (!transcriptCall)
      throw new Error('Expected a transcript dispatcher call');
    expect(transcriptCall[0].scope).toEqual({
      workspaceId: PROJECT,
      worktreeId: TASK,
      chatId: CHAT,
    });
    expect(transcriptCall[1].caller.interfaceKind).toBe('mcp');
    expect(transcriptCall[1].caller.grants).toEqual(['core.chat.read']);
  });

  test('last user message carries the same canonical turn id as history', async () => {
    useMessages([
      message('u1', 'user', 'older'),
      message('a1', 'assistant', 'reply'),
      message('u2', 'user', 'latest'),
      message('a2', 'assistant', 'answer'),
    ]);
    const last = successfulResult(
      await dispatchProjectReadAction(lastUserAction, caller),
    );
    const history = successfulResult(
      await dispatchProjectReadAction(
        historyAction({ roles: ['user'], pageSize: 1 }),
        caller,
      ),
    );
    expect(last.message).toMatchObject({ messageId: 'u2', turnId: 'turn-2' });
    expect(history.items).toMatchObject([
      { messageId: 'u2', turnId: 'turn-2' },
    ]);
  });

  test('resolves only the requested code project task and chat, independent of active tab', async () => {
    const state = snapshot(PROJECT, TASK, [tab('other'), tab(CHAT)]);
    mockRuntime.queryChatStateForLegacyIpc.mockImplementation(() =>
      Promise.resolve({ canonicalResult: {}, legacyResult: state }),
    );
    useMessages([message('u1', 'user', 'selected')]);
    const response = await dispatchProjectReadAction(lastUserAction, caller);
    expect(response).toMatchObject({
      ok: true,
      result: {
        address: { projectId: PROJECT, taskId: TASK, chatId: CHAT },
        message: { messageId: 'u1' },
      },
    });
    const worktreeCall =
      mockRuntime.queryWorktreeListForLegacyIpc.mock.calls[0];
    if (!worktreeCall) throw new Error('Expected a worktree dispatcher call');
    expect(worktreeCall[0]).toEqual({ scope: { workspaceId: PROJECT } });
    expect(worktreeCall[1].caller.grants).toEqual(['core.worktree.read']);
  });

  test('resolves cowork work entries as explicit task parents', async () => {
    const action = {
      ...lastUserAction,
      projectId: 'cowork',
    } satisfies ProjectReadAction;
    jest.mocked(readWorkEntriesFileStrict).mockResolvedValue({
      version: 1,
      entries: [{ id: TASK, createdAt: '2026-10-01' }],
    });
    mockRuntime.queryChatStateForLegacyIpc.mockImplementation(() =>
      Promise.resolve({
        canonicalResult: {},
        legacyResult: snapshot('cowork', TASK),
      }),
    );
    useMessages([message('u1', 'user', 'cowork')]);
    expect(await dispatchProjectReadAction(action, caller)).toMatchObject({
      ok: true,
      result: {
        address: { projectId: 'cowork', taskId: TASK, chatId: CHAT },
        message: { text: 'cowork' },
      },
    });
    expect(readWorkEntriesFileStrict).toHaveBeenCalledWith('cowork');
  });

  test('does not repair a wrong-parent task or chat from another task', async () => {
    const wrongTask = {
      ...lastUserAction,
      taskId: 'another-task',
    } satisfies ProjectReadAction;
    const response = await dispatchProjectReadAction(wrongTask, caller);
    expect(response).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(
      mockRuntime.queryChatTranscriptPageForLegacyIpc,
    ).not.toHaveBeenCalled();
  });

  test('filters hidden, child, system and empty rows before exposing history', async () => {
    useMessages([
      message('hidden', 'user', 'private', { hidden: true }),
      message('child', 'assistant', 'nested', { parentBlockId: 'call' }),
      message('tool-child', 'assistant', 'nested too', {
        parentToolUseId: 'tool',
      }),
      message('system', 'system', 'internal'),
      message('empty', 'user', ''),
      message('visible', 'assistant', 'public'),
    ]);
    const response = await dispatchProjectReadAction(
      historyAction({ pageSize: 10 }),
      caller,
    );
    expect(response).toMatchObject({
      ok: true,
      result: {
        items: [{ messageId: 'visible', text: 'public' }],
        totalMessages: 1,
        totalMatches: 1,
        countsExact: true,
      },
    });
    expect(JSON.stringify(response)).not.toContain('private');
    expect(JSON.stringify(response)).not.toContain('nested');
  });

  test('matches uncapped raw text before truncating output and applies role filters before totals', async () => {
    const longText = `${'x'.repeat(8200)} needlez`;
    useMessages([
      message('match', 'assistant', longText),
      message('skip-role', 'user', 'needlez'),
    ]);
    const response = await dispatchProjectReadAction(
      historyAction({ query: ' NEEDLEZ ', roles: ['assistant'], pageSize: 5 }),
      caller,
    );
    expect(response).toMatchObject({
      ok: true,
      result: {
        returned: 1,
        totalMessages: 2,
        totalMatches: 1,
        items: [{ messageId: 'match', truncated: true }],
      },
    });
    expect(successfulResult(response).query).toBe('NEEDLEZ');
    expect(JSON.stringify(response)).not.toContain('skip-role');
  });

  test('selects the final visible assistant row from the latest complete turn and correlates disposition', async () => {
    const delivered = tab(CHAT, {
      inputDelivery: {
        version: 1,
        epoch: 1,
        rows: [
          {
            id: 'delivery',
            revision: 1,
            createdAt: 1,
            state: 'picked-up',
            text: 'secret input',
            payload: {
              projectId: PROJECT,
              worktreeId: TASK,
              chatId: CHAT,
              userMessageId: 'u2',
              text: 'secret input',
            },
            settingsKey: 'x',
            attempts: [
              {
                id: 'attempt',
                generation: 'g',
                provider: 'codex',
                createdAt: 1,
                rootUserMessageId: 'u2',
                turnOutcome: 'completed',
                turnSettledAt: 3,
              },
            ],
          },
        ],
      },
    });
    mockRuntime.queryChatStateForLegacyIpc = jest.fn<
      ReturnType<RuntimeDispatcherMock['queryChatStateForLegacyIpc']>,
      Parameters<RuntimeDispatcherMock['queryChatStateForLegacyIpc']>
    >(() =>
      Promise.resolve({
        canonicalResult: {
          workspaceId: PROJECT,
          worktreeId: TASK,
          revision: 1,
          tabs: { activeTabId: CHAT, items: [] },
          archives: [],
          runtimeByChatId: {},
          queue: [],
        },
        legacyResult: snapshot(PROJECT, TASK, [delivered]),
      }),
    );
    const rows = [
      message('u1', 'user', 'first'),
      message('f1', 'assistant', 'old final'),
      message('u2', 'user', 'second'),
      message('frame', 'assistant', 'frame'),
      message('f2', 'assistant', 'new final'),
    ];
    const selected = turn('u2', 2, 5, ['f2']);
    readTranscript = (params): TranscriptPage => ({
      ...pageForMessages(rows, params, 10),
      ...(params.view === 'turns'
        ? { turns: [turn('turn-old', 0, 2, ['f1']), selected] }
        : {}),
    });
    const response = await dispatchProjectReadAction(lastAgentAction, caller);
    expect(response).toMatchObject({
      ok: true,
      result: {
        message: { messageId: 'f2', turnId: 'u2', text: 'new final' },
        terminalDisposition: 'completed',
      },
    });
    expect(JSON.stringify(response)).not.toContain('secret input');
  });

  test('returns null for no visible completed agent turn and ignores sticky context from below the page window', async () => {
    const rows = [message('old', 'assistant', 'old sticky')];
    let turnPage = 0;
    readTranscript = (params): TranscriptPage => {
      turnPage += params.view === 'turns' ? 1 : 0;
      if (params.view === 'turns' && params.before === undefined) {
        return {
          messages: rows,
          totalMessages: 10,
          before: 5,
          transcriptRevision: 1,
          view: 'turns',
          turns: [turn('sticky-turn', 0, 1, ['old'])],
        };
      }
      if (params.view === 'turns') {
        return {
          messages: [],
          totalMessages: 10,
          transcriptRevision: 1,
          view: 'turns',
          turns: [],
        };
      }
      return {
        messages: [],
        totalMessages: 10,
        before: 5,
        transcriptRevision: 1,
      };
    };
    const response = await dispatchProjectReadAction(lastAgentAction, caller);
    expect(response).toMatchObject({ ok: true, result: { message: null } });
    expect(turnPage).toBeGreaterThan(1);
  });

  test('desc paging returns a continuation and partial counts when earlier rows remain', async () => {
    useMessages([
      message('m1', 'user', 'one'),
      message('m2', 'assistant', 'two'),
      message('m3', 'user', 'three'),
      message('m4', 'assistant', 'four'),
    ]);
    const response = await dispatchProjectReadAction(
      historyAction({ pageSize: 2 }),
      caller,
    );
    expect(response).toMatchObject({
      ok: true,
      result: {
        items: [{ messageId: 'm4' }, { messageId: 'm3' }],
        returned: 2,
        totalMessages: null,
        totalMatches: null,
        countsExact: false,
      },
    });
    expect(nextCursor(response)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('ascending history rescans within budget and returns oldest visible rows first', async () => {
    useMessages([
      message('m1', 'user', 'one'),
      message('m2', 'assistant', 'two'),
      message('m3', 'user', 'three'),
      message('m4', 'assistant', 'four'),
    ]);
    const response = await dispatchProjectReadAction(
      historyAction({ order: 'asc', pageSize: 2 }),
      caller,
    );
    expect(response).toMatchObject({
      ok: true,
      result: {
        items: [{ messageId: 'm1' }, { messageId: 'm2' }],
        returned: 2,
        countsExact: true,
        totalMessages: 4,
        totalMatches: 4,
      },
    });
    expect(nextCursor(response)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a caller task cannot read a chat under a different project parent', async () => {
    const wrongParent = {
      ...lastUserAction,
      projectId: 'other-project',
    } satisfies ProjectReadAction;
    jest.mocked(requireAuthorizedProject).mockImplementation(() =>
      Promise.resolve({
        ...authorizedProject(),
        projectId: 'other-project',
        item: { ...codeItem, id: 'other-project' },
      }),
    );
    mockRuntime.queryWorktreeListForLegacyIpc = jest.fn<
      ReturnType<RuntimeDispatcherMock['queryWorktreeListForLegacyIpc']>,
      Parameters<RuntimeDispatcherMock['queryWorktreeListForLegacyIpc']>
    >(() =>
      Promise.resolve({
        canonicalResult: { items: [], nextCursor: null },
        legacyResult: [],
        legacyAuthority: { authority: 'ok' },
      }),
    );
    expect(await dispatchProjectReadAction(wrongParent, caller)).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(mockRuntime.queryChatStateForLegacyIpc).not.toHaveBeenCalled();
  });

  test('history file references reveal only the basename and never the host path', async () => {
    const fileMessage = message('file', 'user', '', {
      blocks: [
        {
          type: 'file_references',
          references: [
            {
              absolutePath: '/Users/private/secret/report.md',
              displayPath: '/Users/private/secret/report.md',
            },
          ],
        },
      ],
    });
    useMessages([fileMessage]);
    const response = await dispatchProjectReadAction(
      historyAction({ pageSize: 5 }),
      caller,
    );
    expect(response).toMatchObject({
      ok: true,
      result: { items: [{ messageId: 'file', text: '[file] report.md' }] },
    });
    expect(JSON.stringify(response)).not.toContain('/Users/private');
  });

  test('last-user selection ignores hidden and nested messages and does not expose empty rows', async () => {
    useMessages([
      message('u-old', 'user', 'visible old'),
      message('u-private', 'user', 'private newest', { hidden: true }),
      message('a-child', 'assistant', 'nested', { parentToolUseId: 'use' }),
    ]);
    expect(
      await dispatchProjectReadAction(lastUserAction, caller),
    ).toMatchObject({
      ok: true,
      result: { message: { messageId: 'u-old', text: 'visible old' } },
    });
  });

  test('last-agent selection prefers an earlier complete turn over a newer incomplete turn', async () => {
    const rows = [
      message('old-final', 'assistant', 'completed'),
      message('new-partial', 'assistant', 'streaming'),
    ];
    readTranscript = (params): TranscriptPage => ({
      ...pageForMessages(rows, params, 10),
      ...(params.view === 'turns'
        ? {
            turns: [
              turn('old-turn', 0, 1, ['old-final']),
              turn('streaming-turn', 1, 2, ['new-partial'], false),
            ],
          }
        : {}),
    });
    expect(
      await dispatchProjectReadAction(lastAgentAction, caller),
    ).toMatchObject({
      ok: true,
      result: { message: { messageId: 'old-final', turnId: 'old-turn' } },
    });
  });

  test('last-agent does not infer a final answer from a frame, timer or empty display row', async () => {
    const rows = [
      message('timer', 'assistant', '', {
        blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 2 }],
      }),
      message('frame', 'assistant', 'not final'),
    ];
    readTranscript = (params): TranscriptPage => ({
      ...pageForMessages(rows, params, 10),
      ...(params.view === 'turns'
        ? { turns: [turn('turn', 0, 2, ['timer'])] }
        : {}),
    });
    expect(
      await dispatchProjectReadAction(lastAgentAction, caller),
    ).toMatchObject({ ok: true, result: { message: null } });
  });

  test('terminal disposition is omitted unless an attempt is correlated to the selected turn', async () => {
    const selectedTab = tab(CHAT, {
      inputDelivery: {
        version: 1,
        epoch: 1,
        rows: [
          {
            id: 'delivery',
            revision: 1,
            createdAt: 1,
            state: 'picked-up',
            text: 'private',
            payload: {
              projectId: PROJECT,
              worktreeId: TASK,
              chatId: CHAT,
              userMessageId: 'other-turn',
              text: 'private',
            },
            settingsKey: 'x',
            attempts: [
              {
                id: 'attempt',
                generation: 'g',
                provider: 'claude',
                createdAt: 1,
                rootUserMessageId: 'other-turn',
                turnOutcome: 'failed',
              },
            ],
          },
        ],
      },
    });
    mockRuntime.queryChatStateForLegacyIpc = jest.fn<
      ReturnType<RuntimeDispatcherMock['queryChatStateForLegacyIpc']>,
      Parameters<RuntimeDispatcherMock['queryChatStateForLegacyIpc']>
    >(() =>
      Promise.resolve({
        canonicalResult: {
          workspaceId: PROJECT,
          worktreeId: TASK,
          revision: 1,
          tabs: { activeTabId: CHAT, items: [] },
          archives: [],
          runtimeByChatId: {},
          queue: [],
        },
        legacyResult: snapshot(PROJECT, TASK, [selectedTab]),
      }),
    );
    const rows = [message('final', 'assistant', 'answer')];
    readTranscript = (params): TranscriptPage => ({
      ...pageForMessages(rows, params, 10),
      ...(params.view === 'turns'
        ? { turns: [turn('selected-turn', 0, 1, ['final'])] }
        : {}),
    });
    const response = await dispatchProjectReadAction(lastAgentAction, caller);
    expect(response).toMatchObject({
      ok: true,
      result: { message: { messageId: 'final' } },
    });
    expect(successfulResult(response)).not.toHaveProperty(
      'terminalDisposition',
    );
    expect(JSON.stringify(response)).not.toContain('private');
  });

  test('terminal failure, cancellation and interruption values are passed through without inference', async () => {
    for (const outcome of ['failed', 'cancelled', 'interrupted'] as const) {
      const selectedTab = tab(CHAT, {
        inputDelivery: {
          version: 1,
          epoch: 1,
          rows: [
            {
              id: `delivery-${outcome}`,
              revision: 1,
              createdAt: 1,
              state: 'picked-up',
              text: 'x',
              payload: {
                projectId: PROJECT,
                worktreeId: TASK,
                chatId: CHAT,
                userMessageId: 'turn',
                text: 'x',
              },
              settingsKey: 'x',
              attempts: [
                {
                  id: `attempt-${outcome}`,
                  generation: 'g',
                  provider: 'codex',
                  createdAt: 1,
                  rootUserMessageId: 'turn',
                  turnOutcome: outcome,
                },
              ],
            },
          ],
        },
      });
      mockRuntime.queryChatStateForLegacyIpc = jest.fn<
        ReturnType<RuntimeDispatcherMock['queryChatStateForLegacyIpc']>,
        Parameters<RuntimeDispatcherMock['queryChatStateForLegacyIpc']>
      >(() =>
        Promise.resolve({
          canonicalResult: {
            workspaceId: PROJECT,
            worktreeId: TASK,
            revision: 1,
            tabs: { activeTabId: CHAT, items: [] },
            archives: [],
            runtimeByChatId: {},
            queue: [],
          },
          legacyResult: snapshot(PROJECT, TASK, [selectedTab]),
        }),
      );
      const rows = [message('final', 'assistant', 'answer')];
      readTranscript = (params): TranscriptPage => ({
        ...pageForMessages(rows, params, 10),
        ...(params.view === 'turns'
          ? { turns: [turn('turn', 0, 1, ['final'])] }
          : {}),
      });
      expect(
        await dispatchProjectReadAction(lastAgentAction, caller),
      ).toMatchObject({ ok: true, result: { terminalDisposition: outcome } });
    }
  });

  test('one-page history with unvisited raw rows has partial, not exact, counts', async () => {
    useMessages(
      [message('old', 'user', 'old'), message('new', 'assistant', 'new')],
      2,
    );
    const response = await dispatchProjectReadAction(
      historyAction({ pageSize: 1 }),
      caller,
    );
    expect(response).toMatchObject({
      ok: true,
      result: {
        items: [{ messageId: 'new' }],
        countsExact: false,
        totalMessages: null,
        totalMatches: null,
      },
    });
    expect(nextCursor(response)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('full scan reports role-independent visible counts and filtered match counts', async () => {
    useMessages(
      [
        message('hidden', 'user', 'secret', { hidden: true }),
        message('u', 'user', 'needle user'),
        message('a', 'assistant', 'needle assistant'),
        message('system', 'system', 'needle system'),
      ],
      2,
    );
    const response = await dispatchProjectReadAction(
      historyAction({ query: 'needle', roles: ['assistant'], pageSize: 10 }),
      caller,
    );
    expect(response).toMatchObject({
      ok: true,
      result: {
        items: [{ messageId: 'a' }],
        totalMessages: 2,
        totalMatches: 1,
        countsExact: true,
      },
    });
  });

  test('parses a query of at most 500 characters and rejects longer filters', async () => {
    useMessages([message('a', 'assistant', 'match')]);
    expect(
      await dispatchProjectReadAction(
        historyAction({ query: 'q'.repeat(500) }),
        caller,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await dispatchProjectReadAction(
        historyAction({ query: 'q'.repeat(501) }),
        caller,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });
  });

  test('normalizes case, whitespace and role set order for cursor bindings', async () => {
    useMessages([
      message('u1', 'user', 'Needle'),
      message('a1', 'assistant', 'needle'),
      message('u2', 'user', 'needle'),
    ]);
    const first = await dispatchProjectReadAction(
      historyAction({
        query: ' needle ',
        roles: ['assistant', 'user'],
        pageSize: 1,
      }),
      caller,
    );
    const cursor = nextCursor(first);
    const replay = await dispatchProjectReadAction(
      historyAction({
        query: 'NEEDLE',
        roles: ['user', 'assistant'],
        pageSize: 1,
        cursor,
      }),
      caller,
    );
    expect(replay).toMatchObject({ ok: true, result: { returned: 1 } });
  });

  test('rejects a history cursor when its search filter changes', async () => {
    useMessages([
      message('u1', 'user', 'one'),
      message('a1', 'assistant', 'two'),
      message('u2', 'user', 'three'),
    ]);
    const first = await dispatchProjectReadAction(
      historyAction({ pageSize: 1 }),
      caller,
    );
    const cursor = nextCursor(first);
    expect(
      await dispatchProjectReadAction(
        historyAction({ query: 'different', pageSize: 1, cursor }),
        caller,
      ),
    ).toMatchObject({ ok: false, error: { code: 'cursor_context_changed' } });
  });

  test('cursor replay returns the same continuation page while issuing a fresh next handle', async () => {
    useMessages([
      message('m1', 'user', 'one'),
      message('m2', 'assistant', 'two'),
      message('m3', 'user', 'three'),
      message('m4', 'assistant', 'four'),
      message('m5', 'user', 'five'),
      message('m6', 'assistant', 'six'),
    ]);
    const initial = await dispatchProjectReadAction(
      historyAction({ pageSize: 2 }),
      caller,
    );
    const firstCursor = nextCursor(initial);
    const replayOne = await dispatchProjectReadAction(
      historyAction({ pageSize: 2, cursor: firstCursor }),
      caller,
    );
    const replayTwo = await dispatchProjectReadAction(
      historyAction({ pageSize: 2, cursor: firstCursor }),
      caller,
    );
    expect(replayOne).toMatchObject({
      ok: true,
      result: { items: [{ messageId: 'm4' }, { messageId: 'm3' }] },
    });
    expect(replayTwo).toMatchObject({
      ok: true,
      result: { items: [{ messageId: 'm4' }, { messageId: 'm3' }] },
    });
    expect(nextCursor(replayOne)).not.toBe(firstCursor);
    expect(nextCursor(replayTwo)).not.toBe(nextCursor(replayOne));
  });

  test('rejects unknown and expired cursor handles as cursor_expired', async () => {
    expect(
      await dispatchProjectReadAction(
        historyAction({ cursor: 'unknown-handle' }),
        caller,
      ),
    ).toMatchObject({ ok: false, error: { code: 'cursor_expired' } });
    useMessages([
      message('a', 'assistant', 'answer'),
      message('u', 'user', 'question'),
    ]);
    const first = await dispatchProjectReadAction(
      historyAction({ pageSize: 1 }),
      caller,
    );
    const cursor = nextCursor(first);
    jest.useFakeTimers();
    try {
      jest.advanceTimersByTime(16 * 60 * 1000);
      expect(
        await dispatchProjectReadAction(
          historyAction({ cursor, pageSize: 1 }),
          caller,
        ),
      ).toMatchObject({ ok: false, error: { code: 'cursor_expired' } });
    } finally {
      jest.useRealTimers();
    }
  });

  test('rejects cursor continuation after account, owner or project identity changes', async () => {
    useMessages([
      message('m1', 'user', 'one'),
      message('m2', 'assistant', 'two'),
      message('m3', 'user', 'three'),
    ]);
    const first = await dispatchProjectReadAction(
      historyAction({ pageSize: 1 }),
      caller,
    );
    const cursor = nextCursor(first);
    accountEpoch += 1;
    expect(
      await dispatchProjectReadAction(
        historyAction({ cursor, pageSize: 1 }),
        caller,
      ),
    ).toMatchObject({ ok: false, error: { code: 'cursor_context_changed' } });

    accountEpoch = 1;
    const second = await dispatchProjectReadAction(
      historyAction({ pageSize: 1 }),
      caller,
    );
    const secondCursor = nextCursor(second);
    jest
      .mocked(getCallerOwner)
      .mockResolvedValue({ kind: 'organization', organizationId: 'org-a' });
    expect(
      await dispatchProjectReadAction(
        historyAction({ cursor: secondCursor, pageSize: 1 }),
        caller,
      ),
    ).toMatchObject({ ok: false, error: { code: 'cursor_context_changed' } });
  });

  test('rejects a cursor pinned to a transcript revision that has changed', async () => {
    useMessages([
      message('m1', 'user', 'one'),
      message('m2', 'assistant', 'two'),
      message('m3', 'user', 'three'),
    ]);
    const first = await dispatchProjectReadAction(
      historyAction({ pageSize: 1 }),
      caller,
    );
    const cursor = nextCursor(first);
    readTranscript = (params): TranscriptPage =>
      pageForMessages(
        [
          message('m1', 'user', 'one'),
          message('m2', 'assistant', 'two'),
          message('m3', 'user', 'three'),
        ],
        params,
        2,
        2,
      );
    expect(
      await dispatchProjectReadAction(
        historyAction({ cursor, pageSize: 1 }),
        caller,
      ),
    ).toMatchObject({ ok: false, error: { code: 'cursor_context_changed' } });
  });

  test('distinguishes stable read failure from revision change during page fetch', async () => {
    mockRuntime.queryChatTranscriptPageForLegacyIpc = jest.fn<
      ReturnType<RuntimeDispatcherMock['queryChatTranscriptPageForLegacyIpc']>,
      Parameters<RuntimeDispatcherMock['queryChatTranscriptPageForLegacyIpc']>
    >(() => Promise.reject(new Error('dispatcher unavailable')));
    expect(
      await dispatchProjectReadAction(lastUserAction, caller),
    ).toMatchObject({ ok: false, error: { code: 'execution_failed' } });
    let calls = 0;
    mockRuntime.queryChatTranscriptPageForLegacyIpc = jest.fn<
      ReturnType<RuntimeDispatcherMock['queryChatTranscriptPageForLegacyIpc']>,
      Parameters<RuntimeDispatcherMock['queryChatTranscriptPageForLegacyIpc']>
    >((params) => {
      calls += 1;
      const revision = calls === 1 ? 1 : 2;
      const page: TranscriptPage = {
        messages: [],
        totalMessages: 0,
        transcriptRevision: revision,
        ...(params.view === 'turns' ? { view: 'turns', turns: [] } : {}),
      };
      return Promise.resolve({
        canonicalResult: {
          messages: [],
          totalMessages: 0,
          transcriptRevision: revision,
          ...(params.view === 'turns'
            ? { view: 'turns' as const, turns: [] }
            : {}),
        },
        legacyResult: page,
      });
    });
    expect(
      await dispatchProjectReadAction(lastUserAction, caller),
    ).toMatchObject({ ok: false, error: { code: 'cursor_context_changed' } });
  });

  test('descending raw history stops at pageSize while counting only pages visited', async () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      message(`m${index}`, index % 2 ? 'assistant' : 'user', `row ${index}`),
    );
    useMessages(rows, 2);
    const response = await dispatchProjectReadAction(
      historyAction({ pageSize: 1 }),
      caller,
    );
    expect(response).toMatchObject({
      ok: true,
      result: { items: [{ messageId: 'm11' }], countsExact: false },
    });
    expect(
      mockRuntime.queryChatTranscriptPageForLegacyIpc.mock.calls.filter(
        ([params]) => params.view === undefined,
      ),
    ).toHaveLength(1);
  });

  test('last-user raw scanning is bounded to twenty pages', async () => {
    const rows = Array.from({ length: 41 }, (_, index) =>
      message(`m${index}`, 'assistant', `row ${index}`),
    );
    useMessages(rows, 2);
    expect(
      await dispatchProjectReadAction(lastUserAction, caller),
    ).toMatchObject({ ok: false, error: { code: 'scan_budget_exceeded' } });
    expect(
      mockRuntime.queryChatTranscriptPageForLegacyIpc.mock.calls.filter(
        ([params]) => params.view === undefined,
      ),
    ).toHaveLength(20);
  });

  test('ascending scan returns scan_budget_exceeded rather than partial totals after twenty raw pages', async () => {
    const rows = Array.from({ length: 41 }, (_, index) =>
      message(`m${index}`, 'user', `row ${index}`),
    );
    useMessages(rows, 2);
    expect(
      await dispatchProjectReadAction(
        historyAction({ order: 'asc', pageSize: 1 }),
        caller,
      ),
    ).toMatchObject({ ok: false, error: { code: 'scan_budget_exceeded' } });
    expect(
      mockRuntime.queryChatTranscriptPageForLegacyIpc.mock.calls.filter(
        ([params]) => params.view === undefined,
      ),
    ).toHaveLength(20);
  });

  test('agent response scans sparse windows of one hundred turn summaries without raw-row coverage checks', async () => {
    const totalTurns = 2_100;
    const totalRows = totalTurns * 500;
    const candidateOrdinal = 1_999 * 500;
    const final = message(
      'sparse-final',
      'assistant',
      'found after sparse turn pages',
    );
    let pinnedTurnPages = 0;
    readTranscript = (params): TranscriptPage => {
      if (params.view !== 'turns')
        return {
          messages: [],
          totalMessages: totalRows,
          transcriptRevision: 1,
        };
      if (params.transcriptRevision !== undefined) pinnedTurnPages += 1;
      const upper = params.before ?? totalRows;
      const firstTurn = Math.max(0, Math.floor((upper - 1) / 500) - 99);
      const turnRows = Array.from(
        { length: Math.min(100, Math.floor(upper / 500) - firstTurn) },
        (_, offset) => {
          const index = firstTurn + offset;
          return turn(
            `turn-${index}`,
            index * 500,
            (index + 1) * 500,
            index === 1_999 ? [final.id] : [],
          );
        },
      );
      const start = turnRows[0]?.start ?? 0;
      const pageMessages =
        candidateOrdinal >= start && candidateOrdinal < upper ? [final] : [];
      const result: TranscriptPage = {
        messages: pageMessages,
        totalMessages: totalRows,
        transcriptRevision: 1,
        view: 'turns',
        turns: turnRows,
        ...(start > 0 ? { before: start } : {}),
        ...(pageMessages.length > 0
          ? { messageOrdinals: { [final.id]: candidateOrdinal } }
          : {}),
      };
      return result;
    };
    const response = await dispatchProjectReadAction(lastAgentAction, caller);
    expect(response).toMatchObject({
      ok: true,
      result: { message: { messageId: 'sparse-final', turnId: 'turn-1999' } },
    });
    expect(pinnedTurnPages).toBe(1);
    expect(
      mockRuntime.queryChatTranscriptPageForLegacyIpc.mock.calls.filter(
        ([params]) => params.view === undefined,
      ),
    ).toHaveLength(0);
  });

  test('uses exactly contiguous raw ordinal windows for history pagination', async () => {
    const rows = [
      message('m0', 'user', '0'),
      message('m1', 'assistant', '1'),
      message('m2', 'user', '2'),
      message('m3', 'assistant', '3'),
      message('m4', 'user', '4'),
    ];
    useMessages(rows, 2);
    const response = await dispatchProjectReadAction(
      historyAction({ pageSize: 2 }),
      caller,
    );
    expect(response).toMatchObject({ ok: true });
    const rawCalls =
      mockRuntime.queryChatTranscriptPageForLegacyIpc.mock.calls.filter(
        ([params]) => params.view === undefined,
      );
    expect(rawCalls.map(([params]) => params.before)).toEqual([undefined]);
    const rawPage = readTranscript({
      scope: { workspaceId: PROJECT, worktreeId: TASK, chatId: CHAT },
    });
    expect(rawPage.messages).toHaveLength(
      rawPage.totalMessages - (rawPage.before ?? 0),
    );
  });

  test('desc history that fills on the oldest row after several raw pages has no cursor', async () => {
    useMessages(
      [
        message('m0', 'user', '0'),
        message('m1', 'assistant', '1'),
        message('m2', 'user', '2'),
        message('m3', 'assistant', '3'),
      ],
      2,
    );
    const result = successfulResult(
      await dispatchProjectReadAction(historyAction({ pageSize: 4 }), caller),
    );
    expect(result).toMatchObject({
      returned: 4,
      countsExact: true,
      nextCursor: null,
    });
  });

  test('keeps canonical turn ids when one raw page spans more turns than a turn-view window', async () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      message(`m${index}`, index % 2 === 0 ? 'user' : 'assistant', `${index}`),
    );
    const turns = Array.from({ length: 6 }, (_, index) =>
      turn(`turn-${index * 2}`, index * 2, index * 2 + 2, [
        `m${index * 2 + 1}`,
      ]),
    );
    readTranscript = (params): TranscriptPage => {
      if (params.view !== 'turns') return pageForMessages(rows, params, 12);
      // Like the store's 100-turn cap: only the newest turns before the cursor.
      const end = params.before ?? rows.length;
      const selected = turns.filter((item) => item.start < end).slice(-2);
      const start = selected[0]?.start ?? 0;
      return {
        messages: rows.slice(start, end),
        view: 'turns',
        turns: selected,
        totalMessages: rows.length,
        transcriptRevision: 1,
        ...(start > 0 ? { before: start } : {}),
      };
    };
    const expected = rows.map((row, index) => ({
      messageId: row.id,
      turnId: `turn-${index - (index % 2)}`,
    }));
    for (const order of ['desc', 'asc'] as const) {
      const result = successfulResult(
        await dispatchProjectReadAction(
          historyAction({ pageSize: 12, order }),
          caller,
        ),
      );
      expect(result.items).toMatchObject(
        order === 'desc' ? [...expected].reverse() : expected,
      );
    }
  });
});

function nextCursor(
  response: Awaited<ReturnType<typeof dispatchProjectReadAction>>,
): string {
  const result = successfulResult(response);
  const cursor = result.nextCursor;
  if (typeof cursor !== 'string')
    throw new Error('Expected a continuation cursor');
  return cursor;
}

describe('project read integration adversarial cases', () => {
  test('descending budget exhaustion returns an empty resumable page, not no match', async () => {
    const rows = [
      message('old-match', 'user', 'needle'),
      ...Array.from({ length: 40 }, (_, index) =>
        message(`noise-${index}`, 'assistant', 'noise'),
      ),
    ];
    useMessages(rows, 2);
    const first = await dispatchProjectReadAction(
      historyAction({ query: 'needle', pageSize: 10 }),
      caller,
    );
    expect(first).toMatchObject({
      ok: true,
      result: {
        items: [],
        returned: 0,
        countsExact: false,
        totalMessages: null,
        totalMatches: null,
      },
    });
    const cursor = nextCursor(first);
    expect(
      jest
        .mocked(mockRuntime.queryChatTranscriptPageForLegacyIpc)
        .mock.calls.filter(([params]) => params.view === undefined),
    ).toHaveLength(20);
    const second = await dispatchProjectReadAction(
      historyAction({ query: 'needle', cursor, pageSize: 10 }),
      caller,
    );
    expect(second).toMatchObject({
      ok: true,
      result: {
        items: [{ messageId: 'old-match' }],
        nextCursor: null,
        countsExact: false,
        totalMessages: null,
      },
    });
  });

  test('ascending continuation uses its raw in-page locator and keeps full-scan counts', async () => {
    useMessages(
      Array.from({ length: 7 }, (_, index) =>
        message(`m-${index}`, 'user', String(index)),
      ),
      3,
    );
    const first = await dispatchProjectReadAction(
      historyAction({ order: 'asc', pageSize: 2 }),
      caller,
    );
    const second = await dispatchProjectReadAction(
      historyAction({ order: 'asc', pageSize: 3, cursor: nextCursor(first) }),
      caller,
    );
    expect(second).toMatchObject({
      ok: true,
      result: {
        items: [
          { messageId: 'm-2' },
          { messageId: 'm-3' },
          { messageId: 'm-4' },
        ],
        totalMessages: 7,
        totalMatches: 7,
        countsExact: true,
      },
    });
    const third = await dispatchProjectReadAction(
      historyAction({ order: 'asc', pageSize: 3, cursor: nextCursor(second) }),
      caller,
    );
    expect(third).toMatchObject({
      ok: true,
      result: {
        items: [{ messageId: 'm-5' }, { messageId: 'm-6' }],
        nextCursor: null,
        countsExact: true,
      },
    });
  });

  test.each([1, 2])(
    'pinned page failure probes fresh revision %i to classify it',
    async (latestRevision) => {
      const rows = Array.from({ length: 4 }, (_, index) =>
        message(`m-${index}`, 'user', 'match'),
      );
      let failed = false;
      readTranscript = (params): TranscriptPage => {
        if (params.view === undefined && params.before !== undefined) {
          expect(params.transcriptRevision).toBe(1);
          failed = true;
          throw new Error('opaque pinned read failure');
        }
        return pageForMessages(rows, params, 2, failed ? latestRevision : 1);
      };
      expect(
        await dispatchProjectReadAction(
          historyAction({ pageSize: 10 }),
          caller,
        ),
      ).toMatchObject({
        ok: false,
        error: {
          code:
            latestRevision === 1
              ? 'execution_failed'
              : 'cursor_context_changed',
        },
      });
      expect(failed).toBe(true);
    },
  );

  test('a failed fresh revision probe fails closed rather than publishing a partial page', async () => {
    const rows = Array.from({ length: 4 }, (_, index) =>
      message(`m-${index}`, 'user', 'match'),
    );
    let failure = false;
    readTranscript = (params): TranscriptPage => {
      if (
        failure ||
        (params.view === undefined && params.before !== undefined)
      ) {
        failure = true;
        throw new Error('unreadable');
      }
      return pageForMessages(rows, params, 2);
    };
    expect(
      await dispatchProjectReadAction(historyAction({ pageSize: 10 }), caller),
    ).toMatchObject({ ok: false, error: { code: 'execution_failed' } });
  });

  test('rechecks owner after the final asynchronous transcript probe', async () => {
    const rows = [
      message('visible', 'user', 'do not publish after owner switch'),
    ];
    readTranscript = (params): TranscriptPage => {
      if (params.view === 'turns' && params.transcriptRevision === undefined) {
        jest.mocked(getCallerOwner).mockResolvedValue({
          kind: 'organization',
          organizationId: 'new-owner',
        });
      }
      return pageForMessages(rows, params, 2);
    };
    expect(
      await dispatchProjectReadAction(historyAction({ pageSize: 10 }), caller),
    ).toMatchObject({ ok: false, error: { code: 'cursor_context_changed' } });
  });

  test('drains queued account changes and invalidates an initial read', async () => {
    const rows = [message('visible', 'user', 'private old account')];
    readTranscript = (params): TranscriptPage => {
      if (params.view === undefined) accountEpoch += 1;
      return pageForMessages(rows, params, 2);
    };
    expect(
      await dispatchProjectReadAction(historyAction({ pageSize: 10 }), caller),
    ).toMatchObject({ ok: false, error: { code: 'cursor_context_changed' } });
    expect(mockContext.initialize).toHaveBeenCalled();
    expect(mockContext.whenIdle).toHaveBeenCalled();
  });

  test('owner revocation on a continuation maps not_found to context changed', async () => {
    useMessages([
      message('old', 'user', 'old'),
      message('new', 'assistant', 'new'),
    ]);
    const first = await dispatchProjectReadAction(
      historyAction({ pageSize: 1 }),
      caller,
    );
    const cursor = nextCursor(first);
    jest
      .mocked(requireAuthorizedProject)
      .mockRejectedValue(
        new DiscoveryError('not_found', 'Project was not found.'),
      );
    expect(
      await dispatchProjectReadAction(
        historyAction({ pageSize: 1, cursor }),
        caller,
      ),
    ).toMatchObject({ ok: false, error: { code: 'cursor_context_changed' } });
  });

  test('cross-owner and unknown targets are indistinguishable and never read a transcript', async () => {
    for (const target of ['cross-owner', 'unknown']) {
      jest
        .mocked(requireAuthorizedProject)
        .mockRejectedValue(
          new DiscoveryError('not_found', 'Project was not found.'),
        );
      expect(
        await dispatchProjectReadAction(
          { ...lastUserAction, projectId: target },
          caller,
        ),
      ).toEqual({
        ok: false,
        error: { code: 'not_found', message: 'Project was not found.' },
      });
    }
    expect(
      mockRuntime.queryChatTranscriptPageForLegacyIpc,
    ).not.toHaveBeenCalled();
  });

  test('blocked secret text cannot match a query or enter a visible DTO', async () => {
    useMessages(
      [
        message('mixed', 'assistant', 'public', {
          blocks: [
            { type: 'text', text: 'public' },
            { type: 'thinking', text: 'secret-token' },
            {
              type: 'tool_use',
              toolUseId: 'call',
              toolName: 'Read',
              input: 'secret-token',
            },
            {
              type: 'tool_result',
              toolUseId: 'call',
              toolName: 'Read',
              output: 'secret-token',
              isError: false,
            },
          ],
        }),
        message('tool-only', 'assistant', '', {
          blocks: [{ type: 'thinking', text: 'secret-token' }],
        }),
      ],
      2,
    );
    const search = await dispatchProjectReadAction(
      historyAction({ query: 'secret-token', pageSize: 10 }),
      caller,
    );
    expect(search).toMatchObject({
      ok: true,
      result: {
        items: [],
        totalMessages: 1,
        totalMatches: 0,
        countsExact: true,
      },
    });
    const all = await dispatchProjectReadAction(
      historyAction({ pageSize: 10 }),
      caller,
    );
    expect(all).toMatchObject({
      ok: true,
      result: { items: [{ messageId: 'mixed', text: 'public' }] },
    });
    expect(JSON.stringify(all)).not.toContain('secret-token');
  });

  test('truncates to 8000 characters and outputs only the visible field allowlist', async () => {
    useMessages([message('long', 'user', 'x'.repeat(8001))]);
    const response = await dispatchProjectReadAction(
      historyAction({ pageSize: 10 }),
      caller,
    );
    const items = successfulResult(response).items;
    if (!Array.isArray(items)) throw new Error('Expected items');
    const item: unknown = items[0];
    if (
      typeof item !== 'object' ||
      item === null ||
      !('text' in item) ||
      typeof item.text !== 'string'
    )
      throw new Error('Expected visible message');
    expect(item.text).toHaveLength(8000);
    expect(item.text).toContain('[truncated 1 chars]');
    expect(Object.keys(item).sort()).toEqual([
      'messageId',
      'role',
      'text',
      'timestamp',
      'truncated',
      'turnId',
    ]);
  });

  test('last user is null at exactly twenty exhausted pages, not a budget error', async () => {
    useMessages(
      Array.from({ length: 40 }, (_, index) =>
        message(`a-${index}`, 'assistant', 'answer'),
      ),
      2,
    );
    expect(
      await dispatchProjectReadAction(lastUserAction, caller),
    ).toMatchObject({ ok: true, result: { message: null } });
    expect(
      jest
        .mocked(mockRuntime.queryChatTranscriptPageForLegacyIpc)
        .mock.calls.filter(([params]) => params.view === undefined),
    ).toHaveLength(20);
  });

  test('agent scan budget is exhausted only after twenty canonical turn windows', async () => {
    const total = 21;
    let selectionReads = 0;
    readTranscript = (params): TranscriptPage => {
      const end = params.before ?? total;
      const start = Math.max(0, end - 1);
      if (params.before !== undefined || selectionReads === 0)
        selectionReads += 1;
      return {
        messages: [],
        totalMessages: total,
        transcriptRevision: 1,
        view: 'turns',
        turns: [turn(`t-${start}`, start, end, [], false)],
        ...(start > 0 ? { before: start } : {}),
      };
    };
    expect(
      await dispatchProjectReadAction(lastAgentAction, caller),
    ).toMatchObject({ ok: false, error: { code: 'scan_budget_exceeded' } });
    expect(selectionReads).toBe(20);
  });

  test('final ID list order does not override the canonical row chronology', async () => {
    const rows = [
      message('older-final', 'assistant', 'old'),
      message('newer-final', 'assistant', 'new'),
    ];
    readTranscript = (params): TranscriptPage => ({
      ...pageForMessages(rows, params, 10),
      ...(params.view === 'turns'
        ? {
            turns: [
              turn('canonical-turn', 0, 2, ['newer-final', 'older-final']),
            ],
          }
        : {}),
    });
    expect(
      await dispatchProjectReadAction(lastAgentAction, caller),
    ).toMatchObject({
      ok: true,
      result: {
        message: { messageId: 'newer-final', turnId: 'canonical-turn' },
      },
    });
  });

  test('newer tool-only completed final does not hide an older visible final', async () => {
    const rows = [
      message('visible-final', 'assistant', 'answer'),
      message('tool-final', 'assistant', '', {
        blocks: [{ type: 'thinking', text: 'not public' }],
      }),
    ];
    readTranscript = (params): TranscriptPage => ({
      ...pageForMessages(rows, params, 10),
      ...(params.view === 'turns'
        ? {
            turns: [
              turn('old-turn', 0, 1, ['visible-final']),
              turn('tool-turn', 1, 2, ['tool-final']),
            ],
          }
        : {}),
    });
    expect(
      await dispatchProjectReadAction(lastAgentAction, caller),
    ).toMatchObject({
      ok: true,
      result: { message: { messageId: 'visible-final' } },
    });
  });

  test('non-advancing and incomplete raw pages are execution failures, not empty successes', async () => {
    readTranscript = (): TranscriptPage => ({
      messages: [],
      totalMessages: 10,
      before: 10,
      transcriptRevision: 1,
    });
    expect(
      await dispatchProjectReadAction(historyAction(), caller),
    ).toMatchObject({ ok: false, error: { code: 'execution_failed' } });
    readTranscript = (): TranscriptPage => ({
      messages: [],
      totalMessages: 10,
      transcriptRevision: 1,
    });
    expect(
      await dispatchProjectReadAction(historyAction(), caller),
    ).toMatchObject({ ok: false, error: { code: 'execution_failed' } });
  });

  test('locator store enforces LRU capacity, expiry and copy isolation', () => {
    const store = new ReadCursorStore();
    const first = store.put('binding', 1, { before: 20, offset: 2 });
    const second = store.put('binding', 1, { before: 18, offset: 0 });
    for (let index = 0; index < 126; index += 1)
      store.put('binding', 1, { before: index, offset: 0 });
    const copy = store.get(first, 'binding');
    copy.locator.offset = 999;
    expect(store.get(first, 'binding').locator.offset).toBe(2);
    store.put('binding', 1, { offset: 0 });
    expect(() => store.get(second)).toThrow('expired');
    expect(store.get(first, 'binding').transcriptRevision).toBe(1);
    expect(() => store.get(first, 'other-binding')).toThrow('context changed');
    const now = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + READ_CURSOR_TTL_MS);
    try {
      expect(() => store.get(first)).toThrow('expired');
    } finally {
      now.mockRestore();
    }
  });
});

describe('project read target and session projection', () => {
  test('a missing chat in an existing parent is unknown without cross-task repair', async () => {
    expect(
      await dispatchProjectReadAction(
        { ...lastUserAction, chatId: 'other-task-chat' },
        caller,
      ),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(
      mockRuntime.queryChatTranscriptPageForLegacyIpc,
    ).not.toHaveBeenCalled();
  });

  test('returns only the public session summary, never undelivered text or paths', async () => {
    const secret = 'private-undelivered-token';
    mockRuntime.queryChatStateForLegacyIpc.mockResolvedValue({
      canonicalResult: {},
      legacyResult: snapshot(PROJECT, TASK, [
        tab(CHAT, {
          staleSessionDetected: {
            droppedMessageText: secret,
            droppedInputMode: 'voice',
            droppedFileReferences: [
              {
                absolutePath: '/private/session-secret/file.txt',
                displayPath: 'file.txt',
              },
            ],
          },
        }),
      ]),
    });
    useMessages([message('last-user', 'user', 'visible')]);
    const response = await dispatchProjectReadAction(lastUserAction, caller);
    expect(response).toMatchObject({
      ok: true,
      result: {
        session: {
          state: 'expired',
          expired: true,
          readOnly: true,
          canHandOff: true,
          undeliveredMessagePresent: true,
          undeliveredMessageLength: secret.length,
          undeliveredFileReferenceCount: 1,
          undeliveredInputMode: 'voice',
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(response)).not.toContain('/private/session-secret');
  });

  test('queries match file basenames and literal punctuation, not private path prefixes', async () => {
    useMessages([
      message('file', 'user', '', {
        blocks: [
          {
            type: 'file_references',
            references: [
              {
                absolutePath: '/private/directory/report.*.md',
                displayPath: 'report.*.md',
              },
            ],
          },
        ],
      }),
    ]);
    expect(
      await dispatchProjectReadAction(
        historyAction({ query: 'REPORT.*', pageSize: 10 }),
        caller,
      ),
    ).toMatchObject({
      ok: true,
      result: { items: [{ messageId: 'file' }], totalMatches: 1 },
    });
    expect(
      await dispatchProjectReadAction(
        historyAction({ query: '/private/directory', pageSize: 10 }),
        caller,
      ),
    ).toMatchObject({ ok: true, result: { items: [], totalMatches: 0 } });
  });

  test('recreated task and changed chat identity invalidate continuation handles', async () => {
    useMessages([
      message('one', 'user', 'one'),
      message('two', 'assistant', 'two'),
    ]);
    const cursor = nextCursor(
      await dispatchProjectReadAction(historyAction({ pageSize: 1 }), caller),
    );
    mockRuntime.queryWorktreeListForLegacyIpc.mockResolvedValue({
      canonicalResult: { items: [], nextCursor: null },
      legacyResult: [worktree(TASK, { createdAt: '2026-10-14T00:00:00.000Z' })],
      legacyAuthority: { authority: 'ok' },
    });
    expect(
      await dispatchProjectReadAction(
        historyAction({ pageSize: 1, cursor }),
        caller,
      ),
    ).toMatchObject({ ok: false, error: { code: 'cursor_context_changed' } });
    mockRuntime.queryWorktreeListForLegacyIpc.mockResolvedValue({
      canonicalResult: { items: [], nextCursor: null },
      legacyResult: [worktree(TASK)],
      legacyAuthority: { authority: 'ok' },
    });
    mockRuntime.queryChatStateForLegacyIpc.mockResolvedValue({
      canonicalResult: {},
      legacyResult: snapshot(PROJECT, TASK, [
        tab(CHAT, { customTitle: 'Changed title' }),
      ]),
    });
    expect(
      await dispatchProjectReadAction(
        historyAction({ pageSize: 1, cursor }),
        caller,
      ),
    ).toMatchObject({ ok: false, error: { code: 'cursor_context_changed' } });
  });
});
