/** @jest-environment jsdom */

const openFileTab = jest.fn();
const openFileInBrowserPanel = jest.fn();
const requestBrowserPanel = jest.fn();
const resolveStartPageAbsolutePath = jest.fn();
const selectTab = jest.fn();
const reorderTab = jest.fn();
const movePanel = jest.fn();
const refreshGeneration = jest.fn(() => true);
const openUrlFromDevServer = jest.fn();
const destroyBrowser = jest.fn();
let chatSubscriber: (() => void) | undefined;
let panelSubscriber: (() => void) | undefined;
let filePanelMaterialized = true;
let workspaceMode = 'advanced';
let activePanelId = 'chat-panel';
let activeGroupId = 'group-1';

interface TestChatTab {
  id: string;
  kind: string;
  messages: object[];
  queuedMessages: object[];
  status: string;
  pendingInitialCreation?: boolean;
}

const chatState: {
  chatStateSync: Record<string, { phase: string }>;
  worktreeChats: Record<string, { activeTabId: string; tabs: TestChatTab[] }>;
  openFileTab: typeof openFileTab;
} = {
  chatStateSync: { 'project-1/worktree-1': { phase: 'live' } },
  worktreeChats: {
    'project-1/worktree-1': {
      activeTabId: 'chat-1',
      tabs: [
        {
          id: 'chat-1',
          kind: 'chat',
          messages: [],
          queuedMessages: [],
          status: 'idle',
        },
      ],
    },
  },
  openFileTab,
};

