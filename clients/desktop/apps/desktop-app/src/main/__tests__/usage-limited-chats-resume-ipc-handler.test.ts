import {
  ResumeQueueService,
  type ResumeQueueDependencies,
} from '../services/resume-queue-service';
import { AccountProxyQuotaRecovery } from '../account-proxy/quota-recovery';
import type { AccountProxyStatus } from '@canopy/desktop-shared/types/account-proxy';
import type {
  ChatTabsFile,
  ChatActiveSessionInfo,
  PersistedChatTab,
  ResumeQueueEntry,
  ResumeQueueItem,
  ResumeUsageLimitedChatsRequest,
  ResumeUsageLimitedSessionsRequest,
} from '@canopy/desktop-shared/types';
import { STANDALONE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import type { ExecutionState } from '@canopy/desktop-shared/types/pipeline';
import type * as UsageLimitedChatsRegistryModule from '../lib/usage-limited-chats-registry';

type ResumeQueueConfiguration = {
  readLiveAutomaticResumeInterruptionKeys: NonNullable<
    ResumeQueueDependencies['readLiveAutomaticResumeInterruptionKeys']
  >;
  canDispatch: (entries: ResumeQueueEntry[]) => Promise<boolean>;
  reconcile: (entry: ResumeQueueEntry) => Promise<{
    status: 'waiting' | 'resumed' | 'skipped' | 'failed';
    error?: string;
  }>;
};

let mockLiveProxyConnection = 'proxy-A';
const mockGetAccountProxyStatus = jest.fn(
  (): Promise<AccountProxyStatus> =>
    Promise.resolve({
      available: true,
      connection: {
        id: 'proxy-A',
        kind: 'server',
        url: 'https://proxy-a.test',
      },
      state: 'connected',
      error: null,
      version: '8',
      routing: null,
      routeClaude: true,
      routeCodex: true,
      keepChatOnOneAccount: true,
      refreshedAt: 2000,
      local: {
        phase: 'stopped',
        version: null,
        install: null,
        port: null,
        startWithApp: true,
        message: null,
      },
      signIn: null,
      accounts: [
        {
          authIndex: 'ready',
          provider: 'codex',
          label: 'Ready',
          source: 'sign-in',
          fileName: 'ready.json',
          planType: null,
          status: 'active',
          statusMessage: null,
          availableAt: null,
          limits: [],
        },
      ],
    }),
);
const mockPreviewProxyRoute = jest.fn(
  (options: { requiredConnectionId?: string }): Promise<boolean> =>
    Promise.resolve(
      !options.requiredConnectionId ||
        options.requiredConnectionId === mockLiveProxyConnection,
    ),
);
jest.mock('../account-proxy/service', () => ({
  getAccountProxyStatus: (): ReturnType<typeof mockGetAccountProxyStatus> =>
    mockGetAccountProxyStatus(),
}));
jest.mock('../account-proxy/routing', () => ({
  previewAccountProxySessionRoute: (options: {
    requiredConnectionId?: string;
  }): Promise<boolean> => mockPreviewProxyRoute(options),
}));
const mockAssertResumeAllowed = jest.fn();
const mockReleaseAuthenticationPause = jest.fn();
const mockPauseForAuthentication = jest.fn();
const mockClaimCodexAuthenticationResume = jest.fn();
const mockClearCodexAuthenticationResumeClaim = jest.fn();
const mockConfigureResumeQueue = jest.fn<void, [ResumeQueueConfiguration]>();
const mockGetAllActiveSessionInfos = jest.fn<ChatActiveSessionInfo[], []>(
  () => [],
);
const mockTerminalGetState = jest.fn();
const mockLoadExecutionState = jest.fn();
const mockListExecutionSummaries = jest.fn();
const mockReadWorkspaceIndexEntry = jest.fn();
const mockReadWorkspaceWorktrees = jest.fn();
const mockGetResumeQueue = jest.fn((): { isStopping: () => boolean } => ({
  isStopping: () => false,
}));

jest.mock('../auth/codex-login', () => ({
  codexLoginManager: {
    get assertResumeAllowed(): typeof mockAssertResumeAllowed {
      return mockAssertResumeAllowed;
    },
  },
}));
jest.mock('../services/chat-queue-service', () => ({
  getChatQueueService: jest.fn(() => ({
    get releaseAuthenticationPause(): typeof mockReleaseAuthenticationPause {
      return mockReleaseAuthenticationPause;
    },
    get pauseForAuthentication(): typeof mockPauseForAuthentication {
      return mockPauseForAuthentication;
    },
  })),
}));

jest.mock('../services/chat-service', () => ({
  sendWorktreeChatMessage: jest.fn(),
  buildExistingTabDispatchOptions: jest.fn(),
}));
jest.mock('../services/resume-queue-host', () => ({
  get configureResumeQueue(): typeof mockConfigureResumeQueue {
    return mockConfigureResumeQueue;
  },
  get getResumeQueue(): typeof mockGetResumeQueue {
    return mockGetResumeQueue;
  },
}));
jest.mock('../agents/session-manager', () => ({
  get getAllActiveSessionInfos(): typeof mockGetAllActiveSessionInfos {
    return mockGetAllActiveSessionInfos;
  },
}));
jest.mock('../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: jest.fn(() => ({
    get getState(): typeof mockTerminalGetState {
      return mockTerminalGetState;
    },
  })),
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));
jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(),
}));
jest.mock('../lib/cowork-work-entries', () => ({
  resolveWorkEntryForChat: jest.fn(),
}));
jest.mock('../lib/chat-tabs', () => ({
  writeChatTabsFile: jest.fn(),
}));
jest.mock('../lib/usage-limited-chats-registry', () => {
  const actual = jest.requireActual<typeof UsageLimitedChatsRegistryModule>(
    '../lib/usage-limited-chats-registry',
  );
  return {
    ...actual,
    clearUsageLimitedChat: jest.fn(),
    clearAuthenticationInterruptedChat: jest.fn(),
    get claimCodexAuthenticationResume(): typeof mockClaimCodexAuthenticationResume {
      return mockClaimCodexAuthenticationResume;
    },
    get clearCodexAuthenticationResumeClaim(): typeof mockClearCodexAuthenticationResumeClaim {
      return mockClearCodexAuthenticationResumeClaim;
    },
    readUsageLimitedChats: jest.fn(),
  };
});
jest.mock('../pipelines/pipeline-resume-service', () => ({
  resumePipelineExecutionFromMain: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/node/pipelines/executor', () => ({
  get listExecutionSummaries(): typeof mockListExecutionSummaries {
    return mockListExecutionSummaries;
  },
  get loadExecutionState(): typeof mockLoadExecutionState {
    return mockLoadExecutionState;
  },
}));
jest.mock('../lib/sidebar-items', () => ({
  get readWorkspaceIndexEntry(): typeof mockReadWorkspaceIndexEntry {
    return mockReadWorkspaceIndexEntry;
  },
}));
jest.mock('../lib/workspace-persistence', () => ({
  get readWorkspaceWorktrees(): typeof mockReadWorkspaceWorktrees {
    return mockReadWorkspaceWorktrees;
  },
}));
jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: jest.fn(() => ({
    executionsDir: '/executions',
  })),
}));

import {
  dispatchResumeQueueEntry,
  handleResumeUsageLimitedChats,
  handleResumeUsageLimitedSessions,
  registerUsageLimitedChatsHandlers,
  resolveResumeQueueItems,
  validateResumeQueueRequestTargets,
} from '../ipc/usage-limited-chats';
import {
  buildExistingTabDispatchOptions,
  sendWorktreeChatMessage,
} from '../services/chat-service';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { resolveWorkEntryForChat } from '../lib/cowork-work-entries';
import { writeChatTabsFile } from '../lib/chat-tabs';
import {
  clearAuthenticationInterruptedChat,
  clearUsageLimitedChat,
  readUsageLimitedChats,
} from '../lib/usage-limited-chats-registry';
import { resumePipelineExecutionFromMain } from '../pipelines/pipeline-resume-service';

