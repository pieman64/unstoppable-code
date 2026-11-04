import { subscribeAcceptedWorktreeTurns } from '@/components/onboarding-tips/homeSendEvents';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import type {
  AutomationMutationResponse,
  BranchEntry,
  ChatModel,
  ChatTabPluginSelections,
  CoworkSidebarItem,
  FileReference,
  RepoFileIndex,
  ScheduledActivity,
  SingleRepoSidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_MODEL,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import { orgDefaultCoworkWorkspaceId } from '@canopy/desktop-shared/types';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { createEmptyTab } from '@/stores/chat/tab-utils';
import { getWorktreeCacheKey, useFileListStore } from '@/stores/fileListStore';
import {
  useProjectsStore,
  type CreateWorktreeOptions,
} from '@/stores/projectsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { useGitHubConnectOfferStore } from '@/stores/githubConnectOfferStore';
import { importChatAttachments } from '@/lib/chatAttachments';
import * as promptMentionExpansion from '@/lib/promptMentionExpansion';
import { showAutomationCreatedToast } from '@/lib/automationToasts';
import {
  toActiveComposerView,
  toActiveTranscriptView,
} from '@/components/chat/types';
import { ensureWorktreePanelLayout } from '@/lib/panels/persistence-bridge';
import { applyNewChatPluginSelections } from '@/lib/chatPluginEditing';
import type { AttachmentMeta } from '@canopy/desktop-shared/types';
import {
  buildPipelineTaskText,
  cancelHomeLinkSubmission,
  dispatchHomeSend,
  resolveTaskReadyLaunchTarget,
  retryFailedFirstSend,
} from '../components/home/homeSend';
import {
  cachedHomeModelRefusal,
  preflightHomeModel,
} from '../components/home/homeModelPreflight';
import { useGitHubStore } from '@/stores/githubStore';
import {
  resetHomeLinkTargetSyncForTests,
  syncHomeLinkTarget,
} from '../components/home/homeLinkTargetSync';

jest.mock('@/lib/chatAttachments', () => ({
  importChatAttachments: jest.fn(),
}));

jest.mock('@/lib/automationToasts', () => ({
  showAutomationCreatedToast: jest.fn(),
}));

jest.mock('@/lib/panels/persistence-bridge', () => ({
  ensureWorktreePanelLayout: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/components/chat/chatMessageListChunk', () => ({
  loadChatMessageListModule: jest.fn(() => Promise.resolve({})),
}));

// CAN-5021: eligibility facts are covered in homeModelPreflight.test.ts;
// here every model passes unless a test establishes a refusal.
jest.mock('@/components/home/homeModelPreflight', () => ({
  preflightHomeModel: jest.fn(() => Promise.resolve({ ok: true })),
  cachedHomeModelRefusal: jest.fn(() => ({ ok: true })),
}));
jest.mock('@/lib/chatPluginEditing', () => ({
  applyNewChatPluginSelections: jest.fn(() => Promise.resolve()),
}));

const importChatAttachmentsMock = importChatAttachments as jest.Mock;
const showAutomationCreatedToastMock = showAutomationCreatedToast as jest.Mock;
const ensureWorktreePanelLayoutMock = jest.mocked(ensureWorktreePanelLayout);
const applyNewChatPluginSelectionsMock = jest.mocked(
  applyNewChatPluginSelections,
);

function makeActivity(
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id: 'activity-1',
    name: 'Scheduled task',
    enabled: true,
    schedule: {
      kind: 'one_time',
      runAt: '2026-07-08T12:00:00.000Z',
      timezone: 'local',
    },
    action: { type: 'app_advisor_prompt', prompt: 'placeholder' },
    createdAt: '2026-07-08T00:00:00.000Z',
    updatedAt: '2026-07-08T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

function makePluginSelections(
  overrides?: Partial<ChatTabPluginSelections>,
): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
    ...overrides,
  };
}

function makeAttachment(overrides?: Partial<AttachmentMeta>): AttachmentMeta {
  return {
    filename: 'notes.md',
    absolutePath: '/tmp/attachments/notes.md',
    ...overrides,
  };
}

function makeWorktree(overrides?: Partial<WorktreeData>): WorktreeData {
  return {
    id: 'wt-1',
    branchName: 'wt-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSingleRepoProject(
  id: string,
  overrides?: Partial<SingleRepoSidebarItem>,
): SingleRepoSidebarItem {
  return {
    id,
    type: 'single-repo',
    name: id,
    repoPath: `/tmp/${id}`,
    color: '#123456',
    order: 0,
    collapsed: false,
    worktrees: [],
    scripts: {},
    effectiveScripts: {},
    hooks: {},
    effectiveHooks: {},
    ...overrides,
  };
}

function makeCoworkProject(
  id: string,
  overrides?: Partial<CoworkSidebarItem>,
): CoworkSidebarItem {
  return {
    id,
    type: 'cowork',
    name: id,
    color: '#123456',
    order: 0,
    collapsed: false,
    ...overrides,
  };
}

function makeRepoFileIndex(overrides?: Partial<RepoFileIndex>): RepoFileIndex {
  return {
    repoId: 'baseline',
    repoName: 'ws-1',
    absolutePath: '/data/repo-shadows/k/checkout',
    rootKind: 'git-repo',
    files: [],
    ...overrides,
  };
}

function makeFileReference(overrides?: Partial<FileReference>): FileReference {
  return {
    displayPath: 'src/main.ts',
    absolutePath: '/data/repo-shadows/k/checkout/src/main.ts',
    ...overrides,
  };
}

/**
 * Installs a `fetchFileIndex` mock that populates the target worktree's
 * index cache with a single root at `targetCwd`, so the stale-pill rewrite
 * helpers can resolve the send target's cwd. Returns the mock for
 * call-assertions.
 */
function seedTargetIndexFetch(targetCwd: string): jest.Mock {
  const fetchFileIndex = jest.fn((projectId: string, worktreeId: string) => {
    useFileListStore.setState((state) => ({
      indexCache: {
        ...state.indexCache,
        [getWorktreeCacheKey(projectId, worktreeId)]: {
          data: {
            repos: [
              makeRepoFileIndex({ repoId: 'app', absolutePath: targetCwd }),
            ],
          },
          fetchedAt: Date.now(),
        },
      },
    }));
    return Promise.resolve();
  });
  useFileListStore.setState({ fetchFileIndex });
  return fetchFileIndex;
}

/** Installs `window.api.homeGetCoworkRoot` for the cowork rewrite path. */
function installHomeGetCoworkRoot(
  impl: (request: { workspaceId: string }) => Promise<string>,
): void {
  const existingWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      ...existingWindow,
      api: { ...existingWindow?.api, homeGetCoworkRoot: impl },
    },
  });
}

/** Seeds `ws-1`/`wt-1` as the worktree `createWorktree` + `loadAllWorktreeTabs`
 * resolve to for the new-worktree/branch send paths. */
function seedLoadTabsForTarget(
  setupPhase: 'git-pending' | 'git-ready' | undefined,
): void {
  (useChatStore.getState().loadTabsForTarget as jest.Mock).mockImplementation(
    (): Promise<void> => {
      callOrder.push('loadTabsForTarget');
      useChatStore.setState({
        worktreeChats: {
          'ws-1/wt-1': {
            tabs: [
              {
                ...createEmptyTab(),
                ...useChatStore
                  .getState()
                  .worktreeChats[
                    'ws-1/wt-1'
                  ]?.tabs.find((tab) => tab.id === 'tab-1'),
                id: 'tab-1',
              },
            ],
            activeTabId: 'tab-1',
          },
        },
      });
      return Promise.resolve();
    },
  );
  jest
    .mocked(useChatStore.getState().loadAllWorktreeTabs)
    .mockImplementation((): Promise<void> => {
      callOrder.push('loadAllWorktreeTabs');
      useChatStore.setState({
        worktreeChats: {
          'ws-1/wt-1': {
            tabs: [
              {
                ...createEmptyTab(),
                ...useChatStore
                  .getState()
                  .worktreeChats[
                    'ws-1/wt-1'
                  ]?.tabs.find((tab) => tab.id === 'tab-1'),
                id: 'tab-1',
              },
            ],
            activeTabId: 'tab-1',
          },
        },
      });
      return Promise.resolve();
    });
  useProjectsStore.setState({
    projects: [
      makeSingleRepoProject('ws-1', {
        worktrees: [makeWorktree({ setupPhase })],
      }),
    ],
  });
}

/** Shared call-order log so tests can assert cross-store sequencing. */
let callOrder: string[] = [];

function resetStores(): void {
  callOrder = [];
  useHomeComposerStore.getState().reset();
  useProjectsStore.setState({ projects: [], worktreeError: null });
  // No test exercises `fetchFileIndex` unless it staged shadow-backed
  // `fileReferences` first (see the Task F3 rewrite describe block below) —
  // the default here fails loudly if that invariant is ever broken.
  useFileListStore.setState({
    indexCache: {},
    fetchFileIndex: jest.fn(() =>
      Promise.reject(
        new Error('fetchFileIndex called without a mock in this test'),
      ),
    ),
  });
  importChatAttachmentsMock.mockReset();
  importChatAttachmentsMock.mockImplementation(() => {
    throw new Error('importChatAttachments called without a mock in this test');
  });
  showAutomationCreatedToastMock.mockReset();
  ensureWorktreePanelLayoutMock.mockReset();
  ensureWorktreePanelLayoutMock.mockResolvedValue();
  applyNewChatPluginSelectionsMock.mockReset();
  applyNewChatPluginSelectionsMock.mockImplementation((): Promise<void> => {
    callOrder.push('applyNewChatPluginSelections');
    return Promise.resolve();
  });

  useChatStore.setState({
    worktreeChats: {},
    addPendingAttachments: jest.fn(),
    setFastMode: jest.fn(),
    setSpeed: jest.fn(),
    // Unseeded (the default in every test here) — `resolveHomeEffectiveDefaults`
    // falls back to `DEFAULT_MODEL` / `'high'` for any draft that never
    // touched `model`/`thinkingLevel`. See the F1 pin above.
    modelDefaults: null,
    selectWorktree: jest.fn((): void => {
      callOrder.push('selectWorktree');
    }),
    deselectWorktree: jest.fn((): void => {
      callOrder.push('deselectWorktree');
    }),
    createTab: jest.fn((): void => {
      callOrder.push('createTab');
    }),
    ensureWorktreeHasChatTab: jest.fn((): Promise<void> => {
      callOrder.push('ensureWorktreeHasChatTab');
      return Promise.resolve();
    }),
    togglePlanMode: jest.fn((): void => {
      callOrder.push('togglePlanMode');
    }),
    setTabApprovalMode: jest.fn((): Promise<void> => {
      callOrder.push('setTabApprovalMode');
      return Promise.resolve();
    }),
    setSelectedRepoId: jest.fn((): void => {
      callOrder.push('setSelectedRepoId');
    }),
    setModel: jest.fn(),
    setModelSelectionMode: jest.fn((): Promise<void> => {
      callOrder.push('setModelSelectionMode');
      return Promise.resolve();
    }),
    // Mirrors the real `Promise<boolean>` contract — `resolve(true)` is the
    // acceptance, and a typed `Promise<void>` mock would let a refusal
    // regression pass unnoticed.
    setModelAndWait: jest.fn((): Promise<boolean> => {
      callOrder.push('setModel');
      return Promise.resolve(true);
    }),
    setThinkingLevel: jest.fn((): Promise<void> => {
      callOrder.push('setThinkingLevel');
      return Promise.resolve();
    }),
    setPluginSelections: jest.fn((): ChatTabPluginSelections | undefined => {
      callOrder.push('setPluginSelections');
      return undefined;
    }),
    loadAllWorktreeTabs: jest.fn((): Promise<void> => {
      callOrder.push('loadAllWorktreeTabs');
      return Promise.resolve();
    }),
    ensureSelectedWorktreeTabsLoaded: jest.fn(
      (): Promise<boolean> => Promise.resolve(true),
    ),
    loadTabsForTarget: jest.fn((): Promise<void> => {
      callOrder.push('loadTabsForTarget');
      return Promise.resolve();
    }),
    sendMessage: jest.fn((): Promise<void> => {
      callOrder.push('sendMessage');
      return Promise.resolve();
    }),
    setScheduledSendDraft: jest.fn((): Promise<void> => {
      callOrder.push('setScheduledSendDraft');
      return Promise.resolve();
    }),
    flushWorktreeTabs: jest.fn((): Promise<void> => {
      callOrder.push('flushWorktreeTabs');
      return Promise.resolve();
    }),
  });

  useProjectsStore.setState({
    createWorktree: jest.fn(
      (_projectId: string, options?: CreateWorktreeOptions) => {
        const workspace = useProjectsStore
          .getState()
          .projects.find((project) => project.id === 'ws-1');
        const registered =
          workspace && workspace.type !== 'cowork'
            ? workspace.worktrees.find((worktree) => worktree.id === 'wt-1')
            : undefined;
        callOrder.push('createWorktree');
        options?.onRegistered?.(
          registered ?? makeWorktree({ id: 'wt-1', branchName: 'wt-1' }),
        );
        return Promise.resolve({ id: 'wt-1' });
      },
    ),
    // Task I1: `pendingWorkspaceRepair` defaults null so a falsy `createWorktree`
    // result takes the plain-failure branch (stay on Home + `sendError`) unless
    // a test sets it to simulate the deferred repair modal.
    pendingWorkspaceRepair: null,
  });

  useNavigationStore.setState({
    navigate: jest.fn((): void => {
      callOrder.push('navigate');
    }),
  });

  useStandaloneChatStore.setState({
    createStandaloneChatWithMessage: jest.fn((): Promise<string> => {
      callOrder.push('createStandaloneChatWithMessage');
      return Promise.resolve('chat-1');
    }),
  });

  useAutomationsStore.setState({
    createActivity: jest.fn((): Promise<AutomationMutationResponse> => {
      callOrder.push('createActivity');
      return Promise.resolve({ ok: true, activity: makeActivity() });
    }),
  });
}

beforeEach(() => {
  resetStores();
  resetHomeLinkTargetSyncForTests();
  jest.mocked(preflightHomeModel).mockReset().mockResolvedValue({ ok: true });
  jest.mocked(cachedHomeModelRefusal).mockReset().mockReturnValue({ ok: true });
});

describe('Cursor Home runtime availability', () => {
  it.each(['supported', 'enabled', 'installed', 'status-error'])(
    'preserves the draft before any creation when Cursor %s is unavailable',
    async (unavailable) => {
      seedLoadTabsForTarget(undefined);
      const status = jest.fn(() =>
        unavailable === 'status-error'
          ? Promise.reject(new Error('status unavailable'))
          : Promise.resolve({
              supported: unavailable !== 'supported',
              installed: unavailable !== 'installed',
              enabled: unavailable !== 'enabled',
              version: 'test',
              phase: 'idle',
            }),
      );
      installHomeGetCoworkRoot(() => Promise.resolve('/tmp/cowork'));
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { ...window.api, cursorConnection: { status } },
      });
      useHomeComposerStore.setState({
        workspaceId: 'ws-1',
        branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
        text: 'keep this Cursor draft',
        model: 'cursor-default',
      });
      await dispatchHomeSend();
      expect(useChatStore.getState().createTab).not.toHaveBeenCalled();
      expect(useProjectsStore.getState().createWorktree).not.toHaveBeenCalled();
      expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
      expect(useHomeComposerStore.getState().text).toBe(
        'keep this Cursor draft',
      );
      expect(useHomeComposerStore.getState().sendError).toContain('Cursor');
      expect(useHomeComposerStore.getState().isSending).toBe(false);
    },
  );
});

describe('dispatchHomeSend guards', () => {
  it.each(['new-worktree', 'worktree'] as const)(
    'sends attachment-only drafts and settings into a %s chat',
    async (kind) => {
      seedLoadTabsForTarget('git-ready');
      await useChatStore.getState().loadAllWorktreeTabs([]);
      const attachment = makeAttachment({ promptKind: 'linear-ticket' });
      const restaged = makeAttachment({
        absolutePath: '/tmp/attachments/wt-1/notes.md',
      });
      importChatAttachmentsMock.mockResolvedValue([restaged]);
      const pluginSelections = makePluginSelections({
        collectionIds: ['review'],
      });
      useHomeComposerStore.setState({
        workspaceId: 'ws-1',
        text: '   ',
        branchTarget:
          kind === 'worktree' ? { kind, worktreeId: 'wt-1' } : { kind },
        attachments: [attachment],
        model: 'sonnet',
        thinkingLevel: 'high',
        planMode: true,
        pluginSelections,
        approvalMode: 'full-access',
      });

      await expect(dispatchHomeSend()).resolves.toBe(true);

      expect(importChatAttachmentsMock).toHaveBeenCalledWith(
        { projectId: 'ws-1', worktreeId: 'wt-1' },
        [attachment.absolutePath],
      );
      expect(useChatStore.getState().togglePlanMode).toHaveBeenCalled();
      expect(useChatStore.getState().setTabApprovalMode).toHaveBeenCalled();
      expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
        undefined,
        expect.objectContaining({
          attachmentPaths: [restaged.absolutePath],
        }),
      );
      expect(
        typeof jest.mocked(useChatStore.getState().sendMessage).mock
          .calls[0]?.[4]?.userMessageId,
      ).toBe('string');
      expect(useHomeComposerStore.getState().attachments).toEqual([]);
    },
  );

  it.each(['', '   \n '])(
    'creates an empty worktree for blank text %j',
    async (text) => {
      seedLoadTabsForTarget('git-pending');
      useHomeComposerStore.setState({ workspaceId: 'ws-1', text });

      await expect(dispatchHomeSend()).resolves.toBe(true);

      expect(useProjectsStore.getState().createWorktree).toHaveBeenCalled();
      expect(useNavigationStore.getState().navigate).toHaveBeenCalledWith(
        'main',
      );
      expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
      expect(useHomeComposerStore.getState().text).toBe('');
      expect(useHomeComposerStore.getState().isSending).toBe(false);
    },
  );

  it('keeps an attachment-only Home draft when destination import fails', async () => {
    seedLoadTabsForTarget('git-ready');
    const attachment = makeAttachment({ promptKind: 'linear-ticket' });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      attachments: [attachment],
    });
    importChatAttachmentsMock.mockRejectedValue(
      new Error('Attachment import failed'),
    );
    await expect(dispatchHomeSend()).resolves.toBe(false);
    expect(useHomeComposerStore.getState().attachments).toEqual([attachment]);
    expect(useHomeComposerStore.getState().sendError).toContain(
      'Attachment import failed',
    );
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
  });

  it('creates an empty tab in an existing worktree without sending', async () => {
    seedLoadTabsForTarget('git-ready');
    await useChatStore.getState().loadAllWorktreeTabs([]);
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      text: '   ',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
    });
    await expect(dispatchHomeSend()).resolves.toBe(true);
    expect(useChatStore.getState().createTab).toHaveBeenCalled();
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
  });

  it('restores and awaits the displayed thinking level after an existing-worktree harness change', async () => {
    seedLoadTabsForTarget('git-ready');
    await useChatStore.getState().loadAllWorktreeTabs([]);
    let acceptThinking = (): void => {};
    const thinkingAccepted = new Promise<void>((resolve) => {
      acceptThinking = resolve;
    });
    jest
      .mocked(useChatStore.getState().setThinkingLevel)
      .mockImplementation(() => {
        callOrder.push('setThinkingLevel');
        return thinkingAccepted;
      });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'Keep the displayed effort',
      model: 'ollama-qwen3',
      executionHarness: 'claude',
      thinkingLevel: 'low',
    });
    const send = dispatchHomeSend();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useChatStore.getState().setModelAndWait).toHaveBeenCalled();
    expect(useChatStore.getState().setThinkingLevel).toHaveBeenCalledWith(
      'low',
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
    );
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
    acceptThinking();
    expect(await send).toBe(true);
    expect(callOrder.indexOf('setModel')).toBeLessThan(
      callOrder.indexOf('setThinkingLevel'),
    );
    expect(callOrder.indexOf('setThinkingLevel')).toBeLessThan(
      callOrder.indexOf('sendMessage'),
    );
  });

  it('does not schedule a message when creating an empty worktree', async () => {
    seedLoadTabsForTarget('git-ready');
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      text: '',
      scheduledSendDraft: { runAt: '2030-01-01T12:00:00.000Z' },
    });
    await expect(dispatchHomeSend()).resolves.toBe(true);
    expect(useProjectsStore.getState().createWorktree).toHaveBeenCalled();
    expect(useChatStore.getState().setScheduledSendDraft).toHaveBeenCalledWith(
      { runAt: '2030-01-01T12:00:00.000Z' },
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
    );
    expect(
      useAutomationsStore.getState().createActivity,
    ).not.toHaveBeenCalled();
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
  });

  it('locks synchronously while prompt mentions are loading', async () => {
    let resolvePrompt: ((value: { content: string }) => void) | undefined;
    const readPromptByPath = jest.fn(
      () =>
        new Promise<{ content: string }>((resolve) => {
          resolvePrompt = resolve;
        }),
    );
    installHomeGetCoworkRoot(() => Promise.resolve('/tmp/cowork'));
    const testWindow = globalThis.window;
    Object.defineProperty(testWindow, 'api', {
      configurable: true,
      value: {
        ...testWindow.api,
        workspaceItems: { readPromptByPath },
      },
    });
    useProjectsStore.setState({ projects: [makeCoworkProject('cowork-1')] });
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'Prompt: Review Helper',
      fileReferences: [
        {
          displayPath: 'Prompt: Review Helper',
          absolutePath: '/tmp/cowork/prompts/review-helper.md',
          kind: 'prompt',
          textStart: 0,
        },
      ],
    });

    const first = dispatchHomeSend();
    const second = dispatchHomeSend();
    await expect(second).resolves.toBe(false);
    expect(useHomeComposerStore.getState().isSending).toBe(true);

    resolvePrompt?.({ content: 'Review the diff.' });
    await expect(first).resolves.toBe(true);
    expect(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage,
    ).toHaveBeenCalledTimes(1);
  });

  it('no-ops when no project is selected', async () => {
    useHomeComposerStore.setState({ workspaceId: null, text: 'hello' });

    await dispatchHomeSend();

    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
  });

  it('no-ops when already sending', async () => {
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      text: 'hello',
      isSending: true,
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
  });

  it('no-ops while an attachment import is pending', async () => {
    useHomeComposerStore.setState({ workspaceId: 'ws-1', text: 'hello' });
    const token = useHomeComposerStore.getState().beginAttachmentImport();

    await expect(dispatchHomeSend()).resolves.toBe(false);

    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().isSending).toBe(false);
    useHomeComposerStore.getState().finishAttachmentImport(token);
  });
});

