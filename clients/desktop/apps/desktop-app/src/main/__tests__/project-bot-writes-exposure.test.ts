import {
  CHAT_CREATION_ACTION_TYPES,
  CHAT_SEND_ACTION_TYPES,
  PROJECT_MESSAGE_CONTROL_ACTION_TYPES,
  type ChatCreationAction,
  type ChatSendAction,
  type ProjectsScheduleMessageAction,
  type ProjectsSteerQueuedMessageAction,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import type { ProjectDiscoveryCaller } from '../project-discovery';

const mockIsBotAccessAllowed = jest.fn<
  Promise<boolean>,
  [ProjectDiscoveryCaller]
>();
const mockSend = jest.fn<Promise<object>, [ChatSendAction, object]>();
const mockCreate = jest.fn<Promise<object>, [ChatCreationAction, object]>();
const mockSteer = jest.fn<
  Promise<object>,
  [ProjectsSteerQueuedMessageAction, object]
>();
const mockSchedule = jest.fn<
  Promise<{ receipt: object }>,
  [ProjectsScheduleMessageAction, object]
>();

jest.mock('../project-discovery/bots', (): object => ({
  get isBotAccessAllowed(): typeof mockIsBotAccessAllowed {
    return mockIsBotAccessAllowed;
  },
  dispatchBotAction: jest.fn(),
}));
jest.mock('../agent-messaging/send-orchestration', (): object => {
  const actual = jest.requireActual<object>(
    '../agent-messaging/send-orchestration',
  );
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      dispatchAgentChatSend: {
        get: () => mockSend,
        enumerable: true,
      },
    },
  );
});
jest.mock('../agent-messaging/creation-orchestration', (): object => ({
  get dispatchAgentChatCreation(): typeof mockCreate {
    return mockCreate;
  },
}));
jest.mock('../agent-messaging/steer-orchestration', (): object => ({
  get dispatchAgentChatSteer(): typeof mockSteer {
    return mockSteer;
  },
}));
jest.mock('../agent-messaging/schedule-orchestration', (): object => ({
  get dispatchAgentChatSchedule(): typeof mockSchedule {
    return mockSchedule;
  },
}));

import { appAdvisorActionSchema } from '../app-advisor/definitions';
import { AgentChatSendError } from '../agent-messaging/send-orchestration';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import { executeCanopyInjectedTool } from '../canopy-tools/core';
import { dispatchActionJsonSchema } from '../canopy-tools/definitions';
import { registeredBots } from '../project-discovery/bots/registry';

const source = {
  projectId: 'source',
  worktreeId: 'source-task',
  chatId: 'source-chat',
};

function makeRuntime(
  executionScope: 'worktree' | 'directory',
  allowedActionTypes?: readonly string[],
): CanopyInjectedToolRuntime {
  return {
    requestUserAnswers: jest.fn().mockResolvedValue([]),
    loadScriptOutput: jest.fn().mockResolvedValue({ found: true, lines: [] }),
    worktreeActionRuntime: {
      ...source,
      cwd: '/repo',
      executionScope,
      getWindow: () => null,
      ...(allowedActionTypes ? { allowedActionTypes } : {}),
    },
  };
}

/** The orchestration context a root write carries. */
function rootContext(toolUseId?: string): object {
  const admission: unknown = expect.any(Function);
  return {
    caller: { kind: 'project_root', source },
    watcherDestination: source,
    admission,
    startAdmission: admission,
    ...(toolUseId ? { toolUseId } : {}),
  };
}

interface SearchedAction {
  type: string;
  notes?: string[];
  fields: { name: string }[];
  requiredFields: string[];
}

async function search(
  input: object,
  runtime: CanopyInjectedToolRuntime,
): Promise<SearchedAction[]> {
  const result = await executeCanopyInjectedTool(
    'search_actions',
    input,
    runtime,
  );
  const value: unknown = JSON.parse(result.text);
  const actions: unknown =
    typeof value === 'object' && value !== null && 'actions' in value
      ? value.actions
      : [];
  return Array.isArray(actions)
    ? actions.filter(
        (entry: unknown): entry is SearchedAction =>
          typeof entry === 'object' && entry !== null && 'type' in entry,
      )
    : [];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsBotAccessAllowed.mockResolvedValue(true);
  mockSend.mockResolvedValue({ disposition: 'started', messageId: 'input' });
  mockCreate.mockResolvedValue({
    address: { projectId: 'target', taskId: 'task', chatId: 'chat' },
    taskCreated: true,
    chatCreated: true,
  });
  mockSteer.mockResolvedValue({ disposition: 'steered' });
  mockSchedule.mockResolvedValue({ receipt: { automationId: 'auto' } });
});

