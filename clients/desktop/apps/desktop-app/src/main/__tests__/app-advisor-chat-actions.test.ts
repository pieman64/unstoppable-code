import type * as SendOrchestration from '../agent-messaging/send-orchestration';
import { dispatchAgentChatSend } from '../agent-messaging/send-orchestration';
jest.mock('../agent-messaging/send-orchestration', () => ({
  ...jest.requireActual<typeof SendOrchestration>(
    '../agent-messaging/send-orchestration',
  ),
  dispatchAgentChatSend: jest.fn(),
}));
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { dispatchAdvisorChatAction } from '../app-advisor/advisor-chat-actions';
import type { AppAdvisorToolRuntimeSurfaces } from '../app-advisor/runtime';

import { dispatchAgentChatCreation } from '../agent-messaging/creation-orchestration';
import { AgentChatSendError } from '../agent-messaging/send-orchestration';
jest.mock('../agent-messaging/creation-orchestration', () => ({
  dispatchAgentChatCreation: jest.fn(),
}));
const mockCreateWorkEntry = jest.fn();
const mockListWorkEntryIds = jest.fn();
const mockRemoveWorkEntryRow = jest.fn();
const mockResolveWorkEntryForChat = jest.fn();
jest.mock('../lib/cowork-work-entries', () => ({
  createWorkEntry: (...args: unknown[]): unknown =>
    mockCreateWorkEntry(...args),
  listWorkEntryIds: (...args: unknown[]): unknown =>
    mockListWorkEntryIds(...args),
  removeWorkEntryRow: (...args: unknown[]): unknown =>
    mockRemoveWorkEntryRow(...args),
  resolveWorkEntryForChat: (...args: unknown[]): unknown =>
    mockResolveWorkEntryForChat(...args),
}));
const mockSendWorktreeChatMessage = jest.fn();
const mockBuildAgentSenderRequest = jest.fn();
jest.mock('../agent-messaging/sender-context', () => ({
  buildAgentSenderRequest: (...args: unknown[]): unknown =>
    mockBuildAgentSenderRequest(...args),
  isAgentSenderContextError: (): boolean => false,
}));
jest.mock('../services/chat-service', () => ({
  sendWorktreeChatMessage: (...args: unknown[]): unknown =>
    mockSendWorktreeChatMessage(...args),
}));
const create = jest.mocked(dispatchAgentChatCreation);

const surfaces: AppAdvisorToolRuntimeSurfaces = {
  getMainWindow: () => null,
  getAppAdvisorWindow: () => null,
  openAppAdvisorWindow: jest.fn(),
  ensureAppAdvisorWindow: jest.fn(),
};
const source = {
  projectId: APP_ADVISOR_PROJECT_ID,
  worktreeId: 'entry-source',
  chatId: 'chat-source',
};

beforeEach(() => {
  jest.clearAllMocks();
  create.mockResolvedValue({
    address: {
      botId: 'app_advisor',
      taskId: 'entry-new',
      chatId: 'minted-chat',
    },
    taskCreated: true,
    chatCreated: true,
  });
});