describe('dispatchHomeSend cowork routing', () => {
  it('routes to createStandaloneChatWithMessage with config passthrough, then navigates and resets', async () => {
    useProjectsStore.setState({ projects: [makeCoworkProject('cowork-1')] });
    const pluginSelections = makePluginSelections({
      collectionIds: ['c1'],
    });
    const model: ChatModel = 'claude-sonnet-4-5';

    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'build the thing',
      model,
      modelSelectionMode: 'auto',
      thinkingLevel: 'medium',
      pluginSelections,
      approvalMode: 'auto',
      attachments: [{ filename: 'a.png', absolutePath: '/tmp/a.png' }],
    });

    await dispatchHomeSend();

    expect(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage,
    ).toHaveBeenCalledWith({
      chatProjectId: 'cowork-1',
      message: 'build the thing',
      config: {
        model,
        // Round-2 finding 5: a draft that names a model IS an explicit pick.
        modelExplicitlyChosen: true,
        modelSelectionMode: 'auto',
        thinkingLevel: 'medium',
        pluginSelections,
        fileReferences: undefined,
        attachmentPaths: ['/tmp/a.png'],
        attachments: [{ filename: 'a.png', absolutePath: '/tmp/a.png' }],
        attachmentPromptContexts: undefined,
        approvalMode: 'auto',
      },
    });
    expect(useNavigationStore.getState().navigate).toHaveBeenCalledWith('chat');
    expect(callOrder).toEqual(['createStandaloneChatWithMessage', 'navigate']);

    // Success resets the draft.
    expect(useHomeComposerStore.getState().text).toBe('');
    expect(useHomeComposerStore.getState().workspaceId).toBeNull();
    expect(useHomeComposerStore.getState().isSending).toBe(false);
  });

  it('sends the same model-clamped thinking level the Home controls display', async () => {
    initCodexModels([
      {
        id: 'limited-codex',
        label: 'Limited Codex',
        supportedThinkingLevels: ['off', 'medium', 'high'],
      },
    ]);
    useProjectsStore.setState({ projects: [makeCoworkProject('cowork-1')] });
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'build the thing',
      model: 'limited-codex',
      thinkingLevel: 'ultra',
    });

    await dispatchHomeSend();

    const request = jest.mocked(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage,
    ).mock.calls[0]?.[0];
    expect(request?.config?.model).toBe('limited-codex');
    expect(request?.config?.thinkingLevel).toBe('high');
  });

  it('does not touch chatStore worktree/tab flows for cowork', async () => {
    useProjectsStore.setState({ projects: [makeCoworkProject('cowork-1')] });
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'hi',
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().selectWorktree).not.toHaveBeenCalled();
    expect(useChatStore.getState().createTab).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().createWorktree).not.toHaveBeenCalled();
  });
});

describe('dispatchHomeSend existing-worktree routing', () => {
  it.each(['accepted', 'queued', 'rejected'] as const)(
    'reports a Home worktree turn only after %s dispatch',
    async (outcome) => {
      useProjectsStore.setState({
        projects: [
          makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
        ],
      });
      jest.mocked(useChatStore.getState().createTab).mockImplementation(() => {
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              tabs: [{ ...createEmptyTab(), id: 'tab-1' }],
              activeTabId: 'tab-1',
            },
          },
        });
      });
      useHomeComposerStore.setState({
        workspaceId: 'ws-1',
        branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
        text: 'A live turn',
      });
      jest
        .mocked(useChatStore.getState().sendMessage)
        .mockImplementation(
          (_text, _refs, _target, _mode, options): Promise<void> => {
            if (outcome === 'accepted') options?.onDispatchAccepted?.();
            if (outcome === 'queued')
              options?.onQueuedWithoutDispatch?.('renderer');
            if (outcome === 'rejected') options?.onPreDispatchRejected?.();
            return Promise.resolve();
          },
        );
      const accepted = jest.fn();
      const unsubscribe = subscribeAcceptedWorktreeTurns(accepted);
      try {
        await dispatchHomeSend();
        expect(accepted).toHaveBeenCalledTimes(outcome === 'accepted' ? 1 : 0);
      } finally {
        unsubscribe();
      }
    },
  );

  it('waits for the canonical Auto selection before accepting the first message', async () => {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
      ],
    });
    jest
      .mocked(useChatStore.getState().createTab)
      .mockImplementation((): void => {
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              tabs: [{ ...createEmptyTab(), id: 'tab-1' }],
              activeTabId: 'tab-1',
            },
          },
        });
      });
    let releaseAuto!: () => void;
    const autoPersisted = new Promise<void>((resolve) => {
      releaseAuto = resolve;
    });
    jest
      .mocked(useChatStore.getState().setModelSelectionMode)
      .mockImplementation(() => {
        callOrder.push('setModelSelectionMode');
        return autoPersisted;
      });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'route this first turn',
      modelSelectionMode: 'auto',
    });

    const send = dispatchHomeSend();
    await expect(
      Promise.race([
        send.then(() => 'sent'),
        new Promise<'waiting'>((resolve) =>
          setTimeout(() => resolve('waiting'), 25),
        ),
      ]),
    ).resolves.toBe('waiting');
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();

    releaseAuto();
    await expect(send).resolves.toBe(true);
    expect(callOrder.indexOf('setModelSelectionMode')).toBeLessThan(
      callOrder.indexOf('sendMessage'),
    );
  });

  it('selects the worktree, seeds config via createTab, toggles plan mode, then sends', async () => {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
      ],
    });

    // The mocked createTab does not itself populate `worktreeChats`; simulate
    // that side effect so the orchestrator can resolve the new active tab id.
    jest
      .mocked(useChatStore.getState().createTab)
      .mockImplementation((): void => {
        callOrder.push('createTab');
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              tabs: [{ ...createEmptyTab(), id: 'tab-1' }],
              activeTabId: 'tab-1',
            },
          },
        });
      });

    const pluginSelections = makePluginSelections();
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'fix the bug',
      model: 'claude-sonnet-4-5',
      thinkingLevel: 'high',
      planMode: true,
      pluginSelections,
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().selectWorktree).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
    );
    expect(useNavigationStore.getState().navigate).toHaveBeenCalledWith('main');
    expect(useChatStore.getState().createTab).toHaveBeenCalledWith({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      model: 'claude-sonnet-4-5',
      modelExplicitlyChosen: true,
      thinkingLevel: 'high',
      pluginSelections,
    });
    expect(useChatStore.getState().togglePlanMode).toHaveBeenCalledWith({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'tab-1',
    });
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'fix the bug',
      undefined,
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
      undefined,
      expect.objectContaining({
        attachmentPaths: undefined,
        attachmentPromptContexts: undefined,
      }),
    );

    // Config (via createTab) and the plan toggle both happen before sendMessage.
    expect(callOrder).toEqual([
      'createTab',
      'selectWorktree',
      'navigate',
      'ensureWorktreeHasChatTab',
      'togglePlanMode',
      'sendMessage',
    ]);
    expect(useHomeComposerStore.getState().text).toBe('');
  });

  it('re-enables a mentioned plugin the draft no longer has selected before sending', async () => {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
      ],
    });
    jest
      .mocked(useChatStore.getState().createTab)
      .mockImplementation((): void => {
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              tabs: [{ ...createEmptyTab(), id: 'tab-1' }],
              activeTabId: 'tab-1',
            },
          },
        });
      });

    // The user dropped an `@delta-tool` pill (which enabled the plugin), then
    // removed the plugin again from the picker. The mention wins at send.
    const pluginMention = {
      displayPath: 'delta-tool',
      absolutePath: 'plugin://demo%2Fmarket/delta-tool',
      kind: 'plugin',
    };
    seedTargetIndexFetch('/workspaces/ws-1/worktrees/wt-1');
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'Use delta-tool here',
      fileIndex: [makeRepoFileIndex()],
      fileReferences: [pluginMention],
      pluginSelections: makePluginSelections(),
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().createTab).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginSelections: makePluginSelections({
          pluginRefs: [
            { marketplaceId: 'demo/market', pluginName: 'delta-tool' },
          ],
        }),
      }),
    );
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'Use delta-tool here',
      [pluginMention],
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
      undefined,
      expect.objectContaining({
        attachmentPaths: undefined,
        attachmentPromptContexts: undefined,
      }),
    );
  });

  it('pins an explicit draft approvalMode onto the created tab before sending', async () => {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
      ],
    });
    jest
      .mocked(useChatStore.getState().createTab)
      .mockImplementation((): void => {
        callOrder.push('createTab');
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              tabs: [{ ...createEmptyTab(), id: 'tab-1' }],
              activeTabId: 'tab-1',
            },
          },
        });
      });

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'fix the bug',
      approvalMode: 'full-access',
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().setTabApprovalMode).toHaveBeenCalledWith(
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
      'full-access',
    );
    expect(callOrder).toEqual([
      'createTab',
      'selectWorktree',
      'navigate',
      'ensureWorktreeHasChatTab',
      'setTabApprovalMode',
      'sendMessage',
    ]);
  });

  it('does not pin an approval mode onto the created tab when the draft never touched it', async () => {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
      ],
    });
    jest
      .mocked(useChatStore.getState().createTab)
      .mockImplementation((): void => {
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              tabs: [{ ...createEmptyTab(), id: 'tab-1' }],
              activeTabId: 'tab-1',
            },
          },
        });
      });

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'fix the bug',
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().setTabApprovalMode).not.toHaveBeenCalled();
  });

  it('re-imports stale home-draft attachments before sending to an existing worktree, preserving promptKind (Finding 2)', async () => {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
      ],
    });
    jest
      .mocked(useChatStore.getState().createTab)
      .mockImplementation((): void => {
        callOrder.push('createTab');
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              tabs: [{ ...createEmptyTab(), id: 'tab-1' }],
              activeTabId: 'tab-1',
            },
          },
        });
      });
    // Staged under `new-worktree`, then the branch picker was switched to
    // this existing worktree — the attachment still points at the
    // `home-draft` staging dir. The import IPC's response never carries
    // `promptKind` (only filename/absolutePath/sizeBytes), so the fix must
    // re-attach it from the source attachment.
    importChatAttachmentsMock.mockImplementation(() => {
      callOrder.push('importChatAttachments');
      return Promise.resolve([
        {
          filename: 'linear-can-202.md',
          absolutePath: '/workspaces/ws-1/attachments/wt-1/linear-can-202.md',
        },
      ]);
    });

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'fix the ticket',
      attachments: [
        {
          filename: 'linear-can-202.md',
          absolutePath:
            '/workspaces/ws-1/attachments/home-draft/linear-can-202.md',
          promptKind: 'linear-ticket',
        },
      ],
    });

    await dispatchHomeSend();

    expect(importChatAttachmentsMock).toHaveBeenCalledWith(
      { projectId: 'ws-1', worktreeId: 'wt-1' },
      ['/workspaces/ws-1/attachments/home-draft/linear-can-202.md'],
    );

    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'fix the ticket',
      undefined,
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
      undefined,
      expect.objectContaining({
        attachmentPaths: [
          '/workspaces/ws-1/attachments/wt-1/linear-can-202.md',
        ],
        attachmentPromptContexts: [
          {
            attachmentPath:
              '/workspaces/ws-1/attachments/wt-1/linear-can-202.md',
            promptKind: 'linear-ticket',
          },
        ],
      }),
    );

    // The `toHaveBeenCalledWith` assertion above already pins
    // `attachmentPaths`/`attachmentPromptContexts` to the restaged path, so
    // the stale home-draft path never reaches the dispatched payload.

    expect(callOrder).toEqual([
      'createTab',
      'selectWorktree',
      'navigate',
      'ensureWorktreeHasChatTab',
      'importChatAttachments',
      'sendMessage',
    ]);
  });

  it('does not re-import attachments already staged directly for the target worktree', async () => {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
      ],
    });
    jest
      .mocked(useChatStore.getState().createTab)
      .mockImplementation((): void => {
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              tabs: [{ ...createEmptyTab(), id: 'tab-1' }],
              activeTabId: 'tab-1',
            },
          },
        });
      });

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'fix the bug',
      attachments: [
        {
          filename: 'a.png',
          absolutePath: '/workspaces/ws-1/attachments/wt-1/a.png',
        },
      ],
    });

    await dispatchHomeSend();

    expect(importChatAttachmentsMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'fix the bug',
      undefined,
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
      undefined,
      expect.objectContaining({
        attachmentPaths: ['/workspaces/ws-1/attachments/wt-1/a.png'],
        attachmentPromptContexts: undefined,
      }),
    );
  });

  it('does not call the targeted setModel/setThinkingLevel/setPluginSelections setters (config goes through createTab)', async () => {
    jest
      .mocked(useChatStore.getState().createTab)
      .mockImplementation((): void => {
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              tabs: [{ ...createEmptyTab(), id: 'tab-1' }],
              activeTabId: 'tab-1',
            },
          },
        });
      });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'hi',
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().setModel).not.toHaveBeenCalled();
    expect(useChatStore.getState().setThinkingLevel).not.toHaveBeenCalled();
    expect(useChatStore.getState().setPluginSelections).not.toHaveBeenCalled();
  });

  it('fails gracefully when no active tab id can be resolved after createTab', async () => {
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'hi',
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().isSending).toBe(false);
    expect(useHomeComposerStore.getState().sendError).toBe(
      'Failed to create chat tab.',
    );
    // Draft is preserved on failure.
    expect(useHomeComposerStore.getState().text).toBe('hi');
  });
});

