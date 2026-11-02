import type {
  ChatQueueUpdatedEvent,
  ChatRuntimeState,
  ChatStateSnapshot,
  CoworkWorkEntriesFile,
  CoworkWorkEntryData,
  PersistedChatTab,
  ProjectOwnerContext,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  COWORK_HOME_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import {
  parseBotAction,
  type BotAction,
} from '@canopy/desktop-shared/lib/bot-discovery';
import type { PersistedChatMessage } from '@canopy/agent-transcript';
import type {
  TranscriptPage,
  TranscriptTurnSummary,
} from '@canopy/agent-transcript/transcript-storage';
import type { CoreChatTranscriptPageParams } from '@canopy/protocol/canopy-core';
import {
  resetAppAdvisorProjectAgentAccessForTests,
  setAppAdvisorProjectAgentAccess,
} from '../lib/app-advisor-project-agent-access';
import {
  resolveProjectSavedOwner,
  type ResolvedProjectOwner,
} from '../lib/project-owner';
import { readWorkEntriesFileStrict } from '../lib/cowork-work-entries';
import {
  dispatchBotAction,
  isBotAccessAllowed,
} from '../project-discovery/bots';
import type { ProjectDiscoveryCaller } from '../project-discovery';
import { requireBotAccess } from '../project-discovery/bots/target';

jest.mock('../lib/project-owner');
jest.mock('../lib/cowork-work-entries');
jest.mock('../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): RuntimeDispatcherMock => mockRuntime,
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): ContextServiceMock => mockContext,
}));

const BOT_ID = 'app_advisor';
const TASK_ONE = 'task-one';
const TASK_TWO = 'task-two';
const CHAT_ONE = 'chat-one';
const CHAT_TWO = 'chat-two';
const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PERSONAL_OWNER: ProjectOwnerContext = { kind: 'personal' };
const ORGANIZATION_A: ProjectOwnerContext = {
  kind: 'organization',
  organizationId: ORG_A,
};

const projectCaller = {
  kind: 'project_agent',
  projectId: 'caller-project',
  worktreeId: 'caller-task',
  chatId: 'caller-chat',
} satisfies ProjectDiscoveryCaller;
const otherProjectCaller = {
  kind: 'project_agent',
  projectId: 'other-caller-project',
  worktreeId: 'other-caller-task',
  chatId: 'other-caller-chat',
} satisfies ProjectDiscoveryCaller;
const advisorCaller = {
  kind: 'app_advisor',
  chatId: 'advisor-chat',
} satisfies ProjectDiscoveryCaller;

type WorktreeRequest = { scope: { workspaceId: string } };
type SnapshotRequest = {
  scope: { workspaceId: string; worktreeId: string };
};
type DispatcherOptions = {
  caller: {
    principalId: string;
    clientInstanceId: string;
    authorityId: string;
    interfaceKind: 'mcp';
    grants: string[];
  };
};
type TranscriptRequest = CoreChatTranscriptPageParams;
type TranscriptResult = {
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
    Promise<TranscriptResult>,
    [TranscriptRequest, DispatcherOptions]
  >;
};
type ContextServiceMock = {
  initialize: jest.Mock<Promise<void>, []>;
  whenIdle: jest.Mock<Promise<void>, []>;
  accountEpoch: () => number;
  getState: () => {
    organizations: Array<{ id: string; name: string; role: string }>;
  };
};

let mockRuntime: RuntimeDispatcherMock;
let mockContext: ContextServiceMock;
let accountEpoch = 1;
let organizations: Array<{ id: string; name: string; role: string }> = [];
let snapshotsForTask: (taskId: string) => ChatStateSnapshot;
let transcriptFor: (params: CoreChatTranscriptPageParams) => TranscriptPage;
let savedOwners: Map<string, ResolvedProjectOwner>;

function parseAction(value: unknown): BotAction {
  const parsed = parseBotAction(value);
  if (!parsed.ok) throw new Error(`Invalid test bot action: ${parsed.message}`);
  return parsed.action;
}

function dispatch(
  value: unknown,
  caller: ProjectDiscoveryCaller = projectCaller,
): ReturnType<typeof dispatchBotAction> {
  return dispatchBotAction(parseAction(value), caller);
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

function setWorkEntries(entries: CoworkWorkEntryData[]): void {
  jest.mocked(readWorkEntriesFileStrict).mockResolvedValue({
    version: 1,
    entries,
  } satisfies CoworkWorkEntriesFile);
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
  worktreeId: string,
  tabs: PersistedChatTab[] = [],
  runtimeByChatId: Record<string, ChatRuntimeState> = {},
  queue: ChatQueueUpdatedEvent[] = [],
  archives: ChatStateSnapshot['archives'] = [],
): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId: APP_ADVISOR_PROJECT_ID,
    worktreeId,
    revision: 1,
    tabsFile: {
      version: 1,
      tabs,
      activeTabId: tabs[0]?.id ?? '',
    },
    archives,
    runtimeByChatId,
    queue,
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

const emptyTurnCounts: TranscriptTurnSummary['summary'] = {
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

function transcriptTurn(
  id: string,
  start: number,
  end: number,
  finalMessageIds: string[],
): TranscriptTurnSummary {
  return {
    id,
    start,
    end,
    complete: true,
    finalMessageIds,
    summary: emptyTurnCounts,
  };
}

function pageForMessages(
  rows: PersistedChatMessage[],
  params: CoreChatTranscriptPageParams,
  revision = 1,
  width = 2,
): TranscriptPage {
  const upper = params.before ?? rows.length;
  const start = Math.max(0, upper - width);
  const pageRows = rows.slice(start, upper);
  return {
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
            transcriptTurn(
              `turn-${start + index}`,
              start + index,
              start + index + 1,
              row.role === 'assistant' ? [row.id] : [],
            ),
          ),
        }
      : {}),
  };
}

