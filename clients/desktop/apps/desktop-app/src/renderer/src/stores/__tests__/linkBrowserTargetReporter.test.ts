import type * as ReporterModule from '../linkBrowserTargetReporter';
import type * as ChatStoreModule from '../chatStore';
import type * as NavigationStoreModule from '../navigationStore';

type ReporterModules = {
  startLinkBrowserTargetReporter: typeof ReporterModule.startLinkBrowserTargetReporter;
  useChatStore: typeof ChatStoreModule.useChatStore;
  useNavigationStore: typeof NavigationStoreModule.useNavigationStore;
};

const reportLinkBrowserTarget = jest.fn<void, [{ available: boolean }]>();

const WORKTREE = { projectId: 'project-1', worktreeId: 'worktree-1' };

/** Fresh module state per test: the reporter starts once per module. */
function load(): ReporterModules {
  jest.resetModules();
  return {
    startLinkBrowserTargetReporter: jest.requireActual<typeof ReporterModule>(
      '../linkBrowserTargetReporter',
    ).startLinkBrowserTargetReporter,
    useChatStore:
      jest.requireActual<typeof ChatStoreModule>('../chatStore').useChatStore,
    useNavigationStore:
      jest.requireActual<typeof NavigationStoreModule>('../navigationStore')
        .useNavigationStore,
  };
}

function sent(): boolean[] {
  return reportLinkBrowserTarget.mock.calls.map(
    ([request]) => request.available,
  );
}

beforeEach(() => {
  reportLinkBrowserTarget.mockReset();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: { browser: { reportLinkBrowserTarget } } },
  });
});

it('publishes the current value immediately on start', () => {
  const { startLinkBrowserTargetReporter, useChatStore, useNavigationStore } =
    load();
  useChatStore.setState({ selectedWorktree: WORKTREE });
  useNavigationStore.setState({ activePage: 'main', settingsOpen: false });

  startLinkBrowserTargetReporter();

  expect(sent()).toEqual([true]);
});

it('reports true only for a selected worktree on the uncovered main page', () => {
  const { startLinkBrowserTargetReporter, useChatStore, useNavigationStore } =
    load();
  useChatStore.setState({ selectedWorktree: null });
  useNavigationStore.setState({
    activePage: 'main',
    settingsOpen: false,
    canopyPortalOpen: false,
  });
  startLinkBrowserTargetReporter();

  useChatStore.setState({ selectedWorktree: WORKTREE });
  useNavigationStore.setState({ activePage: 'plugins' });
  useNavigationStore.setState({ activePage: 'main' });
  useNavigationStore.setState({ settingsOpen: true });
  useNavigationStore.setState({ settingsOpen: false });
  useNavigationStore.setState({ canopyPortalOpen: true });
  useNavigationStore.setState({ canopyPortalOpen: false });
  useChatStore.setState({ selectedWorktree: null });

  expect(sent()).toEqual([
    false,
    true,
    false,
    true,
    false,
    true,
    false,
    true,
    false,
  ]);
});

it('sends nothing when the value is unchanged', () => {
  const { startLinkBrowserTargetReporter, useChatStore, useNavigationStore } =
    load();
  useChatStore.setState({ selectedWorktree: WORKTREE });
  useNavigationStore.setState({ activePage: 'main', settingsOpen: false });
  startLinkBrowserTargetReporter();

  useChatStore.setState({
    selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-2' },
  });
  useNavigationStore.setState({ homeComposerFocusRequest: 99 });

  expect(sent()).toEqual([true]);
});

it('skips store updates that leave its inputs unchanged', () => {
  const { startLinkBrowserTargetReporter, useChatStore, useNavigationStore } =
    load();
  useChatStore.setState({ selectedWorktree: WORKTREE });
  useNavigationStore.setState({ activePage: 'main', settingsOpen: false });
  startLinkBrowserTargetReporter();
  // Streaming chat updates must not recompute availability.
  const readNavigation = jest.spyOn(useNavigationStore, 'getState');

  useChatStore.setState({ approvalDefaultsCache: {} });
  useNavigationStore.setState({ commandPaletteOpen: true });

  expect(readNavigation).not.toHaveBeenCalled();
  expect(sent()).toEqual([true]);
});

it('starts only once', () => {
  const { startLinkBrowserTargetReporter, useChatStore, useNavigationStore } =
    load();
  useChatStore.setState({ selectedWorktree: WORKTREE });
  useNavigationStore.setState({ activePage: 'main', settingsOpen: false });
  startLinkBrowserTargetReporter();
  startLinkBrowserTargetReporter();

  useNavigationStore.setState({ activePage: 'plugins' });

  expect(sent()).toEqual([true, false]);
});