describe('dispatchHomeSend new-worktree / branch routing', () => {
  it('waits for a git-pending starter tab and panel layout before selecting and navigating', async () => {
    seedLoadTabsForTarget('git-pending');
    let resolveStarterTab: (() => void) | undefined;
    let resolvePanelLayout: (() => void) | undefined;
    let reportStarterTabRequested: (() => void) | undefined;
    const starterTabRequested = new Promise<void>((resolve) => {
      reportStarterTabRequested = resolve;
    });
    const starterTabReady = new Promise<void>((resolve) => {
      resolveStarterTab = resolve;
    });
    const panelLayoutReady = new Promise<void>((resolve) => {
      resolvePanelLayout = resolve;
    });
    ensureWorktreePanelLayoutMock.mockImplementationOnce(() => {
      callOrder.push('ensureWorktreePanelLayout');
      return panelLayoutReady;
    });
    jest
      .mocked(useChatStore.getState().ensureWorktreeHasChatTab)
      .mockImplementationOnce((): Promise<void> => {
        callOrder.push('ensureWorktreeHasChatTab');
        reportStarterTabRequested?.();
        return starterTabReady;
      });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'build a thing',
    });

    const send = dispatchHomeSend();
    await starterTabRequested;

    expect(useChatStore.getState().selectWorktree).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().navigate).not.toHaveBeenCalled();

    resolveStarterTab?.();
    await Promise.resolve();

    expect(ensureWorktreePanelLayoutMock).toHaveBeenCalledWith('ws-1/wt-1');
    expect(useChatStore.getState().selectWorktree).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().navigate).not.toHaveBeenCalled();

    resolvePanelLayout?.();
    await send;

    expect(useChatStore.getState().selectWorktree).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
      { deferTabLoad: true },
    );
    expect(callOrder.indexOf('ensureWorktreePanelLayout')).toBeLessThan(
      callOrder.indexOf('selectWorktree'),
    );
    expect(useNavigationStore.getState().navigate).toHaveBeenCalledWith('main');
  });

  it.each(['new-worktree', 'pr'] as const)(
    'waits for canonical chat hydration before building the %s layout',
    async (targetKind) => {
      seedLoadTabsForTarget('git-pending');
      let releaseHydration = (): void => undefined;
      let reportHydration = (): void => undefined;
      const started = new Promise<void>((resolve) => {
        reportHydration = resolve;
      });
      const hydration = new Promise<void>((resolve) => {
        releaseHydration = resolve;
      });
      jest
        .mocked(useChatStore.getState().loadTabsForTarget)
        .mockImplementationOnce(async () => {
          reportHydration();
          await hydration;
        });
      useHomeComposerStore.setState({
        workspaceId: 'ws-1',
        branchTarget:
          targetKind === 'pr'
            ? {
                kind: 'pr',
                number: 42,
                title: 'Fix things',
                headRefName: 'fix/things',
                url: 'https://example.test/pr/42',
              }
            : { kind: 'new-worktree' },
        text: '',
      });
      const send = dispatchHomeSend();
      await started;
      try {
        expect(
          useChatStore.getState().ensureWorktreeHasChatTab,
        ).not.toHaveBeenCalled();
        expect(ensureWorktreePanelLayoutMock).not.toHaveBeenCalled();
        expect(useNavigationStore.getState().navigate).not.toHaveBeenCalled();
      } finally {
        releaseHydration();
        await send;
      }
      expect(ensureWorktreePanelLayoutMock).toHaveBeenCalledWith('ws-1/wt-1');
    },
  );

  it('waits for the panel layout before selecting and navigating when registration is already git-ready', async () => {
    seedLoadTabsForTarget('git-ready');
    let resolvePanelLayout: (() => void) | undefined;
    let reportPanelLayoutRequested: (() => void) | undefined;
    const panelLayoutRequested = new Promise<void>((resolve) => {
      reportPanelLayoutRequested = resolve;
    });
    const panelLayoutReady = new Promise<void>((resolve) => {
      resolvePanelLayout = resolve;
    });
    ensureWorktreePanelLayoutMock.mockImplementationOnce(() => {
      callOrder.push('ensureWorktreePanelLayout');
      reportPanelLayoutRequested?.();
      return panelLayoutReady;
    });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'build a thing',
    });

    const send = dispatchHomeSend();
    const firstCompleted = await Promise.race([
      panelLayoutRequested.then(() => 'layout-requested'),
      send.then(() => 'send-completed'),
    ]);

    expect(firstCompleted).toBe('layout-requested');
    expect(ensureWorktreePanelLayoutMock).toHaveBeenCalledWith('ws-1/wt-1');
    expect(useChatStore.getState().selectWorktree).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().navigate).not.toHaveBeenCalled();

    resolvePanelLayout?.();
    await send;

    expect(useChatStore.getState().selectWorktree).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
    );
    expect(callOrder.indexOf('ensureWorktreePanelLayout')).toBeLessThan(
      callOrder.indexOf('selectWorktree'),
    );
    expect(useNavigationStore.getState().navigate).toHaveBeenCalledWith('main');
  });

  it('keeps Home mounted while an already-ready worktree creates its starter chat', async () => {
    seedLoadTabsForTarget('git-ready');
    let release = (): void => undefined;
    let requested = (): void => undefined;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    jest
      .mocked(useChatStore.getState().ensureWorktreeHasChatTab)
      .mockImplementationOnce(() => {
        requested();
        return ready;
      });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'Keep the prompt visible',
    });
    const send = dispatchHomeSend();
    try {
      await started;
      expect(useNavigationStore.getState().navigate).not.toHaveBeenCalled();
      expect(useChatStore.getState().selectWorktree).not.toHaveBeenCalled();
    } finally {
      release();
      await send;
    }
    expect(useNavigationStore.getState().navigate).toHaveBeenCalledWith('main');
  });

  it('creates a new worktree, joins tab hydration, applies config, toggles plan mode, then sends when git-pending', async () => {
    seedLoadTabsForTarget('git-pending');
    importChatAttachmentsMock.mockImplementation(() => {
      callOrder.push('importChatAttachments');
      return Promise.resolve([
        {
          filename: 'a.png',
          absolutePath: '/workspaces/ws-1/attachments/wt-1/a.png',
        },
      ]);
    });

    const pluginSelections = makePluginSelections();
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'build a thing',
      model: 'claude-sonnet-4-5',
      thinkingLevel: 'low',
      planMode: true,
      pluginSelections,
      attachments: [{ filename: 'a.png', absolutePath: '/tmp/a.png' }],
    });

    await dispatchHomeSend();

    // Staged home-draft attachments must be re-imported into the new
    // worktree's own attachment dir before being referenced — the send path
    // validates `attachmentPaths` against the target worktree's directory.
    expect(importChatAttachmentsMock).toHaveBeenCalledWith(
      { projectId: 'ws-1', worktreeId: 'wt-1' },
      ['/tmp/a.png'],
    );

    expect(useNavigationStore.getState().navigate).toHaveBeenCalledWith('main');
    expect(useProjectsStore.getState().createWorktree).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({
        select: false,
        suppressStartPage: true,
      }),
    );
    expect(
      jest.mocked(useProjectsStore.getState().createWorktree).mock.calls[0]?.[1]
        ?.onRegistered,
    ).toBeInstanceOf(Function);
    // Task I1 (kill the stale-selection flash): the stale prior selection is
    // cleared synchronously up front, before the reservation is awaited, so a
    // failed create never strands the user on a cross-workspace selection and
    // the eventual navigate can't paint a previous worktree's chat.
    expect(useChatStore.getState().deselectWorktree).toHaveBeenCalledTimes(1);
    // Task I1: the created worktree's chat is seeded, then the worktree is
    // selected and navigated to, so the FIRST Code frame is its real chat
    // panel (with the queued bubble explaining the setup wait).
    expect(useChatStore.getState().selectWorktree).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
      { deferTabLoad: true },
    );
    expect(useChatStore.getState().loadTabsForTarget).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
      {
        model: 'claude-sonnet-4-5',
        thinkingLevel: 'low',
        pluginSelections,
        skipActiveSessions: true,
      },
    );

    const target = { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' };
    expect(useChatStore.getState().setModelAndWait).toHaveBeenCalledWith(
      'claude-sonnet-4-5',
      target,
    );
    expect(useChatStore.getState().setThinkingLevel).toHaveBeenCalledWith(
      'low',
      target,
    );
    expect(applyNewChatPluginSelectionsMock).toHaveBeenCalledWith(
      useChatStore.getState,
      target,
      { pluginSelections },
    );
    expect(useChatStore.getState().setPluginSelections).not.toHaveBeenCalled();
    expect(useChatStore.getState().togglePlanMode).toHaveBeenCalledWith(target);
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'build a thing',
      undefined,
      target,
      undefined,
      expect.objectContaining({
        attachmentPaths: ['/workspaces/ws-1/attachments/wt-1/a.png'],
        attachmentPromptContexts: undefined,
      }),
    );

    // Task I1 single-transition ordering: deselect (sync) → create (fast,
    // reservation-only) → seed configured tabs → select → navigate →
    // dispatch. No special pending page, no clear step — the created
    // worktree's real chat is the one and only new surface.
    expect(callOrder).toEqual([
      'deselectWorktree',
      'createWorktree',
      'loadTabsForTarget',
      'ensureWorktreeHasChatTab',
      'selectWorktree',
      'navigate',
      'loadAllWorktreeTabs',
      'ensureWorktreeHasChatTab',
      'importChatAttachments',
      'setModel',
      'setThinkingLevel',
      'applyNewChatPluginSelections',
      'togglePlanMode',
      'sendMessage',
    ]);

    // Load-bearing invariants the strict order encodes:
    // (1) the stale selection is cleared before the reservation is awaited;
    // (2) selection lands before navigation → the first Code frame is THIS
    //     worktree, never a stale one and never the embedded empty state;
    // (3) the message dispatch is the terminal step.
    expect(callOrder.indexOf('deselectWorktree')).toBeLessThan(
      callOrder.indexOf('createWorktree'),
    );
    expect(callOrder.indexOf('createWorktree')).toBeLessThan(
      callOrder.indexOf('loadTabsForTarget'),
    );
    expect(callOrder.indexOf('loadTabsForTarget')).toBeLessThan(
      callOrder.indexOf('ensureWorktreeHasChatTab'),
    );
    expect(callOrder.indexOf('ensureWorktreeHasChatTab')).toBeLessThan(
      callOrder.indexOf('selectWorktree'),
    );
    expect(callOrder.indexOf('selectWorktree')).toBeLessThan(
      callOrder.indexOf('navigate'),
    );
    expect(callOrder.indexOf('navigate')).toBeLessThan(
      callOrder.indexOf('sendMessage'),
    );
  });

  it('pins an explicit draft approvalMode onto the newly created tab before sending', async () => {
    seedLoadTabsForTarget('git-ready');

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'build a thing',
      approvalMode: 'auto',
    });

    await dispatchHomeSend();

    const target = { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' };
    expect(useChatStore.getState().setTabApprovalMode).toHaveBeenCalledWith(
      target,
      'auto',
    );
  });

  it('does not pin an approval mode onto the newly created tab when the draft never touched it', async () => {
    seedLoadTabsForTarget('git-ready');

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'build a thing',
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().setTabApprovalMode).not.toHaveBeenCalled();
  });

  it('waits for thinking persistence before applying the Codex speed to a blank draft', async () => {
    initCodexModels([
      {
        id: 'gpt-6-sol',
        label: 'Codex',
        supportedThinkingLevels: ['high', 'xhigh'],
      },
    ]);
    seedLoadTabsForTarget('git-ready');
    let acceptThinking = (): void => {};
    const thinkingAccepted = new Promise<void>((resolve) => {
      acceptThinking = resolve;
    });
    jest
      .mocked(useChatStore.getState().setThinkingLevel)
      .mockImplementation(() => thinkingAccepted);
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: '',
      model: 'gpt-6-sol',
      thinkingLevel: 'xhigh',
      fastMode: true,
    });
    const send = dispatchHomeSend();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useChatStore.getState().setThinkingLevel).toHaveBeenCalled();
    expect(useChatStore.getState().setSpeed).not.toHaveBeenCalled();
    acceptThinking();
    expect(await send).toBe(true);
    // A staged legacy boolean resolves to its exact speed.
    expect(useChatStore.getState().setSpeed).toHaveBeenCalledWith('fast', {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'tab-1',
    });
    expect(useChatStore.getState().setFastMode).not.toHaveBeenCalled();
  });

  it.each(['new-worktree', 'worktree'] as const)(
    'carries a staged Ultra fast speed and attachments into a %s chat',
    async (kind) => {
      initCodexModels([{ id: 'gpt-6-sol', label: 'Codex' }]);
      seedLoadTabsForTarget('git-ready');
      await useChatStore.getState().loadAllWorktreeTabs([]);
      const restaged = makeAttachment({
        absolutePath: '/tmp/attachments/wt-1/notes.md',
      });
      importChatAttachmentsMock.mockResolvedValue([restaged]);
      useHomeComposerStore.setState({
        workspaceId: 'ws-1',
        branchTarget:
          kind === 'worktree' ? { kind, worktreeId: 'wt-1' } : { kind },
        text: 'ship it fast',
        model: 'gpt-6-sol',
        thinkingLevel: 'high',
        attachments: [makeAttachment()],
      });
      useHomeComposerStore.getState().setSpeed('ultrafast');

      await expect(dispatchHomeSend()).resolves.toBe(true);

      const target = { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' };
      expect(useChatStore.getState().setSpeed).toHaveBeenCalledWith(
        'ultrafast',
        target,
      );
      expect(useChatStore.getState().setFastMode).not.toHaveBeenCalled();
      expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
        'ship it fast',
        undefined,
        target,
        undefined,
        expect.objectContaining({
          attachmentPaths: ['/tmp/attachments/wt-1/notes.md'],
        }),
      );
      expect(useHomeComposerStore.getState().speed).toBeUndefined();
    },
  );

  it('waits for the selected model to reach the created tab before the first send', async () => {
    seedLoadTabsForTarget('git-ready');
    let acceptModel = (): void => {
      throw new Error('Model acceptance resolver was not initialized.');
    };
    const modelAccepted = new Promise<boolean>((resolve) => {
      acceptModel = (): void => resolve(true);
    });
    jest
      .mocked(useChatStore.getState().setModelAndWait)
      .mockImplementation(() => {
        callOrder.push('setModel');
        return modelAccepted;
      });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'use my selected provider',
      model: 'claude-sonnet-4-5',
    });

    const send = dispatchHomeSend();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useChatStore.getState().setModelAndWait).toHaveBeenCalled();
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();

    acceptModel();
    await send;

    expect(useChatStore.getState().sendMessage).toHaveBeenCalledTimes(1);
    expect(callOrder.indexOf('setModel')).toBeLessThan(
      callOrder.indexOf('sendMessage'),
    );
  });

  it('waits for the selected model harness before capturing a first message during setup', async () => {
    seedLoadTabsForTarget('git-pending');
    let acceptModel = (): void => {
      throw new Error('Model acceptance resolver was not initialized.');
    };
    const modelAccepted = new Promise<boolean>((resolve) => {
      acceptModel = (): void => resolve(true);
    });
    jest
      .mocked(useChatStore.getState().setModelAndWait)
      .mockImplementation(() => {
        callOrder.push('setModel');
        return modelAccepted;
      });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'show this while setup is pending',
      model: 'claude-sonnet-4-5',
    });

    const send = dispatchHomeSend();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useChatStore.getState().setModelAndWait).toHaveBeenCalled();
    // A first queued message captures the tab's execution harness. Dispatching
    // while the model update is still pending would pin the provisional tab's
    // default harness (for example Codex) even when the Home composer selected
    // a gateway model assigned to Claude.
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();

    acceptModel();
    await send;

    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'show this while setup is pending',
      undefined,
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
      undefined,
      expect.objectContaining({
        attachmentPaths: undefined,
        attachmentPromptContexts: undefined,
      }),
    );
  });

  it('aborts the send when the model change is refused', async () => {
    // `setModelAndWait` reports "did it land" as a boolean and swallows a
    // rejected IPC as `false`, so the refusal arrives as a resolved `false`
    // rather than a throw. Treating that as success re-opens exactly what the
    // await exists to prevent: a first message during setup captures the tab's
    // execution harness, so sending after a refused model change can
    // permanently pin the provisional tab's default harness.
    seedLoadTabsForTarget('git-pending');
    jest
      .mocked(useChatStore.getState().setModelAndWait)
      .mockImplementation(() => {
        callOrder.push('setModel');
        return Promise.resolve(false);
      });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'refused model change',
      model: 'claude-sonnet-4-5',
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().setModelAndWait).toHaveBeenCalled();
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().sendError).not.toBeNull();
    // The draft survives so the user can retry rather than losing the text.
    expect(useHomeComposerStore.getState().text).toBe('refused model change');
  });

  it('aborts the send when selected-worktree tab hydration does not complete', async () => {
    seedLoadTabsForTarget('git-ready');
    jest
      .mocked(useChatStore.getState().ensureSelectedWorktreeTabsLoaded)
      .mockResolvedValue(false);
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'wait for hydration',
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().setModelAndWait).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().sendError).toBe(
      'Failed to load chat tabs.',
    );
    expect(useHomeComposerStore.getState().text).toBe('wait for hydration');
  });

  it('preserves promptKind on restaged attachments even though the import IPC response omits it (Finding 1)', async () => {
    seedLoadTabsForTarget('git-ready');
    // The main-process import handler's response never carries `promptKind`
    // — only filename/absolutePath/sizeBytes — so the fix must re-attach it
    // from the source draft attachment by request-order index.
    importChatAttachmentsMock.mockImplementation(() => {
      callOrder.push('importChatAttachments');
      return Promise.resolve([
        {
          filename: 'linear-can-202.md',
          absolutePath: '/workspaces/ws-1/attachments/wt-1/linear-can-202.md',
        },
      ]);
    });

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'fix the ticket',
      attachments: [
        {
          filename: 'linear-can-202.md',
          absolutePath: '/home-draft/attachments/linear-can-202.md',
          promptKind: 'linear-ticket',
        },
      ],
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'fix the ticket',
      undefined,
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
      undefined,
      expect.objectContaining({
        attachmentPaths: [
          '/workspaces/ws-1/attachments/wt-1/linear-can-202.md',
        ],
        attachmentPromptContexts: [
          {
            attachmentPath:
              '/workspaces/ws-1/attachments/wt-1/linear-can-202.md',
            promptKind: 'linear-ticket',
          },
        ],
      }),
    );
  });

  it('skips re-importing attachments when the draft has none', async () => {
    seedLoadTabsForTarget('git-pending');
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'build a thing',
    });

    await dispatchHomeSend();

    expect(importChatAttachmentsMock).not.toHaveBeenCalled();
  });

  it.each(['git-pending', 'git-ready'] as const)(
    'sends a %s first message straight to main, with no renderer setup queue',
    async (setupPhase) => {
      seedLoadTabsForTarget(setupPhase);
      useHomeComposerStore.setState({
        workspaceId: 'ws-1',
        branchTarget: { kind: 'new-worktree' },
        text: 'build a thing',
      });

      await dispatchHomeSend();

      const call = jest.mocked(useChatStore.getState().sendMessage).mock
        .calls[0];
      expect(call?.[2]).toEqual({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'tab-1',
      });
      expect(call?.[4]).not.toHaveProperty('queueForSetup');
    },
  );

  it('forwards existingBranch for a branch-kind target', async () => {
    seedLoadTabsForTarget(undefined);
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: {
        kind: 'branch',
        branchName: 'feature/foo',
        isRemote: true,
      },
      text: 'build a thing',
    });

    await dispatchHomeSend();

    expect(useProjectsStore.getState().createWorktree).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({
        existingBranch: 'feature/foo',
        select: false,
      }),
    );
    // Task G1: the branch-kind target hits the same "select the created
    // worktree immediately" code path as the new-worktree target above.
    expect(useChatStore.getState().selectWorktree).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
    );
  });

  it('creates a New worktree from the explicit single-repo base branch', async () => {
    seedLoadTabsForTarget(undefined);
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      newWorktreeBaseTarget: {
        kind: 'branch',
        branchName: 'release',
        isRemote: true,
      },
      text: 'build a thing',
    });

    await dispatchHomeSend();

    expect(useProjectsStore.getState().createWorktree).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ baseBranch: 'origin/release', select: false }),
    );
  });

  it('creates a New worktree from the selected existing worktree', async () => {
    seedLoadTabsForTarget(undefined);
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      newWorktreeBaseTarget: { kind: 'worktree', worktreeId: 'wt-base' },
      text: 'build a thing',
    });

    await dispatchHomeSend();

    expect(useProjectsStore.getState().createWorktree).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ baseWorktreeId: 'wt-base', select: false }),
    );
  });

  it('forwards the PR head branch as existingBranch for a pr-kind target', async () => {
    seedLoadTabsForTarget(undefined);
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: {
        kind: 'pr',
        number: 42,
        title: 'Fix things',
        headRefName: 'fix/things',
        url: 'https://example.test/pr/42',
      },
      text: 'build a thing',
    });

    await dispatchHomeSend();

    expect(useProjectsStore.getState().createWorktree).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({
        existingBranch: 'fix/things',
        select: false,
      }),
    );
  });

  it('checks out an existing Linear branch as existingBranch for a linear-issue target', async () => {
    seedLoadTabsForTarget(undefined);
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: {
        kind: 'linear-issue',
        identifier: 'ECW-1',
        title: 'Do it',
        branchName: 'ryan/ecw-1-do-it',
      },
      branchTargets: {
        supported: true,
        branches: [
          {
            name: 'ryan/ecw-1-do-it',
            isRemote: false,
            isCurrent: false,
            isUsedByWorktree: false,
            hasLocalRef: true,
            hasRemoteRef: false,
          },
        ],
        defaultBranch: null,
      },
      text: 'build a thing',
    });

    await dispatchHomeSend();

    expect(useProjectsStore.getState().createWorktree).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({
        existingBranch: 'ryan/ecw-1-do-it',
        select: false,
      }),
    );
  });

  it('creates a new branch for a linear-issue target whose branch does not exist yet', async () => {
    seedLoadTabsForTarget(undefined);
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: {
        kind: 'linear-issue',
        identifier: 'ECW-1',
        title: 'Do it',
        branchName: 'ryan/ecw-1-do-it',
      },
      branchTargets: {
        supported: true,
        branches: [],
        defaultBranch: null,
      },
      text: 'build a thing',
    });

    await dispatchHomeSend();

    expect(useProjectsStore.getState().createWorktree).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({
        branchName: 'ryan/ecw-1-do-it',
        select: false,
      }),
    );
  });

  it('shows the Git creation error and releases sending while preserving the retry draft', async () => {
    const error = 'Git is unavailable. Install Git, then recheck.';
    useProjectsStore.setState({ worktreeError: error });
    jest
      .mocked(useProjectsStore.getState().createWorktree)
      .mockResolvedValue(undefined);
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'build a thing',
    });

    await dispatchHomeSend();

    expect(useHomeComposerStore.getState()).toMatchObject({
      isSending: false,
      sendError: error,
      text: 'build a thing',
    });
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().navigate).not.toHaveBeenCalled();
  });

  it('sets sendError and preserves the draft when createWorktree fails', async () => {
    (
      useProjectsStore.getState().createWorktree as jest.Mock
    ).mockImplementation(() => Promise.resolve(undefined));
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'build a thing',
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().isSending).toBe(false);
    expect(useHomeComposerStore.getState().sendError).toBe(
      'Failed to create worktree.',
    );
    expect(useHomeComposerStore.getState().text).toBe('build a thing');
    // Task I1: navigation happens only AFTER a successful create, so a plain
    // (non-repair) failure leaves the user on Home with the preserved draft +
    // sendError. `pendingWorkspaceRepair` is null here, so the repair branch is
    // not taken and `navigate` is never called.
    expect(useNavigationStore.getState().navigate).not.toHaveBeenCalled();
    // Selection never lands on a failed creation — nothing to select.
    expect(useChatStore.getState().selectWorktree).not.toHaveBeenCalled();
    // The stale selection is still cleared up front, before the reservation is
    // awaited — so even a failed creation never leaves a stale cross-workspace
    // chat rendered during the attempt.
    expect(useChatStore.getState().deselectWorktree).toHaveBeenCalledTimes(1);
  });

  it('navigates to the Code-hosted repair modal (no sendError) when a repair is already pending', async () => {
    (
      useProjectsStore.getState().createWorktree as jest.Mock
    ).mockImplementation(() => Promise.resolve(undefined));
    // Defensive branch: if a synchronous `pendingWorkspaceRepair` was set (the
    // deferred path normally surfaces this asynchronously via the
    // `worktree:needs-repair` event), a falsy create result navigates to Code
    // so the repair modal is visible, rather than surfacing a plain error.
    useProjectsStore.setState({
      pendingWorkspaceRepair: {
        workspaceId: 'ws-1',
        workspaceName: 'ws-1',
        id: 'wt-1',
        branchName: 'task/foo',
        repairIssues: [],
        trackedRepoBaseBranches: {},
      },
    });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'build a thing',
    });

    await dispatchHomeSend();

    // The user is taken to Code (where the repair modal is hosted); no
    // sendError, draft intact.
    expect(useNavigationStore.getState().navigate).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().navigate).toHaveBeenCalledWith('main');
    expect(useHomeComposerStore.getState().isSending).toBe(false);
    expect(useHomeComposerStore.getState().sendError).toBeNull();
    expect(useHomeComposerStore.getState().text).toBe('build a thing');
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
  });

  it('sets sendError from a thrown sendMessage error and preserves the draft', async () => {
    seedLoadTabsForTarget('git-pending');
    (useChatStore.getState().sendMessage as jest.Mock).mockImplementation(() =>
      Promise.reject(
        new Error(
          "Error invoking remote method 'chat:send-message': ResourceGuardError: Canopy is under high memory pressure.",
        ),
      ),
    );
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'build a thing',
    });

    await dispatchHomeSend();

    expect(useHomeComposerStore.getState().isSending).toBe(false);
    expect(useHomeComposerStore.getState().sendError).toBe(
      'Canopy is under high memory pressure.',
    );
    expect(useHomeComposerStore.getState().text).toBe('build a thing');
  });
});

