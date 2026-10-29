/**
 * @jest-environment jsdom
 */
// The snapshot builder is the expensive, allocation-heavy reader of renderer
// state that this projection must NOT reach for. Mocking it lets the "cost"
// suite below assert the projection never calls it, at any update frequency.
const mockBuildCurrentUiStateSnapshot = jest.fn();
jest.mock('@/lib/current-ui-state/buildCurrentUiStateSnapshot', () => ({
  __esModule: true,
  buildCurrentUiStateSnapshot: (...args: unknown[]): unknown =>
    mockBuildCurrentUiStateSnapshot(...args),
  formatAppAdvisorHiddenUiState: (): string => '',
}));

import {
  NAVIGATION_PAGE_ROUTES,
  PANEL_KIND_ROUTES,
  SETTINGS_SECTION_ROUTES,
  isPostHogRoute,
  type PostHogRoute,
} from '@canopy/desktop-instrumentation/posthog-routes';
import { PANEL_KINDS, type PanelKind } from '@canopy/protocol/panels';
import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type NavigationPage,
  type SettingsSection,
  type WorktreeSelection,
} from '@canopy/desktop-shared/types';
import {
  createAppAdvisorPostHogRouteSource,
  createMainWindowPostHogRouteSource,
  createPostHogRouteSource,
} from '../posthog-route-source';
import { setCurrentChatPanelVisible } from '@/lib/worktree-layout-prefs';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import { setStandaloneChatArchiveOverlayOpen } from '@/stores/standaloneChatVisibility';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

// ---------------------------------------------------------------------------
// Privacy fixtures
//
// Deliberately distinctive so the privacy suite can assert that no emitted
// route ever contains any of them. They stand in for the categories the
// catalog forbids: workspace and branch names, chat titles, file paths, and
// browser URLs.
// ---------------------------------------------------------------------------

const SECRET_PROJECT_ID = 'acme-secret-payments-workspace';
const SECRET_WORKTREE_ID = 'feature/redacted-billing-branch';
const SECRET_CHAT_TITLE = 'Q3 layoff planning thread';
const SECRET_FILE_PATH = '/Users/someone/private/salaries.csv';
const SECRET_BROWSER_URL = 'https://internal.acme.example/secret-dashboard';
const SECRET_VALUES = [
  SECRET_PROJECT_ID,
  SECRET_WORKTREE_ID,
  SECRET_CHAT_TITLE,
  SECRET_FILE_PATH,
  SECRET_BROWSER_URL,
  'acme',
  'redacted',
  'salaries',
];

const SECRET_SELECTION: WorktreeSelection = {
  projectId: SECRET_PROJECT_ID,
  worktreeId: SECRET_WORKTREE_ID,
};

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface FakeTab {
  panelId: string;
  kind: string;
}

interface FakeGroup {
  groupId: string;
  activePanelId: string | null;
  tabs: FakeTab[];
}

interface FakeViewModel {
  groups: FakeGroup[];
  activeGroupId: string | null;
  maximizedGroupId: string | null;
}

/**
 * Install a layout view model under `key`. Only the fields the projection
 * reads are populated; `getPanelLayoutViewModel` reads `layouts[key].viewModel`
 * and nothing else on the record.
 */
function setLayout(key: string, viewModel: FakeViewModel): void {
  usePanelLayoutStore.setState((state) => ({
    layouts: {
      ...state.layouts,
      [key]: { viewModel } as unknown as (typeof state.layouts)[string],
    },
  }));
}

/** A single expanded group whose active tab is `kind`. */
function singlePanelViewModel(
  kind: string,
  overrides: Partial<FakeViewModel> = {},
): FakeViewModel {
  return {
    groups: [
      {
        groupId: 'group-a',
        activePanelId: 'panel-1',
        tabs: [
          { panelId: 'panel-1', kind },
          // A distinctive sibling tab: nothing about non-active tabs may ever
          // influence (or leak into) the projection.
          { panelId: `panel-${SECRET_FILE_PATH}`, kind: 'file-diff' },
        ],
      },
    ],
    activeGroupId: 'group-a',
    maximizedGroupId: null,
    ...overrides,
  };
}

const WORKTREE_LAYOUT_KEY = `${SECRET_PROJECT_ID}/${SECRET_WORKTREE_ID}`;
const COWORK_PROJECT_ID = STANDALONE_CHAT_PROJECT_ID;
const COWORK_ENTRY_ID = 'work-entry-with-a-secret-name';
const COWORK_LAYOUT_KEY = `${COWORK_PROJECT_ID}/${COWORK_ENTRY_ID}`;

/** Put the main window on the Code page with a visible worktree chat. */
function selectWorktree(selection: WorktreeSelection = SECRET_SELECTION): void {
  useNavigationStore.setState({ activePage: 'main' });
  useChatStore.setState({ selectedWorktree: selection });
}

