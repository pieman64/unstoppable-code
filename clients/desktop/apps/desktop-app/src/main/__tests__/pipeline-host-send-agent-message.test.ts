import type { AgentJson } from '@canopy/agent-actions';
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: jest.fn(),
  readWorkspaceWorktreesDetailed: jest.fn(),
}));
jest.mock('../lib/cowork-migration-map', () => ({
  resolveCoworkWorkspaceId: jest.fn(),
}));
jest.mock('../lib/cowork-work-entries', () => ({
  readWorkEntriesFileStrict: jest.fn(),
}));
jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
  logMainProcessError: jest.fn(),
}));
jest.mock('../services/chat-service', () => {
  class ExistingTabDispatchTargetNotFoundError extends Error {}
  return {
    ExistingTabDispatchTargetNotFoundError,
    assertTerminalChatAcceptsSettings: jest.fn(),
    buildExistingTabDispatchOptions: jest.fn(),
    isWorktreeChatMessageCommitted: jest.fn(),
  };
});
jest.mock('../agent-messaging/turn-override', () => ({
  resolveChatTurnOverride: jest.fn(),
  resolveAutomationPromptPlugins: jest.fn(),
}));
jest.mock('../lib/configured-prompt-resolution', () => ({
  resolveConfiguredPrompt: jest.fn(),
}));
jest.mock('../services/background-execution-context', () => ({
  authorizeBackgroundExecution: jest.fn(),
}));
const mockPreferences = jest.fn(
  (): Promise<Record<string, unknown>> => Promise.resolve({}),
);
jest.mock('../lib/preferences-store', () => ({
  ...jest.requireActual<object>('../lib/preferences-store'),
  readPreferencesFile: (): Promise<Record<string, unknown>> =>
    mockPreferences(),
}));
jest.mock('@canopy/desktop-shared/types', () => ({
  ...jest.requireActual<object>('@canopy/desktop-shared/types'),
  resolveKnownModel: jest.fn(),
  getProviderForModel: jest.fn(),
}));

import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  PipelineHostActionCaller,
  PipelineHostActionControls,
  PipelineHostActionResult,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import { PipelineHostRefusal } from '@canopy/desktop-shared/pipelines/host-actions';
import { AUTOMATION_IF_CMD_OUTPUT_VAR_NAMES } from '@canopy/desktop-shared/lib/automations';
import {
  emptySendAgentMessageOutputs,
  SEND_AGENT_MESSAGE_AUTHORITY_INPUTS,
  type ResolvedSendAgentMessageInputs,
} from '@canopy/desktop-shared/pipelines/host-send-agent-message';
import {
  getProviderForModel,
  resolveKnownModel,
  type ChatTabsFile,
  type CoworkWorkEntriesFile,
  type WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type { dispatchPipelineProjectBotAction } from '../agent-actions/desktop-project-bot-port';
import {
  resolveAutomationPromptPlugins,
  resolveChatTurnOverride,
} from '../agent-messaging/turn-override';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { resolveConfiguredPrompt } from '../lib/configured-prompt-resolution';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { readWorkEntriesFileStrict } from '../lib/cowork-work-entries';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesDetailed,
} from '../lib/workspace-persistence';
import { createDesktopPipelineHostActions } from '../pipelines/host-actions';
import {
  readSendJournal,
  SEND_JOURNAL_FILE,
  setBeforeSendJournalWriteForTests,
} from '../pipelines/host-send-agent-message-state';
import { authorizeBackgroundExecution } from '../services/background-execution-context';
import {
  assertTerminalChatAcceptsSettings,
  buildExistingTabDispatchOptions,
} from '../services/chat-service';

type Dispatch = typeof dispatchPipelineProjectBotAction;
type Action = Parameters<Dispatch>[0];
type Caller = Parameters<Dispatch>[1];
type Options = NonNullable<Parameters<Dispatch>[2]>;
type Response = Awaited<ReturnType<Dispatch>>;

const SECRET_TEXT = 'SENTINEL-TEXT-8b2c';
const SECRET_NAME = 'SENTINEL-NAME-3e91';
const ACCEPTED_AT = '2026-10-28T00:00:00.000Z';

const readConfig = jest.mocked(readWorkspaceConfigDetailed);
const readWorktrees = jest.mocked(readWorkspaceWorktreesDetailed);
const readEntries = jest.mocked(readWorkEntriesFileStrict);
const readTabs = jest.mocked(readChatTabsFile);
const buildTab = jest.mocked(buildExistingTabDispatchOptions);
const assertTerminal = jest.mocked(assertTerminalChatAcceptsSettings);
const resolveOverride = jest.mocked(resolveChatTurnOverride);
const resolvePlugins = jest.mocked(resolveAutomationPromptPlugins);
const resolvePrompt = jest.mocked(resolveConfiguredPrompt);
const authorize = jest.mocked(authorizeBackgroundExecution);
const knownModel = jest.mocked(resolveKnownModel);
const providerFor = jest.mocked(getProviderForModel);

function config(
  type: WorkspaceConfigFile['type'],
): Awaited<ReturnType<typeof readWorkspaceConfigDetailed>> {
  return {
    config: { version: 1, type, repos: [] } satisfies WorkspaceConfigFile,
    authority: 'ok',
    ownerMalformed: false,
    memoryMalformed: false,
  };
}

function entries(...ids: string[]): CoworkWorkEntriesFile {
  return {
    version: 1,
    entries: ids.map((id) => ({ id, createdAt: ACCEPTED_AT })),
  };
}

function tabs(
  ...list: Array<{ id: string; readOnly?: boolean }>
): ChatTabsFile {
  return {
    version: 1,
    tabs: list.map(({ id, readOnly }) => ({
      id,
      title: 'Chat',
      createdAt: ACCEPTED_AT,
      messages: [],
      ...(readOnly ? { readOnly } : {}),
    })),
    activeTabId: list[0]?.id ?? null,
  };
}

/**
 * A chat that answers a repeated command ID with its first receipt, as the
 * send orchestration's `getCommandReceipt` probe does. `messages` counts the
 * distinct messages it accepted.
 */
interface FakeChat {
  busy: boolean;
  /** Reuse an empty first chat (`chatCreated: false`) on creation. */
  reuseEmpty: boolean;
  steer: Response | 'steered';
  messages: Set<string>;
  receipts: Map<string, AgentJson>;
  calls: Array<{ action: Action; caller: Caller; options: Options }>;
  /** Throws once after the creation resolved its chat, before the message. */
  crashAfterResolve: boolean;
}