describe('dispatchHomeSend CAN-4742 first-send echo', () => {
  function starter(id = 'tab-1'): ChatTab {
    return { ...createEmptyTab(), id };
  }

  function tabIn(chatId: string): ChatTab | undefined {
    return useChatStore
      .getState()
      .worktreeChats['ws-1/wt-1']?.tabs.find((tab) => tab.id === chatId);
  }

  function userTexts(tab: ChatTab | undefined): string[] {
    return (tab?.messages ?? [])
      .filter((message) => message.role === 'user')
      .flatMap((message) =>
        message.blocks.flatMap((block) =>
          block.type === 'text' ? [block.text] : [],
        ),
      );
  }

  function seedStarterHydration(
    setupPhase: 'git-pending' | 'git-ready',
    pendingInitialCreation = false,
  ): void {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject('ws-1', {
          worktrees: [makeWorktree({ setupPhase })],
        }),
      ],
    });
    jest
      .mocked(useChatStore.getState().loadTabsForTarget)
      .mockImplementation((): Promise<void> => {
        callOrder.push('loadTabsForTarget');
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              tabs: [{ ...starter(), pendingInitialCreation }],
              activeTabId: 'tab-1',
            },
          },
        });
        return Promise.resolve();
      });
  }

  function draftNewWorktreeSend(text = 'build a thing'): void {
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text,
    });
  }

  it.each(['git-pending', 'git-ready'] as const)(
    'shows the question and its title before the %s chat opens',
    async (setupPhase) => {
      seedStarterHydration(setupPhase);
      const atNavigation: Array<{
        texts: string[];
        title?: string;
        shown: string[];
        queued: string[];
        starting: boolean;
      }> = [];
      jest
        .mocked(useNavigationStore.getState().navigate)
        .mockImplementation((): void => {
          callOrder.push('navigate');
          const tab = tabIn('tab-1');
          const view = tab ? toActiveTranscriptView(tab) : undefined;
          atNavigation.push({
            texts: userTexts(tab),
            title: tab?.title,
            shown: userTexts(view && { ...starter(), messages: view.messages }),
            queued: view?.queuedMessages.map((row) => row.text) ?? [],
            starting: view?.startingTurnUserMessageId !== undefined,
          });
        });
      draftNewWorktreeSend('Why is the deck empty?');

      await expect(dispatchHomeSend()).resolves.toBe(true);

      // A chat still setting up opens on the sent question and its starting
      // turn, as a ready one does: main holds the send until setup finishes.
      expect(atNavigation).toEqual([
        {
          texts: ['Why is the deck empty?'],
          title: 'Why is the deck empty?',
          shown: ['Why is the deck empty?'],
          queued: [],
          starting: true,
        },
      ]);
      const presented = tabIn('tab-1')?.provisionalFirstSend;
      expect(presented?.phase).toBe('preparing');
      expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
        'Why is the deck empty?',
        undefined,
        { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
        undefined,
        expect.objectContaining({ userMessageId: presented?.userMessageId }),
      );
    },
  );

  it('fails before opening the chat when no starter exists to show the question', async () => {
    seedStarterHydration('git-ready');
    jest
      .mocked(useChatStore.getState().loadTabsForTarget)
      .mockImplementation((): Promise<void> => Promise.resolve());
    draftNewWorktreeSend();

    await expect(dispatchHomeSend()).resolves.toBe(false);

    expect(useNavigationStore.getState().navigate).not.toHaveBeenCalled();
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().sendError).toBe(
      'Failed to create chat tab.',
    );
  });

  const failedTarget = {
    projectId: 'ws-1',
    worktreeId: 'wt-1',
    chatId: 'tab-1',
  };

  function setTabModel(chatId: string, model: ChatTab['model']): void {
    const scope = useChatStore.getState().worktreeChats['ws-1/wt-1'];
    if (!scope) throw new Error('The worktree scope was not seeded.');
    useChatStore.setState({
      worktreeChats: {
        'ws-1/wt-1': {
          ...scope,
          tabs: scope.tabs.map((tab) =>
            tab.id === chatId ? { ...tab, model } : tab,
          ),
        },
      },
    });
  }

  it.each([
    ['resolves false', (): Promise<boolean> => Promise.resolve(false)],
    [
      'rejects',
      (): Promise<boolean> => Promise.reject(new Error('main refused it')),
    ],
  ])(
    'keeps the prompt and title failed in place when the model change %s (CAN-5021)',
    async (_label, refuse) => {
      seedStarterHydration('git-ready');
      jest
        .mocked(useChatStore.getState().setModelAndWait)
        .mockImplementation(refuse);
      draftNewWorktreeSend();

      await expect(dispatchHomeSend()).resolves.toBe(false);

      const tab = tabIn('tab-1');
      expect(userTexts(tab)).toEqual(['build a thing']);
      expect(tab?.title).toBe('build a thing');
      expect(tab?.pendingTurn).toBeUndefined();
      expect(tab?.provisionalFirstSend?.phase).toBe('failed');
      const view = tab && toActiveTranscriptView(tab);
      expect(view?.messages.map((message) => message.id)).toEqual([
        tab?.provisionalFirstSend?.userMessageId,
      ]);
      expect(view?.startingTurnUserMessageId).toBeUndefined();
      // A bare refusal establishes no billing cause; the copy stays generic.
      expect(tab && toActiveComposerView(tab).failedFirstSend?.message).toMatch(
        /couldn’t be used to start this chat\. Choose another model\.$/,
      );
      expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
      expect(useHomeComposerStore.getState().text).toBe('build a thing');
    },
  );

  it('names a refusal reason only when cached facts still establish it', async () => {
    seedStarterHydration('git-ready');
    jest.mocked(cachedHomeModelRefusal).mockReturnValueOnce({
      ok: false,
      reason: 'org-policy',
      modelLabel: 'Opus',
    });
    jest
      .mocked(useChatStore.getState().setModelAndWait)
      .mockResolvedValue(false);
    draftNewWorktreeSend();

    await dispatchHomeSend();

    expect(tabIn('tab-1')?.provisionalFirstSend?.failure?.message).toBe(
      'Opus is blocked by your organization’s model policy. Choose another model.',
    );
  });

  it('withdraws the echo and its title when unrelated preparation fails, keeping the draft', async () => {
    seedStarterHydration('git-ready');
    jest
      .mocked(useChatStore.getState().ensureSelectedWorktreeTabsLoaded)
      .mockResolvedValue(false);
    draftNewWorktreeSend();

    await expect(dispatchHomeSend()).resolves.toBe(false);

    const tab = tabIn('tab-1');
    expect(tab?.messages).toEqual([]);
    expect(tab?.pendingTurn).toBeUndefined();
    expect(tab?.provisionalFirstSend).toBeUndefined();
    expect(tab?.title).toBe('New Chat');
    expect(useHomeComposerStore.getState().text).toBe('build a thing');
    expect(useHomeComposerStore.getState().sendErrorChooseModel).toBeNull();
  });

  it('retries the same message exactly once in the failed chat without creating anything', async () => {
    seedStarterHydration('git-ready');
    const setModelAndWait = jest.mocked(
      useChatStore.getState().setModelAndWait,
    );
    setModelAndWait.mockResolvedValueOnce(false);
    draftNewWorktreeSend();
    await dispatchHomeSend();
    const failed = tabIn('tab-1')?.provisionalFirstSend;

    const first = retryFailedFirstSend(failedTarget);
    const second = retryFailedFirstSend(failedTarget);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);

    expect(useProjectsStore.getState().createWorktree).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().navigate).toHaveBeenCalledTimes(1);
    expect(setModelAndWait).toHaveBeenCalledTimes(2);
    expect(setModelAndWait.mock.calls[1]?.[0]).toBe(
      setModelAndWait.mock.calls[0]?.[0],
    );
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'build a thing',
      undefined,
      failedTarget,
      undefined,
      expect.objectContaining({
        userMessageId: failed?.userMessageId,
        submittedAt: failed?.submittedAt,
      }),
    );
    // The prompt never left the transcript, and the send consumed the draft.
    expect(userTexts(tabIn('tab-1'))).toEqual(['build a thing']);
    expect(tabIn('tab-1')?.provisionalFirstSend?.userMessageId).toBe(
      failed?.userMessageId,
    );
    expect(useHomeComposerStore.getState().text).toBe('');
  });

  it.each(['preflight', 'model'] as const)(
    'does not send or mutate a retry whose target closes during %s',
    async (stage) => {
      seedStarterHydration('git-ready');
      const apply = jest.mocked(useChatStore.getState().setModelAndWait);
      apply.mockResolvedValueOnce(false);
      draftNewWorktreeSend();
      await dispatchHomeSend();
      let release = (): void => {
        throw new Error('Gate not reached');
      };
      const gate = new Promise<boolean>((resolve) => {
        release = (): void => resolve(true);
      });
      if (stage === 'preflight') {
        jest.mocked(preflightHomeModel).mockImplementationOnce(async () => {
          await gate;
          return { ok: true };
        });
      } else {
        apply.mockImplementationOnce(() => gate);
      }
      const retry = retryFailedFirstSend(failedTarget);
      await new Promise((resolve) => setTimeout(resolve, 0));
      useChatStore.setState({ worktreeChats: {} });
      release();
      await expect(retry).resolves.toBe(false);
      expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
      expect(useHomeComposerStore.getState().sendError).toMatch(
        /couldn’t be used to start this chat/,
      );
      if (stage === 'preflight') expect(apply).toHaveBeenCalledTimes(1);
    },
  );

  it('does not claim a retry while a picker selection is pending', async () => {
    seedStarterHydration('git-ready');
    jest
      .mocked(useChatStore.getState().setModelAndWait)
      .mockResolvedValueOnce(false);
    draftNewWorktreeSend();
    await dispatchHomeSend();
    useChatStore.setState({
      pendingModelChanges: {
        'ws-1/wt-1/tab-1': {
          requestId: 'picker-request',
          model: DEFAULT_CODEX_MODEL,
        },
      },
    });
    try {
      await expect(retryFailedFirstSend(failedTarget)).resolves.toBe(false);
      expect(tabIn('tab-1')?.provisionalFirstSend?.phase).toBe('failed');
      expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
    } finally {
      useChatStore.setState({ pendingModelChanges: {} });
    }
  });

  it('uses an accepted same-model harness change for recovery', async () => {
    seedStarterHydration('git-ready');
    jest
      .mocked(useChatStore.getState().setModelAndWait)
      .mockResolvedValueOnce(false);
    draftNewWorktreeSend();
    await dispatchHomeSend();
    const scope = useChatStore.getState().worktreeChats['ws-1/wt-1'];
    if (!scope) throw new Error('Missing scope');
    useChatStore.setState({
      worktreeChats: {
        'ws-1/wt-1': {
          ...scope,
          tabs: scope.tabs.map((tab) => ({
            ...tab,
            executionHarness: 'codex',
          })),
        },
      },
    });
    await expect(retryFailedFirstSend(failedTarget)).resolves.toBe(true);
    expect(useChatStore.getState().setModelAndWait).toHaveBeenLastCalledWith(
      expect.any(String),
      failedTarget,
      'codex',
    );
  });

  it('uses an accepted recovery pick even when the tab already retained that model', async () => {
    seedStarterHydration('git-ready');
    const apply = jest.mocked(useChatStore.getState().setModelAndWait);
    const load = jest.mocked(useChatStore.getState().loadTabsForTarget);
    const hydrate = load.getMockImplementation();
    load.mockImplementation(async (...args) => {
      await hydrate?.(...args);
      setTabModel('tab-1', DEFAULT_CODEX_MODEL);
    });
    apply.mockResolvedValueOnce(false);
    draftNewWorktreeSend();
    await dispatchHomeSend();
    const failure = tabIn('tab-1')?.provisionalFirstSend?.failure;
    if (!failure) throw new Error('Missing failed send');
    // Mirror the model setter's accepted intent, even for a same-value pick.
    Object.assign(failure, { recoveryModelSelectionAccepted: true });

    await expect(retryFailedFirstSend(failedTarget)).resolves.toBe(true);

    expect(apply).toHaveBeenLastCalledWith(DEFAULT_CODEX_MODEL, failedTarget);
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not retry across an account change during eligibility reads', async () => {
    seedStarterHydration('git-ready');
    jest
      .mocked(useChatStore.getState().setModelAndWait)
      .mockResolvedValueOnce(false);
    draftNewWorktreeSend();
    await dispatchHomeSend();
    const { useWorkspaceContextStore } =
      await import('@/stores/workspaceContextStore');
    const epoch = useWorkspaceContextStore.getState().accountEpoch;
    jest.mocked(preflightHomeModel).mockImplementationOnce(() => {
      useWorkspaceContextStore.setState({ accountEpoch: epoch + 1 });
      return Promise.resolve({ ok: true });
    });
    try {
      await expect(retryFailedFirstSend(failedTarget)).resolves.toBe(false);
      expect(useChatStore.getState().setModelAndWait).toHaveBeenCalledTimes(1);
      expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
    } finally {
      useWorkspaceContextStore.setState({ accountEpoch: epoch });
    }
  });

  it('retains attachment contexts and mentions through retry without importing them twice', async () => {
    seedStarterHydration('git-ready');
    jest
      .mocked(useChatStore.getState().setModelAndWait)
      .mockResolvedValueOnce(false);
    const attachment = makeAttachment({ promptKind: 'linear-ticket' });
    const imported = {
      ...attachment,
      absolutePath: '/tmp/ws-1/attachments/wt-1/ticket.md',
    };
    importChatAttachmentsMock.mockResolvedValue([imported]);
    jest
      .mocked(useFileListStore.getState().fetchFileIndex)
      .mockResolvedValue(undefined);
    const references: FileReference[] = [
      { displayPath: 'readme.md', absolutePath: '/tmp/readme.md' },
    ];
    draftNewWorktreeSend('Review readme.md');
    useHomeComposerStore.setState({
      attachments: [attachment],
      fileReferences: references,
    });
    await dispatchHomeSend();
    const failed = tabIn('tab-1')?.provisionalFirstSend;
    await expect(retryFailedFirstSend(failedTarget)).resolves.toBe(true);
    expect(importChatAttachmentsMock).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'Review readme.md',
      references,
      failedTarget,
      undefined,
      expect.objectContaining({
        userMessageId: failed?.userMessageId,
        submittedAt: failed?.submittedAt,
        attachmentPaths: [imported.absolutePath],
        attachmentPromptContexts: [
          {
            attachmentPath: imported.absolutePath,
            promptKind: 'linear-ticket',
          },
        ],
      }),
    );
  });

  it('does not turn a superseded model completion into a user-facing refusal', async () => {
    seedStarterHydration('git-ready');
    jest
      .mocked(useChatStore.getState().setModelAndWait)
      .mockImplementationOnce(() =>
        Promise.resolve().then(() => {
          useChatStore.setState({
            pendingModelChanges: {
              'ws-1/wt-1/tab-1': {
                requestId: 'newer-selection',
                model: DEFAULT_CODEX_MODEL,
              },
            },
          });
          return false;
        }),
      );
    draftNewWorktreeSend();
    try {
      await expect(dispatchHomeSend()).resolves.toBe(false);
      expect(tabIn('tab-1')?.provisionalFirstSend?.phase).toBe('preparing');
      expect(useHomeComposerStore.getState().sendError).toBeNull();
      expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
    } finally {
      useChatStore.setState({ pendingModelChanges: {} });
    }
  });

  it('stops settings writes when retry preparation is replaced during an awaited setting', async () => {
    seedStarterHydration('git-ready');
    jest
      .mocked(useChatStore.getState().setModelAndWait)
      .mockResolvedValueOnce(false);
    draftNewWorktreeSend();
    useHomeComposerStore.setState({ planMode: true, approvalMode: 'auto' });
    await dispatchHomeSend();
    jest
      .mocked(useChatStore.getState().setThinkingLevel)
      .mockImplementationOnce(() => {
        const scope = useChatStore.getState().worktreeChats['ws-1/wt-1'];
        if (!scope) throw new Error('Missing scope');
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              ...scope,
              tabs: scope.tabs.map((tab) => ({
                ...tab,
                provisionalFirstSend: tab.provisionalFirstSend
                  ? {
                      ...tab.provisionalFirstSend,
                      userMessageId: 'replacement',
                    }
                  : undefined,
              })),
            },
          },
        });
        return Promise.resolve();
      });
    await expect(retryFailedFirstSend(failedTarget)).resolves.toBe(false);
    expect(useChatStore.getState().togglePlanMode).not.toHaveBeenCalled();
    expect(useChatStore.getState().setTabApprovalMode).not.toHaveBeenCalled();
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
  });

  it('returns a repeated refusal to the failed state in place', async () => {
    seedStarterHydration('git-ready');
    const setModelAndWait = jest.mocked(
      useChatStore.getState().setModelAndWait,
    );
    setModelAndWait.mockResolvedValue(false);
    draftNewWorktreeSend();
    await dispatchHomeSend();
    const firstFailure = tabIn('tab-1')?.provisionalFirstSend?.failure;

    await expect(retryFailedFirstSend(failedTarget)).resolves.toBe(false);

    const record = tabIn('tab-1')?.provisionalFirstSend;
    expect(record?.phase).toBe('failed');
    expect(record?.failure?.failureId).not.toBe(firstFailure?.failureId);
    expect(userTexts(tabIn('tab-1'))).toEqual(['build a thing']);
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();

    setModelAndWait.mockResolvedValue(true);
    await expect(retryFailedFirstSend(failedTarget)).resolves.toBe(true);
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses a retry the eligibility recheck establishes, before applying the model', async () => {
    seedStarterHydration('git-ready');
    const setModelAndWait = jest.mocked(
      useChatStore.getState().setModelAndWait,
    );
    setModelAndWait.mockResolvedValueOnce(false);
    draftNewWorktreeSend();
    await dispatchHomeSend();
    jest.mocked(preflightHomeModel).mockResolvedValueOnce({
      ok: false,
      reason: 'needs-purchase',
      modelLabel: 'Opus',
    });

    await expect(retryFailedFirstSend(failedTarget)).resolves.toBe(false);

    expect(setModelAndWait).toHaveBeenCalledTimes(1);
    expect(tabIn('tab-1')?.provisionalFirstSend?.failure?.message).toBe(
      'Opus isn’t included in your AI Credits yet. Choose another model.',
    );
  });

  it('retries with a model accepted in the failed chat; the selection alone sends nothing', async () => {
    seedStarterHydration('git-ready');
    const setModelAndWait = jest.mocked(
      useChatStore.getState().setModelAndWait,
    );
    setModelAndWait.mockResolvedValueOnce(false);
    draftNewWorktreeSend();
    await dispatchHomeSend();

    setTabModel('tab-1', DEFAULT_CODEX_MODEL);
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
    await expect(retryFailedFirstSend(failedTarget)).resolves.toBe(true);

    expect(setModelAndWait).toHaveBeenLastCalledWith(
      DEFAULT_CODEX_MODEL,
      failedTarget,
    );
    // Home's thinking level belongs to the submitted model, not the
    // replacement its own picker configured.
    expect(useChatStore.getState().setThinkingLevel).not.toHaveBeenCalled();
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledTimes(1);
  });

  it('explains a refusal inline, without a toast, while the failed chat is in view', async () => {
    seedStarterHydration('git-ready');
    const addToast = jest.fn();
    useGitHubStore.setState({ addToast });
    jest
      .mocked(useChatStore.getState().setModelAndWait)
      .mockImplementation((): Promise<boolean> => {
        useNavigationStore.setState({ activePage: 'main' });
        useChatStore.setState({
          selectedWorktree: { projectId: 'ws-1', worktreeId: 'wt-1' },
        });
        return Promise.resolve(false);
      });
    draftNewWorktreeSend();

    try {
      await dispatchHomeSend();
      expect(addToast).not.toHaveBeenCalled();
      expect(tabIn('tab-1')?.provisionalFirstSend?.phase).toBe('failed');
    } finally {
      useNavigationStore.setState({ activePage: 'home' });
    }
  });

  it('leads back with a toast when the user left the failed chat', async () => {
    seedStarterHydration('git-ready');
    const addToast = jest.fn<
      void,
      [string, string, unknown, { action?: { label: string } }?]
    >();
    useGitHubStore.setState({ addToast });
    jest
      .mocked(useChatStore.getState().setModelAndWait)
      .mockImplementation((): Promise<boolean> => {
        useNavigationStore.setState({ activePage: 'main' });
        useChatStore.setState({
          selectedWorktree: { projectId: 'ws-1', worktreeId: 'wt-other' },
        });
        return Promise.resolve(false);
      });
    draftNewWorktreeSend();

    try {
      await dispatchHomeSend();
      const [message, kind, , options] = addToast.mock.calls[0] ?? [];
      expect(message).toMatch(/couldn’t be used to start this chat/);
      expect(kind).toBe('error');
      expect(options?.action?.label).toBe('Open draft');
      // Home recovery is not given focus while the user is elsewhere.
      expect(useHomeComposerStore.getState().sendErrorChooseModel?.focus).toBe(
        false,
      );
    } finally {
      useNavigationStore.setState({ activePage: 'home' });
    }
  });

  it('never attaches an old refusal to a newer Home draft', async () => {
    seedStarterHydration('git-ready');
    jest
      .mocked(useChatStore.getState().setModelAndWait)
      .mockImplementation((): Promise<boolean> => {
        useHomeComposerStore.setState({ text: 'a newer draft' });
        return Promise.resolve(false);
      });
    draftNewWorktreeSend();

    await dispatchHomeSend();

    const home = useHomeComposerStore.getState();
    expect(home.text).toBe('a newer draft');
    expect(home.sendError).toBeNull();
    expect(home.sendErrorChooseModel).toBeNull();
    expect(tabIn('tab-1')?.provisionalFirstSend?.phase).toBe('failed');
  });

  it('keeps the presented chat as the target when the user switches tabs', async () => {
    seedStarterHydration('git-ready');
    jest
      .mocked(useChatStore.getState().loadAllWorktreeTabs)
      .mockImplementation((): Promise<void> => {
        const scope = useChatStore.getState().worktreeChats['ws-1/wt-1'];
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              tabs: [...(scope?.tabs ?? []), starter('tab-2')],
              activeTabId: 'tab-2',
            },
          },
        });
        return Promise.resolve();
      });
    draftNewWorktreeSend();

    await expect(dispatchHomeSend()).resolves.toBe(true);

    expect(
      jest.mocked(useChatStore.getState().sendMessage).mock.calls[0]?.[2],
    ).toEqual({ projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' });
    expect(userTexts(tabIn('tab-2'))).toEqual([]);
  });

  it('moves the same submission to a starter the refresh replaced', async () => {
    seedStarterHydration('git-ready', true);
    let presentedId: string | undefined;
    jest
      .mocked(useChatStore.getState().loadAllWorktreeTabs)
      .mockImplementation((): Promise<void> => {
        presentedId = tabIn('tab-1')?.provisionalFirstSend?.userMessageId;
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': { tabs: [starter('tab-2')], activeTabId: 'tab-2' },
          },
        });
        return Promise.resolve();
      });
    draftNewWorktreeSend();

    await expect(dispatchHomeSend()).resolves.toBe(true);

    expect(presentedId).toBeDefined();
    expect(tabIn('tab-2')?.provisionalFirstSend?.userMessageId).toBe(
      presentedId,
    );
    expect(userTexts(tabIn('tab-2'))).toEqual(['build a thing']);
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'build a thing',
      undefined,
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-2' },
      undefined,
      expect.objectContaining({ userMessageId: presentedId }),
    );
  });

  it.each([
    ['an intact starter', false, 'tab-1'],
    ['a replaced starter', true, 'tab-2'],
  ] as const)(
    'keeps a file tab selected after navigation with %s',
    async (_label, replaced, expectedChatId) => {
      seedStarterHydration('git-ready', replaced);
      const fileTab: ChatTab = {
        ...createEmptyTab(),
        id: 'file-1',
        kind: 'file',
        filePath: '/workspace/notes.md',
      };
      jest
        .mocked(useChatStore.getState().loadAllWorktreeTabs)
        .mockImplementation((): Promise<void> => {
          const scope = useChatStore.getState().worktreeChats['ws-1/wt-1'];
          useChatStore.setState({
            worktreeChats: {
              'ws-1/wt-1': {
                tabs: [
                  ...(replaced ? [starter('tab-2')] : (scope?.tabs ?? [])),
                  fileTab,
                ],
                activeTabId: 'file-1',
              },
            },
          });
          return Promise.resolve();
        });
      draftNewWorktreeSend();

      await expect(dispatchHomeSend()).resolves.toBe(true);

      expect(
        jest.mocked(useChatStore.getState().ensureWorktreeHasChatTab).mock
          .calls[1]?.[1],
      ).toEqual({ preserveActiveTab: true });
      expect(
        jest.mocked(useChatStore.getState().sendMessage).mock.calls[0]?.[2],
      ).toEqual({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: expectedChatId,
      });
      expect(
        useChatStore.getState().worktreeChats['ws-1/wt-1']?.activeTabId,
      ).toBe('file-1');
    },
  );

  it('hands the echo to the renderer queue row it was queued as', async () => {
    seedStarterHydration('git-pending');
    draftNewWorktreeSend();
    jest
      .mocked(useChatStore.getState().sendMessage)
      .mockImplementation((_text, _refs, _target, _mode, options) => {
        options?.onQueuedWithoutDispatch?.('renderer');
        return Promise.resolve();
      });

    await expect(dispatchHomeSend()).resolves.toBe(true);

    const tab = tabIn('tab-1');
    expect(tab?.provisionalFirstSend?.phase).toBe('queued');
    expect(userTexts(tab)).toEqual([]);
    expect(tab?.pendingTurn).toBeUndefined();
    expect(tab?.title).toBe('build a thing');
  });

  it('withdraws the echo when the send is refused before dispatch', async () => {
    seedStarterHydration('git-ready');
    draftNewWorktreeSend();
    jest
      .mocked(useChatStore.getState().sendMessage)
      .mockImplementation((_text, _refs, _target, _mode, options) => {
        options?.onPreDispatchRejected?.();
        return Promise.resolve();
      });

    await expect(dispatchHomeSend()).resolves.toBe(false);

    expect(tabIn('tab-1')?.messages).toEqual([]);
    expect(tabIn('tab-1')?.title).toBe('New Chat');
    expect(useHomeComposerStore.getState().text).toBe('build a thing');
  });

  it('restores the Home draft for a confirmed rejection after native adoption', async () => {
    seedStarterHydration('git-ready');
    draftNewWorktreeSend();
    jest
      .mocked(useChatStore.getState().sendMessage)
      .mockImplementation((_text, _refs, _target, _mode, options) => {
        const scope = useChatStore.getState().worktreeChats['ws-1/wt-1'];
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              ...scope,
              tabs: scope.tabs.map((tab) => ({
                ...tab,
                provisionalFirstSend: tab.provisionalFirstSend
                  ? { ...tab.provisionalFirstSend, phase: 'dispatched' }
                  : undefined,
              })),
            },
          },
        });
        options?.onPreDispatchRejected?.();
        return Promise.resolve();
      });
    await expect(dispatchHomeSend()).resolves.toBe(false);
    expect(useHomeComposerStore.getState().text).toBe('build a thing');
    expect(useHomeComposerStore.getState().sendErrorRetryable).toBe(true);
  });

  it('does not recreate a starter deleted during the post-navigation refresh', async () => {
    seedStarterHydration('git-ready');
    draftNewWorktreeSend();
    jest
      .mocked(useChatStore.getState().loadAllWorktreeTabs)
      .mockImplementation((): Promise<void> => {
        useChatStore.setState({
          worktreeChats: { 'ws-1/wt-1': { tabs: [], activeTabId: '' } },
        });
        return Promise.resolve();
      });
    await expect(dispatchHomeSend()).resolves.toBe(false);
    expect(
      useChatStore.getState().ensureWorktreeHasChatTab,
    ).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
  });

  it('does not redirect a deleted canonical starter to another tab', async () => {
    seedStarterHydration('git-ready');
    draftNewWorktreeSend();
    jest
      .mocked(useChatStore.getState().loadAllWorktreeTabs)
      .mockImplementation((): Promise<void> => {
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              tabs: [starter('unrelated')],
              activeTabId: 'unrelated',
            },
          },
        });
        return Promise.resolve();
      });
    await expect(dispatchHomeSend()).resolves.toBe(false);
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
    expect(userTexts(tabIn('unrelated'))).toEqual([]);
  });

  it('recovers the submitted draft when a host rejection arrives after Home reset', async () => {
    seedStarterHydration('git-ready');
    draftNewWorktreeSend();
    let reject: (() => void) | undefined;
    jest
      .mocked(useChatStore.getState().sendMessage)
      .mockImplementation(
        (_text, _refs, _target, _mode, options): Promise<void> => {
          reject = options?.onDispatchRejected;
          return Promise.resolve();
        },
      );
    await expect(dispatchHomeSend()).resolves.toBe(true);
    expect(useHomeComposerStore.getState().text).toBe('');
    reject?.();
    expect(useHomeComposerStore.getState().text).toBe('build a thing');
    expect(useHomeComposerStore.getState().sendErrorRetryable).toBe(true);
  });

  it('creates submission identity before prompt expansion yields', async () => {
    seedStarterHydration('git-ready');
    draftNewWorktreeSend();
    let release: (() => void) | undefined;
    const expansion = jest
      .spyOn(promptMentionExpansion, 'expandPromptMentions')
      .mockImplementationOnce(async (_workspace, text, refs) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { text, fileReferences: [...refs] };
      });
    const before = Date.now();
    const sending = dispatchHomeSend();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const resumedAt = before + 1000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(resumedAt);
    release?.();
    try {
      await sending;
      expect(tabIn('tab-1')?.provisionalFirstSend?.submittedAt).toBeLessThan(
        resumedAt,
      );
    } finally {
      now.mockRestore();
      expansion.mockRestore();
    }
  });

  it('waits for the cold transcript chunk before revealing an existing worktree first send', async () => {
    const chunkLoader = jest.requireMock<{
      loadChatMessageListModule: jest.Mock;
    }>('@/components/chat/chatMessageListChunk').loadChatMessageListModule;
    let releaseChunk: () => void = () => {};
    const chunk = new Promise<void>((resolve) => {
      releaseChunk = resolve;
    });
    chunkLoader.mockImplementationOnce(() => chunk);
    let created: () => void = () => {};
    const tabCreated = new Promise<void>((resolve) => {
      created = resolve;
    });
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
      ],
    });
    jest
      .mocked(useChatStore.getState().createTab)
      .mockImplementation((): void => {
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': { tabs: [starter()], activeTabId: 'tab-1' },
          },
        });
        created();
      });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'fix the bug',
    });
    const sending = dispatchHomeSend();
    await tabCreated;
    const navigatedWhileCold = jest.mocked(
      useNavigationStore.getState().navigate,
    ).mock.calls.length;
    const selectedWhileCold = jest.mocked(
      useChatStore.getState().selectWorktree,
    ).mock.calls.length;
    releaseChunk();
    await expect(sending).resolves.toBe(true);
    expect(navigatedWhileCold).toBe(0);
    expect(selectedWhileCold).toBe(0);
    expect(userTexts(tabIn('tab-1'))).toEqual(['fix the bug']);
    expect(useNavigationStore.getState().navigate).toHaveBeenCalledWith('main');
  });

  it('shows the question in an existing worktree chat right after creating it', async () => {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
      ],
    });
    jest
      .mocked(useChatStore.getState().createTab)
      .mockImplementation((): void => {
        callOrder.push('createTab');
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': { tabs: [starter()], activeTabId: 'tab-1' },
          },
        });
      });
    let textsAtNavigation: string[] = [];
    jest
      .mocked(useNavigationStore.getState().navigate)
      .mockImplementation((): void => {
        textsAtNavigation = userTexts(tabIn('tab-1'));
      });
    let textsAtEnsure: string[] = [];
    jest
      .mocked(useChatStore.getState().ensureWorktreeHasChatTab)
      .mockImplementation((): Promise<void> => {
        textsAtEnsure = userTexts(tabIn('tab-1'));
        return Promise.resolve();
      });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'fix the bug',
    });

    await expect(dispatchHomeSend()).resolves.toBe(true);

    expect(textsAtNavigation).toEqual(['fix the bug']);
    expect(textsAtEnsure).toEqual(['fix the bug']);
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'fix the bug',
      undefined,
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
      undefined,
      expect.objectContaining({
        userMessageId: tabIn('tab-1')?.provisionalFirstSend?.userMessageId,
      }),
    );
  });

  it('presents nothing for a scheduled send', async () => {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
      ],
    });
    jest
      .mocked(useChatStore.getState().createTab)
      .mockImplementation((): void => {
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': { tabs: [starter()], activeTabId: 'tab-1' },
          },
        });
      });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'later',
      scheduledSendDraft: { runAt: '2030-01-01T00:00:00.000Z' },
    });

    await dispatchHomeSend();

    expect(tabIn('tab-1')?.provisionalFirstSend).toBeUndefined();
    expect(tabIn('tab-1')?.messages).toEqual([]);
  });
});