function transcriptResult(page: TranscriptPage): TranscriptResult {
  return {
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
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolveDeferred: (value: T) => void = () => {
    throw new Error('Deferred promise was not initialized');
  };
  let rejectDeferred: (reason?: unknown) => void = () => {
    throw new Error('Deferred promise was not initialized');
  };
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

async function waitFor(predicate: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await Promise.resolve();
  }
  return predicate();
}

function createMockRuntime(): RuntimeDispatcherMock {
  return {
    queryWorktreeListForLegacyIpc: jest.fn<
      ReturnType<RuntimeDispatcherMock['queryWorktreeListForLegacyIpc']>,
      Parameters<RuntimeDispatcherMock['queryWorktreeListForLegacyIpc']>
    >(() =>
      Promise.resolve({
        canonicalResult: { items: [], nextCursor: null },
        legacyResult: [],
        legacyAuthority: { authority: 'ok' },
      }),
    ),
    queryChatStateForLegacyIpc: jest.fn<
      ReturnType<RuntimeDispatcherMock['queryChatStateForLegacyIpc']>,
      Parameters<RuntimeDispatcherMock['queryChatStateForLegacyIpc']>
    >(({ scope }) =>
      Promise.resolve({
        canonicalResult: {
          workspaceId: scope.workspaceId,
          worktreeId: scope.worktreeId,
          revision: 1,
          tabs: { activeTabId: '', items: [] },
          archives: [],
          runtimeByChatId: {},
          queue: [],
        },
        legacyResult: snapshotsForTask(scope.worktreeId),
      }),
    ),
    queryChatTranscriptPageForLegacyIpc: jest.fn<
      ReturnType<RuntimeDispatcherMock['queryChatTranscriptPageForLegacyIpc']>,
      Parameters<RuntimeDispatcherMock['queryChatTranscriptPageForLegacyIpc']>
    >((params) => Promise.resolve(transcriptResult(transcriptFor(params)))),
  };
}

function setAccess(
  mode: 'enabled' | 'selected-owners' | 'disabled',
  selectedOwners: ProjectOwnerContext[] = [],
): void {
  setAppAdvisorProjectAgentAccess({ mode, selectedOwners });
}

function setMemberships(...organizationIds: string[]): void {
  organizations = organizationIds.map((id) => ({
    id,
    name: id,
    role: 'MEMBER',
  }));
}

function setSavedOwner(projectId: string, owner: ResolvedProjectOwner): void {
  savedOwners.set(projectId, owner);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordsOf(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error('Expected an array of object rows');
  }
  return value;
}

function resultOf(
  response: Awaited<ReturnType<typeof dispatchBotAction>>,
): Record<string, unknown> {
  if (!response.ok || !isRecord(response.result)) {
    throw new Error('Expected bot action success result');
  }
  return response.result;
}

function expectErrorCode(
  response: Awaited<ReturnType<typeof dispatchBotAction>>,
  code: string,
): void {
  if (response.ok || !response.error) {
    throw new Error(`Expected bot action error ${code}`);
  }
  expect(response.error.code).toBe(code);
}

function nextCursorFrom(
  response: Awaited<ReturnType<typeof dispatchBotAction>>,
): string {
  const cursor = resultOf(response).nextCursor;
  if (typeof cursor !== 'string') {
    throw new Error('Expected a next cursor');
  }
  return cursor;
}

function archive(chatId: string): ChatStateSnapshot['archives'][number] {
  return {
    chatId,
    title: `Archived ${chatId}`,
    turnCount: 1,
    archivedAt: '2026-10-05T00:00:00.000Z',
    createdAt: '2026-10-04T00:00:00.000Z',
    restorable: true,
    unread: false,
  };
}

const mockedResolveProjectSavedOwner = jest.mocked(resolveProjectSavedOwner);
const mockedReadWorkEntriesFileStrict = jest.mocked(readWorkEntriesFileStrict);

beforeEach(() => {
  jest.resetAllMocks();
  resetAppAdvisorProjectAgentAccessForTests();
  accountEpoch = 1;
  organizations = [];
  savedOwners = new Map();
  savedOwners.set(projectCaller.projectId, PERSONAL_OWNER);
  savedOwners.set(otherProjectCaller.projectId, PERSONAL_OWNER);
  mockContext = {
    initialize: jest.fn(() => Promise.resolve()),
    whenIdle: jest.fn(() => Promise.resolve()),
    accountEpoch: (): number => accountEpoch,
    getState: (): ReturnType<ContextServiceMock['getState']> => ({
      organizations,
    }),
  };
  snapshotsForTask = (taskId: string): ChatStateSnapshot =>
    chatSnapshot(taskId);
  transcriptFor = (params: CoreChatTranscriptPageParams): TranscriptPage =>
    pageForMessages([], params);
  mockRuntime = createMockRuntime();
  setAccess('enabled');
  setWorkEntries([]);
  mockedResolveProjectSavedOwner.mockImplementation(({ projectId }) =>
    Promise.resolve(savedOwners.get(projectId) ?? PERSONAL_OWNER),
  );
});

describe('App Advisor bot access gate', () => {
  test('uses the real Enabled and selected-owner resolver for personal and organization origins', async () => {
    setAccess('enabled');
    setSavedOwner(projectCaller.projectId, PERSONAL_OWNER);
    await expect(isBotAccessAllowed(projectCaller)).resolves.toBe(true);

    setAccess('selected-owners', [PERSONAL_OWNER]);
    await expect(isBotAccessAllowed(projectCaller)).resolves.toBe(true);

    setSavedOwner(projectCaller.projectId, ORGANIZATION_A);
    await expect(isBotAccessAllowed(projectCaller)).resolves.toBe(false);

    setAccess('selected-owners', [ORGANIZATION_A]);
    setMemberships(ORG_A);
    await expect(isBotAccessAllowed(projectCaller)).resolves.toBe(true);
    expect(mockContext.initialize).toHaveBeenCalled();
    expect(mockContext.whenIdle).toHaveBeenCalled();
    expect(mockedResolveProjectSavedOwner).toHaveBeenCalledWith({
      projectId: projectCaller.projectId,
      worktreeId: projectCaller.worktreeId,
    });
  });

  test('refuses stale organization membership, Disabled, and an unknown saved owner', async () => {
    setSavedOwner(projectCaller.projectId, ORGANIZATION_A);
    setAccess('selected-owners', [ORGANIZATION_A]);
    setMemberships(ORG_B);
    await expect(isBotAccessAllowed(projectCaller)).resolves.toBe(false);

    setAccess('disabled');
    await expect(isBotAccessAllowed(projectCaller)).resolves.toBe(false);

    setAccess('enabled');
    setSavedOwner(projectCaller.projectId, { kind: 'unknown' });
    await expect(isBotAccessAllowed(projectCaller)).resolves.toBe(false);
  });

  test('does not gate App Advisor callers even when project access is Disabled', async () => {
    setAccess('disabled');

    await expect(isBotAccessAllowed(advisorCaller)).resolves.toBe(true);
    expect(mockedResolveProjectSavedOwner).not.toHaveBeenCalled();

    const response = await dispatch(
      { type: 'bots.list', pageSize: 1 },
      advisorCaller,
    );
    expect(resultOf(response).items).toHaveLength(1);
    expect(mockedReadWorkEntriesFileStrict).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
    );
    expect(mockedResolveProjectSavedOwner).not.toHaveBeenCalled();
  });

  test('gates a pipeline caller only by the agent that started its run', async () => {
    setAccess('disabled');
    const userRun = {
      kind: 'pipeline',
      owner: ORGANIZATION_A,
    } satisfies ProjectDiscoveryCaller;
    await expect(isBotAccessAllowed(userRun)).resolves.toBe(true);
    expect(mockedResolveProjectSavedOwner).not.toHaveBeenCalled();
    const userResponse = await dispatch(
      { type: 'bots.list', pageSize: 1 },
      userRun,
    );
    expect(resultOf(userResponse).items).toHaveLength(1);

    const agentRun = {
      kind: 'pipeline',
      owner: PERSONAL_OWNER,
      agentOrigin: {
        projectId: projectCaller.projectId,
        worktreeId: projectCaller.worktreeId,
        chatId: projectCaller.chatId,
      },
    } satisfies ProjectDiscoveryCaller;
    await expect(isBotAccessAllowed(agentRun)).resolves.toBe(false);
    expectErrorCode(
      await dispatch({ type: 'bots.list', pageSize: 1 }, agentRun),
      'advisor_access_disabled',
    );

    setAccess('enabled');
    await expect(isBotAccessAllowed(agentRun)).resolves.toBe(true);
    expect(mockedResolveProjectSavedOwner).toHaveBeenCalledWith({
      projectId: projectCaller.projectId,
      worktreeId: projectCaller.worktreeId,
    });
  });

  test('allows a pipeline caller without an origin without evaluating the setting', async () => {
    setAccess('disabled');

    await expect(
      isBotAccessAllowed({ kind: 'pipeline', owner: PERSONAL_OWNER }),
    ).resolves.toBe(true);
    expect(mockedResolveProjectSavedOwner).not.toHaveBeenCalled();
  });

  test("decides an agent-originated pipeline by its origin agent's setting", async () => {
    const pipelineCaller = {
      kind: 'pipeline',
      owner: PERSONAL_OWNER,
      agentOrigin: {
        projectId: projectCaller.projectId,
        worktreeId: projectCaller.worktreeId,
        chatId: projectCaller.chatId,
      },
    } satisfies ProjectDiscoveryCaller;
    setAccess('enabled');
    await expect(isBotAccessAllowed(pipelineCaller)).resolves.toBe(true);
    expect(mockedResolveProjectSavedOwner).toHaveBeenCalledWith({
      projectId: projectCaller.projectId,
      worktreeId: projectCaller.worktreeId,
    });

    setAccess('disabled');
    await expect(isBotAccessAllowed(pipelineCaller)).resolves.toBe(false);
    await expect(requireBotAccess(pipelineCaller)).rejects.toMatchObject({
      code: 'advisor_access_disabled',
    });
  });

  test('re-evaluates the latest setting on every call', async () => {
    setAccess('enabled');
    await expect(isBotAccessAllowed(projectCaller)).resolves.toBe(true);

    setAccess('disabled');
    await expect(isBotAccessAllowed(projectCaller)).resolves.toBe(false);
  });

  test('checks the gate before cursors or bot storage and returns the typed refusal', async () => {
    setAccess('disabled');

    const response = await dispatch({
      type: 'bots.list_tasks',
      botId: BOT_ID,
      pageSize: 1,
      cursor: 'expired-or-foreign-cursor',
    });

    expectErrorCode(response, 'advisor_access_disabled');
    expect(mockedReadWorkEntriesFileStrict).not.toHaveBeenCalled();
    expect(mockRuntime.queryChatStateForLegacyIpc).not.toHaveBeenCalled();
    expect(
      mockRuntime.queryChatTranscriptPageForLegacyIpc,
    ).not.toHaveBeenCalled();
  });

  test('rechecks access after an awaited storage read and withholds the page after a flip', async () => {
    let releaseEntries: (file: CoworkWorkEntriesFile) => void = () => {
      throw new Error('Expected the pending Work Entry read to be released');
    };
    let signalReadStarted: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    const pendingEntries = new Promise<CoworkWorkEntriesFile>((resolve) => {
      releaseEntries = resolve;
    });
    mockedReadWorkEntriesFileStrict.mockImplementation(() => {
      signalReadStarted();
      return pendingEntries;
    });

    const pendingResponse = dispatch({
      type: 'bots.list_tasks',
      botId: BOT_ID,
    });
    let readWasStarted = false;
    for (let attempt = 0; attempt < 100 && !readWasStarted; attempt += 1) {
      await Promise.resolve();
      readWasStarted = mockedReadWorkEntriesFileStrict.mock.calls.length > 0;
    }
    setAccess('disabled');
    if (readWasStarted) {
      await readStarted;
      releaseEntries({
        version: 1,
        entries: [workEntry(TASK_ONE)],
      });
    }

    const response = await pendingResponse;
    expect(readWasStarted).toBe(true);
    expectErrorCode(response, 'advisor_access_disabled');
  });

  test('rechecks access after a failed awaited source read before exposing its error', async () => {
    const readStarted = deferred<void>();
    const pendingEntries = deferred<CoworkWorkEntriesFile>();
    mockedReadWorkEntriesFileStrict.mockImplementation(() => {
      readStarted.resolve();
      return pendingEntries.promise;
    });

    const pendingResponse = dispatch({
      type: 'bots.list_tasks',
      botId: BOT_ID,
    });
    const started = await waitFor(
      () => mockedReadWorkEntriesFileStrict.mock.calls.length > 0,
    );
    setAccess('disabled');
    if (started) {
      await readStarted.promise;
      pendingEntries.reject(new Error('work-entry read failed'));
    }

    const response = await pendingResponse;
    expect(started).toBe(true);
    expectErrorCode(response, 'advisor_access_disabled');
  });

  test('Disabled takes precedence over valid, foreign, and expired history cursors', async () => {
    setWorkEntries([workEntry(TASK_ONE), workEntry(TASK_TWO)]);
    snapshotsForTask = (taskId: string): ChatStateSnapshot =>
      chatSnapshot(taskId, [chatTab(CHAT_ONE)]);
    transcriptFor = (params: CoreChatTranscriptPageParams): TranscriptPage =>
      pageForMessages(
        [
          message('user-1', 'user', 'first message'),
          message('assistant-1', 'assistant', 'second message'),
        ],
        params,
        1,
        1,
      );
    const baseAction = {
      type: 'bots.read_history',
      botId: BOT_ID,
      taskId: TASK_ONE,
      chatId: CHAT_ONE,
      pageSize: 1,
    };
    const validCursor = nextCursorFrom(await dispatch(baseAction));
    const foreignCursor = nextCursorFrom(
      await dispatch(baseAction, otherProjectCaller),
    );
    mockedReadWorkEntriesFileStrict.mockClear();
    mockRuntime.queryChatStateForLegacyIpc.mockClear();
    mockRuntime.queryChatTranscriptPageForLegacyIpc.mockClear();
    setAccess('disabled');

    expectErrorCode(
      await dispatch({ ...baseAction, cursor: validCursor }),
      'advisor_access_disabled',
    );
    expectErrorCode(
      await dispatch({ ...baseAction, cursor: foreignCursor }),
      'advisor_access_disabled',
    );
    expectErrorCode(
      await dispatch({ ...baseAction, cursor: 'expired-or-unknown-handle' }),
      'advisor_access_disabled',
    );
    expect(mockedReadWorkEntriesFileStrict).not.toHaveBeenCalled();
    expect(mockRuntime.queryChatStateForLegacyIpc).not.toHaveBeenCalled();
    expect(
      mockRuntime.queryChatTranscriptPageForLegacyIpc,
    ).not.toHaveBeenCalled();
  });

  test('allows an Advisor-owned continuation after project-agent access is Disabled', async () => {
    setWorkEntries([workEntry(TASK_ONE), workEntry(TASK_TWO)]);
    const firstPage = resultOf(
      await dispatch(
        { type: 'bots.list_tasks', botId: BOT_ID, pageSize: 1 },
        advisorCaller,
      ),
    );
    const cursor = firstPage.nextCursor;
    if (typeof cursor !== 'string') throw new Error('Expected a task cursor');
    setAccess('disabled');

    const continuation = resultOf(
      await dispatch(
        {
          type: 'bots.list_tasks',
          botId: BOT_ID,
          pageSize: 1,
          cursor,
        },
        advisorCaller,
      ),
    );

    expect(continuation.items).toEqual([
      expect.objectContaining({ botId: BOT_ID, taskId: TASK_TWO }),
    ]);
  });

  test('rechecks a suspended transcript read and returns no data after access is revoked', async () => {
    setWorkEntries([workEntry(TASK_ONE)]);
    snapshotsForTask = (taskId: string): ChatStateSnapshot =>
      chatSnapshot(taskId, [chatTab(CHAT_ONE)]);
    const readStarted = deferred<void>();
    const pendingTranscript = deferred<TranscriptResult>();
    let requestedParams: CoreChatTranscriptPageParams | undefined;
    mockRuntime.queryChatTranscriptPageForLegacyIpc.mockImplementation(
      (params) => {
        requestedParams = params;
        readStarted.resolve();
        return pendingTranscript.promise;
      },
    );

    const pendingResponse = dispatch({
      type: 'bots.get_last_user_message',
      botId: BOT_ID,
      taskId: TASK_ONE,
      chatId: CHAT_ONE,
    });
    const started = await waitFor(
      () =>
        mockRuntime.queryChatTranscriptPageForLegacyIpc.mock.calls.length > 0,
    );
    setAccess('disabled');
    if (started && requestedParams) {
      await readStarted.promise;
      pendingTranscript.resolve(
        transcriptResult(
          pageForMessages(
            [message('user-1', 'user', 'must not be returned')],
            requestedParams,
          ),
        ),
      );
    }

    const response = await pendingResponse;
    expect(started).toBe(true);
    expectErrorCode(response, 'advisor_access_disabled');
    expect(JSON.stringify(response)).not.toContain('must not be returned');
  });

  test('a failed suspended transcript read is masked by access revocation', async () => {
    setWorkEntries([workEntry(TASK_ONE)]);
    snapshotsForTask = (taskId: string): ChatStateSnapshot =>
      chatSnapshot(taskId, [chatTab(CHAT_ONE)]);
    const readStarted = deferred<void>();
    const pendingTranscript = deferred<TranscriptResult>();
    mockRuntime.queryChatTranscriptPageForLegacyIpc.mockImplementation(() => {
      readStarted.resolve();
      return pendingTranscript.promise;
    });

    const pendingResponse = dispatch({
      type: 'bots.read_history',
      botId: BOT_ID,
      taskId: TASK_ONE,
      chatId: CHAT_ONE,
      pageSize: 1,
    });
    const started = await waitFor(
      () =>
        mockRuntime.queryChatTranscriptPageForLegacyIpc.mock.calls.length > 0,
    );
    setAccess('disabled');
    if (started) {
      await readStarted.promise;
      pendingTranscript.reject(new Error('transcript read failed'));
    }

    const response = await pendingResponse;
    expect(started).toBe(true);
    expectErrorCode(response, 'advisor_access_disabled');
  });
});

