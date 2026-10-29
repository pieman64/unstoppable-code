/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  getDefaultFeatureFlagSnapshot,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import type {
  AppAdvisorWindowCommand,
  ArchivedContainerSummary,
} from '@canopy/desktop-shared/types';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import {
  initializeClaudeTerminalChatSync,
  useChatStore,
} from '@/stores/chatStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  useSurfaceFindStore,
  type FindController,
} from '@/stores/surfaceFindStore';
import { applyDisplayPreferences } from '@/lib/theme';
import { UsageLimitResumeModal } from '@/components/usage-limit/UsageLimitResumeModal';
import { makeWorktreePanelKey } from '@/stores/panelLayoutStore';
import type * as PanelLayoutStoreModule from '@/stores/panelLayoutStore';
import { AppAdvisorWindowApp } from '../AppAdvisorWindowApp';

const mockGetPanelLayoutViewModel = jest.fn<
  ReturnType<typeof PanelLayoutStoreModule.getPanelLayoutViewModel> | undefined,
  [string]
>(() => undefined);

jest.mock('@/stores/panelLayoutStore', () => {
  const actual = jest.requireActual<typeof PanelLayoutStoreModule>(
    '@/stores/panelLayoutStore',
  );
  return {
    ...actual,
    getPanelLayoutViewModel: (
      key: string,
    ): ReturnType<typeof PanelLayoutStoreModule.getPanelLayoutViewModel> =>
      mockGetPanelLayoutViewModel(key) ?? actual.getPanelLayoutViewModel(key),
  };
});

const mockOpenSubagentChatPanel = jest
  .fn()
  .mockResolvedValue({ status: 'placed' });
jest.mock('@/lib/panels/subagent-panel-open', () => ({
  openSubagentChatPanel: (...args: unknown[]): unknown =>
    mockOpenSubagentChatPanel(...args),
}));

const mockEnsureBrowserEventSubscription = jest.fn<void, []>();

jest.mock('@/stores/browserEventSubscription', () => ({
  ensureBrowserEventSubscription: (): void => {
    mockEnsureBrowserEventSubscription();
  },
}));

jest.mock('@/components/shared/ToastContainer', () => ({
  ToastContainer: (): null => null,
}));

jest.mock('@/hooks/useChatEventSubscriptions', () => ({
  useChatEventSubscriptions: jest.fn(),
}));

jest.mock('@/lib/chat-interest', () => ({
  useChatInterestDeclaration: jest.fn(),
}));

jest.mock('@/lib/renderer-diagnostics', () => ({
  useRendererDiagnostics: jest.fn(),
}));

jest.mock('@/stores/chat/stale-catch-up', () => ({
  useStaleChatCatchUp: jest.fn(),
}));

const mockUsePipelineRunsBridge = jest.fn();

jest.mock('@/hooks/usePipelineRunsBridge', () => ({
  usePipelineRunsBridge: (options: { trackGlobalStatus: boolean }): void => {
    mockUsePipelineRunsBridge(options);
  },
}));

jest.mock('@/stores/chatStore', () => ({
  initializeClaudeTerminalChatSync: jest.fn((): (() => void) => jest.fn()),
  useChatStore: {
    getState: jest.fn(),
    setState: jest.fn(),
  },
}));

jest.mock('@/components/app-advisor/AppAdvisorWorkspaceSurface', () => ({
  AppAdvisorWorkspaceSurface: (): null => null,
}));

jest.mock('@/components/app-advisor/AppAdvisorSettingsModal', () => ({
  AppAdvisorSettingsModal: (): null => null,
}));

jest.mock('@/components/app-advisor/AppAdvisorRuntimeBridge', () => ({
  AppAdvisorWindowRuntimeBridge: (): null => null,
}));

jest.mock('@/components/usage-limit/UsageLimitResumeModal', () => ({
  UsageLimitResumeModal: jest.fn((): null => null),
}));

jest.mock('@/lib/theme', () => ({
  applyTheme: jest.fn(),
  applyUiScale: jest.fn(),
  applyDisplayPreferences: jest.fn(),
}));

jest.mock('@/stores/appAdvisorStore', () => ({
  useAppAdvisorStore: Object.assign(
    (selector: (state: { layout: string }) => unknown): unknown =>
      selector({ layout: 'full' }),
    { getState: jest.fn() },
  ),
}));

jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: jest.fn(),
  },
}));

jest.mock('@/stores/featureFlagsStore', () => ({
  useFeatureFlagsStore: {
    getState: jest.fn(),
  },
}));

const mockGetBrowserState = jest.fn();
const mockSetLocalServersOnly = jest.fn();
const mockSetOpenAppLinksInBuiltInBrowser = jest.fn();
jest.mock('@/stores/browserStore', () => ({
  useBrowserStore: {
    getState: (): unknown => mockGetBrowserState(),
  },
}));

const mockRequestBrowserUrlFocus = jest.fn<void, [string]>();
jest.mock('@/lib/browserUrlFocus', () => ({
  requestBrowserUrlFocus: (browserId: string): void =>
    mockRequestBrowserUrlFocus(browserId),
}));

const mockRunNewTabShortcut = jest.fn();
jest.mock('@/lib/newTabShortcut', () => ({
  runNewTabShortcut: (params: unknown): unknown =>
    mockRunNewTabShortcut(params),
}));