describe('dispatchHomeSend Task F3: shadow-backed @ mention rewrite (new-worktree / branch)', () => {
  it('rewrites a shadow-backed FileReference onto the created worktree cwd before sending (shadow path in → target path dispatched)', async () => {
    seedLoadTabsForTarget('git-ready');

    const fetchFileIndex = jest.fn((projectId: string, worktreeId: string) => {
      useFileListStore.setState((state) => ({
        indexCache: {
          ...state.indexCache,
          [getWorktreeCacheKey(projectId, worktreeId)]: {
            data: {
              repos: [
                makeRepoFileIndex({
                  repoId: 'app',
                  absolutePath: '/workspaces/ws-1/worktrees/wt-1',
                }),
              ],
            },
            fetchedAt: Date.now(),
          },
        },
      }));
      return Promise.resolve();
    });
    useFileListStore.setState({ fetchFileIndex });

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'see src/main.ts',
      fileIndex: [makeRepoFileIndex()],
      fileReferences: [makeFileReference()],
    });

    await dispatchHomeSend();

    expect(fetchFileIndex).toHaveBeenCalledWith('ws-1', 'wt-1');
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'see src/main.ts',
      [
        makeFileReference({
          absolutePath: '/workspaces/ws-1/worktrees/wt-1/src/main.ts',
        }),
      ],
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
      undefined,
      expect.objectContaining({
        attachmentPaths: undefined,
        attachmentPromptContexts: undefined,
      }),
    );
  });

  it('rewrites for a branch-kind target too', async () => {
    seedLoadTabsForTarget(undefined);
    const fetchFileIndex = jest.fn((projectId: string, worktreeId: string) => {
      useFileListStore.setState((state) => ({
        indexCache: {
          ...state.indexCache,
          [getWorktreeCacheKey(projectId, worktreeId)]: {
            data: {
              repos: [
                makeRepoFileIndex({
                  repoId: 'app',
                  absolutePath: '/workspaces/ws-1/worktrees/wt-1',
                }),
              ],
            },
            fetchedAt: Date.now(),
          },
        },
      }));
      return Promise.resolve();
    });
    useFileListStore.setState({ fetchFileIndex });

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: {
        kind: 'branch',
        branchName: 'feature/foo',
        isRemote: true,
      },
      text: 'see src/main.ts',
      fileIndex: [makeRepoFileIndex()],
      fileReferences: [makeFileReference()],
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'see src/main.ts',
      [
        makeFileReference({
          absolutePath: '/workspaces/ws-1/worktrees/wt-1/src/main.ts',
        }),
      ],
      expect.anything(),
      undefined,
      expect.anything(),
    );
  });

  it('leaves a reference outside the shadow root (e.g. a staged attachment) unchanged', async () => {
    seedLoadTabsForTarget('git-ready');
    const fetchFileIndex = jest.fn((projectId: string, worktreeId: string) => {
      useFileListStore.setState((state) => ({
        indexCache: {
          ...state.indexCache,
          [getWorktreeCacheKey(projectId, worktreeId)]: {
            data: {
              repos: [
                makeRepoFileIndex({
                  repoId: 'app',
                  absolutePath: '/workspaces/ws-1/worktrees/wt-1',
                }),
              ],
            },
            fetchedAt: Date.now(),
          },
        },
      }));
      return Promise.resolve();
    });
    useFileListStore.setState({ fetchFileIndex });

    const outsideRef = makeFileReference({
      displayPath: '/tmp/attachments/pasted.png',
      absolutePath: '/tmp/attachments/pasted.png',
    });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'see pasted.png',
      fileIndex: [makeRepoFileIndex()],
      fileReferences: [outsideRef],
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'see pasted.png',
      [outsideRef],
      expect.anything(),
      undefined,
      expect.anything(),
    );
  });

  it('does not call fetchFileIndex when the draft has no file references (pure pass-through)', async () => {
    seedLoadTabsForTarget('git-ready');
    const fetchFileIndex = jest.fn(() => Promise.resolve());
    useFileListStore.setState({ fetchFileIndex });

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'build a thing',
    });

    await dispatchHomeSend();

    expect(fetchFileIndex).not.toHaveBeenCalled();
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'build a thing',
      undefined,
      expect.anything(),
      undefined,
      expect.anything(),
    );
  });

  it('rewrites even when the draft fileIndex never loaded — stale-root recovery does not depend on knowing the original root (fix round 1)', async () => {
    seedLoadTabsForTarget('git-ready');
    const fetchFileIndex = seedTargetIndexFetch(
      '/workspaces/ws-1/worktrees/wt-1',
    );

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'see src/main.ts',
      fileIndex: null,
      fileReferences: [makeFileReference()],
    });

    await dispatchHomeSend();

    expect(fetchFileIndex).toHaveBeenCalledWith('ws-1', 'wt-1');
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'see src/main.ts',
      [
        makeFileReference({
          absolutePath: '/workspaces/ws-1/worktrees/wt-1/src/main.ts',
        }),
      ],
      expect.anything(),
      undefined,
      expect.anything(),
    );
  });
});

describe('dispatchHomeSend multi-repo working directory', () => {
  it('pins the draft selectedRepoId onto the created tab on the existing-worktree route, before sending', async () => {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
      ],
    });
    jest
      .mocked(useChatStore.getState().createTab)
      .mockImplementation((): void => {
        callOrder.push('createTab');
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              tabs: [{ ...createEmptyTab(), id: 'tab-1' }],
              activeTabId: 'tab-1',
            },
          },
        });
      });

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      selectedRepoId: 'web',
      text: 'fix the bug',
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().setSelectedRepoId).toHaveBeenCalledWith(
      'web',
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
    );
    expect(callOrder).toEqual([
      'createTab',
      'selectWorktree',
      'navigate',
      'ensureWorktreeHasChatTab',
      'setSelectedRepoId',
      'sendMessage',
    ]);
  });

  it('pins the draft selectedRepoId onto the created tab on the new-worktree route, before sending', async () => {
    seedLoadTabsForTarget('git-ready');

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      selectedRepoId: 'web',
      text: 'fix the bug',
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().setSelectedRepoId).toHaveBeenCalledWith(
      'web',
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
    );
    expect(callOrder).toEqual([
      'deselectWorktree',
      'createWorktree',
      'loadTabsForTarget',
      'ensureWorktreeHasChatTab',
      'selectWorktree',
      'navigate',
      'loadAllWorktreeTabs',
      'ensureWorktreeHasChatTab',
      'setModel',
      'setThinkingLevel',
      'setSelectedRepoId',
      'sendMessage',
    ]);
  });

  it('never touches the tab working directory when the draft has no repo selection', async () => {
    seedLoadTabsForTarget('git-ready');

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'fix the bug',
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().setSelectedRepoId).not.toHaveBeenCalled();
  });

  it('re-roots multi-root shadow pills by repoId and scopes the target cwd to the selected repo', async () => {
    seedLoadTabsForTarget('git-ready');

    // Target worktree index: workspace root + child repo checkouts.
    const fetchFileIndex = jest.fn((projectId: string, worktreeId: string) => {
      useFileListStore.setState((state) => ({
        indexCache: {
          ...state.indexCache,
          [getWorktreeCacheKey(projectId, worktreeId)]: {
            data: {
              repos: [
                makeRepoFileIndex({
                  repoId: '__workspace_root__',
                  rootKind: 'workspace-root',
                  absolutePath: '/workspaces/ws-1/worktrees/wt-1',
                }),
                makeRepoFileIndex({
                  repoId: 'web',
                  repoName: 'web',
                  absolutePath: '/workspaces/ws-1/worktrees/wt-1/repos/web',
                }),
              ],
            },
            fetchedAt: Date.now(),
          },
        },
      }));
      return Promise.resolve();
    });
    useFileListStore.setState({ fetchFileIndex });

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      selectedRepoId: 'web',
      text: 'see web/src/main.ts',
      // Draft-time multi-root baseline index: root shadow + child shadow.
      fileIndex: [
        makeRepoFileIndex({
          repoId: '__workspace_root__',
          rootKind: 'workspace-root',
          absolutePath: '/shadows/src/checkout',
        }),
        makeRepoFileIndex({
          repoId: 'web',
          repoName: 'web',
          absolutePath: '/shadows/web/checkout',
        }),
      ],
      // Multi-root pills carry repoName, which the suffix-based rewrite
      // passes through — only the repoId-keyed pass can re-root this one.
      fileReferences: [
        makeFileReference({
          displayPath: 'web/src/main.ts',
          absolutePath: '/shadows/web/checkout/src/main.ts',
          repoName: 'web',
        }),
      ],
    });

    await dispatchHomeSend();

    // Child-repo scope: the chat cwd IS the child repo, so both the pill and
    // the prompt text collapse to repo-relative paths — exactly what typing
    // the same mention into that repo-scoped worktree composer would send.
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'see src/main.ts',
      [
        makeFileReference({
          displayPath: 'src/main.ts',
          absolutePath: '/workspaces/ws-1/worktrees/wt-1/repos/web/src/main.ts',
          repoName: 'web',
        }),
      ],
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
      undefined,
      expect.objectContaining({
        attachmentPaths: undefined,
        attachmentPromptContexts: undefined,
      }),
    );
  });

  it('root scope: child-repo mentions gain the repos/ prefix in the dispatched text, matching the worktree composer', async () => {
    seedLoadTabsForTarget('git-ready');

    const fetchFileIndex = jest.fn((projectId: string, worktreeId: string) => {
      useFileListStore.setState((state) => ({
        indexCache: {
          ...state.indexCache,
          [getWorktreeCacheKey(projectId, worktreeId)]: {
            data: {
              repos: [
                makeRepoFileIndex({
                  repoId: '__workspace_root__',
                  rootKind: 'workspace-root',
                  absolutePath: '/workspaces/ws-1/worktrees/wt-1',
                }),
                makeRepoFileIndex({
                  repoId: 'web',
                  repoName: 'web',
                  absolutePath: '/workspaces/ws-1/worktrees/wt-1/repos/web',
                }),
              ],
            },
            fetchedAt: Date.now(),
          },
        },
      }));
      return Promise.resolve();
    });
    useFileListStore.setState({ fetchFileIndex });

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      // Workspace-root working directory (no repo selection).
      text: 'see web/src/main.ts',
      fileIndex: [
        makeRepoFileIndex({
          repoId: '__workspace_root__',
          rootKind: 'workspace-root',
          absolutePath: '/shadows/src/checkout',
        }),
        makeRepoFileIndex({
          repoId: 'web',
          repoName: 'web',
          absolutePath: '/shadows/web/checkout',
        }),
      ],
      fileReferences: [
        makeFileReference({
          displayPath: 'web/src/main.ts',
          absolutePath: '/shadows/web/checkout/src/main.ts',
          repoName: 'web',
        }),
      ],
    });

    await dispatchHomeSend();

    // Root scope: the chat cwd is the workspace root, where child repos live
    // under `repos/` — the agent-facing text must use that resolvable path,
    // not the picker's repoName-prefixed display text.
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'see repos/web/src/main.ts',
      [
        makeFileReference({
          displayPath: 'repos/web/src/main.ts',
          absolutePath: '/workspaces/ws-1/worktrees/wt-1/repos/web/src/main.ts',
          repoName: 'web',
        }),
      ],
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
      undefined,
      expect.objectContaining({
        attachmentPaths: undefined,
        attachmentPromptContexts: undefined,
      }),
    );
  });
});

describe('dispatchHomeSend fix round 1: stale pills after a branch-target/workspace switch', () => {
  function seedExistingWorktreeTab(): void {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
      ],
    });
    jest
      .mocked(useChatStore.getState().createTab)
      .mockImplementation((): void => {
        callOrder.push('createTab');
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              tabs: [{ ...createEmptyTab(), id: 'tab-1' }],
              activeTabId: 'tab-1',
            },
          },
        });
      });
  }

  it('DEEP PIN: a pill picked under the new-worktree (shadow) target, then switched to an existing worktree, dispatches under the worktree cwd', async () => {
    seedExistingWorktreeTab();
    const fetchFileIndex = seedTargetIndexFetch(
      '/workspaces/ws-1/worktrees/wt-1',
    );

    // The pill was inserted while branchTarget was `new-worktree`
    // (absolutePath in the repo shadow); the user then switched the branch
    // picker to the existing worktree `wt-1` before sending.
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'see src/main.ts',
      fileReferences: [makeFileReference()],
    });

    await dispatchHomeSend();

    expect(fetchFileIndex).toHaveBeenCalledWith('ws-1', 'wt-1');
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'see src/main.ts',
      [
        makeFileReference({
          absolutePath: '/workspaces/ws-1/worktrees/wt-1/src/main.ts',
        }),
      ],
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
      undefined,
      expect.anything(),
    );
  });

  it('leaves a pill already under the target worktree cwd unchanged on the existing-worktree route', async () => {
    seedExistingWorktreeTab();
    seedTargetIndexFetch('/workspaces/ws-1/worktrees/wt-1');

    const freshRef = makeFileReference({
      absolutePath: '/workspaces/ws-1/worktrees/wt-1/src/main.ts',
    });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'see src/main.ts',
      fileReferences: [freshRef],
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      'see src/main.ts',
      [freshRef],
      expect.anything(),
      undefined,
      expect.anything(),
    );
  });

  it('carries the rewritten references on the scheduled existing-worktree route too', async () => {
    seedExistingWorktreeTab();
    seedTargetIndexFetch('/workspaces/ws-1/worktrees/wt-1');

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'see src/main.ts',
      fileReferences: [makeFileReference()],
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });

    await dispatchHomeSend();

    expect(useAutomationsStore.getState().createActivity).toHaveBeenCalledWith({
      name: 'Scheduled message',
      schedule: {
        kind: 'one_time',
        runAt: '2026-07-08T12:00:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'tab-1',
        prompt: 'see src/main.ts',
        fileReferences: [
          makeFileReference({
            absolutePath: '/workspaces/ws-1/worktrees/wt-1/src/main.ts',
          }),
        ],
        purpose: 'scheduled_send',
        workspaceName: 'ws-1',
        worktreeName: 'wt-1',
      },
    });
  });

  it('re-roots a stale pill from a previous project onto the cowork root on the cowork route', async () => {
    useProjectsStore.setState({ projects: [makeCoworkProject('cowork-1')] });
    installHomeGetCoworkRoot(
      jest.fn(() => Promise.resolve('/cowork/homes/cowork-1')),
    );

    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'see src/main.ts',
      fileReferences: [makeFileReference()],
    });

    await dispatchHomeSend();

    expect(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage,
    ).toHaveBeenCalledWith({
      chatProjectId: 'cowork-1',
      message: 'see src/main.ts',
      config: {
        model: DEFAULT_MODEL,
        // Round-2 finding 5: no draft model, so the effective default is
        // pinned for WYSIWYG but is NOT a user pick.
        modelExplicitlyChosen: false,
        thinkingLevel: 'high',
        pluginSelections: undefined,
        fileReferences: [
          makeFileReference({
            absolutePath: '/cowork/homes/cowork-1/src/main.ts',
          }),
        ],
        attachmentPaths: undefined,
        attachmentPromptContexts: undefined,
      },
    });
  });

  it('passes references through unchanged when the cowork-root IPC rejects', async () => {
    useProjectsStore.setState({ projects: [makeCoworkProject('cowork-1')] });
    installHomeGetCoworkRoot(jest.fn(() => Promise.reject(new Error('boom'))));

    const ref = makeFileReference();
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'see src/main.ts',
      fileReferences: [ref],
    });

    await dispatchHomeSend();

    expect(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage,
    ).toHaveBeenCalledWith({
      chatProjectId: 'cowork-1',
      message: 'see src/main.ts',
      config: {
        model: DEFAULT_MODEL,
        // Round-2 finding 5: no draft model, so the effective default is
        // pinned for WYSIWYG but is NOT a user pick.
        modelExplicitlyChosen: false,
        thinkingLevel: 'high',
        pluginSelections: undefined,
        fileReferences: [ref],
        attachmentPaths: undefined,
        attachmentPromptContexts: undefined,
      },
    });
  });
});

describe('dispatchHomeSend scheduled routing — cowork', () => {
  it('creates a deferred standalone_prompt automation, fires the toast, and resets — never creates a chat or navigates', async () => {
    useProjectsStore.setState({ projects: [makeCoworkProject('cowork-1')] });
    const model: ChatModel = 'claude-sonnet-4-5';

    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'build the thing',
      model,
      thinkingLevel: 'medium',
      pluginSelections: makePluginSelections({ collectionIds: ['c1'] }),
      approvalMode: 'full-access',
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });

    await dispatchHomeSend();

    expect(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage,
    ).not.toHaveBeenCalled();
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().setScheduledSendDraft,
    ).not.toHaveBeenCalled();
    expect(useChatStore.getState().flushWorktreeTabs).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().navigate).not.toHaveBeenCalled();

    expect(useAutomationsStore.getState().createActivity).toHaveBeenCalledWith({
      name: 'Scheduled message',
      schedule: {
        kind: 'one_time',
        runAt: '2026-07-08T12:00:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: 'build the thing',
        model,
        thinking: 'medium',
        approvalMode: 'full-access',
      },
    });

    expect(showAutomationCreatedToastMock).toHaveBeenCalledWith(
      makeActivity(),
      'cowork-1',
    );

    expect(callOrder).toEqual(['createActivity']);

    expect(useHomeComposerStore.getState().text).toBe('');
    expect(useHomeComposerStore.getState().workspaceId).toBeNull();
    expect(useHomeComposerStore.getState().isSending).toBe(false);
  });

  it('blocks scheduled cowork sends that still have staged attachments', async () => {
    useProjectsStore.setState({ projects: [makeCoworkProject('cowork-1')] });
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'build the thing',
      attachments: [makeAttachment()],
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });

    const sent = await dispatchHomeSend();

    expect(sent).toBe(false);
    expect(
      useAutomationsStore.getState().createActivity,
    ).not.toHaveBeenCalled();
    expect(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage,
    ).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().sendError).toBe(
      'Scheduled sends to this destination cannot include attachments. Remove the attachments or send now.',
    );
    expect(useHomeComposerStore.getState().sendErrorRetryable).toBe(false);
    expect(useHomeComposerStore.getState().scheduledSendDraft).toEqual({
      runAt: '2026-07-08T12:00:00.000Z',
    });
    expect(useHomeComposerStore.getState().attachments).toHaveLength(1);
  });

  it('keeps a pending org Chats scheduled draft when binding fails', async () => {
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const workspaceId = orgDefaultCoworkWorkspaceId(organizationId);
    const ensureOrgDefaultCoworkWorkspace = jest
      .fn()
      .mockRejectedValue(new Error('offline'));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        chatProject: {
          ...window.api?.chatProject,
          getOrgDefaultCoworkEligibility: jest
            .fn()
            .mockResolvedValue('eligible'),
          ensureOrgDefaultCoworkWorkspace,
        },
      },
    });
    useHomeComposerStore.setState({
      workspaceId,
      text: 'schedule after binding',
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });

    await expect(dispatchHomeSend()).resolves.toBe(false);

    expect(ensureOrgDefaultCoworkWorkspace).toHaveBeenCalledWith(
      organizationId,
    );
    expect(
      useAutomationsStore.getState().createActivity,
    ).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState()).toMatchObject({
      workspaceId,
      text: 'schedule after binding',
      isSending: false,
      sendErrorRetryable: true,
    });
  });

  it('rejects a scheduled send to an ineligible published org Chats workspace', async () => {
    const organizationId = '22222222-2222-4222-8222-222222222222';
    const workspaceId = orgDefaultCoworkWorkspaceId(organizationId);
    useProjectsStore.setState({ projects: [makeCoworkProject(workspaceId)] });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        chatProject: {
          ...window.api?.chatProject,
          getOrgDefaultCoworkEligibility: jest
            .fn()
            .mockResolvedValue('ineligible'),
          ensureOrgDefaultCoworkWorkspace: jest
            .fn()
            .mockResolvedValue(undefined),
        },
      },
    });
    useHomeComposerStore.setState({
      workspaceId,
      text: 'blocked schedule',
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });

    await expect(dispatchHomeSend()).resolves.toBe(false);

    expect(
      useAutomationsStore.getState().createActivity,
    ).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState()).toMatchObject({
      workspaceId,
      text: 'blocked schedule',
      isSending: false,
    });
  });

  it('preserves the draft and sets sendError when the automation create fails', async () => {
    useProjectsStore.setState({ projects: [makeCoworkProject('cowork-1')] });
    (
      useAutomationsStore.getState().createActivity as jest.Mock
    ).mockImplementation(
      (): Promise<AutomationMutationResponse> =>
        Promise.resolve({ ok: false, error: 'boom' }),
    );

    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'build the thing',
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });

    await dispatchHomeSend();

    expect(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage,
    ).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().navigate).not.toHaveBeenCalled();
    expect(showAutomationCreatedToastMock).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().isSending).toBe(false);
    expect(useHomeComposerStore.getState().sendError).toBe(
      'Could not schedule message.',
    );
    expect(useHomeComposerStore.getState().text).toBe('build the thing');
    expect(useHomeComposerStore.getState().scheduledSendDraft).toEqual({
      runAt: '2026-07-08T12:00:00.000Z',
    });
  });
});

