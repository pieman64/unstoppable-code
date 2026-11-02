import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type ChatTabsFile,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { CreateWorktreeServiceOptions } from '../lib/worktree-service';

jest.mock('../agents/session-event-router', () => ({
  drainCurrentSessionEvents: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/git', () => ({
  getCurrentBranch: jest.fn(() => Promise.resolve('source-feature')),
}));
const mockCurrentBranch = jest.requireMock<{
  getCurrentBranch: jest.Mock<Promise<string>, []>;
}>('../lib/git').getCurrentBranch;
const mockResolveWorktreeTargetIds = jest.fn(
  (projectId: string, worktreeId: string) => ({ projectId, worktreeId }),
);
const mockTabs = new Map<string, ChatTabsFile>();
const mockUpdateCompatibilityTab = jest.fn(
  (
    { worktreeId }: { worktreeId: string },
    chatId: string,
    update: (tab: PersistedChatTab) => PersistedChatTab,
  ): Promise<{ tabsFile: ChatTabsFile; updated: boolean }> => {
    const tabsFile = mockTabs.get(worktreeId) ?? {
      version: 1 as const,
      tabs: [],
      activeTabId: '',
    };
    const index = tabsFile.tabs.findIndex((tab) => tab.id === chatId);
    const tab = tabsFile.tabs[index];
    if (!tab) return Promise.resolve({ tabsFile, updated: false });
    tabsFile.tabs[index] = update(tab);
    return Promise.resolve({ tabsFile, updated: true });
  },
);
const mockGetCompatibilityTabs = jest.fn(
  ({ worktreeId }: { worktreeId: string }): Promise<ChatTabsFile | undefined> =>
    Promise.resolve(mockTabs.get(worktreeId)),
);
const mockCommand = jest.fn(
  (envelope: {
    worktreeId: string;
    command: {
      type: string;
      cloneMode?: 'continuation';
      sourceTabId?: string;
      targetTabId?: string;
      tabId?: string;
      destinationTab?: PersistedChatTab;
    };
  }): Promise<{
    outcome: 'applied' | 'rejected' | 'not_found';
    reason?: string;
  }> => {
    const command = envelope.command;
    const tabs = mockTabs.get(envelope.worktreeId);
    if (tabs && command.type === 'chat.close_tab') {
      tabs.tabs = tabs.tabs.filter((tab) => tab.id !== command.tabId);
    }
    const sourceTab = tabs?.tabs.find((tab) => tab.id === command.sourceTabId);
    if (tabs && sourceTab && command.destinationTab) {
      tabs.tabs.push({
        ...structuredClone(command.destinationTab),
        messages: structuredClone(sourceTab.messages),
      });
    }
    return Promise.resolve({ outcome: 'applied' });
  },
);
const mockCopyStorageChats = jest.fn(
  (
    _source: unknown,
    destination: { worktreeId: string },
    tabsFile: ChatTabsFile,
  ): Promise<void> => {
    mockTabs.set(destination.worktreeId, structuredClone(tabsFile));
    return Promise.resolve();
  },
);
const mockSend = jest.fn<
  Promise<{ ok: boolean; chatId: string }>,
  [
    request: unknown,
    options?: { onTurnAccepted?: () => void; admissionSignal?: AbortSignal },
  ]
>(() => Promise.resolve({ ok: true, chatId: 'unused' }));
const mockDestroySession = jest.fn(() => Promise.resolve());
jest.mock('../agents/session-manager', () => ({
  get destroySession(): typeof mockDestroySession {
    return mockDestroySession;
  },
}));
const mockIngestProviderEvent = jest.fn(() => Promise.resolve());
const mockLogWarn = jest.fn();
jest.mock('../lib/main-process-logging', () => ({
  get logMainProcessWarn(): typeof mockLogWarn {
    return mockLogWarn;
  },
}));
const createWorktree = async (
  options: CreateWorktreeServiceOptions,
): Promise<{ id: string; branch: string }> => {
  try {
    await options.beforeGitReady?.({
      projectId: 'project',
      worktreeId: 'child',
      branchName: 'temporary-new-branch',
    });
    options.onGitSetupSettled?.({
      projectId: 'project',
      worktreeId: 'child',
      outcome: 'ready',
    });
    return { id: 'child', branch: 'temporary-new-branch' };
  } catch (error) {
    options.onGitSetupSettled?.({
      projectId: 'project',
      worktreeId: 'child',
      outcome: 'failed',
    });
    throw error;
  }
};
const mockCreateSingle = jest.fn(createWorktree);
const mockCreateMulti = jest.fn(createWorktree);
const mockForkOpenCode = jest.fn<
  Promise<{ sessionId: string; executionContext?: string }>,
  [unknown]
>(() => Promise.resolve({ sessionId: 'forked-opencode' }));
const mockDiscardOpenCode = jest.fn(() => Promise.resolve());
jest.mock(
  '../opencode/fork-session',
  () => ({
    get forkOpenCodeSessionByIdViaOneShot(): typeof mockForkOpenCode {
      return mockForkOpenCode;
    },
    get discardUnpublishedOpenCodeFork(): typeof mockDiscardOpenCode {
      return mockDiscardOpenCode;
    },
  }),
  { virtual: true },
);
type RendererSendRequest = {
  action: {
    type: string;
    projectId: string;
    worktreeId: string;
    chatId: string;
    text: string;
    queueForSetup: boolean;
  };
  hostSend?: 'start_branched_agent';
};
const mockRendererSend = jest.fn<
  Promise<{ ok: boolean }>,
  [RendererSendRequest, unknown]