describe('phase 09 explicit sends', () => {
  it.each(CHAT_SEND_ACTION_TYPES)(
    'strictly routes %s without replacing target IDs',
    async (type) => {
      const action =
        type === 'projects.send_message'
          ? {
              type,
              projectId: 'other-project',
              taskId: 'other-task',
              chatId: 'other-chat',
              text: ' unchanged ',
            }
          : {
              type,
              botId: 'app_advisor',
              taskId: 'entry',
              chatId: 'other-chat',
              text: ' unchanged ',
            };
      const runtime = makeRuntime('worktree');
      const result = await executeCanopyInjectedTool(
        'dispatch_action',
        { action },
        runtime,
        { toolUseId: 'send-tool' },
      );
      expect(result.isError).toBe(false);
      expect(mockSend).toHaveBeenLastCalledWith(
        action,
        rootContext('send-tool'),
      );
      expect(appAdvisorActionSchema.parse(action)).toEqual(action);
      for (const field of [
        'source',
        'sender',
        'agentSent',
        'hiddenContext',
        'expectedUiRevision',
      ]) {
        const spoofed = await executeCanopyInjectedTool(
          'dispatch_action',
          { action: { ...action, [field]: 'spoof' } },
          runtime,
        );
        expect(spoofed.isError).toBe(true);
      }
      expect(mockSend).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['worktree', 'directory'] as const)(
    'advertises sends and filters bot sends per %s call',
    async (executionScope) => {
      const runtime = makeRuntime(executionScope);
      for (const type of CHAT_SEND_ACTION_TYPES) {
        const [visible] = await search({ actionType: type }, runtime);
        expect(visible?.requiredFields).toContain(
          type === 'projects.send_message' ? 'projectId' : 'botId',
        );
        expect((visible?.notes ?? []).join(' ')).not.toContain(
          'Do not provide projectId',
        );
      }
      mockIsBotAccessAllowed.mockResolvedValue(false);
      expect(
        await search({ actionType: 'bots.send_message' }, runtime),
      ).toEqual([]);
    },
  );

  it.each(['worktree', 'directory'] as const)(
    'returns the receipt of a %s root send',
    async (executionScope) => {
      const receipt = {
        address: { projectId: 'target', taskId: 'task', chatId: 'chat' },
        disposition: 'queued',
        queuedMessageId: 'queue-row',
        acceptedAt: '2026-10-17T00:00:00.000Z',
        watcherReceipts: [],
      };
      mockSend.mockResolvedValueOnce(receipt);
      const action = {
        type: 'projects.send_message',
        projectId: 'target',
        taskId: 'task',
        chatId: 'chat',
        text: ' original ',
        watchers: [{ label: 'Review done' }],
      };
      const result = await executeCanopyInjectedTool(
        'dispatch_action',
        { action },
        makeRuntime(executionScope),
        { toolUseId: 'send-tool' },
      );
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text)).toMatchObject({
        ok: true,
        result: receipt,
      });
      expect(mockSend).toHaveBeenLastCalledWith(
        action,
        rootContext('send-tool'),
      );
    },
  );

  it('keeps the pipeline-only send fields off every agent surface', async () => {
    const runtime = makeRuntime('worktree');
    const action = {
      type: 'projects.send_message',
      projectId: 'other-project',
      taskId: 'other-task',
      chatId: 'other-chat',
      text: 'text',
    };
    for (const field of [
      'turnOverride',
      'fixedIds',
      'composition',
      'newChatSeed',
      'caller',
    ]) {
      const spoofed = await executeCanopyInjectedTool(
        'dispatch_action',
        { action: { ...action, [field]: { version: 1 } } },
        runtime,
      );
      expect(spoofed.isError).toBe(true);
    }
    expect(mockSend).not.toHaveBeenCalled();
    const catalog = JSON.stringify([
      dispatchActionJsonSchema,
      appAdvisorActionSchema.safeParse({}),
    ]);
    expect(catalog).not.toContain('turnOverride');
    expect(catalog).not.toContain('fixedIds');
    expect(catalog).not.toContain('newChatSeed');
  });

  it('routes a pipeline write through the same orchestrations, never an agent action', async () => {
    const { dispatchPipelineProjectBotAction } =
      await import('../agent-actions/desktop-project-bot-port');
    const agentActions: Record<string, unknown> =
      await import('@canopy/agent-actions');
    expect(Object.keys(agentActions)).not.toContain(
      'dispatchPipelineProjectBotAction',
    );
    const receipt = { address: {}, disposition: 'started' };
    mockSend.mockResolvedValueOnce(receipt);
    const caller = {
      kind: 'pipeline',
      source: {
        executionId: 'exec',
        pipelineId: 'pipe',
        stepId: 'step',
        pipelineName: 'Pipe',
        owner: { kind: 'personal' },
      },
    } as const;
    const action = {
      type: 'projects.send_message',
      projectId: 'target',
      taskId: 'task',
      chatId: 'chat',
      text: 'text',
    } as const;
    await expect(
      dispatchPipelineProjectBotAction(action, caller, {
        turnOverride: { version: 1, planMode: true },
      }),
    ).resolves.toEqual({ ok: true, result: receipt });
    expect(mockSend).toHaveBeenLastCalledWith(action, {
      caller,
      turnOverride: { version: 1, planMode: true },
    });
    await expect(
      dispatchPipelineProjectBotAction(
        {
          type: 'projects.list',
          pageSize: 50,
          includeDefault: true,
          sort: 'name',
          order: 'asc',
        },
        caller,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported_action' },
    });
  });

  it('reports typed send refusals with their codes', async () => {
    const runtime = makeRuntime('worktree');
    const action = {
      type: 'bots.send_message',
      botId: 'app_advisor',
      taskId: 'entry',
      chatId: 'chat',
      text: 'Send',
    };
    for (const [code, expected] of [
      ['advisor_access_disabled', 'advisor_access_disabled'],
      ['owner_boundary', 'not_found'],
      ['target_not_ready', 'invalid_target'],
      ['authorization_conflict', 'authorization_conflict'],
      ['stale_ui_state', 'stale_ui_state'],
    ] as const) {
      mockSend.mockRejectedValueOnce(new AgentChatSendError(code, 'Refused.'));
      const denied = await executeCanopyInjectedTool(
        'dispatch_action',
        { action },
        runtime,
      );
      expect(denied.isError).toBe(true);
      expect(JSON.parse(denied.text)).toMatchObject({
        error: {
          code: expected,
          ...(code === 'stale_ui_state' ? { retryable: true } : {}),
        },
      });
    }
  });
});

