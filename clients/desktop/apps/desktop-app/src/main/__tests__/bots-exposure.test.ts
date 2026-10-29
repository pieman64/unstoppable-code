import { BOT_ACTION_TYPES as ALL_BOT_ACTION_TYPES } from '@canopy/agent-actions';
import {
  BOT_ACTION_TYPES,
  botActionSchema,
  type BotAction,
} from '@canopy/desktop-shared/lib/bot-discovery';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type AppAdvisorActionResponse,
  type AppAdvisorWatcherDestination,
} from '@canopy/desktop-shared/types';
import {
  createDelegateCanopyTools,
  DELEGATE_SCRIPT_ACTION_TYPES,
} from '../agents/delegation/canopy-tools';
import { appAdvisorActionSchema } from '../app-advisor/definitions';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import { executeCanopyInjectedTool } from '../canopy-tools/core';
import { dispatchActionJsonSchema } from '../canopy-tools/definitions';
import type { ProjectDiscoveryCaller } from '../project-discovery';
import { createAppAdvisorToolRuntime } from '../app-advisor/runtime';
import type { AppAdvisorToolRuntimeSurfaces } from '../app-advisor/runtime';

type BotServiceResponse = Omit<AppAdvisorActionResponse, 'requestId'>;

const mockIsBotAccessAllowed = jest.fn<
  Promise<boolean>,
  [ProjectDiscoveryCaller]
>();
const mockDispatchBotAction = jest.fn<
  Promise<BotServiceResponse>,
  [BotAction, ProjectDiscoveryCaller]
>();

jest.mock('../project-discovery/bots', (): object => ({
  isBotAccessAllowed: mockIsBotAccessAllowed,
  dispatchBotAction: mockDispatchBotAction,
}));

const botActions = [
  { type: 'bots.list' },
  { type: 'bots.list_tasks', botId: 'app_advisor' },
  {
    type: 'bots.list_task_chats',
    botId: 'app_advisor',
    taskId: 'advisor-task',
  },
  {
    type: 'bots.get_last_user_message',
    botId: 'app_advisor',
    taskId: 'advisor-task',
    chatId: 'advisor-chat',
  },
  {
    type: 'bots.get_last_agent_response',
    botId: 'app_advisor',
    taskId: 'advisor-task',
    chatId: 'advisor-chat',
  },
  {
    type: 'bots.read_history',
    botId: 'app_advisor',
    taskId: 'advisor-task',
    chatId: 'advisor-chat',
  },
];

function makeRuntime(
  executionScope: 'worktree' | 'directory',
  allowedActionTypes?: readonly string[],
): CanopyInjectedToolRuntime {
  return {
    requestUserAnswers: jest.fn().mockResolvedValue([]),
    loadScriptOutput: jest.fn().mockResolvedValue({ found: true, lines: [] }),
    worktreeActionRuntime: {
      projectId: 'origin-project',
      worktreeId: 'origin-task',
      chatId: 'origin-chat',
      cwd: '/repo',
      executionScope,
      getWindow: () => null,
      ...(allowedActionTypes ? { allowedActionTypes } : {}),
    },
  };
}

function makeAdvisorSurfaces(): AppAdvisorToolRuntimeSurfaces {
  return {
    getMainWindow: () => null,
    getAppAdvisorWindow: () => null,
    openAppAdvisorWindow: jest.fn().mockResolvedValue({
      open: true,
      focused: true,
    }),
    ensureAppAdvisorWindow: jest.fn().mockResolvedValue({
      open: true,
      focused: true,
    }),
  };
}

function advisorDestination(): AppAdvisorWatcherDestination {
  return {
    projectId: APP_ADVISOR_PROJECT_ID,
    worktreeId: APP_ADVISOR_WORKTREE_ID,
    chatId: 'advisor-root-chat',
  };
}

interface SearchResult {
  categories: string[];
  totalMatches: number;
  actions: { type: string }[];
}