>(() => Promise.resolve({ ok: true }));
jest.mock('../ipc/app-advisor', () => ({
  get requestAppAdvisorRendererTool(): typeof mockRendererSend {
    return mockRendererSend;
  },
}));
const mockConfig = jest.fn(() => Promise.resolve({ type: 'single-repo' }));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): unknown => ({
    get getCompatibilityTabs(): typeof mockGetCompatibilityTabs {
      return mockGetCompatibilityTabs;
    },
    get command(): typeof mockCommand {
      return mockCommand;
    },
    get copyStorageChats(): typeof mockCopyStorageChats {
      return mockCopyStorageChats;
    },
    get ingestProviderEvent(): typeof mockIngestProviderEvent {
      return mockIngestProviderEvent;
    },
    settleRejectedStartup: jest.fn(() => Promise.resolve()),
    get updateCompatibilityTab(): typeof mockUpdateCompatibilityTab {
      return mockUpdateCompatibilityTab;
    },
    updateCompatibilityTabs: (
      { worktreeId }: { worktreeId: string },
      update: (current: ChatTabsFile) => ChatTabsFile,
    ): Promise<ChatTabsFile> => {
      const next = update(
        mockTabs.get(worktreeId) ?? { version: 1, tabs: [], activeTabId: '' },
      );
      mockTabs.set(worktreeId, next);
      return Promise.resolve(next);
    },
  }),
}));
jest.mock('../services/chat-service', () => ({
  buildExistingTabDispatchOptions: (
    _project: string,
    worktreeId: string,
    chatId: string,
  ): Promise<unknown> => {
    const tab = mockTabs
      .get(worktreeId)
      ?.tabs.find((candidate) => candidate.id === chatId);
    return Promise.resolve({
      model: tab?.model,
      sdkSessionId: tab?.sdkSessionId,
      claudeForkSession: tab?.claudeForkSessionOnNextSend,
    });
  },
  get sendWorktreeChatMessage(): typeof mockSend {
    return mockSend;
  },
}));
const SPLIT_CALL_UUID = '11111111-2222-4333-8444-555555555555';
jest.mock('../lib/worktree-service', () => ({
  get createSingleRepoWorktree(): typeof mockCreateSingle {
    return mockCreateSingle;
  },
  get createMultiRepoWorktree(): typeof mockCreateMulti {
    return mockCreateMulti;
  },
}));
jest.mock('../lib/workspace-persistence', () => ({
  get readWorkspaceConfig(): typeof mockConfig {
    return mockConfig;
  },
  readWorkspaceWorktrees: (): Promise<unknown[]> => Promise.resolve([]),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (_project: string, worktreeId: string): string =>
    `/worktrees/${worktreeId}`,
  get resolveWorktreeTargetIds(): typeof mockResolveWorktreeTargetIds {
    return mockResolveWorktreeTargetIds;
  },
}));
jest.mock('../lib/project-worktree-runtime', () => ({
  startProjectWorktreePostCreateSetup: jest.fn(),
}));
jest.mock('../lib/workspace-worktree-runtime', () => ({
  startWorkspaceWorktreePostCreateSetup: jest.fn(),
}));
jest.mock('../codex/fork-thread', () => ({
  forkCodexThreadByIdViaOneShot: jest.fn(() =>
    Promise.resolve('forked-thread'),
  ),
}));
const mockForkCodex = jest.requireMock<{
  forkCodexThreadByIdViaOneShot: jest.Mock<Promise<string>, unknown[]>;
}>('../codex/fork-thread').forkCodexThreadByIdViaOneShot;

import { startSplitAgent } from '../canopy-tools/start-split-agent-runtime';

const runtime = {
  signal: new AbortController().signal,
  projectId: 'project',
  worktreeId: 'source',
  chatId: 'source-chat',
  cwd: '/worktrees/source',
  getWindow: (): null => null,
};
const defaultCommand = mockCommand.getMockImplementation();
let source: PersistedChatTab;
beforeEach(() => {
  jest.clearAllMocks();
  mockCommand.mockReset();
  if (defaultCommand) mockCommand.mockImplementation(defaultCommand);
  mockIngestProviderEvent.mockReset().mockResolvedValue(undefined);
  mockSend.mockReset().mockResolvedValue({ ok: true, chatId: 'unused' });
  mockResolveWorktreeTargetIds.mockImplementation((projectId, worktreeId) => ({
    projectId,
    worktreeId,
  }));
  mockConfig.mockResolvedValue({ type: 'single-repo' });
  mockTabs.clear();
  source = {
    id: 'source-chat',
    title: 'Task',
    providerType: 'claude',
    sdkSessionId: 'source-session',
    createdAt: new Date().toISOString(),
    autoArchive: true,
    transcript: {
      format: 'complete-message-jsonl-v1',
      committedMessageCount: 2,
      committedByteLength: 200,
      transcriptRevision: 3,
      hasActiveSidecar: false,
      messageCount: 2,
      lastMessageId: 'assistant',
    },
    messages: [
      {
        id: 'user',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Original task' }],
      },
      {
        id: 'assistant',
        role: 'assistant',
        timestamp: 2,
        claudeUuid: SPLIT_CALL_UUID,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'pending-tool',
            toolName: 'Bash',
            input: '{}',
          },
        ],
      },
    ],
  };
  mockTabs.set('source', {
    version: 1,
    tabs: [source],
    activeTabId: source.id,
  });
});

it('copies an active chat and submits a user prompt resumed at the split call without changing its source', async () => {
  source.description = 'Generated task summary';
  // Like the canonical fork, refuse to anchor on the open split call: drop the
  // carried session and disclose a fresh start.
  mockCommand.mockImplementationOnce((envelope) => {
    const tabs = mockTabs.get(envelope.worktreeId);
    const destination = envelope.command.destinationTab;
    if (tabs && destination) {
      const fresh: PersistedChatTab = {
        ...structuredClone(destination),
        messages: structuredClone(source.messages),
        ...(destination.forkedFrom
          ? { forkedFrom: { ...destination.forkedFrom, modelContext: 'fresh' } }
          : {}),
      };
      delete fresh.sdkSessionId;
      delete fresh.claudeForkSessionOnNextSend;
      tabs.tabs.push(fresh);
    }
    return Promise.resolve({ outcome: 'applied' });
  });
  const before = structuredClone(source);
  const result = await startSplitAgent(
    'start_forked_agent',
    { followUpInstruction: 'Investigate independently' },
    runtime,
  );
  const copy = mockTabs.get('source')?.tabs[1];
  expect(source).toEqual(before);
  expect(mockGetCompatibilityTabs).toHaveBeenCalledWith(
    { projectId: 'project', worktreeId: 'source' },
    { chatIds: ['source-chat'] },
  );
  expect(mockTabs.get('source')?.activeTabId).toBe(source.id);
  expect(copy).toMatchObject({
    id: result.chatId,
    title: 'Fork: Generated task summary',
    sdkSessionId: 'source-session',
    claudeForkSessionOnNextSend: true,
    forkedFrom: { chatId: source.id, resumePointRequired: true },
  });
  expect(copy?.forkedFrom?.modelContext).toBeUndefined();
  expect(copy?.description).toBeUndefined();
  expect(copy?.autoArchive).toBeUndefined();
  expect(
    copy?.messages.some((message) =>
      message.blocks.some(
        (block) => block.type === 'text' && block.text === 'Original task',
      ),
    ),
  ).toBe(true);
  const instruction = copy?.pendingSystemInstructions?.find(
    (item) => item.id === 'independent-agent-start',
  );
  expect(instruction?.text).toContain(
    'You are now running as an independent forked chat.',
  );
  expect(instruction?.text).toContain('Investigate independently');
  // The fork resumes the source session at the assistant entry that made
  // the split call and answers that open call, rather than starting fresh.
  expect(mockSend).toHaveBeenCalledWith(
    expect.objectContaining({
      chatId: copy?.id,
      worktreeId: 'source',
      text: 'Continue',
      sdkSessionId: 'source-session',
      claudeForkSession: true,
      claudeForkResumeAt: SPLIT_CALL_UUID,
      claudeForkToolResults: [
        {
          toolUseId: 'pending-tool',
          content: expect.stringContaining('forked chat') as unknown,
        },
      ],
    }),
    expect.anything(),
  );
  expect(mockCreateSingle).not.toHaveBeenCalled();
});

