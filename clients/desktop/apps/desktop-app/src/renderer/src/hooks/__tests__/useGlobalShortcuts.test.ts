import type { CanopyApi } from '@canopy/desktop-shared/types';
import type * as CoworkRegistryModule from '../../lib/cowork-registry';
import type * as ChatStoreModule from '../../stores/chatStore';
import type * as BrowserStoreModule from '../../stores/browserStore';
import type { ChatState } from '../../stores/chat/state';
import type * as NavigationStoreModule from '../../stores/navigationStore';
import type * as SidebarStoreModule from '../../stores/sidebarStore';
import type * as HomeComposerStoreModule from '../../stores/homeComposerStore';
import type * as NavigationHistoryStoreModule from '../../stores/navigationHistoryStore';
import type * as PanelCommandsModule from '../../lib/panels/commands';
import type * as NewTabShortcutModule from '../../lib/newTabShortcut';
import type * as CloseTabShortcutModule from '../../lib/closeTabShortcut';
import type * as ShortcutModule from '../useGlobalShortcuts';
import type * as FindShortcutModule from '../../lib/find/findShortcut';
import type * as PanelLayoutStoreModule from '../../stores/panelLayoutStore';

// CAN-3048: Cmd/Ctrl+F routing is unit-tested in findShortcut.test.ts; here
// only its placement in the global handler is asserted.
const mockRunFindShortcut = jest.fn<
  boolean,
  Parameters<typeof FindShortcutModule.runFindShortcut>
>(() => false);

const mockResolveFallbackFindTarget = jest.fn<
  ReturnType<typeof FindShortcutModule.resolveFallbackFindTarget>,
  Parameters<typeof FindShortcutModule.resolveFallbackFindTarget>
>(() => null);

jest.mock('@/lib/find/findShortcut', () => ({
  ...jest.requireActual<typeof FindShortcutModule>('@/lib/find/findShortcut'),
  runFindShortcut: (
    ...args: Parameters<typeof FindShortcutModule.runFindShortcut>
  ): boolean => mockRunFindShortcut(...args),
  resolveFallbackFindTarget: (
    ...args: Parameters<typeof FindShortcutModule.resolveFallbackFindTarget>
  ): ReturnType<typeof FindShortcutModule.resolveFallbackFindTarget> =>
    mockResolveFallbackFindTarget(...args),
}));

// Delegates to the real store unless a test overrides the active group.
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

// Stable spy across jest.resetModules() re-evaluations of the mock factory.
const mockRunPanelCommand = jest.fn<boolean, [string, string]>();

jest.mock('@/lib/panels/commands', () => {
  const actual = jest.requireActual<typeof PanelCommandsModule>(
    '@/lib/panels/commands',
  );
  const runPanelCommand: typeof actual.runPanelCommand = (id, worktreeKey) =>
    mockRunPanelCommand(id, worktreeKey);
  return { ...actual, runPanelCommand };
});

// Context-aware ⌘T dispatch (ECW-7984): useGlobalShortcuts resolves WHERE the
// chord applies (page + selection) and delegates the surface routing to
// `runNewTabShortcut`; the routing itself has its own unit tests
// (`newTabSurface.test.ts`), so it is stubbed here.
const mockRunNewTabShortcut = jest.fn<
  NewTabShortcutModule.NewTabSurfaceKind,
  [NewTabShortcutModule.RunNewTabShortcutParams]
>();
jest.mock('@/lib/newTabShortcut', () => ({
  runNewTabShortcut: (
    params: NewTabShortcutModule.RunNewTabShortcutParams,
  ): NewTabShortcutModule.NewTabSurfaceKind => mockRunNewTabShortcut(params),
}));

// Context-aware ⌘W dispatch (ECW-7984) is delegated the same way: the routing
// (close the focused surface's active panel via the shared panel-close path)
// has its own unit tests (`closeTabShortcut.test.ts`), so it is stubbed here.
const mockRunCloseTabShortcut = jest.fn<
  string | null,
  [CloseTabShortcutModule.RunCloseTabShortcutParams]
>();
jest.mock('@/lib/closeTabShortcut', () => ({
  runCloseTabShortcut: (
    params: CloseTabShortcutModule.RunCloseTabShortcutParams,
  ): string | null => mockRunCloseTabShortcut(params),
}));

// Ctrl+` open-terminal collaborators (stable spies across resetModules).
interface MockPanelLocation {
  layoutKey: string;
  groupId: string;
  panelId: string;
}
const mockEnsureTerminalPanelVisible = jest.fn<
  MockPanelLocation | null,
  [string]
>();
jest.mock('@/lib/panels/terminal-panel-activation', () => ({
  ensureTerminalPanelVisible: (worktreeKey: string): MockPanelLocation | null =>
    mockEnsureTerminalPanelVisible(worktreeKey),
}));
const mockRequestTerminalSpawn = jest.fn<void, [unknown]>();
jest.mock('@/lib/terminalSpawnRequests', () => ({
  requestTerminalSpawn: (request: unknown): void =>
    mockRequestTerminalSpawn(request),
}));
const mockRequestBrowserUrlFocus = jest.fn<void, [string]>();
jest.mock('@/lib/browserUrlFocus', () => ({
  requestBrowserUrlFocus: (browserId: string): void =>
    mockRequestBrowserUrlFocus(browserId),
}));

// The Cmd/Ctrl+S save shortcut resolves the active file tab through the shared
// desktop file-session controller (CAN-1426). Stable spies survive the mock
// factory re-running across jest.resetModules().
const mockControllerHasSession = jest.fn<boolean, [string]>();
const mockControllerSaveTab = jest.fn<Promise<boolean>, [string]>();
jest.mock('@/lib/file-viewer/desktop-file-session-controller', () => ({
  desktopFileSessionController: {
    hasSession: (tabId: string): boolean => mockControllerHasSession(tabId),
    saveTab: (tabId: string): Promise<boolean> => mockControllerSaveTab(tabId),
  },
}));

const sendMessageMock = jest.fn<Promise<void>, [unknown]>();
const cancelChatMock = jest.fn<Promise<void>, [unknown]>();
const loadTabsMock = jest.fn<Promise<unknown>, [unknown]>();
const saveTabsMock = jest.fn<Promise<void>, [unknown]>();
const activeSessionsMock = jest.fn<Promise<unknown>, [unknown]>();
const togglePlanModeMock = jest.fn<Promise<void>, [unknown]>();
const answerMcpQuestionMock = jest.fn();
const changeModelMock = jest.fn();
const updatePluginsMock = jest.fn();
const toggleThinkingLevelMock = jest.fn();
const generateHandoffSummaryMock = jest.fn<Promise<unknown>, [unknown]>();
const discoverWorktreeEnvMock = jest.fn();
const setForegroundWorktreeMock = jest.fn();
const requestFastRefreshMock = jest.fn();
const loadPreferencesMock = jest.fn();
const savePreferencesMock = jest.fn();
const showOsNotificationMock = jest.fn(
  (): Promise<{ shown: boolean }> => Promise.resolve({ shown: true }),
);
const onOsNotificationClickedMock = jest.fn((): (() => void) => (): void => {});
const onOsNotificationClosedMock = jest.fn((): (() => void) => (): void => {});
const activityPlansCreateMock = jest.fn();
const activityPlansUpdateMock = jest.fn();
const activityPlansListMock = jest.fn();
const activityPlansGetMock = jest.fn();
const appAdvisorOpenWindowMock = jest.fn();
const browserBackMock = jest.fn<Promise<unknown>, [unknown]>();
const browserForwardMock = jest.fn<Promise<unknown>, [unknown]>();
const windowDispatchEventMock = jest.fn<boolean, [Event]>();
const documentDispatchEventMock = jest.fn<boolean, [Event]>();
const documentQuerySelectorMock = jest.fn<
  { getClientRects: () => readonly object[] } | null,
  [string]
>();

declare global {
  interface Window {
    api: CanopyApi;
  }
}