/** SearchActions for a trusted chat whose bot access is `allowed`. */
async function search(
  input: object,
  executionScope: 'worktree' | 'directory',
  allowed: boolean | 'no_caller',
): Promise<SearchResult> {
  const runtime: CanopyInjectedToolRuntime =
    allowed === 'no_caller'
      ? {
          requestUserAnswers: jest.fn().mockResolvedValue([]),
          loadScriptOutput: jest
            .fn()
            .mockResolvedValue({ found: true, lines: [] }),
        }
      : makeRuntime(executionScope);
  if (allowed !== 'no_caller')
    mockIsBotAccessAllowed.mockResolvedValue(allowed);
  const result = await executeCanopyInjectedTool(
    'search_actions',
    input,
    runtime,
  );
  const value: unknown = JSON.parse(result.text);
  if (typeof value !== 'object' || value === null)
    throw new Error('SearchActions returned no object');
  const categories = 'categories' in value ? value.categories : [];
  const totalMatches = 'totalMatches' in value ? value.totalMatches : 0;
  const actions: unknown = 'actions' in value ? value.actions : [];
  return {
    categories: Array.isArray(categories)
      ? categories.filter((entry): entry is string => typeof entry === 'string')
      : [],
    totalMatches: typeof totalMatches === 'number' ? totalMatches : 0,
    actions: Array.isArray(actions)
      ? actions.filter(
          (entry: unknown): entry is { type: string } =>
            typeof entry === 'object' &&
            entry !== null &&
            'type' in entry &&
            typeof entry.type === 'string',
        )
      : [],
  };
}