it('uses the canonical full-history fork transaction for a same-worktree split', async () => {
  const descriptor = source.transcript;
  if (!descriptor) throw new Error('Expected transcript descriptor');
  source.transcript = {
    ...descriptor,
    messageCount: 620,
    lastMessageId: 'assistant',
  };

  const result = await startSplitAgent(
    'start_forked_agent',
    { followUpInstruction: 'Inspect the complete history' },
    runtime,
  );

  const command = mockCommand.mock.calls[0]?.[0].command;
  expect(command).toMatchObject({
    type: 'chat.fork_tab',
    sourceTabId: source.id,
    targetTabId: result.chatId,
    atMessageId: 'assistant',
  });
  expect(command?.destinationTab).toMatchObject({
    id: result.chatId,
    messages: [],
  });
});

it.each(['start_forked_agent', 'start_branched_agent'] as const)(
  'closes only the new chat when %s dispatch fails after canonical persistence',
  async (kind) => {
    const before = structuredClone(source);
    const failure = new Error('Claude startup refused the resume point');
    if (kind === 'start_forked_agent') mockSend.mockRejectedValueOnce(failure);
    else mockRendererSend.mockRejectedValueOnce(failure);

    await expect(
      startSplitAgent(kind, { followUpInstruction: 'Investigate' }, runtime),
    ).rejects.toBe(failure);

    const forkCommand = mockCommand.mock.calls.find(
      ([envelope]) => envelope.command.type === 'chat.fork_tab',
    );
    const childId =
      forkCommand?.[0].command.targetTabId ??
      mockCopyStorageChats.mock.calls[0]?.[2].tabs[0]?.id;
    expect(childId).toBeTruthy();
    const worktreeId = kind === 'start_forked_agent' ? 'source' : 'child';
    expect(mockDestroySession).toHaveBeenCalledWith(
      'project',
      worktreeId,
      childId,
    );
    expect(mockIngestProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        worktreeId,
        chatId: childId,
        data: {
          type: 'error',
          error: failure.message,
        },
      }),
    );
    expect(mockCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId: 'project',
        worktreeId,
        command: { type: 'chat.close_tab', tabId: childId, mode: 'archive' },
      }),
    );
    expect(source).toEqual(before);
    expect(
      mockTabs.get(worktreeId)?.tabs.some((tab) => tab.id === childId),
    ).toBe(false);
    expect(mockDestroySession.mock.invocationCallOrder[0]).toBeLessThan(
      mockIngestProviderEvent.mock.invocationCallOrder[0] ?? 0,
    );
  },
);

it('retains a successful independent chat without running failure cleanup', async () => {
  const result = await startSplitAgent(
    'start_forked_agent',
    { followUpInstruction: 'Investigate' },
    runtime,
  );
  expect(
    mockTabs.get('source')?.tabs.some((tab) => tab.id === result.chatId),
  ).toBe(true);
  expect(mockDestroySession).not.toHaveBeenCalled();
  expect(mockIngestProviderEvent).not.toHaveBeenCalled();
});

it('closes a persisted fork when restoring its provider metadata fails', async () => {
  const failure = new Error('metadata write failed');
  mockUpdateCompatibilityTab.mockRejectedValueOnce(failure);
  await expect(
    startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Investigate' },
      runtime,
    ),
  ).rejects.toBe(failure);
  expect(mockTabs.get('source')?.tabs).toEqual([source]);
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockDestroySession).toHaveBeenCalledTimes(1);
});

it('closes a partially published branch when copying its storage fails', async () => {
  const failure = new Error('copy failed after publication');
  mockCopyStorageChats.mockImplementationOnce(
    (_source, destination, tabsFile) => {
      mockTabs.set(destination.worktreeId, structuredClone(tabsFile));
      return Promise.reject(failure);
    },
  );
  await expect(
    startSplitAgent(
      'start_branched_agent',
      { followUpInstruction: 'Investigate' },
      runtime,
    ),
  ).rejects.toBe(failure);
  expect(mockTabs.get('child')?.tabs).toEqual([]);
  expect(mockRendererSend).not.toHaveBeenCalled();
  expect(mockDestroySession).toHaveBeenCalledWith(
    'project',
    'child',
    expect.any(String),
  );
});

it('still closes the failed tab when provider teardown throws', async () => {
  const failure = new Error('dispatch rejected');
  mockSend.mockRejectedValueOnce(failure);
  mockDestroySession.mockRejectedValueOnce(
    new Error('provider already exited'),
  );
  await expect(
    startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Investigate' },
      runtime,
    ),
  ).rejects.toBe(failure);
  expect(mockTabs.get('source')?.tabs).toEqual([source]);
  expect(mockLogWarn).toHaveBeenCalledWith(
    expect.stringContaining('Failed to stop'),
    expect.any(Error),
  );
});