const mockRunCloseTabShortcut = jest.fn();
const mockHasCloseableTabForShortcut = jest.fn();
jest.mock('@/lib/closeTabShortcut', () => ({
  runCloseTabShortcut: (params: unknown): unknown =>
    mockRunCloseTabShortcut(params),
  hasCloseableTabForShortcut: (params: unknown): unknown =>
    mockHasCloseableTabForShortcut(params),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const getAppAdvisorStateMock = jest.mocked(useAppAdvisorStore.getState);
const getStandaloneStateMock = jest.mocked(useStandaloneChatStore.getState);
const getChatStateMock = jest.mocked(useChatStore.getState);
const setChatStateMock = jest.mocked(useChatStore.setState);
const getFeatureFlagsStateMock = jest.mocked(useFeatureFlagsStore.getState);
const initializeClaudeTerminalChatSyncMock = jest.mocked(
  initializeClaudeTerminalChatSync,
);
const usageLimitResumeModalMock = jest.mocked(UsageLimitResumeModal);

function flushPromises(): Promise<void> {
  return act(async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deletedSummary(projectId = 'app-advisor'): ArchivedContainerSummary {
  return {
    version: 1,
    id: 'deleted-entry',
    projectId,
    kind: 'work-entry',
    name: 'Deleted entry',
    createdAt: '2026-09-01T00:00:00.000Z',
    archivedAt: '2026-09-02T00:00:00.000Z',
    retentionDays: 7,
    expiresAt: '2026-09-09T00:00:00.000Z',
    chatCount: 1,
    archivedChatCount: 0,
    executionCount: 0,
  };
}

describe('AppAdvisorWindowApp command handling', () => {
  let root: Root;
  let container: HTMLDivElement;
  let loadPreferencesMock: jest.Mock;
  let commandListener: (command: AppAdvisorWindowCommand) => void;
  let preferencesSyncedListener: (preferences: unknown) => void;
  let applyDeferredToolsDefaultsMock: jest.Mock<void, [unknown]>;
  let applyModelDefaultsMock: jest.Mock<void, [unknown]>;
  let applyScopedPreferencesMock: jest.Mock<void, [unknown]>;
  let applyPreferencesMock: jest.Mock<void, [unknown]>;
  let hydrateFeatureFlagsMock: jest.Mock<Promise<void>, []>;
  let setFeatureFlagSnapshotMock: jest.Mock<void, [FeatureFlagSnapshot]>;
  let featureFlagSnapshotListener: (snapshot: FeatureFlagSnapshot) => void;
  let unsubscribeFeatureFlagsMock: jest.Mock<void, []>;
  let hydrateForNavigationMock: jest.Mock<Promise<void>, []>;
  let syncWindowStateMock: jest.Mock<void, [unknown]>;
  let closeDialogMock: jest.Mock<void, []>;
  let initializeScopedMock: jest.Mock<Promise<boolean>, [string]>;
  let selectChatMock: jest.Mock<Promise<void>, [string]>;
  let closeArchiveOverlayMock: jest.Mock<void, []>;
  let createWorkEntryChatWithMessageMock: jest.Mock<
    Promise<string>,
    [Record<string, unknown>]
  >;
  let chatSendMessageMock: jest.Mock<Promise<void>, [string, ...unknown[]]>;
  let loadTabsForTargetMock: jest.Mock;
  let resolveChatMock: jest.Mock;
  let acknowledgeWatcherMessageDeliveryMock: jest.Mock<
    Promise<{ ok: true }>,
    [{ watcherId: string; deliveryId: string; ok: boolean; error?: string }]
  >;
  let browserBackMock: jest.Mock;
  let browserForwardMock: jest.Mock;
  let applyBrowserSnapshotMock: jest.Mock;
  let worktreeChats: Record<
    string,
    { tabs: Array<{ id: string; readOnly?: boolean }>; activeTabId: string }
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    mockHasCloseableTabForShortcut.mockReturnValue(false);
    mockRunCloseTabShortcut.mockReturnValue(false);
    applyDeferredToolsDefaultsMock = jest.fn<void, [unknown]>();
    applyModelDefaultsMock = jest.fn<void, [unknown]>();
    applyScopedPreferencesMock = jest.fn<void, [unknown]>();
    applyPreferencesMock = jest.fn<void, [unknown]>();
    hydrateFeatureFlagsMock = jest
      .fn<Promise<void>, []>()
      .mockResolvedValue(undefined);
    setFeatureFlagSnapshotMock = jest.fn<void, [FeatureFlagSnapshot]>();
    featureFlagSnapshotListener = (): void => {};
    unsubscribeFeatureFlagsMock = jest.fn<void, []>();
    hydrateForNavigationMock = jest
      .fn<Promise<void>, []>()
      .mockResolvedValue(undefined);
    syncWindowStateMock = jest.fn<void, [unknown]>();
    closeDialogMock = jest.fn<void, []>();
    initializeScopedMock = jest
      .fn<Promise<boolean>, [string]>()
      .mockResolvedValue(true);
    selectChatMock = jest
      .fn<Promise<void>, [string]>()
      .mockResolvedValue(undefined);
    closeArchiveOverlayMock = jest.fn<void, []>();
    createWorkEntryChatWithMessageMock = jest
      .fn<Promise<string>, [Record<string, unknown>]>()
      .mockResolvedValue('chat-id');
    chatSendMessageMock = jest
      .fn<Promise<void>, [string, ...unknown[]]>()
      .mockResolvedValue(undefined);
    loadTabsForTargetMock = jest.fn().mockResolvedValue(undefined);
    resolveChatMock = jest
      .fn()
      .mockResolvedValue({ entryId: 'entry-1', archivedInEntryId: null });
    worktreeChats = {
      'app-advisor/entry-1': {
        tabs: [{ id: 'advisor-1' }],
        activeTabId: 'advisor-1',
      },
    };
    acknowledgeWatcherMessageDeliveryMock = jest
      .fn<
        Promise<{ ok: true }>,
        [{ watcherId: string; ok: boolean; error?: string }]
      >()
      .mockResolvedValue({ ok: true });
    browserBackMock = jest.fn().mockResolvedValue({ id: 'browser-1' });
    browserForwardMock = jest.fn().mockResolvedValue({ id: 'browser-1' });
    applyBrowserSnapshotMock = jest.fn();
    mockGetBrowserState.mockReturnValue({
      worktrees: {
        'app-advisor/entry-1': {
          activeBrowserId: 'browser-1',
        },
      },
      applySnapshot: applyBrowserSnapshotMock,
      setLocalServersOnly: mockSetLocalServersOnly,
      setOpenAppLinksInBuiltInBrowser: mockSetOpenAppLinksInBuiltInBrowser,
    });
    getChatStateMock.mockImplementation(
      () =>
        ({
          applyDeferredToolsDefaults: applyDeferredToolsDefaultsMock,
          applyModelDefaults: applyModelDefaultsMock,
          // Called by `useBillingLaneRuntimeSync` once lane facts settle.
          syncActiveEmptyTabToDefaults: jest.fn(() => Promise.resolve()),
          sendMessage: chatSendMessageMock,
          loadTabsForTarget: loadTabsForTargetMock,
          worktreeChats,
        }) as unknown as ReturnType<typeof useChatStore.getState>,
    );
    getAppAdvisorStateMock.mockReturnValue({
      syncWindowState: syncWindowStateMock,
      closeDialog: closeDialogMock,
      applyPreferences: applyPreferencesMock,
      hydrateForNavigation: hydrateForNavigationMock,
    } as unknown as ReturnType<typeof useAppAdvisorStore.getState>);
    getStandaloneStateMock.mockReturnValue({
      initializeScoped: initializeScopedMock,
      applyScopedPreferences: applyScopedPreferencesMock,
      selectChat: selectChatMock,
      closeArchiveOverlay: closeArchiveOverlayMock,
      createWorkEntryChatWithMessage: createWorkEntryChatWithMessageMock,
      activeWorkEntryId: 'entry-1',
      activeChatProjectId: 'app-advisor',
      archiveOverlayChatId: null,
    } as unknown as ReturnType<typeof useStandaloneChatStore.getState>);
    getFeatureFlagsStateMock.mockReturnValue({
      snapshot: getDefaultFeatureFlagSnapshot(),
      hydrate: hydrateFeatureFlagsMock,
      setSnapshot: setFeatureFlagSnapshotMock,
      isEnabled: jest.fn(),
    });
    commandListener = (): void => {};
    preferencesSyncedListener = (): void => {};
    loadPreferencesMock = jest.fn().mockResolvedValue({});
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: loadPreferencesMock,
        getResumeQueue: jest.fn().mockResolvedValue({
          version: 1,
          revision: 0,
          paused: false,
          entries: [],
        }),
        onResumeQueueChanged: jest.fn(
          (): (() => void) => (): undefined => undefined,
        ),
        // Required by `useBillingLaneRuntimeSync`, which this renderer mounts
        // so its lane availability is not permanently UNKNOWN. Left pending so
        // availability stays unresolved and these specs keep asserting command
        // handling rather than lane resolution.
        getClaudeAuthStatus: jest.fn(() => new Promise(() => {})),
        getCodexAuthStatus: jest.fn(() => new Promise(() => {})),
        loadNativeAiCreditsAvailability: jest.fn(() => new Promise(() => {})),
        onPreferencesSynced: jest.fn(
          (listener: (preferences: unknown) => void): (() => void) => {
            preferencesSyncedListener = listener;
            return (): undefined => undefined;
          },
        ),
        onAutoArchiveCompleted: jest.fn(
          (): (() => void) => (): undefined => undefined,
        ),
        featureFlags: {
          onSnapshotChanged: jest.fn(
            (
              listener: (snapshot: FeatureFlagSnapshot) => void,
            ): (() => void) => {
              featureFlagSnapshotListener = listener;
              return unsubscribeFeatureFlagsMock;
            },
          ),
        },
        workEntries: {
          resolveChat: resolveChatMock,
        },
        browser: {
          back: browserBackMock,
          forward: browserForwardMock,
        },
        appAdvisor: {
          getWindowState: jest
            .fn()
            .mockResolvedValue({ open: false, focused: false }),
          markWindowRendererReady: jest
            .fn()
            .mockResolvedValue({ open: false, focused: false }),
          onWindowStateChanged: jest.fn(
            (): (() => void) => (): undefined => undefined,
          ),
          onWindowCommand: jest.fn(
            (
              listener: (command: AppAdvisorWindowCommand) => void,
            ): (() => void) => {
              commandListener = listener;
              return (): undefined => undefined;
            },
          ),
          acknowledgeWatcherMessageDelivery:
            acknowledgeWatcherMessageDeliveryMock,
        },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('mounts the Claude terminal chat sync on mount and disposes it on unmount', async () => {
    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    expect(initializeClaudeTerminalChatSyncMock).toHaveBeenCalledTimes(1);
    const dispose = initializeClaudeTerminalChatSyncMock.mock.results[0]
      ?.value as jest.Mock;
    expect(dispose).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('installs its own pipeline bridge without global worktree status tracking', async () => {
    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    // This window is a separate renderer with its own pipeline stores; the
    // sidebar/overview status maps belong to the main window only.
    expect(mockUsePipelineRunsBridge).toHaveBeenCalledWith({
      trackGlobalStatus: false,
    });
  });

  it('subscribes to app-link events and hydrates browser preferences', async () => {
    loadPreferencesMock.mockResolvedValue({
      inAppBrowserLocalServersOnly: true,
      openAppLinksInBuiltInBrowser: true,
    });

    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    expect(mockEnsureBrowserEventSubscription).toHaveBeenCalledTimes(1);
    expect(mockSetLocalServersOnly).toHaveBeenCalledWith(true);
    expect(mockSetOpenAppLinksInBuiltInBrowser).toHaveBeenCalledWith(true);
  });

  it('opens the archived overview and Empty trash confirmation in the popout renderer', async () => {
    const archivedStore = useArchivedContainersStore.getState();
    const closeViewer = jest
      .spyOn(archivedStore, 'closeViewer')
      .mockImplementation();
    const openOverview = jest
      .spyOn(archivedStore, 'openOverview')
      .mockImplementation();
    const loadForWorkspace = jest
      .spyOn(archivedStore, 'loadForWorkspace')
      .mockResolvedValue();
    const requestEmptyTrashConfirmation = jest
      .spyOn(archivedStore, 'requestEmptyTrashConfirmation')
      .mockImplementation();
    useArchivedContainersStore.setState({
      byWorkspace: { 'app-advisor': [deletedSummary()] },
      emptyTrashRun: null,
    });

    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    act(() => {
      commandListener({
        type: 'open_archived_overview',
        openEmptyTrashConfirmation: true,
        requestId: 'overview-request-1',
      });
    });
    await flushPromises();

    expect(closeArchiveOverlayMock).toHaveBeenCalledTimes(1);
    expect(closeViewer).toHaveBeenCalledTimes(1);
    expect(openOverview).toHaveBeenCalledWith('app-advisor');
    expect(loadForWorkspace).toHaveBeenCalledWith('app-advisor', {
      trailing: true,
      strict: true,
    });
    expect(requestEmptyTrashConfirmation).toHaveBeenCalledWith('app-advisor');
    expect(
      useArchivedContainersStore.getState().lastArchivedOverviewRequest,
    ).toEqual({ requestId: 'overview-request-1', confirmationOpened: true });

    useArchivedContainersStore.setState({
      emptyTrashRun: {
        workspaceId: 'app-advisor',
        total: 1,
        completed: 0,
        cancelRequested: false,
      },
    });
    act(() => {
      commandListener({
        type: 'open_archived_overview',
        openEmptyTrashConfirmation: true,
        requestId: 'overview-request-2',
      });
    });
    await flushPromises();
    expect(
      useArchivedContainersStore.getState().lastArchivedOverviewRequest,
    ).toEqual({ requestId: 'overview-request-2', confirmationOpened: false });

    closeViewer.mockRestore();
    openOverview.mockRestore();
    loadForWorkspace.mockRestore();
    requestEmptyTrashConfirmation.mockRestore();
  });

  it('does not acknowledge Empty trash after the authoritative load finds no Deleted items', async () => {
    const archivedStore = useArchivedContainersStore.getState();
    const loadForWorkspace = jest
      .spyOn(archivedStore, 'loadForWorkspace')
      .mockImplementation(() => {
        useArchivedContainersStore.setState({
          byWorkspace: { 'app-advisor': [] },
        });
        return Promise.resolve();
      });
    const requestEmptyTrashConfirmation = jest
      .spyOn(archivedStore, 'requestEmptyTrashConfirmation')
      .mockImplementation();
    useArchivedContainersStore.setState({
      byWorkspace: { 'app-advisor': [deletedSummary()] },
      emptyTrashRun: null,
      lastArchivedOverviewRequest: null,
    });

    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    act(() => {
      commandListener({
        type: 'open_archived_overview',
        openEmptyTrashConfirmation: true,
        requestId: 'overview-no-deleted-items',
      });
    });
    await flushPromises();

    expect(loadForWorkspace).toHaveBeenCalledWith('app-advisor', {
      trailing: true,
      strict: true,
    });
    expect(requestEmptyTrashConfirmation).not.toHaveBeenCalled();
    expect(
      useArchivedContainersStore.getState().lastArchivedOverviewRequest,
    ).toEqual({
      requestId: 'overview-no-deleted-items',
      confirmationOpened: false,
    });

    loadForWorkspace.mockRestore();
    requestEmptyTrashConfirmation.mockRestore();
  });

  it('hydrates feature flags and applies broadcasts in this renderer', async () => {
    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    expect(hydrateFeatureFlagsMock).toHaveBeenCalledTimes(1);

    const snapshot: FeatureFlagSnapshot = { status: 'ready', values: {} };
    act(() => {
      featureFlagSnapshotListener(snapshot);
    });
    expect(setFeatureFlagSnapshotMock).toHaveBeenCalledWith(snapshot);

    act(() => {
      root.unmount();
    });
    expect(unsubscribeFeatureFlagsMock).toHaveBeenCalledTimes(1);
  });

  it('mounts the usage-limit resume modal in the App Advisor renderer', async () => {
    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    expect(usageLimitResumeModalMock).toHaveBeenCalled();
  });

  it('hydrates every App Advisor entry in the authoritative renderer', async () => {
    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    expect(hydrateForNavigationMock).toHaveBeenCalledTimes(1);
  });

  it('hides App Advisor through the main process on Cmd/Ctrl+W instead of closing its page', async () => {
    // Under early access the page lives in a `WebContentsView`, where
    // `window.close()` destroys the page itself rather than asking its
    // window to close (which the main process would turn into a hide).
    const windowClose = jest
      .spyOn(window, 'close')
      .mockImplementation((): void => undefined);
    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    const event = new KeyboardEvent('keydown', {
      key: 'w',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(closeDialogMock).toHaveBeenCalledTimes(1);
    expect(mockRunCloseTabShortcut).not.toHaveBeenCalled();
    expect(windowClose).not.toHaveBeenCalled();
    windowClose.mockRestore();
  });

  describe('Cmd/Ctrl+W with tabs (CAN-3952)', () => {
    function pressCloseChord(target: EventTarget = container): KeyboardEvent {
      const event = new KeyboardEvent('keydown', {
        key: 'w',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      return event;
    }

    async function renderApp(): Promise<void> {
      act(() => {
        root.render(createElement(AppAdvisorWindowApp));
      });
      await flushPromises();
    }

    it('closes the active tab instead of hiding when another tab remains', async () => {
      mockHasCloseableTabForShortcut.mockReturnValue(true);
      // A refused close (busy chat) is indistinguishable here, and must not
      // fall back to hiding App Advisor.
      mockRunCloseTabShortcut.mockReturnValue(false);
      await renderApp();

      const event = pressCloseChord();

      const target = { projectId: 'app-advisor', worktreeId: 'entry-1' };
      expect(event.defaultPrevented).toBe(true);
      expect(mockHasCloseableTabForShortcut).toHaveBeenCalledWith(target);
      expect(mockRunCloseTabShortcut).toHaveBeenCalledTimes(1);
      expect(mockRunCloseTabShortcut).toHaveBeenCalledWith(target);
      expect(closeDialogMock).not.toHaveBeenCalled();
    });

    it('hides App Advisor when the full layout has nothing to close', async () => {
      await renderApp();

      const event = pressCloseChord();

      expect(event.defaultPrevented).toBe(true);
      expect(closeDialogMock).toHaveBeenCalledTimes(1);
      expect(mockRunCloseTabShortcut).not.toHaveBeenCalled();
    });

    it('hides the floating panel even when the full layout has a closable tab', async () => {
      mockHasCloseableTabForShortcut.mockReturnValue(true);
      getAppAdvisorStateMock.mockReturnValue({
        ...getAppAdvisorStateMock(),
        layout: 'floating',
      } as unknown as ReturnType<typeof useAppAdvisorStore.getState>);
      await renderApp();

      pressCloseChord();

      expect(closeDialogMock).toHaveBeenCalledTimes(1);
      expect(mockHasCloseableTabForShortcut).not.toHaveBeenCalled();
      expect(mockRunCloseTabShortcut).not.toHaveBeenCalled();
    });

    it('hides App Advisor before the scoped store is ready', async () => {
      mockHasCloseableTabForShortcut.mockReturnValue(true);
      getStandaloneStateMock.mockReturnValue({
        ...getStandaloneStateMock(),
        activeChatProjectId: 'other',
      } as unknown as ReturnType<typeof useStandaloneChatStore.getState>);
      await renderApp();

      pressCloseChord();

      expect(closeDialogMock).toHaveBeenCalledTimes(1);
      expect(mockHasCloseableTabForShortcut).not.toHaveBeenCalled();
      expect(mockRunCloseTabShortcut).not.toHaveBeenCalled();
    });

    it('hides App Advisor when there is no active Work Entry', async () => {
      mockHasCloseableTabForShortcut.mockReturnValue(true);
      getStandaloneStateMock.mockReturnValue({
        ...getStandaloneStateMock(),
        activeWorkEntryId: null,
      } as unknown as ReturnType<typeof useStandaloneChatStore.getState>);
      await renderApp();

      pressCloseChord();

      expect(closeDialogMock).toHaveBeenCalledTimes(1);
      expect(mockHasCloseableTabForShortcut).not.toHaveBeenCalled();
      expect(mockRunCloseTabShortcut).not.toHaveBeenCalled();
    });

    describe('while an archive view covers the grid', () => {
      afterEach(() => {
        useArchivedContainersStore.setState({ viewer: null, overview: null });
      });

      it.each([
        [
          'the archived overview',
          (): void => {
            useArchivedContainersStore.setState({
              overview: { workspaceId: 'app-advisor' },
            });
          },
        ],
        [
          'an archived container viewer',
          (): void => {
            useArchivedContainersStore.setState({
              viewer: {
                workspaceId: 'app-advisor',
                containerId: 'entry-archived',
                tab: 'chats',
              },
            });
          },
        ],
        [
          'the legacy archived-chat overlay',
          (): void => {
            getStandaloneStateMock.mockReturnValue({
              ...getStandaloneStateMock(),
              archiveOverlayChatId: 'chat-archived',
            } as unknown as ReturnType<typeof useStandaloneChatStore.getState>);
          },
        ],
      ])(
        'hides App Advisor instead of closing the hidden tab under %s',
        async (_name, openArchiveView) => {
          mockHasCloseableTabForShortcut.mockReturnValue(true);
          openArchiveView();
          await renderApp();

          pressCloseChord();

          expect(closeDialogMock).toHaveBeenCalledTimes(1);
          expect(mockRunCloseTabShortcut).not.toHaveBeenCalled();
        },
      );
    });

    it('leaves terminal Ctrl+W to the shell on non-macOS platforms', async () => {
      mockHasCloseableTabForShortcut.mockReturnValue(true);
      await renderApp();
      const terminal = document.createElement('div');
      terminal.className = 'xterm';
      container.appendChild(terminal);

      const event = pressCloseChord(terminal);

      expect(event.defaultPrevented).toBe(false);
      expect(closeDialogMock).not.toHaveBeenCalled();
      expect(mockRunCloseTabShortcut).not.toHaveBeenCalled();
    });
  });

  it('starts a new chat on Cmd/Ctrl+T in the floating panel, whatever panel the full layout left active', async () => {
    const startNewChatMock = jest.fn().mockResolvedValue(undefined);
    getAppAdvisorStateMock.mockReturnValue({
      ...getAppAdvisorStateMock(),
      layout: 'floating',
    } as unknown as ReturnType<typeof useAppAdvisorStore.getState>);
    getStandaloneStateMock.mockReturnValue({
      ...getStandaloneStateMock(),
      startNewChat: startNewChatMock,
    } as unknown as ReturnType<typeof useStandaloneChatStore.getState>);
    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    const event = new KeyboardEvent('keydown', {
      key: 't',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    container.dispatchEvent(event);

    // The floating panel shows chats only, so the grid's panel-aware
    // shortcut (which may target a terminal) does not apply.
    expect(event.defaultPrevented).toBe(true);
    expect(startNewChatMock).toHaveBeenCalledTimes(1);
    expect(mockRunNewTabShortcut).not.toHaveBeenCalled();
  });

  it('leaves terminal Ctrl+T to the shell on non-macOS platforms', async () => {
    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    const terminal = document.createElement('div');
    terminal.className = 'xterm';
    container.appendChild(terminal);
    const event = new KeyboardEvent('keydown', {
      key: 't',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    terminal.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(mockRunNewTabShortcut).not.toHaveBeenCalled();
  });

  it('routes browser-chrome address and history shortcuts', async () => {
    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    const browserSurface = document.createElement('div');
    browserSurface.dataset.browserSurface = '';
    container.appendChild(browserSurface);

    const focusEvent = new KeyboardEvent('keydown', {
      key: 'l',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    browserSurface.dispatchEvent(focusEvent);
    const backEvent = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    browserSurface.dispatchEvent(backEvent);
    const forwardEvent = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    browserSurface.dispatchEvent(forwardEvent);
    await flushPromises();

    expect(focusEvent.defaultPrevented).toBe(true);
    expect(mockRequestBrowserUrlFocus).toHaveBeenCalledWith('browser-1');
    expect(backEvent.defaultPrevented).toBe(true);
    expect(forwardEvent.defaultPrevented).toBe(true);
    expect(browserBackMock).toHaveBeenCalledWith({ browserId: 'browser-1' });
    expect(browserForwardMock).toHaveBeenCalledWith({
      browserId: 'browser-1',
    });
    expect(applyBrowserSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it('opens the find bar for the focused chat on Cmd/Ctrl+F (CAN-3048)', async () => {
    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    const chat = document.createElement('div');
    chat.setAttribute('data-find-surface', 'chat');
    chat.setAttribute('data-find-scope', 'advisor-chat');
    const composer = document.createElement('textarea');
    chat.appendChild(composer);
    container.appendChild(chat);
    const controller: FindController = {
      mode: 'chat',
      scopeKey: 'advisor-chat',
      title: 'Advisor',
      anchor: chat,
      setQuery: jest.fn(),
      next: jest.fn(),
      previous: jest.fn(),
      close: jest.fn(),
    };
    useSurfaceFindStore.getState().registerController(controller);

    const findEvent = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      composer.dispatchEvent(findEvent);
    });

    try {
      expect(findEvent.defaultPrevented).toBe(true);
      expect(useSurfaceFindStore.getState().open).toBe(true);
      expect(useSurfaceFindStore.getState().mode).toBe('chat');
    } finally {
      act(() => {
        useSurfaceFindStore.getState().close();
        useSurfaceFindStore.getState().unregisterController(controller);
      });
    }
  });

  it('opens a searchable terminal its own find bar on Ctrl+F, and nothing from an unmarked terminal', async () => {
    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    // An unmarked terminal beside a chat must not open the chat's bar.
    const chat = document.createElement('div');
    chat.setAttribute('data-find-surface', 'chat');
    chat.setAttribute('data-find-scope', 'advisor-chat');
    container.appendChild(chat);
    const pane = document.createElement('div');
    pane.setAttribute('data-find-surface', 'terminal');
    pane.setAttribute('data-find-scope', 'term-1');
    const terminal = document.createElement('div');
    terminal.className = 'xterm';
    pane.appendChild(terminal);
    container.appendChild(pane);
    const unmarked = document.createElement('div');
    unmarked.className = 'xterm';
    container.appendChild(unmarked);
    const controllers: FindController[] = [
      { mode: 'chat', scopeKey: 'advisor-chat', anchor: chat },
      { mode: 'terminal', scopeKey: 'term-1', anchor: pane },
    ].map(({ mode, scopeKey, anchor }) => ({
      mode,
      scopeKey,
      title: scopeKey,
      anchor,
      setQuery: jest.fn(),
      next: jest.fn(),
      previous: jest.fn(),
      close: jest.fn(),
    }));
    act(() => {
      for (const controller of controllers) {
        useSurfaceFindStore.getState().registerController(controller);
      }
    });
    const pressFind = (target: HTMLElement): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', {
        key: 'f',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        target.dispatchEvent(event);
      });
      return event;
    };

    try {
      const unmarkedEvent = pressFind(unmarked);
      expect(unmarkedEvent.defaultPrevented).toBe(false);
      expect(useSurfaceFindStore.getState().open).toBe(false);

      const findEvent = pressFind(terminal);
      expect(findEvent.defaultPrevented).toBe(true);
      expect(useSurfaceFindStore.getState().open).toBe(true);
      expect(useSurfaceFindStore.getState().mode).toBe('terminal');
    } finally {
      act(() => {
        useSurfaceFindStore.getState().close();
        for (const controller of controllers) {
          useSurfaceFindStore.getState().unregisterController(controller);
        }
      });
    }
  });

  it('opens find for the active panel group from a composer outside the transcript (CAN-3048)', async () => {
    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    // A split layout: two chat panels, focus in the first group's composer,
    // which sits outside its transcript's find marker.
    const controllers = ['chat-a', 'chat-b'].map((scopeKey, position) => {
      const group = document.createElement('div');
      group.dataset.testid = `panel-group-group-${position + 1}`;
      const transcript = document.createElement('div');
      transcript.setAttribute('data-find-surface', 'chat');
      transcript.setAttribute('data-find-scope', scopeKey);
      group.appendChild(transcript);
      container.appendChild(group);
      const controller: FindController = {
        mode: 'chat',
        scopeKey,
        title: scopeKey,
        anchor: transcript,
        setQuery: jest.fn(),
        next: jest.fn(),
        previous: jest.fn(),
        close: jest.fn(),
      };
      useSurfaceFindStore.getState().registerController(controller);
      return controller;
    });
    const composer = document.createElement('textarea');
    container
      .querySelector('[data-testid="panel-group-group-1"]')
      ?.appendChild(composer);
    const layoutKey = makeWorktreePanelKey('app-advisor', 'entry-1');
    mockGetPanelLayoutViewModel.mockImplementation((key) =>
      key === layoutKey
        ? ({ activeGroupId: 'group-1' } as ReturnType<
            typeof PanelLayoutStoreModule.getPanelLayoutViewModel
          >)
        : undefined,
    );

    const findEvent = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      composer.dispatchEvent(findEvent);
    });

    try {
      expect(findEvent.defaultPrevented).toBe(true);
      expect(useSurfaceFindStore.getState().open).toBe(true);
      expect(useSurfaceFindStore.getState().activeScope.chat).toBe('chat-a');
    } finally {
      mockGetPanelLayoutViewModel.mockReset();
      mockGetPanelLayoutViewModel.mockReturnValue(undefined);
      act(() => {
        useSurfaceFindStore.getState().close();
        for (const controller of controllers) {
          useSurfaceFindStore.getState().unregisterController(controller);
        }
      });
    }
  });

  it('applies deferred-tools + App Advisor defaults from initial preferences', async () => {
    const preferences = {
      deferredToolsAppAdvisorEnabled: false,
    };
    loadPreferencesMock.mockResolvedValueOnce(preferences);

    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    expect(applyDeferredToolsDefaultsMock).toHaveBeenCalledWith(preferences);
    expect(applyModelDefaultsMock).toHaveBeenCalledWith(preferences);
    expect(applyPreferencesMock).toHaveBeenCalledWith(preferences);
    expect(applyScopedPreferencesMock).toHaveBeenCalledWith(preferences);
  });

  it('re-applies display preferences when the main process broadcasts a preference change', async () => {
    const applyDisplayPreferencesMock = jest.mocked(applyDisplayPreferences);

    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();
    applyDisplayPreferencesMock.mockClear();
    applyDeferredToolsDefaultsMock.mockClear();
    applyModelDefaultsMock.mockClear();
    applyScopedPreferencesMock.mockClear();
    setChatStateMock.mockClear();

    act(() => {
      preferencesSyncedListener({
        theme: 'ocean',
        colorMode: 'dark',
        uiScale: 125,
      });
    });

    expect(applyDisplayPreferencesMock).toHaveBeenCalledWith({
      theme: 'ocean',
      colorMode: 'dark',
      uiScale: 125,
    });
    expect(applyDeferredToolsDefaultsMock).toHaveBeenCalledWith({
      theme: 'ocean',
      colorMode: 'dark',
      uiScale: 125,
    });
    expect(applyModelDefaultsMock).toHaveBeenCalledWith({
      theme: 'ocean',
      colorMode: 'dark',
      uiScale: 125,
    });
    expect(applyScopedPreferencesMock).toHaveBeenCalledWith({
      theme: 'ocean',
      colorMode: 'dark',
      uiScale: 125,
    });
    expect(setChatStateMock).toHaveBeenCalledWith({
      approvalDefaultsCache: {},
    });
  });

  it('runs initializeScoped before every command and selects chats through the scoped store', async () => {
    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    act(() => {
      commandListener({ type: 'select_chat', chatId: 'chat-42' });
    });
    await flushPromises();

    expect(initializeScopedMock).toHaveBeenCalledWith('app-advisor');
    expect(selectChatMock).toHaveBeenCalledWith('chat-42');
    expect(initializeScopedMock.mock.invocationCallOrder[0]).toBeLessThan(
      selectChatMock.mock.invocationCallOrder[0],
    );
  });

  it('opens a delegate in this renderer after selecting its owning Work Entry', async () => {
    selectChatMock.mockResolvedValue(true);
    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();
    act(() => {
      commandListener(
        Object.assign(
          { type: 'select_chat' as const, chatId: 'chat-42' },
          { delegationId: 'delegate-42' },
        ),
      );
    });
    await flushPromises();
    expect(mockOpenSubagentChatPanel).toHaveBeenCalledWith(
      { projectId: 'app-advisor', worktreeId: 'entry-1' },
      {
        rootChatId: 'chat-42',
        subagentId: 'delegate-42',
        subagentKind: 'managed',
        title: '',
      },
    );
    expect(selectChatMock.mock.invocationCallOrder[0]).toBeLessThan(
      mockOpenSubagentChatPanel.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('does not open a delegate when its parent chat cannot be selected', async () => {
    selectChatMock.mockResolvedValue(false);
    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();
    act(() => {
      commandListener({
        type: 'select_chat',
        chatId: 'missing-chat',
        delegationId: 'delegate-42',
      });
    });
    await flushPromises();
    expect(mockOpenSubagentChatPanel).not.toHaveBeenCalled();
  });

  it('serializes non-idempotent quick prompt commands in delivery order', async () => {
    const fileReferences = [
      { displayPath: 'prompt', absolutePath: '/advisor/prompt', textStart: 6 },
    ];
    const sendResolvers: Array<(value: string) => void> = [];
    createWorkEntryChatWithMessageMock.mockImplementation(
      (): Promise<string> =>
        new Promise((resolve) => {
          sendResolvers.push(resolve);
        }),
    );

    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    act(() => {
      commandListener({
        type: 'send_quick_prompt',
        text: 'first prompt',
        chatId: 'quick-1',
        userMessageId: 'quick-user-1',
        entryId: 'entry-quick-1',
        removeEntryOnFailure: true,
        replaceActiveEmpty: true,
        approvalMode: 'ask',
        planMode: true,
        fileReferences,
        packageOverlay: {
          packageDigest: `pp:v1:${'a'.repeat(43)}`,
          resources: [],
        },
      });
      commandListener({
        type: 'send_quick_prompt',
        text: 'second prompt',
        chatId: 'quick-2',
        entryId: 'entry-quick-2',
        removeEntryOnFailure: false,
        replaceActiveEmpty: false,
      });
    });
    await flushPromises();

    expect(createWorkEntryChatWithMessageMock).toHaveBeenCalledTimes(1);
    expect(createWorkEntryChatWithMessageMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        message: 'first prompt',
        chatId: 'quick-1',
        entryId: 'entry-quick-1',
        removeEntryOnFailure: true,
        replaceActiveEmpty: true,
      }),
    );
    const firstQuickPrompt =
      createWorkEntryChatWithMessageMock.mock.calls[0]?.[0];
    expect(firstQuickPrompt?.config).toMatchObject({
      approvalMode: 'ask',
      planMode: true,
      fileReferences,
    });
    expect(firstQuickPrompt?.sendOptions).toMatchObject({
      userMessageId: 'quick-user-1',
      planMode: true,
      packageOverlay: {
        packageDigest: `pp:v1:${'a'.repeat(43)}`,
        resources: [],
      },
    });

    await act(async (): Promise<void> => {
      sendResolvers[0]?.('quick-1');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createWorkEntryChatWithMessageMock).toHaveBeenCalledTimes(2);
    expect(createWorkEntryChatWithMessageMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: 'second prompt',
        chatId: 'quick-2',
        entryId: 'entry-quick-2',
        removeEntryOnFailure: false,
        replaceActiveEmpty: false,
      }),
    );
  });

  it('resolves the entry and sends watcher messages without changing selection', async () => {
    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    act(() => {
      commandListener({
        type: 'send_watcher_message',
        chatId: 'advisor-1',
        watcherId: 'watch-1',
        deliveryId: 'delivery-1',
        text: 'pipeline finished',
        hiddenContextText: '<system_instruction>hidden</system_instruction>',
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
      });
    });
    await flushPromises();

    expect(resolveChatMock).toHaveBeenCalledWith({
      projectId: 'app-advisor',
      chatId: 'advisor-1',
    });
    expect(chatSendMessageMock).toHaveBeenCalledTimes(1);
    expect(chatSendMessageMock).toHaveBeenCalledWith(
      'pipeline finished',
      undefined,
      {
        projectId: 'app-advisor',
        worktreeId: 'entry-1',
        chatId: 'advisor-1',
      },
      undefined,
      expect.objectContaining({
        assistantMode: 'app-advisor',
        hiddenContext: {
          kind: 'canopy-watcher-event',
          text: '<system_instruction>hidden</system_instruction>',
        },
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
        watcherDeliveryId: 'delivery-1',
        throwOnDispatchFailure: true,
      }),
    );
    expect(acknowledgeWatcherMessageDeliveryMock).toHaveBeenCalledWith({
      watcherId: 'watch-1',
      deliveryId: 'delivery-1',
      stage: 'completed',
      ok: true,
    });
    // Watcher delivery never changes the selected entry/chat.
    expect(selectChatMock).not.toHaveBeenCalled();
  });

  it('preserves command acceptance order before host-queue consolidation', async () => {
    const watcherResolvers: Array<() => void> = [];
    chatSendMessageMock.mockImplementation(
      (): Promise<void> =>
        new Promise<void>((resolve) => {
          watcherResolvers.push(resolve);
        }),
    );

    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    act(() => {
      commandListener({
        type: 'send_watcher_message',
        chatId: 'advisor-1',
        watcherId: 'w-1',
        deliveryId: 'delivery-1',
        text: 'first',
      });
      commandListener({
        type: 'send_watcher_message',
        chatId: 'advisor-1',
        watcherId: 'w-2',
        deliveryId: 'delivery-2',
        text: 'second',
      });
    });
    await flushPromises();

    expect(chatSendMessageMock).toHaveBeenCalledTimes(1);
    expect(chatSendMessageMock.mock.calls[0][0]).toBe('first');

    await act(async (): Promise<void> => {
      watcherResolvers[0]?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(chatSendMessageMock).toHaveBeenCalledTimes(2);
    expect(chatSendMessageMock.mock.calls[1][0]).toBe('second');
  });

  it('deduplicates a retried watcher delivery while the first send is pending', async () => {
    let resolveSend: (() => void) | undefined;
    chatSendMessageMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );

    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    const command = {
      type: 'send_watcher_message' as const,
      chatId: 'advisor-1',
      watcherId: 'watch-retry',
      deliveryId: 'delivery-retry',
      text: 'pipeline finished',
    };
    act(() => {
      commandListener(command);
      commandListener(command);
    });
    await flushPromises();
    expect(chatSendMessageMock).toHaveBeenCalledTimes(1);

    await act(async (): Promise<void> => {
      resolveSend?.();
      await flushPromises();
    });
    expect(chatSendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('acknowledges failure when the watcher recipient cannot be resolved', async () => {
    resolveChatMock.mockResolvedValueOnce({
      entryId: null,
      archivedInEntryId: null,
    });

    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    act(() => {
      commandListener({
        type: 'send_watcher_message',
        chatId: 'missing-chat',
        watcherId: 'w-fallback',
        deliveryId: 'delivery-fallback',
        text: 'fallback delivery',
      });
    });
    await flushPromises();

    expect(chatSendMessageMock).not.toHaveBeenCalled();
    expect(acknowledgeWatcherMessageDeliveryMock).toHaveBeenCalledWith({
      watcherId: 'w-fallback',
      deliveryId: 'delivery-fallback',
      stage: 'completed',
      ok: false,
      error:
        'Cannot deliver watcher message because App Advisor chat missing-chat was not found.',
    });
  });

  it('acknowledges failure when watcher scoped initialization rejects', async () => {
    initializeScopedMock.mockRejectedValueOnce(new Error('scope unavailable'));

    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    act(() => {
      commandListener({
        type: 'send_watcher_message',
        chatId: 'advisor-1',
        watcherId: 'w-init-failure',
        deliveryId: 'delivery-init-failure',
        text: 'pipeline finished',
      });
    });
    await flushPromises();

    expect(chatSendMessageMock).not.toHaveBeenCalled();
    expect(acknowledgeWatcherMessageDeliveryMock).toHaveBeenCalledWith({
      watcherId: 'w-init-failure',
      deliveryId: 'delivery-init-failure',
      stage: 'completed',
      ok: false,
      error: 'scope unavailable',
    });
  });

  it('acknowledges watcher delivery failure when the send rejects', async () => {
    chatSendMessageMock.mockRejectedValueOnce(new Error('missing tab'));

    act(() => {
      root.render(createElement(AppAdvisorWindowApp));
    });
    await flushPromises();

    let unexpectedError: unknown = null;
    try {
      act(() => {
        commandListener({
          type: 'send_watcher_message',
          chatId: 'advisor-1',
          watcherId: 'w-missing',
          deliveryId: 'delivery-missing',
          text: 'noop',
        });
      });
      await flushPromises();
    } catch (error) {
      unexpectedError = error;
    }

    expect(unexpectedError).toBeNull();
    expect(acknowledgeWatcherMessageDeliveryMock).toHaveBeenCalledWith({
      watcherId: 'w-missing',
      deliveryId: 'delivery-missing',
      stage: 'completed',
      ok: false,
      error: 'missing tab',
    });
  });
});