/** Put the main window on the Co-Work page with an active Work Entry. */
function selectCowork(entryId: string | null = COWORK_ENTRY_ID): void {
  useNavigationStore.setState({ activePage: 'chat' });
  useStandaloneChatStore.setState({
    activeChatProjectId: COWORK_PROJECT_ID,
    activeWorkEntryId: entryId,
  });
  useChatStore.setState({
    selectedWorktree:
      entryId === null
        ? null
        : { projectId: COWORK_PROJECT_ID, worktreeId: entryId },
  });
}

function openSettingsWithSection(section: SettingsSection | null): void {
  useNavigationStore.setState({
    settingsOpen: true,
    settingsActiveSection: section,
  });
}

/** Let the source's microtask coalescing window close. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Subscribe and collect every emitted route, newest last. */
function subscribeCollecting(source: {
  subscribe(listener: (route: PostHogRoute) => void): () => void;
}): { routes: PostHogRoute[]; unsubscribe: () => void } {
  const routes: PostHogRoute[] = [];
  const unsubscribe = source.subscribe((route) => routes.push(route));
  return { routes, unsubscribe };
}

// ---------------------------------------------------------------------------

const originalNavigationState = useNavigationStore.getState();
const originalChatSelection = useChatStore.getState().selectedWorktree;
const originalStandaloneState = {
  activeChatProjectId: useStandaloneChatStore.getState().activeChatProjectId,
  activeWorkEntryId: useStandaloneChatStore.getState().activeWorkEntryId,
};

beforeEach(() => {
  mockBuildCurrentUiStateSnapshot.mockClear();
  useNavigationStore.setState({
    activePage: 'overview',
    settingsOpen: false,
    settingsInitialSection: undefined,
    settingsActiveSection: null,
    settingsHostedLocation: null,
    settingsHostedHistory: [],
  });
  useChatStore.setState({ selectedWorktree: null });
  useStandaloneChatStore.setState({
    activeChatProjectId: COWORK_PROJECT_ID,
    activeWorkEntryId: null,
  });
  usePanelLayoutStore.setState({ layouts: {} });
  setCurrentChatPanelVisible(true);
  setStandaloneChatArchiveOverlayOpen(false);
});

afterAll(() => {
  useNavigationStore.setState(originalNavigationState);
  useChatStore.setState({ selectedWorktree: originalChatSelection });
  useStandaloneChatStore.setState(originalStandaloneState);
  usePanelLayoutStore.setState({ layouts: {} });
});

// ---------------------------------------------------------------------------
// Page mapping
// ---------------------------------------------------------------------------