function loadModules(): {
  handleGlobalShortcutKeyDown: typeof ShortcutModule.handleGlobalShortcutKeyDown;
  useChatStore: typeof ChatStoreModule.useChatStore;
  useBrowserStore: typeof BrowserStoreModule.useBrowserStore;
  useNavigationStore: typeof NavigationStoreModule.useNavigationStore;
  registerCoworkWorkspaceIds: (ids: readonly string[]) => void;
  useSidebarStore: typeof SidebarStoreModule.useSidebarStore;
  useHomeComposerStore: typeof HomeComposerStoreModule.useHomeComposerStore;
  useNavigationHistoryStore: typeof NavigationHistoryStoreModule.useNavigationHistoryStore;
} {
  jest.resetModules();
  // The ⌘U attachments chord broadcasts a document-level custom event; the
  // node test environment has no document, so provide a structural stub.
  Object.defineProperty(global, 'document', {
    configurable: true,
    value: {
      defaultView: null,
      addEventListener: (): void => {},
      removeEventListener: (): void => {},
      dispatchEvent: documentDispatchEventMock,
      querySelector: documentQuerySelectorMock,
    },
  });
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      addEventListener: (): void => {},
      removeEventListener: (): void => {},
      dispatchEvent: windowDispatchEventMock,
      api: {
        chat: {
          sendMessage: sendMessageMock,
          cancel: cancelChatMock,
          loadTabs: loadTabsMock,
          saveTabs: saveTabsMock,
          activeSessions: activeSessionsMock,
          togglePlanMode: togglePlanModeMock,
          answerMcpQuestion: answerMcpQuestionMock,
          changeModel: changeModelMock,
          updatePlugins: updatePluginsMock,
          toggleThinkingLevel: toggleThinkingLevelMock,
          generateHandoffSummary: generateHandoffSummaryMock,
        },
        discoverWorktreeEnv: discoverWorktreeEnvMock,
        github: {
          setForegroundWorktree: setForegroundWorktreeMock,
          requestFastRefresh: requestFastRefreshMock,
        },
        savePreferences: savePreferencesMock,
        loadPreferences: loadPreferencesMock,
        showOsNotification: showOsNotificationMock,
        onOsNotificationClicked: onOsNotificationClickedMock,
        onOsNotificationClosed: onOsNotificationClosedMock,
        activity: {
          plans: {
            create: activityPlansCreateMock,
            update: activityPlansUpdateMock,
            list: activityPlansListMock,
            get: activityPlansGetMock,
          },
        },
        appAdvisor: {
          openWindow: appAdvisorOpenWindowMock,
        },
        browser: {
          back: browserBackMock,
          forward: browserForwardMock,
        },
      },
    },
  });

  loadPreferencesMock.mockResolvedValue({
    defaultChatProvider: 'claude',
    defaultChatModelByProvider: {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
    },
    defaultWorktreeProvider: 'claude',
    defaultWorktreeModelByProvider: {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
    },
  });

  const shortcuts = jest.requireActual<typeof ShortcutModule>(
    '../useGlobalShortcuts',
  );
  const chatStore = jest.requireActual<typeof ChatStoreModule>(
    '../../stores/chatStore',
  );
  const browserStore = jest.requireActual<typeof BrowserStoreModule>(
    '../../stores/browserStore',
  );
  const navigationStore = jest.requireActual<typeof NavigationStoreModule>(
    '../../stores/navigationStore',
  );
  const coworkRegistry = jest.requireActual<typeof CoworkRegistryModule>(
    '../../lib/cowork-registry',
  );
  const sidebarStore = jest.requireActual<typeof SidebarStoreModule>(
    '../../stores/sidebarStore',
  );
  const homeComposerStore = jest.requireActual<typeof HomeComposerStoreModule>(
    '../../stores/homeComposerStore',
  );
  const navigationHistoryStore = jest.requireActual<
    typeof NavigationHistoryStoreModule
  >('../../stores/navigationHistoryStore');

  return {
    handleGlobalShortcutKeyDown: shortcuts.handleGlobalShortcutKeyDown,
    useChatStore: chatStore.useChatStore,
    useBrowserStore: browserStore.useBrowserStore,
    useNavigationStore: navigationStore.useNavigationStore,
    registerCoworkWorkspaceIds: coworkRegistry.registerCoworkWorkspaceIds,
    useSidebarStore: sidebarStore.useSidebarStore,
    useHomeComposerStore: homeComposerStore.useHomeComposerStore,
    useNavigationHistoryStore: navigationHistoryStore.useNavigationHistoryStore,
  };
}

interface TestShortcutEvent {
  altKey: boolean;
  code?: string;
  ctrlKey: boolean;
  isComposing: boolean;
  key: string;
  metaKey: boolean;
  preventDefault: jest.Mock<void, []>;
  shiftKey: boolean;
  target: EventTarget | null;
}

class ClosestTarget extends EventTarget {
  constructor(private readonly matchedSelectors: readonly string[]) {
    super();
  }

  closest(selector: string): object | null {
    return this.matchedSelectors.some((candidate) =>
      selector.includes(candidate),
    )
      ? this
      : null;
  }
}

function createShortcutEvent(
  overrides?: Partial<TestShortcutEvent>,
): TestShortcutEvent {
  const platform =
    typeof navigator === 'undefined' ? '' : navigator.platform.toLowerCase();
  const isMac = platform.includes('mac');

  return {
    altKey: false,
    ctrlKey: !isMac,
    isComposing: false,
    key: 'p',
    metaKey: isMac,
    preventDefault: jest.fn<void, []>(),
    shiftKey: false,
    target: null,
    ...overrides,
  };
}

