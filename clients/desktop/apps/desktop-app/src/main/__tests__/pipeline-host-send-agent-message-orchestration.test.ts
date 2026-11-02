/**
 * The `send-agent-message` adapter against the real pipeline port and send
 * orchestration, over an in-memory chat-state port: a replay after a crash
 * commits one message, and the orchestration's D11 backstop refuses plugins
 * that `text_references` bring to an agent-originated run.
 */
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: jest.fn(),
  readWorkspaceWorktreesDetailed: jest.fn(),
}));
jest.mock('../lib/cowork-migration-map', () => ({
  resolveCoworkWorkspaceId: (id: string): string => id,
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
    assertTerminalChatAcceptsSettings: (): Promise<void> => Promise.resolve(),
    buildExistingTabDispatchOptions: (): Promise<object> => Promise.resolve({}),
    isWorktreeChatMessageCommitted: jest.fn(),
    getRegisteredAppAdvisorSurfaces: (): undefined => undefined,
    sendWorktreeChatMessage: jest.fn(),
  };
});
jest.mock('../agent-messaging/turn-override', () => ({
  // Folds plugins that references bring into the override, as the real one does.
  resolveChatTurnOverride: (
    _target: unknown,
    _tab: unknown,
    _request: unknown,
    promptPluginSelections?: object,
  ): Promise<object> =>
    Promise.resolve({
      version: 1,
      ...(promptPluginSelections
        ? { pluginSelections: promptPluginSelections }
        : {}),
    }),
  resolveAutomationPromptPlugins: jest.fn(),
}));
jest.mock('../lib/configured-prompt-resolution', () => ({
  resolveConfiguredPrompt: jest.fn(),
}));
jest.mock('../services/background-execution-context', () => ({
  authorizeBackgroundExecution: (): Promise<object> =>
    Promise.resolve({ allow: true }),
}));
jest.mock('../project-discovery/chat-target', () => ({
  resolveAuthorizedChat: (address: {
    projectId: string;
    taskId: string;
    chatId: string;
  }): Promise<object> =>
    Promise.resolve({
      address,
      projectType: 'cowork',
      scope: {
        workspaceId: address.projectId,
        worktreeId: address.taskId,
        chatId: address.chatId,
      },
      tab: { id: address.chatId },
    }),
}));
jest.mock('../agent-messaging/sender-context', () => ({
  ...jest.requireActual<object>('../agent-messaging/sender-context'),
  buildPipelineSenderRequest: (): Promise<object> =>
    Promise.resolve({
      agentSent: {
        sender: { kind: 'pipeline', executionId: 'exec-1' },
        chatTitle: 'Nightly',
        projectLabel: '',
      },
    }),
  revalidateAgentSenderRequest: (): Promise<void> => Promise.resolve(),
  revalidatePipelineAgentOrigin: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): object => ({}),
}));
jest.mock('../ipc/chat-state', () => ({
  getChatStateCommandPort: (): object => ({
    command: jest.fn(),
    getCommandReceipt: ({ commandId }: { commandId: string }): unknown =>
      Promise.resolve(mockStore.receipts.get(commandId) ?? null),
  }),
}));
jest.mock('../canopy-runtime/core-chat-command-adapter', () => ({
  createChatCommandDispatchOptions: (): object => ({}),
  dispatchTrustedChatCommand: (
    ...args: Parameters<typeof mockCommit>
  ): unknown => mockCommit(...args),
}));

import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  PipelineHostActionCaller,
  PipelineHostActionResult,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import type { ResolvedSendAgentMessageInputs } from '@canopy/desktop-shared/pipelines/host-send-agent-message';