it('advertises implemented bot send and creation capabilities', () => {
  expect(registeredBots()[0]?.capabilities).toEqual({
    listTasks: true,
    readChats: true,
    sendMessages: true,
    createTasks: true,
    createChats: true,
    watchChats: true,
  });
});

it.each([
  'worktree-chat.send_message',
  'standalone-chat.send_message',
  'advisor-chat.send_message',
])(
  'strips legacy %s sender overrides without forwarding hidden or persisted attribution',
  (type) => {
    const parsed = appAdvisorActionSchema.parse({
      type,
      projectId: 'project',
      worktreeId: 'task',
      chatId: 'chat',
      text: 'Original text',
      sender: { chatId: 'spoof' },
      agentSent: { chatTitle: 'spoof' },
      hiddenContext: [{ kind: 'agent-sender-context', text: 'spoof' }],
      agentSenderProvenance: { acceptedInputId: 'spoof' },
    });
    expect(parsed).toMatchObject({
      type,
      chatId: 'chat',
      text: 'Original text',
    });
    expect(parsed).not.toHaveProperty('sender');
    expect(parsed).not.toHaveProperty('agentSent');
    expect(parsed).not.toHaveProperty('hiddenContext');
    expect(parsed).not.toHaveProperty('agentSenderProvenance');
    expect(JSON.stringify(parsed)).not.toContain('spoof');
  },
);

