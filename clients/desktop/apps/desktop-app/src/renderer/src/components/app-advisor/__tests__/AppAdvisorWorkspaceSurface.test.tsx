/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppAdvisorWorkspaceSurface } from '@/components/app-advisor/AppAdvisorWorkspaceSurface';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { requestBrowserPanel } from '@/lib/browserPanelActivation';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const panelGridSurfaceMock = jest.fn<JSX.Element, [Record<string, unknown>]>(
  (props: Record<string, unknown>): JSX.Element => {
    void props;
    return <div data-testid="mock-panel-grid" />;
  },
);
jest.mock('@/components/panels/PanelGridSurface', () => ({
  PanelGridSurface: (props: Record<string, unknown>): JSX.Element =>
    panelGridSurfaceMock(props),
}));
jest.mock('@/components/app-advisor/AppAdvisorNav', () => ({
  AppAdvisorNav: (): JSX.Element => <div data-testid="mock-nav" />,
}));
jest.mock('@/components/app-advisor/AppAdvisorTopBar', () => ({
  AppAdvisorTopBar: (): JSX.Element => <div data-testid="mock-top-bar" />,
}));
jest.mock('@/components/standalone-chat/CoworkArchiveOverlay', () => ({
  CoworkArchiveOverlay: (): null => null,
}));
const floatingSurfaceMock = jest.fn<JSX.Element, [Record<string, unknown>]>(
  (props: Record<string, unknown>): JSX.Element => {
    void props;
    return <div data-testid="mock-floating" />;
  },
);
jest.mock('@/components/app-advisor/AppAdvisorFloatingSurface', () => ({
  AppAdvisorFloatingSurface: (props: Record<string, unknown>): JSX.Element =>
    floatingSurfaceMock(props),
}));
const ensureWorktreePanelLayoutMock = jest.fn((key: string): Promise<void> => {
  void key;
  return Promise.resolve();
});
jest.mock('@/lib/panels/persistence-bridge', () => ({
  ensureWorktreePanelLayout: (key: string): Promise<void> =>
    ensureWorktreePanelLayoutMock(key),
}));
let mockDirtyFileTabIds: readonly string[] = [];
jest.mock('@/lib/file-viewer/desktop-file-session-controller', () => ({
  desktopFileSessionController: {
    isDirty: (tabId: string): boolean => mockDirtyFileTabIds.includes(tabId),
  },
  useDesktopFileSessionRevision: (): number => 0,
}));
const initBrowserPanelActivationMock = jest.fn();
jest.mock('@/lib/panels/browser-panel-activation', () => ({
  initBrowserPanelActivation: (): void => {
    initBrowserPanelActivationMock();
  },
}));