let chat: FakeChat;
let dispatch: jest.Mock<ReturnType<Dispatch>, Parameters<Dispatch>>;
let hasMessage: jest.Mock<Promise<boolean>, [unknown, string, string]>;
let assertTargetOwner: jest.Mock<Promise<void>, [unknown, unknown]>;
let artifactsDir: string;
let key: string;
let keySeq = 0;
let finalizer: (() => Promise<PipelineHostActionResult>) | undefined;

function address(
  target: { projectId?: string; botId?: string; taskId: string },
  chatId: string,
): Record<string, string> {
  return target.projectId !== undefined
    ? { projectId: target.projectId, taskId: target.taskId, chatId }
    : { botId: target.botId ?? '', taskId: target.taskId, chatId };
}

function accept(
  action: { projectId?: string; botId?: string; taskId: string },
  chatId: string,
  commandId: string,
): AgentJson {
  const prior = chat.receipts.get(commandId);
  if (prior !== undefined) return prior;
  chat.messages.add(commandId);
  const receipt: AgentJson = chat.busy
    ? {
        address: address(action, chatId),
        acceptedAt: ACCEPTED_AT,
        watcherReceipts: [],
        disposition: 'queued',
        queuedMessageId: `queued-${chat.messages.size}`,
      }
    : {
        address: address(action, chatId),
        acceptedAt: ACCEPTED_AT,
        turnId: 'turn-1',
        watcherReceipts: [],
        disposition: 'started',
        messageId: `input-${chat.messages.size}`,
      };
  chat.receipts.set(commandId, receipt);
  return receipt;
}

async function fakeDispatch(
  action: Action,
  caller: Caller,
  options: Options = {},
): Promise<Response> {
  chat.calls.push({ action, caller, options });
  const commandId = options.fixedIds?.commandId ?? 'none';
  switch (action.type) {
    case 'projects.send_message':
    case 'bots.send_message':
      return { ok: true, result: accept(action, action.chatId, commandId) };
    case 'projects.create_task_chat':
    case 'bots.create_task_chat': {
      const fixedTab = options.fixedIds?.tabId ?? 'new-tab';
      const created = !(chat.reuseEmpty || options.fixedIds?.reusedTab);
      const chatId = created ? fixedTab : 'empty-tab';
      await options.onChatResolved?.({ chatId, created });
      if (chat.crashAfterResolve) {
        chat.crashAfterResolve = false;
        throw new Error('app stopped');
      }
      return {
        ok: true,
        result: {
          address: address(action, chatId),
          taskCreated: false,
          chatCreated: created,
          input: accept(action, chatId, commandId),
        },
      };
    }
    case 'projects.steer_queued_message':
      if (chat.steer !== 'steered') return chat.steer;
      return {
        ok: true,
        result: {
          address: address(action, action.chatId),
          queuedMessageId: action.queuedMessageId,
          disposition: 'steered',
          steeredAt: ACCEPTED_AT,
        },
      };
    default:
      return { ok: false, error: { code: 'unsupported_action', message: 'x' } };
  }
}

function caller(
  overrides: Partial<PipelineHostActionCaller> = {},
): PipelineHostActionCaller {
  return {
    executionId: 'exec-1',
    pipelineId: 'pipe-1',
    jobId: 'job',
    stepId: 'send',
    attempt: 0,
    iteration: 0,
    idempotencyKey: key,
    ...overrides,
  };
}

function controls(): PipelineHostActionControls {
  return {
    deadlineAt: Date.now() + 60_000,
    artifactsDir,
    registerTimeoutFinalizer: (finalize): void => {
      finalizer = finalize;
    },
  };
}

function host(): ReturnType<typeof createDesktopPipelineHostActions> {
  return createDesktopPipelineHostActions({
    assertTargetOwner,
    sendDispatch: dispatch,
    hasTranscriptMessage: hasMessage,
  });
}

function inputs(
  overrides: Partial<ResolvedSendAgentMessageInputs> = {},
): ResolvedSendAgentMessageInputs {
  return {
    target: { kind: 'project', projectId: 'p', taskId: 't', chatId: 'c' },
    text: SECRET_TEXT,
    mode: 'queue',
    settings: {},
    ...overrides,
  };
}

function send(
  request: ResolvedSendAgentMessageInputs = inputs(),
  options: {
    caller?: Partial<PipelineHostActionCaller>;
    signal?: AbortSignal;
    hostActions?: ReturnType<typeof host>;
  } = {},
): Promise<PipelineHostActionResult> {
  return (options.hostActions ?? host()).run(
    { action: 'send-agent-message', inputs: request },
    caller(options.caller),
    options.signal ?? new AbortController().signal,
    controls(),
  );
}

function journalText(): string {
  return readFileSync(path.join(artifactsDir, SEND_JOURNAL_FILE), 'utf8');
}

function actionsOf(type: Action['type']): Action[] {
  return chat.calls
    .map(({ action }) => action)
    .filter((action) => action.type === type);
}

function lastOptions(): Options {
  const call = chat.calls.at(-1);
  if (!call) throw new Error('nothing dispatched');
  return call.options;
}

beforeEach(() => {
  jest.resetAllMocks();
  setBeforeSendJournalWriteForTests(undefined);
  finalizer = undefined;
  artifactsDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-send-host-'));
  key = `pipeline-host:exec-1:job::send:${++keySeq}:0`;
  chat = {
    busy: false,
    reuseEmpty: false,
    steer: 'steered',
    messages: new Set(),
    receipts: new Map(),
    calls: [],
    crashAfterResolve: false,
  };
  dispatch = jest.fn(fakeDispatch);
  hasMessage = jest.fn<Promise<boolean>, [unknown, string, string]>(() =>
    Promise.resolve(false),
  );
  assertTargetOwner = jest.fn<Promise<void>, [unknown, unknown]>(() =>
    Promise.resolve(),
  );
  readConfig.mockResolvedValue(config('cowork'));
  jest.mocked(resolveCoworkWorkspaceId).mockImplementation((id) => id);
  readEntries.mockResolvedValue(entries('t'));
  readWorktrees.mockResolvedValue({
    worktrees: [],
    authority: 'ok',
  } as unknown as Awaited<ReturnType<typeof readWorkspaceWorktreesDetailed>>);
  readTabs.mockResolvedValue(tabs({ id: 'c' }));
  buildTab.mockResolvedValue({});
  resolveOverride.mockResolvedValue({ version: 1 });
  authorize.mockResolvedValue({ allow: true });
});

afterEach(() => {
  setBeforeSendJournalWriteForTests(undefined);
  rmSync(artifactsDir, { recursive: true, force: true });
});

