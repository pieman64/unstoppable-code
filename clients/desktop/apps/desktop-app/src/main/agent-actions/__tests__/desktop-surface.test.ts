import type * as AgentActionsModule from '@canopy/agent-actions';
import type * as DesktopHostModule from '../desktop-host';

const mockQuery = jest.fn();
const mockActiveTurn = jest.fn<string | undefined, [unknown]>();

jest.mock('../../services/chat-queue-service', () => ({
  getChatQueueService: (): object => ({
    runningTurnUserMessageId: (target: unknown): string | undefined =>
      mockActiveTurn(target),
  }),
}));

const mockTerminalTurn = jest.fn<
  string | undefined,
  [string, string, string]
>();

jest.mock('../../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: (): object => ({
    runningTurnUserMessageId: (
      projectId: string,
      worktreeId: string,
      chatId: string,
    ): string | undefined => mockTerminalTurn(projectId, worktreeId, chatId),
  }),
}));

const mockStartChat = jest.fn();
const mockPostMessage = jest.fn();

jest.mock('../desktop-host', () => {
  const actual =
    jest.requireActual<typeof DesktopHostModule>('../desktop-host');
  const packageActual = jest.requireActual<typeof AgentActionsModule>(
    '@canopy/agent-actions',
  );
  return {
    ...actual,
    desktopAgentActionPorts: (): object => ({
      environment: {
        query: jest.fn(),
        getChat: (input: { chatId: string }): Promise<object> =>
          Promise.resolve({
            chatId: input.chatId,
            workspaceId: 'project',
            worktreeId: 'worktree',
            title: 'Target',
            state: 'idle',
            modelId: null,
          }),
        startChat: (input: unknown): Promise<object> => {
          mockStartChat(input);
          return Promise.resolve({
            chatId: 'chat-new',
            worktreeId: 'worktree',
            delivery: 'submitted',
          });
        },
        postMessage: (input: unknown): Promise<object> => {
          mockPostMessage(input);
          return Promise.resolve({
            chatId: 'chat-target',
            delivery: 'submitted',
          });
        },
        listModels: (): Promise<object> =>
          Promise.resolve({ models: [], defaultModelId: null }),
        callerDepth: (): Promise<number> => Promise.resolve(0),
      },
      limits: packageActual.createInMemoryAgentActionLimits(),
      chatWatchers: {
        armChatCompletion: jest.fn(),
        list: (): Promise<[]> => Promise.resolve([]),
        delete: (): Promise<[]> => Promise.resolve([]),
      },
      split: { forked: jest.fn(), branched: jest.fn() },
      receipts: packageActual.createInMemoryAgentActionReceipts(),
    }),
  };
});

jest.mock('../../canopy-runtime/desktop-runtime-access', () => ({
  getDesktopCanopyRuntime: (): object => ({
    query: mockQuery,
    instruction: jest.fn(),
  }),
}));

import Ajv from 'ajv';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import {
  DELETE_WATCHERS_DESCRIPTION,
  DESKTOP_LEGACY_ACTION_JSON_ENUM_ORDER,
  DISPATCH_ACTION_DESCRIPTION,
  SEARCH_ACTIONS_DESCRIPTION,
  SEARCH_WATCHERS_DESCRIPTION,
  SETUP_WATCHERS_DESCRIPTION,
  START_BRANCHED_AGENT_DESCRIPTION,
  START_FORKED_AGENT_DESCRIPTION,
  coworkDispatchActionJsonSchema,
  deleteWatchersJsonSchema,
  dispatchActionJsonSchema,
  scopedDispatchActionSchema,
  searchActionsJsonSchema,
  searchWatchersJsonSchema,
  setupWatchersJsonSchema,
  startSplitAgentJsonSchema,
} from '../../canopy-tools/definitions';
import { DESKTOP_LEGACY_ACTION_TYPES } from '../../canopy-tools/worktree-actions';
import {
  createDesktopAgentActionSurface,
  desktopAgentActionCall,
  executeDesktopAgentActionTool,
} from '../desktop-surface';

function runtime(
  executionScope: 'worktree' | 'directory',
): CanopyInjectedToolRuntime {
  return {
    requestUserAnswers: () => Promise.resolve([]),
    loadScriptOutput: () => Promise.resolve({ found: false, lines: [] }),
    worktreeActionRuntime: {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      cwd: '/worktree',
      executionScope,
      getWindow: () => null,
    },
  };
}