describe('page mapping', () => {
  // Driven off the catalog record itself: a new `NavigationPage` union member
  // fails this test (the record is `satisfies Record<NavigationPage, …>`, so it
  // must gain an entry, and that entry must then project correctly) rather
  // than silently passing.
  const pages = Object.keys(NAVIGATION_PAGE_ROUTES) as NavigationPage[];

  it.each(pages)('maps the %s page to its catalog route', (page) => {
    useNavigationStore.setState({ activePage: page });
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      NAVIGATION_PAGE_ROUTES[page],
    );
  });

  it('covers every NavigationPage in the catalog record', () => {
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      expect(isPostHogRoute(NAVIGATION_PAGE_ROUTES[page])).toBe(true);
    }
  });

  it('resolves main with a visible worktree chat to the worktree-chat route', () => {
    selectWorktree();
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main/worktree-chat',
    );
  });

  it('resolves main with no worktree selected to the bare main route', () => {
    useNavigationStore.setState({ activePage: 'main' });
    useChatStore.setState({ selectedWorktree: null });
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main',
    );
  });

  it('keeps the worktree route when the Code chat panel is hidden', () => {
    selectWorktree();
    setCurrentChatPanelVisible(false);
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main/worktree-chat',
    );
  });

  it('maps the Co-Work chat page to app://main/chat', () => {
    selectCowork();
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main/chat',
    );
  });

  it('keeps kanban on its own route despite sharing MainPage with main', () => {
    useNavigationStore.setState({ activePage: 'kanban' });
    useChatStore.setState({ selectedWorktree: SECRET_SELECTION });
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main/kanban',
    );
    expect(NAVIGATION_PAGE_ROUTES.kanban).not.toBe(NAVIGATION_PAGE_ROUTES.main);
  });

  it('keeps an App Advisor conversation hosted in the main window on a main-window route', () => {
    useNavigationStore.setState({ activePage: 'chat' });
    useStandaloneChatStore.setState({
      activeChatProjectId: APP_ADVISOR_PROJECT_ID,
      activeWorkEntryId: 'advisor-entry',
    });
    useChatStore.setState({
      selectedWorktree: {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'advisor-entry',
      },
    });
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main/chat',
    );
  });

  it('never reports app://app-advisor from the main window on the Code page', () => {
    useNavigationStore.setState({ activePage: 'main' });
    useChatStore.setState({
      selectedWorktree: {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'advisor-entry',
      },
    });
    // `isCoworkChatTarget` also matches App Advisor, so this is not a worktree
    // chat — but it is still a main-window route.
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main',
    );
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('settings', () => {
  const REPRESENTATIVE_SECTIONS: SettingsSection[] = [
    'display',
    'mcp',
    'app-advisor',
    'experiments',
    'legal',
  ];

  it.each(REPRESENTATIVE_SECTIONS)(
    'reports app://settings/%s for a displayed section',
    (section) => {
      useNavigationStore.setState({ activePage: 'overview' });
      openSettingsWithSection(section);
      expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
        SETTINGS_SECTION_ROUTES[section],
      );
    },
  );

  it('overrides the underlying page while Settings is open', async () => {
    selectWorktree();
    const source = createMainWindowPostHogRouteSource();
    const { routes, unsubscribe } = subscribeCollecting(source);
    expect(source.getSnapshot()).toBe('app://main/worktree-chat');

    openSettingsWithSection('display');
    await settle();
    expect(routes).toEqual(['app://settings/display']);
    expect(source.getSnapshot()).toBe('app://settings/display');
    unsubscribe();
  });

  // Every redirect the overlay applies lands on `canopy`; the projection must
  // report the DISPLAYED outcome, not the requested section.
  it.each<[string, SettingsSection]>([
    ['dictation on a platform without voice dictation', 'canopy'],
    ['ollama on an unsupported platform', 'canopy'],
    ['claude when claudeSettingsAvailable is false', 'canopy'],
    ['an absent requested section', 'canopy'],
  ])('reports the displayed section for %s', (_case, displayed) => {
    useNavigationStore.setState({
      activePage: 'overview',
      // The REQUESTED deep link is deliberately different from the displayed
      // section; the projection must ignore it entirely.
      settingsInitialSection: 'dictation',
    });
    openSettingsWithSection(displayed);
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://settings/canopy',
    );
  });

  it('holds the previous route while Settings is open but has not reported a section', async () => {
    selectWorktree();
    const source = createMainWindowPostHogRouteSource();
    const { routes, unsubscribe } = subscribeCollecting(source);
    expect(source.getSnapshot()).toBe('app://main/worktree-chat');

    useNavigationStore.setState({
      settingsOpen: true,
      settingsActiveSection: null,
    });
    await settle();
    expect(routes).toEqual([]);
    expect(source.getSnapshot()).toBe('app://main/worktree-chat');

    useNavigationStore.setState({ settingsActiveSection: 'display' });
    await settle();
    // Exactly one transition for one navigation: no `app://settings` in between.
    expect(routes).toEqual(['app://settings/display']);
    expect(routes).not.toContain('app://settings');
    unsubscribe();
  });

  it('falls back to app://settings only when Settings is already open at first read', () => {
    useNavigationStore.setState({
      activePage: 'main',
      settingsOpen: true,
      settingsActiveSection: null,
    });
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://settings',
    );
  });

  it('follows a post-mount availability change with no user action', async () => {
    useNavigationStore.setState({ activePage: 'overview' });
    openSettingsWithSection('claude');
    const source = createMainWindowPostHogRouteSource();
    const { routes, unsubscribe } = subscribeCollecting(source);
    expect(source.getSnapshot()).toBe('app://settings/claude');

    // `claudeSettingsAvailable` resolves false after mount; the overlay
    // republishes the redirected section.
    useNavigationStore.setState({ settingsActiveSection: 'canopy' });
    await settle();
    expect(routes).toEqual(['app://settings/canopy']);
    unsubscribe();
  });

  it('returns to the underlying page when Settings closes', async () => {
    selectWorktree();
    openSettingsWithSection('display');
    const source = createMainWindowPostHogRouteSource();
    const { routes, unsubscribe } = subscribeCollecting(source);
    expect(source.getSnapshot()).toBe('app://settings/display');

    useNavigationStore.getState().closeSettings();
    await settle();
    expect(routes).toEqual(['app://main/worktree-chat']);
    unsubscribe();
  });

  it('reports feedback as its own route rather than canopy', () => {
    openSettingsWithSection('feedback');
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://settings/feedback',
    );
  });

  it('never reports the environments page alias as a main route', async () => {
    useNavigationStore.setState({ activePage: 'main' });
    const source = createMainWindowPostHogRouteSource();
    const { routes, unsubscribe } = subscribeCollecting(source);

    useNavigationStore.getState().navigate('environments');
    await settle();

    expect(useNavigationStore.getState().activePage).toBe('main');
    expect(useNavigationStore.getState().settingsOpen).toBe(true);
    expect(routes).not.toContain('app://main/environments');
    unsubscribe();
  });

  it('reports app://settings/environment for the Settings → Environments section', () => {
    useNavigationStore.setState({ activePage: 'overview' });
    openSettingsWithSection('environment');
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://settings/environment',
    );
  });

  it('reports a hosted settings page by scope and page only (CAN-4386)', async () => {
    const source = createMainWindowPostHogRouteSource();
    const { routes, unsubscribe } = subscribeCollecting(source);
    useNavigationStore.getState().openAccountOrganizationSettings(
      {
        scope: 'organization',
        organizationId: SECRET_PROJECT_ID,
        page: 'members',
        userId: SECRET_WORKTREE_ID,
      },
      { search: `filter=${SECRET_CHAT_TITLE}`, hash: 'secret-anchor' },
    );
    await settle();
    expect(source.getSnapshot()).toBe('app://settings/organization/members');
    for (const route of routes) {
      for (const secret of SECRET_VALUES) expect(route).not.toContain(secret);
      expect(isPostHogRoute(route)).toBe(true);
    }

    // Leaving for a local section reports that section again.
    useNavigationStore.getState().showLocalSettingsSection();
    useNavigationStore.setState({ settingsActiveSection: 'git' });
    await settle();
    expect(source.getSnapshot()).toBe('app://settings/git');
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

describe('panels', () => {
  const NON_CHAT_KINDS = PANEL_KINDS.filter(
    (kind): kind is PanelKind => PANEL_KIND_ROUTES[kind] !== null,
  );

  it('covers every non-chat panel kind', () => {
    // Nine today; a new `PanelKind` with a route must be added to the catalog
    // and is picked up here automatically.
    expect(NON_CHAT_KINDS).toHaveLength(PANEL_KINDS.length - 1);
  });

  it.each(NON_CHAT_KINDS)(
    'maps a focused %s panel to its catalog route',
    (kind) => {
      selectWorktree();
      setLayout(WORKTREE_LAYOUT_KEY, singlePanelViewModel(kind));
      expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
        PANEL_KIND_ROUTES[kind],
      );
    },
  );

  it('maps a focused terminal panel to app://panel/terminal', () => {
    selectWorktree();
    setLayout(WORKTREE_LAYOUT_KEY, singlePanelViewModel('terminal'));
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://panel/terminal',
    );
  });

  it('maps a focused browser panel to app://panel/browser', () => {
    selectWorktree();
    setLayout(WORKTREE_LAYOUT_KEY, singlePanelViewModel('browser'));
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://panel/browser',
    );
  });

  it('keeps the containing worktree route for a focused chat panel', () => {
    selectWorktree();
    setLayout(WORKTREE_LAYOUT_KEY, singlePanelViewModel('chat'));
    expect(PANEL_KIND_ROUTES.chat).toBeNull();
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main/worktree-chat',
    );
  });

  it('keeps the containing Co-Work route for a focused chat panel', () => {
    selectCowork();
    setLayout(COWORK_LAYOUT_KEY, singlePanelViewModel('chat'));
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main/chat',
    );
  });

  it('resolves a Co-Work panel through the active work entry layout', () => {
    selectCowork();
    setLayout(COWORK_LAYOUT_KEY, singlePanelViewModel('terminal'));
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://panel/terminal',
    );
  });

  it('reports the Co-Work route while the archive overlay covers a focused panel', async () => {
    selectCowork();
    setLayout(COWORK_LAYOUT_KEY, singlePanelViewModel('terminal'));
    const source = createMainWindowPostHogRouteSource();
    const { routes, unsubscribe } = subscribeCollecting(source);
    expect(source.getSnapshot()).toBe('app://panel/terminal');

    useStandaloneChatStore.setState({ archiveOverlayChatId: 'archived-chat' });
    await settle();
    expect(routes).toEqual(['app://main/chat']);

    useStandaloneChatStore.setState({ archiveOverlayChatId: null });
    await settle();
    expect(routes).toEqual(['app://main/chat', 'app://panel/terminal']);
    unsubscribe();
  });

  it('falls back to the containing page for a collapsed group', () => {
    selectWorktree();
    // A collapsed group reports `activePanelId: null` in the view model.
    setLayout(WORKTREE_LAYOUT_KEY, {
      groups: [
        {
          groupId: 'group-a',
          activePanelId: null,
          tabs: [{ panelId: 'panel-1', kind: 'terminal' }],
        },
      ],
      activeGroupId: 'group-a',
      maximizedGroupId: null,
    });
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main/worktree-chat',
    );
  });

  it('treats an active panel outside the maximized group as hidden', () => {
    selectWorktree();
    // The one visibility case the shared `getActivePanel` helper does not
    // cover: while `group-b` is maximized only it is on screen, so the active
    // group's terminal is not visible.
    setLayout(WORKTREE_LAYOUT_KEY, {
      groups: [
        {
          groupId: 'group-a',
          activePanelId: 'panel-1',
          tabs: [{ panelId: 'panel-1', kind: 'terminal' }],
        },
        {
          groupId: 'group-b',
          activePanelId: 'panel-2',
          tabs: [{ panelId: 'panel-2', kind: 'browser' }],
        },
      ],
      activeGroupId: 'group-a',
      maximizedGroupId: 'group-b',
    });
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main/worktree-chat',
    );
  });

  it('reports the panel when the active group is itself maximized', () => {
    selectWorktree();
    setLayout(WORKTREE_LAYOUT_KEY, {
      groups: [
        {
          groupId: 'group-a',
          activePanelId: 'panel-1',
          tabs: [{ panelId: 'panel-1', kind: 'terminal' }],
        },
      ],
      activeGroupId: 'group-a',
      maximizedGroupId: 'group-a',
    });
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://panel/terminal',
    );
  });

  it('falls back to the containing page for a deleted active panel', () => {
    selectWorktree();
    setLayout(WORKTREE_LAYOUT_KEY, {
      groups: [
        {
          groupId: 'group-a',
          // Points at a tab that no longer exists.
          activePanelId: 'panel-gone',
          tabs: [{ panelId: 'panel-1', kind: 'terminal' }],
        },
      ],
      activeGroupId: 'group-a',
      maximizedGroupId: null,
    });
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main/worktree-chat',
    );
  });

  it('falls back to the containing page when no layout exists', () => {
    selectWorktree();
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main/worktree-chat',
    );
  });

  it('falls back to the containing page when no group is focused', () => {
    selectWorktree();
    setLayout(WORKTREE_LAYOUT_KEY, {
      groups: [
        {
          groupId: 'group-a',
          activePanelId: 'panel-1',
          tabs: [{ panelId: 'panel-1', kind: 'terminal' }],
        },
      ],
      activeGroupId: null,
      maximizedGroupId: null,
    });
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main/worktree-chat',
    );
  });

  it('falls back to the containing page for an unknown panel kind', () => {
    selectWorktree();
    setLayout(
      WORKTREE_LAYOUT_KEY,
      // A layout restored from a newer build, or a prototype-chain key.
      singlePanelViewModel('a-kind-from-the-future'),
    );
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main/worktree-chat',
    );

    setLayout(WORKTREE_LAYOUT_KEY, singlePanelViewModel('constructor'));
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main/worktree-chat',
    );
  });

  it('renders no panel grid for a Co-Work layout with no active work entry', () => {
    selectCowork(null);
    // A layout keyed by some other entry must not be reachable.
    setLayout(COWORK_LAYOUT_KEY, singlePanelViewModel('terminal'));
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main/chat',
    );
  });

  it('does not resolve Code-page panels for a Co-Work selection', () => {
    useNavigationStore.setState({ activePage: 'main' });
    useChatStore.setState({
      selectedWorktree: {
        projectId: COWORK_PROJECT_ID,
        worktreeId: COWORK_ENTRY_ID,
      },
    });
    setLayout(COWORK_LAYOUT_KEY, singlePanelViewModel('terminal'));
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main',
    );
  });

  it('lets Settings override a focused panel', () => {
    selectWorktree();
    setLayout(WORKTREE_LAYOUT_KEY, singlePanelViewModel('terminal'));
    openSettingsWithSection('display');
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://settings/display',
    );
  });

  it('ignores panels on pages other than main and chat', () => {
    useNavigationStore.setState({ activePage: 'pipelines' });
    useChatStore.setState({ selectedWorktree: SECRET_SELECTION });
    setLayout(WORKTREE_LAYOUT_KEY, singlePanelViewModel('terminal'));
    expect(createMainWindowPostHogRouteSource().getSnapshot()).toBe(
      'app://main/pipelines',
    );
  });
});