it('preserves a fork rejection when recording the error targets a missing chat', async () => {
  const failure = new Error('source fork rejected');
  mockCommand.mockResolvedValueOnce({
    outcome: 'rejected',
    reason: failure.message,
  });
  mockCommand.mockResolvedValueOnce({ outcome: 'not_found' });
  mockIngestProviderEvent.mockRejectedValueOnce(
    new Error('Provider event targets missing chat'),
  );
  await expect(
    startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Investigate' },
      runtime,
    ),
  ).rejects.toThrow(/^source fork rejected$/);
  expect(mockCommand.mock.calls.at(-1)?.[0]).toMatchObject({
    command: { type: 'chat.close_tab' },
  });
  expect(mockLogWarn).not.toHaveBeenCalledWith(
    expect.stringContaining('Failed to close'),
    expect.anything(),
  );
});

it('closes an existing failed fork even when recording its error fails', async () => {
  const failure = new Error('dispatch rejected');
  mockSend.mockRejectedValueOnce(failure);
  mockIngestProviderEvent.mockRejectedValueOnce(
    new Error('error write failed'),
  );
  await expect(
    startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Investigate' },
      runtime,
    ),
  ).rejects.toBe(failure);
  expect(mockTabs.get('source')?.tabs).toEqual([source]);
});

it('preserves an accepted direct fork when later send persistence rejects', async () => {
  const failure = new Error('fork marker persistence failed');
  mockSend.mockImplementationOnce((_request, options) => {
    options?.onTurnAccepted?.();
    return Promise.reject(failure);
  });
  await expect(
    startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Investigate' },
      runtime,
    ),
  ).rejects.toBe(failure);
  expect(mockDestroySession).not.toHaveBeenCalled();
  expect(mockTabs.get('source')?.tabs).toHaveLength(2);
  expect(mockTabs.get('source')?.tabs[0]).toEqual(source);
  expect(mockIngestProviderEvent).not.toHaveBeenCalled();
});

it('reports cleanup rejection instead of claiming the failed tab was removed', async () => {
  mockSend.mockImplementationOnce(() => {
    mockCommand.mockResolvedValueOnce({
      outcome: 'rejected',
      reason: 'storage unavailable',
    });
    return Promise.reject(new Error('dispatch rejected'));
  });
  await expect(
    startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Investigate' },
      runtime,
    ),
  ).rejects.toThrow('The failed chat could not be closed');
  expect(mockIngestProviderEvent).toHaveBeenCalled();
  expect(mockLogWarn).toHaveBeenCalledWith(
    expect.stringContaining('Failed to close'),
    expect.any(Error),
  );
});

it.each(['single-repo', 'multi-repo'])(
  'reserves a child %s worktree and submits through the normal setup queue',
  async (type) => {
    mockConfig.mockResolvedValue({ type });
    const result = await startSplitAgent(
      'start_branched_agent',
      { followUpInstruction: 'Implement the other part' },
      runtime,
    );
    expect(result).toMatchObject({
      ok: true,
      worktreeId: 'child',
      delivery: 'submitted',
    });
    expect(
      type === 'single-repo' ? mockCreateSingle : mockCreateMulti,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'project',
        baseWorktreeId: 'source',
        deferGitSetup: true,
        startPostCreateSetup: true,
      }),
    );
    expect(mockTabs.get('source')?.tabs).toEqual([source]);
    const instruction = mockTabs
      .get('child')
      ?.tabs[0]?.pendingSystemInstructions?.find(
        (item) => item.id === 'worktree-relocation',
      );
    expect(instruction?.text).toContain('fresh branch');
    expect(instruction?.text).not.toContain('temporary-new-branch');
    expect(instruction?.text).toContain(
      'New working directory: \"/worktrees/child\"',
    );
    expect(instruction?.text).toContain(
      'Originating worktree location: \"/worktrees/source\"',
    );
    if (type === 'single-repo') {
      expect(instruction?.text).toContain(
        'Originating branch: \"source-feature\"',
      );
      expect(mockCurrentBranch).toHaveBeenCalledWith('/worktrees/source');
    } else {
      expect(instruction?.text).toContain('Originating branch: unavailable.');
      expect(mockCurrentBranch).not.toHaveBeenCalled();
    }
    expect(instruction?.text).toContain('read-only reference');
    expect(instruction?.text).toContain(
      'Limit all changes to the new working directory',
    );
    expect(instruction?.text).not.toContain('Implement the other part');
    expect(
      mockTabs
        .get('child')
        ?.tabs[0]?.pendingSystemInstructions?.find(
          (item) => item.id === 'independent-agent-start',
        )?.text,
    ).toContain('Implement the other part');
    expect(mockRendererSend.mock.calls[0]?.[0].action).toEqual({
      type: 'worktree-chat.send_message',
      projectId: 'project',
      worktreeId: 'child',
      chatId: result.chatId,
      text: 'Continue',
      queueForSetup: true,
    });
    // The renderer only runs this send for the trusted host marker.
    expect(mockRendererSend.mock.calls[0]?.[0].hostSend).toBe(
      'start_branched_agent',
    );
    expect(mockSend).not.toHaveBeenCalled();
  },
);

it('streams branched history and tool artifacts through canonical cross-scope copy', async () => {
  const result = await startSplitAgent(
    'start_branched_agent',
    { followUpInstruction: 'Inspect the complete history' },
    runtime,
  );

  expect(mockCopyStorageChats).toHaveBeenCalledWith(
    { projectId: 'project', worktreeId: 'source' },
    { projectId: 'project', worktreeId: 'child' },
    expect.objectContaining({
      tabs: [expect.objectContaining({ id: result.chatId, messages: [] })],
    }),
    { version: 1, archived: [] },
    { [result.chatId]: source.id },
    undefined,
    { [result.chatId]: 'assistant' },
  );
});