describe('handleGlobalShortcutKeyDown', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loadTabsMock.mockResolvedValue({ version: 1, tabs: [], activeTabId: '' });
    activeSessionsMock.mockResolvedValue({ activeChatIds: [], sessions: [] });
    showOsNotificationMock.mockResolvedValue({ shown: true });
    appAdvisorOpenWindowMock.mockResolvedValue({
      open: true,
      focused: true,
    });
    mockControllerHasSession.mockReturnValue(false);
    mockControllerSaveTab.mockResolvedValue(true);
    mockEnsureTerminalPanelVisible.mockReturnValue(null);
    documentQuerySelectorMock.mockReturnValue(null);
    documentDispatchEventMock.mockImplementation(() => true);
    // The sidebar store persists its hidden state fire-and-forget and chains
    // `.catch` onto the result, so this must resolve rather than return
    // undefined.
    savePreferencesMock.mockResolvedValue(undefined);
  });

  describe('ECW-7984 follow-up chords', () => {
    it('toggles the left sidebar on the primary+B chord', () => {
      const { handleGlobalShortcutKeyDown, useSidebarStore } = loadModules();
      useSidebarStore.setState({ hidden: false });

      const event = createShortcutEvent({ key: 'b' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(useSidebarStore.getState().hidden).toBe(true);
    });

    it('does not toggle the sidebar when Alt joins the B chord', () => {
      // ⌘⌥B (the deferred right-panel toggle) must stay unbound rather than
      // fall through to the ⌘B sidebar chord. macOS composes ⌥B into `∫`.
      const { handleGlobalShortcutKeyDown, useSidebarStore } = loadModules();
      useSidebarStore.setState({ hidden: false });

      const event = createShortcutEvent({
        key: '∫',
        code: 'KeyB',
        altKey: true,
      });
      handleGlobalShortcutKeyDown(event);

      expect(useSidebarStore.getState().hidden).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('drives app navigation history when the browser does not own focus', () => {
      const {
        handleGlobalShortcutKeyDown,
        useNavigationHistoryStore,
        useNavigationStore,
      } = loadModules();
      useNavigationStore.setState({ activePage: 'main' });

      const goBack = jest.fn<boolean, []>(() => true);
      useNavigationHistoryStore.setState({ canGoBack: true, goBack });

      const event = createShortcutEvent({ key: 'ArrowLeft' });
      handleGlobalShortcutKeyDown(event);

      expect(goBack).toHaveBeenCalledTimes(1);
      expect(browserBackMock).not.toHaveBeenCalled();
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it('leaves the history chord unclaimed when navigation cannot step', () => {
      const { handleGlobalShortcutKeyDown, useNavigationHistoryStore } =
        loadModules();

      // The cached flag can be stale after history pruning; the action's
      // return value is the authoritative result at invocation time.
      const goBack = jest.fn<boolean, []>(() => false);
      useNavigationHistoryStore.setState({ canGoBack: true, goBack });

      const event = createShortcutEvent({ key: 'ArrowLeft' });
      handleGlobalShortcutKeyDown(event);

      expect(goBack).toHaveBeenCalledTimes(1);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('leaves the history chord to a focused text field', () => {
      const { handleGlobalShortcutKeyDown, useNavigationHistoryStore } =
        loadModules();

      const goBack = jest.fn<boolean, []>(() => true);
      useNavigationHistoryStore.setState({ canGoBack: true, goBack });

      // ⌘← is move-to-line-start inside an input on macOS.
      const event = createShortcutEvent({
        key: 'ArrowLeft',
        target: new ClosestTarget(['input']),
      });
      handleGlobalShortcutKeyDown(event);

      expect(goBack).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('requests the project picker on Option+W, but only on Home', () => {
      const { handleGlobalShortcutKeyDown, useNavigationStore } = loadModules();

      useNavigationStore.setState({ activePage: 'main' });
      const offHome = createShortcutEvent({
        key: '∑',
        code: 'KeyW',
        altKey: true,
        metaKey: false,
        ctrlKey: false,
      });
      handleGlobalShortcutKeyDown(offHome);
      expect(offHome.preventDefault).not.toHaveBeenCalled();

      useNavigationStore.setState({ activePage: 'home' });
      documentDispatchEventMock.mockImplementation((dispatched) => {
        dispatched.preventDefault();
        return false;
      });
      const onHome = createShortcutEvent({
        key: '∑',
        code: 'KeyW',
        altKey: true,
        metaKey: false,
        ctrlKey: false,
      });
      handleGlobalShortcutKeyDown(onHome);

      expect(onHome.preventDefault).toHaveBeenCalledTimes(1);
      expect(documentDispatchEventMock).toHaveBeenCalledTimes(1);
    });

    it('addresses the active chat when Option+M opens the model picker', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();

      useNavigationStore.setState({ activePage: 'main' });
      const worktreeChat: ChatState['worktreeChats'][string] = {
        tabs: [],
        activeTabId: 'chat-7',
      };
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
        worktreeChats: {
          'project-a/wt-1': worktreeChat,
        },
      });
      documentDispatchEventMock.mockImplementation((dispatched) => {
        dispatched.preventDefault();
        return false;
      });

      const event = createShortcutEvent({
        key: 'µ',
        code: 'KeyM',
        altKey: true,
        metaKey: false,
        ctrlKey: false,
      });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      const dispatched = documentDispatchEventMock.mock.calls[0]?.[0];
      expect(dispatched).toBeInstanceOf(CustomEvent);
      if (!(dispatched instanceof CustomEvent)) {
        throw new Error('expected a composer shortcut CustomEvent');
      }
      expect(dispatched.detail).toEqual({
        scope: 'chat',
        projectId: 'project-a',
        worktreeId: 'wt-1',
        chatId: 'chat-7',
      });
    });

    it('leaves Cowork composer shortcuts unclaimed for a stale Code selection', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'chat' });
      const worktreeChat: ChatState['worktreeChats'][string] = {
        tabs: [],
        activeTabId: 'chat-7',
      };
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
        worktreeChats: { 'project-a/wt-1': worktreeChat },
      });

      const event = createShortcutEvent({
        key: 'µ',
        code: 'KeyM',
        altKey: true,
        metaKey: false,
        ctrlKey: false,
      });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(documentDispatchEventMock).not.toHaveBeenCalled();
    });

    it('leaves Option composer chords to a focused terminal', () => {
      const { handleGlobalShortcutKeyDown, useNavigationStore } = loadModules();
      useNavigationStore.setState({ activePage: 'home' });

      const event = createShortcutEvent({
        key: '†',
        code: 'KeyT',
        altKey: true,
        metaKey: false,
        ctrlKey: false,
        target: new ClosestTarget(['.xterm']),
      });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(documentDispatchEventMock).not.toHaveBeenCalled();
    });

    it('leaves Home Option shortcuts unclaimed in pipeline mode', () => {
      const {
        handleGlobalShortcutKeyDown,
        useHomeComposerStore,
        useNavigationStore,
      } = loadModules();
      useNavigationStore.setState({ activePage: 'home' });
      useHomeComposerStore.setState({ mode: 'pipeline' });

      const event = createShortcutEvent({
        key: '†',
        code: 'KeyT',
        altKey: true,
        metaKey: false,
        ctrlKey: false,
      });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(documentDispatchEventMock).not.toHaveBeenCalled();
    });

    it('leaves a composer chord unclaimed when no enabled composer handles it', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      const worktreeChat: ChatState['worktreeChats'][string] = {
        tabs: [],
        activeTabId: 'chat-7',
      };
      useNavigationStore.setState({ activePage: 'main' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
        worktreeChats: { 'project-a/wt-1': worktreeChat },
      });

      const event = createShortcutEvent({
        key: 'µ',
        code: 'KeyM',
        altKey: true,
        metaKey: false,
        ctrlKey: false,
      });
      handleGlobalShortcutKeyDown(event);

      expect(documentDispatchEventMock).toHaveBeenCalledTimes(1);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('leaves Option+T unclaimed when no composer is addressable', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();

      useNavigationStore.setState({ activePage: 'main' });
      useChatStore.setState({ selectedWorktree: null });

      const event = createShortcutEvent({
        key: '†',
        code: 'KeyT',
        altKey: true,
        metaKey: false,
        ctrlKey: false,
      });
      handleGlobalShortcutKeyDown(event);

      // Unclaimed so macOS still types `†` into whatever has focus.
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(documentDispatchEventMock).not.toHaveBeenCalled();
    });
  });

  it('navigates to main before opening the file search palette shortcut', () => {
    const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
      loadModules();

    useNavigationStore.setState({ activePage: 'workflows-library' });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
    });

    const event = createShortcutEvent();
    handleGlobalShortcutKeyDown(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().activePage).toBe('main');
    expect(useNavigationStore.getState().fileSearchPaletteOpen).toBe(true);
  });

  it('does not open the file search palette shortcut without a selection', () => {
    const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
      loadModules();

    useNavigationStore.setState({ activePage: 'workflows-library' });
    useChatStore.setState({ selectedWorktree: null });

    const event = createShortcutEvent();
    handleGlobalShortcutKeyDown(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    expect(useNavigationStore.getState().fileSearchPaletteOpen).toBe(false);
  });

  it('opens the file search palette on the chat page for a cowork work entry', () => {
    const {
      handleGlobalShortcutKeyDown,
      useChatStore,
      useNavigationStore,
      registerCoworkWorkspaceIds,
    } = loadModules();

    registerCoworkWorkspaceIds(['cowork-ws']);
    useNavigationStore.setState({ activePage: 'workflows-library' });
    useChatStore.setState({
      selectedWorktree: { projectId: 'cowork-ws', worktreeId: 'entry-1' },
    });

    const event = createShortcutEvent();
    handleGlobalShortcutKeyDown(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().activePage).toBe('chat');
    expect(useNavigationStore.getState().fileSearchPaletteOpen).toBe(true);
  });

  it('opens App Advisor with the Cmd+L shortcut', () => {
    const { handleGlobalShortcutKeyDown } = loadModules();

    const event = createShortcutEvent({ key: 'l' });
    handleGlobalShortcutKeyDown(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(appAdvisorOpenWindowMock).toHaveBeenCalledWith({
      focus: true,
      focusComposer: true,
    });
  });

  it('opens the App Advisor quick prompt with the Cmd+Shift+L shortcut', () => {
    const { handleGlobalShortcutKeyDown, useNavigationStore } = loadModules();

    const event = createShortcutEvent({ key: 'l', shiftKey: true });
    handleGlobalShortcutKeyDown(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().appAdvisorQuickPromptOpen).toBe(true);
    expect(appAdvisorOpenWindowMock).not.toHaveBeenCalled();
  });

  it('does not open App Advisor while the command palette is open', () => {
    const { handleGlobalShortcutKeyDown, useNavigationStore } = loadModules();

    useNavigationStore.setState({ commandPaletteOpen: true });

    const event = createShortcutEvent({ key: 'l' });
    handleGlobalShortcutKeyDown(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(appAdvisorOpenWindowMock).not.toHaveBeenCalled();
  });

  describe('find shortcut (⌘F, CAN-3048)', () => {
    it('hands ⌘F from an editable field to the find bar and stops there', () => {
      const { handleGlobalShortcutKeyDown } = loadModules();
      mockRunFindShortcut.mockReturnValueOnce(true);

      const event = createShortcutEvent({
        key: 'f',
        target: new ClosestTarget(['input']),
      });
      handleGlobalShortcutKeyDown(event);

      expect(mockRunFindShortcut).toHaveBeenCalledWith(
        event,
        expect.any(Function),
      );
      expect(appAdvisorOpenWindowMock).not.toHaveBeenCalled();
    });

    it("falls back to the visible grid's active panel group", () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'main' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
      });
      const { makeWorktreePanelKey } = jest.requireActual<
        typeof PanelLayoutStoreModule
      >('@/stores/panelLayoutStore');
      const layoutKey = makeWorktreePanelKey('project-a', 'wt-1');
      mockGetPanelLayoutViewModel.mockImplementation((key) =>
        key === layoutKey
          ? ({ activeGroupId: 'group-2' } as ReturnType<
              typeof PanelLayoutStoreModule.getPanelLayoutViewModel
            >)
          : undefined,
      );

      handleGlobalShortcutKeyDown(createShortcutEvent({ key: 'f' }));
      const fallback = mockRunFindShortcut.mock.calls[0]?.[1];
      fallback?.();

      expect(mockResolveFallbackFindTarget).toHaveBeenCalledWith(
        document,
        'group-2',
      );
      mockGetPanelLayoutViewModel.mockReset();
      mockGetPanelLayoutViewModel.mockReturnValue(undefined);
    });

    it('falls back without a group when no grid is visible', () => {
      const { handleGlobalShortcutKeyDown, useNavigationStore } = loadModules();
      useNavigationStore.setState({ activePage: 'plugins' });

      handleGlobalShortcutKeyDown(createShortcutEvent({ key: 'f' }));
      mockRunFindShortcut.mock.calls[0]?.[1]();

      expect(mockResolveFallbackFindTarget).toHaveBeenCalledWith(
        document,
        null,
      );
    });

    it('does not open the find bar while the command palette is open', () => {
      const { handleGlobalShortcutKeyDown, useNavigationStore } = loadModules();
      useNavigationStore.setState({ commandPaletteOpen: true });

      handleGlobalShortcutKeyDown(createShortcutEvent({ key: 'f' }));

      expect(mockRunFindShortcut).not.toHaveBeenCalled();
    });

    // CAN-4528: the one CAN-338 exception. The find chord from a terminal
    // opens only that terminal's own bar (resolved from its marker); it
    // never falls back to a sibling surface, on any platform.
    function onPlatform(platform: string, run: () => void): void {
      const originalNavigator = globalThis.navigator;
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { platform, userAgent: 'Mozilla/5.0' },
      });
      try {
        run();
      } finally {
        Object.defineProperty(globalThis, 'navigator', {
          configurable: true,
          value: originalNavigator,
        });
      }
    }

    function terminalFindEvent(
      modifier: 'ctrl' | 'meta',
      key = 'f',
    ): TestShortcutEvent {
      return createShortcutEvent({
        key,
        ctrlKey: modifier === 'ctrl',
        metaKey: modifier === 'meta',
        target: new ClosestTarget(['xterm']),
      });
    }

    it('hands Ctrl+F from a terminal to its own find bar before the CAN-338 guard', () => {
      onPlatform('Linux x86_64', () => {
        const { handleGlobalShortcutKeyDown } = loadModules();
        mockRunFindShortcut.mockReturnValueOnce(true);

        const event = terminalFindEvent('ctrl');
        handleGlobalShortcutKeyDown(event);

        expect(mockRunFindShortcut).toHaveBeenCalledTimes(1);
        expect(mockRunFindShortcut).toHaveBeenCalledWith(
          event,
          expect.any(Function),
        );
      });
    });

    it.each<[string, 'ctrl' | 'meta']>([
      ['Win32', 'ctrl'],
      ['MacIntel', 'meta'],
    ])(
      'never resolves the find chord from a terminal to a sibling surface (%s)',
      (platform, modifier) => {
        onPlatform(platform, () => {
          const { handleGlobalShortcutKeyDown } = loadModules();

          const event = terminalFindEvent(modifier);
          handleGlobalShortcutKeyDown(event);

          expect(mockRunFindShortcut).toHaveBeenCalledTimes(1);
          expect(mockRunFindShortcut.mock.calls[0]?.[1]()).toBeNull();
          expect(mockResolveFallbackFindTarget).not.toHaveBeenCalled();
          expect(event.preventDefault).not.toHaveBeenCalled();
        });
      },
    );

    it.each(['b', 'r'])('leaves Ctrl+%s in a terminal to the shell', (key) => {
      onPlatform('Linux x86_64', () => {
        const { handleGlobalShortcutKeyDown } = loadModules();

        const event = terminalFindEvent('ctrl', key);
        handleGlobalShortcutKeyDown(event);

        expect(mockRunFindShortcut).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
      });
    });
  });

  it('opens settings with Cmd+, from an editable field', () => {
    const { handleGlobalShortcutKeyDown, useNavigationStore } = loadModules();

    const editableTarget = {
      closest: jest.fn((selector: string) =>
        selector.includes('input') ? editableTarget : null,
      ),
    } as unknown as EventTarget;
    const event = createShortcutEvent({ key: ',', target: editableTarget });

    handleGlobalShortcutKeyDown(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().settingsOpen).toBe(true);
  });

  it('opens settings with Cmd+, while another palette is open', () => {
    const { handleGlobalShortcutKeyDown, useNavigationStore } = loadModules();

    useNavigationStore.setState({ commandPaletteOpen: true });
    const event = createShortcutEvent({ key: ',' });

    handleGlobalShortcutKeyDown(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().settingsOpen).toBe(true);
    expect(useNavigationStore.getState().commandPaletteOpen).toBe(false);
  });

  it('does not open the App Advisor quick prompt while settings is open', () => {
    const { handleGlobalShortcutKeyDown, useNavigationStore } = loadModules();

    useNavigationStore.setState({ settingsOpen: true });

    const event = createShortcutEvent({ key: 'l', shiftKey: true });
    handleGlobalShortcutKeyDown(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().appAdvisorQuickPromptOpen).toBe(false);
  });

  describe('close-tab shortcut (⌘W)', () => {
    beforeEach(() => {
      mockRunCloseTabShortcut.mockReset();
      mockRunCloseTabShortcut.mockReturnValue(null);
    });

    function loadWithActiveTabOnMain(): ReturnType<typeof loadModules> {
      const modules = loadModules();
      modules.useNavigationStore.setState({ activePage: 'main' });
      modules.useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
      });
      return modules;
    }

    it('delegates to the context-aware close routing for the selected worktree', () => {
      const { handleGlobalShortcutKeyDown } = loadWithActiveTabOnMain();

      const event = createShortcutEvent({ key: 'w' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRunCloseTabShortcut).toHaveBeenCalledTimes(1);
      const params = mockRunCloseTabShortcut.mock.calls[0][0];
      expect(params.projectId).toBe('project-a');
      expect(params.worktreeId).toBe('wt-1');
    });

    it('delegates even when focus is in an editable field', () => {
      // ⌘W runs BEFORE the editable-target guard: it must keep working while
      // the focus sits in the Slate composer, Monaco, or any input.
      const { handleGlobalShortcutKeyDown } = loadWithActiveTabOnMain();

      const editableTarget = new ClosestTarget(['input']);
      const event = createShortcutEvent({ key: 'w', target: editableTarget });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRunCloseTabShortcut).toHaveBeenCalledTimes(1);
    });

    it('swallows the chord without closing when off the main page', () => {
      // The chord must never fall through to a window-closing default, so it
      // is preventDefault-ed even when the close-tab action does not apply.
      const { handleGlobalShortcutKeyDown, useNavigationStore } =
        loadWithActiveTabOnMain();
      useNavigationStore.setState({ activePage: 'workflows-library' });

      const event = createShortcutEvent({ key: 'w' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRunCloseTabShortcut).not.toHaveBeenCalled();
    });

    it('swallows the chord without closing when no worktree is selected', () => {
      const { handleGlobalShortcutKeyDown, useChatStore } =
        loadWithActiveTabOnMain();
      useChatStore.setState({ selectedWorktree: null });

      const event = createShortcutEvent({ key: 'w' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRunCloseTabShortcut).not.toHaveBeenCalled();
    });

    it('routes cowork work entries on the chat page', () => {
      const {
        handleGlobalShortcutKeyDown,
        useChatStore,
        useNavigationStore,
        registerCoworkWorkspaceIds,
      } = loadModules();
      registerCoworkWorkspaceIds(['cowork-ws']);
      useNavigationStore.setState({ activePage: 'chat' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'cowork-ws', worktreeId: 'entry-1' },
      });

      const event = createShortcutEvent({ key: 'w' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRunCloseTabShortcut).toHaveBeenCalledTimes(1);
      expect(mockRunCloseTabShortcut).toHaveBeenCalledWith({
        projectId: 'cowork-ws',
        worktreeId: 'entry-1',
      });
    });

    it('swallows the chord without closing when a cowork entry is selected on the main page', () => {
      const {
        handleGlobalShortcutKeyDown,
        useChatStore,
        useNavigationStore,
        registerCoworkWorkspaceIds,
      } = loadModules();
      registerCoworkWorkspaceIds(['cowork-ws']);
      useNavigationStore.setState({ activePage: 'main' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'cowork-ws', worktreeId: 'entry-1' },
      });

      const event = createShortcutEvent({ key: 'w' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRunCloseTabShortcut).not.toHaveBeenCalled();
    });

    it('swallows the chord without closing on the chat page without a cowork selection', () => {
      const { handleGlobalShortcutKeyDown, useNavigationStore } =
        loadWithActiveTabOnMain();
      useNavigationStore.setState({ activePage: 'chat' });

      const event = createShortcutEvent({ key: 'w' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRunCloseTabShortcut).not.toHaveBeenCalled();
    });

    it('swallows the chord without closing while the quick prompt is open', () => {
      const { handleGlobalShortcutKeyDown, useNavigationStore } =
        loadWithActiveTabOnMain();
      useNavigationStore.setState({ appAdvisorQuickPromptOpen: true });

      const event = createShortcutEvent({ key: 'w' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRunCloseTabShortcut).not.toHaveBeenCalled();
    });

    it('swallows the chord without closing from an editor inside a dialog', () => {
      // A modal's editable (e.g. the review-search input) must not leak ⌘W
      // to the page behind the overlay.
      const { handleGlobalShortcutKeyDown } = loadWithActiveTabOnMain();

      const dialogEditableTarget = new ClosestTarget(['input', 'dialog']);
      const event = createShortcutEvent({
        key: 'w',
        target: dialogEditableTarget,
      });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRunCloseTabShortcut).not.toHaveBeenCalled();
    });

    it('swallows the chord without closing while the settings overlay is open', () => {
      const { handleGlobalShortcutKeyDown, useNavigationStore } =
        loadWithActiveTabOnMain();
      useNavigationStore.setState({ settingsOpen: true });

      const event = createShortcutEvent({ key: 'w' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRunCloseTabShortcut).not.toHaveBeenCalled();
    });

    it('leaves Ctrl+W to the shell when focus is in a terminal pane', () => {
      // Readline's delete-word (Ctrl+W) must reach the pty; the terminal
      // guard runs before the unconditional ⌘W swallow.
      const { handleGlobalShortcutKeyDown } = loadWithActiveTabOnMain();

      const terminalTarget = new ClosestTarget(['xterm']);
      const event = createShortcutEvent({
        key: 'w',
        ctrlKey: true,
        metaKey: false,
        target: terminalTarget,
      });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mockRunCloseTabShortcut).not.toHaveBeenCalled();
    });
  });

  it('navigates pages from an editable field', () => {
    // ⌘1–9 also run before the editable-target guard.
    const { handleGlobalShortcutKeyDown, useNavigationStore } = loadModules();
    useNavigationStore.setState({ activePage: 'main' });

    const editableTarget = new ClosestTarget(['input']);
    const event = createShortcutEvent({ key: '4', target: editableTarget });
    handleGlobalShortcutKeyDown(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
  });

  describe('panel shortcuts', () => {
    function loadWithWorktreeOnMain(): ReturnType<typeof loadModules> {
      const modules = loadModules();
      modules.useNavigationStore.setState({ activePage: 'main' });
      modules.useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
      });
      return modules;
    }

    it('dispatches split-right for the backslash shortcut on the main page', () => {
      const { handleGlobalShortcutKeyDown } = loadWithWorktreeOnMain();

      const event = createShortcutEvent({ key: '\\' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRunPanelCommand).toHaveBeenCalledWith(
        'panel-split-right',
        'project-a/wt-1',
      );
    });

    it('dispatches close-group for the shifted W shortcut without hitting close-tab', () => {
      const { handleGlobalShortcutKeyDown } = loadWithWorktreeOnMain();

      const event = createShortcutEvent({ key: 'w', shiftKey: true });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRunPanelCommand).toHaveBeenCalledWith(
        'panel-close-group',
        'project-a/wt-1',
      );
    });

    it('dispatches directional focus for alt+arrow shortcuts', () => {
      const { handleGlobalShortcutKeyDown } = loadWithWorktreeOnMain();

      const event = createShortcutEvent({ key: 'ArrowRight', altKey: true });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRunPanelCommand).toHaveBeenCalledWith(
        'panel-focus-group-right',
        'project-a/wt-1',
      );
    });

    it('no-ops without swallowing the event when off the main page', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'workflows-library' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
      });

      const event = createShortcutEvent({ key: '\\' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mockRunPanelCommand).not.toHaveBeenCalled();
    });

    it('no-ops without a normal selected worktree', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'main' });
      useChatStore.setState({ selectedWorktree: null });

      const event = createShortcutEvent({ key: '\\' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mockRunPanelCommand).not.toHaveBeenCalled();
    });

    it('is guarded against editable targets (composer keeps its keys)', () => {
      const { handleGlobalShortcutKeyDown } = loadWithWorktreeOnMain();

      const editableTarget = {
        closest: jest.fn((selector: string) =>
          selector.includes('input') ? editableTarget : null,
        ),
      } as unknown as EventTarget;
      const event = createShortcutEvent({ key: '\\', target: editableTarget });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mockRunPanelCommand).not.toHaveBeenCalled();
    });

    it('defers to the command palette while it is open', () => {
      const { handleGlobalShortcutKeyDown, useNavigationStore } =
        loadWithWorktreeOnMain();
      useNavigationStore.setState({ commandPaletteOpen: true });

      const event = createShortcutEvent({ key: '\\' });
      handleGlobalShortcutKeyDown(event);

      expect(mockRunPanelCommand).not.toHaveBeenCalled();
    });

    // CAN-4616: tab cycling. The chords never edit text, so they run before
    // the editable-target guard and act on the visible grid.
    describe('tab cycling', () => {
      function onPlatform(platform: string, run: () => void): void {
        const originalNavigator = globalThis.navigator;
        Object.defineProperty(globalThis, 'navigator', {
          configurable: true,
          value: { platform, userAgent: 'Mozilla/5.0' },
        });
        try {
          run();
        } finally {
          Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: originalNavigator,
          });
        }
      }

      function macBracketEvent(
        code: 'BracketRight' | 'BracketLeft',
        overrides?: Partial<TestShortcutEvent>,
      ): TestShortcutEvent {
        return createShortcutEvent({
          code,
          key: code === 'BracketRight' ? '}' : '{',
          shiftKey: true,
          metaKey: true,
          ctrlKey: false,
          ...overrides,
        });
      }

      function ctrlEvent(
        key: 'Tab' | 'PageDown' | 'PageUp',
        overrides?: Partial<TestShortcutEvent>,
      ): TestShortcutEvent {
        return createShortcutEvent({
          key,
          code: key,
          ctrlKey: true,
          metaKey: false,
          ...overrides,
        });
      }

      it.each([
        ['BracketRight', 'panel-select-next-tab'],
        ['BracketLeft', 'panel-select-previous-tab'],
      ] as const)('dispatches ⌘⇧ %s on macOS as %s', (code, commandId) => {
        onPlatform('MacIntel', () => {
          const { handleGlobalShortcutKeyDown } = loadWithWorktreeOnMain();

          const event = macBracketEvent(code);
          handleGlobalShortcutKeyDown(event);

          expect(event.preventDefault).toHaveBeenCalledTimes(1);
          expect(mockRunPanelCommand).toHaveBeenCalledWith(
            commandId,
            'project-a/wt-1',
          );
        });
      });

      it('dispatches from an editable target and a terminal on macOS', () => {
        onPlatform('MacIntel', () => {
          const { handleGlobalShortcutKeyDown } = loadWithWorktreeOnMain();

          for (const target of [
            new ClosestTarget(['input']),
            new ClosestTarget(['xterm']),
          ]) {
            const event = macBracketEvent('BracketRight', { target });
            handleGlobalShortcutKeyDown(event);
            expect(event.preventDefault).toHaveBeenCalledTimes(1);
          }
          expect(mockRunPanelCommand).toHaveBeenCalledTimes(2);
        });
      });

      it('does not dispatch from an editable target inside a dialog', () => {
        onPlatform('MacIntel', () => {
          const { handleGlobalShortcutKeyDown } = loadWithWorktreeOnMain();

          const event = macBracketEvent('BracketRight', {
            target: new ClosestTarget(['input', 'dialog']),
          });
          handleGlobalShortcutKeyDown(event);

          expect(event.preventDefault).not.toHaveBeenCalled();
          expect(mockRunPanelCommand).not.toHaveBeenCalled();
        });
      });

      it('does not match the macOS chord on other platforms', () => {
        onPlatform('Win32', () => {
          const { handleGlobalShortcutKeyDown } = loadWithWorktreeOnMain();

          const event = macBracketEvent('BracketRight');
          handleGlobalShortcutKeyDown(event);

          expect(mockRunPanelCommand).not.toHaveBeenCalled();
        });
      });

      it.each([
        ['Tab', false, 'panel-select-next-tab'],
        ['Tab', true, 'panel-select-previous-tab'],
        ['PageDown', false, 'panel-select-next-tab'],
        ['PageUp', false, 'panel-select-previous-tab'],
      ] as const)(
        'dispatches Ctrl+%s (shift: %s) on Windows as %s',
        (key, shiftKey, commandId) => {
          onPlatform('Win32', () => {
            const { handleGlobalShortcutKeyDown } = loadWithWorktreeOnMain();

            const event = ctrlEvent(key, {
              shiftKey,
              target: new ClosestTarget(['input']),
            });
            handleGlobalShortcutKeyDown(event);

            expect(event.preventDefault).toHaveBeenCalledTimes(1);
            expect(mockRunPanelCommand).toHaveBeenCalledWith(
              commandId,
              'project-a/wt-1',
            );
          });
        },
      );

      it('does not match Ctrl+Tab on macOS', () => {
        onPlatform('MacIntel', () => {
          const { handleGlobalShortcutKeyDown } = loadWithWorktreeOnMain();

          const event = ctrlEvent('Tab');
          handleGlobalShortcutKeyDown(event);

          expect(event.preventDefault).not.toHaveBeenCalled();
          expect(mockRunPanelCommand).not.toHaveBeenCalled();
        });
      });

      // Selecting a terminal tab focuses it, so a cycle that lands on one
      // must still be able to leave it on Windows/Linux.
      it.each([
        ['Tab', 'panel-select-next-tab'],
        ['PageUp', 'panel-select-previous-tab'],
      ] as const)(
        'dispatches Ctrl+%s from a focused terminal on Windows as %s',
        (key, commandId) => {
          onPlatform('Win32', () => {
            const { handleGlobalShortcutKeyDown } = loadWithWorktreeOnMain();

            const event = ctrlEvent(key, {
              target: new ClosestTarget(['xterm']),
            });
            handleGlobalShortcutKeyDown(event);

            expect(event.preventDefault).toHaveBeenCalledTimes(1);
            expect(mockRunPanelCommand).toHaveBeenCalledWith(
              commandId,
              'project-a/wt-1',
            );
          });
        },
      );

      it('still leaves other Ctrl chords to a focused terminal on Windows (CAN-338)', () => {
        onPlatform('Win32', () => {
          const { handleGlobalShortcutKeyDown } = loadWithWorktreeOnMain();

          const event = createShortcutEvent({
            key: '\\',
            ctrlKey: true,
            metaKey: false,
            target: new ClosestTarget(['xterm']),
          });
          handleGlobalShortcutKeyDown(event);

          expect(event.preventDefault).not.toHaveBeenCalled();
          expect(mockRunPanelCommand).not.toHaveBeenCalled();
        });
      });

      it('does not dispatch from a focused button inside a dialog', () => {
        onPlatform('MacIntel', () => {
          const { handleGlobalShortcutKeyDown } = loadWithWorktreeOnMain();

          const event = macBracketEvent('BracketRight', {
            target: new ClosestTarget(['dialog']),
          });
          handleGlobalShortcutKeyDown(event);

          expect(event.preventDefault).not.toHaveBeenCalled();
          expect(mockRunPanelCommand).not.toHaveBeenCalled();
        });
      });

      it('routes cowork work entries on the chat page', () => {
        onPlatform('MacIntel', () => {
          const {
            handleGlobalShortcutKeyDown,
            useChatStore,
            useNavigationStore,
            registerCoworkWorkspaceIds,
          } = loadModules();
          registerCoworkWorkspaceIds(['cowork-ws']);
          useNavigationStore.setState({ activePage: 'chat' });
          useChatStore.setState({
            selectedWorktree: { projectId: 'cowork-ws', worktreeId: 'entry-1' },
          });

          const event = macBracketEvent('BracketRight');
          handleGlobalShortcutKeyDown(event);

          expect(event.preventDefault).toHaveBeenCalledTimes(1);
          expect(mockRunPanelCommand).toHaveBeenCalledWith(
            'panel-select-next-tab',
            'cowork-ws/entry-1',
          );
        });
      });

      it('stays unclaimed off a visible grid or without a selection', () => {
        onPlatform('MacIntel', () => {
          const {
            handleGlobalShortcutKeyDown,
            useChatStore,
            useNavigationStore,
          } = loadWithWorktreeOnMain();

          useNavigationStore.setState({ activePage: 'workflows-library' });
          const offPage = macBracketEvent('BracketRight');
          handleGlobalShortcutKeyDown(offPage);

          useNavigationStore.setState({ activePage: 'main' });
          useChatStore.setState({ selectedWorktree: null });
          const noSelection = macBracketEvent('BracketRight');
          handleGlobalShortcutKeyDown(noSelection);

          expect(offPage.preventDefault).not.toHaveBeenCalled();
          expect(noSelection.preventDefault).not.toHaveBeenCalled();
          expect(mockRunPanelCommand).not.toHaveBeenCalled();
        });
      });

      it('defers to the command palette and an already-consumed event', () => {
        onPlatform('MacIntel', () => {
          const { handleGlobalShortcutKeyDown, useNavigationStore } =
            loadWithWorktreeOnMain();

          const consumed = {
            ...macBracketEvent('BracketRight'),
            defaultPrevented: true,
          };
          handleGlobalShortcutKeyDown(consumed);

          useNavigationStore.setState({ commandPaletteOpen: true });
          handleGlobalShortcutKeyDown(macBracketEvent('BracketRight'));

          expect(mockRunPanelCommand).not.toHaveBeenCalled();
        });
      });

      it.each([
        'fileSearchPaletteOpen',
        'prPickerOpen',
        'settingsOpen',
        'appAdvisorQuickPromptOpen',
      ] as const)('does not dispatch while %s', (overlay) => {
        onPlatform('MacIntel', () => {
          const { handleGlobalShortcutKeyDown, useNavigationStore } =
            loadWithWorktreeOnMain();

          useNavigationStore.setState({ [overlay]: true });
          const event = macBracketEvent('BracketRight');
          handleGlobalShortcutKeyDown(event);

          expect(event.preventDefault).not.toHaveBeenCalled();
          expect(mockRunPanelCommand).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe('Cmd/Ctrl+S save shortcut (single Cmd/Ctrl+S owner)', () => {
    // Runs in the node test environment (no jsdom), so the editable target is
    // a structural EventTarget with the duck-typed `closest` the production
    // `isEditableTarget` guard probes for — no DOM and no casting needed.
    function makeEditableTarget(): EventTarget & {
      closest: (selector: string) => unknown;
    } {
      const editableRoot = {};
      return {
        addEventListener: (): void => {},
        removeEventListener: (): void => {},
        dispatchEvent: (): boolean => true,
        closest: (selector: string): unknown =>
          selector.includes('textarea') ||
          selector.includes('input') ||
          selector.includes('contenteditable')
            ? editableRoot
            : null,
      };
    }

    function loadWithActiveTab(
      kind: 'file' | 'chat',
    ): ReturnType<typeof loadModules> {
      const modules = loadModules();
      modules.useNavigationStore.setState({ activePage: 'main' });
      const chatState: Partial<ChatState> = {
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
        worktreeChats: {
          'project-a/wt-1': {
            tabs: [
              {
                id: 'file-1',
                title: 'notes.md',
                ...(kind === 'file'
                  ? { kind: 'file', filePath: '/abs/notes.md' }
                  : {}),
                messages: [],
                status: 'idle',
                error: null,
                createdAt: '2026-04-25T00:00:00.000Z',
                queuedMessages: [],
                planMode: false,
                proposalMode: 'optional',
                thinkingLevel: 'high',
                modelConfig: {
                  thinkingLevel: 'high',
                  speed: 'standard',
                  fastMode: false,
                },
                fastModeExplicit: false,
              },
            ],
            activeTabId: 'file-1',
          },
        },
      };
      modules.useChatStore.setState(chatState);
      return modules;
    }

    it('saves the active file tab exactly once with focus outside an editor', () => {
      mockControllerHasSession.mockReturnValue(true);
      const { handleGlobalShortcutKeyDown } = loadWithActiveTab('file');

      const event = createShortcutEvent({ key: 's', target: null });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockControllerSaveTab).toHaveBeenCalledTimes(1);
      expect(mockControllerSaveTab).toHaveBeenCalledWith('file-1');
    });

    it('saves the active file tab exactly once with focus inside a Monaco-like editable target', () => {
      mockControllerHasSession.mockReturnValue(true);
      const { handleGlobalShortcutKeyDown } = loadWithActiveTab('file');

      const event = createShortcutEvent({
        key: 's',
        target: makeEditableTarget(),
      });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockControllerSaveTab).toHaveBeenCalledTimes(1);
    });

    it('leaves the keystroke unclaimed when the file tab has no shared session', () => {
      mockControllerHasSession.mockReturnValue(false);
      const { handleGlobalShortcutKeyDown } = loadWithActiveTab('file');

      const event = createShortcutEvent({ key: 's', target: null });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mockControllerSaveTab).not.toHaveBeenCalled();
    });

    it('does not save when the active tab is not a file tab', () => {
      mockControllerHasSession.mockReturnValue(true);
      const { handleGlobalShortcutKeyDown } = loadWithActiveTab('chat');

      const event = createShortcutEvent({ key: 's', target: null });
      handleGlobalShortcutKeyDown(event);

      expect(mockControllerSaveTab).not.toHaveBeenCalled();
    });
  });

  describe('context-aware new-tab shortcut (⌘T, ECW-7984)', () => {
    it('routes through runNewTabShortcut for the selected worktree on main', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'main' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
      });

      const event = createShortcutEvent({ key: 't' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRunNewTabShortcut).toHaveBeenCalledTimes(1);
      const params = mockRunNewTabShortcut.mock.calls[0][0];
      expect(params.projectId).toBe('project-a');
      expect(params.worktreeId).toBe('wt-1');
      expect(params.target).toBeNull();
    });

    it('creates a chat tab through the chat store when the routing falls back to chat', () => {
      const createTabMock = jest.fn<void, []>();
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'main' });
      const chatState: Partial<ChatState> = {
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
        createTab: createTabMock,
      };
      useChatStore.setState(chatState);

      handleGlobalShortcutKeyDown(createShortcutEvent({ key: 't' }));

      const params = mockRunNewTabShortcut.mock.calls[0][0];
      params.createChatTab();
      expect(createTabMock).toHaveBeenCalledTimes(1);
    });

    it('still routes with focus in an editable field (composer must not swallow ⌘T)', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'main' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
      });

      const editableTarget = new ClosestTarget(['input']);
      const event = createShortcutEvent({ key: 't', target: editableTarget });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRunNewTabShortcut).toHaveBeenCalledTimes(1);
      expect(mockRunNewTabShortcut.mock.calls[0][0].target).toBe(
        editableTarget,
      );
    });

    it('routes cowork work entries on the chat page', () => {
      const {
        handleGlobalShortcutKeyDown,
        useChatStore,
        useNavigationStore,
        registerCoworkWorkspaceIds,
      } = loadModules();
      registerCoworkWorkspaceIds(['cowork-ws']);
      useNavigationStore.setState({ activePage: 'chat' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'cowork-ws', worktreeId: 'entry-1' },
      });

      const event = createShortcutEvent({ key: 't' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      const params = mockRunNewTabShortcut.mock.calls[0][0];
      expect(params.projectId).toBe('cowork-ws');
      expect(params.worktreeId).toBe('entry-1');
    });

    it('creates a Pipeline Assistant chat tab on the pipelines page', () => {
      const createTabMock = jest.fn();
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'workflows-library' });
      const chatState: Partial<ChatState> = {
        selectedWorktree: null,
        createTab: createTabMock,
      };
      useChatStore.setState(chatState);

      const event = createShortcutEvent({ key: 't' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRunNewTabShortcut).not.toHaveBeenCalled();
      // Opens the assistant drawer + creates a tab in the pipeline editor
      // synthetic worktree.
      expect(windowDispatchEventMock).toHaveBeenCalledTimes(1);
      expect(createTabMock).toHaveBeenCalledWith({
        projectId: 'pipeline-editor',
        worktreeId: 'pipeline-editor',
      });
    });

    it('falls back to the command palette on non-tabbed pages without navigating', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'audit' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
      });

      const event = createShortcutEvent({ key: 't' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRunNewTabShortcut).not.toHaveBeenCalled();
      expect(useNavigationStore.getState().activePage).toBe('audit');
      expect(useNavigationStore.getState().commandPaletteOpen).toBe(true);
    });

    it('does not fire from an editor inside a dialog', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'main' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
      });

      const dialogEditableTarget = new ClosestTarget(['input', 'dialog']);
      const event = createShortcutEvent({
        key: 't',
        target: dialogEditableTarget,
      });
      handleGlobalShortcutKeyDown(event);

      expect(mockRunNewTabShortcut).not.toHaveBeenCalled();
    });
  });

  it('opens the new-task Home surface with ⌘N', () => {
    const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
      loadModules();
    useNavigationStore.setState({ activePage: 'main' });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
    });

    const event = createShortcutEvent({ key: 'n' });
    handleGlobalShortcutKeyDown(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().activePage).toBe('home');
  });

  describe('browser chrome shortcuts (ECW-7984)', () => {
    const browserTarget = new ClosestTarget(['data-browser-surface']);

    function loadWithBrowserBucket(): ReturnType<typeof loadModules> {
      const modules = loadModules();
      modules.useNavigationStore.setState({ activePage: 'main' });
      modules.useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
      });
      modules.useBrowserStore.setState({
        worktrees: {
          'project-a/wt-1': {
            browserOrder: ['browser-1'],
            activeBrowserId: 'browser-1',
            browsers: {},
            live: new Set<string>(),
            hydrated: true,
          },
        },
      });
      return modules;
    }

    it('⌘L focuses the active browser address bar while browser chrome owns focus', () => {
      const { handleGlobalShortcutKeyDown } = loadWithBrowserBucket();

      const event = createShortcutEvent({ key: 'l', target: browserTarget });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRequestBrowserUrlFocus).toHaveBeenCalledWith('browser-1');
      expect(appAdvisorOpenWindowMock).not.toHaveBeenCalled();
    });

    it('⌘L keeps its App Advisor binding outside the browser surface', () => {
      const { handleGlobalShortcutKeyDown } = loadWithBrowserBucket();

      const event = createShortcutEvent({ key: 'l' });
      handleGlobalShortcutKeyDown(event);

      expect(mockRequestBrowserUrlFocus).not.toHaveBeenCalled();
      expect(appAdvisorOpenWindowMock).toHaveBeenCalledTimes(1);
    });

    it('⌘←/⌘→ navigate the active browser tab back/forward from browser chrome', () => {
      browserBackMock.mockResolvedValue({ id: 'browser-1' });
      browserForwardMock.mockResolvedValue({ id: 'browser-1' });
      const { handleGlobalShortcutKeyDown } = loadWithBrowserBucket();

      const backEvent = createShortcutEvent({
        key: 'ArrowLeft',
        target: browserTarget,
      });
      handleGlobalShortcutKeyDown(backEvent);
      expect(backEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(browserBackMock).toHaveBeenCalledWith({ browserId: 'browser-1' });

      const forwardEvent = createShortcutEvent({
        key: 'ArrowRight',
        target: browserTarget,
      });
      handleGlobalShortcutKeyDown(forwardEvent);
      expect(forwardEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(browserForwardMock).toHaveBeenCalledWith({
        browserId: 'browser-1',
      });
    });

    it('does not fall through to app history when browser chrome has no active session', () => {
      const {
        handleGlobalShortcutKeyDown,
        useBrowserStore,
        useNavigationHistoryStore,
      } = loadWithBrowserBucket();
      useBrowserStore.setState({
        worktrees: {
          'project-a/wt-1': {
            browserOrder: [],
            activeBrowserId: null,
            browsers: {},
            live: new Set<string>(),
            hydrated: true,
          },
        },
      });
      const goBack = jest.fn<boolean, []>(() => true);
      useNavigationHistoryStore.setState({ canGoBack: true, goBack });

      const event = createShortcutEvent({
        key: 'ArrowLeft',
        target: browserTarget,
      });
      handleGlobalShortcutKeyDown(event);

      expect(browserBackMock).not.toHaveBeenCalled();
      expect(goBack).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('accepts the Alt+arrow history convention from browser chrome', () => {
      const originalNavigator = globalThis.navigator;
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { platform: 'Linux x86_64', userAgent: 'Mozilla/5.0' },
      });
      try {
        browserBackMock.mockResolvedValue({ id: 'browser-1' });
        const { handleGlobalShortcutKeyDown } = loadWithBrowserBucket();

        const event = createShortcutEvent({
          key: 'ArrowLeft',
          altKey: true,
          ctrlKey: false,
          metaKey: false,
          target: browserTarget,
        });
        handleGlobalShortcutKeyDown(event);

        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(browserBackMock).toHaveBeenCalledWith({
          browserId: 'browser-1',
        });
      } finally {
        Object.defineProperty(globalThis, 'navigator', {
          configurable: true,
          value: originalNavigator,
        });
      }
    });

    it('leaves arrow chords alone in editable targets (address bar cursor keys)', () => {
      const { handleGlobalShortcutKeyDown } = loadWithBrowserBucket();

      const editableBrowserTarget = new ClosestTarget([
        'data-browser-surface',
        'input',
      ]);
      const event = createShortcutEvent({
        key: 'ArrowLeft',
        target: editableBrowserTarget,
      });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(browserBackMock).not.toHaveBeenCalled();
    });

    it('does not claim arrow chords outside the browser surface', () => {
      const { handleGlobalShortcutKeyDown } = loadWithBrowserBucket();

      const event = createShortcutEvent({ key: 'ArrowLeft' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(browserBackMock).not.toHaveBeenCalled();
    });
  });

  describe('open-terminal shortcut (Ctrl+`)', () => {
    it('uses the physical Backquote key across keyboard layouts', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'main' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
      });

      const event = createShortcutEvent({
        code: 'Backquote',
        key: 'Dead',
        ctrlKey: true,
        metaKey: false,
      });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockRequestTerminalSpawn).toHaveBeenCalledWith({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        layoutKey: 'project-a/wt-1',
        mode: 'ensure',
      });
    });

    it('reveals the terminal panel and requests an ensure-spawn', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'main' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
      });

      const event = createShortcutEvent({
        key: '`',
        ctrlKey: true,
        metaKey: false,
      });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockEnsureTerminalPanelVisible).toHaveBeenCalledWith(
        'project-a/wt-1',
      );
      expect(mockRequestTerminalSpawn).toHaveBeenCalledWith({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        layoutKey: 'project-a/wt-1',
        mode: 'ensure',
      });
    });

    it('scopes ensure-spawn to the auxiliary layout returned by reveal', () => {
      mockEnsureTerminalPanelVisible.mockReturnValue({
        layoutKey: 'project-a/wt-1#aux:terminal-window',
        groupId: 'group-aux',
        panelId: 'panel-terminal',
      });
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'main' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
      });

      handleGlobalShortcutKeyDown(
        createShortcutEvent({
          key: '`',
          ctrlKey: true,
          metaKey: false,
        }),
      );

      expect(mockRequestTerminalSpawn).toHaveBeenCalledWith({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        layoutKey: 'project-a/wt-1#aux:terminal-window',
        mode: 'ensure',
      });
    });

    it('does not use the key fallback when code identifies another key', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'main' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
      });

      const event = createShortcutEvent({
        code: 'KeyP',
        key: '`',
        ctrlKey: true,
        metaKey: false,
      });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mockRequestTerminalSpawn).not.toHaveBeenCalled();
    });

    it('leaves Ctrl+` to the shell when focus is in a terminal pane', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'main' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
      });

      const terminalTarget = new ClosestTarget(['xterm']);
      const event = createShortcutEvent({
        key: '`',
        ctrlKey: true,
        metaKey: false,
        target: terminalTarget,
      });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mockRequestTerminalSpawn).not.toHaveBeenCalled();
    });

    it('no-ops without a visible panel grid', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'audit' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
      });

      const event = createShortcutEvent({
        key: '`',
        ctrlKey: true,
        metaKey: false,
      });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mockRequestTerminalSpawn).not.toHaveBeenCalled();
    });
  });

  describe('attachments shortcut (⌘U)', () => {
    it('asks the visible composer to open its attachment picker', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'main' });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
        worktreeChats: {
          'project-a/wt-1': {
            tabs: [],
            activeTabId: 'chat-1',
          },
        },
      });

      const event = createShortcutEvent({ key: 'u' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(documentDispatchEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'canopy:open-chat-attachments',
          detail: {
            projectId: 'project-a',
            worktreeId: 'wt-1',
            chatId: 'chat-1',
          },
        }),
      );
    });

    it('leaves the chord unclaimed without a chat surface', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'audit' });
      useChatStore.setState({ selectedWorktree: null });

      const event = createShortcutEvent({ key: 'u' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(documentDispatchEventMock).not.toHaveBeenCalled();
    });

    it('routes to the visible Pipeline Assistant composer on the pipelines page', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'workflows-library' });
      useChatStore.setState({
        selectedWorktree: null,
        worktreeChats: {
          'pipeline-editor/pipeline-editor': {
            tabs: [],
            activeTabId: 'assistant-chat-1',
          },
        },
      });
      // The drawer is only mounted while visible; simulate its presence.
      documentQuerySelectorMock.mockReturnValue({
        getClientRects: () => [{}],
      });

      const event = createShortcutEvent({ key: 'u' });
      handleGlobalShortcutKeyDown(event);

      expect(documentQuerySelectorMock).toHaveBeenCalledWith(
        '[data-testid="pipeline-chat-panel"]',
      );
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(documentDispatchEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'canopy:open-chat-attachments',
          detail: {
            projectId: 'pipeline-editor',
            worktreeId: 'pipeline-editor',
            chatId: 'assistant-chat-1',
          },
        }),
      );
    });

    it('leaves the chord unclaimed on pipelines while the assistant drawer is hidden', () => {
      const { handleGlobalShortcutKeyDown, useChatStore, useNavigationStore } =
        loadModules();
      useNavigationStore.setState({ activePage: 'workflows-library' });
      useChatStore.setState({
        selectedWorktree: null,
        worktreeChats: {
          'pipeline-editor/pipeline-editor': {
            tabs: [],
            activeTabId: 'assistant-chat-1',
          },
        },
      });
      // A responsive class can hide the mounted drawer at narrow widths.
      documentQuerySelectorMock.mockReturnValue({
        getClientRects: () => [],
      });

      const event = createShortcutEvent({ key: 'u' });
      handleGlobalShortcutKeyDown(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(documentDispatchEventMock).not.toHaveBeenCalled();
    });
  });
});
