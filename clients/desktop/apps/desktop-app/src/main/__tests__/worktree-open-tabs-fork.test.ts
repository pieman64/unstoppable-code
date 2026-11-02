jest.mock('../lib/git', () => ({
  getCurrentBranch: jest.fn((cwd: string) =>
    Promise.resolve(cwd.endsWith('repo-1') ? 'repo-feature' : 'source-feature'),
  ),
}));

jest.mock('../lib/approval-mode-resolution', () => ({
  resolvePersistedApprovalMode: jest.fn(
    (_projectId: string, _worktreeId: string, mode?: string) =>
      Promise.resolve(mode ?? 'auto'),
  ),
}));

import type { McpActivationRecord } from '@canopy/protocol/mcp-servers';
import { join, sep } from 'node:path';
import {
  initCodexModels,
  type ChatTabsFile,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { SerializablePanelLayoutFile } from '@canopy/protocol/panels';
import {
  clonePersistedWorktreeTab,
  forkOpenWorktreeTabs,
} from '../lib/worktree-open-tabs-fork';
import { resolvePersistedApprovalMode } from '../lib/approval-mode-resolution';
import {
  beginApprovalModeTransition,
  clearLiveApprovalMode,
  setLiveApprovalMode,
} from '../approvals/live-approval-modes';

initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);

function chatTab(
  id: string,
  providerType: 'claude' | 'codex',
  sdkSessionId: string,
): PersistedChatTab {
  return {
    id,
    title: id,
    messages: [
      {
        id: `${id}-message`,
        role: 'user',
        blocks: [{ type: 'text', text: id }],
        timestamp: 1,
      },
    ],
    createdAt: '2026-07-30T00:00:00.000Z',
    providerType,
    sdkSessionId,
    pinned: true,
    planMode: true,
  };
}

const recovery: McpActivationRecord = {
  version: 1,
  ownerId: 'owner',
  activationId: 'activation',
  attemptId: 'attempt',
  originatingMessageId: 'source-message',
  providerSessionId: 'source-session',
  provider: 'claude',
  trigger: 'auth',
  requiredTargets: [
    { kind: 'standalone', serverId: 'server', configId: 'config' },
  ],
  desiredGeneration: 1,
  phase: 'connecting',
  cancelled: false,
  admission: 'not_sent',
  retryEligible: false,
};