// ---------------------------------------------------------------------------
// Notification semantics
// ---------------------------------------------------------------------------

describe('notification semantics', () => {
  it('emits nothing for an A→A update', async () => {
    selectWorktree();
    const source = createMainWindowPostHogRouteSource();
    const { routes, unsubscribe } = subscribeCollecting(source);

    useNavigationStore.setState({ activePage: 'main' });
    await settle();
    expect(routes).toEqual([]);
    unsubscribe();
  });

  it('emits nothing when switching worktrees within the same category', async () => {
    selectWorktree();
    const source = createMainWindowPostHogRouteSource();
    const { routes, unsubscribe } = subscribeCollecting(source);
    expect(source.getSnapshot()).toBe('app://main/worktree-chat');

    for (const worktreeId of ['branch-one', 'branch-two', 'branch-three']) {
      useChatStore.setState({
        selectedWorktree: { projectId: SECRET_PROJECT_ID, worktreeId },
      });
      await settle();
    }
    useChatStore.setState({
      selectedWorktree: {
        projectId: 'another-private-workspace',
        worktreeId: 'another-private-branch',
      },
    });
    await settle();

    expect(routes).toEqual([]);
    expect(source.getSnapshot()).toBe('app://main/worktree-chat');
    unsubscribe();
  });

  it('emits nothing when switching chat tabs within a Co-Work entry', async () => {
    selectCowork();
    const source = createMainWindowPostHogRouteSource();
    const { routes, unsubscribe } = subscribeCollecting(source);

    for (const entryId of ['entry-a', 'entry-b', 'entry-c']) {
      useStandaloneChatStore.setState({ activeWorkEntryId: entryId });
      await settle();
    }
    expect(routes).toEqual([]);
    unsubscribe();
  });

  it('emits exactly once for an A→B transition', async () => {
    selectWorktree();
    const source = createMainWindowPostHogRouteSource();
    const { routes, unsubscribe } = subscribeCollecting(source);

    useNavigationStore.setState({ activePage: 'usage' });
    await settle();
    expect(routes).toEqual(['app://main/usage']);
    expect(source.getSnapshot()).toBe('app://main/usage');
    unsubscribe();
  });

  it('coalesces several synchronous updates that settle on one route', async () => {
    useNavigationStore.setState({ activePage: 'overview' });
    const source = createMainWindowPostHogRouteSource();
    const { routes, unsubscribe } = subscribeCollecting(source);

    // One user navigation performs several store writes in a single tick.
    useNavigationStore.setState({ activePage: 'usage' });
    useNavigationStore.setState({ activePage: 'pipelines' });
    useChatStore.setState({ selectedWorktree: SECRET_SELECTION });
    useNavigationStore.setState({ activePage: 'main' });
    setLayout(WORKTREE_LAYOUT_KEY, singlePanelViewModel('terminal'));
    await settle();

    expect(routes).toEqual(['app://panel/terminal']);
    unsubscribe();
  });

  it('emits nothing when synchronous updates settle back on the same route', async () => {
    selectWorktree();
    const source = createMainWindowPostHogRouteSource();
    const { routes, unsubscribe } = subscribeCollecting(source);

    useNavigationStore.setState({ activePage: 'usage' });
    useNavigationStore.setState({ activePage: 'main' });
    await settle();

    expect(routes).toEqual([]);
    unsubscribe();
  });

  it('keeps getSnapshot equal to the last notified value', async () => {
    useNavigationStore.setState({ activePage: 'overview' });
    const source = createMainWindowPostHogRouteSource();
    const seen: PostHogRoute[] = [];
    const unsubscribe = source.subscribe((route) => {
      // Read back from inside the notification too: the snapshot must already
      // be the notified value, not the previous one.
      seen.push(route);
      expect(source.getSnapshot()).toBe(route);
    });

    for (const page of ['usage', 'plugins', 'audit'] as NavigationPage[]) {
      useNavigationStore.setState({ activePage: page });
      await settle();
      expect(source.getSnapshot()).toBe(seen[seen.length - 1]);
    }
    expect(seen).toEqual([
      'app://main/usage',
      'app://main/plugins',
      'app://main/audit',
    ]);
    unsubscribe();
  });

  it('emits one worktree route when Kanban-to-Code visibility lags navigation', async () => {
    // Kanban with its chat panel hidden publishes visibility = false.
    useNavigationStore.setState({ activePage: 'kanban' });
    useChatStore.setState({ selectedWorktree: SECRET_SELECTION });
    setCurrentChatPanelVisible(false);
    const source = createMainWindowPostHogRouteSource();
    const { routes, unsubscribe } = subscribeCollecting(source);
    expect(source.getSnapshot()).toBe('app://main/kanban');

    // Navigating to the Code page: the store changes first...
    useNavigationStore.setState({ activePage: 'main' });
    await settle();
    // ...and `WorktreeManager` flips visibility one commit later. This must
    // not create a second screen transition.
    setCurrentChatPanelVisible(true);
    await settle();

    expect(routes).toEqual(['app://main/worktree-chat']);
    expect(source.getSnapshot()).toBe('app://main/worktree-chat');
    unsubscribe();
  });

  it('detaches from all four stores on unsubscribe and is idempotent', async () => {
    useNavigationStore.setState({ activePage: 'overview' });
    const source = createMainWindowPostHogRouteSource();
    const { routes, unsubscribe } = subscribeCollecting(source);

    unsubscribe();
    unsubscribe();
    unsubscribe();

    // One update per subscribed store; none may
    // reach the listener.
    useNavigationStore.setState({ activePage: 'main' });
    useChatStore.setState({ selectedWorktree: SECRET_SELECTION });
    useStandaloneChatStore.setState({ activeWorkEntryId: COWORK_ENTRY_ID });
    setLayout(WORKTREE_LAYOUT_KEY, singlePanelViewModel('terminal'));
    setCurrentChatPanelVisible(false);
    setCurrentChatPanelVisible(true);
    await settle();

    expect(routes).toEqual([]);
    // The source stays usable after detaching: an unsubscribed snapshot is
    // derived on demand rather than served stale.
    expect(source.getSnapshot()).toBe('app://panel/terminal');
  });

  it('attaches exactly one listener per store and removes each on unsubscribe', () => {
    const stores = [
      useNavigationStore,
      useChatStore,
      useStandaloneChatStore,
      usePanelLayoutStore,
    ] as const;
    const removals = stores.map(() => jest.fn());
    const spies = stores.map((store, index) =>
      jest
        .spyOn(
          store as { subscribe: (l: () => void) => () => void },
          'subscribe',
        )
        .mockImplementation(() => removals[index]),
    );

    const source = createMainWindowPostHogRouteSource();
    const first = source.subscribe(jest.fn());
    const second = source.subscribe(jest.fn());
    // A second SDK listener shares the one set of store subscriptions.
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }

    first();
    for (const removal of removals) {
      expect(removal).not.toHaveBeenCalled();
    }
    second();
    second();
    first();
    for (const removal of removals) {
      expect(removal).toHaveBeenCalledTimes(1);
    }
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  it('re-attaches after a full unsubscribe', async () => {
    useNavigationStore.setState({ activePage: 'overview' });
    const source = createMainWindowPostHogRouteSource();
    const first = subscribeCollecting(source);
    first.unsubscribe();

    const second = subscribeCollecting(source);
    useNavigationStore.setState({ activePage: 'usage' });
    await settle();
    expect(second.routes).toEqual(['app://main/usage']);
    second.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Surface selection
// ---------------------------------------------------------------------------

describe('surface selection', () => {
  it('returns a fixed app://app-advisor source for the App Advisor renderer', () => {
    const source = createPostHogRouteSource('app-advisor');
    expect(source.getSnapshot()).toBe('app://app-advisor');

    const listener = jest.fn();
    const unsubscribe = source.subscribe(listener);
    // Nothing in the main-window projection may move it.
    useNavigationStore.setState({ activePage: 'main' });
    useChatStore.setState({ selectedWorktree: SECRET_SELECTION });
    expect(source.getSnapshot()).toBe('app://app-advisor');
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    unsubscribe();
    expect(source.getSnapshot()).toBe('app://app-advisor');
  });

  it('registers nothing for the App Advisor surface', () => {
    const before = createAppAdvisorPostHogRouteSource();
    const navigationSubscribe = jest.spyOn(useNavigationStore, 'subscribe');
    const unsubscribe = before.subscribe(jest.fn());
    expect(navigationSubscribe).not.toHaveBeenCalled();
    unsubscribe();
    navigationSubscribe.mockRestore();
  });

  it('installs no tracking until a consumer subscribes', () => {
    // With instrumentation disabled the SDK never subscribes, so constructing
    // and even reading the source must attach nothing to any store.
    const stores = [
      useNavigationStore,
      useChatStore,
      useStandaloneChatStore,
      usePanelLayoutStore,
    ] as const;
    const spies = stores.map((store) =>
      jest.spyOn(
        store as { subscribe: (l: () => void) => () => void },
        'subscribe',
      ),
    );

    const source = createPostHogRouteSource('main');
    source.getSnapshot();
    useNavigationStore.setState({ activePage: 'usage' });
    source.getSnapshot();

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('returns the live projection for the main renderer', async () => {
    useNavigationStore.setState({ activePage: 'overview' });
    const source = createPostHogRouteSource('main');
    const { routes, unsubscribe } = subscribeCollecting(source);
    expect(source.getSnapshot()).toBe('app://main/overview');

    useNavigationStore.setState({ activePage: 'plugins' });
    await settle();
    expect(routes).toEqual(['app://main/plugins']);
    unsubscribe();
  });

  it('gives the two surfaces independent route state', async () => {
    useNavigationStore.setState({ activePage: 'overview' });
    const mainSource = createPostHogRouteSource('main');
    const advisorSource = createPostHogRouteSource('app-advisor');
    const main = subscribeCollecting(mainSource);
    const advisor = subscribeCollecting(advisorSource);

    useNavigationStore.setState({ activePage: 'workers' });
    await settle();

    expect(main.routes).toEqual(['app://main/workers']);
    expect(advisor.routes).toEqual([]);
    expect(advisorSource.getSnapshot()).toBe('app://app-advisor');
    main.unsubscribe();
    advisor.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

describe('privacy', () => {
  it('never leaks fixture values and only emits catalog members', async () => {
    const emitted: PostHogRoute[] = [];
    useNavigationStore.setState({ activePage: 'overview' });
    const source = createMainWindowPostHogRouteSource();
    const unsubscribe = source.subscribe((route) => emitted.push(route));
    emitted.push(source.getSnapshot());

    // Walk a realistic session across every surface that carries private data.
    selectWorktree();
    setLayout(
      WORKTREE_LAYOUT_KEY,
      singlePanelViewModel('browser', {
        groups: [
          {
            groupId: `group-${SECRET_BROWSER_URL}`,
            activePanelId: `panel-${SECRET_CHAT_TITLE}`,
            tabs: [
              { panelId: `panel-${SECRET_CHAT_TITLE}`, kind: 'browser' },
              { panelId: `panel-${SECRET_FILE_PATH}`, kind: 'file-diff' },
            ],
          },
        ],
        activeGroupId: `group-${SECRET_BROWSER_URL}`,
      }),
    );
    await settle();

    setLayout(
      WORKTREE_LAYOUT_KEY,
      singlePanelViewModel('file-diff', {
        groups: [
          {
            groupId: `group-${SECRET_FILE_PATH}`,
            activePanelId: `panel-${SECRET_FILE_PATH}`,
            tabs: [{ panelId: `panel-${SECRET_FILE_PATH}`, kind: 'file-diff' }],
          },
        ],
        activeGroupId: `group-${SECRET_FILE_PATH}`,
      }),
    );
    await settle();

    openSettingsWithSection('account');
    await settle();
    useNavigationStore.getState().closeSettings();
    await settle();

    selectCowork(`entry-${SECRET_CHAT_TITLE}`);
    await settle();

    useNavigationStore.setState({ activePage: 'kanban' });
    await settle();

    expect(emitted.length).toBeGreaterThan(4);
    for (const route of emitted) {
      expect(isPostHogRoute(route)).toBe(true);
      for (const secret of SECRET_VALUES) {
        expect(route).not.toContain(secret);
      }
      // No route may carry a query string, fragment, or encoded payload.
      expect(route).toMatch(/^app:\/\/[a-z-]+(\/[a-z-]+)?$/);
    }
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

describe('cost', () => {
  it('produces no notifications for a high-frequency unchanged-route update loop', async () => {
    selectWorktree();
    const source = createMainWindowPostHogRouteSource();
    const listener = jest.fn();
    const unsubscribe = source.subscribe(listener);
    expect(source.getSnapshot()).toBe('app://main/worktree-chat');

    // Stand in for streaming tokens: the chat store notifies on every one.
    for (let index = 0; index < 500; index += 1) {
      useChatStore.setState({ chatStreamTick: index } as never);
    }
    await settle();

    expect(listener).not.toHaveBeenCalled();
    expect(source.getSnapshot()).toBe('app://main/worktree-chat');
    unsubscribe();
  });

  it('does not even schedule a derivation for streaming-token updates', async () => {
    selectWorktree();
    const source = createMainWindowPostHogRouteSource();
    const unsubscribe = source.subscribe(jest.fn());
    const queueMicrotaskSpy = jest.spyOn(globalThis, 'queueMicrotask');

    // Token updates touch transcript state, never the fields the projection
    // reads, so each costs one reference comparison.
    for (let index = 0; index < 500; index += 1) {
      useChatStore.setState({ chatStreamTick: index } as never);
    }
    // A layout-size-only drag is likewise irrelevant to the route.
    usePanelLayoutStore.setState({ layoutSizeRevisions: { any: 1 } });
    expect(queueMicrotaskSpy).not.toHaveBeenCalled();

    // A relevant change still schedules exactly one coalesced derivation.
    useNavigationStore.setState({ activePage: 'usage' });
    useNavigationStore.setState({ activePage: 'audit' });
    expect(queueMicrotaskSpy).toHaveBeenCalledTimes(1);
    await settle();

    queueMicrotaskSpy.mockRestore();
    unsubscribe();
  });

  it('never calls buildCurrentUiStateSnapshot', async () => {
    selectWorktree();
    const source = createMainWindowPostHogRouteSource();
    const unsubscribe = source.subscribe(jest.fn());

    source.getSnapshot();
    useNavigationStore.setState({ activePage: 'chat' });
    useStandaloneChatStore.setState({ activeWorkEntryId: COWORK_ENTRY_ID });
    setLayout(COWORK_LAYOUT_KEY, singlePanelViewModel('terminal'));
    openSettingsWithSection('display');
    await settle();
    source.getSnapshot();

    expect(mockBuildCurrentUiStateSnapshot).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('adds no persistent timer', async () => {
    const setInterval = jest.spyOn(globalThis, 'setInterval');
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    selectWorktree();
    const source = createMainWindowPostHogRouteSource();
    const unsubscribe = source.subscribe(jest.fn());
    useNavigationStore.setState({ activePage: 'usage' });
    await Promise.resolve();
    await Promise.resolve();

    expect(setInterval).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    unsubscribe();
    setInterval.mockRestore();
    setTimeoutSpy.mockRestore();
  });
});