describe('dispatchHomeSend scheduled routing — existing worktree', () => {
  it.each(['cursor-default', 'cursor:gpt-test'])(
    'rejects unsupported Cursor plugin selections before creating a chat: %s',
    async (model) => {
      useProjectsStore.setState({
        projects: [
          makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
        ],
      });
      useHomeComposerStore.setState({
        workspaceId: 'ws-1',
        branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
        text: 'fix the bug',
        model,
        pluginSelections: makePluginSelections({
          collectionIds: ['unsupported'],
        }),
      });
      expect(await dispatchHomeSend()).toBe(false);
      expect(useHomeComposerStore.getState().sendError).toContain('Cursor');
      expect(useChatStore.getState().createTab).not.toHaveBeenCalled();
      expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
    },
  );

  it.each(['cursor-default', 'cursor:gpt-test'])(
    'rejects a stale Cursor scheduled draft before creating a chat or automation: %s',
    async (model) => {
      useProjectsStore.setState({
        projects: [
          makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
        ],
      });
      useHomeComposerStore.setState({
        workspaceId: 'ws-1',
        branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
        text: 'fix the bug',
        model,
        scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
      });
      expect(await dispatchHomeSend()).toBe(false);
      expect(useHomeComposerStore.getState().sendError).toContain('Cursor');
      expect(useChatStore.getState().createTab).not.toHaveBeenCalled();
      expect(
        useAutomationsStore.getState().createActivity,
      ).not.toHaveBeenCalled();
    },
  );

  it('creates the tab, an automation, sets the draft marker, flushes, and resets without sending', async () => {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject('ws-1', { worktrees: [makeWorktree()] }),
      ],
    });
    jest
      .mocked(useChatStore.getState().createTab)
      .mockImplementation((): void => {
        callOrder.push('createTab');
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              tabs: [{ ...createEmptyTab(), id: 'tab-1' }],
              activeTabId: 'tab-1',
            },
          },
        });
      });

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'fix the bug',
      planMode: true,
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().selectWorktree).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
    );
    expect(useNavigationStore.getState().navigate).toHaveBeenCalledWith('main');
    expect(useChatStore.getState().togglePlanMode).toHaveBeenCalledWith({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'tab-1',
    });
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();

    expect(useAutomationsStore.getState().createActivity).toHaveBeenCalledWith({
      name: 'Scheduled message',
      schedule: {
        kind: 'one_time',
        runAt: '2026-07-08T12:00:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'tab-1',
        prompt: 'fix the bug',
        purpose: 'scheduled_send',
        workspaceName: 'ws-1',
        worktreeName: 'wt-1',
      },
    });

    expect(useChatStore.getState().setScheduledSendDraft).toHaveBeenCalledWith(
      { runAt: '2026-07-08T12:00:00.000Z' },
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
    );
    expect(useChatStore.getState().flushWorktreeTabs).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
    );
    expect(showAutomationCreatedToastMock).not.toHaveBeenCalled();

    expect(callOrder).toEqual([
      'createTab',
      'selectWorktree',
      'navigate',
      'ensureWorktreeHasChatTab',
      'togglePlanMode',
      'createActivity',
      'setScheduledSendDraft',
      'flushWorktreeTabs',
    ]);

    expect(useHomeComposerStore.getState().text).toBe('');
  });

  it('preserves the draft and sets sendError when the automation create fails', async () => {
    jest
      .mocked(useChatStore.getState().createTab)
      .mockImplementation((): void => {
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              tabs: [{ ...createEmptyTab(), id: 'tab-1' }],
              activeTabId: 'tab-1',
            },
          },
        });
      });
    (
      useAutomationsStore.getState().createActivity as jest.Mock
    ).mockImplementation(
      (): Promise<AutomationMutationResponse> =>
        Promise.resolve({ ok: false, error: 'boom' }),
    );

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'fix the bug',
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });

    await dispatchHomeSend();

    expect(
      useChatStore.getState().setScheduledSendDraft,
    ).not.toHaveBeenCalled();
    expect(useChatStore.getState().flushWorktreeTabs).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().isSending).toBe(false);
    expect(useHomeComposerStore.getState().sendError).toBe(
      'Could not schedule message.',
    );
    expect(useHomeComposerStore.getState().text).toBe('fix the bug');
  });
});

describe('dispatchHomeSend scheduled routing — new worktree / branch', () => {
  it('blocks scheduled provisioning sends that still have staged attachments', async () => {
    useProjectsStore.setState({
      projects: [makeSingleRepoProject('ws-1')],
    });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'build a thing',
      attachments: [makeAttachment()],
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });

    const sent = await dispatchHomeSend();

    expect(sent).toBe(false);
    expect(
      useAutomationsStore.getState().createActivity,
    ).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().createWorktree).not.toHaveBeenCalled();
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().sendError).toBe(
      'Scheduled sends to this destination cannot include attachments. Remove the attachments or send now.',
    );
    expect(useHomeComposerStore.getState().scheduledSendDraft).toEqual({
      runAt: '2026-07-08T12:00:00.000Z',
    });
    expect(useHomeComposerStore.getState().attachments).toHaveLength(1);
  });

  it('creates an automation without provisioning anything, fires the toast, and resets — never navigates', async () => {
    useProjectsStore.setState({
      projects: [makeSingleRepoProject('ws-1')],
    });

    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'build a thing',
      model: 'claude-sonnet-4-5',
      thinkingLevel: 'low',
      planMode: true,
      approvalMode: 'auto',
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });

    await dispatchHomeSend();

    expect(useProjectsStore.getState().createWorktree).not.toHaveBeenCalled();
    expect(useChatStore.getState().loadAllWorktreeTabs).not.toHaveBeenCalled();
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().navigate).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().setScheduledSendDraft,
    ).not.toHaveBeenCalled();

    expect(useAutomationsStore.getState().createActivity).toHaveBeenCalledWith({
      name: 'Scheduled task',
      schedule: {
        kind: 'one_time',
        runAt: '2026-07-08T12:00:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        prompt: 'build a thing',
        model: 'claude-sonnet-4-5',
        thinking: 'low',
        planMode: true,
        approvalMode: 'auto',
        purpose: 'scheduled_task',
        workspaceName: 'ws-1',
      },
    });

    expect(showAutomationCreatedToastMock).toHaveBeenCalledWith(
      makeActivity(),
      'ws-1',
    );

    expect(callOrder).toEqual(['createActivity']);

    expect(useHomeComposerStore.getState().text).toBe('');
    expect(useHomeComposerStore.getState().workspaceId).toBeNull();
  });

  it('preserves the explicit New worktree base branch in a scheduled task', async () => {
    useProjectsStore.setState({
      projects: [makeSingleRepoProject('ws-1')],
    });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      newWorktreeBaseTarget: {
        kind: 'branch',
        branchName: 'release',
        isRemote: true,
      },
      text: 'build a thing',
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });

    await dispatchHomeSend();

    expect(useAutomationsStore.getState().createActivity).toHaveBeenCalledWith({
      name: 'Scheduled task',
      schedule: {
        kind: 'one_time',
        runAt: '2026-07-08T12:00:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        prompt: 'build a thing',
        baseBranch: 'origin/release',
        model: DEFAULT_MODEL,
        thinking: 'high',
        purpose: 'scheduled_task',
        workspaceName: 'ws-1',
      },
    });
  });

  it('forwards existingBranch for a branch-kind target', async () => {
    useProjectsStore.setState({
      projects: [makeSingleRepoProject('ws-1')],
    });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: {
        kind: 'branch',
        branchName: 'feature/foo',
        isRemote: true,
      },
      text: 'build a thing',
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });

    await dispatchHomeSend();

    expect(useAutomationsStore.getState().createActivity).toHaveBeenCalledWith({
      name: 'Scheduled task',
      schedule: {
        kind: 'one_time',
        runAt: '2026-07-08T12:00:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        prompt: 'build a thing',
        existingBranch: 'feature/foo',
        // Task F1: the draft never touched model/thinking, so the scheduled
        // action now carries the EFFECTIVE resolved defaults (unseeded
        // `modelDefaults` in this test falls back to `DEFAULT_MODEL` /
        // `'high'` — see `resolveHomeEffectiveDefaults`) rather than omitting
        // them.
        model: DEFAULT_MODEL,
        thinking: 'high',
        purpose: 'scheduled_task',
        workspaceName: 'ws-1',
      },
    });
  });

  it('forwards the PR head branch as existingBranch for a scheduled pr-kind target', async () => {
    useProjectsStore.setState({
      projects: [makeSingleRepoProject('ws-1')],
    });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: {
        kind: 'pr',
        number: 42,
        title: 'Fix things',
        headRefName: 'fix/things',
        url: 'https://example.test/pr/42',
      },
      text: 'build a thing',
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });

    await dispatchHomeSend();

    expect(useAutomationsStore.getState().createActivity).toHaveBeenCalledWith({
      name: 'Scheduled task',
      schedule: {
        kind: 'one_time',
        runAt: '2026-07-08T12:00:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        prompt: 'build a thing',
        existingBranch: 'fix/things',
        model: DEFAULT_MODEL,
        thinking: 'high',
        purpose: 'scheduled_task',
        workspaceName: 'ws-1',
      },
    });
  });

  it('forwards an existing Linear branch as existingBranch for a scheduled linear-issue target', async () => {
    useProjectsStore.setState({
      projects: [makeSingleRepoProject('ws-1')],
    });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: {
        kind: 'linear-issue',
        identifier: 'ECW-1',
        title: 'Do it',
        branchName: 'ryan/ecw-1-do-it',
      },
      branchTargets: {
        supported: true,
        branches: [
          {
            name: 'ryan/ecw-1-do-it',
            isRemote: false,
            isCurrent: false,
            isUsedByWorktree: false,
            hasLocalRef: true,
            hasRemoteRef: false,
          },
        ],
        defaultBranch: null,
      },
      text: 'build a thing',
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });

    await dispatchHomeSend();

    expect(useAutomationsStore.getState().createActivity).toHaveBeenCalledWith({
      name: 'Scheduled task',
      schedule: {
        kind: 'one_time',
        runAt: '2026-07-08T12:00:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'ws-1',
        prompt: 'build a thing',
        existingBranch: 'ryan/ecw-1-do-it',
        model: DEFAULT_MODEL,
        thinking: 'high',
        purpose: 'scheduled_task',
        workspaceName: 'ws-1',
      },
    });
  });

  it('rejects scheduling a linear-issue target whose branch does not exist yet (fallback)', async () => {
    // Fallback path: `worktree_prompt` is a persisted, cross-package automation
    // action carrying only `existingBranch` (no create-new-named-branch field),
    // so a Linear issue whose branch resolves to `{ branchName }` cannot be
    // deferred to fire time. The send is rejected with a clear error rather
    // than silently dropping the branch name.
    useProjectsStore.setState({
      projects: [makeSingleRepoProject('ws-1')],
    });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: {
        kind: 'linear-issue',
        identifier: 'ECW-1',
        title: 'Do it',
        branchName: 'ryan/ecw-1-do-it',
      },
      branchTargets: {
        supported: true,
        branches: [],
        defaultBranch: null,
      },
      text: 'build a thing',
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });

    await expect(dispatchHomeSend()).resolves.toBe(false);

    expect(
      useAutomationsStore.getState().createActivity,
    ).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().createWorktree).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().isSending).toBe(false);
    expect(useHomeComposerStore.getState().sendError).toBe(
      'Scheduling is not available for a Linear issue whose branch does not exist yet. Send now, or pick its PR or an existing branch.',
    );
    expect(useHomeComposerStore.getState().text).toBe('build a thing');
  });

  it('preserves the draft and sets sendError when the automation create fails, without a toast', async () => {
    (
      useAutomationsStore.getState().createActivity as jest.Mock
    ).mockImplementation(
      (): Promise<AutomationMutationResponse> =>
        Promise.resolve({ ok: false, error: 'boom' }),
    );
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'build a thing',
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });

    await dispatchHomeSend();

    expect(showAutomationCreatedToastMock).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().isSending).toBe(false);
    expect(useHomeComposerStore.getState().sendError).toBe(
      'Could not schedule task.',
    );
    expect(useHomeComposerStore.getState().text).toBe('build a thing');
    expect(useHomeComposerStore.getState().scheduledSendDraft).toEqual({
      runAt: '2026-07-08T12:00:00.000Z',
    });
  });
});

describe('dispatchHomeSend inherited workspace defaults', () => {
  const KEPT_DEFAULT = { marketplaceId: 'mkt', pluginName: 'kept-default' };
  const DROPPED_DEFAULT = {
    marketplaceId: 'mkt',
    pluginName: 'dropped-default',
  };
  const OWN_PICK = { marketplaceId: 'mkt', pluginName: 'own-pick' };
  const workspaceDefaults = makePluginSelections({
    pluginRefs: [KEPT_DEFAULT, DROPPED_DEFAULT],
  });
  // The draft is seeded from the defaults; the user turned one off and added
  // a plugin of their own.
  const draft = makePluginSelections({ pluginRefs: [KEPT_DEFAULT, OWN_PICK] });
  const own = makePluginSelections({ pluginRefs: [OWN_PICK] });
  const tombstones = { pluginRefs: [DROPPED_DEFAULT] };

  function mockCreateTabActivatesTab1(): void {
    jest
      .mocked(useChatStore.getState().createTab)
      .mockImplementation((): void => {
        callOrder.push('createTab');
        useChatStore.setState({
          worktreeChats: {
            'ws-1/wt-1': {
              tabs: [{ ...createEmptyTab(), id: 'tab-1' }],
              activeTabId: 'tab-1',
            },
          },
        });
      });
  }

  it('creates a cowork chat with only its own choices and the defaults it turned off', async () => {
    useProjectsStore.setState({
      projects: [
        makeCoworkProject('cowork-1', {
          defaultPluginSelections: workspaceDefaults,
        }),
      ],
    });
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'build the thing',
      pluginSelections: draft,
    });

    await dispatchHomeSend();

    const request = jest.mocked(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage,
    ).mock.calls[0]?.[0];
    expect(request?.config?.pluginSelections).toEqual(own);
    expect(request?.config?.disabledGlobalPluginSelections).toEqual(tombstones);
  });

  it('seeds an existing-worktree chat with its own choices and turns defaults off before sending', async () => {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject('ws-1', {
          worktrees: [makeWorktree()],
          defaultPluginSelections: workspaceDefaults,
        }),
      ],
    });
    mockCreateTabActivatesTab1();
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'fix the bug',
      pluginSelections: draft,
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().createTab).toHaveBeenCalledWith(
      expect.objectContaining({ pluginSelections: own }),
    );
    expect(applyNewChatPluginSelectionsMock).toHaveBeenCalledWith(
      useChatStore.getState,
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
      { pluginSelections: own, disabledGlobalPluginSelections: tombstones },
    );
    expect(callOrder.indexOf('applyNewChatPluginSelections')).toBeLessThan(
      callOrder.indexOf('sendMessage'),
    );
  });

  it('does not copy untouched defaults into an existing-worktree chat', async () => {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject('ws-1', {
          worktrees: [makeWorktree()],
          defaultPluginSelections: workspaceDefaults,
        }),
      ],
    });
    mockCreateTabActivatesTab1();
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'worktree', worktreeId: 'wt-1' },
      text: 'fix the bug',
      pluginSelections: workspaceDefaults,
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().createTab).toHaveBeenCalledWith(
      expect.objectContaining({ pluginSelections: makePluginSelections() }),
    );
    expect(applyNewChatPluginSelectionsMock).not.toHaveBeenCalled();
  });

  it('hydrates a new-worktree chat with its own choices and applies the defaults it turned off', async () => {
    seedLoadTabsForTarget('git-ready');
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject('ws-1', {
          worktrees: [makeWorktree({ setupPhase: 'git-ready' })],
          defaultPluginSelections: workspaceDefaults,
        }),
      ],
    });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'build a thing',
      pluginSelections: draft,
    });

    await dispatchHomeSend();

    expect(useChatStore.getState().loadTabsForTarget).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
      expect.objectContaining({ pluginSelections: own }),
    );
    expect(applyNewChatPluginSelectionsMock).toHaveBeenCalledWith(
      useChatStore.getState,
      { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'tab-1' },
      { pluginSelections: own, disabledGlobalPluginSelections: tombstones },
    );
    expect(useChatStore.getState().setPluginSelections).not.toHaveBeenCalled();
    expect(callOrder.indexOf('applyNewChatPluginSelections')).toBeLessThan(
      callOrder.indexOf('sendMessage'),
    );
  });
});

describe('dispatchHomeSend return value', () => {
  it('returns false for a guard no-op (no project selected)', async () => {
    useHomeComposerStore.setState({ workspaceId: null, text: 'hello' });
    await expect(dispatchHomeSend()).resolves.toBe(false);
  });

  it('returns false for a guard no-op (empty prompt)', async () => {
    useHomeComposerStore.setState({ workspaceId: 'ws-1', text: '   ' });
    await expect(dispatchHomeSend()).resolves.toBe(false);
  });

  it('returns true after a successful cowork send', async () => {
    useProjectsStore.setState({ projects: [makeCoworkProject('cowork-1')] });
    useHomeComposerStore.setState({ workspaceId: 'cowork-1', text: 'hi' });
    await expect(dispatchHomeSend()).resolves.toBe(true);
  });

  it('returns true after a successful new-worktree send', async () => {
    // Registration hydrates the starter before the chat opens (CAN-4742).
    const seedStarter = (): Promise<void> => {
      useChatStore.setState({
        worktreeChats: {
          'ws-1/wt-1': {
            tabs: [
              {
                ...createEmptyTab(),
                ...useChatStore
                  .getState()
                  .worktreeChats[
                    'ws-1/wt-1'
                  ]?.tabs.find((tab) => tab.id === 'tab-1'),
                id: 'tab-1',
              },
            ],
            activeTabId: 'tab-1',
          },
        },
      });
      return Promise.resolve();
    };
    jest
      .mocked(useChatStore.getState().loadTabsForTarget)
      .mockImplementation(seedStarter);
    jest
      .mocked(useChatStore.getState().loadAllWorktreeTabs)
      .mockImplementation(seedStarter);
    useProjectsStore.setState({ projects: [makeSingleRepoProject('ws-1')] });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'build a thing',
    });
    await expect(dispatchHomeSend()).resolves.toBe(true);
  });

  it('returns false when the send fails (createWorktree fails)', async () => {
    (
      useProjectsStore.getState().createWorktree as jest.Mock
    ).mockImplementation(() => Promise.resolve(undefined));
    useProjectsStore.setState({ projects: [makeSingleRepoProject('ws-1')] });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'build a thing',
    });
    await expect(dispatchHomeSend()).resolves.toBe(false);
  });

  it('returns true after a successful scheduled provision send', async () => {
    useProjectsStore.setState({ projects: [makeSingleRepoProject('ws-1')] });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'build a thing',
      scheduledSendDraft: { runAt: '2026-07-08T12:00:00.000Z' },
    });
    await expect(dispatchHomeSend()).resolves.toBe(true);
  });
});