describe('bot registry and task discovery', () => {
  test('parses bot actions so defaults come from the shared contract', () => {
    expect(
      parseAction({ type: 'bots.list_tasks', botId: BOT_ID }),
    ).toMatchObject({
      pageSize: 50,
      retentionStates: ['retained'],
      sort: 'last_activity',
      order: 'desc',
    });
    expect(
      parseAction({ type: 'bots.list_task_chats', botId: BOT_ID }),
    ).toMatchObject({
      pageSize: 50,
      retentionStates: ['retained'],
      includeLastUserMessage: false,
    });
  });

  test('lists only the public Advisor bot with its implemented capabilities and eligible task count', async () => {
    setWorkEntries([
      workEntry(TASK_ONE),
      workEntry(TASK_TWO),
      workEntry(APP_ADVISOR_WORKTREE_ID),
      workEntry(COWORK_HOME_WORKTREE_ID),
    ]);

    const response = await dispatch({ type: 'bots.list', pageSize: 1 });
    const result = resultOf(response);

    expect(result.items).toEqual([
      expect.objectContaining({
        botId: BOT_ID,
        availability: 'available',
        taskCount: 2,
        capabilities: {
          listTasks: true,
          readChats: true,
          sendMessages: true,
          createTasks: true,
          createChats: true,
          watchChats: true,
        },
      }),
    ]);
    expect(result.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: APP_ADVISOR_PROJECT_ID }),
      ]),
    );
    expect(mockedReadWorkEntriesFileStrict).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
    );
  });

  test('names the bot Orchestrator and still matches its former name', async () => {
    setWorkEntries([workEntry(TASK_ONE)]);
    const listed = resultOf(await dispatch({ type: 'bots.list' }));
    expect(listed.items).toEqual([
      expect.objectContaining({ botId: BOT_ID, name: 'Orchestrator' }),
    ]);

    for (const name of ['App Advisor', 'orchestrator', ' ORCHESTRATOR ']) {
      const page = resultOf(await dispatch({ type: 'bots.list', name }));
      expect(page.items).toEqual([expect.objectContaining({ botId: BOT_ID })]);
    }
    for (const query of ['app advisor', 'orch']) {
      const page = resultOf(await dispatch({ type: 'bots.list', query }));
      expect(page.items).toEqual([expect.objectContaining({ botId: BOT_ID })]);
    }
    const other = resultOf(
      await dispatch({ type: 'bots.list', name: 'Pipeline Advisor' }),
    );
    expect(other.items).toEqual([]);
  });

  test('keeps the one-bot catalog on a terminal page and rejects unissued list cursors', async () => {
    setWorkEntries([workEntry(TASK_ONE)]);
    const page = resultOf(await dispatch({ type: 'bots.list', pageSize: 1 }));

    expect(page.returned).toBe(1);
    expect(page.totalMatches).toBe(1);
    expect(page.nextCursor).toBeNull();
    expectErrorCode(
      await dispatch({
        type: 'bots.list',
        pageSize: 1,
        cursor: 'not-issued-by-the-single-bot-catalog',
      }),
      'cursor_expired',
    );
  });

  test.each(['unknown_bot_id', APP_ADVISOR_PROJECT_ID])(
    'returns unknown_bot for unknown public bot ID %s without resolving storage',
    async (botId) => {
      const response = await dispatch({
        type: 'bots.list_tasks',
        botId,
      });

      expectErrorCode(response, 'unknown_bot');
      expect(mockedReadWorkEntriesFileStrict).not.toHaveBeenCalled();
      expect(mockRuntime.queryChatStateForLegacyIpc).not.toHaveBeenCalled();
    },
  );

  test('lists only eligible retained Work Entries and never projects the internal project ID', async () => {
    setWorkEntries([
      workEntry(TASK_ONE, { title: 'Alpha', pinned: true }),
      workEntry(TASK_TWO, { status: 'done', title: 'Beta' }),
      workEntry(APP_ADVISOR_WORKTREE_ID),
      workEntry(COWORK_HOME_WORKTREE_ID),
    ]);
    snapshotsForTask = (taskId: string): ChatStateSnapshot =>
      chatSnapshot(taskId, taskId === TASK_ONE ? [chatTab(CHAT_ONE)] : []);

    const response = await dispatch({
      type: 'bots.list_tasks',
      botId: BOT_ID,
      pageSize: 20,
    });
    const result = resultOf(response);

    expect(result).toMatchObject({
      botId: BOT_ID,
      returned: 2,
      totalMatches: 2,
    });
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          botId: BOT_ID,
          taskId: TASK_ONE,
          kind: 'work_entry',
        }),
        expect.objectContaining({
          botId: BOT_ID,
          taskId: TASK_TWO,
          kind: 'work_entry',
        }),
      ]),
    );
    expect(JSON.stringify(result.items)).not.toContain('projectId');
    expect(
      mockRuntime.queryChatStateForLegacyIpc.mock.calls.map(
        ([request]) => request.scope,
      ),
    ).toEqual([
      { workspaceId: APP_ADVISOR_PROJECT_ID, worktreeId: TASK_ONE },
      { workspaceId: APP_ADVISOR_PROJECT_ID, worktreeId: TASK_TWO },
    ]);
    expect(
      mockRuntime.queryChatStateForLegacyIpc.mock.calls.some(
        ([request]) =>
          request.scope.worktreeId === APP_ADVISOR_WORKTREE_ID ||
          request.scope.worktreeId === COWORK_HOME_WORKTREE_ID,
      ),
    ).toBe(false);
  });

  test('rejects archive filters instead of returning incomplete retained-only results', async () => {
    setWorkEntries([workEntry(TASK_ONE)]);
    const taskArchivedOnly = await dispatch({
      type: 'bots.list_tasks',
      botId: BOT_ID,
      retentionStates: ['archived'],
    });
    const taskMixed = await dispatch({
      type: 'bots.list_tasks',
      botId: BOT_ID,
      retentionStates: ['retained', 'archived'],
    });
    const chatsArchivedOnly = await dispatch({
      type: 'bots.list_task_chats',
      botId: BOT_ID,
      taskId: TASK_ONE,
      retentionStates: ['archived'],
    });

    expectErrorCode(taskArchivedOnly, 'unsupported_filter');
    expectErrorCode(taskMixed, 'unsupported_filter');
    expectErrorCode(chatsArchivedOnly, 'unsupported_filter');
  });
});