it.each([
  ['Plan Explore', PLAN_EXPLORE_CHAT_PROJECT_ID],
  ['Code Review', CODE_REVIEW_CHAT_PROJECT_ID],
])('branches a %s chat from its borrowed worktree target', async (_, scope) => {
  const scopeId = 'specialized-scope-1';
  mockResolveWorktreeTargetIds.mockReturnValueOnce({
    projectId: 'project',
    worktreeId: 'source',
  });
  mockTabs.set(scopeId, {
    version: 1,
    tabs: [source],
    activeTabId: source.id,
  });

  const result = await startSplitAgent(
    'start_branched_agent',
    { followUpInstruction: 'Implement from the specialized chat' },
    { ...runtime, projectId: scope, worktreeId: scopeId },
  );

  expect(mockConfig).toHaveBeenCalledWith('project');
  expect(mockCreateSingle).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: 'project',
      baseWorktreeId: 'source',
    }),
  );
  expect(mockTabs.get('child')?.tabs[0]?.forkedFrom).toMatchObject({
    projectId: scope,
    worktreeId: scopeId,
    chatId: source.id,
  });
  expect(mockRendererSend.mock.calls[0]?.[0].action).toMatchObject({
    projectId: 'project',
    worktreeId: 'child',
    chatId: result.chatId,
  });
});

it('forks Codex context before launching and never shares the source thread', async () => {
  source.providerType = 'codex';
  source.executionHarness = 'codex';
  const result = await startSplitAgent(
    'start_forked_agent',
    { followUpInstruction: 'Investigate' },
    runtime,
  );
  expect(mockForkCodex).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceThreadId: 'source-session',
      sourceChatId: source.id,
    }),
  );
  expect(mockTabs.get('source')?.tabs[1]?.sdkSessionId).toBe('forked-thread');
  expect(mockSend).toHaveBeenCalledWith(
    expect.objectContaining({
      sdkSessionId: 'forked-thread',
      chatId: result.chatId,
    }),
    expect.anything(),
  );
});

it('forks branched Codex context into the destination worktree', async () => {
  source.providerType = 'codex';
  source.executionHarness = 'codex';
  await startSplitAgent(
    'start_branched_agent',
    { followUpInstruction: 'Investigate' },
    runtime,
  );
  expect(mockForkCodex).toHaveBeenCalledWith(
    expect.objectContaining({
      cwd: '/worktrees/child',
      worktreeId: 'child',
      sourceThreadId: 'source-session',
      sourceChatId: source.id,
    }),
  );
  expect(mockCreateSingle.mock.invocationCallOrder[0]).toBeLessThan(
    mockForkCodex.mock.invocationCallOrder[0],
  );
  expect(mockTabs.get('child')?.tabs[0]?.sdkSessionId).toBe('forked-thread');
});

it('waits for the destination checkout before forking branched Codex context', async () => {
  source.providerType = 'codex';
  source.executionHarness = 'codex';
  let createOptions: CreateWorktreeServiceOptions | undefined;
  mockCreateSingle.mockImplementationOnce((options) => {
    createOptions = options;
    return Promise.resolve({
      id: 'child',
      branch: 'temporary-new-branch',
    });
  });

  const pending = startSplitAgent(
    'start_branched_agent',
    { followUpInstruction: 'Investigate' },
    runtime,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(mockForkCodex).not.toHaveBeenCalled();
  const beforeGitReady = createOptions?.beforeGitReady;
  if (!beforeGitReady) {
    throw new Error('Expected branched-agent Git readiness callback.');
  }
  await beforeGitReady({
    projectId: 'project',
    worktreeId: 'child',
    branchName: 'temporary-new-branch',
  });
  createOptions?.onGitSetupSettled?.({
    projectId: 'project',
    worktreeId: 'child',
    outcome: 'ready',
  });
  await pending;

  expect(mockForkCodex).toHaveBeenCalledWith(
    expect.objectContaining({
      cwd: '/worktrees/child',
      worktreeId: 'child',
    }),
  );
});

it('fails without persisting when deferred Git setup fails before a Codex fork', async () => {
  source.providerType = 'codex';
  source.executionHarness = 'codex';
  let createOptions: CreateWorktreeServiceOptions | undefined;
  mockCreateSingle.mockImplementationOnce((options) => {
    createOptions = options;
    return Promise.resolve({
      id: 'child',
      branch: 'temporary-new-branch',
    });
  });

  const pending = startSplitAgent(
    'start_branched_agent',
    { followUpInstruction: 'Investigate' },
    runtime,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const onGitFailed = createOptions?.onGitFailed;
  if (!onGitFailed) {
    throw new Error('Expected branched-agent Git failure callback.');
  }
  onGitFailed({
    projectId: 'project',
    worktreeId: 'child',
    error: 'checkout failed',
  });
  createOptions?.onGitSetupSettled?.({
    projectId: 'project',
    worktreeId: 'child',
    outcome: 'failed',
  });

  await expect(pending).rejects.toThrow('checkout failed');
  expect(mockForkCodex).not.toHaveBeenCalled();
  expect(mockTabs.get('child')).toBeUndefined();
  expect(mockRendererSend).not.toHaveBeenCalled();
});

it('settles when deferred Git setup is cancelled before a Codex fork', async () => {
  source.providerType = 'codex';
  source.executionHarness = 'codex';
  let createOptions: CreateWorktreeServiceOptions | undefined;
  mockCreateSingle.mockImplementationOnce((options) => {
    createOptions = options;
    return Promise.resolve({
      id: 'child',
      branch: 'temporary-new-branch',
    });
  });

  const pending = startSplitAgent(
    'start_branched_agent',
    { followUpInstruction: 'Investigate' },
    runtime,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const onGitSetupSettled =
    createOptions && 'onGitSetupSettled' in createOptions
      ? createOptions.onGitSetupSettled
      : undefined;
  expect(typeof onGitSetupSettled).toBe('function');
  if (typeof onGitSetupSettled !== 'function') {
    throw new Error('Expected branched-agent Git settlement callback.');
  }
  onGitSetupSettled({
    projectId: 'project',
    worktreeId: 'child',
    outcome: 'cancelled',
  });

  await expect(pending).rejects.toThrow(
    'Worktree setup ended before the Codex context could be forked.',
  );
  expect(mockForkCodex).not.toHaveBeenCalled();
  expect(mockTabs.get('child')).toBeUndefined();
  expect(mockRendererSend).not.toHaveBeenCalled();
});

it('fails before persisting or starting a chat when the branched provider fork fails', async () => {
  source.executionHarness = 'codex';
  mockForkCodex.mockRejectedValueOnce(new Error('fork failed'));
  await expect(
    startSplitAgent(
      'start_branched_agent',
      { followUpInstruction: 'Investigate' },
      runtime,
    ),
  ).rejects.toThrow('fork failed');
  expect(mockCreateSingle).toHaveBeenCalled();
  expect(mockTabs.get('child')).toBeUndefined();
  expect(mockSend).not.toHaveBeenCalled();
});

it('rejects missing source scopes before any mutation', async () => {
  await expect(
    startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Investigate' },
      { ...runtime, chatId: 'missing' },
    ),
  ).rejects.toThrow('existing editable chat');
  expect(mockSend).not.toHaveBeenCalled();
});

it('forks a Cowork chat in the same entry with independent context and settings', async () => {
  mockConfig.mockResolvedValue({ type: 'cowork' });
  source.model = 'sonnet';
  source.approvalMode = 'ask';
  source.modelConfig = { thinkingLevel: 'high' };
  const coworkRuntime = {
    ...runtime,
    projectId: 'cowork-project',
    worktreeId: 'cowork-entry',
    executionScope: 'directory' as const,
    cwd: '/cowork/project',
  };
  mockTabs.set('cowork-entry', {
    version: 1,
    tabs: [source],
    activeTabId: source.id,
  });
  const result = await startSplitAgent(
    'start_forked_agent',
    { followUpInstruction: 'Explore a separate idea' },
    coworkRuntime,
  );

  expect(result).toMatchObject({ ok: true, worktreeId: 'cowork-entry' });
  expect(mockCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: 'cowork-project',
      worktreeId: 'cowork-entry',
      command: expect.objectContaining({ type: 'chat.fork_tab' }) as unknown,
    }),
  );
  const copy = mockTabs
    .get('cowork-entry')
    ?.tabs.find((tab) => tab.id === result.chatId);
  expect(copy).toMatchObject({
    model: source.model,
    modelConfig: source.modelConfig,
    approvalMode: source.approvalMode,
    sdkSessionId: source.sdkSessionId,
    claudeForkSessionOnNextSend: true,
    forkedFrom: {
      projectId: 'cowork-project',
      worktreeId: 'cowork-entry',
      chatId: source.id,
    },
  });
  expect(mockSend).toHaveBeenCalledWith(
    expect.objectContaining({
      claudeForkResumeAt: SPLIT_CALL_UUID,
      projectId: 'cowork-project',
      worktreeId: 'cowork-entry',
      chatId: result.chatId,
      text: 'Continue',
    }),
    expect.anything(),
  );
  expect(mockCreateSingle).not.toHaveBeenCalled();
});

