import {
  captureCanonicalChatProducerContext,
  captureChatWatcherEvidence,
  getCanonicalChatTerminalDisposition,
  getActiveChatInputProvider,
  getCanonicalInputAcceptedAt,
  hasCanonicalTurnVisibleOutput,
  resolveCanonicalChatAddress,
} from '../services/active-chat-input';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
const mockResolveAuthorizedChat = jest.fn();
const mockResolveWorkEntryForChat = jest.fn();
const mockReadSnapshot = jest.fn();
const mockRequireBotAccess = jest.fn();
let mockTranscriptMessages: PersistedChatMessage[] = [];
async function* mockTranscript(): AsyncIterable<PersistedChatMessage> {
  for (const message of mockTranscriptMessages)
    yield await Promise.resolve(message);
}

jest.mock('../project-discovery/chat-target', () => ({
  resolveAuthorizedChat: (...args: unknown[]): unknown =>
    mockResolveAuthorizedChat(...args),
}));
jest.mock('../lib/cowork-work-entries', () => ({
  resolveWorkEntryForChat: (...args: unknown[]): unknown =>
    mockResolveWorkEntryForChat(...args),
}));
jest.mock('../project-discovery/owner-policy', () => ({
  requireAuthorizedProject: jest.fn(),
}));
jest.mock('../project-discovery/bots/target', () => ({
  requireBotAccess: (...args: unknown[]): unknown =>
    mockRequireBotAccess(...args),
}));
jest.mock('../services/chat-state-service', () => ({
  readChatWatcherSnapshot: (...args: unknown[]): unknown =>
    mockReadSnapshot(...args),
  consumeChatWatcherTranscript: (
    _target: unknown,
    consume: (messages: AsyncIterable<PersistedChatMessage>) => unknown,
  ): unknown => consume(mockTranscript()),
}));
jest.mock('../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: (): {
    getActiveChatInput: () => Promise<{ state: 'idle' }>;
  } => ({
    getActiveChatInput: (): Promise<{ state: 'idle' }> =>
      Promise.resolve({ state: 'idle' }),
  }),
}));
jest.mock('../agents/session-manager', () => ({
  getSession: jest.fn(),
  getActiveChatIds: jest.fn(() => []),
}));