describe('bot chat discovery and read targets', () => {
  test('omitted task enumeration excludes global/home sentinels and projects read-only bot chat capabilities', async () => {
    setWorkEntries([
      workEntry(TASK_ONE),
      workEntry(APP_ADVISOR_WORKTREE_ID),
      workEntry(COWORK_HOME_WORKTREE_ID),
    ]);
    snapshotsForTask = (taskId: string): ChatStateSnapshot =>
      taskId === TASK_ONE
        ? chatSnapshot(
            taskId,
            [
              chatTab(CHAT_ONE, { title: 'Healthy' }),
              chatTab('queued-chat', { title: 'Queued' }),
              chatTab('expired-chat', { title: 'Expired', readOnly: true }),
              chatTab('file-tab', { title: 'File', kind: 'file' }),
            ],
            {
              'queued-chat': {
                status: 'queued',
                queuedMessageIds: ['queued-1'],
                steeringCapabilities: {
                  provider: 'claude',
                  generation: 'test-generation',
                  steer: true,
                  withdraw: false,
                  interrupt: false,
                },
              },
            },
          )
        : chatSnapshot(taskId, [chatTab('wrong-sentinel-chat')]);

    const response = await dispatch({
      type: 'bots.list_task_chats',
      botId: BOT_ID,
      includeLastUserMessage: true,
      pageSize: 20,
    });
    const result = resultOf(response);

    expect(result).toMatchObject({
      botId: BOT_ID,
      returned: 3,
      totalMatches: 3,
    });
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          botId: BOT_ID,
          taskId: TASK_ONE,
          chatId: CHAT_ONE,
        }),
        expect.objectContaining({
          botId: BOT_ID,
          taskId: TASK_ONE,
          chatId: 'queued-chat',
        }),
        expect.objectContaining({
          botId: BOT_ID,
          taskId: TASK_ONE,
          chatId: 'expired-chat',
        }),
      ]),
    );
    expect(JSON.stringify(result.items)).not.toContain('projectId');
    const items = recordsOf(result.items);
    expect(items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chatId: 'file-tab' }),
        expect.objectContaining({ chatId: 'wrong-sentinel-chat' }),
      ]),
    );
    for (const item of items) {
      expect(item.lastUserMessage).toBeUndefined();
      expect(item.capabilities).toEqual(
        expect.objectContaining({
          canRead: true,
          // Read-only and expired chats cannot receive sends.
          canSend: item.chatId !== 'expired-chat',
          canWatch: true,
          canSteerQueuedMessage: false,
        }),
      );
      expect(isRecord(item.capabilities)).toBe(true);
      if (isRecord(item.capabilities)) {
        expect(item.capabilities.unavailableReason).toEqual(expect.any(String));
      }
    }
    expect(
      mockRuntime.queryChatStateForLegacyIpc.mock.calls.map(
        ([request]) => request.scope.worktreeId,
      ),
    ).toEqual([TASK_ONE]);
  });

  test('returns not_found for unknown tasks, wrong-parent chats, file tabs, archives, and sentinels', async () => {
    setWorkEntries([workEntry(TASK_ONE), workEntry(TASK_TWO)]);
    snapshotsForTask = (taskId: string): ChatStateSnapshot =>
      taskId === TASK_ONE
        ? chatSnapshot(
            taskId,
            [chatTab(CHAT_ONE), chatTab('file-tab', { kind: 'file' })],
            {},
            [],
            [archive('archived-chat')],
          )
        : chatSnapshot(taskId, [chatTab(CHAT_TWO)]);

    const missingTask = await dispatch({
      type: 'bots.list_task_chats',
      botId: BOT_ID,
      taskId: 'missing-task',
    });
    const wrongParent = await dispatch({
      type: 'bots.get_last_user_message',
      botId: BOT_ID,
      taskId: TASK_ONE,
      chatId: CHAT_TWO,
    });
    const fileTab = await dispatch({
      type: 'bots.get_last_user_message',
      botId: BOT_ID,
      taskId: TASK_ONE,
      chatId: 'file-tab',
    });
    const archivedChat = await dispatch({
      type: 'bots.get_last_user_message',
      botId: BOT_ID,
      taskId: TASK_ONE,
      chatId: 'archived-chat',
    });
    const globalSlot = await dispatch({
      type: 'bots.get_last_user_message',
      botId: BOT_ID,
      taskId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'legacy-chat',
    });
    const homeSlot = await dispatch({
      type: 'bots.get_last_user_message',
      botId: BOT_ID,
      taskId: COWORK_HOME_WORKTREE_ID,
      chatId: 'home-chat',
    });

    for (const response of [
      missingTask,
      wrongParent,
      fileTab,
      archivedChat,
      globalSlot,
      homeSlot,
    ]) {
      expectErrorCode(response, 'not_found');
    }
    expect(
      mockRuntime.queryChatTranscriptPageForLegacyIpc,
    ).not.toHaveBeenCalled();
  });

  test('reads messages using public bot addresses and the canonical Advisor workspace scope', async () => {
    setWorkEntries([workEntry(TASK_ONE)]);
    snapshotsForTask = (taskId: string): ChatStateSnapshot =>
      chatSnapshot(taskId, [chatTab(CHAT_ONE)]);
    const userMessage = message(
      'user-1',
      'user',
      'question from Advisor history',
    );
    const assistantMessage = message(
      'assistant-1',
      'assistant',
      'answer from Advisor history',
    );
    transcriptFor = (params: CoreChatTranscriptPageParams): TranscriptPage =>
      pageForMessages([userMessage, assistantMessage], params);

    const lastUser = resultOf(
      await dispatch({
        type: 'bots.get_last_user_message',
        botId: BOT_ID,
        taskId: TASK_ONE,
        chatId: CHAT_ONE,
      }),
    );
    const lastAgent = resultOf(
      await dispatch({
        type: 'bots.get_last_agent_response',
        botId: BOT_ID,
        taskId: TASK_ONE,
        chatId: CHAT_ONE,
      }),
    );
    const history = resultOf(
      await dispatch({
        type: 'bots.read_history',
        botId: BOT_ID,
        taskId: TASK_ONE,
        chatId: CHAT_ONE,
        pageSize: 2,
      }),
    );

    expect(lastUser).toMatchObject({
      address: { botId: BOT_ID, taskId: TASK_ONE, chatId: CHAT_ONE },
      message: {
        messageId: 'user-1',
        role: 'user',
        text: 'question from Advisor history',
      },
    });
    expect(lastAgent).toMatchObject({
      address: { botId: BOT_ID, taskId: TASK_ONE, chatId: CHAT_ONE },
      message: {
        messageId: 'assistant-1',
        role: 'assistant',
        text: 'answer from Advisor history',
      },
    });
    expect(history).toMatchObject({
      address: { botId: BOT_ID, taskId: TASK_ONE, chatId: CHAT_ONE },
    });
    expect(recordsOf(history.items)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageId: 'user-1', role: 'user' }),
        expect.objectContaining({
          messageId: 'assistant-1',
          role: 'assistant',
        }),
      ]),
    );
    for (const result of [lastUser, lastAgent, history]) {
      expect(result.address).not.toHaveProperty('projectId');
      expect(JSON.stringify(result)).not.toContain('projectId');
    }
    expect(
      mockRuntime.queryChatTranscriptPageForLegacyIpc.mock.calls.map(
        ([params]) => params.scope,
      ),
    ).toEqual(
      expect.arrayContaining([
        {
          workspaceId: APP_ADVISOR_PROJECT_ID,
          worktreeId: TASK_ONE,
          chatId: CHAT_ONE,
        },
      ]),
    );
    expect(
      mockRuntime.queryChatStateForLegacyIpc.mock.calls.every(
        ([request]) => request.scope.workspaceId === APP_ADVISOR_PROJECT_ID,
      ),
    ).toBe(true);
  });
});