it('keeps App Advisor identity and dispatch surfaces when forking an entry chat', async () => {
  const advisorSurfaces = {
    getMainWindow: (): null => null,
    getAppAdvisorWindow: (): null => null,
    ensureAppAdvisorWindow: jest.fn(),
    openAppAdvisorWindow: jest.fn(),
  };
  const advisorRuntime = {
    ...runtime,
    projectId: APP_ADVISOR_PROJECT_ID,
    worktreeId: 'advisor-entry',
    appAdvisorSurfaces: advisorSurfaces,
  };
  mockTabs.set('advisor-entry', {
    version: 1,
    tabs: [source],
    activeTabId: source.id,
  });
  const result = await startSplitAgent(
    'start_forked_agent',
    { followUpInstruction: 'Check another possibility' },
    advisorRuntime,
  );

  expect(result).toMatchObject({ ok: true, worktreeId: 'advisor-entry' });
  expect(mockCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'advisor-entry',
      command: expect.objectContaining({ type: 'chat.fork_tab' }) as unknown,
    }),
  );
  expect(mockSend).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'advisor-entry',
      chatId: result.chatId,
      claudeForkSession: true,
      claudeForkResumeAt: SPLIT_CALL_UUID,
    }),
    expect.objectContaining({ appAdvisorSurfaces: advisorSurfaces }),
  );
  expect(mockCreateSingle).not.toHaveBeenCalled();
});

it('keeps branching code-only and rejects the legacy Advisor global slot', async () => {
  for (const scope of [
    { ...runtime, executionScope: 'directory' as const },
    { ...runtime, projectId: APP_ADVISOR_PROJECT_ID, worktreeId: 'entry' },
  ]) {
    await expect(
      startSplitAgent(
        'start_branched_agent',
        { followUpInstruction: 'Branch this task' },
        scope,
      ),
    ).rejects.toThrow('worktree');
  }
  await expect(
    startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Fork this task' },
      {
        ...runtime,
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
      },
    ),
  ).rejects.toThrow('Orchestrator');
  expect(mockCommand).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

it.each([true, false])(
  'refuses unqualified Cursor agent forks with persisted harness %s',
  async (hasHarness) => {
    source.providerType = 'cursor';
    source.executionHarness = hasHarness ? 'cursor' : undefined;
    if (!hasHarness) source.model = undefined;
    source.sdkSessionId = 'parent-cursor-session';
    await expect(
      startSplitAgent(
        'start_forked_agent',
        { followUpInstruction: 'Continue separately' },
        runtime,
      ),
    ).rejects.toThrow('not available');
    expect(mockTabs.get('source')?.tabs).toHaveLength(1);
    expect(mockCommand).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  },
);

it('refuses unqualified Cursor forks even without an owning turn signal', async () => {
  source.providerType = 'cursor';
  source.executionHarness = 'cursor';
  await expect(
    startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Continue' },
      {
        ...runtime,
        signal: undefined,
      },
    ),
  ).rejects.toThrow('not available');
  expect(mockCommand).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

it('refuses Cursor branched starts before setup or publication until cancellation is supported', async () => {
  source.providerType = 'cursor';
  source.executionHarness = 'cursor';
  await expect(
    startSplitAgent(
      'start_branched_agent',
      { followUpInstruction: 'Continue' },
      runtime,
    ),
  ).rejects.toThrow('Branched agents');
  expect(mockCreateSingle).not.toHaveBeenCalled();
  expect(mockCreateMulti).not.toHaveBeenCalled();
  expect(mockCommand).not.toHaveBeenCalled();
  expect(mockRendererSend).not.toHaveBeenCalled();
});

it('does not publish a fork after parent Stop during the source read', async () => {
  const stop = new AbortController();
  mockGetCompatibilityTabs.mockImplementationOnce(({ worktreeId }) => {
    stop.abort(new Error('Parent stopped'));
    return Promise.resolve(mockTabs.get(worktreeId));
  });
  await expect(
    startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Continue' },
      {
        ...runtime,
        signal: stop.signal,
      },
    ),
  ).rejects.toThrow('Parent stopped');
  expect(mockCommand).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

it('closes a newly published fork when parent Stop wins before dispatch', async () => {
  const stop = new AbortController();
  mockCommand.mockImplementationOnce(async (request) => {
    const result = await defaultCommand?.(request);
    stop.abort(new Error('Parent stopped'));
    return result ?? { outcome: 'applied' };
  });
  await expect(
    startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Continue' },
      {
        ...runtime,
        signal: stop.signal,
      },
    ),
  ).rejects.toThrow('Parent stopped');
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockCommand.mock.calls.at(-1)?.[0].command.type).toBe(
    'chat.close_tab',
  );
  expect(mockTabs.get('source')?.tabs).toHaveLength(1);
});

it('closes a fork when parent Stop wins during send preparation', async () => {
  const stop = new AbortController();
  const accepted = jest.fn();
  mockSend.mockImplementationOnce(async (_request, options) => {
    await Promise.resolve();
    stop.abort(new Error('Parent stopped during admission'));
    options?.admissionSignal?.throwIfAborted();
    accepted();
    options?.onTurnAccepted?.();
    return { ok: true, chatId: 'unused' };
  });
  await expect(
    startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Continue' },
      {
        ...runtime,
        signal: stop.signal,
      },
    ),
  ).rejects.toThrow('Parent stopped during admission');
  expect(accepted).not.toHaveBeenCalled();
  expect(mockTabs.get('source')?.tabs).toHaveLength(1);
});