const mockedSendWorktreeChatMessage = jest.mocked(sendWorktreeChatMessage);
const mockedBuildExistingTabDispatchOptions = jest.mocked(
  buildExistingTabDispatchOptions,
);
const mockedReadChatTabsFile = jest.mocked(readChatTabsFile);
const mockedResolveWorkEntryForChat = jest.mocked(resolveWorkEntryForChat);
const mockedWriteChatTabsFile = jest.mocked(writeChatTabsFile);
const mockedClearUsageLimitedChat = jest.mocked(clearUsageLimitedChat);
const mockedClearAuthenticationInterruptedChat = jest.mocked(
  clearAuthenticationInterruptedChat,
);
const mockedReadUsageLimitedChats = jest.mocked(readUsageLimitedChats);
const mockedResumePipelineExecutionFromMain = jest.mocked(
  resumePipelineExecutionFromMain,
);

function tab(over: Partial<PersistedChatTab> = {}): PersistedChatTab {
  return {
    id: 'chat-1',
    title: 'Some Chat',
    messages: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function tabsFile(tabs: PersistedChatTab[]): ChatTabsFile {
  return {
    version: 1,
    activeTabId: tabs[0]?.id ?? '',
    tabs,
  };
}

function executionState(id: string): ExecutionState {
  return {
    version: 6,
    id,
    pipeline_id: 'pipeline',
    pipeline_snapshot: {
      name: 'Usage-limited pipeline',
      scope: ['directory'],
      jobs: {},
    },
    status: 'paused',
    jobs: {},
    job_definitions: {},
    job_groups: {},
    pending_pauses: [],
    started_at: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/repo',
    env: {},
    inputs: {},
    status_reasons: [],
  };
}

describe('handleResumeUsageLimitedChats', () => {
  it('waits for the durable terminal user prompt before completing a queued resume', async () => {
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      interfaceMode: 'claude-code',
    });
    const delivered = tab({
      interfaceMode: 'claude-code',
      messages: [
        {
          id: 'queue-attempt',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Continue' }],
        },
      ],
    });
    const awaitingDelivery = tab({ interfaceMode: 'claude-code' });
    mockedReadChatTabsFile
      .mockResolvedValueOnce(tabsFile([awaitingDelivery]))
      .mockResolvedValueOnce(tabsFile([awaitingDelivery]))
      .mockResolvedValueOnce(tabsFile([delivered]));
    const target = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    };
    await expect(
      handleResumeUsageLimitedChats(
        { targets: [target] },
        () => null,
        'queue-attempt',
      ),
    ).resolves.toEqual({ resumedCount: 1, failedTargets: [] });
    expect(mockedSendWorktreeChatMessage.mock.calls[0][1]).toMatchObject({
      preserveUsageLimitRegistry: true,
    });
    expect(
      mockedReadChatTabsFile.mock.calls.filter(
        ([, , options]) => options?.pageOnly === true,
      ),
    ).toHaveLength(2);
    expect(mockedClearUsageLimitedChat.mock.calls[0]?.[0]).toEqual(target);
    expect(
      typeof mockedClearUsageLimitedChat.mock.calls[0]?.[1]
        ?.onlyIfDetectedBefore,
    ).toBe('number');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockClaimCodexAuthenticationResume.mockResolvedValue(true);
    mockClearCodexAuthenticationResumeClaim.mockResolvedValue(undefined);
    mockedSendWorktreeChatMessage.mockResolvedValue({
      ok: true,
      chatId: 'chat-1',
    });
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      sdkSessionId: 'session-123',
      providerType: 'claude',
    });
    mockedClearUsageLimitedChat.mockResolvedValue(undefined);
    mockedWriteChatTabsFile.mockResolvedValue(undefined);
    mockedReadChatTabsFile.mockResolvedValue(tabsFile([tab()]));
    mockedReadUsageLimitedChats.mockResolvedValue([
      {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'claude',
        detectedAt: Date.now(),
        workspaceName: '',
        chatTitle: '',
      },
      {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-good',
        provider: 'claude',
        detectedAt: Date.now(),
        workspaceName: '',
        chatTitle: '',
      },
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        provider: 'claude',
        detectedAt: Date.now(),
        workspaceName: '',
        chatTitle: '',
      },
    ]);
    mockedClearAuthenticationInterruptedChat.mockResolvedValue(undefined);
  });

  it('does not attribute a resume when there is no eligible interruption', async () => {
    mockedReadUsageLimitedChats.mockResolvedValue([]);
    const target = { projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' };
    expect(
      await handleResumeUsageLimitedChats({ targets: [target] }, () => null),
    ).toEqual({ resumedCount: 0, failedTargets: [target] });
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'supports the registry-free restart fallback (agent progress: %s)',
    async (hasProgress) => {
      const target = {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
      };
      mockedReadUsageLimitedChats.mockResolvedValue([]);
      mockedReadChatTabsFile.mockResolvedValue(
        tabsFile([
          tab({
            interruptedTurns: { original: {} },
            messages: [
              {
                id: 'original',
                role: 'user',
                timestamp: 100,
                inputMode: 'voice',
                blocks: [{ type: 'text', text: 'Edit this' }],
              },
              ...(hasProgress
                ? [
                    {
                      id: 'progress',
                      role: 'assistant' as const,
                      timestamp: 110,
                      blocks: [{ type: 'text' as const, text: 'Working' }],
                    },
                  ]
                : []),
            ],
          }),
        ]),
      );

      expect(
        await handleResumeUsageLimitedChats({ targets: [target] }, () => null),
      ).toEqual({ resumedCount: 1, failedTargets: [] });
      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
      const sent = mockedSendWorktreeChatMessage.mock.calls[0]?.[0];
      expect(sent).toMatchObject({
        ...target,
        text: hasProgress ? 'Continue' : 'Edit this',
        resumesInterruptedTurn: true,
        autoResume: {
          reason: 'app_shutdown',
          resumesUserMessageId: 'original',
          resendsUserMessage: !hasProgress,
        },
      });
      if (hasProgress) expect(sent).not.toHaveProperty('inputMode');
      else expect(sent).toHaveProperty('inputMode', 'voice');
      expect(mockedClearUsageLimitedChat).toHaveBeenCalledTimes(1);
      expect(mockedClearUsageLimitedChat.mock.calls[0]?.[0]).toEqual(target);
    },
  );

  it.each([{ resumedBy: 'resume' }, { abandoned: true as const }])(
    'rejects resolved restart metadata without a registry entry: %j',
    async (interruption) => {
      const target = {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
      };
      mockedReadUsageLimitedChats.mockResolvedValue([]);
      mockedReadChatTabsFile.mockResolvedValue(
        tabsFile([tab({ interruptedTurns: { original: interruption } })]),
      );

      expect(
        await handleResumeUsageLimitedChats({ targets: [target] }, () => null),
      ).toEqual({ resumedCount: 0, failedTargets: [target] });
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect(mockedClearUsageLimitedChat).not.toHaveBeenCalled();
    },
  );

  it('rejects a concurrent caller and releases the claim for retry after dispatch failure', async () => {
    const target = { projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' };
    let rejectDispatch: (error: Error) => void = () => undefined;
    let markDispatchStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markDispatchStarted = resolve;
    });
    mockedSendWorktreeChatMessage.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectDispatch = reject;
          markDispatchStarted();
        }),
    );
    const first = handleResumeUsageLimitedChats(
      { targets: [target] },
      () => null,
    );
    await started;
    expect(
      await handleResumeUsageLimitedChats({ targets: [target] }, () => null),
    ).toEqual({ resumedCount: 0, failedTargets: [target] });
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
    expect(mockedClearUsageLimitedChat).not.toHaveBeenCalled();

    rejectDispatch(new Error('Unavailable'));
    expect(await first).toEqual({ resumedCount: 0, failedTargets: [target] });
    expect(
      await handleResumeUsageLimitedChats({ targets: [target] }, () => null),
    ).toEqual({ resumedCount: 1, failedTargets: [] });
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(2);
    expect(mockedClearUsageLimitedChat).toHaveBeenCalledTimes(1);
  });

  it.each(['lost response', 'cleanup failure'])(
    'reconciles an accepted app-shutdown resume after %s without another dispatch',
    async (failure) => {
      const target = {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
      };
      let current = tab({
        interruptedTurns: { original: {} },
        messages: [
          {
            id: 'original',
            role: 'user',
            timestamp: 100,
            blocks: [{ type: 'text', text: 'Edit this' }],
          },
        ],
      });
      mockedReadUsageLimitedChats.mockResolvedValue([
        {
          ...target,
          provider: 'claude',
          detectedAt: 120,
          interruptedUserMessageId: 'original',
          resumeReason: 'app_shutdown',
          workspaceName: '',
          chatTitle: '',
        },
      ]);
      mockedReadChatTabsFile.mockImplementation(() =>
        Promise.resolve(tabsFile([current])),
      );
      mockedSendWorktreeChatMessage.mockImplementationOnce((request) => {
        if (!request.userMessageId)
          throw new Error('Resume requires a message ID');
        current = {
          ...current,
          lastAcceptedUserMessageId: request.userMessageId,
          interruptedTurns: { original: { resumedBy: request.userMessageId } },
          messages: [
            ...current.messages,
            {
              id: request.userMessageId,
              role: 'user',
              timestamp: 150,
              userMessageSource: 'auto_resume',
              autoResume: request.autoResume,
              blocks: [{ type: 'text', text: request.text }],
            },
          ],
        };
        return failure === 'lost response'
          ? Promise.reject(new Error('Response lost after acceptance'))
          : Promise.resolve({ ok: true, chatId: target.chatId });
      });
      const logError = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      if (failure === 'cleanup failure')
        mockedClearUsageLimitedChat.mockRejectedValueOnce(new Error('ENOSPC'));
      try {
        expect(
          await handleResumeUsageLimitedChats(
            { targets: [target] },
            () => null,
          ),
        ).toEqual(
          failure === 'lost response'
            ? { resumedCount: 0, failedTargets: [target] }
            : { resumedCount: 1, failedTargets: [] },
        );
        expect(
          await handleResumeUsageLimitedChats(
            { targets: [target] },
            () => null,
          ),
        ).toEqual({ resumedCount: 1, failedTargets: [] });
        expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
        expect(mockedClearUsageLimitedChat.mock.calls.at(-1)?.[0]).toEqual(
          target,
        );
      } finally {
        logError.mockRestore();
      }
    },
  );

  it('derives app-shutdown provenance from the registry and exact interrupted turn', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      tabsFile([
        tab({
          interruptedTurns: { original: {} },
          messages: [
            {
              id: 'original',
              role: 'user',
              timestamp: 100,
              inputMode: 'voice',
              blocks: [{ type: 'text', text: 'Edit this' }],
            },
            {
              id: 'work',
              role: 'assistant',
              timestamp: 110,
              blocks: [
                {
                  type: 'tool_use',
                  toolUseId: 'edit',
                  toolName: 'Edit',
                  input: '{}',
                },
              ],
            },
          ],
        }),
      ]),
    );
    mockedReadUsageLimitedChats.mockResolvedValue([
      {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'claude',
        detectedAt: 120,
        interruptedUserMessageId: 'original',
        resumeReason: 'app_shutdown',
        workspaceName: '',
        chatTitle: '',
      },
    ]);
    expect(
      await handleResumeUsageLimitedChats(
        {
          targets: [
            { projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' },
          ],
        },
        () => null,
      ),
    ).toMatchObject({ resumedCount: 1 });
    const sent = mockedSendWorktreeChatMessage.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      text: 'Continue',
      autoResume: {
        reason: 'app_shutdown',
        resumesUserMessageId: 'original',
        resendsUserMessage: false,
      },
    });
    expect(sent).not.toHaveProperty('inputMode');
  });

  it('retries cleanup without duplicating an already accepted automatic resume', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      tabsFile([
        tab({
          lastAcceptedUserMessageId: 'accepted-resume',
          interruptedTurns: { original: { resumedBy: 'accepted-resume' } },
          messages: [
            {
              id: 'accepted-resume',
              role: 'user',
              timestamp: 150,
              userMessageSource: 'auto_resume',
              autoResume: {
                reason: 'app_shutdown',
                resumesUserMessageId: 'original',
                resendsUserMessage: false,
              },
              blocks: [{ type: 'text', text: 'Continue' }],
            },
          ],
        }),
      ]),
    );
    const target = { projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' };
    mockedReadUsageLimitedChats.mockResolvedValue([
      {
        ...target,
        provider: 'claude',
        detectedAt: 120,
        interruptedUserMessageId: 'original',
        resumeReason: 'app_shutdown',
        workspaceName: '',
        chatTitle: '',
      },
    ]);
    expect(
      await handleResumeUsageLimitedChats({ targets: [target] }, () => null),
    ).toEqual({ resumedCount: 1, failedTargets: [] });
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    expect(mockedClearUsageLimitedChat).toHaveBeenCalled();
  });

  it('refuses a registry anchor superseded by a newer human turn', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      tabsFile([
        tab({
          messages: [
            {
              id: 'new-human',
              role: 'user',
              timestamp: 100,
              blocks: [{ type: 'text', text: 'New work' }],
            },
          ],
        }),
      ]),
    );
    mockedReadUsageLimitedChats.mockResolvedValue([
      {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'claude',
        detectedAt: 200,
        interruptedUserMessageId: 'old',
        resumeReason: 'app_shutdown',
        workspaceName: '',
        chatTitle: '',
      },
    ]);
    expect(
      await handleResumeUsageLimitedChats(
        {
          targets: [
            { projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' },
          ],
        },
        () => null,
      ),
    ).toMatchObject({ resumedCount: 0 });
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('dispatches Continue with the built tab options and clears the registry entry', async () => {
    const req: ResumeUsageLimitedChatsRequest = {
      targets: [{ projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' }],
    };

    const res = await handleResumeUsageLimitedChats(req, () => null);

    expect(res).toEqual({ resumedCount: 1, failedTargets: [] });

    expect(mockedBuildExistingTabDispatchOptions).toHaveBeenCalledWith(
      'ws-a',
      'wt-1',
      'chat-1',
    );

    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
    const [sentRequest] = mockedSendWorktreeChatMessage.mock.calls[0];
    expect(sentRequest).toMatchObject({
      projectId: 'ws-a',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      text: 'Continue',
      initiationSource: 'automation',
      resumesInterruptedTurn: true,
      sdkSessionId: 'session-123',
      providerType: 'claude',
    });

    // Guarded by the instant the resume began, so a usage-limit record written
    // by the turn this resume just dispatched is not deleted by its own clear.
    const [clearTarget, clearOptions] =
      mockedClearUsageLimitedChat.mock.calls[0] ?? [];
    expect(clearTarget).toEqual({
      projectId: 'ws-a',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
    });
    expect(typeof clearOptions?.onlyIfDetectedBefore).toBe('number');
  });

  it('resumes a migrated standalone chat in its owning entry and clears its legacy registry key', async () => {
    const target = {
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'cowork-x',
      chatId: 'chat-1',
    };
    mockedResolveWorkEntryForChat.mockResolvedValue({
      entryId: 'owning-entry',
      archivedInEntryId: null,
    });
    const banner = {
      provider: 'claude' as const,
      message: 'Usage limit reached',
      resetsAt: 1000,
      detectedAt: 1,
      dismissKey: 'k1',
    };
    mockedReadChatTabsFile.mockImplementation((projectId, worktreeId) =>
      Promise.resolve(
        tabsFile(
          projectId === 'cowork-x' && worktreeId === 'owning-entry'
            ? [tab({ llmProviderUsageLimitBanner: banner })]
            : [],
        ),
      ),
    );
    expect(
      await handleResumeUsageLimitedChats({ targets: [target] }, () => null),
    ).toEqual({ resumedCount: 1, failedTargets: [] });
    expect(mockedBuildExistingTabDispatchOptions).toHaveBeenCalledWith(
      'cowork-x',
      'owning-entry',
      'chat-1',
    );
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'cowork-x',
        worktreeId: 'owning-entry',
        chatId: 'chat-1',
      }),
      expect.anything(),
    );
    expect(mockedClearUsageLimitedChat).toHaveBeenCalledWith(
      target,
      expect.anything(),
    );
    expect(mockedWriteChatTabsFile).toHaveBeenCalledWith(
      'cowork-x',
      'owning-entry',
      expect.anything(),
    );
  });

  it('re-sends the user last message when the last turn was just a rate-limited user prompt', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      tabsFile([
        tab({
          id: 'chat-1',
          messages: [
            {
              id: 'u1',
              role: 'user',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'Refactor the parser' }],
            },
            {
              id: 's1',
              role: 'system',
              timestamp: 2,
              blocks: [{ type: 'turn_timer', completedAt: 3 }],
            },
          ],
        }),
      ]),
    );

    const req: ResumeUsageLimitedChatsRequest = {
      targets: [{ projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' }],
    };

    const res = await handleResumeUsageLimitedChats(req, () => null);

    expect(res).toEqual({ resumedCount: 1, failedTargets: [] });
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
    const [sentRequest] = mockedSendWorktreeChatMessage.mock.calls[0];
    expect(sentRequest).toMatchObject({
      chatId: 'chat-1',
      text: 'Refactor the parser',
    });
  });

  it('forwards original file references and attachments when re-sending a user prompt', async () => {
    const fileReference = {
      displayPath: 'src/parser.ts',
      absolutePath: '/repo/src/parser.ts',
    };
    const attachmentPromptContext = {
      attachmentPath: '/tmp/context.md',
      promptKind: 'in-app-browser-resource' as const,
      sourceUrl: 'https://example.test/context',
    };
    mockedReadChatTabsFile.mockResolvedValue(
      tabsFile([
        tab({
          id: 'chat-1',
          messages: [
            {
              id: 'u1',
              role: 'user',
              timestamp: 1,
              blocks: [
                { type: 'file_references', references: [fileReference] },
                { type: 'text', text: 'Use the attached context' },
              ],
              attachmentPaths: ['/tmp/context.md'],
              attachmentPromptContexts: [attachmentPromptContext],
              inputMode: 'voice',
            },
            {
              id: 's1',
              role: 'system',
              timestamp: 2,
              blocks: [{ type: 'turn_timer', completedAt: 3 }],
            },
          ],
        }),
      ]),
    );

    const req: ResumeUsageLimitedChatsRequest = {
      targets: [{ projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' }],
    };

    const res = await handleResumeUsageLimitedChats(req, () => null);

    expect(res).toEqual({ resumedCount: 1, failedTargets: [] });
    const [sentRequest] = mockedSendWorktreeChatMessage.mock.calls[0];
    expect(sentRequest).toMatchObject({
      chatId: 'chat-1',
      text: 'Use the attached context',
      fileReferences: [fileReference],
      attachmentPaths: ['/tmp/context.md'],
      attachmentPromptContexts: [attachmentPromptContext],
      inputMode: 'voice',
    });
  });

  it('dispatches Continue when the agent already did work in the last turn', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      tabsFile([
        tab({
          id: 'chat-1',
          messages: [
            {
              id: 'u1',
              role: 'user',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'Refactor the parser' }],
            },
            {
              id: 'a1',
              role: 'assistant',
              timestamp: 2,
              blocks: [{ type: 'text', text: 'On it.' }],
            },
          ],
        }),
      ]),
    );

    const req: ResumeUsageLimitedChatsRequest = {
      targets: [{ projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' }],
    };

    const res = await handleResumeUsageLimitedChats(req, () => null);

    expect(res).toEqual({ resumedCount: 1, failedTargets: [] });
    const [sentRequest] = mockedSendWorktreeChatMessage.mock.calls[0];
    expect(sentRequest).toMatchObject({ chatId: 'chat-1', text: 'Continue' });
  });

  it('strips both the current and legacy usage-limit banner keys from the persisted tab', async () => {
    const staleTab: PersistedChatTab = {
      ...tab({ id: 'chat-1' }),
      llmProviderUsageLimitBanner: {
        provider: 'claude',
        message: 'Usage limit reached',
        detectedAt: 100,
        dismissKey: 'k1',
      },
      dismissedLlmProviderUsageLimitBannerKey: 'k0',
    };
    // The legacy pre-rename keys are not part of the current PersistedChatTab
    // type, so attach them the same way production data would carry them:
    // as extra fields on the persisted JSON object.
    Reflect.set(staleTab, 'claudeUsageLimitBanner', {
      message: 'legacy banner',
    });
    Reflect.set(staleTab, 'dismissedClaudeUsageLimitBannerKey', 'legacy-key');

    mockedReadChatTabsFile.mockResolvedValue(tabsFile([staleTab]));

    const req: ResumeUsageLimitedChatsRequest = {
      targets: [{ projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' }],
    };

    const res = await handleResumeUsageLimitedChats(req, () => null);

    expect(res).toEqual({ resumedCount: 1, failedTargets: [] });
    expect(mockedWriteChatTabsFile).toHaveBeenCalledTimes(1);

    const [writtenProjectId, writtenWorktreeId, writtenFile] =
      mockedWriteChatTabsFile.mock.calls[0];
    expect(writtenProjectId).toBe('ws-a');
    expect(writtenWorktreeId).toBe('wt-1');

    const writtenTab = writtenFile.tabs.find((t) => t.id === 'chat-1');
    if (!writtenTab) throw new Error('expected the written chat-1 tab');
    expect(writtenTab).not.toHaveProperty('llmProviderUsageLimitBanner');
    expect(writtenTab).not.toHaveProperty(
      'dismissedLlmProviderUsageLimitBannerKey',
    );
    expect(writtenTab).not.toHaveProperty('claudeUsageLimitBanner');
    expect(writtenTab).not.toHaveProperty('dismissedClaudeUsageLimitBannerKey');
  });

  it('does not write the tabs file when the tab carries no banner keys', async () => {
    mockedReadChatTabsFile.mockResolvedValue(tabsFile([tab({ id: 'chat-1' })]));

    const req: ResumeUsageLimitedChatsRequest = {
      targets: [{ projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' }],
    };

    const res = await handleResumeUsageLimitedChats(req, () => null);

    expect(res).toEqual({ resumedCount: 1, failedTargets: [] });
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
  });

  it('preserves a newer persisted banner recorded by the resumed turn', async () => {
    const staleTabs = tabsFile([
      tab({
        id: 'chat-1',
        llmProviderUsageLimitBanner: {
          provider: 'claude',
          message: 'Old usage limit',
          detectedAt: 1,
          dismissKey: 'old-limit',
        },
      }),
    ]);
    const freshTabs = tabsFile([
      tab({
        id: 'chat-1',
        llmProviderUsageLimitBanner: {
          provider: 'claude',
          message: 'New usage limit',
          detectedAt: Date.now() + 60_000,
          dismissKey: 'new-limit',
        },
      }),
    ]);
    let persistedTabs = staleTabs;
    mockedReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(persistedTabs),
    );
    mockedSendWorktreeChatMessage.mockImplementationOnce(() => {
      persistedTabs = freshTabs;
      return Promise.resolve({ ok: true, chatId: 'chat-1' });
    });

    const req: ResumeUsageLimitedChatsRequest = {
      targets: [{ projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' }],
    };

    await expect(
      handleResumeUsageLimitedChats(req, () => null),
    ).resolves.toEqual({ resumedCount: 1, failedTargets: [] });
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
  });

  it('validates target ids before reading chat tab files', async () => {
    const req: ResumeUsageLimitedChatsRequest = {
      targets: [{ projectId: '../ws-a', worktreeId: 'wt-1', chatId: 'chat-1' }],
    };

    const res = await handleResumeUsageLimitedChats(req, () => null);

    expect(res).toEqual({
      resumedCount: 0,
      failedTargets: req.targets,
    });
    expect(mockedBuildExistingTabDispatchOptions).not.toHaveBeenCalled();
    expect(mockedReadChatTabsFile).not.toHaveBeenCalled();
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('rejects provider-sign-in recovery through the unscoped legacy handler', async () => {
    mockedReadUsageLimitedChats.mockResolvedValue([
      {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'codex',
        detectedAt: 1,
        resumeReason: 'provider_sign_in',
        authenticationAttemptId: 'attempt-legacy',
        workspaceName: 'Workspace',
        chatTitle: 'Chat',
      },
    ]);
    const req: ResumeUsageLimitedChatsRequest = {
      targets: [{ projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' }],
    };

    await expect(
      handleResumeUsageLimitedChats(req, () => null),
    ).resolves.toEqual({ resumedCount: 0, failedTargets: req.targets });
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('isolates a per-target dispatch failure without aborting the rest of the batch', async () => {
    mockedBuildExistingTabDispatchOptions.mockImplementation(
      (projectId, worktreeId, chatId) => {
        if (chatId === 'chat-bad') {
          return Promise.reject(new Error('failed to load tab options'));
        }
        return Promise.resolve({ sdkSessionId: 'session-ok' });
      },
    );

    const req: ResumeUsageLimitedChatsRequest = {
      targets: [
        { projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-bad' },
        { projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-good' },
      ],
    };

    mockedReadChatTabsFile.mockResolvedValue(
      tabsFile([tab({ id: 'chat-bad' }), tab({ id: 'chat-good' })]),
    );
    const res = await handleResumeUsageLimitedChats(req, () => null);

    expect(res.resumedCount).toBe(1);
    expect(res.failedTargets).toEqual([
      { projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-bad' },
    ]);
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
    const [sentRequest] = mockedSendWorktreeChatMessage.mock.calls[0];
    expect(sentRequest).toMatchObject({ chatId: 'chat-good' });
  });

  it('still counts a successful dispatch as resumed even when post-dispatch cleanup fails', async () => {
    mockedWriteChatTabsFile.mockRejectedValue(
      new Error('ENOSPC: disk full, write'),
    );
    mockedReadChatTabsFile.mockResolvedValue(
      tabsFile([
        {
          ...tab({ id: 'chat-1' }),
          llmProviderUsageLimitBanner: {
            provider: 'claude',
            message: 'Usage limit reached',
            detectedAt: 100,
            dismissKey: 'k1',
          },
        },
      ]),
    );

    const req: ResumeUsageLimitedChatsRequest = {
      targets: [{ projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' }],
    };

    const res = await handleResumeUsageLimitedChats(req, () => null);

    // The `Continue` message really was dispatched before the cleanup I/O
    // failed, so this target must still be reported as resumed, not failed.
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
    expect(res.resumedCount).toBe(1);
    expect(res.failedTargets).toEqual([]);
  });
});

describe('handleResumeUsageLimitedSessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllActiveSessionInfos.mockReturnValue([]);
    mockLoadExecutionState.mockReset().mockResolvedValue(null);
    mockedSendWorktreeChatMessage.mockResolvedValue({
      ok: true,
      chatId: 'chat-1',
    });
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      sdkSessionId: 'session-123',
      providerType: 'codex',
    });
    mockedReadChatTabsFile.mockResolvedValue(tabsFile([tab()]));
    mockedWriteChatTabsFile.mockResolvedValue(undefined);
    mockedClearUsageLimitedChat.mockResolvedValue(undefined);
    mockedClearAuthenticationInterruptedChat.mockResolvedValue(undefined);
    mockedReadUsageLimitedChats.mockResolvedValue([]);
  });

  it('rejects a malformed authentication attempt id before authorization', async () => {
    await expect(
      handleResumeUsageLimitedSessions(
        {
          authenticationAttemptId: '../attempt',
          targets: [
            {
              kind: 'chat',
              projectId: 'ws-a',
              worktreeId: 'wt-1',
              chatId: 'chat-1',
            },
          ],
        },
        () => null,
      ),
    ).rejects.toThrow('authenticationAttemptId');
    expect(mockAssertResumeAllowed).not.toHaveBeenCalled();
  });

  it('authorizes persisted provider-sign-in work when the renderer omits the attempt id', async () => {
    mockedReadUsageLimitedChats.mockResolvedValue([
      {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'codex',
        detectedAt: 1,
        resumeReason: 'provider_sign_in',
        authenticationAttemptId: 'attempt-1',
        workspaceName: 'Workspace',
        chatTitle: 'Chat',
      },
    ]);

    await expect(
      handleResumeUsageLimitedSessions(
        {
          targets: [
            {
              kind: 'chat',
              projectId: 'ws-a',
              worktreeId: 'wt-1',
              chatId: 'chat-1',
            },
          ],
        },
        () => null,
      ),
    ).resolves.toMatchObject({ resumedCount: 1, failedTargets: [] });
    expect(mockAssertResumeAllowed).toHaveBeenCalledWith('attempt-1');
    expect(mockReleaseAuthenticationPause).toHaveBeenCalledWith(
      { projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' },
      'attempt-1',
    );
    expect(mockedClearAuthenticationInterruptedChat).toHaveBeenCalledWith(
      { projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' },
      'attempt-1',
    );
  });

  it('preserves authentication recovery until terminal delivery is durable', async () => {
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      interfaceMode: 'claude-code',
      providerType: 'codex',
    });
    mockedReadUsageLimitedChats.mockResolvedValue([
      {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'codex',
        detectedAt: 1,
        resumeReason: 'provider_sign_in',
        authenticationAttemptId: 'attempt-terminal',
        workspaceName: 'Workspace',
        chatTitle: 'Chat',
      },
    ]);
    let tabReadCount = 0;
    mockedReadChatTabsFile.mockImplementation(() => {
      tabReadCount += 1;
      const dispatchedMessageId =
        mockedSendWorktreeChatMessage.mock.calls[0]?.[0].userMessageId;
      return Promise.resolve(
        tabsFile([
          tab({
            interfaceMode: 'claude-code',
            messages:
              tabReadCount >= 3 && dispatchedMessageId
                ? [
                    {
                      id: dispatchedMessageId,
                      role: 'user',
                      timestamp: 1,
                      blocks: [{ type: 'text', text: 'Continue' }],
                    },
                  ]
                : [],
          }),
        ]),
      );
    });

    await expect(
      handleResumeUsageLimitedSessions(
        {
          targets: [
            {
              kind: 'chat',
              projectId: 'ws-a',
              worktreeId: 'wt-1',
              chatId: 'chat-1',
            },
          ],
        },
        () => null,
      ),
    ).resolves.toMatchObject({ resumedCount: 1, failedTargets: [] });

    expect(mockedSendWorktreeChatMessage.mock.calls[0]?.[1]).toMatchObject({
      preserveUsageLimitRegistry: true,
    });
    expect(
      mockedReadChatTabsFile.mock.calls.some(
        ([, , options]) => options?.pageOnly === true,
      ),
    ).toBe(true);
  });

  it('retries authentication recovery when terminal delivery is not confirmed', async () => {
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      interfaceMode: 'claude-code',
      providerType: 'codex',
    });
    mockedReadUsageLimitedChats.mockResolvedValue([
      {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'codex',
        detectedAt: 1,
        resumeReason: 'provider_sign_in',
        authenticationAttemptId: 'attempt-terminal-retry',
        workspaceName: 'Workspace',
        chatTitle: 'Chat',
      },
    ]);
    let stopping = true;
    mockGetResumeQueue.mockImplementation(() => ({
      isStopping: (): boolean => stopping,
    }));
    mockedReadChatTabsFile.mockImplementation(
      (_projectId, _worktreeId, options) => {
        const retryMessageId =
          mockedSendWorktreeChatMessage.mock.calls[1]?.[0].userMessageId;
        return Promise.resolve(
          tabsFile([
            tab({
              interfaceMode: 'claude-code',
              messages:
                options?.pageOnly && retryMessageId
                  ? [
                      {
                        id: retryMessageId,
                        role: 'user',
                        timestamp: 1,
                        blocks: [{ type: 'text', text: 'Continue' }],
                      },
                    ]
                  : [],
            }),
          ]),
        );
      },
    );
    const request: ResumeUsageLimitedSessionsRequest = {
      targets: [
        {
          kind: 'chat',
          projectId: 'ws-a',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
        },
      ],
    };

    await expect(
      handleResumeUsageLimitedSessions(request, () => null),
    ).resolves.toMatchObject({ resumedCount: 0, failedTargets: [{}] });
    stopping = false;
    await expect(
      handleResumeUsageLimitedSessions(request, () => null),
    ).resolves.toMatchObject({ resumedCount: 1, failedTargets: [] });

    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(2);
    expect(mockClearCodexAuthenticationResumeClaim).toHaveBeenCalled();
    expect(mockedClearAuthenticationInterruptedChat).toHaveBeenCalledTimes(1);
  });

  it('does not release a newer authentication pause that appears before dispatch', async () => {
    const base = {
      projectId: 'ws-a',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      provider: 'codex' as const,
      detectedAt: 1,
      resumeReason: 'provider_sign_in' as const,
      workspaceName: 'Workspace',
      chatTitle: 'Chat',
    };
    mockedReadUsageLimitedChats
      .mockResolvedValueOnce([
        { ...base, authenticationAttemptId: 'attempt-1' },
      ])
      .mockResolvedValueOnce([
        { ...base, authenticationAttemptId: 'attempt-2' },
      ]);

    const result = await handleResumeUsageLimitedSessions(
      {
        authenticationAttemptId: 'attempt-1',
        targets: [
          {
            kind: 'chat',
            projectId: 'ws-a',
            worktreeId: 'wt-1',
            chatId: 'chat-1',
          },
        ],
      },
      () => null,
    );

    expect(result.resumedCount).toBe(0);
    expect(result.failedTargets).toHaveLength(1);
    expect(mockReleaseAuthenticationPause).not.toHaveBeenCalled();
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('retries durable cleanup without dispatching Continue twice', async () => {
    const interrupted = {
      projectId: 'ws-a',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      provider: 'codex' as const,
      detectedAt: 1,
      resumeReason: 'provider_sign_in' as const,
      authenticationAttemptId: 'attempt-cleanup',
      workspaceName: 'Workspace',
      chatTitle: 'Chat',
    };
    mockedReadUsageLimitedChats.mockResolvedValue([interrupted]);
    mockedClearAuthenticationInterruptedChat
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);
    const request: ResumeUsageLimitedSessionsRequest = {
      targets: [
        {
          kind: 'chat',
          projectId: 'ws-a',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
        },
      ],
    };

    const first = await handleResumeUsageLimitedSessions(request, () => null);
    const sentMessageId =
      mockedSendWorktreeChatMessage.mock.calls[0]?.[0].userMessageId;
    if (!sentMessageId) throw new Error('Expected a dispatched resume message');
    mockedReadChatTabsFile.mockResolvedValue(
      tabsFile([
        tab({
          messages: [
            {
              id: sentMessageId,
              role: 'user',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'Continue' }],
            },
          ],
        }),
      ]),
    );
    const second = await handleResumeUsageLimitedSessions(request, () => null);

    expect(first).toMatchObject({ resumedCount: 1, failedTargets: [] });
    expect(second).toMatchObject({ resumedCount: 0, staleCount: 1 });
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
    expect(mockedClearAuthenticationInterruptedChat).toHaveBeenCalledTimes(2);
  });

  it('does not clear recovery for a duplicate while the original dispatch is in flight', async () => {
    const interrupted = {
      projectId: 'ws-a',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      provider: 'codex' as const,
      detectedAt: 1,
      resumeReason: 'provider_sign_in' as const,
      authenticationAttemptId: 'attempt-in-flight',
      workspaceName: 'Workspace',
      chatTitle: 'Chat',
    };
    mockedReadUsageLimitedChats.mockResolvedValue([interrupted]);
    let rejectDispatch = (error: Error): void => {
      void error;
      throw new Error('Dispatch rejection was not initialized.');
    };
    mockedSendWorktreeChatMessage.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectDispatch = reject;
      }),
    );
    const request: ResumeUsageLimitedSessionsRequest = {
      targets: [
        {
          kind: 'chat',
          projectId: 'ws-a',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
        },
      ],
    };

    const original = handleResumeUsageLimitedSessions(request, () => null);
    await Promise.resolve();
    const duplicate = await handleResumeUsageLimitedSessions(
      request,
      () => null,
    );

    expect(duplicate).toMatchObject({ resumedCount: 0, staleCount: 1 });
    expect(mockedClearAuthenticationInterruptedChat).not.toHaveBeenCalled();
    rejectDispatch(new Error('dispatch failed'));
    await expect(original).resolves.toMatchObject({
      resumedCount: 0,
      failedTargets: [{ error: 'Chat resume dispatch failed' }],
    });
    expect(mockPauseForAuthentication).toHaveBeenCalledWith(
      { projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' },
      'attempt-in-flight',
    );
    expect(mockedClearAuthenticationInterruptedChat).not.toHaveBeenCalled();
  });

  it('does not redispatch a durable authentication claim after restart', async () => {
    const interrupted = {
      projectId: 'ws-a',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      provider: 'codex' as const,
      detectedAt: 1,
      resumeReason: 'provider_sign_in' as const,
      authenticationAttemptId: 'attempt-after-restart',
      workspaceName: 'Workspace',
      chatTitle: 'Chat',
    };
    mockedReadUsageLimitedChats.mockResolvedValue([interrupted]);
    mockClaimCodexAuthenticationResume.mockResolvedValueOnce(false);

    const result = await handleResumeUsageLimitedSessions(
      {
        targets: [
          {
            kind: 'chat',
            projectId: 'ws-a',
            worktreeId: 'wt-1',
            chatId: 'chat-1',
          },
        ],
      },
      () => null,
    );

    expect(result).toMatchObject({ resumedCount: 1, staleCount: 0 });
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
    const dispatchedRequest = mockedSendWorktreeChatMessage.mock.calls[0]?.[0];
    if (!dispatchedRequest) throw new Error('Expected a dispatched request');
    expect(dispatchedRequest.chatId).toBe('chat-1');
    expect(dispatchedRequest.userMessageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(mockedClearAuthenticationInterruptedChat).toHaveBeenCalledWith(
      { projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' },
      'attempt-after-restart',
    );
    expect(mockClearCodexAuthenticationResumeClaim).toHaveBeenCalledTimes(1);
  });

  it('counts an authentication resume as successful when registry cleanup fails', async () => {
    mockedReadUsageLimitedChats.mockResolvedValue([
      {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'codex',
        detectedAt: 1,
        resumeReason: 'provider_sign_in',
        authenticationAttemptId: 'attempt-cleanup-failure',
        workspaceName: 'Workspace',
        chatTitle: 'Chat',
      },
    ]);
    mockedClearAuthenticationInterruptedChat.mockRejectedValueOnce(
      new Error('registry write failed'),
    );

    const result = await handleResumeUsageLimitedSessions(
      {
        targets: [
          {
            kind: 'chat',
            projectId: 'ws-a',
            worktreeId: 'wt-1',
            chatId: 'chat-1',
          },
        ],
      },
      () => null,
    );

    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      resumedCount: 1,
      staleCount: 0,
      failedTargets: [],
    });
  });

  it('isolates pipeline failures and counts stale reason selections', async () => {
    const reasonId = '123e4567-e89b-42d3-a456-426614174000';
    mockedResumePipelineExecutionFromMain.mockImplementation((request) => {
      if (request.executionId === 'failure') {
        return Promise.reject(new Error('dispatch failed'));
      }
      return request.executionId === 'stale'
        ? Promise.resolve({
            status: 'stale-noop',
            state: executionState('stale'),
          })
        : Promise.resolve({
            status: 'started',
            state: executionState('started'),
          });
    });
    const req: ResumeUsageLimitedSessionsRequest = {
      targets: ['started', 'stale', 'failure'].map((executionId) => ({
        kind: 'pipeline' as const,
        executionId,
        statusReasonIds: [reasonId],
      })),
    };

    await expect(
      handleResumeUsageLimitedSessions(req, () => null),
    ).resolves.toMatchObject({
      resumedCount: 1,
      staleCount: 1,
      failedTargets: [
        {
          target: { kind: 'pipeline', executionId: 'failure' },
          error: 'dispatch failed',
        },
      ],
    });
    expect(mockedResumePipelineExecutionFromMain).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: 'started',
        statusReasonIds: [reasonId],
        allowStaleNoop: true,
        initiationSource: 'automation',
      }),
    );
  });
});

describe('resume queue IPC boundary and dispatch', () => {
  const queuedChat: ResumeQueueEntry = {
    id: '123e4567-e89b-42d3-a456-426614174000',
    target: {
      kind: 'chat',
      projectId: 'ws-a',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
    },
    interruptionId: '1',
    title: 'Chat',
    workspaceName: 'Workspace',
    createdAt: 1,
    status: 'waiting',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllActiveSessionInfos.mockReturnValue([]);
    mockLoadExecutionState.mockReset().mockResolvedValue(null);
    mockListExecutionSummaries.mockReset().mockResolvedValue([]);
    mockReadWorkspaceIndexEntry.mockReset().mockResolvedValue({
      id: 'ws-a',
      name: 'Workspace',
      type: 'single-repo',
    });
    mockReadWorkspaceWorktrees
      .mockReset()
      .mockResolvedValue([{ id: 'wt-1', label: 'main' }]);
    mockedSendWorktreeChatMessage.mockResolvedValue({
      ok: true,
      chatId: 'chat-1',
    });
    mockedBuildExistingTabDispatchOptions.mockResolvedValue({
      sdkSessionId: 'session-123',
      providerType: 'codex',
    });
    mockedReadChatTabsFile.mockResolvedValue(tabsFile([tab()]));
    mockedClearUsageLimitedChat.mockResolvedValue(undefined);
    mockedClearAuthenticationInterruptedChat.mockResolvedValue(undefined);
  });

  it('rejects connection replacement inside the admission cache window', async () => {
    mockLiveProxyConnection = 'proxy-A';
    mockedReadUsageLimitedChats.mockResolvedValue([
      {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'codex',
        detectedAt: 1,
        accountProxyConnectionId: 'proxy-A',
        resumeReason: 'usage_limit',
        workspaceName: 'Workspace',
        chatTitle: 'Chat',
      },
    ]);
    registerUsageLimitedChatsHandlers(() => null);
    const configuration = mockConfigureResumeQueue.mock.calls[0]?.[0];
    if (!configuration) throw new Error('Expected queue configuration');
    const entry: ResumeQueueEntry = {
      ...queuedChat,
      accountProxyConnectionId: 'proxy-A',
      providers: ['codex'],
    };
    await expect(configuration.canDispatch([entry])).resolves.toBe(true);
    mockLiveProxyConnection = 'proxy-B';
    await expect(configuration.canDispatch([entry])).resolves.toBe(false);
    expect(mockGetAccountProxyStatus).toHaveBeenCalledTimes(1);
  });

  it('carries the recorded proxy connection through the trusted dispatch context', async () => {
    mockedReadUsageLimitedChats.mockResolvedValue([
      {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'codex',
        detectedAt: 1,
        accountProxyConnectionId: 'proxy-A',
        resumeReason: 'usage_limit',
        workspaceName: 'Workspace',
        chatTitle: 'Chat',
      },
    ]);
    await dispatchResumeQueueEntry(
      {
        ...queuedChat,
        accountProxyConnectionId: 'proxy-A',
        providers: ['codex'],
      },
      () => null,
    );
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requiredAccountProxyConnectionId: 'proxy-A' }),
    );
  });

  it('resumes queued provider-sign-in chats through attempt authorization', async () => {
    mockedReadUsageLimitedChats.mockResolvedValue([
      {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'codex',
        detectedAt: 1,
        resumeReason: 'provider_sign_in',
        authenticationAttemptId: 'attempt-1',
        workspaceName: 'Workspace',
        chatTitle: 'Chat',
      },
    ]);

    await expect(
      dispatchResumeQueueEntry(queuedChat, () => null),
    ).resolves.toBe('resumed');
    expect(mockAssertResumeAllowed).toHaveBeenCalledWith('attempt-1');
    expect(mockReleaseAuthenticationPause).toHaveBeenCalledWith(
      { projectId: 'ws-a', worktreeId: 'wt-1', chatId: 'chat-1' },
      'attempt-1',
    );
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userMessageId: queuedChat.id }),
      expect.anything(),
    );
  });

  it('does not admit a chat re-interrupted under a different authentication attempt', async () => {
    mockedReadUsageLimitedChats.mockResolvedValue([
      {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'codex',
        detectedAt: 2,
        resumeReason: 'provider_sign_in',
        authenticationAttemptId: 'attempt-new',
        workspaceName: 'Workspace',
        chatTitle: 'Chat',
      },
    ]);

    await expect(
      resolveResumeQueueItems({
        authenticationAttemptId: 'attempt-old',
        targets: [queuedChat.target],
      }),
    ).resolves.toEqual([]);
  });

  it('does not scan retained terminal history to throttle the queue', async () => {
    mockTerminalGetState.mockReturnValue({ turnState: 'running' });
    registerUsageLimitedChatsHandlers(() => null);
    const configuration = mockConfigureResumeQueue.mock.calls[0]?.[0];
    if (!configuration) throw new Error('Expected resume queue configuration');

    await expect(
      configuration.canDispatch([
        { ...queuedChat, status: 'resumed' },
        { ...queuedChat, id: '123e4567-e89b-42d3-a456-426614174001' },
      ]),
    ).resolves.toBe(true);
    expect(mockTerminalGetState).not.toHaveBeenCalled();
  });

  it('does not throttle resumes when four unrelated sessions are active', async () => {
    mockGetAllActiveSessionInfos.mockReturnValue(
      Array.from({ length: 4 }, (_, index) => ({
        projectId: 'other',
        worktreeId: 'worktree',
        chatId: `active-${index}`,
        providerType: 'claude',
        turnActive: true,
        createdAt: 0,
        lastActivityAt: 0,
        turnCount: 1,
        pendingMessageCount: 0,
      })),
    );
    registerUsageLimitedChatsHandlers(() => null);
    const configuration = mockConfigureResumeQueue.mock.calls[0]?.[0];
    if (!configuration) throw new Error('Expected resume queue configuration');
    await expect(configuration.canDispatch([queuedChat])).resolves.toBe(true);
    mockGetAllActiveSessionInfos.mockReturnValue([]);
  });

  it('keeps a terminal resume waiting while the renderer is unavailable', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      tabsFile([tab({ interfaceMode: 'claude-code' })]),
    );
    registerUsageLimitedChatsHandlers(
      () => null,
      (): boolean => false,
    );
    const configuration = mockConfigureResumeQueue.mock.calls[0]?.[0];
    if (!configuration) throw new Error('Expected resume queue configuration');

    await expect(configuration.canDispatch([queuedChat])).resolves.toBe(false);
  });

  it.each([
    'Corrupt JSON',
    'Unsupported execution state version',
    'Execution identity mismatch',
  ])(
    'keeps corrupt pipeline Stop and still recovers unrelated work: %s',
    async (message) => {
      const interruption = {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'codex' as const,
        detectedAt: 1,
        accountProxyConnectionId: 'proxy-A',
        resumeReason: 'usage_limit' as const,
        workspaceName: 'Workspace',
        chatTitle: 'Chat',
      };
      mockedReadUsageLimitedChats.mockResolvedValue([interruption]);
      mockLoadExecutionState.mockRejectedValue(new Error(message));
      registerUsageLimitedChatsHandlers(() => null);
      const configuration = mockConfigureResumeQueue.mock.calls[0]?.[0];
      if (!configuration) throw new Error('Expected queue configuration');
      const suppression = {
        targetKey: 'pipeline:broken',
        interruptionId: 'stopped-reason',
      };
      const queue = new ResumeQueueService({
        load: (): ReturnType<ResumeQueueDependencies['load']> =>
          Promise.resolve({
            version: 1,
            revision: 0,
            paused: false,
            entries: [],
            suppressedAutomaticResumes: [suppression],
          }),
        save: (): Promise<void> => Promise.resolve(),
        dispatch: (): Promise<'resumed'> => Promise.resolve('resumed'),
        reconcile: (): Promise<{ status: 'waiting' }> =>
          Promise.resolve({ status: 'waiting' }),
        now: (): number => 10_000,
        changed: (): void => undefined,
        readLiveAutomaticResumeInterruptionKeys:
          configuration.readLiveAutomaticResumeInterruptionKeys,
      });
      await queue.initialize();
      const recovery = new AccountProxyQuotaRecovery({
        now: (): number => 10_000,
        readInterrupted: (): Promise<Array<typeof interruption>> =>
          Promise.resolve([interruption]),
        readStatus: (): Promise<AccountProxyStatus> =>
          mockGetAccountProxyStatus(),
        resolveItems: (): Promise<ResumeQueueItem[]> =>
          Promise.resolve([
            {
              target: queuedChat.target,
              title: 'Chat',
              workspaceName: 'Workspace',
              interruptionId: '1',
              accountProxyConnectionId: 'proxy-A',
              providers: ['codex'],
            },
          ]),
      });
      await expect(recovery.collect(queue)).resolves.toBeUndefined();
      expect(queue.snapshot().entries).toHaveLength(1);
      expect(queue.snapshot().suppressedAutomaticResumes).toContainEqual(
        suppression,
      );
      await queue.control('stop');
      await expect(queue.control('dismiss')).resolves.toMatchObject({
        entries: [],
      });
      expect(queue.snapshot().suppressedAutomaticResumes).toContainEqual(
        suppression,
      );
    },
  );

  it('ignores unreadable retained pipelines when checking queue capacity', async () => {
    mockLoadExecutionState.mockRejectedValueOnce(
      new Error('Unsupported execution state version'),
    );
    registerUsageLimitedChatsHandlers(() => null);
    const configuration = mockConfigureResumeQueue.mock.calls[0]?.[0];
    if (!configuration) throw new Error('Expected resume queue configuration');

    await expect(
      configuration.canDispatch([
        {
          ...queuedChat,
          id: '123e4567-e89b-42d3-a456-426614174002',
          target: {
            kind: 'pipeline',
            executionId: '123e4567-e89b-42d3-a456-426614174003',
            statusReasonIds: ['reason-1'],
          },
          status: 'resumed',
        },
        queuedChat,
      ]),
    ).resolves.toBe(true);
  });

  it('admits an obsolete proxy pipeline entry so dispatch can settle it as skipped', async () => {
    mockLoadExecutionState.mockResolvedValueOnce(null);
    registerUsageLimitedChatsHandlers(() => null);
    const configuration = mockConfigureResumeQueue.mock.calls[0]?.[0];
    if (!configuration) throw new Error('Expected resume queue configuration');
    await expect(
      configuration.canDispatch([
        {
          ...queuedChat,
          accountProxyConnectionId: 'proxy',
          target: {
            kind: 'pipeline',
            executionId: 'deleted',
            statusReasonIds: ['old-reason'],
          },
        },
      ]),
    ).resolves.toBe(true);
  });

  it('admits an obsolete proxy chat entry so dispatch can settle it as skipped', async () => {
    mockedReadUsageLimitedChats.mockResolvedValue([]);
    registerUsageLimitedChatsHandlers(() => null);
    const configuration = mockConfigureResumeQueue.mock.calls[0]?.[0];
    if (!configuration) throw new Error('Expected resume queue configuration');
    await expect(
      configuration.canDispatch([
        {
          ...queuedChat,
          accountProxyConnectionId: 'proxy',
          accountProxyDetectedAt: 1000,
        },
      ]),
    ).resolves.toBe(true);
  });

  it('clears the matching interruption after accepted-message reconciliation', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      tabsFile([tab({ lastAcceptedUserMessageId: queuedChat.id })]),
    );
    mockedReadUsageLimitedChats.mockResolvedValue([
      {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'claude',
        detectedAt: 1,
        workspaceName: 'Workspace',
        chatTitle: 'Chat',
        resumeReason: 'usage_limit',
      },
    ]);
    registerUsageLimitedChatsHandlers(() => null);
    const configuration = mockConfigureResumeQueue.mock.calls[0]?.[0];
    if (!configuration) throw new Error('Expected resume queue configuration');

    await expect(configuration.reconcile(queuedChat)).resolves.toEqual({
      status: 'resumed',
    });
    expect(mockedClearUsageLimitedChat).toHaveBeenCalledWith(
      queuedChat.target,
      { onlyIfDetectedAt: 1 },
    );
  });

  it('reconciles a legacy queued resume against its migrated accepted message', async () => {
    const legacy: ResumeQueueEntry = {
      ...queuedChat,
      target: {
        kind: 'chat',
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'cowork-x',
        chatId: 'chat-1',
      },
    };
    const legacyTarget = legacy.target;
    if (legacyTarget.kind !== 'chat') {
      throw new Error('Expected a legacy chat target');
    }
    mockedResolveWorkEntryForChat.mockResolvedValue({
      entryId: 'owning-entry',
      archivedInEntryId: null,
    });
    mockedReadChatTabsFile.mockImplementation((projectId, worktreeId) =>
      Promise.resolve(
        tabsFile(
          projectId === 'cowork-x' && worktreeId === 'owning-entry'
            ? [tab({ lastAcceptedUserMessageId: legacy.id })]
            : [],
        ),
      ),
    );
    mockedReadUsageLimitedChats.mockResolvedValue([
      {
        ...legacyTarget,
        provider: 'claude',
        detectedAt: 1,
        workspaceName: 'Cowork',
        chatTitle: 'Chat',
      },
    ]);
    registerUsageLimitedChatsHandlers(() => null);
    const configuration = mockConfigureResumeQueue.mock.calls[0]?.[0];
    if (!configuration) throw new Error('Expected resume queue configuration');
    await expect(configuration.reconcile(legacy)).resolves.toEqual({
      status: 'resumed',
    });
    expect(mockedClearUsageLimitedChat).toHaveBeenCalledWith(legacy.target, {
      onlyIfDetectedAt: 1,
    });
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('clears authentication state after terminal-message reconciliation', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      tabsFile([
        tab({
          interfaceMode: 'claude-code',
          messages: [
            {
              id: queuedChat.id,
              role: 'user',
              timestamp: 2,
              blocks: [{ type: 'text', text: 'Continue' }],
            },
          ],
        }),
      ]),
    );
    mockedReadUsageLimitedChats.mockResolvedValue([
      {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'codex',
        detectedAt: 1,
        workspaceName: 'Workspace',
        chatTitle: 'Chat',
        resumeReason: 'provider_sign_in',
        authenticationAttemptId: 'attempt-1',
      },
    ]);
    registerUsageLimitedChatsHandlers(() => null);
    const configuration = mockConfigureResumeQueue.mock.calls[0]?.[0];
    if (!configuration) throw new Error('Expected resume queue configuration');

    await expect(configuration.reconcile(queuedChat)).resolves.toEqual({
      status: 'resumed',
    });
    expect(mockedClearAuthenticationInterruptedChat).toHaveBeenCalledWith(
      queuedChat.target,
      'attempt-1',
    );
    expect(mockClearCodexAuthenticationResumeClaim).toHaveBeenCalledWith(
      JSON.stringify(['attempt-1', queuedChat.target]),
    );
  });

  it('fails closed when a durable resume prompt was persisted without acceptance', async () => {
    mockedReadUsageLimitedChats.mockResolvedValue([
      {
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'claude',
        detectedAt: 1,
        workspaceName: 'Workspace',
        chatTitle: 'Chat',
        resumeReason: 'usage_limit',
      },
    ]);
    await expect(
      dispatchResumeQueueEntry(queuedChat, () => null),
    ).resolves.toBe('resumed');
    const durableMessageId =
      mockedSendWorktreeChatMessage.mock.calls[0]?.[0].userMessageId;
    if (!durableMessageId)
      throw new Error('Expected a durable resume message id');
    mockedReadChatTabsFile.mockResolvedValue(
      tabsFile([
        tab({
          messages: [
            {
              id: durableMessageId,
              role: 'user',
              timestamp: 2,
              blocks: [{ type: 'text', text: 'Continue' }],
            },
          ],
        }),
      ]),
    );
    registerUsageLimitedChatsHandlers(() => null);
    const configuration = mockConfigureResumeQueue.mock.calls[0]?.[0];
    if (!configuration) throw new Error('Expected resume queue configuration');

    await expect(configuration.reconcile(queuedChat)).resolves.toEqual({
      status: 'failed',
      error:
        'The app stopped during this resume. Check the session before trying again.',
    });
  });

  it('does not convert registry read failures into terminal skips', async () => {
    mockedReadUsageLimitedChats.mockImplementation((strict) =>
      strict
        ? Promise.reject(new SyntaxError('corrupt registry'))
        : Promise.resolve([]),
    );

    await expect(
      dispatchResumeQueueEntry(queuedChat, () => null),
    ).rejects.toThrow('corrupt registry');
    expect(mockedReadUsageLimitedChats).toHaveBeenCalledWith(true);
  });

  it('retries registry cleanup without redispatching a queued Continue', async () => {
    const interrupted = {
      projectId: 'ws-a',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      provider: 'claude' as const,
      detectedAt: 1,
      workspaceName: 'Workspace',
      chatTitle: 'Chat',
      resumeReason: 'usage_limit' as const,
    };
    mockedReadUsageLimitedChats.mockResolvedValue([interrupted]);
    mockedClearUsageLimitedChat
      .mockRejectedValueOnce(new Error('registry write failed'))
      .mockResolvedValueOnce(undefined);

    await expect(
      dispatchResumeQueueEntry(queuedChat, () => null),
    ).resolves.toBe('resumed');
    const sentMessageId =
      mockedSendWorktreeChatMessage.mock.calls[0]?.[0].userMessageId;
    if (!sentMessageId) throw new Error('Expected a dispatched resume message');
    mockedReadChatTabsFile.mockResolvedValue(
      tabsFile([
        tab({
          lastAcceptedUserMessageId: sentMessageId,
          messages: [
            {
              id: sentMessageId,
              role: 'user',
              timestamp: 2,
              blocks: [{ type: 'text', text: 'Continue' }],
            },
          ],
        }),
      ]),
    );

    await expect(
      dispatchResumeQueueEntry(
        {
          ...queuedChat,
          id: '123e4567-e89b-42d3-a456-426614174999',
        },
        () => null,
      ),
    ).resolves.toBe('resumed');

    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
    expect(mockedClearUsageLimitedChat).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed queue status reason ids at the IPC boundary', () => {
    expect(() =>
      validateResumeQueueRequestTargets({
        targets: [
          {
            kind: 'pipeline',
            executionId: '123e4567-e89b-42d3-a456-426614174000',
            statusReasonIds: ['../reason'],
          },
        ],
      }),
    ).toThrow('statusReasonIds');
  });
});