import type {
  ChatCommandEnvelope,
  ChatCommandExecutionOptions,
  ChatTabsFile,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { resolveConfiguredPrompt } from '../lib/configured-prompt-resolution';
import { readWorkEntriesFileStrict } from '../lib/cowork-work-entries';
import { readWorkspaceConfigDetailed } from '../lib/workspace-persistence';
import { createDesktopPipelineHostActions } from '../pipelines/host-actions';
import { setBeforeSendJournalWriteForTests } from '../pipelines/host-send-agent-message-state';

const ACCEPTED_AT = '2026-10-28T00:00:00.000Z';

/** The acceptance facts a committed send stores on its command receipt. */
interface Acceptance {
  acceptedInputId: string;
  disposition: 'started' | 'queued';
  acceptedAt: string;
}

/** The in-memory chat state: committed messages and receipts by command ID. */
const mockStore = {
  transcript: [] as string[],
  receipts: new Map<string, { agentSendAcceptance: Acceptance }>(),
};

const mockCommit = jest.fn(
  (
    envelope: ChatCommandEnvelope,
    options: { executionOptions?: ChatCommandExecutionOptions },
  ): Promise<object> => {
    const { command } = envelope;
    if (command.type !== 'chat.send_message') {
      return Promise.resolve({ outcome: 'applied' });
    }
    const facts: Acceptance = {
      acceptedInputId: command.userMessageId,
      disposition: 'started',
      acceptedAt: ACCEPTED_AT,
    };
    mockStore.transcript.push(command.userMessageId);
    mockStore.receipts.set(envelope.commandId, { agentSendAcceptance: facts });
    options.executionOptions?.onAgentSendAccepted?.(facts);
    return Promise.resolve({ outcome: 'applied' });
  },
);

let artifactsDir: string;
let keySeq = 0;
let key: string;

function inputs(
  overrides: Partial<ResolvedSendAgentMessageInputs> = {},
): ResolvedSendAgentMessageInputs {
  return {
    target: { kind: 'project', projectId: 'p', taskId: 't', chatId: 'c' },
    text: 'Nightly report',
    mode: 'queue',
    settings: {},
    ...overrides,
  };
}

function send(
  request: ResolvedSendAgentMessageInputs = inputs(),
  callerOverrides: Partial<PipelineHostActionCaller> = {},
): Promise<PipelineHostActionResult> {
  return createDesktopPipelineHostActions({
    assertTargetOwner: () => Promise.resolve(),
  }).run(
    { action: 'send-agent-message', inputs: request },
    {
      executionId: 'exec-1',
      pipelineId: 'pipe-1',
      pipelineName: 'Nightly',
      jobId: 'job',
      stepId: 'send',
      attempt: 0,
      iteration: 0,
      idempotencyKey: key,
      ...callerOverrides,
    },
    new AbortController().signal,
    {
      deadlineAt: Date.now() + 60_000,
      artifactsDir,
      registerTimeoutFinalizer: () => undefined,
    },
  );
}

beforeEach(() => {
  mockCommit.mockClear();
  mockStore.transcript = [];
  mockStore.receipts.clear();
  setBeforeSendJournalWriteForTests(undefined);
  artifactsDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-send-orch-'));
  key = `pipeline-host:exec-1:job::send:${++keySeq}:0`;
  jest.mocked(readWorkspaceConfigDetailed).mockResolvedValue({
    config: {
      version: 1,
      type: 'cowork',
      repos: [],
    } satisfies WorkspaceConfigFile,
    authority: 'ok',
    ownerMalformed: false,
    memoryMalformed: false,
  });
  jest.mocked(readWorkEntriesFileStrict).mockResolvedValue({
    version: 1,
    entries: [{ id: 't', createdAt: ACCEPTED_AT }],
  });
  jest.mocked(readChatTabsFile).mockResolvedValue({
    version: 1,
    tabs: [{ id: 'c', title: 'Chat', createdAt: ACCEPTED_AT, messages: [] }],
    activeTabId: 'c',
  } satisfies ChatTabsFile);
});

afterEach(() => {
  setBeforeSendJournalWriteForTests(undefined);
  rmSync(artifactsDir, { recursive: true, force: true });
});

it('commits one message when a crash before done is replayed', async () => {
  setBeforeSendJournalWriteForTests((record) => {
    if (record.phase === 'done') throw new Error('app stopped');
  });
  const first = await send();
  setBeforeSendJournalWriteForTests(undefined);

  const replay = await send();

  expect(first).toMatchObject({
    status: 'success',
    outputs: { state: 'sent', chat_id: 'c' },
  });
  expect(replay).toEqual(first);
  expect(mockCommit).toHaveBeenCalledTimes(1);
  expect(mockStore.transcript).toHaveLength(1);
  const [userMessageId] = mockStore.transcript;
  expect(first.chatSend?.userMessageId).toBe(userMessageId);
  const accepted = Array.from(
    mockStore.receipts.values(),
    (receipt): string => receipt.agentSendAcceptance.acceptedInputId,
  );
  expect(accepted).toEqual([userMessageId]);
});

it('refuses plugins that references bring to an agent-originated run, before any commit', async () => {
  jest.mocked(resolveConfiguredPrompt).mockResolvedValue({
    prompt: 'Use the plugin',
    referencedPluginSelections: {
      pluginRefs: [{ marketplaceId: 'm', pluginName: 'p' }],
    },
  } as Awaited<ReturnType<typeof resolveConfiguredPrompt>>);

  const result = await send(
    inputs({
      text: 'Use the plugin',
      textReferences: [
        {
          kind: 'plugin',
          textStart: 8,
          displayText: 'plugin',
          plugin: { kind: 'installed', marketplaceId: 'm', pluginName: 'p' },
        },
      ],
    }),
    {
      agentOrigin: { projectId: 'ap', worktreeId: 'aw', chatId: 'ac' },
    },
  );

  // The orchestration's backstop, not the adapter's early input check.
  expect(result).toMatchObject({
    status: 'failure',
    failureReason: 'authorization_conflict',
  });
  expect(result.status === 'failure' ? result.error : '').toContain(
    'An agent-originated run cannot change',
  );
  expect(result.chatSend).toBeUndefined();
  expect(mockCommit).not.toHaveBeenCalled();
  expect(mockStore.transcript).toHaveLength(0);
});