const worktreeDefinitions = [
  ['SearchActions', SEARCH_ACTIONS_DESCRIPTION, searchActionsJsonSchema],
  ['DispatchAction', DISPATCH_ACTION_DESCRIPTION, dispatchActionJsonSchema],
  ['SearchWatchers', SEARCH_WATCHERS_DESCRIPTION, searchWatchersJsonSchema],
  ['SetupWatchers', SETUP_WATCHERS_DESCRIPTION, setupWatchersJsonSchema],
  ['DeleteWatchers', DELETE_WATCHERS_DESCRIPTION, deleteWatchersJsonSchema],
  [
    'StartForkedAgent',
    START_FORKED_AGENT_DESCRIPTION,
    startSplitAgentJsonSchema,
  ],
  [
    'StartBranchedAgent',
    START_BRANCHED_AGENT_DESCRIPTION,
    startSplitAgentJsonSchema,
  ],
] as const;

function advertised(
  executionScope: 'worktree' | 'directory',
): Array<[string, string, string]> {
  return createDesktopAgentActionSurface(runtime(executionScope))
    .toolDefinitions()
    .map((definition) => [
      definition.name,
      definition.description,
      JSON.stringify(definition.inputSchema),
    ]);
}

describe('desktop agent action surface', () => {
  it('advertises exactly the desktop tool definitions in a worktree chat', () => {
    expect(advertised('worktree')).toEqual(
      worktreeDefinitions.map(([name, description, schema]) => [
        name,
        description,
        JSON.stringify(schema),
      ]),
    );
  });

  it('advertises the static Cowork DispatchAction schema the surface composes', () => {
    expect(
      advertised('directory').find(([name]) => name === 'DispatchAction')?.[2],
    ).toBe(JSON.stringify(coworkDispatchActionJsonSchema));
  });

  it('omits StartBranchedAgent in a Cowork chat', () => {
    expect(advertised('directory').map(([name]) => name)).toEqual([
      'SearchActions',
      'DispatchAction',
      'SearchWatchers',
      'SetupWatchers',
      'DeleteWatchers',
      'StartForkedAgent',
    ]);
  });

  it('keeps the legacy type list, schema, and advertised enum in step', () => {
    const schemaTypes = scopedDispatchActionSchema.in.def.options.map(
      (option) => option.shape.type.value,
    );
    expect(new Set(schemaTypes)).toEqual(new Set(DESKTOP_LEGACY_ACTION_TYPES));
    expect(new Set(DESKTOP_LEGACY_ACTION_JSON_ENUM_ORDER)).toEqual(
      new Set(DESKTOP_LEGACY_ACTION_TYPES),
    );
    expect(DESKTOP_LEGACY_ACTION_JSON_ENUM_ORDER).toHaveLength(
      DESKTOP_LEGACY_ACTION_TYPES.length,
    );
  });
});