describe('dispatchHomeSend CAN-3933 purge on send', () => {
  /** Runs `during` while the cowork send is in flight, then settles it. */
  function runDuringCoworkSend(
    during: () => void,
    settle: () => Promise<string> = (): Promise<string> =>
      Promise.resolve('chat-1'),
  ): void {
    jest
      .mocked(useStandaloneChatStore.getState().createStandaloneChatWithMessage)
      .mockImplementation((): Promise<string> => {
        during();
        return settle();
      });
  }

  const reference = {
    displayPath: 'src/app.ts',
    absolutePath: '/repo/src/app.ts',
    textStart: 4,
  };

  beforeEach(() => {
    useProjectsStore.setState({ projects: [makeCoworkProject('cowork-1')] });
  });

  it('resets the draft after a successful send even when draftGeneration was bumped mid-send', async () => {
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'see src/app.ts',
      fileReferences: [reference],
    });
    runDuringCoworkSend(() => {
      useHomeComposerStore.getState().setBranchTarget({ kind: 'new-worktree' });
    });

    await expect(dispatchHomeSend()).resolves.toBe(true);

    const state = useHomeComposerStore.getState();
    expect(state.text).toBe('');
    expect(state.fileReferences).toEqual([]);
    expect(state.workspaceId).toBeNull();
    expect(state.isSending).toBe(false);
  });

  it('purges the submitted text when only reference identity drifted', async () => {
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'see src/app.ts',
      fileReferences: [reference],
    });
    runDuringCoworkSend(() => {
      useHomeComposerStore.getState().setDraft({
        text: 'see src/app.ts',
        fileReferences: [{ ...reference }],
      });
    });

    await expect(dispatchHomeSend()).resolves.toBe(true);

    const state = useHomeComposerStore.getState();
    expect(state.text).toBe('');
    expect(state.fileReferences).toEqual([]);
    expect(state.isSending).toBe(false);
  });

  it('purges only the submitted text when the rest of the draft changed mid-send', async () => {
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'build the thing',
    });
    const staged = { filename: 'a.png', absolutePath: '/tmp/a.png' };
    runDuringCoworkSend(() => {
      useHomeComposerStore.getState().addAttachments([staged]);
    });

    await expect(dispatchHomeSend()).resolves.toBe(true);

    const state = useHomeComposerStore.getState();
    expect(state.text).toBe('');
    expect(state.workspaceId).toBe('cowork-1');
    expect(state.attachments).toEqual([staged]);
    expect(state.isSending).toBe(false);
  });

  it('keeps a newer draft typed during the send', async () => {
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'build the thing',
    });
    runDuringCoworkSend(() => {
      useHomeComposerStore
        .getState()
        .setDraft({ text: 'the next task', fileReferences: [] });
    });

    await expect(dispatchHomeSend()).resolves.toBe(true);

    const state = useHomeComposerStore.getState();
    expect(state.text).toBe('the next task');
    expect(state.workspaceId).toBe('cowork-1');
    expect(state.isSending).toBe(false);
  });

  it('purges the submitted text but keeps a workspace selected mid-send', async () => {
    useProjectsStore.setState({
      projects: [makeCoworkProject('cowork-1'), makeCoworkProject('cowork-2')],
    });
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'build the thing',
    });
    runDuringCoworkSend(() => {
      useHomeComposerStore
        .getState()
        .selectWorkspace('cowork-2', { explicit: true });
    });

    await expect(dispatchHomeSend()).resolves.toBe(true);

    const state = useHomeComposerStore.getState();
    expect(state.text).toBe('');
    expect(state.workspaceId).toBe('cowork-2');
    expect(state.isSending).toBe(false);
  });

  it('purges the submitted text but keeps a schedule changed mid-send', async () => {
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'build the thing',
    });
    const schedule = { runAt: '2026-10-09T09:00:00.000Z' };
    runDuringCoworkSend(() => {
      useHomeComposerStore.getState().setScheduledSendDraft(schedule);
    });

    await expect(dispatchHomeSend()).resolves.toBe(true);

    const state = useHomeComposerStore.getState();
    expect(state.text).toBe('');
    expect(state.workspaceId).toBe('cowork-1');
    expect(state.scheduledSendDraft).toEqual(schedule);
    expect(state.isSending).toBe(false);
  });

  it('does not bump draftGeneration for an attachment-only send whose text was already empty', async () => {
    useProjectsStore.setState({ projects: [makeSingleRepoProject('ws-1')] });
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: '',
      attachments: [{ filename: 'a.png', absolutePath: '/tmp/a.png' }],
    });
    const staged = { filename: 'b.png', absolutePath: '/tmp/b.png' };
    let generationDuringSend = -1;
    jest
      .mocked(useProjectsStore.getState().createWorktree)
      .mockImplementationOnce((): Promise<{ id: string }> => {
        useHomeComposerStore.getState().addAttachments([staged]);
        generationDuringSend = useHomeComposerStore.getState().draftGeneration;
        return Promise.resolve({ id: 'wt-1' });
      });

    await dispatchHomeSend();

    const state = useHomeComposerStore.getState();
    expect(generationDuringSend).toBeGreaterThanOrEqual(0);
    expect(state.draftGeneration).toBe(generationDuringSend);
    expect(state.isSending).toBe(false);
  });

  it('preserves the text and surfaces the error when a send fails after a mid-send generation bump', async () => {
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'build the thing',
    });
    runDuringCoworkSend(
      () => {
        useHomeComposerStore
          .getState()
          .setBranchTarget({ kind: 'new-worktree' });
      },
      () => Promise.reject(new Error('chat create failed')),
    );

    await expect(dispatchHomeSend()).resolves.toBe(false);

    const state = useHomeComposerStore.getState();
    expect(state.text).toBe('build the thing');
    expect(state.workspaceId).toBe('cowork-1');
    expect(state.isSending).toBe(false);
    expect(state.sendError).toBe('chat create failed');
  });
});

describe('resolveTaskReadyLaunchTarget', () => {
  function makeBranch(name: string): BranchEntry {
    return {
      name,
      isRemote: false,
      isCurrent: false,
      isUsedByWorktree: false,
      hasLocalRef: true,
      hasRemoteRef: false,
    };
  }

  it('always resolves cowork projects to the cowork target, ignoring branchTarget', () => {
    expect(
      resolveTaskReadyLaunchTarget(
        makeCoworkProject('cowork-1'),
        {
          kind: 'worktree',
          worktreeId: 'wt-1',
        },
        [],
      ),
    ).toEqual({ kind: 'cowork' });
  });

  it('maps worktree branch targets to the worktree target kind', () => {
    expect(
      resolveTaskReadyLaunchTarget(
        makeSingleRepoProject('ws-1'),
        {
          kind: 'worktree',
          worktreeId: 'wt-1',
        },
        [],
      ),
    ).toEqual({ kind: 'worktree', worktreeId: 'wt-1' });
  });

  it('maps branch targets to the branch target kind (dropping isRemote)', () => {
    expect(
      resolveTaskReadyLaunchTarget(
        makeSingleRepoProject('ws-1'),
        {
          kind: 'branch',
          branchName: 'feature/x',
          isRemote: true,
        },
        [],
      ),
    ).toEqual({ kind: 'branch', branchName: 'feature/x' });
  });

  it('maps pr targets to a branch launch on the PR head branch', () => {
    expect(
      resolveTaskReadyLaunchTarget(
        makeSingleRepoProject('ws-1'),
        {
          kind: 'pr',
          number: 42,
          title: 'Fix things',
          headRefName: 'fix/things',
          url: 'https://example.test/pr/42',
        },
        [],
      ),
    ).toEqual({ kind: 'branch', branchName: 'fix/things' });
  });

  it('maps a linear-issue target to a branch launch when its branch already exists', () => {
    expect(
      resolveTaskReadyLaunchTarget(
        makeSingleRepoProject('ws-1'),
        {
          kind: 'linear-issue',
          identifier: 'ECW-1',
          title: 'Do it',
          branchName: 'ryan/ecw-1-do-it',
        },
        [makeBranch('ryan/ecw-1-do-it')],
      ),
    ).toEqual({ kind: 'branch', branchName: 'ryan/ecw-1-do-it' });
  });

  it('falls back to new-worktree for a linear-issue whose branch does not exist yet', () => {
    // v2 limitation: the task_ready launcher has no create-new-named-branch
    // shape, so the Linear-suggested branch name is not preserved here.
    expect(
      resolveTaskReadyLaunchTarget(
        makeSingleRepoProject('ws-1'),
        {
          kind: 'linear-issue',
          identifier: 'ECW-1',
          title: 'Do it',
          branchName: 'ryan/ecw-1-do-it',
        },
        [makeBranch('some/other-branch')],
      ),
    ).toEqual({ kind: 'new-worktree' });
  });

  it('maps new-worktree targets (and unknown projects) to new-worktree', () => {
    expect(
      resolveTaskReadyLaunchTarget(
        makeSingleRepoProject('ws-1'),
        {
          kind: 'new-worktree',
        },
        [],
      ),
    ).toEqual({ kind: 'new-worktree' });
    expect(
      resolveTaskReadyLaunchTarget(undefined, { kind: 'new-worktree' }, []),
    ).toEqual({ kind: 'new-worktree' });
  });

  it('carries the explicit New worktree base into a pipeline launch target', () => {
    expect(
      resolveTaskReadyLaunchTarget(
        makeSingleRepoProject('ws-1'),
        { kind: 'new-worktree' },
        [],
        { kind: 'worktree', worktreeId: 'wt-base' },
      ),
    ).toEqual({ kind: 'new-worktree', baseWorktreeId: 'wt-base' });
    expect(
      resolveTaskReadyLaunchTarget(
        makeSingleRepoProject('ws-1'),
        { kind: 'new-worktree' },
        [],
        { kind: 'branch', branchName: 'release', isRemote: true },
      ),
    ).toEqual({ kind: 'new-worktree', baseBranch: 'origin/release' });
  });
});

describe('buildPipelineTaskText', () => {
  function makeAttachment(overrides?: Partial<AttachmentMeta>): AttachmentMeta {
    return {
      filename: 'notes.md',
      absolutePath: '/tmp/attachments/notes.md',
      ...overrides,
    };
  }

  it('returns the trimmed text unchanged when there are no attachments', () => {
    expect(buildPipelineTaskText('  build a thing  ', [])).toBe(
      'build a thing',
    );
  });

  it('returns an empty string when there is no text and no attachments', () => {
    expect(buildPipelineTaskText('   ', [])).toBe('');
  });

  it('appends an instruction block with one absolute-path line per attachment when text is present', () => {
    const attachments = [
      makeAttachment({ absolutePath: '/tmp/attachments/a.png' }),
      makeAttachment({ absolutePath: '/tmp/attachments/b.txt' }),
    ];

    expect(buildPipelineTaskText('build a thing', attachments)).toBe(
      [
        'build a thing',
        '',
        'Review these task context files before starting (absolute paths):',
        '- /tmp/attachments/a.png',
        '- /tmp/attachments/b.txt',
      ].join('\n'),
    );
  });

  it('returns the instruction block alone when text is empty but attachments exist', () => {
    const attachments = [
      makeAttachment({ absolutePath: '/tmp/attachments/a.png' }),
    ];

    expect(buildPipelineTaskText('', attachments)).toBe(
      [
        'Review these task context files before starting (absolute paths):',
        '- /tmp/attachments/a.png',
      ].join('\n'),
    );
    expect(buildPipelineTaskText('   ', attachments)).toBe(
      [
        'Review these task context files before starting (absolute paths):',
        '- /tmp/attachments/a.png',
      ].join('\n'),
    );
  });

  it('suffixes Linear ticket snapshot attachments with "(Linear ticket snapshot)"', () => {
    const attachments = [
      makeAttachment({
        absolutePath: '/tmp/attachments/linear-can-202.md',
        promptKind: 'linear-ticket',
      }),
      makeAttachment({ absolutePath: '/tmp/attachments/plain.txt' }),
    ];

    expect(buildPipelineTaskText('fix it', attachments)).toBe(
      [
        'fix it',
        '',
        'Review these task context files before starting (absolute paths):',
        '- /tmp/attachments/linear-can-202.md (Linear ticket snapshot)',
        '- /tmp/attachments/plain.txt',
      ].join('\n'),
    );
  });
});

it('preserves a saved Cursor draft while rollout is off without probing the runtime', async () => {
  seedLoadTabsForTarget(undefined);
  const previous = useFeatureFlagsStore.getState().snapshot;
  useFeatureFlagsStore.setState({
    snapshot: {
      ...previous,
      values: { ...previous.values, 'canopy-desktop-cursor-harness': false },
    },
  });
  const status = jest.fn();
  installHomeGetCoworkRoot(() => Promise.resolve('/tmp/cowork'));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ...window.api, cursorConnection: { status } },
  });
  useHomeComposerStore.setState({
    workspaceId: 'ws-1',
    branchTarget: { kind: 'new-worktree' },
    text: 'keep my draft',
    model: 'cursor-default',
  });
  try {
    expect(await dispatchHomeSend()).toBe(false);
    expect(status).not.toHaveBeenCalled();
    expect(useChatStore.getState().createTab).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().createWorktree).not.toHaveBeenCalled();
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().text).toBe('keep my draft');
    expect(useHomeComposerStore.getState().sendError).toBe(
      'This Cursor model is unavailable. Choose another Cursor model and try again.',
    );
  } finally {
    useFeatureFlagsStore.setState({ snapshot: previous });
  }
});

