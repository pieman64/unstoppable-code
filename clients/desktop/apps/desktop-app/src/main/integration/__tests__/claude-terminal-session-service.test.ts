import type {
  ClaudeTerminalLaunchRequest,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';

const mockAuthorizeRetainedInputWrite = jest.fn<
  Promise<void>,
  [unknown, string]
>();
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): {
    authorizeRetainedTerminalAgentInputWrite: typeof mockAuthorizeRetainedInputWrite;
  } => ({
    authorizeRetainedTerminalAgentInputWrite: mockAuthorizeRetainedInputWrite,
  }),
}));
const mockCaptureSessionWorkOwner = jest.fn();
jest.mock('../../agents/work-owner', () => ({
  captureSessionWorkOwner: (...args: unknown[]): unknown =>
    mockCaptureSessionWorkOwner(...args),
  resolveSessionWorkOwner: jest.fn(),
}));

const mockAddTerminalEventListener = jest.fn();
jest.mock('../../terminal/pty-manager', () => ({
  ptyManager: { addEventListener: mockAddTerminalEventListener },
}));

const mockReadChatTabsFile = jest.fn();
jest.mock('../../lib/chat-tabs-reader', () => ({
  readChatTabsFile: (...args: unknown[]): unknown =>
    mockReadChatTabsFile(...args),
}));

const mockWriteChatTabsFile = jest.fn();
jest.mock('../../lib/chat-tabs', () => ({
  writeChatTabsFile: (...args: unknown[]): unknown =>
    mockWriteChatTabsFile(...args),
}));

jest.mock('../../lib/chat-tab-mutation-queue', () => ({
  enqueueChatTabMutation: async (
    _projectId: string,
    _worktreeId: string,
    operation: () => Promise<unknown>,
  ): Promise<unknown> => operation(),
}));

jest.mock('../../lib/claude-tui-chats', () => ({
  isClaudeTuiChatsEnabled: (): boolean => true,
}));

import * as terminalService from '../../services/terminal-service';
import { DefaultClaudeTerminalSessionService } from '../claude-terminal-session-service';