describe('canonical chat producer facts', () => {
  it('never captures a launch-local account epoch as durable bot evidence', async () => {
    mockRequireBotAccess.mockResolvedValue({ accountEpoch: 42 });
    await expect(
      // Preserve this legacy address without taskId; only the test boundary
      // needs to bypass the canonical input type.
      captureChatWatcherEvidence({
        botId: 'app_advisor',
        chatId: 'chat',
      } as Parameters<typeof captureChatWatcherEvidence>[0]),
    ).resolves.toEqual({ sourceOwner: null });
  });
  it('preserves error and interrupted ahead of no output', () => {
    expect(getCanonicalChatTerminalDisposition({}, 'failure', false)).toBe(
      'error',
    );
    expect(getCanonicalChatTerminalDisposition({}, 'interrupted', false)).toBe(
      'interrupted',
    );
    expect(getCanonicalChatTerminalDisposition({}, 'success', false)).toBe(
      'no_output',
    );
    expect(getCanonicalChatTerminalDisposition({}, 'success')).toBe(
      'completed',
    );
  });
  it('normalizes real cowork IDs through the authorized phase 03 resolver', async () => {
    mockResolveAuthorizedChat.mockResolvedValue({
      address: { projectId: 'cowork-real', taskId: 'entry', chatId: 'chat' },
    });
    await expect(
      resolveCanonicalChatAddress({
        projectId: 'cowork-real',
        worktreeId: 'entry',
        chatId: 'chat',
      }),
    ).resolves.toEqual({
      projectId: 'cowork-real',
      taskId: 'entry',
      chatId: 'chat',
    });
  });
  it("normalizes the legacy standalone scope to the chat's owning Work Entry", async () => {
    const address = {
      projectId: 'cowork-real',
      taskId: 'owning-entry',
      chatId: 'chat',
    };
    mockResolveWorkEntryForChat.mockResolvedValue({
      entryId: 'owning-entry',
      archivedInEntryId: null,
    });
    mockResolveAuthorizedChat.mockImplementation((target: unknown) => {
      expect(target).toEqual(address);
      return Promise.resolve({ address });
    });
    await expect(
      resolveCanonicalChatAddress({
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'cowork-real',
        chatId: 'chat',
      }),
    ).resolves.toEqual(address);
    expect(mockResolveWorkEntryForChat).toHaveBeenCalledWith(
      'cowork-real',
      'chat',
    );
    expect(mockResolveAuthorizedChat).toHaveBeenCalledWith(address, {
      kind: 'app_advisor',
      chatId: 'chat',
    });
  });
  it.each([null, 'archived-entry'])(
    'does not invent a task when the standalone chat has no live owner (%s)',
    async (archivedInEntryId) => {
      mockResolveWorkEntryForChat.mockResolvedValue({
        entryId: null,
        archivedInEntryId,
      });
      mockResolveAuthorizedChat.mockResolvedValue({
        address: { projectId: 'cowork-real', taskId: 'entry', chatId: 'chat' },
      });
      mockResolveAuthorizedChat.mockClear();
      await expect(
        resolveCanonicalChatAddress({
          projectId: STANDALONE_CHAT_PROJECT_ID,
          worktreeId: 'cowork-real',
          chatId: 'chat',
        }),
      ).resolves.toBeNull();
      expect(mockResolveAuthorizedChat).not.toHaveBeenCalled();
    },
  );
  it.each([CODE_REVIEW_CHAT_PROJECT_ID, PLAN_EXPLORE_CHAT_PROJECT_ID])(
    'does not alias the non-watchable sentinel %s to a cowork project',
    async (projectId) => {
      mockResolveWorkEntryForChat.mockClear();
      mockResolveAuthorizedChat.mockRejectedValue(
        new Error('Project was not found.'),
      );
      await expect(
        captureCanonicalChatProducerContext({
          projectId,
          worktreeId: 'scope',
          chatId: 'chat',
        }),
      ).resolves.toBeNull();
      expect(mockResolveWorkEntryForChat).not.toHaveBeenCalled();
      expect(mockResolveAuthorizedChat).toHaveBeenCalledWith(
        { projectId, taskId: 'scope', chatId: 'chat' },
        { kind: 'app_advisor', chatId: 'chat' },
      );
    },
  );
  it.each([
    {
      runtime: {
        status: 'awaiting_input',
        activeTurn: { userMessageId: 'paused-root', startedAt: 1 },
        queuedMessageIds: [],
      },
      expected: { state: 'active', inputId: 'paused-root' },
    },
    {
      runtime: {
        status: 'streaming',
        activeTurn: { userMessageId: 'root', startedAt: 1 },
        queuedMessageIds: [],
      },
      expected: { state: 'active', inputId: 'root' },
    },
    {
      runtime: {
        status: 'queued',
        queuedMessageIds: ['row'],
        queuedMessages: [{ request: { userMessageId: 'pending-root' } }],
      },
      expected: { state: 'pending', inputId: 'pending-root' },
    },
    {
      runtime: {
        status: 'completed',
        queuedMessageIds: [],
        lastActivityAt: 100,
      },
      expected: { state: 'idle' },
    },
  ])(
    'projects authoritative active and pending roots ($expected.state)',
    async ({ runtime, expected }) => {
      mockReadSnapshot.mockResolvedValue({
        tabsFile: { tabs: [{ id: 'chat' }] },
        runtimeByChatId: { chat: runtime },
      });
      await expect(
        getActiveChatInputProvider().getActiveChatInput({
          projectId: 'project',
          taskId: 'entry',
          chatId: 'chat',
        }),
      ).resolves.toEqual(expected);
    },
  );
  it('returns retained pending terminal input instead of guessing idle', async () => {
    const payload = {
      projectId: 'project',
      worktreeId: 'entry',
      chatId: 'chat',
      userMessageId: 'pending-root',
      text: 'Pending',
    };
    mockReadSnapshot.mockResolvedValue({
      tabsFile: {
        tabs: [
          {
            id: 'chat',
            interfaceMode: 'claude-code',
            inputDelivery: {
              version: 1,
              epoch: 0,
              rows: [
                {
                  id: 'pending-root',
                  revision: 1,
                  createdAt: 1,
                  text: 'Pending',
                  settingsKey: 'settings',
                  state: 'pending',
                  payload,
                  attempts: [],
                },
              ],
            },
          },
        ],
      },
      runtimeByChatId: {},
    });
    await expect(
      getActiveChatInputProvider().getActiveChatInput({
        projectId: 'project',
        taskId: 'entry',
        chatId: 'chat',
      }),
    ).resolves.toEqual({ state: 'pending', inputId: 'pending-root' });
  });
  it('finds a turn answer after folded steering inside the same turn', async () => {
    mockTranscriptMessages = [
      {
        id: 'root',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Start' }],
      },
      {
        id: 'steer',
        role: 'user',
        timestamp: 2,
        blocks: [
          {
            type: 'text',
            text: 'Also check tests',
            steering: { startsTurn: false },
          },
        ],
      },
      {
        id: 'answer',
        role: 'assistant',
        timestamp: 3,
        blocks: [{ type: 'text', text: 'Done' }],
      },
    ];
    await expect(
      hasCanonicalTurnVisibleOutput(
        { projectId: 'project', worktreeId: 'entry', chatId: 'chat' },
        'root',
      ),
    ).resolves.toBe(true);
  });
  it('reads a root without its own ledger row from the transcript, not a steering row', async () => {
    mockReadSnapshot.mockResolvedValue({
      tabsFile: {
        tabs: [
          {
            id: 'chat',
            inputDelivery: {
              version: 1,
              epoch: 0,
              rows: [
                {
                  id: 'steer',
                  revision: 1,
                  createdAt: 5000,
                  state: 'picked-up',
                  text: 'Also check tests',
                  payload: {
                    projectId: 'project',
                    worktreeId: 'entry',
                    chatId: 'chat',
                    userMessageId: 'steer',
                    text: 'Also check tests',
                  },
                  settingsKey: 'k',
                  attempts: [
                    {
                      id: 'attempt',
                      generation: '1',
                      provider: 'codex',
                      createdAt: 5000,
                      admittedAt: 5000,
                      rootUserMessageId: 'root',
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
      runtimeByChatId: {},
    });
    mockTranscriptMessages = [
      {
        id: 'root',
        role: 'user',
        timestamp: 1000,
        blocks: [{ type: 'text', text: 'Start' }],
      },
    ];
    await expect(
      getCanonicalInputAcceptedAt(
        { projectId: 'project', worktreeId: 'entry', chatId: 'chat' },
        'root',
      ),
    ).resolves.toBe(new Date(1000).toISOString());
  });
  it('does not report a finished managed-terminal attempt as active after switching to native mode', async () => {
    mockReadSnapshot.mockResolvedValue({
      tabsFile: {
        tabs: [
          {
            id: 'chat',
            interfaceMode: 'native',
            inputDelivery: {
              version: 1,
              epoch: 0,
              rows: [
                {
                  id: 'terminal-input',
                  revision: 2,
                  createdAt: 1,
                  text: 'Ran in the terminal',
                  settingsKey: 'settings',
                  state: 'picked-up',
                  payload: {
                    projectId: 'project',
                    worktreeId: 'entry',
                    chatId: 'chat',
                    userMessageId: 'terminal-input',
                    text: 'Ran in the terminal',
                  },
                  currentAttemptId: 'terminal-attempt',
                  attempts: [
                    {
                      id: 'terminal-attempt',
                      generation: 'managed-terminal',
                      provider: 'claude',
                      createdAt: 1,
                      pickedUpAt: 2,
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
      runtimeByChatId: {
        chat: { status: 'idle', queuedMessageIds: [], lastActivityAt: 3 },
      },
    });
    const active = await getActiveChatInputProvider().getActiveChatInput({
      projectId: 'project',
      taskId: 'entry',
      chatId: 'chat',
    });
    expect(active.state).not.toBe('active');
  });
  it('does not mistake a synthesized idle snapshot for observed idle', async () => {
    mockReadSnapshot.mockResolvedValue({
      tabsFile: { tabs: [{ id: 'chat' }] },
      runtimeByChatId: { chat: { status: 'idle', queuedMessageIds: [] } },
    });
    await expect(
      getActiveChatInputProvider().getActiveChatInput({
        projectId: 'project',
        taskId: 'entry',
        chatId: 'chat',
      }),
    ).resolves.toEqual({ state: 'unknown' });
  });
});