describe('dispatchHomeSend CAN-3606 link destinations', () => {
  it('clears the chosen attachment when its Linear issue leaves the actual draft', async () => {
    seedChatsAndProject();
    installLinkApi({
      searchLinearIssues: jest.fn((query: string) =>
        Promise.resolve([
          {
            id: query,
            identifier: query,
            title: 'Fix',
            description: null,
            url: `https://linear.app/acme/issue/${query}`,
            priority: 1,
            priorityLabel: 'Urgent',
            branchName: 'can-fix',
            attachments: [
              { url: PR_URL },
              { url: 'https://github.com/acme/app/pull/43' },
            ],
            attachmentsComplete: true,
          },
        ]),
      ),
    });
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'Fix CAN-1',
    });
    await dispatchHomeSend();
    await waitForLinkStatus('blocked');
    useHomeComposerStore
      .getState()
      .chooseLinkAttachment('github.com/acme/app/pull/42', 'linear:CAN-1');
    syncHomeLinkTarget();
    await waitForLinkStatus('ready');
    useHomeComposerStore.getState().setText('Fix CAN-2');
    await expect(dispatchHomeSend()).resolves.toBe(false);
    await waitForLinkStatus('blocked');
    expect(useHomeComposerStore.getState().chosenLinkAttachmentKey).toBeNull();
    expect(useProjectsStore.getState().createWorktree).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'expands source-project saved prompts for a linked task (scheduled=%s)',
    async (scheduled) => {
      seedChatsAndProject();
      installLinkApi();
      const readPromptByPath = jest.fn(
        ({ projectId }: { projectId: string }) =>
          projectId === 'cowork-1'
            ? Promise.resolve({ content: 'Review the security assumptions.' })
            : Promise.reject(new Error('Prompt outside project')),
      );
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          ...window.api,
          workspaceItems: { readPromptByPath },
        },
      });
      useHomeComposerStore.setState({
        workspaceId: 'cowork-1',
        text: `Prompt: Review Helper ${PR_URL}`,
        fileReferences: [
          {
            displayPath: 'Prompt: Review Helper',
            absolutePath: '/tmp/cowork/prompts/review-helper.md',
            kind: 'prompt',
            textStart: 0,
          },
        ],
        ...(scheduled
          ? { scheduledSendDraft: { runAt: '2100-01-01T12:00:00.000Z' } }
          : {}),
      });
      await dispatchHomeSend();
      await waitForLinkStatus('ready');
      await expect(dispatchHomeSend()).resolves.toBe(true);
      expect(readPromptByPath).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'cowork-1' }),
      );
      if (scheduled) {
        const request = jest.mocked(
          useAutomationsStore.getState().createActivity,
        ).mock.calls[0]?.[0];
        expect(request?.action.type).toBe('worktree_prompt');
        if (request?.action.type === 'worktree_prompt') {
          expect(request.action.workspaceId).toBe('ws-1');
          expect(request.action.prompt).toContain(
            'Review the security assumptions.',
          );
        }
      } else {
        expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
          expect.stringContaining('Review the security assumptions.'),
          undefined,
          expect.objectContaining({ projectId: 'ws-1' }),
          undefined,
          expect.any(Object),
        );
      }
    },
  );

  it('preserves the displayed Chats thinking default when a link selects a code project', async () => {
    seedChatsAndProject();
    installLinkApi();
    useChatStore.setState({
      modelDefaults: {
        chatProvider: 'claude',
        chatModelByProvider: {
          claude: { model: DEFAULT_MODEL, thinkingLevel: 'medium' },
          codex: { model: 'gpt-6.1', thinkingLevel: 'high' },
          ollama: null,
        },
        worktreeProvider: 'claude',
        worktreeModelByProvider: {
          claude: { model: DEFAULT_MODEL, thinkingLevel: 'high' },
          codex: { model: 'gpt-6.1', thinkingLevel: 'high' },
          ollama: null,
        },
      },
    });
    useHomeComposerStore.setState({ workspaceId: 'cowork-1', text: PR_URL });
    await dispatchHomeSend();
    await waitForLinkStatus('ready');
    await expect(dispatchHomeSend()).resolves.toBe(true);
    expect(useChatStore.getState().loadTabsForTarget).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
      expect.objectContaining({ thinkingLevel: 'medium' }),
    );
  });

  it('defers immediate Linear branch existence decisions to the backend', async () => {
    seedChatsAndProject();
    installLinkApi({
      searchLinearIssues: jest.fn().mockResolvedValue([
        {
          id: 'issue-1',
          identifier: 'CAN-1',
          title: 'Fix',
          description: null,
          url: 'https://linear.app/acme/issue/CAN-1',
          priority: 1,
          priorityLabel: 'Urgent',
          branchName: 'can-1-fix',
          attachments: [{ url: 'https://github.com/acme/app' }],
          attachmentsComplete: true,
        },
      ]),
      homeListBranchTargets: jest
        .fn()
        .mockRejectedValue(new Error('branch listing unavailable')),
    });
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'Fix CAN-1',
    });
    await dispatchHomeSend();
    await waitForLinkStatus('ready');
    await expect(dispatchHomeSend()).resolves.toBe(true);
    expect(useProjectsStore.getState().createWorktree).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ suggestedBranch: 'can-1-fix' }),
    );
  });

  it('marks scheduling non-cancellable before the irreversible activity mutation', async () => {
    seedChatsAndProject();
    installLinkApi();
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: PR_URL,
      scheduledSendDraft: { runAt: '2100-01-01T12:00:00.000Z' },
    });
    await dispatchHomeSend();
    await waitForLinkStatus('ready');
    let beginMutation: () => void = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      beginMutation = resolve;
    });
    let finishMutation: (
      response: AutomationMutationResponse,
    ) => void = (): void => undefined;
    jest
      .mocked(useAutomationsStore.getState().createActivity)
      .mockImplementationOnce(() => {
        beginMutation();
        return new Promise((resolve) => {
          finishMutation = resolve;
        });
      });
    const sending = dispatchHomeSend();
    await started;
    const target = useHomeComposerStore.getState().linkTarget;
    const canCancel =
      target.status === 'submitting' ? target.canCancel : undefined;
    cancelHomeLinkSubmission();
    finishMutation({ ok: true, activity: makeActivity() });
    await expect(sending).resolves.toBe(true);
    expect(canCancel).toBe(false);
    expect(showAutomationCreatedToastMock).toHaveBeenCalled();
  });

  it('preserves Linear issue context when its attachment selects a PR branch', async () => {
    seedChatsAndProject();
    installLinkApi({
      searchLinearIssues: jest.fn().mockResolvedValue([
        {
          id: 'issue-1',
          identifier: 'CAN-1',
          title: 'Repair login',
          description: 'The checkout form loses its session.',
          url: 'https://linear.app/acme/issue/CAN-1',
          priority: 1,
          priorityLabel: 'Urgent',
          branchName: 'can-1-repair-login',
          attachments: [{ url: PR_URL }],
          attachmentsComplete: true,
        },
      ]),
    });
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'Please fix CAN-1',
    });
    await expect(dispatchHomeSend()).resolves.toBe(false);
    await waitForLinkStatus('ready');
    await expect(dispatchHomeSend()).resolves.toBe(true);
    expect(useProjectsStore.getState().createWorktree).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ existingBranch: 'feature/login' }),
    );
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
      expect.stringMatching(
        /Please fix CAN-1[\s\S]*Repair login[\s\S]*The checkout form loses its session/,
      ),
      undefined,
      expect.anything(),
      undefined,
      expect.anything(),
    );
  });
  it('does not automatically send a replacement draft after settling an older identifier', async () => {
    seedChatsAndProject();
    let finishLookup: (issues: []) => void = (): void => undefined;
    installLinkApi({
      searchLinearIssues: jest.fn(
        () =>
          new Promise<[]>((resolve) => {
            finishLookup = resolve;
          }),
      ),
    });
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'explain UTF-8',
    });
    const submission = dispatchHomeSend();
    useHomeComposerStore.getState().setText('a replacement draft');
    finishLookup([]);
    await expect(submission).resolves.toBe(false);
    expect(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage,
    ).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().text).toBe('a replacement draft');
  });
  it('does not clear a newer draft when an older worktree send finishes', async () => {
    seedChatsAndProject();
    installLinkApi();
    useHomeComposerStore.setState({ workspaceId: 'cowork-1', text: PR_URL });
    await dispatchHomeSend();
    await waitForLinkStatus('ready');
    const original = useProjectsStore.getState().createWorktree;
    useProjectsStore.setState({
      createWorktree: jest.fn(async (id, options) => {
        useHomeComposerStore.getState().setText('a newer draft');
        return original(id, options);
      }),
    });
    await dispatchHomeSend();
    expect(useHomeComposerStore.getState().text).toBe('a newer draft');
    expect(useHomeComposerStore.getState().linkTarget.status).toBe('idle');
  });

  it('timestamps the submission before link materialization yields (CAN-4742)', async () => {
    seedChatsAndProject();
    const api = installLinkApi();
    useHomeComposerStore.setState({ workspaceId: 'cowork-1', text: PR_URL });
    await dispatchHomeSend();
    await waitForLinkStatus('ready');
    let release: (slug: { owner: string; repo: string }) => void = (): void =>
      undefined;
    let entered = (): void => undefined;
    const atLookup = new Promise<void>((resolve) => {
      entered = resolve;
    });
    api.getRepoSlug.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
          entered();
        }),
    );
    const sending = dispatchHomeSend();
    await atLookup;
    const resumedAt = Date.now() + 1000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(resumedAt);
    release({ owner: 'Acme', repo: 'App' });
    try {
      await expect(sending).resolves.toBe(true);
      expect(
        jest.mocked(useChatStore.getState().sendMessage).mock.calls[0]?.[4]
          ?.submittedAt,
      ).toBeLessThan(resumedAt);
    } finally {
      now.mockRestore();
    }
  });

  it('retires the first-send echo immediately when creation is cancelled at a held layout', async () => {
    seedChatsAndProject();
    installLinkApi();
    useHomeComposerStore.setState({ workspaceId: 'cowork-1', text: PR_URL });
    await dispatchHomeSend();
    await waitForLinkStatus('ready');
    let release = (): void => undefined;
    let entered = (): void => undefined;
    const atLayout = new Promise<void>((resolve) => {
      entered = resolve;
    });
    ensureWorktreePanelLayoutMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          entered();
        }),
    );
    const sending = dispatchHomeSend();
    try {
      await atLayout;
      expect(
        useChatStore.getState().worktreeChats['ws-1/wt-1']?.tabs[0]
          ?.provisionalFirstSend,
      ).toBeDefined();
      cancelHomeLinkSubmission();
      expect(
        useChatStore.getState().worktreeChats['ws-1/wt-1']?.tabs[0]
          ?.provisionalFirstSend,
      ).toBeUndefined();
    } finally {
      release();
      await sending;
    }
  });

  it.each(['registration', 'hydration', 'layout'] as const)(
    'stops chat activation when cancelled during %s',
    async (stage) => {
      seedChatsAndProject();
      installLinkApi();
      useHomeComposerStore.setState({ workspaceId: 'cowork-1', text: PR_URL });
      await dispatchHomeSend();
      await waitForLinkStatus('ready');
      if (stage === 'registration') {
        const original = useProjectsStore.getState().createWorktree;
        useProjectsStore.setState({
          createWorktree: jest.fn((id, options) => {
            cancelHomeLinkSubmission();
            return original(id, options);
          }),
        });
      } else if (stage === 'hydration') {
        jest
          .mocked(useChatStore.getState().loadTabsForTarget)
          .mockImplementationOnce(() => {
            cancelHomeLinkSubmission();
            return Promise.resolve();
          });
      } else {
        ensureWorktreePanelLayoutMock.mockImplementationOnce(() => {
          cancelHomeLinkSubmission();
          return Promise.resolve();
        });
      }
      await expect(dispatchHomeSend()).resolves.toBe(false);
      expect(useProjectsStore.getState().createWorktree).toHaveBeenCalledTimes(
        1,
      );
      if (stage !== 'layout')
        expect(
          useChatStore.getState().ensureWorktreeHasChatTab,
        ).not.toHaveBeenCalled();
      expect(useChatStore.getState().selectWorktree).not.toHaveBeenCalled();
      expect(useNavigationStore.getState().navigate).not.toHaveBeenCalled();
      expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
      expect(useHomeComposerStore.getState().text).toBe(PR_URL);
      expect(useHomeComposerStore.getState().sendError).toContain(
        'worktree remains available',
      );
    },
  );

  it('resolves and sends a replacement link after editing during materialization', async () => {
    seedChatsAndProject();
    const api = installLinkApi();
    useHomeComposerStore.setState({ workspaceId: 'cowork-1', text: PR_URL });
    await dispatchHomeSend();
    await waitForLinkStatus('ready');
    let finishLookup: (slug: {
      owner: string;
      repo: string;
    }) => void = (): void => undefined;
    api.getRepoSlug.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLookup = resolve;
        }),
    );
    const submission = dispatchHomeSend();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useHomeComposerStore.getState().linkTarget.status).toBe(
      'submitting',
    );
    const replacement = `Please review ${PR_URL}`;
    useHomeComposerStore.getState().setText(replacement);
    finishLookup({ owner: 'Acme', repo: 'App' });
    await expect(submission).resolves.toBe(false);
    expect(useHomeComposerStore.getState().text).toBe(replacement);
    expect(useHomeComposerStore.getState().linkTarget.status).not.toBe(
      'submitting',
    );
    await waitForLinkStatus('ready');
    await expect(dispatchHomeSend()).resolves.toBe(true);
    expect(useProjectsStore.getState().createWorktree).toHaveBeenCalledTimes(1);
  });

  const PR_URL = 'https://github.com/acme/app/pull/42';

  function installLinkApi(overrides: Record<string, unknown> = {}): {
    getRepoSlug: jest.Mock;
    resolvePullRequest: jest.Mock;
    searchLinearIssues: jest.Mock;
  } {
    const api = {
      getRepoSlug: jest.fn(({ repoPath }: { repoPath: string }) =>
        Promise.resolve(
          repoPath === '/tmp/ws-1' ? { owner: 'Acme', repo: 'App' } : null,
        ),
      ),
      resolvePullRequest: jest.fn(() =>
        Promise.resolve({
          number: 42,
          title: 'Fix login',
          headRefName: 'feature/login',
          baseRefName: 'main',
          url: PR_URL,
        }),
      ),
      searchLinearIssues: jest.fn(() => Promise.resolve([])),
      listUserGitHubRepos: jest.fn(() =>
        Promise.resolve([
          {
            fullName: 'acme/app',
            ownerLogin: 'acme',
            name: 'app',
            description: null,
            cloneUrl: 'https://github.com/acme/app.git',
            sshUrl: '',
            htmlUrl: '',
            isPrivate: false,
            isFork: false,
            isArchived: false,
            defaultBranch: 'main',
            updatedAt: null,
          },
        ]),
      ),
      ...overrides,
    };
    installHomeGetCoworkRoot(() => Promise.resolve('/tmp/cowork'));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...window.api, ...api },
    });
    return api;
  }

  async function waitForLinkStatus(status: string): Promise<void> {
    const deadline = Date.now() + 3000;
    while (useHomeComposerStore.getState().linkTarget.status !== status) {
      if (Date.now() > deadline) {
        throw new Error(
          `link target stayed ${useHomeComposerStore.getState().linkTarget.status}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function seedChatsAndProject(): void {
    seedLoadTabsForTarget(undefined);
    useProjectsStore.setState((state) => ({
      projects: [...state.projects, makeCoworkProject('cowork-1')],
    }));
  }

  it('creates the PR-head worktree from Chats instead of a Cowork chat (reported regression)', async () => {
    seedChatsAndProject();
    installLinkApi();
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: `create a worktree based on this PR ${PR_URL}`,
    });

    // A send before the preview settles stops; it never becomes a chat.
    await expect(dispatchHomeSend()).resolves.toBe(false);
    expect(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage,
    ).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().text).toContain(PR_URL);

    await waitForLinkStatus('ready');
    // Preview never changes the selection.
    expect(useHomeComposerStore.getState().workspaceId).toBe('cowork-1');

    await expect(dispatchHomeSend()).resolves.toBe(true);
    const createWorktree = jest.mocked(
      useProjectsStore.getState().createWorktree,
    );
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(createWorktree.mock.calls[0][0]).toBe('ws-1');
    expect(createWorktree.mock.calls[0][1]).toEqual(
      expect.objectContaining({ existingBranch: 'feature/login' }),
    );
    expect(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage,
    ).not.toHaveBeenCalled();
  });

  it('keeps the shown destination while an edit re-checks the same link', async () => {
    seedChatsAndProject();
    installLinkApi();
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: `review ${PR_URL}`,
    });
    syncHomeLinkTarget();
    await waitForLinkStatus('ready');
    const { linkTarget: ready } = useHomeComposerStore.getState();
    if (ready.status !== 'ready') throw new Error('expected ready');

    useHomeComposerStore.getState().setText(`please review ${PR_URL}`);
    syncHomeLinkTarget();
    const recheck = useHomeComposerStore.getState().linkTarget;
    expect(recheck).toEqual(
      expect.objectContaining({
        status: 'resolving',
        previousPlan: ready.plan,
      }),
    );
    // A send still waits for the re-check; the kept plan is display only.
    await expect(dispatchHomeSend()).resolves.toBe(false);
    expect(useProjectsStore.getState().createWorktree).not.toHaveBeenCalled();

    useHomeComposerStore
      .getState()
      .setText('review https://github.com/acme/other/pull/7');
    syncHomeLinkTarget();
    const other = useHomeComposerStore.getState().linkTarget;
    expect(other.status).toBe('resolving');
    expect(other).not.toHaveProperty('previousPlan');
  });

  it('sends an ordinary Cowork chat once the link is dismissed', async () => {
    seedChatsAndProject();
    installLinkApi();
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: `what does ${PR_URL} change?`,
    });
    useHomeComposerStore
      .getState()
      .dismissLinkReferences(['github.com/acme/app/pull/42']);

    await expect(dispatchHomeSend()).resolves.toBe(true);
    expect(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage,
    ).toHaveBeenCalledTimes(1);
    expect(useProjectsStore.getState().createWorktree).not.toHaveBeenCalled();
  });

  it('requires dismissal before sending prose that looks like an unknown Linear identifier', async () => {
    seedChatsAndProject();
    const api = installLinkApi();
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'explain UTF-8 encoding',
    });

    await expect(dispatchHomeSend()).resolves.toBe(false);
    expect(api.searchLinearIssues).toHaveBeenCalledWith('UTF-8');
    expect(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage,
    ).not.toHaveBeenCalled();
    useHomeComposerStore.getState().dismissLinkReferences(['linear:UTF-8']);
    await expect(dispatchHomeSend()).resolves.toBe(true);
    expect(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage,
    ).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft and creates nothing while the link is blocked', async () => {
    seedChatsAndProject();
    installLinkApi({
      resolvePullRequest: jest.fn(() =>
        Promise.reject(new Error('Pull request #42 was not found.')),
      ),
    });
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: PR_URL,
    });
    await expect(dispatchHomeSend()).resolves.toBe(false);
    await waitForLinkStatus('blocked');

    await expect(dispatchHomeSend()).resolves.toBe(false);
    expect(useHomeComposerStore.getState().sendError).toMatch(
      /Resolve the link above/,
    );
    expect(useHomeComposerStore.getState().text).toBe(PR_URL);
    expect(useProjectsStore.getState().createWorktree).not.toHaveBeenCalled();
    expect(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage,
    ).not.toHaveBeenCalled();
  });

  it('refuses a known blocked model before cloning a link project', async () => {
    useProjectsStore.setState({ projects: [makeCoworkProject('cowork-1')] });
    const addRemoteRepo = jest.fn();
    useProjectsStore.setState({ addRemoteRepo });
    installLinkApi({
      getDefaultCloneDirectory: jest.fn(() => Promise.resolve('/tmp/clones')),
      probeCloneDestination: jest.fn(() =>
        Promise.resolve({
          repoName: 'app',
          candidateExists: false,
          reusablePath: null,
        }),
      ),
    });
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'start on https://github.com/acme/app',
      model: 'claude-sonnet-4-5',
    });
    await dispatchHomeSend();
    await waitForLinkStatus('ready');
    jest.mocked(preflightHomeModel).mockResolvedValueOnce({
      ok: false,
      reason: 'not-routable',
      modelLabel: 'Sonnet 4.5',
    });
    await expect(dispatchHomeSend()).resolves.toBe(false);
    expect(addRemoteRepo).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().createWorktree).not.toHaveBeenCalled();
  });

  it('clones a missing repository, then creates its default-branch worktree', async () => {
    useProjectsStore.setState({ projects: [makeCoworkProject('cowork-1')] });
    seedLoadTabsForTarget(undefined);
    useProjectsStore.setState({ projects: [makeCoworkProject('cowork-1')] });
    const addRemoteRepo = jest.fn<
      Promise<string>,
      [string, string, { jobId?: string }?]
    >((): Promise<string> => {
      useProjectsStore.setState((state) => ({
        projects: [...state.projects, makeSingleRepoProject('ws-1')],
      }));
      return Promise.resolve('ws-1');
    });
    useProjectsStore.setState({ addRemoteRepo });
    const probeCloneDestination = jest.fn(() =>
      Promise.resolve({
        repoName: 'app',
        candidateExists: false,
        reusablePath: null,
      }),
    );
    installLinkApi({
      getDefaultCloneDirectory: jest.fn(() => Promise.resolve('/tmp/clones')),
      probeCloneDestination,
    });
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'start on https://github.com/acme/app',
    });
    await expect(dispatchHomeSend()).resolves.toBe(false);
    await waitForLinkStatus('ready');
    const { linkTarget } = useHomeComposerStore.getState();
    expect(linkTarget.status === 'ready' && linkTarget.plan.kind).toBe(
      'create-project',
    );

    await expect(dispatchHomeSend()).resolves.toBe(true);
    expect(addRemoteRepo).toHaveBeenCalledTimes(1);
    expect(addRemoteRepo).toHaveBeenCalledTimes(1);
    const [cloneUrl, cloneDir, cloneOptions] = addRemoteRepo.mock.calls[0];
    expect([cloneUrl, cloneDir]).toEqual([
      'https://github.com/acme/app.git',
      '/tmp/clones',
    ]);
    expect(typeof cloneOptions?.jobId).toBe('string');
    const createWorktree = jest.mocked(
      useProjectsStore.getState().createWorktree,
    );
    expect(createWorktree.mock.calls[0][0]).toBe('ws-1');
    expect(createWorktree.mock.calls[0][1]?.existingBranch).toBeUndefined();
    expect(
      useStandaloneChatStore.getState().createStandaloneChatWithMessage,
    ).not.toHaveBeenCalled();
  });

  describe('GitHub sign-in when the clone needs it (CAN-4466)', () => {
    const AUTH_REJECTION =
      "Error invoking remote method 'workspace:add-from-remote': GitHubAuthFailureError: fatal: could not read Username for 'https://github.com': terminal prompts disabled";
    const FAILURE =
      "Couldn’t add acme/app: fatal: could not read Username for 'https://github.com': terminal prompts disabled";
    const TEXT = 'start on https://github.com/acme/app';

    function composerLinkKey(): string | undefined {
      const { linkTarget } = useHomeComposerStore.getState();
      return linkTarget.status === 'idle' ? undefined : linkTarget.key;
    }

    async function readyToClone(
      rejection: string,
    ): Promise<jest.Mock<Promise<string>, [string, string, unknown?]>> {
      useGitHubConnectOfferStore.setState({ offer: null });
      useProjectsStore.setState({ projects: [makeCoworkProject('cowork-1')] });
      const addRemoteRepo = jest.fn<
        Promise<string>,
        [string, string, unknown?]
      >(() => Promise.reject(new Error(rejection)));
      useProjectsStore.setState({ addRemoteRepo });
      installLinkApi({
        getDefaultCloneDirectory: jest.fn(() => Promise.resolve('/tmp/clones')),
        probeCloneDestination: jest.fn(() =>
          Promise.resolve({
            repoName: 'app',
            candidateExists: false,
            reusablePath: null,
          }),
        ),
      });
      useHomeComposerStore.setState({ workspaceId: 'cowork-1', text: TEXT });
      await dispatchHomeSend();
      await waitForLinkStatus('ready');
      return addRemoteRepo;
    }

    it('offers the sign-in instead of an error, keeping the draft', async () => {
      const addRemoteRepo = await readyToClone(AUTH_REJECTION);
      await expect(dispatchHomeSend()).resolves.toBe(false);
      expect(addRemoteRepo).toHaveBeenCalledTimes(1);
      const continuation =
        useGitHubConnectOfferStore.getState().offer?.continuation;
      expect(typeof continuation?.operationId).toBe('string');
      expect(continuation).toEqual({
        operationId: continuation?.operationId,
        kind: 'home-link-add-project',
        resume: 'send',
        linkKey: composerLinkKey(),
        draftText: TEXT,
        failureMessage: FAILURE,
      });
      const composer = useHomeComposerStore.getState();
      expect(composer.sendError).toBeNull();
      expect(composer.isSending).toBe(false);
      expect(composer.text).toBe(TEXT);
      expect(composer.linkTarget.status).toBe('ready');
    });

    it('shows the ordinary error while another offer is pending', async () => {
      await readyToClone(AUTH_REJECTION);
      useGitHubConnectOfferStore.getState().requestOffer({
        operationId: 'op-push',
        kind: 'push',
        projectId: 'p',
        worktreeId: 'w',
        expectedHeadBranch: 'main',
      });
      await expect(dispatchHomeSend()).resolves.toBe(false);
      expect(useHomeComposerStore.getState().sendError).toBe(FAILURE);
      expect(
        useGitHubConnectOfferStore.getState().offer?.continuation.operationId,
      ).toBe('op-push');
    });

    it('a resend after connecting that fails again shows the error, not a second offer', async () => {
      const addRemoteRepo = await readyToClone(AUTH_REJECTION);
      useHomeComposerStore.getState().requestGitHubConnectResume();
      await expect(dispatchHomeSend()).resolves.toBe(false);
      expect(addRemoteRepo).toHaveBeenCalledTimes(1);
      expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
      expect(useHomeComposerStore.getState().sendError).toBe(FAILURE);
      expect(
        useHomeComposerStore.getState().pendingGitHubConnectResume,
      ).toBeNull();
    });

    it('consumes a resend request even when the send stops early', async () => {
      useHomeComposerStore.setState({
        workspaceId: 'cowork-1',
        pendingAttachmentImportIds: [1],
      });
      useHomeComposerStore.getState().requestGitHubConnectResume();
      await expect(dispatchHomeSend()).resolves.toBe(false);
      expect(
        useHomeComposerStore.getState().pendingGitHubConnectResume,
      ).toBeNull();
    });

    it('never offers for an ordinary clone failure', async () => {
      await readyToClone(
        "Error invoking remote method 'workspace:add-from-remote': Error: remote: Repository not found.",
      );
      await expect(dispatchHomeSend()).resolves.toBe(false);
      expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
      expect(useHomeComposerStore.getState().sendError).toBe(
        'Couldn’t add acme/app: remote: Repository not found.',
      );
    });
  });

  it('rejects scheduling a missing-project link before any side effect', async () => {
    useProjectsStore.setState({ projects: [makeCoworkProject('cowork-1')] });
    const addRemoteRepo = jest.fn();
    useProjectsStore.setState({ addRemoteRepo });
    installLinkApi();
    useHomeComposerStore.setState({
      workspaceId: 'cowork-1',
      text: 'start on https://github.com/acme/app',
      scheduledSendDraft: { runAt: '2026-10-07T12:00:00.000Z' },
    });
    await dispatchHomeSend();
    await waitForLinkStatus('ready');

    await expect(dispatchHomeSend()).resolves.toBe(false);
    expect(useHomeComposerStore.getState().sendError).toMatch(/Scheduling/);
    expect(addRemoteRepo).not.toHaveBeenCalled();
    expect(
      useAutomationsStore.getState().createActivity,
    ).not.toHaveBeenCalled();
  });
});

describe('dispatchHomeSend CAN-5021 model pre-flight', () => {
  const refusal = {
    ok: false,
    reason: 'not-routable',
    modelLabel: 'Sonnet 4.5',
  } as const;
  const refusalCopy =
    'Sonnet 4.5 isn’t available on AI Credits. Choose another model.';

  it.each([
    ['a new worktree', { kind: 'new-worktree' }, 'ws-1'],
    ['an existing worktree', { kind: 'worktree', worktreeId: 'wt-1' }, 'ws-1'],
    ['a Cowork chat', { kind: 'new-worktree' }, 'cowork-1'],
  ] as const)(
    'stays on Home with the whole draft when the model is known to be refused for %s',
    async (_label, branchTarget, workspaceId) => {
      jest.mocked(preflightHomeModel).mockResolvedValueOnce(refusal);
      useHomeComposerStore.setState({
        workspaceId,
        branchTarget,
        attachments: [makeAttachment()],
        fileReferences: [
          { displayPath: 'readme.md', absolutePath: '/tmp/readme.md' },
        ],
        planMode: true,
        text: 'keep every word',
        model: 'claude-sonnet-4-5',
      });

      await expect(dispatchHomeSend()).resolves.toBe(false);

      expect(preflightHomeModel).toHaveBeenLastCalledWith(workspaceId, {
        model: 'claude-sonnet-4-5',
      });
      expect(useProjectsStore.getState().createWorktree).not.toHaveBeenCalled();
      expect(useChatStore.getState().createTab).not.toHaveBeenCalled();
      expect(useNavigationStore.getState().navigate).not.toHaveBeenCalled();
      expect(useChatStore.getState().setModelAndWait).not.toHaveBeenCalled();
      expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled();
      const home = useHomeComposerStore.getState();
      expect(home.text).toBe('keep every word');
      expect(home.model).toBe('claude-sonnet-4-5');
      expect(home.attachments).toEqual([makeAttachment()]);
      expect(home.fileReferences).toEqual([
        { displayPath: 'readme.md', absolutePath: '/tmp/readme.md' },
      ]);
      expect(home.planMode).toBe(true);
      expect(
        useStandaloneChatStore.getState().createStandaloneChatWithMessage,
      ).not.toHaveBeenCalled();
      expect(home.branchTarget).toEqual(branchTarget);
      expect(home.isSending).toBe(false);
      expect(home.sendError).toBe(refusalCopy);
      expect(home.sendErrorChooseModel).toMatchObject({
        message: refusalCopy,
        focus: true,
      });
      expect(typeof home.sendErrorChooseModel?.failureId).toBe('string');
    },
  );

  it('gives a repeated identical refusal a new identity, so it takes focus again', async () => {
    jest.mocked(preflightHomeModel).mockResolvedValue(refusal);
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'again',
    });

    await dispatchHomeSend();
    const first = useHomeComposerStore.getState().sendErrorChooseModel;
    await dispatchHomeSend();
    const second = useHomeComposerStore.getState().sendErrorChooseModel;

    expect(second?.message).toBe(first?.message);
    expect(second?.failureId).not.toBe(first?.failureId);
  });

  it('clears the refusal and its action when another model is accepted', async () => {
    jest.mocked(preflightHomeModel).mockResolvedValueOnce(refusal);
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'switch models',
      model: 'claude-sonnet-4-5',
    });
    await dispatchHomeSend();

    useHomeComposerStore.getState().setModel(DEFAULT_CODEX_MODEL);

    expect(useHomeComposerStore.getState().sendError).toBeNull();
    expect(useHomeComposerStore.getState().sendErrorChooseModel).toBeNull();
    expect(useHomeComposerStore.getState().text).toBe('switch models');
  });

  it('does not clear the lock or error of a newer submission after a reset', async () => {
    let firstRelease = (): void => {
      throw new Error('First check not reached');
    };
    let secondRelease = (): void => {
      throw new Error('Second check not reached');
    };
    jest
      .mocked(preflightHomeModel)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            firstRelease = (): void => resolve(refusal);
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            secondRelease = (): void => resolve(refusal);
          }),
      );
    const submit = (): Promise<boolean> => {
      useHomeComposerStore.setState({
        workspaceId: 'ws-1',
        text: 'same words',
        model: 'claude-sonnet-4-5',
      });
      return dispatchHomeSend();
    };
    const first = submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    useHomeComposerStore.getState().reset();
    const second = submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    firstRelease();
    await expect(first).resolves.toBe(false);
    expect(useHomeComposerStore.getState().isSending).toBe(true);
    expect(useHomeComposerStore.getState().sendError).toBeNull();
    secondRelease();
    await expect(second).resolves.toBe(false);
  });

  it('drops a pre-flight result that a draft change made stale', async () => {
    let settle = (): void => {
      throw new Error('The pre-flight resolver was not initialized.');
    };
    jest.mocked(preflightHomeModel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = (): void => resolve(refusal);
        }),
    );
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'first thought',
      model: 'claude-sonnet-4-5',
    });

    const send = dispatchHomeSend();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A second submit while the first is in flight is ignored.
    await expect(dispatchHomeSend()).resolves.toBe(false);
    useHomeComposerStore.setState({ model: DEFAULT_CODEX_MODEL });
    settle();

    await expect(send).resolves.toBe(false);
    const home = useHomeComposerStore.getState();
    expect(home.sendError).toBeNull();
    expect(home.sendErrorChooseModel).toBeNull();
    expect(home.isSending).toBe(false);
    expect(useProjectsStore.getState().createWorktree).not.toHaveBeenCalled();
    expect(preflightHomeModel).toHaveBeenCalledTimes(1);
  });

  it('drops a pre-flight result after the new-worktree base changes', async () => {
    let settle = (): void => {
      throw new Error('Pre-flight not reached');
    };
    jest.mocked(preflightHomeModel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = (): void => resolve({ ok: true });
        }),
    );
    useHomeComposerStore.setState({
      workspaceId: 'ws-1',
      branchTarget: { kind: 'new-worktree' },
      text: 'Keep my newer base selection',
    });
    const send = dispatchHomeSend();
    await new Promise((resolve) => setTimeout(resolve, 0));
    useHomeComposerStore.getState().setNewWorktreeBaseTarget({
      kind: 'worktree',
      worktreeId: 'new-base',
    });
    settle();

    await expect(send).resolves.toBe(false);
    expect(useProjectsStore.getState().createWorktree).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().text).toBe(
      'Keep my newer base selection',
    );
    expect(useHomeComposerStore.getState().isSending).toBe(false);
  });
});
