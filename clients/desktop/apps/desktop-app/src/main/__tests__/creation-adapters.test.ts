import { dispatchLegacyChatCreation } from '../app-advisor/creation-adapters';
import { dispatchAgentChatCreation } from '../agent-messaging/creation-orchestration';
import {
  dispatchAgentChatSend,
  AgentChatSendError,
} from '../agent-messaging/send-orchestration';
import { requestAppAdvisorRendererTool } from '../ipc/app-advisor';
import { isSplitLocked } from '../services/split-lock-service';
import type { AppAdvisorToolRuntimeSurfaces } from '../app-advisor/runtime';

jest.mock('../agent-messaging/creation-orchestration', () => ({
  dispatchAgentChatCreation: jest.fn(),
}));
jest.mock('../agent-messaging/send-orchestration', () => {
  class AgentChatSendError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    dispatchAgentChatSend: jest.fn(),
    AgentChatSendError,
    isAgentChatSendError: (error: unknown): boolean =>
      error instanceof AgentChatSendError,
  };
});
jest.mock('../ipc/app-advisor', () => ({
  requestAppAdvisorRendererTool: jest.fn(),
}));
jest.mock('../services/split-lock-service', () => ({
  isSplitLocked: jest.fn(),
}));
const surfaces: AppAdvisorToolRuntimeSurfaces = {
  getMainWindow: () => null,
  getAppAdvisorWindow: () => null,
  openAppAdvisorWindow: jest.fn(),
  ensureAppAdvisorWindow: jest.fn(),
};
const destination = {
  projectId: 'app-advisor',
  worktreeId: 'source-entry',
  chatId: 'source-chat',
};
const context = { destination, surfaces, requestId: 'legacy-create' };
const create = jest.mocked(dispatchAgentChatCreation);
const send = jest.mocked(dispatchAgentChatSend);
const reveal = jest.mocked(requestAppAdvisorRendererTool);
const chat = {
  id: 'new-chat',
  title: '',
  description: '',
  createdAt: '2026-10-17',
  messageCount: 0,
  lastMessageAt: null,
  providerType: 'claude',
  archived: false,
  archivedAt: null,
  hasPluginSelections: false,
};
const settings = {
  projectId: 'project',
  worktreeId: 'new-entry',
  chatId: 'new-chat',
  title: '',
  planMode: false,
  thinkingLevel: 'medium',
  model: 'model',
  providerType: 'claude',
  pluginSelections: {},
  session: null,
  agentTurn: null,
};
beforeEach(() => {
  jest.clearAllMocks();
  create.mockResolvedValue({
    address: { projectId: 'project', taskId: 'new-entry', chatId: 'new-chat' },
    taskCreated: true,
    chatCreated: true,
  });
  reveal.mockResolvedValue({
    requestId: 'reveal',
    ok: true,
    result: { projectId: 'project', workEntryId: 'new-entry', chat, settings },
  });
  jest.mocked(isSplitLocked).mockReturnValue(false);
});
describe('dispatchLegacyChatCreation', () => {
  it('projects the exact standalone legacy shape and creates only once', async () => {
    expect(
      await dispatchLegacyChatCreation(
        { type: 'standalone-chat.create_chat', projectId: 'project' },
        context,
      ),
    ).toEqual({
      requestId: context.requestId,
      ok: true,
      result: {
        projectId: 'project',
        workEntryId: 'new-entry',
        chatId: 'new-chat',
        chat,
        settings,
      },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      { type: 'projects.create_task', projectId: 'project' },
      {
        caller: { kind: 'app_advisor', source: destination },
        watcherDestination: destination,
        surfaces,
        toolUseId: context.requestId,
      },
    );
    expect(reveal.mock.calls[0][0]).toMatchObject({
      kind: 'dispatch_action',
      action: {
        type: 'standalone-chat.switch_chat',
        projectId: 'project',
        chatId: 'new-chat',
      },
    });
    expect(send).not.toHaveBeenCalled();
  });
  it('reveals before sending through the trusted marker-producing send path, never creating with text', async () => {
    const order: string[] = [];
    create.mockImplementationOnce(() => {
      order.push('create');
      return Promise.resolve({
        address: { projectId: 'project', taskId: 'task', chatId: 'new-chat' },
        taskCreated: false,
        chatCreated: false,
      });
    });
    reveal.mockImplementationOnce(() => {
      order.push('reveal');
      return Promise.resolve({ requestId: 'reveal', ok: true });
    });
    send.mockImplementationOnce(() => {
      order.push('send');
      return Promise.resolve({
        address: { projectId: 'project', taskId: 'task', chatId: 'new-chat' },
        acceptedAt: 'now',
        disposition: 'started',
        messageId: 'input',
        watcherReceipts: [],
      });
    });
    expect(
      await dispatchLegacyChatCreation(
        {
          type: 'worktree-chat.open_tab',
          projectId: 'project',
          worktreeId: 'task',
          initialMessage: ' Go ',
        },
        context,
      ),
    ).toEqual({
      requestId: context.requestId,
      ok: true,
      result: { chatId: 'new-chat' },
    });
    expect(order).toEqual(['create', 'reveal', 'send']);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toEqual({
      type: 'projects.create_task_chat',
      projectId: 'project',
      taskId: 'task',
    });
    expect(reveal.mock.calls[0][0]).toMatchObject({
      action: {
        type: 'worktree-chat.open_tab',
        projectId: 'project',
        worktreeId: 'task',
        chatId: 'new-chat',
      },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).not.toHaveProperty('queueForSetup');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'projects.send_message',
        projectId: 'project',
        taskId: 'task',
        chatId: 'new-chat',
        text: ' Go ',
      }),
      expect.objectContaining({
        caller: { kind: 'app_advisor', source: destination },
      }),
    );
  });
  it('normalizes blank initial messages to no send', async () => {
    await dispatchLegacyChatCreation(
      {
        type: 'worktree-chat.open_tab',
        projectId: 'project',
        worktreeId: 'task',
        initialMessage: '  ',
      },
      context,
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('refuses an existing chat without creating or revealing', async () => {
    expect(
      await dispatchLegacyChatCreation(
        {
          type: 'worktree-chat.open_tab',
          projectId: 'project',
          worktreeId: 'task',
          chatId: 'existing',
        },
        context,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });
    expect(create).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });
  it('checks split lock before creating only when sending', async () => {
    jest.mocked(isSplitLocked).mockReturnValue(true);
    expect(
      await dispatchLegacyChatCreation(
        {
          type: 'worktree-chat.open_tab',
          projectId: 'project',
          worktreeId: 'task',
          initialMessage: 'Go',
        },
        context,
      ),
    ).toMatchObject({ ok: false, error: { code: 'surface_unavailable' } });
    expect(create).not.toHaveBeenCalled();
    await dispatchLegacyChatCreation(
      {
        type: 'worktree-chat.open_tab',
        projectId: 'project',
        worktreeId: 'task',
      },
      context,
    );
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('checks expected UI revision before durable creation', async () => {
    reveal.mockResolvedValueOnce({
      requestId: 'state',
      ok: true,
      uiState: {
        version: 1,
        revision: 2,
        capturedAt: 'now',
        digest: 'test',
        snapshot: {
          activePage: 'main',
          archivedContainers: { count: 0, viewerOpen: false },
          overlays: {
            commandPaletteOpen: false,
            fileSearchPaletteOpen: false,
            prPickerOpen: false,
            canopyPortalOpen: false,
            appAdvisorOpen: false,
          },
        },
      },
    });
    expect(
      await dispatchLegacyChatCreation(
        { type: 'standalone-chat.create_chat', projectId: 'project' },
        { ...context, expectedUiRevision: 1 },
      ),
    ).toMatchObject({ ok: false, error: { code: 'stale_ui_state' } });
    expect(create).not.toHaveBeenCalled();
  });
  it('retains durable creation and sends nothing when reveal fails', async () => {
    reveal.mockResolvedValueOnce({
      requestId: 'reveal',
      ok: false,
      error: { code: 'stale_ui_state', message: 'New selection wins.' },
    });
    expect(
      await dispatchLegacyChatCreation(
        {
          type: 'worktree-chat.open_tab',
          projectId: 'project',
          worktreeId: 'task',
          initialMessage: 'Go',
        },
        context,
      ),
    ).toMatchObject({ ok: false, error: { code: 'stale_ui_state' } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    ['owner_boundary', 'not_found', 'Chat was not found.'],
    ['target_not_ready', 'invalid_target', 'blocked'],
    ['missing_capability', 'missing_capability', 'blocked'],
  ] as const)(
    'maps %s to the legacy error',
    async (code, legacyCode, message) => {
      create.mockRejectedValueOnce(new AgentChatSendError(code, 'blocked'));
      expect(
        await dispatchLegacyChatCreation(
          { type: 'standalone-chat.create_chat', projectId: 'project' },
          context,
        ),
      ).toEqual({
        requestId: context.requestId,
        ok: false,
        error: { code: legacyCode, message },
      });
      expect(reveal).not.toHaveBeenCalled();
    },
  );
  it('maps an initial-send refusal without recreating or sending twice', async () => {
    send.mockRejectedValueOnce(
      new AgentChatSendError('target_not_ready', 'target blocked'),
    );
    expect(
      await dispatchLegacyChatCreation(
        {
          type: 'worktree-chat.open_tab',
          projectId: 'project',
          worktreeId: 'task',
          initialMessage: 'Go',
        },
        context,
      ),
    ).toEqual({
      requestId: context.requestId,
      ok: false,
      error: { code: 'invalid_target', message: 'target blocked' },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('maps unexpected failures and refuses incomplete reveal projections', async () => {
    create.mockRejectedValueOnce(new Error('disk failed'));
    expect(
      await dispatchLegacyChatCreation(
        { type: 'standalone-chat.create_chat', projectId: 'project' },
        context,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'execution_failed', message: 'disk failed' },
    });
    reveal.mockResolvedValueOnce({ requestId: 'reveal', ok: true, result: {} });
    expect(
      await dispatchLegacyChatCreation(
        { type: 'standalone-chat.create_chat', projectId: 'project' },
        context,
      ),
    ).toMatchObject({ ok: false, error: { code: 'execution_failed' } });
  });
});