describe('the state table', () => {
  it('sends to an idle chat', async () => {
    const result = await send();
    const userMessageId = lastOptions().fixedIds?.userMessageId;

    expect(userMessageId).toEqual(expect.any(String));
    expect(result).toEqual({
      status: 'success',
      outputs: {
        ...emptySendAgentMessageOutputs(),
        project_id: 'p',
        task_id: 't',
        chat_id: 'c',
        state: 'sent',
        chat_created: 'false',
        message_id: 'input-1',
        turn_id: 'turn-1',
        accepted_at: ACCEPTED_AT,
      },
      chatSend: {
        version: 1,
        address: { kind: 'project', projectId: 'p', taskId: 't', chatId: 'c' },
        userMessageId,
        state: 'sent',
        chatCreated: false,
        acceptedAt: ACCEPTED_AT,
        turnId: 'turn-1',
      },
    });
  });

  it('queues behind a running turn', async () => {
    chat.busy = true;

    const result = await send();

    expect(result.outputs.state).toBe('queued');
    expect(result.outputs.queued_message_id).toBe('queued-1');
    expect(result.chatSend?.queuedMessageId).toBe('queued-1');
    expect(actionsOf('projects.steer_queued_message')).toHaveLength(0);
  });

  it('steers into a running turn with the journaled steer id', async () => {
    chat.busy = true;

    const result = await send(inputs({ mode: 'steer' }));

    expect(result.status).toBe('success');
    expect(result.outputs.state).toBe('steered');
    expect(result.chatSend?.state).toBe('steered');
    expect(actionsOf('projects.steer_queued_message')).toEqual([
      {
        type: 'projects.steer_queued_message',
        projectId: 'p',
        taskId: 't',
        chatId: 'c',
        queuedMessageId: 'queued-1',
      },
    ]);
    expect(lastOptions().fixedIds?.steerCommandId).toEqual(expect.any(String));
  });

  it('leaves the message queued when the chat cannot steer', async () => {
    chat.busy = true;
    chat.steer = {
      ok: false,
      error: { code: 'missing_capability', message: 'No steering.' },
    };

    const result = await send(inputs({ mode: 'steer' }));

    expect(result.status).toBe('success');
    expect(result.outputs.state).toBe('queued');
    expect(result.outputs.steer_unavailable_reason).toBe('missing_capability');
  });

  it('reports sent without steering when the turn started', async () => {
    const result = await send(inputs({ mode: 'steer' }));

    expect(result.outputs.state).toBe('sent');
    expect(actionsOf('projects.steer_queued_message')).toHaveLength(0);
  });

  describe('a steer refused because the turn took the row (decision C)', () => {
    const notFound: Response = {
      ok: false,
      error: { code: 'not_found', message: 'Chat was not found.' },
    };

    beforeEach(() => {
      chat.busy = true;
      chat.steer = notFound;
    });

    function steerHost(): ReturnType<typeof host> {
      return createDesktopPipelineHostActions({
        assertTargetOwner,
        sendDispatch: dispatch,
        hasTranscriptMessage: hasMessage,
      });
    }

    it('reports sent when the message is in the transcript', async () => {
      hasMessage.mockResolvedValue(true);

      const result = await send(inputs({ mode: 'steer' }));

      expect(result.outputs.state).toBe('sent');
      expect(hasMessage).toHaveBeenCalledWith(
        { projectId: 'p', worktreeId: 't' },
        'c',
        result.chatSend?.userMessageId,
      );
    });

    it('reports sent when the message lands by the re-check', async () => {
      hasMessage.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      const result = await send(inputs({ mode: 'steer' }), {
        hostActions: steerHost(),
      });

      expect(result.outputs.state).toBe('sent');
      expect(hasMessage).toHaveBeenCalledTimes(2);
    });

    it('fails not_found but keeps the accepted message (decision E)', async () => {
      const result = await send(inputs({ mode: 'steer' }));

      expect(result.status).toBe('failure');
      expect(result).toMatchObject({
        failureReason: 'not_found',
        error: "The queued message isn't waiting in chat `c` anymore",
        outputs: { state: 'queued', queued_message_id: 'queued-1' },
        chatSend: { state: 'queued', queuedMessageId: 'queued-1' },
      });
      expect(hasMessage).toHaveBeenCalledTimes(2);
      expect(JSON.parse(journalText())).toMatchObject({
        phase: 'done',
        result: { chatSend: { state: 'queued' } },
      });
    });
  });

  it('keeps the queued message when the steer fails unexpectedly (decision E)', async () => {
    chat.busy = true;
    chat.steer = { ok: true, result: { unexpected: true } };

    const result = await send(inputs({ mode: 'steer' }));

    expect(result).toMatchObject({
      status: 'failure',
      failureReason: 'target_not_ready',
      outputs: { state: 'queued', queued_message_id: 'queued-1' },
      chatSend: { state: 'queued', queuedMessageId: 'queued-1' },
    });
    // Not terminal: resuming the attempt steers again with the same IDs.
    expect(JSON.parse(journalText())).toMatchObject({ phase: 'steering' });
  });

  it('creates a chat when none is given', async () => {
    const result = await send(
      inputs({ target: { kind: 'project', projectId: 'p', taskId: 't' } }),
    );

    const [creation] = actionsOf('projects.create_task_chat');
    expect(creation).toEqual({
      type: 'projects.create_task_chat',
      projectId: 'p',
      taskId: 't',
      initialMessage: SECRET_TEXT,
    });
    const tabId = lastOptions().fixedIds?.tabId;
    expect(result.outputs).toMatchObject({
      state: 'sent',
      chat_created: 'true',
      chat_id: tabId,
    });
    expect(result.chatSend?.chatCreated).toBe(true);
    expect(lastOptions()).not.toHaveProperty('newChatSeed');
  });

  it('reports a reused empty chat as not created', async () => {
    chat.reuseEmpty = true;

    const result = await send(
      inputs({ target: { kind: 'project', projectId: 'p', taskId: 't' } }),
    );

    expect(result.outputs).toMatchObject({
      chat_created: 'false',
      chat_id: 'empty-tab',
    });
  });

  it('passes new-chat settings as the seed', async () => {
    knownModel.mockReturnValue('opus');
    providerFor.mockReturnValue('claude');

    await send(
      inputs({
        target: { kind: 'project', projectId: 'p', taskId: 't' },
        settings: {
          model: 'opus',
          planMode: true,
          thinkingEffort: 'high',
          interfaceMode: 'canopy',
        },
      }),
    );

    expect(lastOptions().newChatSeed).toEqual({
      model: 'opus',
      providerType: 'claude',
      modelConfig: { thinkingLevel: 'high' },
      planMode: true,
      interfaceMode: 'canopy',
    });
  });

  it('waits for setup in a code task only', async () => {
    readConfig.mockResolvedValue(config('single-repo'));
    readWorktrees.mockResolvedValue({
      worktrees: [{ id: 't' }],
      authority: 'ok',
    } as unknown as Awaited<ReturnType<typeof readWorkspaceWorktreesDetailed>>);
    await send();
    expect(actionsOf('projects.send_message').at(-1)).toMatchObject({
      queueForSetup: true,
    });

    key = `${key}-cowork`;
    readConfig.mockResolvedValue(config('cowork'));
    await send();
    expect(actionsOf('projects.send_message').at(-1)).not.toHaveProperty(
      'queueForSetup',
    );
  });

  it('sends to an Orchestrator chat without waiting for setup', async () => {
    readEntries.mockResolvedValue(entries('t'));

    const result = await send(
      inputs({
        target: { kind: 'bot', botId: 'app_advisor', taskId: 't', chatId: 'c' },
      }),
    );

    expect(actionsOf('bots.send_message')).toEqual([
      {
        type: 'bots.send_message',
        botId: 'app_advisor',
        taskId: 't',
        chatId: 'c',
        text: SECRET_TEXT,
      },
    ]);
    expect(result.outputs).toMatchObject({
      bot_id: 'app_advisor',
      project_id: '',
    });
    expect(result.chatSend?.address).toEqual({
      kind: 'bot',
      botId: 'app_advisor',
      taskId: 't',
      chatId: 'c',
    });
  });
});