jest.mock('@/hooks/useCanopyDesktopStartPageEnabled', () => ({
  isCanopyDesktopStartPageEnabled: (): boolean => true,
}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): typeof chatState => chatState,
    subscribe: jest.fn((subscriber: () => void) => {
      chatSubscriber = subscriber;
      return jest.fn();
    }),
  },
}));
jest.mock('@/stores/chat/slices/revisioned', () => ({
  waitForChatScopeLive: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('@/stores/chat/revisioned-sync', () => ({
  chatScopeKey: (projectId: string, worktreeId: string): string =>
    `${projectId}/${worktreeId}`,
}));
jest.mock('@/stores/browserStore', () => ({
  useBrowserStore: {
    getState: (): object => ({
      localServersOnly: false,
      openUrlFromDevServer,
      destroyBrowser,
    }),
  },
}));
jest.mock('@/stores/workspaceLayoutModeStore', () => ({
  getWorkspaceLayoutMode: (): string => workspaceMode,
}));
jest.mock('@/stores/panelLayoutStore', () => ({
  findPanelByInstanceKey: (
    _key: string,
    instanceKey: string,
  ): object | null => {
    if (instanceKey.startsWith('chat:')) {
      return {
        layoutKey: 'project-1/worktree-1',
        groupId: 'group-1',
        panelId: 'chat-panel',
      };
    }
    if (instanceKey.startsWith('browser:')) {
      return {
        layoutKey: 'project-1/worktree-1',
        groupId: 'group-2',
        panelId: 'browser-panel',
      };
    }
    if (!filePanelMaterialized) return null;
    return {
      layoutKey: 'project-1/worktree-1',
      groupId: 'group-1',
      panelId: 'file-panel',
    };
  },
  usePanelLayoutStore: {
    subscribe: jest.fn((subscriber: () => void) => {
      panelSubscriber = subscriber;
      return jest.fn();
    }),
    getState: (): object => ({
      layouts: {
        'project-1/worktree-1': {
          activeGroupId,
          groups: { [activeGroupId]: { activePanelId } },
        },
      },
      selectTab,
      reorderTab,
      movePanel,
    }),
  },
}));
jest.mock('@/lib/file-viewer/initial-view-mode', () => ({
  initialFileTabViewMode: (): string => 'preview',
}));
jest.mock('@/lib/openFileInBrowserPanel', () => ({ openFileInBrowserPanel }));
jest.mock('@/lib/browserPanelActivation', () => ({ requestBrowserPanel }));
jest.mock('@/lib/browserUrl', () => ({
  normalizeInAppBrowserInput: (url: string): string => url,
}));
jest.mock('@/lib/start-page/project-start-page', () => ({
  isHtmlStartPagePath: (path: string): boolean => path.endsWith('.html'),
  resolveStartPageAbsolutePath,
}));
jest.mock('../hydration-generation', () => ({
  isPanelHydrationGenerationCurrent: refreshGeneration,
}));

import { markStartPageSuppressed, maybeOpenStartPage } from '../start-page';

function openStartPage(
  worktreeKey: string,
  generation: number,
  createdLayout: boolean,
): Promise<void> {
  return maybeOpenStartPage(
    worktreeKey,
    generation,
    createdLayout,
    (operation) => operation(),
  );
}

async function waitForCall(mock: jest.Mock): Promise<void> {
  for (
    let attempt = 0;
    attempt < 20 && mock.mock.calls.length === 0;
    attempt++
  ) {
    await Promise.resolve();
  }
  expect(mock).toHaveBeenCalled();
}

describe('maybeOpenStartPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chatSubscriber = undefined;
    panelSubscriber = undefined;
    filePanelMaterialized = true;
    refreshGeneration.mockReturnValue(true);
    workspaceMode = 'advanced';
    activePanelId = 'chat-panel';
    activeGroupId = 'group-1';
    chatState.worktreeChats['project-1/worktree-1'].tabs[0] = {
      id: 'chat-1',
      kind: 'chat',
      messages: [],
      queuedMessages: [],
      status: 'idle',
    };
    // Opening a file tab makes its panel the one showing in the group.
    openFileTab.mockImplementation(() => {
      activePanelId = 'file-panel';
      return 'file-1';
    });
    openFileInBrowserPanel.mockImplementation(
      (
        _projectId: string,
        _worktreeId: string,
        _absolutePath: string,
        options?: { focus?: boolean },
      ) => {
        if (options?.focus !== false) activePanelId = 'browser-panel';
        return Promise.resolve('browser-file-1');
      },
    );
    openUrlFromDevServer.mockReturnValue({
      browserId: 'browser-url-1',
      createdNewSession: true,
      ready: Promise.resolve(null),
    });
    destroyBrowser.mockResolvedValue(undefined);
    requestBrowserPanel.mockImplementation(
      (
        _projectId: string,
        _worktreeId: string,
        _browserId: string,
        _originChatTabId?: string,
        options?: { focus?: boolean },
      ) => {
        if (options?.focus !== false) activePanelId = 'browser-panel';
        return Promise.resolve(true);
      },
    );
    resolveStartPageAbsolutePath.mockReturnValue('/repo/README.md');
    Object.assign(window, {
      api: {
        resolveProjectStartPage: jest.fn(() =>
          Promise.resolve({
            startPage: { kind: 'file', path: 'README.md' },
            source: 'local',
          }),
        ),
        getFileTreeRoots: jest.fn(() =>
          Promise.resolve({
            roots: [
              {
                repoId: 'repo-1',
                repoName: 'Repo',
                rootKind: 'git-repo',
                absolutePath: '/repo',
              },
            ],
          }),
        ),
        readFileContent: jest.fn(() => Promise.resolve({ content: '# Hi' })),
      },
    });
  });

  it('suppresses a session created with a prompt', async () => {
    markStartPageSuppressed('project-1/worktree-1');
    await openStartPage('project-1/worktree-1', 0, true);
    expect(window.api.resolveProjectStartPage).not.toHaveBeenCalled();
  });

  it('opens a Markdown file first and keeps New Chat beside it', async () => {
    await openStartPage('project-1/worktree-1', 0, true);
    expect(openFileTab).toHaveBeenCalledWith(
      {
        absolutePath: '/repo/README.md',
        filename: 'README.md',
        initialViewMode: 'preview',
      },
      { projectId: 'project-1', worktreeId: 'worktree-1' },
    );
    expect(reorderTab).toHaveBeenCalledWith(
      'project-1/worktree-1',
      'group-1',
      'file-panel',
      0,
    );
    expect(selectTab).toHaveBeenCalledWith(
      'project-1/worktree-1',
      'group-1',
      'file-panel',
      { focus: true },
    );
  });

  it('places a file start page first once its panel materializes', async () => {
    // The chat-panel sync creates a file tab's panel on a later microtask,
    // so it does not exist yet when `openFileTab` returns.
    filePanelMaterialized = false;
    const opening = openStartPage('project-1/worktree-1', 0, true);
    await waitForCall(openFileTab);
    for (let attempt = 0; attempt < 20 && !panelSubscriber; attempt++) {
      await Promise.resolve();
    }
    expect(reorderTab).not.toHaveBeenCalled();

    filePanelMaterialized = true;
    panelSubscriber?.();
    await opening;
    expect(reorderTab).toHaveBeenCalledWith(
      'project-1/worktree-1',
      'group-1',
      'file-panel',
      0,
    );
    expect(selectTab).toHaveBeenCalledWith(
      'project-1/worktree-1',
      'group-1',
      'file-panel',
      { focus: true },
    );
  });

  it.each([
    ['another tab', 'other-panel'],
    ['the chat tab it started on', 'chat-panel'],
  ])(
    'leaves a file start page in place when the user picked %s while its panel was pending',
    async (_label, pickedPanelId) => {
      filePanelMaterialized = false;
      const opening = openStartPage('project-1/worktree-1', 0, true);
      await waitForCall(openFileTab);
      for (let attempt = 0; attempt < 20 && !panelSubscriber; attempt++) {
        await Promise.resolve();
      }

      activePanelId = pickedPanelId;
      filePanelMaterialized = true;
      panelSubscriber?.();
      await opening;
      expect(movePanel).not.toHaveBeenCalled();
      expect(reorderTab).not.toHaveBeenCalled();
      expect(selectTab).not.toHaveBeenCalled();
    },
  );

  it('places a file start page that opened in another group and left the active panel alone', async () => {
    // The file panel lands in a group that is not the active one, so the
    // chat panel is still active when the start page is placed.
    openFileTab.mockImplementation(() => 'file-1');
    activeGroupId = 'group-chat-only';
    await openStartPage('project-1/worktree-1', 0, true);
    expect(reorderTab).toHaveBeenCalledWith(
      'project-1/worktree-1',
      'group-1',
      'file-panel',
      0,
    );
    expect(selectTab).toHaveBeenCalled();
  });

  it('leaves a file start page in place when the hydration generation changes before its panel materializes', async () => {
    filePanelMaterialized = false;
    const opening = openStartPage('project-1/worktree-1', 0, true);
    await waitForCall(openFileTab);
    for (let attempt = 0; attempt < 20 && !panelSubscriber; attempt++) {
      await Promise.resolve();
    }

    refreshGeneration.mockReturnValue(false);
    filePanelMaterialized = true;
    panelSubscriber?.();
    await opening;
    expect(reorderTab).not.toHaveBeenCalled();
    expect(selectTab).not.toHaveBeenCalled();
  });

  it('does not open over an existing conversation', async () => {
    chatState.worktreeChats['project-1/worktree-1'].tabs[0].messages.push({});
    await openStartPage('project-1/worktree-1', 0, true);
    expect(window.api.resolveProjectStartPage).not.toHaveBeenCalled();
  });

  it('waits for pending initial chat creation', async () => {
    chatState.worktreeChats[
      'project-1/worktree-1'
    ].tabs[0].pendingInitialCreation = true;
    const opening = openStartPage('project-1/worktree-1', 0, true);
    await Promise.resolve();
    expect(window.api.resolveProjectStartPage).not.toHaveBeenCalled();
    chatState.worktreeChats[
      'project-1/worktree-1'
    ].tabs[0].pendingInitialCreation = false;
    chatSubscriber?.();
    await opening;
    expect(window.api.resolveProjectStartPage).toHaveBeenCalled();
  });

  it('opens HTML in a browser panel', async () => {
    resolveStartPageAbsolutePath.mockReturnValueOnce('/repo/index.html');
    await openStartPage('project-1/worktree-1', 0, true);
    expect(openFileInBrowserPanel).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      '/repo/index.html',
      { focus: false },
    );
    expect(openFileTab).not.toHaveBeenCalled();
    expect(destroyBrowser).not.toHaveBeenCalled();
    expect(movePanel).toHaveBeenCalled();
  });

  it('opens an HTTP URL in a browser panel', async () => {
    jest.mocked(window.api.resolveProjectStartPage).mockResolvedValueOnce({
      startPage: { kind: 'url', url: 'https://example.com' },
      source: 'source',
    });
    await openStartPage('project-1/worktree-1', 0, true);
    expect(openUrlFromDevServer).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      { url: 'https://example.com' },
    );
    expect(requestBrowserPanel).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-url-1',
      undefined,
      { focus: false },
    );
    expect(destroyBrowser).not.toHaveBeenCalled();
    expect(movePanel).toHaveBeenCalledWith(
      'project-1/worktree-1',
      'browser-panel',
      'group-1',
      'center',
      0,
    );
  });

  it('does not focus a URL start page after the active panel changes', async () => {
    let finishPanel: (placed: boolean) => void = () => undefined;
    requestBrowserPanel.mockReturnValueOnce(
      new Promise((resolve) => {
        finishPanel = resolve;
      }),
    );
    jest.mocked(window.api.resolveProjectStartPage).mockResolvedValueOnce({
      startPage: { kind: 'url', url: 'https://example.com' },
      source: 'source',
    });

    const opening = openStartPage('project-1/worktree-1', 0, true);
    await waitForCall(requestBrowserPanel);
    activePanelId = 'other-panel';
    finishPanel(true);
    await opening;

    expect(requestBrowserPanel).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-url-1',
      undefined,
      { focus: false },
    );
    expect(selectTab).not.toHaveBeenCalled();
    expect(destroyBrowser).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-url-1',
    );
  });

  it('does not focus an HTML start page after the active panel changes', async () => {
    let finishOpen: (browserId: string) => void = () => undefined;
    openFileInBrowserPanel.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOpen = resolve;
      }),
    );
    resolveStartPageAbsolutePath.mockReturnValueOnce('/repo/index.html');

    const opening = openStartPage('project-1/worktree-1', 0, true);
    await waitForCall(openFileInBrowserPanel);
    activePanelId = 'other-panel';
    finishOpen('browser-file-late');
    await opening;

    expect(selectTab).not.toHaveBeenCalled();
    expect(destroyBrowser).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-file-late',
    );
  });

  it('activates the start page without reordering in Minimal mode', async () => {
    workspaceMode = 'minimal';
    await openStartPage('project-1/worktree-1', 0, true);
    expect(reorderTab).not.toHaveBeenCalled();
    expect(selectTab).toHaveBeenCalledWith(
      'project-1/worktree-1',
      'group-1',
      'file-panel',
      { focus: true },
    );
  });

  it('falls back silently when a configured file is missing', async () => {
    jest.mocked(window.api.readFileContent).mockResolvedValueOnce({
      kind: 'missing',
      content: '',
      filename: 'README.md',
      sizeBytes: 0,
      truncated: false,
      modifiedAtMs: 0,
    });
    await openStartPage('project-1/worktree-1', 0, true);
    expect(openFileTab).not.toHaveBeenCalled();
    expect(openFileInBrowserPanel).not.toHaveBeenCalled();
  });

  it('aborts after a hydration generation change', async () => {
    refreshGeneration.mockReturnValueOnce(false);
    await openStartPage('project-1/worktree-1', 0, true);
    expect(window.api.resolveProjectStartPage).not.toHaveBeenCalled();
  });
});