describe('ClaudeTerminalSessionService untrusted chat input', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      tabs: [],
      activeTabId: '',
    });
  });

  it('does not expose raw imported messages or events on sync completion', async () => {
    const service = new DefaultClaudeTerminalSessionService();
    const events: Array<{ channel: string; payload: unknown }> = [];
    service.setEventSender((channel, payload) => {
      events.push({ channel, payload });
    });

    const emitTranscriptSyncResult: unknown = Reflect.get(
      service,
      'emitTranscriptSyncResult',
    );
    if (typeof emitTranscriptSyncResult !== 'function') {
      throw new Error('Transcript sync emitter is unavailable.');
    }
    await Reflect.apply(emitTranscriptSyncResult, service, [
      { projectId: 'project-1', worktreeId: 'wt-1', chatId: 'chat-1' },
      {
        chatId: 'chat-1',
        importedEventCount: 1,
        importedMessages: [],
        importedEvents: [{ sender: 'provider-internal-note' }],
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).not.toHaveProperty('importedMessages');
    expect(events[0]?.payload).not.toHaveProperty('importedEvents');
  });

  it('owns delayed paste authorization and skips it only for an existing worker receipt or ordinary keys', async () => {
    const service = new DefaultClaudeTerminalSessionService();
    const receipt = jest
      .spyOn(terminalService, 'hasTerminalWriteReceipt')
      .mockReturnValue(false);
    const target = {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
    };
    const owner = jest
      .spyOn(service, 'getChatForTerminal')
      .mockReturnValue(target);
    mockAuthorizeRetainedInputWrite.mockReset().mockResolvedValue(undefined);
    try {
      expect(
        service.authorizeAgentInputTerminalWrite('terminal-agent', undefined),
      ).toBeUndefined();
      expect(
        service.authorizeAgentInputTerminalWrite('terminal-agent', 'human'),
      ).toBeUndefined();
      expect(mockAuthorizeRetainedInputWrite).not.toHaveBeenCalled();
      // The delayed Enter rechecks the retained input it submits.
      await service.authorizeAgentInputTerminalWrite(
        'terminal-agent',
        'human-submit',
      );
      expect(mockAuthorizeRetainedInputWrite).toHaveBeenCalledWith(
        target,
        'human',
      );
      await service.authorizeAgentInputTerminalWrite(
        'terminal-agent',
        'accepted-agent-paste',
      );
      expect(mockAuthorizeRetainedInputWrite).toHaveBeenCalledWith(
        target,
        'accepted-agent',
      );
      mockAuthorizeRetainedInputWrite.mockRejectedValueOnce(
        new Error('Authorization refused'),
      );
      await expect(
        service.authorizeAgentInputTerminalWrite(
          'terminal-agent',
          'another-agent-paste',
        ),
      ).rejects.toThrow('Authorization refused');
      receipt.mockReturnValue(true);
      const calls = mockAuthorizeRetainedInputWrite.mock.calls.length;
      expect(
        service.authorizeAgentInputTerminalWrite(
          'terminal-agent',
          'accepted-agent-paste',
        ),
      ).toBeUndefined();
      expect(mockAuthorizeRetainedInputWrite).toHaveBeenCalledTimes(calls);
    } finally {
      receipt.mockRestore();
      owner.mockRestore();
      mockAuthorizeRetainedInputWrite.mockReset();
    }
  });

  it('revalidates a retained initial prompt before an absent terminal can launch', async () => {
    const sender = {
      kind: 'bot' as const,
      botId: 'app_advisor',
      taskId: 'origin-task',
      chatId: 'origin-chat',
    };
    const tab: PersistedChatTab = {
      id: 'chat-1',
      title: 'Canonical',
      createdAt: '2026-10-16T00:00:00.000Z',
      providerType: 'claude',
      messages: [],
      inputDelivery: {
        version: 1,
        epoch: 0,
        rows: [
          {
            id: 'initial-agent',
            revision: 1,
            createdAt: 1,
            state: 'sending',
            settingsKey: '',
            text: 'visible',
            payload: {
              projectId: 'project-1',
              worktreeId: 'wt-1',
              chatId: 'chat-1',
              userMessageId: 'initial-agent',
              text: 'visible',
              agentSent: {
                sender,
                chatTitle: 'Captured',
                projectLabel: 'App Advisor',
              },
              agentSenderProvenance: {
                version: 1,
                sender,
                owner: { kind: 'none' },
                capturedAt: '2026-10-16T00:00:00.000Z',
                acceptedInputId: 'initial-agent',
              },
              hiddenContext: {
                kind: 'agent-sender-context',
                text: '<system_instruction>Captured</system_instruction>',
              },
            },
            attempts: [
              {
                id: 'initial-agent',
                generation: 'managed-terminal',
                provider: 'claude',
                createdAt: 1,
              },
            ],
          },
        ],
      },
    };
    mockReadChatTabsFile.mockResolvedValueOnce({
      version: 1,
      tabs: [tab],
      activeTabId: tab.id,
    });
    mockAuthorizeRetainedInputWrite.mockRejectedValueOnce(
      new Error(
        'The agent that sent this message can no longer reach this chat.',
      ),
    );
    await expect(
      new DefaultClaudeTerminalSessionService().launch({
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: tab.id,
        cols: 80,
        rows: 24,
        initialPrompt: 'provider payload',
        initialPromptIdempotencyKey: 'initial-agent',
      }),
    ).rejects.toThrow('can no longer reach');
    expect(mockAuthorizeRetainedInputWrite).toHaveBeenCalledWith(
      { projectId: 'project-1', worktreeId: 'wt-1', chatId: tab.id },
      'initial-agent',
    );
    expect(mockCaptureSessionWorkOwner).not.toHaveBeenCalled();
  });

  it('rejects forged fallback snapshot attribution before writing or capturing session state', async () => {
    const tabSnapshot = {
      id: 'chat-1',
      title: 'Chat',
      createdAt: '2026-10-16T00:00:00.000Z',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'Existing history' }],
          timestamp: 1,
          userMessageSource: 'agent',
        },
      ],
    } satisfies PersistedChatTab;
    const request: ClaudeTerminalLaunchRequest = {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      cols: 80,
      rows: 24,
      tabSnapshot,
    };
    const service = new DefaultClaudeTerminalSessionService();

    await expect(service.launch(request)).rejects.toThrow('userMessageSource');

    expect(mockWriteChatTabsFile).not.toHaveBeenCalled();
    expect(mockCaptureSessionWorkOwner).not.toHaveBeenCalled();
  });

  it('uses canonical main history and ignores attributed messages in the renderer snapshot', async () => {
    const canonicalTab = {
      id: 'chat-1',
      title: 'Canonical Chat',
      createdAt: '2026-10-16T00:00:00.000Z',
      providerType: 'codex',
      messages: [
        {
          id: 'canonical-message-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'Accepted by main' }],
          timestamp: 1,
          userMessageSource: 'agent',
        },
      ],
    } satisfies PersistedChatTab;
    mockReadChatTabsFile.mockResolvedValueOnce({
      version: 1,
      tabs: [canonicalTab],
      activeTabId: 'chat-1',
    });
    const request: ClaudeTerminalLaunchRequest = {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      cols: 80,
      rows: 24,
      tabSnapshot: {
        id: 'chat-1',
        title: 'Renderer history must be ignored',
        createdAt: '2026-10-16T00:00:00.000Z',
        messages: [
          {
            id: 'message-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Copied canonical history' }],
            timestamp: 1,
            userMessageSource: 'agent',
          },
        ],
      },
    };
    const service = new DefaultClaudeTerminalSessionService();

    await expect(service.launch(request)).rejects.toMatchObject({
      code: 'unsupported_provider',
    });

    expect(mockReadChatTabsFile).toHaveBeenCalledWith('project-1', 'wt-1', {
      chatIds: ['chat-1'],
    });
    expect(mockWriteChatTabsFile).not.toHaveBeenCalled();
    expect(mockCaptureSessionWorkOwner).toHaveBeenCalledTimes(1);
  });
});