it('keeps an accepted fork independent when its parent stops', async () => {
  const stop = new AbortController();
  mockSend.mockImplementationOnce(async (_request, options) => {
    options?.admissionSignal?.throwIfAborted();
    options?.onTurnAccepted?.();
    await Promise.resolve();
    stop.abort(new Error('Parent stopped after acceptance'));
    return { ok: true, chatId: 'unused' };
  });
  await expect(
    startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Continue' },
      {
        ...runtime,
        signal: stop.signal,
      },
    ),
  ).resolves.toMatchObject({ ok: true, delivery: 'submitted' });
  expect(mockTabs.get('source')?.tabs).toHaveLength(2);
});

it.each(['start_forked_agent', 'start_branched_agent'] as const)(
  'preserves OpenCode native context before publishing %s',
  async (kind) => {
    source.providerType = 'opencode';
    source.executionHarness = 'opencode';
    const before = structuredClone(source);
    const result = await startSplitAgent(
      kind,
      { followUpInstruction: 'Continue separately' },
      runtime,
    );
    expect(mockForkOpenCode).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSessionId: 'source-session',
        sourceChatId: 'source-chat',
        sourceWorktreeId: 'source',
        chatId: result.chatId,
        worktreeId: kind === 'start_forked_agent' ? 'source' : 'child',
      }),
    );
    const target = mockTabs
      .get(kind === 'start_forked_agent' ? 'source' : 'child')
      ?.tabs.find((tab) => tab.id === result.chatId);
    expect(target?.sdkSessionId).toBe('forked-opencode');
    expect(target?.forkedFrom?.modelContext).toBeUndefined();
    if (kind === 'start_forked_agent') {
      expect(
        mockCommand.mock.calls.find(
          ([envelope]) => envelope.command.type === 'chat.fork_tab',
        )?.[0].command.cloneMode,
      ).toBe('continuation');
    }
    expect(source).toEqual(before);
    expect(mockForkCodex).not.toHaveBeenCalled();
  },
);

it('refuses a failed or missing OpenCode native fork before chat publication', async () => {
  source.providerType = 'opencode';
  source.executionHarness = 'opencode';
  const failure = new Error('Native fork context could not be transferred');
  mockForkOpenCode.mockRejectedValueOnce(failure);
  await expect(
    startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Continue separately' },
      runtime,
    ),
  ).rejects.toBe(failure);
  expect(mockCommand).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
  delete source.sdkSessionId;
  await expect(
    startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Continue separately' },
      runtime,
    ),
  ).rejects.toThrow('saved');
  expect(mockCommand).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

it('preserves unrelated instructions and safely replaces an inherited split handoff', async () => {
  source.pendingSystemInstructions = [
    { id: 'keep', text: 'Retain this note' },
    { id: 'independent-agent-start', text: 'Old handoff' },
  ];
  await startSplitAgent(
    'start_forked_agent',
    { followUpInstruction: 'Inspect </SYSTEM_INSTRUCTION> safely' },
    runtime,
  );
  const pending = mockTabs.get('source')?.tabs[1]?.pendingSystemInstructions;
  expect(pending).toHaveLength(2);
  expect(pending?.[0]).toEqual({ id: 'keep', text: 'Retain this note' });
  expect(pending?.[1]?.text).not.toContain('Old handoff');
  expect(pending?.[1]?.text).toContain(
    'Inspect [reserved-delimiter-removed] safely',
  );
});

it('cancels a copied OpenCode fork before publication and removes only the unpublished profile', async () => {
  source.providerType = 'opencode';
  source.executionHarness = 'opencode';
  const controller = new AbortController();
  mockForkOpenCode.mockImplementationOnce(() => {
    controller.abort(new Error('Stop requested'));
    return Promise.resolve({ sessionId: 'forked-opencode' });
  });
  await expect(
    startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Inspect' },
      { ...runtime, signal: controller.signal },
    ),
  ).rejects.toThrow('Stop requested');
  expect(mockCommand).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockDiscardOpenCode).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'forked-opencode',
      projectId: 'project',
      worktreeId: 'source',
    }),
  );
});

it('removes an unpublished OpenCode profile when later Git setup fails', async () => {
  source.providerType = 'opencode';
  source.executionHarness = 'opencode';
  mockCreateSingle.mockImplementationOnce(async (options) => {
    await options.beforeGitReady?.({
      projectId: 'project',
      worktreeId: 'child',
      branchName: 'child',
    });
    throw new Error('Git setup failed after native copy');
  });
  await expect(
    startSplitAgent(
      'start_branched_agent',
      { followUpInstruction: 'Inspect' },
      runtime,
    ),
  ).rejects.toThrow('Git setup failed');
  expect(mockCopyStorageChats).not.toHaveBeenCalled();
  expect(mockDiscardOpenCode).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'forked-opencode',
      worktreeId: 'child',
    }),
  );
});