function flushTimers(ms: number): void {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AppAdvisorWorkspaceSurface', () => {
  let container: HTMLDivElement;
  let root: Root;
  let initializeScopedMock: jest.Mock;
  let reportWindowUiStateMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    initializeScopedMock = jest.fn().mockResolvedValue(undefined);
    reportWindowUiStateMock = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: jest
          .fn()
          .mockResolvedValue({ appAdvisorNavCollapsed: false }),
        savePreferences: jest.fn().mockResolvedValue(undefined),
        chat: { onChatEvent: jest.fn().mockReturnValue(jest.fn()) },
        appAdvisor: { reportWindowUiState: reportWindowUiStateMock },
      },
    });
    useStandaloneChatStore.setState({
      initialized: true,
      scopedWorkspaceId: 'app-advisor',
      activeChatProjectId: 'app-advisor',
      activeWorkEntryId: 'entry-1',
      workEntries: [],
      initializeScoped: initializeScopedMock,
      refreshWorkEntries: jest.fn().mockResolvedValue(undefined),
    });
    useChatStore.setState({
      worktreeChats: {
        'app-advisor/entry-1': {
          tabs: [],
          activeTabId: 'chat-9',
        },
      },
    } as unknown as Parameters<typeof useChatStore.setState>[0]);
    useProjectsStore.setState({
      subscribeToDiscoveryEvents: jest.fn().mockReturnValue(jest.fn()),
    } as unknown as Parameters<typeof useProjectsStore.setState>[0]);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  function render(settingsModalOpen = false): void {
    act(() => {
      root.render(
        <AppAdvisorWorkspaceSurface
          settingsModalOpen={settingsModalOpen}
          onOpenSettings={jest.fn()}
        />,
      );
    });
  }

  it('bootstraps the scoped store and renders the ready project', async () => {
    render();
    await flush();
    expect(initializeScopedMock).toHaveBeenCalledWith('app-advisor');
    expect(
      container.querySelector('[data-testid="mock-panel-grid"]'),
    ).toBeTruthy();
    expect(container.querySelector('[data-testid="mock-nav"]')).toBeTruthy();
    expect(
      container.querySelector('[data-testid="mock-top-bar"]'),
    ).toBeTruthy();
  });

  it('expands the floating panel to the full window for archive views', async () => {
    const expandDialog = jest.fn();
    const appAdvisorBefore = useAppAdvisorStore.getState();
    const archivedBefore = useArchivedContainersStore.getState();
    const hasFocus = jest.spyOn(document, 'hasFocus').mockReturnValue(true);
    useAppAdvisorStore.setState({
      layout: 'floating',
      open: true,
      expandDialog,
    });
    try {
      render();
      await flush();
      expect(
        container.querySelector('[data-testid="mock-floating"]'),
      ).toBeTruthy();
      expect(expandDialog).not.toHaveBeenCalled();

      // Empty trash only confirms in the full window, so it expands there.
      act(() => {
        useArchivedContainersStore.setState({
          emptyTrashConfirmationWorkspaceId: 'app-advisor',
        });
      });
      expect(expandDialog).toHaveBeenCalledTimes(1);
    } finally {
      hasFocus.mockRestore();
      useAppAdvisorStore.setState(appAdvisorBefore, true);
      useArchivedContainersStore.setState(archivedBefore, true);
    }
  });

  it('leaves a hidden or background App Advisor alone for an archive view', async () => {
    const expandDialog = jest.fn();
    const appAdvisorBefore = useAppAdvisorStore.getState();
    const archivedBefore = useArchivedContainersStore.getState();
    const hasFocus = jest.spyOn(document, 'hasFocus').mockReturnValue(false);
    useAppAdvisorStore.setState({
      layout: 'floating',
      open: false,
      expandDialog,
    });
    try {
      render();
      await flush();
      act(() => {
        useArchivedContainersStore.setState({
          emptyTrashConfirmationWorkspaceId: 'app-advisor',
        });
      });
      // Hidden: nothing shows or takes focus.
      expect(expandDialog).not.toHaveBeenCalled();

      // Shown while the person works in another app: still left alone.
      act(() => useAppAdvisorStore.setState({ open: true }));
      expect(expandDialog).not.toHaveBeenCalled();

      // The person comes back to the panel: it expands for the archive view.
      hasFocus.mockReturnValue(true);
      act(() => useAppAdvisorStore.setState({ open: false }));
      act(() => useAppAdvisorStore.setState({ open: true }));
      expect(expandDialog).toHaveBeenCalledTimes(1);
    } finally {
      hasFocus.mockRestore();
      useAppAdvisorStore.setState(appAdvisorBefore, true);
      useArchivedContainersStore.setState(archivedBefore, true);
    }
  });

  it('expands the floating panel to the full window for an App Advisor browser', async () => {
    const expandDialog = jest.fn();
    const appAdvisorBefore = useAppAdvisorStore.getState();
    useAppAdvisorStore.setState({
      layout: 'floating',
      open: true,
      expandDialog,
    });
    try {
      render();
      await flush();
      // The grid's activation bridge is installed while floating, so the
      // request queues for the full layout's grid instead of being dropped.
      expect(initBrowserPanelActivationMock).toHaveBeenCalled();

      void requestBrowserPanel('other-project', 'worktree-1', 'browser-0');
      expect(expandDialog).not.toHaveBeenCalled();

      // Agent background work leaves the user's focus alone, and still
      // lands: the entry's panel layout loads for the activation bridge.
      void requestBrowserPanel(
        'app-advisor',
        'entry-1',
        'browser-2',
        undefined,
        {
          focus: false,
        },
      );
      expect(expandDialog).not.toHaveBeenCalled();
      expect(ensureWorktreePanelLayoutMock).toHaveBeenCalledWith(
        'app-advisor/entry-1',
      );

      void requestBrowserPanel('app-advisor', 'entry-1', 'browser-1');
      expect(expandDialog).toHaveBeenCalledTimes(1);

      // Closed, App Advisor does not reappear for it.
      act(() => useAppAdvisorStore.setState({ open: false }));
      void requestBrowserPanel('app-advisor', 'entry-1', 'browser-3');
      expect(expandDialog).toHaveBeenCalledTimes(1);
    } finally {
      useAppAdvisorStore.setState(appAdvisorBefore, true);
    }
  });

  it('keeps the full layout free of the floating browser bridge', async () => {
    const expandDialog = jest.fn();
    const appAdvisorBefore = useAppAdvisorStore.getState();
    useAppAdvisorStore.setState({ layout: 'full', expandDialog });
    try {
      render();
      await flush();
      void requestBrowserPanel('app-advisor', 'entry-1', 'browser-1');
      expect(expandDialog).not.toHaveBeenCalled();
      expect(initBrowserPanelActivationMock).not.toHaveBeenCalled();
    } finally {
      useAppAdvisorStore.setState(appAdvisorBefore, true);
    }
  });

  it('expands the floating panel when a file tab opens in its chat', async () => {
    const expandDialog = jest.fn();
    const appAdvisorBefore = useAppAdvisorStore.getState();
    const hasFocus = jest.spyOn(document, 'hasFocus').mockReturnValue(true);
    useAppAdvisorStore.setState({ layout: 'floating', expandDialog });
    useChatStore.setState({
      worktreeChats: {
        'app-advisor/entry-1': {
          tabs: [{ id: 'chat-9', kind: 'chat' }],
          activeTabId: 'chat-9',
        },
      },
    } as unknown as Parameters<typeof useChatStore.setState>[0]);
    try {
      render();
      await flush();
      expect(expandDialog).not.toHaveBeenCalled();

      // A file link the person clicks (App Advisor focused) opens and
      // selects a file tab, which only the full layout's panels can show.
      act(() => {
        useChatStore.setState({
          worktreeChats: {
            'app-advisor/entry-1': {
              tabs: [
                { id: 'chat-9', kind: 'chat' },
                { id: 'file-1', kind: 'file' },
              ],
              activeTabId: 'file-1',
            },
          },
        } as unknown as Parameters<typeof useChatStore.setState>[0]);
      });
      expect(expandDialog).toHaveBeenCalledTimes(1);
    } finally {
      hasFocus.mockRestore();
      useAppAdvisorStore.setState(appAdvisorBefore, true);
    }
  });

  it('leaves the panel floating for a file an agent opens in the background', async () => {
    const expandDialog = jest.fn();
    const appAdvisorBefore = useAppAdvisorStore.getState();
    const switchTab = jest.fn();
    const chatBefore = useChatStore.getState();
    // The person is working elsewhere: App Advisor does not have focus.
    const hasFocus = jest.spyOn(document, 'hasFocus').mockReturnValue(false);
    useAppAdvisorStore.setState({ layout: 'floating', expandDialog });
    // The person has the entry's second chat open.
    useChatStore.setState({
      switchTab,
      worktreeChats: {
        'app-advisor/entry-1': {
          tabs: [
            { id: 'chat-9', kind: 'chat' },
            { id: 'chat-b', kind: 'chat' },
          ],
          activeTabId: 'chat-b',
        },
      },
    } as unknown as Parameters<typeof useChatStore.setState>[0]);
    try {
      render();
      await flush();
      act(() => {
        useChatStore.setState({
          worktreeChats: {
            'app-advisor/entry-1': {
              tabs: [
                { id: 'chat-9', kind: 'chat' },
                { id: 'chat-b', kind: 'chat' },
                { id: 'file-1', kind: 'file' },
              ],
              activeTabId: 'file-1',
            },
          },
        } as unknown as Parameters<typeof useChatStore.setState>[0]);
      });
      expect(expandDialog).not.toHaveBeenCalled();
      // The panel keeps showing that chat; the file waits as a tab.
      expect(switchTab).toHaveBeenCalledTimes(1);
      expect(switchTab).toHaveBeenCalledWith('chat-b', {
        projectId: 'app-advisor',
        worktreeId: 'entry-1',
      });
    } finally {
      hasFocus.mockRestore();
      useAppAdvisorStore.setState(appAdvisorBefore, true);
      useChatStore.setState({ switchTab: chatBefore.switchTab });
    }
  });

  it('opens floating on a chat when the full layout left a file tab active', async () => {
    const expandDialog = jest.fn();
    const appAdvisorBefore = useAppAdvisorStore.getState();
    const switchTab = jest.fn();
    const chatBefore = useChatStore.getState();
    useAppAdvisorStore.setState({ layout: 'floating', expandDialog });
    useChatStore.setState({
      switchTab,
      worktreeChats: {
        'app-advisor/entry-1': {
          tabs: [
            { id: 'chat-9', kind: 'chat' },
            { id: 'file-1', kind: 'file' },
          ],
          activeTabId: 'file-1',
        },
      },
    } as unknown as Parameters<typeof useChatStore.setState>[0]);
    try {
      render();
      await flush();
      // Opening floating is not a request for the file: it shows the chat.
      expect(expandDialog).not.toHaveBeenCalled();
      expect(switchTab).toHaveBeenCalledWith('chat-9', {
        projectId: 'app-advisor',
        worktreeId: 'entry-1',
      });
    } finally {
      useAppAdvisorStore.setState(appAdvisorBefore, true);
      useChatStore.setState({ switchTab: chatBefore.switchTab });
    }
  });

  it('shows the loading gate until the scoped project and entry are ready', async () => {
    useStandaloneChatStore.setState({
      initialized: false,
      activeWorkEntryId: null,
    });
    render();
    await flush();
    expect(
      container.querySelector('[data-testid="app-advisor-workspace-loading"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="mock-panel-grid"]'),
    ).toBeNull();
    // The nav (and main column shell) stays mounted even while loading.
    expect(container.querySelector('[data-testid="mock-nav"]')).toBeTruthy();
  });

  it('keys the grid to the active entry and exposes full panel parity', async () => {
    render();
    await flush();
    const calls = panelGridSurfaceMock.mock.calls;
    const props = calls[calls.length - 1][0];
    expect(props.projectId).toBe('app-advisor');
    expect(props.worktreeId).toBe('entry-1');
    expect(props.includeAuxWindowContent).toBe(true);
    expect(props.addMenuExcludeKinds).toBeUndefined();
  });

  it('refreshes work-entry metadata while the popout is visible', async () => {
    render();
    await flush();
    const refreshWorkEntries =
      useStandaloneChatStore.getState().refreshWorkEntries;

    expect(refreshWorkEntries).not.toHaveBeenCalled();
    flushTimers(1_500);
    await flush();

    expect(refreshWorkEntries).toHaveBeenCalledTimes(1);
    expect(refreshWorkEntries).toHaveBeenCalledWith('app-advisor');
  });

  it('reports an unsent draft, so the main process keeps the page', async () => {
    const before = useChatStore.getState();
    useChatStore.setState({ composerTextPresent: { 'chat-9': true } });
    try {
      render();
      await flush();
      flushTimers(300);
      await flush();
      expect(reportWindowUiStateMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ hasUnsentDraft: true }),
      );
    } finally {
      useChatStore.setState(before, true);
    }
  });

  it('reports a draft that holds only a file reference as unsent', async () => {
    const before = useChatStore.getState();
    useChatStore.setState({
      tabDrafts: {
        'chat-9': [
          {
            type: 'paragraph',
            children: [
              { text: '' },
              {
                type: 'file-reference',
                displayPath: 'notes.md',
                absolutePath: '/tmp/notes.md',
                children: [{ text: '' }],
              },
              { text: '' },
            ],
          },
        ],
      },
    } as unknown as Parameters<typeof useChatStore.setState>[0]);
    try {
      render();
      await flush();
      flushTimers(300);
      await flush();
      expect(reportWindowUiStateMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ hasUnsentDraft: true }),
      );
    } finally {
      useChatStore.setState(before, true);
    }
  });

  it('reports a file tab with unsaved edits, so the page is kept', async () => {
    const before = useChatStore.getState();
    mockDirtyFileTabIds = ['file-1'];
    useChatStore.setState({
      worktreeChats: {
        'app-advisor/entry-1': {
          tabs: [
            { id: 'chat-9', kind: 'chat' },
            { id: 'file-1', kind: 'file' },
          ],
          activeTabId: 'chat-9',
        },
      },
    } as unknown as Parameters<typeof useChatStore.setState>[0]);
    try {
      render();
      await flush();
      flushTimers(300);
      await flush();
      expect(reportWindowUiStateMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ hasUnsentDraft: true }),
      );
    } finally {
      mockDirtyFileTabIds = [];
      useChatStore.setState(before, true);
    }
  });

  it('reports a draft that holds only attachments as unsent', async () => {
    const before = useChatStore.getState();
    useChatStore.setState({
      worktreeChats: {
        'app-advisor/entry-1': {
          tabs: [
            {
              id: 'chat-9',
              kind: 'chat',
              pendingAttachments: [{ path: '/tmp/a.png' }],
            },
          ],
          activeTabId: 'chat-9',
        },
      },
    } as unknown as Parameters<typeof useChatStore.setState>[0]);
    try {
      render();
      await flush();
      flushTimers(300);
      await flush();
      expect(reportWindowUiStateMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ hasUnsentDraft: true }),
      );
    } finally {
      useChatStore.setState(before, true);
    }
  });

  it('reports throttled UI state with ids and booleans only', async () => {
    render();
    await flush();
    expect(reportWindowUiStateMock).not.toHaveBeenCalled();
    flushTimers(300);
    await flush();
    expect(reportWindowUiStateMock).toHaveBeenCalledTimes(1);
    expect(reportWindowUiStateMock).toHaveBeenCalledWith({
      groupEditorId: null,
      activeWorkEntryId: 'entry-1',
      activeChatId: 'chat-9',
      navCollapsed: false,
      settingsModalOpen: false,
      archivedOverviewOpen: false,
      archivedOverviewWorkspaceId: null,
      emptyTrashConfirmationOpen: false,
      emptyTrashRunning: false,
      lastArchivedOverviewRequestId: null,
      lastArchivedOverviewConfirmationOpened: null,
      hasUnsentDraft: false,
    });
    const payload = reportWindowUiStateMock.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    for (const value of Object.values(payload[0])) {
      expect(
        value === null || ['string', 'boolean'].includes(typeof value),
      ).toBe(true);
    }

    // A semantic change (entry switch) produces exactly one more report;
    // unchanged renders do not re-report.
    act(() => {
      useStandaloneChatStore.setState({ activeWorkEntryId: 'entry-2' });
    });
    await flush();
    flushTimers(300);
    await flush();
    expect(reportWindowUiStateMock).toHaveBeenCalledTimes(2);
    expect(reportWindowUiStateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeWorkEntryId: 'entry-2' }),
    );
  });
});