describe('dispatchAdvisorChatAction', () => {
  it('creates a titled entry through canonical creation with the exact legacy result and no navigation', async () => {
    const result = await dispatchAdvisorChatAction(
      { type: 'advisor-chat.create_entry', title: ' Research ', text: 'Go' },
      source,
      surfaces,
      'tool-1',
    );
    expect(result).toEqual({
      ok: true,
      result: { workEntryId: 'entry-new', chatId: 'minted-chat' },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      {
        type: 'bots.create_task',
        botId: 'app_advisor',
        title: 'Research',
        initialMessage: 'Go',
      },
      {
        caller: { kind: 'app_advisor', source },
        watcherDestination: source,
        surfaces,
        toolUseId: 'tool-1',
      },
    );
    expect(mockCreateWorkEntry).not.toHaveBeenCalled();
    expect(mockSendWorktreeChatMessage).not.toHaveBeenCalled();
    expect(dispatchAgentChatSend).not.toHaveBeenCalled();
    expect(surfaces.openAppAdvisorWindow).not.toHaveBeenCalled();
    expect(surfaces.ensureAppAdvisorWindow).not.toHaveBeenCalled();
  });
  it('lets canonical creation reuse the chat inside an existing entry without a second send', async () => {
    mockListWorkEntryIds.mockResolvedValue(['entry-1']);
    create.mockResolvedValueOnce({
      address: {
        botId: 'app_advisor',
        taskId: 'entry-1',
        chatId: 'existing-empty',
      },
      taskCreated: false,
      chatCreated: false,
    });
    expect(
      await dispatchAdvisorChatAction(
        {
          type: 'advisor-chat.create_chat',
          workEntryId: 'entry-1',
          text: 'Go',
        },
        source,
        surfaces,
      ),
    ).toEqual({
      ok: true,
      result: { workEntryId: 'entry-1', chatId: 'existing-empty' },
    });
    expect(create).toHaveBeenCalledWith(
      {
        type: 'bots.create_task_chat',
        botId: 'app_advisor',
        taskId: 'entry-1',
        initialMessage: 'Go',
      },
      expect.objectContaining({ caller: { kind: 'app_advisor', source } }),
    );
    expect(mockSendWorktreeChatMessage).not.toHaveBeenCalled();
    expect(dispatchAgentChatSend).not.toHaveBeenCalled();
  });
  it('rejects an unknown entry without creating or sending', async () => {
    mockListWorkEntryIds.mockResolvedValue(['entry-1']);
    expect(
      await dispatchAdvisorChatAction(
        {
          type: 'advisor-chat.create_chat',
          workEntryId: 'entry-2',
          text: 'Go',
        },
        source,
        surfaces,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_target' } });
    expect(create).not.toHaveBeenCalled();
    expect(mockSendWorktreeChatMessage).not.toHaveBeenCalled();
  });
  it('leaves no adapter-owned orphan entry when canonical initial send fails', async () => {
    create.mockRejectedValueOnce(new Error('model blocked'));
    expect(
      await dispatchAdvisorChatAction(
        { type: 'advisor-chat.create_entry', text: 'Go' },
        source,
        surfaces,
      ),
    ).toEqual({
      ok: false,
      error: { code: 'execution_failed', message: 'model blocked' },
    });
    // The orchestrator owns conservative cleanup; this adapter must not create
    // another entry outside that transaction, nor delete possibly saved chats.
    expect(mockCreateWorkEntry).not.toHaveBeenCalled();
    expect(mockRemoveWorkEntryRow).not.toHaveBeenCalled();
    expect(mockSendWorktreeChatMessage).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['owner_boundary', 'not_found', 'Chat was not found.'],
    ['target_not_ready', 'invalid_target', 'blocked'],
    ['missing_capability', 'missing_capability', 'blocked'],
  ] as const)(
    'preserves legacy %s mapping without compensating deletion',
    async (code, legacyCode, message) => {
      create.mockRejectedValueOnce(new AgentChatSendError(code, 'blocked'));
      expect(
        await dispatchAdvisorChatAction(
          { type: 'advisor-chat.create_entry', text: 'Go' },
          source,
          surfaces,
        ),
      ).toEqual({ ok: false, error: { code: legacyCode, message } });
      expect(mockRemoveWorkEntryRow).not.toHaveBeenCalled();
    },
  );

  it('sends to another chat with that chat’s own settings', async () => {
    mockResolveWorkEntryForChat.mockResolvedValue({
      entryId: 'entry-1',
      archivedInEntryId: null,
    });

    const result = await dispatchAdvisorChatAction(
      {
        type: 'advisor-chat.send_message',
        chatId: 'chat-2',
        text: 'Continue',
      },
      source,
      surfaces,
    );

    expect(result).toEqual({
      ok: true,
      result: { workEntryId: 'entry-1', chatId: 'chat-2' },
    });
    expect(dispatchAgentChatSend).toHaveBeenCalledWith(
      {
        type: 'bots.send_message',
        botId: 'app_advisor',
        taskId: 'entry-1',
        chatId: 'chat-2',
        text: 'Continue',
      },
      {
        caller: { kind: 'app_advisor', source },
        watcherDestination: source,
        surfaces,
      },
    );
    expect(mockSendWorktreeChatMessage).not.toHaveBeenCalled();
    expect(mockBuildAgentSenderRequest).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the calling chat',
      { chatId: 'chat-source' },
      { entryId: 'entry-source', archivedInEntryId: null },
    ],
    [
      'an archived chat',
      { chatId: 'chat-2' },
      { entryId: null, archivedInEntryId: 'entry-1' },
    ],
    [
      'a mismatched entry',
      { chatId: 'chat-2', workEntryId: 'entry-other' },
      { entryId: 'entry-1', archivedInEntryId: null },
    ],
  ])('refuses to send to %s', async (_label, target, owner) => {
    mockResolveWorkEntryForChat.mockResolvedValue(owner);

    const result = await dispatchAdvisorChatAction(
      { type: 'advisor-chat.send_message', ...target, text: 'Continue' },
      source,
      surfaces,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_target');
    expect(mockSendWorktreeChatMessage).not.toHaveBeenCalled();
  });
});