describe('forkOpenWorktreeTabs', () => {
  it('marks a copied OpenCode worktree tab for visible text without sharing its session', () => {
    const source: PersistedChatTab = {
      ...chatTab('opencode', 'claude', 'private-source-session'),
      providerType: 'opencode',
      model: 'opencode:fixture%2Fmodel',
    };
    const cloned = clonePersistedWorktreeTab(
      source,
      {
        projectId: 'project',
        sourceWorktreeId: 'source',
        destinationWorktreeId: 'destination',
      },
      join(sep, 'worktrees', 'source'),
      join(sep, 'worktrees', 'destination'),
      'forked-opencode',
      '2026-10-12T00:00:00.000Z',
    );
    expect(cloned?.sdkSessionId).toBeUndefined();
    expect(cloned?.forkedFrom).toMatchObject({
      atMessageId: 'opencode-message',
      modelContext: 'visible-transcript',
    });
    expect(source.sdkSessionId).toBe('private-source-session');
  });

  it('copies an empty OpenCode tab without a historical seed marker', () => {
    const source: PersistedChatTab = {
      ...chatTab('empty-opencode', 'claude', 'private-source'),
      providerType: 'opencode',
      model: 'opencode:fixture%2Fmodel',
      messages: [],
    };
    const cloned = clonePersistedWorktreeTab(
      source,
      {
        projectId: 'project',
        sourceWorktreeId: 'source',
        destinationWorktreeId: 'destination',
      },
      join(sep, 'worktrees', 'source'),
      join(sep, 'worktrees', 'destination'),
      'empty-fork',
      '2026-10-12T00:00:00.000Z',
    );
    expect(cloned?.forkedFrom?.atMessageId).toBeUndefined();
    expect(cloned?.forkedFrom?.modelContext).toBeUndefined();
    expect(cloned?.sdkSessionId).toBeUndefined();
  });

  it.each([false, true])(
    'replaces source OpenCode pending instructions with trusted relocation, selected=%s',
    async (selected) => {
      const source: PersistedChatTab = {
        ...chatTab('opencode', 'claude', 'private-source'),
        providerType: 'opencode',
        model: 'opencode:fixture%2Fmodel',
        pendingSystemInstructions: [
          { id: 'plan-file-location:source-plan', text: 'PRIVATE_SOURCE_PLAN' },
        ],
      };
      const destination: PersistedChatTab = {
        ...source,
        id: 'destination-chat',
        messages: [],
        sdkSessionId: 'private-source',
        forkedFrom: {
          projectId: 'project',
          worktreeId: 'source',
          chatId: 'wrong-chat',
          atMessageId: 'wrong-anchor',
        },
      };
      let written: ChatTabsFile | undefined;
      await forkOpenWorktreeTabs(
        {
          projectId: 'project',
          sourceWorktreeId: 'source',
          destinationWorktreeId: 'destination',
          ...(selected
            ? {
                selectedTab: {
                  sourceTabId: 'opencode',
                  destinationTab: destination,
                  throughMessageId: 'opencode-message',
                },
              }
            : {}),
        },
        {
          readTabs: () =>
            Promise.resolve({
              version: 1,
              tabs: [source],
              activeTabId: 'opencode',
            }),
          writeTabs: (_projectId, _worktreeId, data) => {
            written = data;
            return Promise.resolve();
          },
          copyTabs: (_request, data) => {
            written = data;
            return Promise.resolve();
          },
          resolveCwd: (_projectId, worktreeId) =>
            join(sep, 'worktrees', worktreeId),
          forkCodexThread: jest.fn(),
          nextId: () => 'fork-opencode',
          now: () => new Date('2026-10-12T00:00:00.000Z'),
          loadPanelLayout: () => null,
          savePanelLayout: jest.fn(),
          nextAuxWindowId: () => 'aux',
        },
      );
      expect(
        written?.tabs[0]?.pendingSystemInstructions?.map(
          (instruction) => instruction.id,
        ),
      ).toEqual(['worktree-relocation']);
      expect(
        JSON.stringify(written?.tabs[0]?.pendingSystemInstructions),
      ).not.toContain('PRIVATE_SOURCE_PLAN');
      expect(written?.tabs[0]?.sdkSessionId).toBeUndefined();
      expect(written?.tabs[0]?.forkedFrom).toMatchObject({
        chatId: 'opencode',
        atMessageId: 'opencode-message',
        modelContext: 'visible-transcript',
      });
      expect(written?.tabs[0]?.pendingSystemInstructions?.[0]?.text).toContain(
        join(sep, 'worktrees', 'destination'),
      );
    },
  );

  it('preserves fresh Claude context when cloning a sessionless worktree tab', () => {
    const source = chatTab('fresh-claude', 'claude', 'discarded-session');
    source.mcpActivation = structuredClone(recovery);
    source.customTitle = 'User-owned source name';
    source.automaticTitleState = 'closed';
    delete source.sdkSessionId;
    source.forkedFrom = {
      projectId: 'project',
      worktreeId: 'ancestor',
      chatId: 'ancestor-chat',
      modelContext: 'fresh',
    };

    const cloned = clonePersistedWorktreeTab(
      source,
      {
        projectId: 'project',
        sourceWorktreeId: 'source',
        destinationWorktreeId: 'destination',
      },
      join(sep, 'worktrees', 'source'),
      join(sep, 'worktrees', 'destination'),
      'forked-fresh-claude',
      '2026-07-31T00:00:00.000Z',
    );

    expect(cloned?.sdkSessionId).toBeUndefined();
    expect(cloned?.forkedFrom?.modelContext).toBe('fresh');
    expect(cloned).not.toHaveProperty('customTitle');
    // Matches the canonical fork: naming state belongs to the source chat.
    expect(cloned).not.toHaveProperty('automaticTitleState');
    expect(cloned).not.toHaveProperty('mcpActivation');
    expect(source.mcpActivation).toEqual(recovery);
    expect(source.customTitle).toBe('User-owned source name');
    expect(source.automaticTitleState).toBe('closed');
  });

  it.each(['ask', 'auto', 'full-access', undefined] as const)(
    'copies selected chat approval mode %s from the trusted source',
    async (sourceMode) => {
      const sourceTab = chatTab('source-chat', 'claude', 'source-session');
      sourceTab.mcpActivation = structuredClone(recovery);
      sourceTab.customTitle = 'User-owned source name';
      sourceTab.approvalMode = sourceMode;
      sourceTab.transcript = {
        format: 'complete-message-jsonl-v1',
        committedMessageCount: 900,
        committedByteLength: 90_000,
        transcriptRevision: 12,
        hasActiveSidecar: false,
        messageCount: 900,
        lastMessageId: 'canonical-anchor',
      };
      const destinationTab: PersistedChatTab = {
        ...structuredClone(sourceTab),
        id: 'destination-chat',
        title: 'Selected branch',
        messages: [],
        approvalMode: 'full-access',
        sessionApprovalRules: [
          {
            id: 'renderer-injected-rule',
            behavior: 'allow',
            target: { kind: 'command', pattern: '*' },
            createdAt: '2026-09-09T00:00:00.000Z',
            origin: 'prompt',
          },
        ],
        sharedRun: {
          externalId: 'renderer-injected-run',
          shareScope: 'team',
          sharedAt: '2026-09-09T00:00:00.000Z',
        },
        readOnly: true,
        unread: true,
        unreadMarkedManually: true,
        pendingRevertAttachmentPath: '/tmp/renderer-injected-revert.md',
        forkedFrom: {
          projectId: 'project',
          worktreeId: 'source',
          chatId: sourceTab.id,
          atMessageId: 'canonical-anchor',
        },
      };
      sourceTab.sessionApprovalRules = structuredClone(
        destinationTab.sessionApprovalRules,
      );
      let copiedTabs: ChatTabsFile | undefined;
      const copyTabs = jest.fn((_request: unknown, data: ChatTabsFile) => {
        copiedTabs = data;
        return Promise.resolve();
      });

      const bindings = await forkOpenWorktreeTabs(
        {
          projectId: 'project',
          sourceWorktreeId: 'source',
          destinationWorktreeId: 'destination',
          selectedTab: {
            sourceTabId: sourceTab.id,
            destinationTab,
            throughMessageId: 'canonical-anchor',
          },
        },
        {
          readTabs: () =>
            Promise.resolve({
              version: 1,
              tabs: [
                sourceTab,
                chatTab('sibling', 'claude', 'sibling-session'),
              ],
              activeTabId: sourceTab.id,
            }),
          copyTabs,
          resolveCwd: (_projectId, worktreeId) =>
            join(sep, 'worktrees', worktreeId),
          forkCodexThread: jest.fn(),
          nextId: () => 'unexpected-generated-id',
          now: () => new Date('2026-09-09T00:00:00.000Z'),
          loadPanelLayout: () => null,
          savePanelLayout: jest.fn(),
          nextAuxWindowId: () => 'aux',
        },
      );

      expect(bindings).toEqual(
        new Map([['source-chat', { destinationTabId: 'destination-chat' }]]),
      );
      expect(copyTabs).toHaveBeenCalledWith(
        expect.objectContaining({ destinationWorktreeId: 'destination' }),
        expect.objectContaining({
          tabs: [
            expect.objectContaining({
              id: 'destination-chat',
              title: 'Selected branch',
              messages: [],
            }),
          ],
        }),
        { 'destination-chat': 'source-chat' },
        { 'destination-chat': 'canonical-anchor' },
        expect.any(Function),
        expect.any(Function),
      );
      const persistedTab = copiedTabs?.tabs[0];
      expect(persistedTab?.approvalMode).toBe(sourceMode ?? 'auto');
      expect(resolvePersistedApprovalMode).toHaveBeenLastCalledWith(
        'project',
        'source',
        sourceMode,
      );
      expect(persistedTab).not.toHaveProperty('sessionApprovalRules');
      expect(persistedTab).not.toHaveProperty('customTitle');
      expect(persistedTab).not.toHaveProperty('mcpActivation');
      expect(sourceTab.mcpActivation).toEqual(recovery);
      expect(persistedTab).not.toHaveProperty('sharedRun');
      expect(persistedTab).not.toHaveProperty('readOnly');
      expect(persistedTab).not.toHaveProperty('unread');
      expect(persistedTab).not.toHaveProperty('unreadMarkedManually');
      expect(persistedTab).not.toHaveProperty('pendingRevertAttachmentPath');
    },
  );

  it('honors a selected branch seed that starts fresh from a session-carrying source', async () => {
    const sourceTab = chatTab('source-chat', 'claude', 'source-session');
    sourceTab.transcript = {
      format: 'complete-message-jsonl-v1',
      committedMessageCount: 1,
      committedByteLength: 100,
      transcriptRevision: 1,
      hasActiveSidecar: false,
      messageCount: 1,
      lastMessageId: 'source-chat-message',
    };
    const destinationTab = structuredClone(sourceTab);
    destinationTab.id = 'destination-chat';
    destinationTab.messages = [];
    destinationTab.forkedFrom = {
      projectId: 'project',
      worktreeId: 'source',
      chatId: sourceTab.id,
      atMessageId: 'source-chat-message',
      modelContext: 'fresh',
    };
    delete destinationTab.sdkSessionId;
    delete destinationTab.claudeForkSessionOnNextSend;
    let copiedTabs: ChatTabsFile | undefined;

    await forkOpenWorktreeTabs(
      {
        projectId: 'project',
        sourceWorktreeId: 'source',
        destinationWorktreeId: 'destination',
        selectedTab: {
          sourceTabId: sourceTab.id,
          destinationTab,
          throughMessageId: 'source-chat-message',
        },
      },
      {
        readTabs: () =>
          Promise.resolve({
            version: 1,
            tabs: [sourceTab],
            activeTabId: sourceTab.id,
          }),
        copyTabs: (_request, data) => {
          copiedTabs = data;
          return Promise.resolve();
        },
        resolveCwd: (_projectId, worktreeId) =>
          join(sep, 'worktrees', worktreeId),
        forkCodexThread: jest.fn(),
        nextId: () => 'unexpected-generated-id',
        now: () => new Date('2026-09-09T00:00:00.000Z'),
        loadPanelLayout: () => null,
        savePanelLayout: jest.fn(),
        nextAuxWindowId: () => 'aux',
      },
    );

    expect(copiedTabs?.tabs[0]?.forkedFrom?.modelContext).toBe('fresh');
    expect(copiedTabs?.tabs[0]).not.toHaveProperty('sdkSessionId');
    expect(copiedTabs?.tabs[0]).not.toHaveProperty(
      'claudeForkSessionOnNextSend',
    );
  });

  it('clamps a stale persisted mode to a concurrent restrictive live mode', async () => {
    const sourceTab = chatTab('source-chat', 'claude', 'source-session');
    sourceTab.approvalMode = 'full-access';
    sourceTab.transcript = {
      format: 'complete-message-jsonl-v1',
      committedMessageCount: 1,
      committedByteLength: 100,
      transcriptRevision: 1,
      hasActiveSidecar: false,
      messageCount: 1,
      lastMessageId: 'source-chat-message',
    };
    const destinationTab: PersistedChatTab = {
      ...structuredClone(sourceTab),
      id: 'destination-chat',
      messages: [],
    };
    let copiedTabs: ChatTabsFile | undefined;

    setLiveApprovalMode('project', 'source', sourceTab.id, 'ask');
    try {
      await forkOpenWorktreeTabs(
        {
          projectId: 'project',
          sourceWorktreeId: 'source',
          destinationWorktreeId: 'destination',
          selectedTab: {
            sourceTabId: sourceTab.id,
            destinationTab,
            throughMessageId: 'source-chat-message',
          },
        },
        {
          readTabs: () =>
            Promise.resolve({
              version: 1,
              tabs: [sourceTab],
              activeTabId: sourceTab.id,
            }),
          copyTabs: (_request, data) => {
            copiedTabs = data;
            return Promise.resolve();
          },
          resolveCwd: (_projectId, worktreeId) =>
            join(sep, 'worktrees', worktreeId),
          forkCodexThread: jest.fn(),
          nextId: () => 'unexpected-generated-id',
          now: () => new Date('2026-09-09T00:00:00.000Z'),
          loadPanelLayout: () => null,
          savePanelLayout: jest.fn(),
          nextAuxWindowId: () => 'aux',
        },
      );
    } finally {
      clearLiveApprovalMode('project', 'source', sourceTab.id);
    }

    expect(copiedTabs?.tabs[0]?.approvalMode).toBe('ask');
  });

  it('aborts the atomic transcript publish when the source is downgraded mid-copy', async () => {
    const sourceTab = chatTab('source-chat', 'claude', 'source-session');
    sourceTab.approvalMode = 'full-access';
    sourceTab.transcript = {
      format: 'complete-message-jsonl-v1',
      committedMessageCount: 1,
      committedByteLength: 100,
      transcriptRevision: 1,
      hasActiveSidecar: false,
      messageCount: 1,
      lastMessageId: 'source-chat-message',
    };
    const destinationTab: PersistedChatTab = {
      ...structuredClone(sourceTab),
      id: 'destination-chat',
      messages: [],
    };
    let signalCopyStarted: (() => void) | undefined;
    const copyStarted = new Promise<void>((resolve) => {
      signalCopyStarted = resolve;
    });
    let resumeCopy: (() => void) | undefined;
    const copyPaused = new Promise<void>((resolve) => {
      resumeCopy = resolve;
    });
    let copiedTabs: ChatTabsFile | undefined;
    let published = false;

    setLiveApprovalMode('project', 'source', sourceTab.id, 'full-access');
    try {
      const fork = forkOpenWorktreeTabs(
        {
          projectId: 'project',
          sourceWorktreeId: 'source',
          destinationWorktreeId: 'destination',
          selectedTab: {
            sourceTabId: sourceTab.id,
            destinationTab,
            throughMessageId: 'source-chat-message',
          },
        },
        {
          readTabs: () =>
            Promise.resolve({
              version: 1,
              tabs: [sourceTab],
              activeTabId: sourceTab.id,
            }),
          copyTabs: async (
            _request,
            data,
            _sourceChatIds,
            _throughMessageIds,
            beforePublish,
            preparePublish,
          ) => {
            copiedTabs = {
              version: 1,
              tabs: data.tabs,
              activeTabId: data.activeTabId,
            };
            signalCopyStarted?.();
            await copyPaused;
            await preparePublish?.();
            beforePublish?.();
            published = true;
          },
          resolveCwd: (_projectId, worktreeId) =>
            join(sep, 'worktrees', worktreeId),
          forkCodexThread: jest.fn(),
          nextId: () => 'unexpected-generated-id',
          now: () => new Date('2026-09-09T00:00:00.000Z'),
          loadPanelLayout: () => null,
          savePanelLayout: jest.fn(),
          nextAuxWindowId: () => 'aux',
        },
      );

      await copyStarted;
      sourceTab.approvalMode = 'ask';
      setLiveApprovalMode('project', 'source', sourceTab.id, 'ask');
      resumeCopy?.();
      await expect(fork).rejects.toThrow(
        'Source approval mode became more restrictive while branching',
      );
      expect(copiedTabs?.tabs[0]?.approvalMode).toBe('full-access');
      expect(published).toBe(false);
      expect(sourceTab.approvalMode).toBe('ask');
    } finally {
      clearLiveApprovalMode('project', 'source', sourceTab.id);
    }
  });

  it('rejects a default-derived escalation when the default becomes restrictive before publish', async () => {
    const sourceTab = chatTab('source-chat', 'claude', 'source-session');
    sourceTab.approvalMode = undefined;
    const destinationTab: PersistedChatTab = {
      ...structuredClone(sourceTab),
      id: 'destination-chat',
      approvalMode: 'full-access',
      messages: [],
    };
    jest
      .mocked(resolvePersistedApprovalMode)
      .mockResolvedValueOnce('full-access')
      .mockResolvedValueOnce('ask');
    const writeTabs = jest.fn(
      async (
        _projectId: string,
        _worktreeId: string,
        _data: ChatTabsFile,
        beforePublish?: () => void,
        preparePublish?: () => Promise<void>,
      ) => {
        await preparePublish?.();
        beforePublish?.();
      },
    );

    await expect(
      forkOpenWorktreeTabs(
        {
          projectId: 'project',
          sourceWorktreeId: 'source',
          destinationWorktreeId: 'destination',
          selectedTab: { sourceTabId: sourceTab.id, destinationTab },
        },
        {
          readTabs: () =>
            Promise.resolve({
              version: 1,
              tabs: [sourceTab],
              activeTabId: sourceTab.id,
            }),
          writeTabs,
          copyTabs: jest.fn(),
          resolveCwd: (_projectId, worktreeId) =>
            join(sep, 'worktrees', worktreeId),
          forkCodexThread: jest.fn(),
          nextId: () => 'unexpected-generated-id',
          now: () => new Date('2026-09-09T00:00:00.000Z'),
          loadPanelLayout: () => null,
          savePanelLayout: jest.fn(),
          nextAuxWindowId: () => 'aux',
        },
      ),
    ).rejects.toThrow(
      'Source approval mode became more restrictive while branching',
    );
    expect(writeTabs).toHaveBeenCalledTimes(1);
  });

  it('rejects a compatibility fork when source approval becomes restrictive during the write', async () => {
    const sourceTab = chatTab('source-chat', 'claude', 'source-session');
    sourceTab.approvalMode = 'full-access';
    const destinationTab: PersistedChatTab = {
      ...structuredClone(sourceTab),
      id: 'destination-chat',
      messages: [],
    };
    let signalWriteStarted: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    let resumeWrite: (() => void) | undefined;
    const writePaused = new Promise<void>((resolve) => {
      resumeWrite = resolve;
    });
    let published = false;

    setLiveApprovalMode('project', 'source', sourceTab.id, 'full-access');
    try {
      const fork = forkOpenWorktreeTabs(
        {
          projectId: 'project',
          sourceWorktreeId: 'source',
          destinationWorktreeId: 'destination',
          selectedTab: { sourceTabId: sourceTab.id, destinationTab },
        },
        {
          readTabs: () =>
            Promise.resolve({
              version: 1,
              tabs: [sourceTab],
              activeTabId: sourceTab.id,
            }),
          writeTabs: async (
            _projectId,
            _worktreeId,
            _data,
            beforePublish,
            preparePublish,
          ) => {
            expect(beforePublish).toEqual(expect.any(Function));
            expect(preparePublish).toEqual(expect.any(Function));
            signalWriteStarted?.();
            await writePaused;
            await preparePublish?.();
            beforePublish?.();
            published = true;
          },
          copyTabs: jest.fn(),
          resolveCwd: (_projectId, worktreeId) =>
            join(sep, 'worktrees', worktreeId),
          forkCodexThread: jest.fn(),
          nextId: () => 'unexpected-generated-id',
          now: () => new Date('2026-09-09T00:00:00.000Z'),
          loadPanelLayout: () => null,
          savePanelLayout: jest.fn(),
          nextAuxWindowId: () => 'aux',
        },
      );

      await writeStarted;
      sourceTab.approvalMode = 'ask';
      setLiveApprovalMode('project', 'source', sourceTab.id, 'ask');
      resumeWrite?.();
      await expect(fork).rejects.toThrow(
        'Source approval mode became more restrictive while branching',
      );
      expect(published).toBe(false);
    } finally {
      clearLiveApprovalMode('project', 'source', sourceTab.id);
    }
  });

  it('rejects a default-derived escalation when a restrictive target is pending at publish', async () => {
    const sourceTab = chatTab('source-chat', 'claude', 'source-session');
    sourceTab.approvalMode = undefined;
    sourceTab.transcript = {
      format: 'complete-message-jsonl-v1',
      committedMessageCount: 1,
      committedByteLength: 100,
      transcriptRevision: 1,
      hasActiveSidecar: false,
      messageCount: 1,
      lastMessageId: 'source-message',
    };
    jest.mocked(resolvePersistedApprovalMode).mockResolvedValue('full-access');
    let published = false;

    try {
      await expect(
        forkOpenWorktreeTabs(
          {
            projectId: 'project',
            sourceWorktreeId: 'source',
            destinationWorktreeId: 'destination',
            selectedTab: {
              sourceTabId: sourceTab.id,
              destinationTab: {
                ...structuredClone(sourceTab),
                id: 'destination-chat',
                messages: [],
              },
              throughMessageId: 'source-message',
            },
          },
          {
            readTabs: () =>
              Promise.resolve({
                version: 1,
                tabs: [sourceTab],
                activeTabId: sourceTab.id,
              }),
            writeTabs: jest.fn(),
            copyTabs: async (
              _request,
              _data,
              _sourceChatIds,
              _throughMessageIds,
              beforePublish,
              preparePublish,
            ) => {
              beginApprovalModeTransition(
                'project',
                'source',
                sourceTab.id,
                'ask',
              );
              await preparePublish?.();
              beforePublish?.();
              published = true;
            },
            resolveCwd: (_projectId, worktreeId) =>
              join(sep, 'worktrees', worktreeId),
            forkCodexThread: jest.fn(),
            nextId: () => 'unexpected-generated-id',
            now: () => new Date('2026-09-09T00:00:00.000Z'),
            loadPanelLayout: () => null,
            savePanelLayout: jest.fn(),
            nextAuxWindowId: () => 'aux',
          },
        ),
      ).rejects.toThrow(
        'Source approval mode became more restrictive while branching',
      );
      expect(published).toBe(false);
    } finally {
      clearLiveApprovalMode('project', 'source', sourceTab.id);
    }
  });

  it('commits the trusted approval mode in the transcript copy without a post-copy patch', async () => {
    const sourceTab = chatTab('source-chat', 'claude', 'source-session');
    sourceTab.approvalMode = 'full-access';
    sourceTab.transcript = {
      format: 'complete-message-jsonl-v1',
      committedMessageCount: 1,
      committedByteLength: 100,
      transcriptRevision: 1,
      hasActiveSidecar: false,
      messageCount: 1,
      lastMessageId: 'source-chat-message',
    };
    const destinationTab: PersistedChatTab = {
      ...structuredClone(sourceTab),
      id: 'destination-chat',
      messages: [],
    };
    let copiedTabs: ChatTabsFile | undefined;

    await expect(
      forkOpenWorktreeTabs(
        {
          projectId: 'project',
          sourceWorktreeId: 'source',
          destinationWorktreeId: 'destination',
          selectedTab: {
            sourceTabId: sourceTab.id,
            destinationTab,
            throughMessageId: 'source-chat-message',
          },
        },
        {
          readTabs: () =>
            Promise.resolve({
              version: 1,
              tabs: [sourceTab],
              activeTabId: sourceTab.id,
            }),
          copyTabs: (_request, data) => {
            copiedTabs = data;
            return Promise.resolve();
          },
          resolveCwd: (_projectId, worktreeId) =>
            join(sep, 'worktrees', worktreeId),
          forkCodexThread: jest.fn(),
          nextId: () => 'unexpected-generated-id',
          now: () => new Date('2026-09-09T00:00:00.000Z'),
          loadPanelLayout: () => null,
          savePanelLayout: jest.fn(),
          nextAuxWindowId: () => 'aux',
        },
      ),
    ).resolves.toEqual(
      new Map([['source-chat', { destinationTabId: 'destination-chat' }]]),
    );
    expect(copiedTabs?.tabs[0]?.approvalMode).toBe('full-access');
  });

  it('forks mixed Cursor and Claude tabs without copying the Cursor resume id', async () => {
    const cursor: PersistedChatTab = {
      ...chatTab('cursor', 'claude', 'cursor-session'),
      providerType: 'cursor',
      executionHarness: 'cursor',
      model: 'cursor-default',
    };
    const writeTabs = jest.fn<Promise<void>, [string, string, ChatTabsFile]>(
      () => Promise.resolve(),
    );
    let id = 0;
    await forkOpenWorktreeTabs(
      {
        projectId: 'project',
        sourceWorktreeId: 'source',
        destinationWorktreeId: 'destination',
        forkPanelLayout: false,
      },
      {
        readTabs: () =>
          Promise.resolve({
            version: 1,
            tabs: [cursor, chatTab('claude', 'claude', 'claude-session')],
            activeTabId: cursor.id,
          }),
        writeTabs,
        resolveCwd: (_project, worktree) => join(sep, 'worktrees', worktree),
        nextId: () => `fork-${++id}`,
      },
    );
    const written = writeTabs.mock.calls[0]?.[2];
    if (!written) throw new Error('Missing forked tabs');
    expect(written.tabs).toHaveLength(2);
    expect(written.tabs[0]).toMatchObject({
      providerType: 'cursor',
      model: 'cursor-default',
      messages: cursor.messages,
    });
    expect(written.tabs[0]).not.toHaveProperty('sdkSessionId');
    expect(written.tabs[1]?.sdkSessionId).toBe('claude-session');
  });

  it('uses each selected repository location and reads its source branch only once', async () => {
    const tabs = [
      chatTab('root-a', 'claude', 'session-a'),
      chatTab('root-b', 'claude', 'session-b'),
      {
        ...chatTab('repo-chat', 'claude', 'session-c'),
        selectedRepoId: 'repo-1',
      },
    ];
    const getCurrentBranch = jest.fn((cwd: string) =>
      Promise.resolve(
        cwd.endsWith('/repo-1') ? 'repo-feature' : 'root-feature',
      ),
    );
    let written: ChatTabsFile | undefined;
    let nextId = 0;
    await forkOpenWorktreeTabs(
      {
        projectId: 'project',
        sourceWorktreeId: 'source',
        destinationWorktreeId: 'destination',
      },
      {
        readTabs: () =>
          Promise.resolve({ version: 1, tabs, activeTabId: 'root-a' }),
        writeTabs: (_projectId, _worktreeId, data) => {
          written = data;
          return Promise.resolve();
        },
        resolveCwd: (_projectId, worktreeId, repoId) =>
          `/worktrees/${worktreeId}${repoId ? `/${repoId}` : ''}`,
        getCurrentBranch,
        nextId: () => `copy-${++nextId}`,
      },
    );
    expect(getCurrentBranch).toHaveBeenCalledTimes(2);
    expect(getCurrentBranch).toHaveBeenCalledWith('/worktrees/source');
    expect(getCurrentBranch).toHaveBeenCalledWith('/worktrees/source/repo-1');
    const notes = written?.tabs.map(
      (tab) => tab.pendingSystemInstructions?.[0]?.text,
    );
    expect(notes?.[0]).toContain('Originating branch: "root-feature"');
    expect(notes?.[1]).toContain('Originating branch: "root-feature"');
    expect(notes?.[2]).toContain('Originating branch: "repo-feature"');
    expect(notes?.[2]).toContain(
      'New working directory: "/worktrees/destination/repo-1"',
    );
  });

  it('forks live chats, rewrites files, and creates an independent Codex thread', async () => {
    const sourceRoot = join(sep, 'worktrees', 'source');
    const destinationRoot = join(sep, 'worktrees', 'destination');
    const sourceFilePath = join(sourceRoot, 'src', 'index.ts');
    const legacyFileTab: ChatTabsFile['tabs'][number] = {
      id: 'file-tab',
      title: 'index.ts',
      kind: 'file',
      filePath: sourceFilePath,
      description: sourceFilePath,
      messages: [],
      createdAt: '2026-07-30T00:00:00.000Z',
    };
    // Preserve the legacy input: the fork test verifies that this value survives.
    Reflect.set(legacyFileTab, 'fileViewMode', 'rich');
    const source: ChatTabsFile = {
      version: 1,
      tabs: [
        {
          ...chatTab('claude-chat', 'claude', 'claude-session'),
          claudeTerminal: {
            terminalId: 'source-terminal',
            sessionKey: 'source-session-key',
            sdkSessionId: 'claude-session',
            turnState: 'running',
          },
        },
        chatTab('codex-chat', 'codex', 'codex-thread'),
        legacyFileTab,
        {
          id: 'external-file-tab',
          title: 'shared-notes.md',
          kind: 'file',
          filePath: join(sep, 'tmp', 'shared-notes.md'),
          messages: [],
          createdAt: '2026-07-30T00:00:00.000Z',
        },
      ],
      activeTabId: 'file-tab',
      lastActiveEditableChatId: 'codex-chat',
      lastActiveChatProvider: 'codex',
      pendingQuestions: [
        {
          requestId: 'archived-or-source-only-question',
          chatId: 'claude-chat',
          questions: [],
        },
      ],
    };
    let written: ChatTabsFile | undefined;
    let nextId = 0;
    const forkCodexThread = jest.fn(() =>
      Promise.resolve('forked-codex-thread'),
    );
    const sourcePanelLayout: SerializablePanelLayoutFile = {
      version: 1,
      grid: {
        orientation: 1,
        width: 1200,
        height: 800,
        root: {
          type: 'leaf',
          groupId: 'main',
          size: 1200,
          panels: [
            {
              panelId: 'panel-file-file-tab',
              kind: 'file-diff',
              instance: { fileTabId: 'file-tab', filePath: sourceFilePath },
            },
            {
              panelId: 'panel-chat-claude-chat',
              kind: 'chat',
              instance: { chatTabId: 'claude-chat' },
            },
          ],
          activePanelId: 'panel-file-file-tab',
        },
      },
      activeGroupId: 'main',
      mostRecentActiveGroupIds: ['main'],
    };
    const savePanelLayout = jest.fn<
      void,
      [string, string, SerializablePanelLayoutFile]
    >();

    await forkOpenWorktreeTabs(
      {
        projectId: 'project',
        sourceWorktreeId: 'source',
        destinationWorktreeId: 'destination',
      },
      {
        readTabs: () => Promise.resolve(source),
        writeTabs: (_projectId, _worktreeId, data) => {
          written = data;
          return Promise.resolve();
        },
        resolveCwd: (_projectId, worktreeId) =>
          worktreeId === 'source' ? sourceRoot : destinationRoot,
        forkCodexThread,
        nextId: () => `fork-${String(++nextId)}`,
        now: () => new Date('2026-07-31T00:00:00.000Z'),
        loadPanelLayout: () => sourcePanelLayout,
        savePanelLayout,
        nextAuxWindowId: () => 'aux-forked',
      },
    );

    expect(written?.tabs).toHaveLength(4);
    expect(written?.activeTabId).toBe('fork-3');
    expect(written?.lastActiveEditableChatId).toBe('fork-2');
    expect(written?.pendingQuestions).toBeUndefined();
    const claude = written?.tabs.find((tab) => tab.id === 'fork-1');
    expect(claude?.sdkSessionId).toBe('claude-session');
    expect(claude?.claudeForkSessionOnNextSend).toBe(true);
    expect(claude?.forkedFrom?.resumePointRequired).toBe(true);
    expect(claude?.claudeTerminal).toBeUndefined();
    expect(claude?.pendingSystemInstructions?.map(({ id }) => id)).toEqual([
      'worktree-relocation',
    ]);
    expect(claude?.pendingSystemInstructions?.[0]?.text).toContain(
      destinationRoot,
    );
    expect(claude?.forkedFrom).toEqual({
      projectId: 'project',
      worktreeId: 'source',
      chatId: 'claude-chat',
      atMessageId: 'claude-chat-message',
      resumePointRequired: true,
    });
    const codex = written?.tabs.find((tab) => tab.id === 'fork-2');
    expect(codex?.sdkSessionId).toBe('forked-codex-thread');
    expect(codex?.pendingSystemInstructions?.[0]?.text).toContain(sourceRoot);
    for (const tab of [claude, codex]) {
      const note = tab?.pendingSystemInstructions?.[0]?.text;
      expect(note).toContain('read-only reference');
      expect(note).toContain('Limit all changes to the new working directory');
      expect(note).toContain('Originating branch: "source-feature"');
      expect(note).not.toContain('Follow-up instruction');
    }

    expect(codex?.pendingSystemInstructions?.[0]?.text).toContain(
      destinationRoot,
    );
    expect(forkCodexThread).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'destination',
        chatId: 'fork-2',
        sourceProjectId: 'project',
        sourceWorktreeId: 'source',
        sourceChatId: 'codex-chat',
        sourceThreadId: 'codex-thread',
      }),
    );
    expect(written?.tabs.find((tab) => tab.kind === 'file')).toEqual(
      expect.objectContaining({
        id: 'fork-3',
        filePath: join(destinationRoot, 'src', 'index.ts'),
        fileViewMode: 'rich',
      }),
    );
    expect(
      written?.tabs.some(
        (tab) =>
          tab.id === 'fork-4' &&
          tab.filePath === join(sep, 'tmp', 'shared-notes.md'),
      ),
    ).toBe(true);
    expect(source.tabs.map((tab) => tab.id)).toEqual([
      'claude-chat',
      'codex-chat',
      'file-tab',
      'external-file-tab',
    ]);
    expect(savePanelLayout).toHaveBeenCalledTimes(1);
    const copiedLayout: SerializablePanelLayoutFile | undefined =
      savePanelLayout.mock.calls[0]?.[2];
    const copiedRoot = copiedLayout?.grid.root;
    expect(copiedRoot?.type).toBe('leaf');
    if (!copiedRoot || copiedRoot.type !== 'leaf') return;
    expect(copiedRoot.panels.map((panel) => panel.panelId)).toEqual([
      'panel-file-fork-3',
      'panel-chat-fork-1',
    ]);
    expect(copiedRoot.panels[0]?.instance).toEqual({
      fileTabId: 'fork-3',
      filePath: join(destinationRoot, 'src', 'index.ts'),
    });
    expect(copiedRoot.activePanelId).toBe('panel-file-fork-3');
  });

  it('resolves legacy provider identity before preserving or forking sessions', async () => {
    const legacyClaude = chatTab(
      'legacy-claude',
      'claude',
      'legacy-claude-session',
    );
    delete legacyClaude.providerType;
    const modelDerivedCodex = chatTab(
      'model-codex',
      'codex',
      'model-codex-thread',
    );
    delete modelDerivedCodex.providerType;
    modelDerivedCodex.model = 'gpt-5.5';
    const source: ChatTabsFile = {
      version: 1,
      tabs: [legacyClaude, modelDerivedCodex],
      activeTabId: legacyClaude.id,
    };
    let written: ChatTabsFile | undefined;
    let nextId = 0;
    const forkCodexThread = jest.fn(() =>
      Promise.resolve('forked-model-codex-thread'),
    );

    await forkOpenWorktreeTabs(
      {
        projectId: 'project',
        sourceWorktreeId: 'source',
        destinationWorktreeId: 'destination',
      },
      {
        readTabs: () => Promise.resolve(source),
        writeTabs: (_projectId, _worktreeId, data) => {
          written = data;
          return Promise.resolve();
        },
        resolveCwd: (_projectId, worktreeId) =>
          join(sep, 'worktrees', worktreeId),
        forkCodexThread,
        nextId: () => `fork-${String(++nextId)}`,
        now: () => new Date('2026-07-31T00:00:00.000Z'),
        loadPanelLayout: () => null,
        savePanelLayout: jest.fn(),
        nextAuxWindowId: () => 'aux-forked',
      },
    );

    const clonedClaude = written?.tabs.find((tab) => tab.id === 'fork-1');
    expect(clonedClaude?.sdkSessionId).toBe('legacy-claude-session');
    expect(clonedClaude?.claudeForkSessionOnNextSend).toBe(true);
    expect(clonedClaude?.forkedFrom?.resumePointRequired).toBe(true);
    expect(forkCodexThread).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'fork-2',
        sourceThreadId: 'model-codex-thread',
      }),
    );
    expect(written?.tabs.find((tab) => tab.id === 'fork-2')?.sdkSessionId).toBe(
      'forked-model-codex-thread',
    );
  });

  it('falls back safely when a persisted tab references a stale model', async () => {
    const stale = chatTab('stale-model', 'claude', 'stale-session');
    delete stale.providerType;
    stale.model = 'removed-model';
    const source: ChatTabsFile = {
      version: 1,
      tabs: [stale],
      activeTabId: stale.id,
    };
    let written: ChatTabsFile | undefined;
    const forkCodexThread = jest.fn();

    await expect(
      forkOpenWorktreeTabs(
        {
          projectId: 'project',
          sourceWorktreeId: 'source',
          destinationWorktreeId: 'destination',
        },
        {
          readTabs: () => Promise.resolve(source),
          writeTabs: (_projectId, _worktreeId, data) => {
            written = data;
            return Promise.resolve();
          },
          resolveCwd: (_projectId, worktreeId) =>
            join(sep, 'worktrees', worktreeId),
          forkCodexThread,
          nextId: () => 'fork-stale',
          now: () => new Date('2026-07-31T00:00:00.000Z'),
          loadPanelLayout: () => null,
          savePanelLayout: jest.fn(),
          nextAuxWindowId: () => 'aux-forked',
        },
      ),
    ).resolves.toEqual(
      new Map([['stale-model', { destinationTabId: 'fork-stale' }]]),
    );

    expect(written?.tabs[0]).toMatchObject({
      id: 'fork-stale',
      model: 'removed-model',
      sdkSessionId: 'stale-session',
      claudeForkSessionOnNextSend: true,
    });
    expect(forkCodexThread).not.toHaveBeenCalled();
  });
});