describe('bot action exposure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsBotAccessAllowed.mockResolvedValue(true);
  });

  it.each(botActions)(
    'uses the shared strict parser for $type on both root surfaces',
    async (action) => {
      const runtime = makeRuntime('worktree');
      const expected = botActionSchema.parse(action);
      mockDispatchBotAction.mockResolvedValue({ ok: true, result: {} });
      const response = await executeCanopyInjectedTool(
        'dispatch_action',
        { action },
        runtime,
      );
      expect(response.isError).toBe(false);
      expect(mockDispatchBotAction).toHaveBeenLastCalledWith(
        expected,
        expect.objectContaining({ kind: 'project_agent' }),
      );
      expect(appAdvisorActionSchema.parse(action)).toEqual(expected);
      expect(JSON.stringify(dispatchActionJsonSchema)).toContain(action.type);

      const dispatched = mockDispatchBotAction.mock.calls.length;
      for (const field of [
        'projectId',
        'worktreeId',
        'expectedUiRevision',
        'ui',
        'selectedProjectId',
        'unexpected',
      ]) {
        const rejected = await executeCanopyInjectedTool(
          'dispatch_action',
          { action: { ...action, [field]: 'unexpected' } },
          runtime,
        );
        expect(rejected.isError).toBe(true);
        expect(
          appAdvisorActionSchema.safeParse({
            ...action,
            [field]: 'unexpected',
          }).success,
        ).toBe(false);
      }
      expect(mockDispatchBotAction).toHaveBeenCalledTimes(dispatched);
    },
  );

  it('defines exactly the six bot discovery and read actions', async () => {
    expect(BOT_ACTION_TYPES).toEqual([
      'bots.list',
      'bots.list_tasks',
      'bots.list_task_chats',
      'bots.get_last_user_message',
      'bots.get_last_agent_response',
      'bots.read_history',
    ]);
    expect(botActions.map(({ type }) => type)).toEqual(BOT_ACTION_TYPES);
    const unknown = await executeCanopyInjectedTool(
      'dispatch_action',
      { action: { type: 'bots.unknown' } },
      makeRuntime('worktree'),
    );
    expect(unknown.isError).toBe(true);
    expect(mockDispatchBotAction).not.toHaveBeenCalled();
    expect(
      appAdvisorActionSchema.safeParse({ type: 'bots.unknown' }).success,
    ).toBe(false);
  });

  it.each(['worktree', 'directory'] as const)(
    'shows bots in unfiltered, category, and exact searches only when allowed (%s)',
    async (executionScope) => {
      const allowed = await search({}, executionScope, true);
      const denied = await search({}, executionScope, false);
      const absent = await search({}, executionScope, 'no_caller');

      expect(allowed.categories).toContain('bots');
      expect(denied.categories).not.toContain('bots');
      expect(absent.categories).not.toContain('bots');
      expect(
        denied.actions
          .map(({ type }) => type)
          .filter((type) =>
            ALL_BOT_ACTION_TYPES.some((botType) => botType === type),
          ),
      ).toEqual([]);

      const filteredAllowed = await search(
        { query: 'bots', limit: 50 },
        executionScope,
        true,
      );
      const filteredDenied = await search(
        { query: 'bots', limit: 50 },
        executionScope,
        false,
      );
      expect(filteredAllowed.totalMatches).toBe(ALL_BOT_ACTION_TYPES.length);
      expect(filteredAllowed.actions.map(({ type }) => type).sort()).toEqual(
        [...ALL_BOT_ACTION_TYPES].sort(),
      );
      expect(filteredDenied.totalMatches).toBe(0);

      const allowedCategory = await search(
        { category: 'bots' },
        executionScope,
        true,
      );
      expect(allowedCategory.actions.map(({ type }) => type).sort()).toEqual(
        [...ALL_BOT_ACTION_TYPES].sort(),
      );
      expect(
        (await search({ category: 'bots' }, executionScope, false)).actions,
      ).toEqual([]);
      expect(
        (await search({ category: 'bots' }, executionScope, 'no_caller'))
          .actions,
      ).toEqual([]);
    },
  );

  it.each(['worktree', 'directory'] as const)(
    'searches registered bot action types in the actionType field only when allowed (%s)',
    async (executionScope) => {
      for (const actionType of ALL_BOT_ACTION_TYPES) {
        const allowed = await search({ actionType }, executionScope, true);
        expect(allowed.actions.map(({ type }) => type)).toContain(actionType);
        expect(
          allowed.actions.every((action) =>
            ALL_BOT_ACTION_TYPES.some((botType) => botType === action.type),
          ),
        ).toBe(true);
        expect(
          (await search({ actionType }, executionScope, false)).actions,
        ).toEqual([]);
        expect(
          (await search({ actionType }, executionScope, 'no_caller')).actions,
        ).toEqual([]);
      }
    },
  );

  it.each(['worktree', 'directory'] as const)(
    'rechecks trusted bot access on every SearchActions call (%s)',
    async (executionScope) => {
      const runtime = makeRuntime(executionScope);
      mockIsBotAccessAllowed
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const caller: ProjectDiscoveryCaller = {
        kind: 'project_agent',
        projectId: 'origin-project',
        worktreeId: 'origin-task',
        chatId: 'origin-chat',
      };

      const first = await executeCanopyInjectedTool(
        'search_actions',
        {},
        runtime,
      );
      expect(JSON.parse(first.text)).toHaveProperty(
        'categories',
        expect.arrayContaining(['bots']),
      );
      const accessOff = await executeCanopyInjectedTool(
        'search_actions',
        {},
        runtime,
      );
      expect(JSON.parse(accessOff.text)).toHaveProperty(
        'categories',
        expect.not.arrayContaining(['bots']),
      );
      const accessOnAgain = await executeCanopyInjectedTool(
        'search_actions',
        {},
        runtime,
      );
      expect(JSON.parse(accessOnAgain.text)).toHaveProperty(
        'categories',
        expect.arrayContaining(['bots']),
      );
      expect(mockIsBotAccessAllowed).toHaveBeenCalledTimes(3);
      expect(mockIsBotAccessAllowed).toHaveBeenNthCalledWith(1, caller);
      expect(mockIsBotAccessAllowed).toHaveBeenNthCalledWith(2, caller);
      expect(mockIsBotAccessAllowed).toHaveBeenNthCalledWith(3, caller);
      expect(mockDispatchBotAction).not.toHaveBeenCalled();
    },
  );

  it('keeps bots hidden when SearchActions has no trusted caller', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn().mockResolvedValue([]),
      loadScriptOutput: jest.fn().mockResolvedValue({ found: true, lines: [] }),
    };
    const result = await executeCanopyInjectedTool(
      'search_actions',
      {},
      runtime,
    );

    expect(JSON.parse(result.text)).toHaveProperty(
      'categories',
      expect.not.arrayContaining(['bots']),
    );
    expect(mockIsBotAccessAllowed).not.toHaveBeenCalled();
    expect(mockDispatchBotAction).not.toHaveBeenCalled();
  });

  it.each(['worktree', 'directory'] as const)(
    'routes DispatchAction through the bot service with trusted caller identity (%s)',
    async (executionScope) => {
      const runtime = makeRuntime(executionScope);
      const allowed: BotServiceResponse = {
        ok: true,
        result: { items: [], returned: 0 },
      };
      const denied: BotServiceResponse = {
        ok: false,
        error: {
          code: 'advisor_access_disabled',
          message: 'App Advisor access is disabled for this project owner.',
        },
      };
      const caller: ProjectDiscoveryCaller = {
        kind: 'project_agent',
        projectId: 'origin-project',
        worktreeId: 'origin-task',
        chatId: 'origin-chat',
      };
      for (const [index, rawAction] of botActions.entries()) {
        const action = botActionSchema.parse(rawAction);
        mockDispatchBotAction
          .mockResolvedValueOnce(allowed)
          .mockResolvedValueOnce(denied);

        const allowedResponse = await executeCanopyInjectedTool(
          'dispatch_action',
          { action },
          runtime,
        );
        expect(allowedResponse.isError).toBe(false);
        expect(JSON.parse(allowedResponse.text)).toMatchObject(allowed);
        expect(mockDispatchBotAction).toHaveBeenNthCalledWith(
          index * 2 + 1,
          action,
          caller,
        );

        const deniedResponse = await executeCanopyInjectedTool(
          'dispatch_action',
          { action },
          runtime,
        );
        expect(deniedResponse.isError).toBe(true);
        expect(JSON.parse(deniedResponse.text)).toMatchObject(denied);
        expect(mockDispatchBotAction).toHaveBeenNthCalledWith(
          index * 2 + 2,
          action,
          caller,
        );
      }
      expect(mockIsBotAccessAllowed).not.toHaveBeenCalled();
    },
  );

  it.each(['worktree', 'directory'] as const)(
    'blocks restricted direct DispatchAction before the bot service (%s)',
    async (executionScope) => {
      const runtime = makeRuntime(executionScope, ['worktree.list_scripts']);
      const search = await executeCanopyInjectedTool(
        'search_actions',
        {},
        runtime,
      );
      expect(JSON.parse(search.text)).toHaveProperty(
        'categories',
        expect.not.arrayContaining(['bots']),
      );
      for (const action of botActions) {
        const result = await executeCanopyInjectedTool(
          'dispatch_action',
          { action },
          runtime,
        );
        expect(result.isError).toBe(true);
      }
      expect(mockIsBotAccessAllowed).not.toHaveBeenCalled();
      expect(mockDispatchBotAction).not.toHaveBeenCalled();
    },
  );

  it('keeps delegate DispatchAction limited to the existing script snapshot', async () => {
    const delegate = createDelegateCanopyTools(
      {
        projectId: 'origin-project',
        worktreeId: 'origin-task',
        chatId: 'origin-chat',
        delegationId: 'delegate-1',
        provider: 'codex',
        isolated: false,
        parentCwd: '/repo',
        executionCwd: '/repo',
        codeGraphAvailable: false,
        getWindow: () => null,
        authorizeCommand: jest.fn().mockResolvedValue(true),
      },
      () => Promise.resolve(true),
    );
    const tool = delegate.tools.find(
      (entry) => entry.key === 'dispatch_action',
    );
    expect(tool).toBeDefined();
    if (!tool) throw new Error('Missing delegate DispatchAction');

    expect(DELEGATE_SCRIPT_ACTION_TYPES).toEqual([
      'worktree.list_scripts',
      'worktree.run_script',
    ]);
    for (const action of botActions) {
      const result = await delegate.execute(
        tool,
        { action },
        { callId: 'bot-discovery' },
      );
      expect(result.isError).toBe(true);
    }
    expect(mockIsBotAccessAllowed).not.toHaveBeenCalled();
    expect(mockDispatchBotAction).not.toHaveBeenCalled();
  });

  it('keeps App Advisor callers outside the project-agent access gate', async () => {
    const caller = advisorDestination();
    const runtime = createAppAdvisorToolRuntime(makeAdvisorSurfaces(), caller);
    const success: BotServiceResponse = { ok: true, result: { items: [] } };
    mockIsBotAccessAllowed.mockResolvedValue(false);
    mockDispatchBotAction.mockResolvedValue(success);

    const action = botActionSchema.parse({ type: 'bots.list' });
    const response = await runtime.dispatchRendererAction(action);

    expect(response).toMatchObject(success);
    expect(response.requestId).toEqual(expect.any(String));
    expect(mockDispatchBotAction).toHaveBeenCalledWith(action, {
      kind: 'app_advisor',
      chatId: caller.chatId,
    });
    expect(mockIsBotAccessAllowed).not.toHaveBeenCalled();
  });
});