describe('desktop agent action call', () => {
  it('uses Advisor watcher scope for experiments without extending other action scopes', async () => {
    const advisor: CanopyInjectedToolRuntime = {
      ...runtime('worktree'),
      worktreeActionRuntime: undefined,
      worktreeWatcherRuntime: {
        projectId: 'advisor',
        worktreeId: 'advisor',
        chatId: 'advisor-chat',
      },
    };
    const experiment = await desktopAgentActionCall(
      'dispatch_action',
      {
        action: {
          type: 'experiments.set_enabled',
          experimentId: 'early-access',
          enabled: true,
        },
      },
      advisor,
    );
    expect(experiment.scope).toEqual({
      workspaceId: 'advisor',
      worktreeId: 'advisor',
      chatId: 'advisor-chat',
    });
    const existing = await desktopAgentActionCall(
      'dispatch_action',
      { action: { type: 'chat.list' } },
      advisor,
    );
    expect(existing.scope).toBeUndefined();
  });
  const turnKeyOf = async (
    key: Parameters<typeof desktopAgentActionCall>[0],
    args: unknown,
  ): Promise<string | undefined> =>
    (await desktopAgentActionCall(key, args, runtime('worktree'))).turnKey;
  const create = { action: { type: 'chat.create', message: 'Hi' } };

  beforeEach(() => {
    mockActiveTurn.mockReset();
    mockTerminalTurn.mockReset();
    mockQuery.mockReset();
    mockStartChat.mockReset();
    mockPostMessage.mockReset();
  });

  it('runs chat.create and chat.send_message from a managed Claude terminal turn', async () => {
    mockActiveTurn.mockReturnValue(undefined);
    mockTerminalTurn.mockReturnValue('msg-terminal-1');
    await expect(turnKeyOf('dispatch_action', create)).resolves.toBe(
      'chat:msg-terminal-1',
    );
    expect(mockTerminalTurn).toHaveBeenCalledWith(
      'project',
      'worktree',
      'chat',
    );
    const created = await executeDesktopAgentActionTool(
      'dispatch_action',
      { action: { type: 'chat.create', message: 'Review it.' } },
      runtime('worktree'),
      { toolUseId: 'terminal-create' },
    );
    expect(created.isError).toBe(false);
    expect(mockStartChat).toHaveBeenCalledTimes(1);
    const sent = await executeDesktopAgentActionTool(
      'dispatch_action',
      {
        action: {
          type: 'chat.send_message',
          chatId: 'chat-target',
          message: 'Also check the docs.',
        },
      },
      runtime('worktree'),
      { toolUseId: 'terminal-send' },
    );
    expect(sent.isError).toBe(false);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });

  it('prefers the chat queue turn over a terminal turn', async () => {
    mockActiveTurn.mockReturnValue('u7');
    mockTerminalTurn.mockReturnValue('msg-terminal-1');
    await expect(turnKeyOf('dispatch_action', create)).resolves.toBe('chat:u7');
  });

  it('keys limited writes and split agents by the turn the chat is running', async () => {
    mockActiveTurn.mockReturnValue('u7');
    await expect(turnKeyOf('dispatch_action', create)).resolves.toBe('chat:u7');
    expect(mockActiveTurn).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
    });
    await expect(
      turnKeyOf('start_forked_agent', { followUpInstruction: 'Go' }),
    ).resolves.toBe('chat:u7');
    await expect(
      turnKeyOf('start_branched_agent', { followUpInstruction: 'Go' }),
    ).resolves.toBe('chat:u7');
    await expect(
      turnKeyOf('search_actions', { query: 'chat' }),
    ).resolves.toBeUndefined();
  });

  it('keeps the turn key when a queued message is saved while the turn runs', async () => {
    mockActiveTurn.mockReturnValue('u7');
    const latestHuman = (id: string): object => ({
      messages: [],
      totalMessages: 0,
      transcriptRevision: 0,
      latestHumanMessage: { id, role: 'user', blocks: [], timestamp: 0 },
    });
    mockQuery.mockResolvedValue(latestHuman('u7'));
    const before = await turnKeyOf('dispatch_action', create);
    // The user queues another message; it is saved before its turn starts.
    mockQuery.mockResolvedValue(latestHuman('u8'));
    const after = await turnKeyOf('dispatch_action', create);
    expect(before).toBe('chat:u7');
    expect(after).toBe(before);
  });

  it('refuses a write, retryably, when the chat has no running turn', async () => {
    mockActiveTurn.mockReturnValue(undefined);
    const result = await executeDesktopAgentActionTool(
      'dispatch_action',
      create,
      runtime('worktree'),
      { toolUseId: 'tool-no-turn' },
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toEqual({
      requestId: 'tool-no-turn',
      ok: false,
      error: {
        code: 'surface_unavailable',
        message:
          'The running turn could not be identified, so nothing was changed. Retry the same call.',
        retryable: true,
      },
    });
  });
});

describe('desktop agent action tool schemas', () => {
  for (const executionScope of ['worktree', 'directory'] as const) {
    it(`compile as draft-07 JSON Schema in a ${executionScope} chat`, () => {
      const ajv = new Ajv();
      for (const definition of createDesktopAgentActionSurface(
        runtime(executionScope),
      ).toolDefinitions()) {
        expect(() => ajv.compile(definition.inputSchema)).not.toThrow();
      }
    });

    it(`keeps other actions' shared fields permissive in a ${executionScope} chat`, () => {
      const validate = new Ajv().compile(
        executionScope === 'worktree'
          ? dispatchActionJsonSchema
          : coworkDispatchActionJsonSchema,
      );
      // The project and bot families declare these names too; their
      // constraints must not reach actions that accept looser values.
      for (const action of [
        { type: 'skills.list', query: '' },
        { type: 'pipeline.list', query: '', projectId: '' },
      ])
        expect(validate({ action })).toBe(true);
    });
  }
});