describe('refusals', () => {
  it('refuses to steer an Orchestrator chat after the owner check', async () => {
    const result = await send(
      inputs({
        target: { kind: 'bot', botId: 'app_advisor', taskId: 't', chatId: 'c' },
        mode: 'steer',
      }),
    );

    expect(result).toEqual({
      status: 'failure',
      failureReason: 'unsupported_action',
      error: "Orchestrator chats can't be steered",
      outputs: emptySendAgentMessageOutputs(),
    });
    expect(assertTargetOwner).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('reads a cross-owner project like a missing one, before the journal', async () => {
    assertTargetOwner.mockRejectedValue(
      new PipelineHostRefusal(
        'not_found',
        "Project `p` isn't available to this pipeline",
      ),
    );

    const result = await send(inputs({ mode: 'steer' }));

    expect(result).toMatchObject({
      failureReason: 'not_found',
      error: "Project `p` isn't available to this pipeline",
    });
    expect(existsSync(path.join(artifactsDir, SEND_JOURNAL_FILE))).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses a chat that is not in the task, naming only ids', async () => {
    readTabs.mockResolvedValue(tabs({ id: 'other' }));

    const result = await send();

    expect(result).toEqual({
      status: 'failure',
      failureReason: 'not_found',
      error: "Chat `c` isn't in task `t`",
      outputs: emptySendAgentMessageOutputs(),
    });
  });

  it('throws on an unreadable tabs file instead of reporting a miss', async () => {
    readTabs.mockRejectedValue(new Error('EACCES'));

    await expect(send()).rejects.toThrow('EACCES');
  });

  it('refuses a read-only chat', async () => {
    readTabs.mockResolvedValue(tabs({ id: 'c', readOnly: true }));

    const result = await send();

    expect(result).toMatchObject({ failureReason: 'unsupported_action' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses an unparseable owner context', async () => {
    const result = await send(inputs(), {
      caller: { executionContext: 'garbage:{' },
    });

    expect(result).toMatchObject({
      failureReason: 'owner_context_unavailable',
    });
  });

  it.each([
    ['advisor_access_disabled', 'advisor_access_disabled'],
    ['owner_context_unavailable', 'owner_context_unavailable'],
    ['validation_failed', 'validation_failed'],
    ['invalid_target', 'target_not_ready'],
    ['unsupported_action', 'unsupported_action'],
    ['authorization_conflict', 'authorization_conflict'],
    ['idempotency_conflict', 'authorization_conflict'],
  ])('maps a %s send refusal to %s with every output', async (code, reason) => {
    dispatch.mockResolvedValueOnce({
      ok: false,
      error: { code, message: 'No.' },
    });

    const result = await send();

    expect(result.status).toBe('failure');
    expect(result).toMatchObject({ failureReason: reason });
    expect(Object.keys(result.outputs).sort()).toEqual(
      Object.keys(emptySendAgentMessageOutputs()).sort(),
    );
    expect(result).not.toHaveProperty('chatSend');
  });

  it('names the chat it created when the first message is refused', async () => {
    dispatch.mockImplementationOnce(async (_action, _caller, options = {}) => {
      await options.onChatResolved?.({ chatId: 'new-tab', created: true });
      return {
        ok: false,
        error: { code: 'validation_failed', message: 'No.' },
      };
    });

    const result = await send(
      inputs({ target: { kind: 'project', projectId: 'p', taskId: 't' } }),
    );

    expect(result).toMatchObject({
      failureReason: 'validation_failed',
      outputs: { chat_id: 'new-tab', chat_created: 'true' },
    });
    expect(result).not.toHaveProperty('chatSend');
  });

  it('fills every output on a host refusal', async () => {
    readEntries.mockResolvedValue(entries());

    const result = await send();

    expect(result).toMatchObject({ failureReason: 'not_found' });
    expect(result.outputs).toEqual(emptySendAgentMessageOutputs());
  });
});

describe('settings', () => {
  const agentOrigin = { projectId: 'ap', worktreeId: 'aw', chatId: 'ac' };

  it.each(SEND_AGENT_MESSAGE_AUTHORITY_INPUTS)(
    'refuses %s on an existing chat in an agent-started run',
    async (input) => {
      const settings = {
        approval_mode: { approvalMode: 'auto' as const },
        model: { model: 'opus' },
        plan_mode: { planMode: true },
        plugins: {
          plugins: [
            {
              type: 'skill' as const,
              source: { type: 'builtin' as const, id: 'app' },
              skill_name: 'x',
            },
          ],
        },
      }[input];

      const result = await send(inputs({ settings }), {
        caller: { agentOrigin },
      });

      expect(result).toMatchObject({
        failureReason: 'authorization_conflict',
      });
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it('passes the agent origin through the sender source', async () => {
    await send(inputs({ settings: { thinkingEffort: 'low' } }), {
      caller: { agentOrigin },
    });

    expect(chat.calls[0]?.caller.source.agentOrigin).toEqual(agentOrigin);
  });

  it('passes a user-started run’s override for the turn', async () => {
    resolveOverride.mockResolvedValue({ version: 1, model: 'opus' });

    await send(inputs({ settings: { model: 'opus' } }));

    expect(resolveOverride).toHaveBeenCalledWith(
      { projectId: 'p', worktreeId: 't', chatId: 'c' },
      {},
      { model: 'opus' },
      undefined,
    );
    expect(lastOptions().turnOverride).toEqual({ version: 1, model: 'opus' });
  });

  it('checks a terminal chat accepts the override before sending', async () => {
    resolveOverride.mockResolvedValue({
      version: 1,
      model: 'opus',
      providerType: 'claude',
      executionHarness: 'claude',
      resetRuntime: true,
      modelConfig: { thinkingLevel: 'high' },
      planMode: true,
      approvalMode: 'ask',
      pluginSelections: {
        collectionIds: ['col-1'],
        skillRefs: [],
        pluginRefs: [],
      },
    });

    await send(inputs({ settings: { model: 'opus', planMode: true } }));

    expect(assertTerminal).toHaveBeenCalledWith(
      { projectId: 'p', worktreeId: 't', chatId: 'c' },
      {
        model: 'opus',
        providerType: 'claude',
        executionHarness: 'claude',
        modelConfig: { thinkingLevel: 'high' },
        planMode: true,
        approvalMode: 'ask',
        pluginSelections: {
          collectionIds: ['col-1'],
          skillRefs: [],
          pluginRefs: [],
        },
      },
    );
  });

  it('refuses settings a terminal chat would not apply, before sending', async () => {
    resolveOverride.mockResolvedValue({ version: 1, planMode: true });
    assertTerminal.mockRejectedValue(
      new Error('Scheduled terminal chat settings differ from the live chat.'),
    );

    const result = await send(inputs({ settings: { planMode: true } }));

    expect(result).toMatchObject({
      status: 'failure',
      failureReason: 'validation_failed',
      error: 'Scheduled terminal chat settings differ from the live chat.',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('drops an empty override', async () => {
    await send();

    expect(lastOptions()).not.toHaveProperty('turnOverride');
  });

  it('maps an override error to validation_failed', async () => {
    resolveOverride.mockRejectedValue(
      new Error('The automation model is unavailable.'),
    );

    const result = await send(inputs({ settings: { model: 'nope' } }));

    expect(result).toMatchObject({
      failureReason: 'validation_failed',
      error: 'The automation model is unavailable.',
    });
  });

  it('refuses plugins the owner may not use', async () => {
    resolveOverride.mockResolvedValue({
      version: 1,
      pluginSelections: {
        collectionIds: ['col-1'],
        skillRefs: [],
        pluginRefs: [],
      },
    });
    authorize.mockResolvedValue({ allow: false, reason: 'unsupported-target' });

    const result = await send();

    expect(result).toMatchObject({ failureReason: 'authorization_conflict' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses an unknown model for a new chat', async () => {
    knownModel.mockReturnValue(undefined);

    const result = await send(
      inputs({
        target: { kind: 'project', projectId: 'p', taskId: 't' },
        settings: { model: 'not-a-model' },
      }),
    );

    expect(result).toMatchObject({ failureReason: 'validation_failed' });
  });

  it('refuses a known model with no available provider for a new chat', async () => {
    knownModel.mockReturnValue('agent:unavailable');
    providerFor.mockReturnValue(undefined);

    const result = await send(
      inputs({
        target: { kind: 'project', projectId: 'p', taskId: 't' },
        settings: { model: 'agent:unavailable' },
      }),
    );

    expect(result).toMatchObject({ failureReason: 'validation_failed' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses interface_mode with a model that is not Claude', async () => {
    knownModel.mockReturnValue('gpt-x');
    providerFor.mockReturnValue('codex');

    const result = await send(
      inputs({
        target: { kind: 'project', projectId: 'p', taskId: 't' },
        settings: { model: 'gpt-x', interfaceMode: 'canopy' },
      }),
    );

    expect(result).toMatchObject({ failureReason: 'validation_failed' });
  });

  it('puts new-chat plugins on the seed', async () => {
    resolvePlugins.mockResolvedValue({
      collectionIds: ['col-1'],
      skillRefs: [],
      pluginRefs: [],
    });

    await send(
      inputs({
        target: { kind: 'project', projectId: 'p', taskId: 't' },
        settings: {
          plugins: [
            {
              type: 'skill',
              source: { type: 'builtin', id: 'app' },
              skill_name: 'x',
            },
          ],
        },
      }),
    );

    expect(lastOptions().newChatSeed?.pluginSelections).toEqual({
      collectionIds: ['col-1'],
      skillRefs: [],
      pluginRefs: [],
    });
  });

  it('resolves text_references into the composition and override', async () => {
    const fileReferences = [{ path: 'notes.md' }];
    resolvePrompt.mockResolvedValue({
      prompt: 'resolved',
      fileReferences,
      referencedPluginSelections: { collectionIds: ['col-2'] },
    } as unknown as Awaited<ReturnType<typeof resolveConfiguredPrompt>>);

    await send(
      inputs({
        text: '@notes.md',
        textReferences: [
          {
            kind: 'file',
            textStart: 0,
            displayText: '@notes.md',
            root: { kind: 'workspace' },
            relativePath: 'notes.md',
          },
        ],
        attachments: ['/abs/work/a.txt'],
      }),
    );

    expect(actionsOf('projects.send_message')[0]).toMatchObject({
      text: 'resolved',
    });
    expect(lastOptions().composition).toEqual({
      fileReferences,
      attachmentPaths: ['/abs/work/a.txt'],
    });
    expect(resolveOverride.mock.calls[0]?.[3]).toEqual({
      collectionIds: ['col-2'],
    });
  });

  it('names an automation and the pipeline in the sender source', async () => {
    await send(inputs(), {
      caller: {
        pipelineName: SECRET_NAME,
        initiator: { kind: 'automation', automationId: 'auto-1' },
      },
    });
    await send(inputs(), {
      caller: { idempotencyKey: `${key}-2`, pipelineName: '' },
    });

    expect(chat.calls[0]?.caller.source).toMatchObject({
      pipelineName: SECRET_NAME,
      automation: { automationId: 'auto-1', automationName: 'auto-1' },
    });
    expect(chat.calls[1]?.caller.source).toMatchObject({
      pipelineName: 'pipe-1',
    });
    expect(chat.calls[1]?.caller.source).not.toHaveProperty('automation');
  });
});

describe('replay', () => {
  function crashOn(phase: string): void {
    setBeforeSendJournalWriteForTests((record) => {
      if (record.phase === phase) throw new Error('app stopped');
    });
  }

  it.each(['owner_context_unavailable', 'stale_ui_state', 'in_progress'])(
    'sends again with the same IDs after a %s refusal',
    async (code) => {
      dispatch.mockResolvedValueOnce({
        ok: false,
        error: { code, message: 'Try again.' },
      });
      const refused = await send();
      expect(refused.status).toBe('failure');
      expect(JSON.parse(journalText())).toMatchObject({ phase: 'sending' });

      const replay = await send();

      expect(replay.status).toBe('success');
      expect(chat.messages.size).toBe(1);
      const [a, b] = dispatch.mock.calls.map(
        ([, , options]) => options?.fixedIds,
      );
      expect(a?.commandId).toBeDefined();
      expect(b).toEqual(a);
    },
  );

  it.each(['owner_context_unavailable', 'stale_ui_state', 'in_progress'])(
    'steers again after a %s steer refusal',
    async (code) => {
      chat.busy = true;
      chat.steer = { ok: false, error: { code, message: 'Try again.' } };
      const refused = await send(inputs({ mode: 'steer' }));
      expect(refused).toMatchObject({
        status: 'failure',
        chatSend: { state: 'queued' },
      });
      expect(JSON.parse(journalText())).toMatchObject({ phase: 'steering' });

      chat.steer = 'steered';
      const replay = await send(inputs({ mode: 'steer' }));

      expect(replay.outputs.state).toBe('steered');
      expect(chat.messages.size).toBe(1);
    },
  );

  it('returns a recorded permanent refusal without sending again', async () => {
    dispatch.mockResolvedValueOnce({
      ok: false,
      error: { code: 'validation_failed', message: 'No.' },
    });
    const refused = await send();

    const replay = await send();

    expect(replay).toEqual(refused);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('returns the original receipt after a crash before done', async () => {
    crashOn('done');
    const first = await send();
    setBeforeSendJournalWriteForTests(undefined);
    expect(JSON.parse(journalText())).toMatchObject({ phase: 'sending' });

    const replay = await send();

    expect(replay).toEqual(first);
    expect(chat.messages.size).toBe(1);
    const [a, b] = actionsOf('projects.send_message').map(
      (_action, index) => chat.calls[index]?.options.fixedIds,
    );
    expect(b).toEqual(a);
  });

  it('reuses the created chat after a crash before its message', async () => {
    chat.crashAfterResolve = true;
    const request = inputs({
      target: { kind: 'project', projectId: 'p', taskId: 't' },
    });

    await expect(send(request)).rejects.toThrow('app stopped');
    const read = await readSendJournal(artifactsDir, key);
    if (read.kind !== 'present') throw new Error('no journal');
    const journaled = read.record;
    expect(journaled.phase).toBe('sending');

    const replay = await send(request);

    expect(replay.outputs).toMatchObject({
      chat_id: journaled.ids.tabId,
      chat_created: 'true',
    });
    expect(lastOptions().fixedIds?.tabId).toBe(journaled.ids.tabId);
    expect(chat.messages.size).toBe(1);
  });

  it('replays an accepted steer with the same steer id', async () => {
    chat.busy = true;
    crashOn('done');
    await send(inputs({ mode: 'steer' }));
    setBeforeSendJournalWriteForTests(undefined);

    const replay = await send(inputs({ mode: 'steer' }));

    expect(replay.outputs.state).toBe('steered');
    const steers = chat.calls.filter(
      ({ action }) => action.type === 'projects.steer_queued_message',
    );
    expect(steers).toHaveLength(2);
    expect(steers[1]?.options.fixedIds?.steerCommandId).toBe(
      steers[0]?.options.fixedIds?.steerCommandId,
    );
    expect(chat.messages.size).toBe(1);
  });

  it('replays an Orchestrator send with the same ids after a crash before done', async () => {
    const request = inputs({
      target: { kind: 'bot', botId: 'app_advisor', taskId: 't', chatId: 'c' },
    });
    crashOn('done');
    const first = await send(request);
    setBeforeSendJournalWriteForTests(undefined);

    const replay = await send(request);

    expect(replay).toEqual(first);
    expect(chat.messages.size).toBe(1);
    const [a, b] = chat.calls
      .filter(({ action }) => action.type === 'bots.send_message')
      .map(({ options }) => options.fixedIds);
    expect(b).toEqual(a);
  });

  it('replays an unchanged attachment to the original receipt', async () => {
    const request = inputs({ attachments: ['/runs/exec-1/workspace/a.md'] });
    crashOn('done');
    const first = await send(request);
    setBeforeSendJournalWriteForTests(undefined);

    const replay = await send(
      inputs({ attachments: ['/runs/exec-1/workspace/a.md'] }),
    );

    expect(replay).toEqual(first);
    expect(chat.messages.size).toBe(1);
    expect(lastOptions().composition).toEqual({
      attachmentPaths: ['/runs/exec-1/workspace/a.md'],
    });
  });

  it('returns a done result without dispatching again', async () => {
    const first = await send();
    const again = await send();

    expect(again).toEqual(first);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('refuses a changed request under the same key', async () => {
    crashOn('done');
    await send();
    setBeforeSendJournalWriteForTests(undefined);

    const result = await send(
      inputs({ text: 'different text from a changed file' }),
    );

    expect(result).toMatchObject({
      failureReason: 'authorization_conflict',
      error: 'This step already ran with different inputs',
    });
    expect(chat.messages.size).toBe(1);
  });

  it('replays to the original receipt when a referenced file changed', async () => {
    const request = inputs({
      text: '@a.md',
      textReferences: [
        {
          kind: 'file',
          textStart: 0,
          displayText: '@a.md',
          root: { kind: 'workspace' },
          relativePath: 'a.md',
        },
      ],
    });
    resolvePrompt.mockResolvedValueOnce({ prompt: 'v1' });
    crashOn('done');
    const first = await send(request);
    setBeforeSendJournalWriteForTests(undefined);
    resolvePrompt.mockResolvedValueOnce({ prompt: 'v2' });

    const replay = await send(request);

    expect(replay).toEqual(first);
    expect(chat.messages.size).toBe(1);
  });

  it('sends again on a new attempt with new ids', async () => {
    await send();
    key = `${key}-retry`;
    await send();

    expect(chat.messages.size).toBe(2);
    const ids = chat.calls.map(({ options }) => options.fixedIds?.commandId);
    expect(new Set(ids).size).toBe(2);
  });

  it('gives two executions of the same step different ids', async () => {
    await send(inputs(), { caller: { executionId: 'exec-a' } });
    key = 'pipeline-host:exec-b:job::send:0:0';
    await send(inputs(), { caller: { executionId: 'exec-b' } });

    const [a, b] = chat.calls.map(({ options }) => options.fixedIds);
    expect(a?.commandId).not.toBe(b?.commandId);
    expect(a?.userMessageId).not.toBe(b?.userMessageId);
  });
});

describe('cancellation, concurrency and timeouts', () => {
  function deferredDispatch(): { release: () => void } {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    dispatch.mockImplementationOnce(async (...args) => {
      await gate;
      return fakeDispatch(...args);
    });
    return { release: () => release() };
  }

  it('finishes and journals a send whose caller aborted after dispatch', async () => {
    const { release } = deferredDispatch();
    const controller = new AbortController();
    const hostActions = host();

    const pending = send(inputs(), { signal: controller.signal, hostActions });
    await new Promise((resolve) => setImmediate(resolve));
    while (dispatch.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(JSON.parse(journalText())).toMatchObject({ phase: 'done' });
    const replay = await send(inputs(), { hostActions });
    expect(replay.outputs.state).toBe('sent');
    expect(chat.messages.size).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when aborted before the journal write', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      send(inputs(), { signal: controller.signal }),
    ).rejects.toThrow();

    expect(dispatch).not.toHaveBeenCalled();
    expect(existsSync(path.join(artifactsDir, SEND_JOURNAL_FILE))).toBe(false);
  });

  it('shares one operation between concurrent callers', async () => {
    const { release } = deferredDispatch();
    const hostActions = host();

    const first = send(inputs(), { hostActions });
    const second = send(inputs(), { hostActions });
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual(b);
    expect(dispatch).toHaveBeenCalledTimes(1);
    // The live entry is gone once the operation settled: a later call reads the journal.
    await send(inputs(), { hostActions });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('times out as target_not_ready before acceptance and with the send after', async () => {
    const { release } = deferredDispatch();
    const pending = send();
    while (dispatch.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const before = await finalizer?.();
    expect(before).toMatchObject({
      status: 'failure',
      failureReason: 'target_not_ready',
      error:
        'Timed out before the chat confirmed the message. Check the chat before retrying: a retry sends it again.',
    });
    expect(before?.outputs).toMatchObject({ project_id: 'p', chat_id: 'c' });

    release();
    const result = await pending;
    expect(await finalizer?.()).toEqual(result);
  });

  it('times out naming the chat it created before its message', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resolved = false;
    dispatch.mockImplementationOnce(async (action, caller, options = {}) =>
      fakeDispatch(action, caller, {
        ...options,
        onChatResolved: async (chat) => {
          await options.onChatResolved?.(chat);
          resolved = true;
          await gate;
        },
      }),
    );
    const pending = send(
      inputs({ target: { kind: 'project', projectId: 'p', taskId: 't' } }),
    );
    while (!resolved) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const read = await readSendJournal(artifactsDir, key);
    const chatId = read.kind === 'present' ? read.record.chatId : undefined;
    expect(chatId).toBeDefined();
    expect(await finalizer?.()).toMatchObject({
      failureReason: 'target_not_ready',
      outputs: { chat_id: chatId, chat_created: 'true' },
    });

    release();
    await pending;
  });

  it('times out with the queued send while its steer is pending (decision E)', async () => {
    chat.busy = true;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    dispatch.mockImplementation(async (action, ...rest) => {
      if (action.type === 'projects.steer_queued_message') await gate;
      return fakeDispatch(action, ...rest);
    });
    const pending = send(inputs({ mode: 'steer' }));
    while (
      !dispatch.mock.calls.some(
        ([action]) => action.type === 'projects.steer_queued_message',
      )
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const timedOut = await finalizer?.();
    expect(timedOut).toMatchObject({
      status: 'failure',
      failureReason: 'target_not_ready',
      outputs: { chat_id: 'c', state: 'queued', queued_message_id: 'queued-1' },
      chatSend: { state: 'queued', queuedMessageId: 'queued-1' },
    });
    if (timedOut?.status !== 'failure')
      throw new Error('Expected timeout failure');
    expect(timedOut.error).not.toContain(SECRET_TEXT);

    release();
    expect((await pending).outputs.state).toBe('steered');
  });

  it('gives a caller that joins the operation the same timeout result', async () => {
    chat.busy = true;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    dispatch.mockImplementation(async (action, ...rest) => {
      if (action.type === 'projects.steer_queued_message') await gate;
      return fakeDispatch(action, ...rest);
    });
    const hostActions = host();
    const first = send(inputs({ mode: 'steer' }), { hostActions });
    while (
      !dispatch.mock.calls.some(
        ([action]) => action.type === 'projects.steer_queued_message',
      )
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    let joinerFinalizer: (() => Promise<PipelineHostActionResult>) | undefined;
    const joined = hostActions.run(
      { action: 'send-agent-message', inputs: inputs({ mode: 'steer' }) },
      caller(),
      new AbortController().signal,
      {
        ...controls(),
        registerTimeoutFinalizer: (finalize): void => {
          joinerFinalizer = finalize;
        },
      },
    );

    expect(await joinerFinalizer?.()).toMatchObject({
      failureReason: 'target_not_ready',
      chatSend: { state: 'queued' },
    });

    release();
    expect(await joined).toEqual(await first);
  });

  it('times out with the accepted send while its done write is pending', async () => {
    let finalizedEarly: PipelineHostActionResult | undefined;
    setBeforeSendJournalWriteForTests((record) => {
      if (record.phase === 'done') {
        void finalizer?.().then((value) => {
          finalizedEarly = value;
        });
      }
    });

    const result = await send();
    await new Promise((resolve) => setImmediate(resolve));

    expect(finalizedEarly).toEqual(result);
  });
});

describe('the journal', () => {
  it('holds ids only: no text, file paths or names', async () => {
    resolvePrompt.mockResolvedValue({ prompt: SECRET_TEXT });
    await send(
      inputs({
        text: `@${SECRET_NAME}`,
        textReferences: [
          {
            kind: 'file',
            textStart: 0,
            displayText: `@${SECRET_NAME}`,
            root: { kind: 'workspace' },
            relativePath: SECRET_NAME,
          },
        ],
        attachments: [`/abs/${SECRET_NAME}`],
      }),
      { caller: { pipelineName: SECRET_NAME } },
    );

    const text = journalText();
    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toContain(SECRET_NAME);
  });

  it('refuses a malformed send record before journaling it', async () => {
    dispatch.mockResolvedValueOnce({
      ok: true,
      result: {
        address: { projectId: 'p', taskId: 't', chatId: 'c' },
        acceptedAt: 'not-a-date',
        watcherReceipts: [],
        disposition: 'started',
        messageId: 'm',
      },
    });

    await expect(send()).rejects.toThrow('unreadable send receipt');
    expect(JSON.parse(journalText())).not.toHaveProperty('result');
  });
});

// CAN-4551: what a converted automation's send step adds.
describe('a run an automation started', () => {
  const token = `{{${AUTOMATION_IF_CMD_OUTPUT_VAR_NAMES[0]}}}`;
  const automation = (ifCommandOutput?: string): PipelineHostActionCaller => ({
    ...caller(),
    initiator: {
      kind: 'automation',
      automationId: 'auto-1',
      ...(ifCommandOutput !== undefined ? { ifCommandOutput } : {}),
    },
  });

  it('puts the gate output in the text, as the native prompt did', async () => {
    await send(inputs({ text: `Review ${token}` }), {
      caller: automation('payload ${{ inputs.x }}'),
    });
    expect(actionsOf('projects.send_message')[0]).toMatchObject({
      text: 'Review payload ${{ inputs.x }}',
    });
  });

  it('keeps the token without a recorded gate output', async () => {
    await send(inputs({ text: `Review ${token}` }), { caller: automation() });
    expect(actionsOf('projects.send_message')[0]).toMatchObject({
      text: `Review ${token}`,
    });
  });

  it('moves each reference past the gate output, and leaves a pill alone', async () => {
    resolvePrompt.mockResolvedValue({ prompt: 'resolved' });
    const pill = `@${token}`;
    await send(
      inputs({
        text: `${token} then ${pill}`,
        textReferences: [
          {
            kind: 'file',
            textStart: token.length + ' then '.length,
            displayText: pill,
            root: { kind: 'workspace' },
            relativePath: 'notes.md',
          },
        ],
      }),
      { caller: automation('ok') },
    );
    expect(resolvePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: `ok then ${pill}`,
        promptReferences: [
          expect.objectContaining({
            textStart: 'ok then '.length,
            displayText: pill,
          }),
        ],
      }),
    );
  });

  it('carries the automation banner and presentation, as its own send did', async () => {
    await send(inputs(), {
      caller: {
        ...automation(),
        executionContext: 'org:11111111-1111-4111-8111-111111111111',
        initiator: {
          kind: 'automation',
          automationId: 'auto-1',
          automationName: 'Nightly',
          background: true,
        },
      },
    });
    expect(lastOptions().automationDispatch).toEqual({
      version: 1,
      automationName: 'Nightly',
      presentation: 'background',
      executionContext: 'org:11111111-1111-4111-8111-111111111111',
    });
    await send(inputs(), {
      caller: { ...automation(), idempotencyKey: `${key}-2` },
    });
    expect(lastOptions().automationDispatch).toEqual({
      version: 1,
      automationName: 'auto-1',
      presentation: 'foreground',
      executionContext: 'personal',
    });
    await send(inputs(), { caller: { idempotencyKey: `${key}-3` } });
    expect(lastOptions()).not.toHaveProperty('automationDispatch');
  });

  it('replaces an empty first chat only in a run an automation started', async () => {
    const newChat = inputs({
      target: { kind: 'project', projectId: 'p', taskId: 't' },
      replaceEmptyChat: true,
    });
    await send(newChat, { caller: automation() });
    expect(lastOptions().reuseStarterChat).toBe(true);
    await send(newChat, { caller: { idempotencyKey: `${key}-2` } });
    expect(lastOptions()).not.toHaveProperty('reuseStarterChat');
  });

  // The native send fell back to the surface's level for the named model's
  // provider; the step's own default would be the provider's generic one.
  it.each([
    { type: 'cowork' as const, surface: 'defaultChatModelByProvider' },
    { type: 'single-repo' as const, surface: 'defaultWorktreeModelByProvider' },
  ])(
    'takes a named model’s thinking level from the $type surface defaults',
    async ({ type, surface }) => {
      readConfig.mockResolvedValue(config(type));
      readWorktrees.mockResolvedValue({
        worktrees: [{ id: 't' }],
        authority: 'ok',
      } as unknown as Awaited<
        ReturnType<typeof readWorkspaceWorktreesDetailed>
      >);
      knownModel.mockReturnValue('opus');
      providerFor.mockReturnValue('claude');
      mockPreferences.mockResolvedValue({
        [surface]: { claude: { model: 'sonnet', thinkingLevel: 'low' } },
      });
      const named = (thinkingEffort?: 'max'): ResolvedSendAgentMessageInputs =>
        inputs({
          target: { kind: 'project', projectId: 'p', taskId: 't' },
          settings: {
            model: 'opus',
            ...(thinkingEffort ? { thinkingEffort } : {}),
          },
        });
      await send(named(), { caller: automation() });
      expect(lastOptions().newChatSeed?.modelConfig).toEqual({
        thinkingLevel: 'low',
      });
      await send(named('max'), {
        caller: { ...automation(), idempotencyKey: `${key}-2` },
      });
      expect(lastOptions().newChatSeed?.modelConfig).toEqual({
        thinkingLevel: 'max',
      });
      await send(named(), { caller: { idempotencyKey: `${key}-3` } });
      expect(lastOptions().newChatSeed).not.toHaveProperty('modelConfig');
    },
  );

  // The native Orchestrator send put the automation's plugins over the
  // Orchestrator's defaults; a seeded selection replaces them otherwise.
  it('keeps the Orchestrator’s default plugins under the ones it chooses', async () => {
    const defaults = {
      collectionIds: ['default-col'],
      skillRefs: [],
      pluginRefs: [],
    };
    mockPreferences.mockResolvedValue({ appAdvisorPluginSelections: defaults });
    resolvePlugins.mockResolvedValue({
      collectionIds: ['merged'],
      skillRefs: [],
      pluginRefs: [],
    });
    const plugins = [
      {
        type: 'skill' as const,
        source: { type: 'builtin' as const, id: 'app' },
        skill_name: 'x',
      },
    ];
    const newBotChat = inputs({
      target: { kind: 'bot', botId: 'app_advisor', taskId: 't' },
      settings: { plugins },
    });

    await send(newBotChat, { caller: automation() });
    expect(resolvePlugins).toHaveBeenLastCalledWith(
      defaults,
      plugins,
      undefined,
    );

    await send(newBotChat, { caller: { idempotencyKey: `${key}-2` } });
    expect(resolvePlugins).toHaveBeenLastCalledWith(
      undefined,
      plugins,
      undefined,
    );
  });

  it('asks for a new chat with new_chat, with no settings', async () => {
    await send(
      inputs({
        target: { kind: 'project', projectId: 'p', taskId: 't' },
        newChat: true,
      }),
    );
    expect(lastOptions().newChat).toBe(true);
    expect(lastOptions()).not.toHaveProperty('newChatSeed');
  });
});