describe('bot cursors', () => {
  beforeEach(() => {
    setWorkEntries([
      workEntry(TASK_ONE, { title: 'Alpha' }),
      workEntry(TASK_TWO, { title: 'Beta' }),
    ]);
    snapshotsForTask = (taskId: string): ChatStateSnapshot =>
      chatSnapshot(
        taskId,
        taskId === TASK_ONE
          ? [chatTab(CHAT_ONE), chatTab(CHAT_TWO)]
          : [chatTab(CHAT_TWO)],
      );
    transcriptFor = (params: CoreChatTranscriptPageParams): TranscriptPage =>
      pageForMessages(
        [
          message('user-1', 'user', 'first message'),
          message('assistant-1', 'assistant', 'second message'),
        ],
        params,
        1,
        1,
      );
  });

  test('binds task-list continuations to account, caller, saved owner, and filters', async () => {
    const accountCursor = nextCursorFrom(
      await dispatch({ type: 'bots.list_tasks', botId: BOT_ID, pageSize: 1 }),
    );
    accountEpoch += 1;
    expectErrorCode(
      await dispatch({
        type: 'bots.list_tasks',
        botId: BOT_ID,
        pageSize: 1,
        cursor: accountCursor,
      }),
      'cursor_context_changed',
    );

    accountEpoch = 1;
    const callerCursor = nextCursorFrom(
      await dispatch({ type: 'bots.list_tasks', botId: BOT_ID, pageSize: 1 }),
    );
    expectErrorCode(
      await dispatch(
        {
          type: 'bots.list_tasks',
          botId: BOT_ID,
          pageSize: 1,
          cursor: callerCursor,
        },
        otherProjectCaller,
      ),
      'cursor_context_changed',
    );

    const ownerCursor = nextCursorFrom(
      await dispatch({ type: 'bots.list_tasks', botId: BOT_ID, pageSize: 1 }),
    );
    setSavedOwner(projectCaller.projectId, ORGANIZATION_A);
    expectErrorCode(
      await dispatch({
        type: 'bots.list_tasks',
        botId: BOT_ID,
        pageSize: 1,
        cursor: ownerCursor,
      }),
      'cursor_context_changed',
    );

    setSavedOwner(projectCaller.projectId, PERSONAL_OWNER);
    const filterCursor = nextCursorFrom(
      await dispatch({
        type: 'bots.list_tasks',
        botId: BOT_ID,
        pageSize: 1,
        query: 'a',
      }),
    );
    expectErrorCode(
      await dispatch({
        type: 'bots.list_tasks',
        botId: BOT_ID,
        pageSize: 1,
        query: 'xyz',
        cursor: filterCursor,
      }),
      'cursor_context_changed',
    );
  });

  test('invalidates task-list cursors when task metadata changes', async () => {
    const cursor = nextCursorFrom(
      await dispatch({ type: 'bots.list_tasks', botId: BOT_ID, pageSize: 1 }),
    );
    setWorkEntries([
      workEntry(TASK_ONE, { title: 'Renamed Alpha' }),
      workEntry(TASK_TWO, { title: 'Beta' }),
    ]);

    expectErrorCode(
      await dispatch({
        type: 'bots.list_tasks',
        botId: BOT_ID,
        pageSize: 1,
        cursor,
      }),
      'cursor_context_changed',
    );
  });

  test('binds chat continuations to task target and normalized chat filters', async () => {
    const cursor = nextCursorFrom(
      await dispatch({
        type: 'bots.list_task_chats',
        botId: BOT_ID,
        taskId: TASK_ONE,
        pageSize: 1,
      }),
    );

    expectErrorCode(
      await dispatch({
        type: 'bots.list_task_chats',
        botId: BOT_ID,
        taskId: TASK_TWO,
        pageSize: 1,
        cursor,
      }),
      'cursor_context_changed',
    );

    const filterCursor = nextCursorFrom(
      await dispatch({
        type: 'bots.list_task_chats',
        botId: BOT_ID,
        taskId: TASK_ONE,
        pageSize: 1,
        runtimeStates: ['unknown'],
      }),
    );
    expectErrorCode(
      await dispatch({
        type: 'bots.list_task_chats',
        botId: BOT_ID,
        taskId: TASK_ONE,
        pageSize: 1,
        runtimeStates: ['running'],
        cursor: filterCursor,
      }),
      'cursor_context_changed',
    );
  });

  test('invalidates a chat cursor when the next retained chat metadata changes', async () => {
    const cursor = nextCursorFrom(
      await dispatch({
        type: 'bots.list_task_chats',
        botId: BOT_ID,
        taskId: TASK_ONE,
        pageSize: 1,
      }),
    );
    snapshotsForTask = (taskId: string): ChatStateSnapshot =>
      chatSnapshot(
        taskId,
        taskId === TASK_ONE
          ? [chatTab(CHAT_ONE), chatTab(CHAT_TWO, { title: 'Changed Chat' })]
          : [chatTab(CHAT_TWO)],
      );

    expectErrorCode(
      await dispatch({
        type: 'bots.list_task_chats',
        botId: BOT_ID,
        taskId: TASK_ONE,
        pageSize: 1,
        cursor,
      }),
      'cursor_context_changed',
    );
  });

  test('binds history continuations to chat address and transcript revision', async () => {
    const cursor = nextCursorFrom(
      await dispatch({
        type: 'bots.read_history',
        botId: BOT_ID,
        taskId: TASK_ONE,
        chatId: CHAT_ONE,
        pageSize: 1,
      }),
    );

    expectErrorCode(
      await dispatch({
        type: 'bots.read_history',
        botId: BOT_ID,
        taskId: TASK_ONE,
        chatId: CHAT_TWO,
        pageSize: 1,
        cursor,
      }),
      'cursor_context_changed',
    );

    const revisionCursor = nextCursorFrom(
      await dispatch({
        type: 'bots.read_history',
        botId: BOT_ID,
        taskId: TASK_ONE,
        chatId: CHAT_ONE,
        pageSize: 1,
      }),
    );
    transcriptFor = (params: CoreChatTranscriptPageParams): TranscriptPage =>
      pageForMessages(
        [
          message('user-1', 'user', 'first message'),
          message('assistant-1', 'assistant', 'second message'),
        ],
        params,
        2,
        1,
      );
    expectErrorCode(
      await dispatch({
        type: 'bots.read_history',
        botId: BOT_ID,
        taskId: TASK_ONE,
        chatId: CHAT_ONE,
        pageSize: 1,
        cursor: revisionCursor,
      }),
      'cursor_context_changed',
    );
  });

  test('binds history continuations to account, caller, owner, and filters', async () => {
    const accountCursor = nextCursorFrom(
      await dispatch({
        type: 'bots.read_history',
        botId: BOT_ID,
        taskId: TASK_ONE,
        chatId: CHAT_ONE,
        pageSize: 1,
      }),
    );
    accountEpoch += 1;
    expectErrorCode(
      await dispatch({
        type: 'bots.read_history',
        botId: BOT_ID,
        taskId: TASK_ONE,
        chatId: CHAT_ONE,
        pageSize: 1,
        cursor: accountCursor,
      }),
      'cursor_context_changed',
    );

    accountEpoch = 1;
    const callerCursor = nextCursorFrom(
      await dispatch({
        type: 'bots.read_history',
        botId: BOT_ID,
        taskId: TASK_ONE,
        chatId: CHAT_ONE,
        pageSize: 1,
      }),
    );
    expectErrorCode(
      await dispatch(
        {
          type: 'bots.read_history',
          botId: BOT_ID,
          taskId: TASK_ONE,
          chatId: CHAT_ONE,
          pageSize: 1,
          cursor: callerCursor,
        },
        otherProjectCaller,
      ),
      'cursor_context_changed',
    );

    const ownerCursor = nextCursorFrom(
      await dispatch({
        type: 'bots.read_history',
        botId: BOT_ID,
        taskId: TASK_ONE,
        chatId: CHAT_ONE,
        pageSize: 1,
      }),
    );
    setSavedOwner(projectCaller.projectId, ORGANIZATION_A);
    expectErrorCode(
      await dispatch({
        type: 'bots.read_history',
        botId: BOT_ID,
        taskId: TASK_ONE,
        chatId: CHAT_ONE,
        pageSize: 1,
        cursor: ownerCursor,
      }),
      'cursor_context_changed',
    );

    setSavedOwner(projectCaller.projectId, PERSONAL_OWNER);
    const filterCursor = nextCursorFrom(
      await dispatch({
        type: 'bots.read_history',
        botId: BOT_ID,
        taskId: TASK_ONE,
        chatId: CHAT_ONE,
        pageSize: 1,
        query: 'message',
      }),
    );
    expectErrorCode(
      await dispatch({
        type: 'bots.read_history',
        botId: BOT_ID,
        taskId: TASK_ONE,
        chatId: CHAT_ONE,
        pageSize: 1,
        query: 'first',
        cursor: filterCursor,
      }),
      'cursor_context_changed',
    );
  });
});