it('closes a published OpenCode tab without starting it when Stop races canonical persistence', async () => {
  source.providerType = 'opencode';
  source.executionHarness = 'opencode';
  const controller = new AbortController();
  const persist = mockCommand.getMockImplementation();
  if (!persist) throw new Error('Missing canonical fixture');
  mockCommand.mockImplementationOnce(async (command) => {
    const result = await persist(command);
    controller.abort(new Error('Stop during publication'));
    return result;
  });
  await expect(
    startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Inspect' },
      { ...runtime, signal: controller.signal },
    ),
  ).rejects.toThrow('Stop during publication');
  expect(mockSend).not.toHaveBeenCalled();
  expect(
    mockCommand.mock.calls.some(
      ([request]) => request.command.type === 'chat.close_tab',
    ),
  ).toBe(true);
  expect(mockDiscardOpenCode).not.toHaveBeenCalled();
});

it('carries managed fork funding context through canonical publication and startup', async () => {
  source.providerType = 'opencode';
  source.executionHarness = 'opencode';
  source.model = 'gateway-model';
  const executionContext = 'org:123e4567-e89b-12d3-a456-426614174000';
  // The host fork owns authority resolution; the split path must retain its result.
  const next = { sessionId: 'forked-opencode', executionContext };
  mockForkOpenCode.mockResolvedValueOnce(next);
  const result = await startSplitAgent(
    'start_forked_agent',
    { followUpInstruction: 'Continue' },
    runtime,
  );
  expect(mockForkOpenCode.mock.calls[0]?.[0]).toMatchObject({
    model: 'gateway-model',
  });
  const target = mockTabs
    .get('source')
    ?.tabs.find((tab) => tab.id === result.chatId);
  expect(target?.executionContext).toBe(executionContext);
  expect(target?.sdkSessionId).toBe('forked-opencode');
});

it.each(['start_forked_agent', 'start_branched_agent'] as const)(
  'starts an independent Copilot %s with a fresh native session and frozen host cutoff',
  async (kind) => {
    source.providerType = 'copilot';
    source.executionHarness = 'copilot';
    source.model = 'copilot:fixture-model';
    source.approvalMode = 'ask';
    source.pluginSelections = {
      collectionIds: ['review'],
      skillRefs: [],
      pluginRefs: [],
    };
    const original = structuredClone(source);
    const result = await startSplitAgent(
      kind,
      { followUpInstruction: 'Continue the approved investigation' },
      runtime,
    );
    const copy = mockTabs
      .get(result.worktreeId)
      ?.tabs.find((tab) => tab.id === result.chatId);
    expect(copy?.sdkSessionId).toBeUndefined();
    expect(copy).toMatchObject({
      providerType: 'copilot',
      executionHarness: 'copilot',
      model: source.model,
      approvalMode: 'ask',
      pluginSelections: source.pluginSelections,
      forkedFrom: { chatId: source.id, atMessageId: 'assistant' },
    });
    expect(source).toEqual(original);
    expect(
      copy?.pendingSystemInstructions?.some((note) =>
        note.text.includes('Continue the approved investigation'),
      ),
    ).toBe(true);
    if (kind === 'start_branched_agent')
      expect(
        copy?.pendingSystemInstructions?.some((note) =>
          note.text.includes('read-only'),
        ),
      ).toBe(true);
  },
);
it('keeps a legacy Copilot fork fresh when harness and model metadata are absent', async () => {
  source.providerType = 'copilot';
  delete source.executionHarness;
  delete source.model;
  const original = structuredClone(source);
  const result = await startSplitAgent(
    'start_forked_agent',
    { followUpInstruction: 'Continue the legacy chat independently' },
    runtime,
  );
  const copy = mockTabs
    .get(result.worktreeId)
    ?.tabs.find((tab) => tab.id === result.chatId);
  expect(copy?.sdkSessionId).toBeUndefined();
  expect(copy?.claudeForkSessionOnNextSend).toBeUndefined();
  expect(mockSend.mock.calls[0]?.[0]).toMatchObject({
    claudeForkSession: undefined,
  });
  expect(mockForkCodex).not.toHaveBeenCalled();
  expect(source).toEqual(original);
});

it.each(['cowork', 'advisor'] as const)(
  'forks a Copilot %s chat within its existing scope',
  async (scope) => {
    source.providerType = 'copilot';
    source.executionHarness = 'copilot';
    const projectId =
      scope === 'advisor' ? APP_ADVISOR_PROJECT_ID : 'cowork-project';
    const worktreeId = scope + '-entry';
    const surfaces = {
      getMainWindow: (): null => null,
      getAppAdvisorWindow: (): null => null,
      ensureAppAdvisorWindow: jest.fn(),
      openAppAdvisorWindow: jest.fn(),
    };
    mockTabs.set(worktreeId, {
      version: 1,
      tabs: [source],
      activeTabId: source.id,
    });
    const result = await startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Explore independently' },
      {
        ...runtime,
        projectId,
        worktreeId,
        executionScope: 'directory',
        ...(scope === 'advisor' ? { appAdvisorSurfaces: surfaces } : {}),
      },
    );
    expect(result.worktreeId).toBe(worktreeId);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        worktreeId,
        chatId: result.chatId,
        text: 'Continue',
      }),
      expect.anything(),
    );
    expect(mockCreateSingle).not.toHaveBeenCalled();
  },
);
it('cleans up only the rejected Copilot destination when its first send fails', async () => {
  source.providerType = 'copilot';
  source.executionHarness = 'copilot';
  mockSend.mockRejectedValueOnce(new Error('Copilot first send failed'));
  await expect(
    startSplitAgent(
      'start_forked_agent',
      { followUpInstruction: 'Continue independently' },
      runtime,
    ),
  ).rejects.toThrow('Copilot first send failed');
  expect(mockTabs.get('source')?.tabs.map((tab) => tab.id)).toEqual([
    source.id,
  ]);
  expect(source.sdkSessionId).toBe('source-session');
});