const controls = [
  {
    type: 'projects.steer_queued_message',
    projectId: 'target',
    taskId: 'task',
    chatId: 'chat',
    queuedMessageId: 'queued',
  },
  {
    type: 'projects.schedule_message',
    projectId: 'target',
    taskId: 'task',
    chatId: 'chat',
    text: 'Continue',
    runAt: '2099-01-01T00:00:00Z',
  },
];
it.each(controls)(
  'exposes strict message control $type on both root surfaces',
  async (action) => {
    expect(PROJECT_MESSAGE_CONTROL_ACTION_TYPES).toContain(action.type);
    for (const executionScope of ['worktree', 'directory'] as const) {
      const runtime = makeRuntime(executionScope);
      const result = await executeCanopyInjectedTool(
        'dispatch_action',
        { action },
        runtime,
      );
      expect(result.isError).toBe(false);
      const mock =
        action.type === 'projects.steer_queued_message'
          ? mockSteer
          : mockSchedule;
      expect(mock).toHaveBeenLastCalledWith(action, rootContext());
      expect(appAdvisorActionSchema.parse(action)).toEqual(action);
      const calls = mock.mock.calls.length;
      for (const field of [
        'agentSent',
        'agentSteeringActor',
        'agentScheduledSend',
        'sender',
        'worktreeId',
        'watchers',
      ]) {
        const spoofed = await executeCanopyInjectedTool(
          'dispatch_action',
          { action: { ...action, [field]: 'spoof' } },
          runtime,
        );
        expect(spoofed.isError).toBe(true);
        expect(
          appAdvisorActionSchema.safeParse({ ...action, [field]: 'spoof' })
            .success,
        ).toBe(false);
      }
      expect(mock).toHaveBeenCalledTimes(calls);
      const [entry] = await search({ actionType: action.type }, runtime);
      expect(entry?.requiredFields).toEqual(
        expect.arrayContaining(['projectId', 'taskId', 'chatId']),
      );
    }
  },
);

describe('phase 11 explicit creation', () => {
  it.each(CHAT_CREATION_ACTION_TYPES)(
    'strictly exposes %s with explicit targets',
    async (type) => {
      const action = {
        type,
        ...(type.startsWith('projects.')
          ? { projectId: 'other-project' }
          : { botId: 'app_advisor' }),
        ...(type.endsWith('_chat')
          ? { taskId: 'other-task' }
          : { title: 'New task' }),
        initialMessage: ' unchanged ',
      };
      expect(appAdvisorActionSchema.parse(action)).toEqual(action);
      for (const executionScope of ['worktree', 'directory'] as const) {
        const runtime = makeRuntime(executionScope);
        const result = await executeCanopyInjectedTool(
          'dispatch_action',
          { action },
          runtime,
          { toolUseId: 'creation' },
        );
        expect(result.isError).toBe(false);
        expect(JSON.parse(result.text)).toMatchObject({
          ok: true,
          result: { taskCreated: true, chatCreated: true },
        });
        expect(mockCreate).toHaveBeenLastCalledWith(
          action,
          rootContext('creation'),
        );
        const calls = mockCreate.mock.calls.length;
        for (const field of [
          'chatId',
          'worktreeId',
          'source',
          'sender',
          'agentSent',
          'hiddenContext',
          'expectedUiRevision',
          'watchers',
          'queueForSetup',
        ]) {
          const spoofed = await executeCanopyInjectedTool(
            'dispatch_action',
            { action: { ...action, [field]: 'spoof' } },
            runtime,
          );
          expect(spoofed.isError).toBe(true);
          expect(
            appAdvisorActionSchema.safeParse({ ...action, [field]: 'spoof' })
              .success,
          ).toBe(false);
        }
        expect(mockCreate).toHaveBeenCalledTimes(calls);
        const [entry] = await search({ actionType: type }, runtime);
        expect(entry?.requiredFields).toContain(
          type.startsWith('projects.') ? 'projectId' : 'botId',
        );
        if (type.endsWith('_chat'))
          expect(entry?.requiredFields).toContain('taskId');
        expect(entry?.fields.map(({ name }) => name)).not.toContain(
          'worktreeId',
        );
        expect(
          await search(
            { actionType: type },
            makeRuntime(executionScope, ['worktree.list_scripts']),
          ),
        ).toEqual([]);
        if (type.startsWith('bots.')) {
          mockIsBotAccessAllowed.mockResolvedValueOnce(false);
          expect(await search({ actionType: type }, runtime)).toEqual([]);
        }
      }
      const json = JSON.stringify(dispatchActionJsonSchema);
      expect(json).toContain(type);
      expect(json).toContain('initialMessage');
    },
  );
});
