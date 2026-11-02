/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import {
  ContextMenuPlacementProvider,
  type ContextMenuPlacement,
} from '@canopy/ui-shared';
import { CanopyClientProvider } from '@canopy/app-state';
import { createFakeClient } from '@canopy/app-state/__tests__/fake-org-projects-client';
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PreferencesData,
  UpdateState,
} from '@canopy/desktop-shared/types';
import type { SessionViewModel } from '@canopy/app-core';
import { DEFAULT_SIDEBAR_NAV_LAYOUT } from '@canopy/desktop-shared/lib/sidebar-nav-layout';
import { isHeaderStatesPageEnabled } from '../header-states-page-flag';
import { isWorktreeStatesPageEnabled } from '../worktree-states-page-flag';
import { isActivityStatesPageEnabled } from '../activity-states-page-flag';
import { isMessageBubbleStatesPageEnabled } from '../message-bubble-states-page-flag';
import {
  CHANGE_REVIEW_PAGE_STORAGE_KEY,
  isChangeReviewPageEnabled,
} from '../change-review-page-flag';
import { makeTestPreferences } from '@/test-utils/preferences';
import { useProjectsStore } from '@/stores/projectsStore';
import { useResourceMonitorStore } from '@/stores/resourceMonitorStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useUpdateState } from '@/hooks/useUpdateState';
import { useNavigationStore } from '@/stores/navigationStore';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';
import {
  applyLabsExperimentsSnapshot,
  resetLabsExperimentsStoreForTest,
} from '@/stores/labsExperimentsStore';
import {
  makeTestLabsSnapshot,
  pageExperimentsOn,
} from '@/test-utils/labsExperiments';
import { useSidebarStore, SIDEBAR_DEFAULT_WIDTH } from '@/stores/sidebarStore';
import {
  AppSidebar,
  resolveStickyWorkspaceRows,
  type AppSidebarProps,
} from '../AppSidebar';
import { SidebarNavRow } from '../SidebarNavRow';
import { getSidebarNavItemDefs } from '../sidebar-nav-items';
import { BANNER_GLYPH_STROKE_WIDTH } from '../BannerGlyphs';
import { DESKTOP_SHARED_SIDEBAR_STORAGE_KEY } from '../desktop-shared-sidebar-flag';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
  var __workspacesSectionRenders: number;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__workspacesSectionRenders = 0;

/** Switches the Labs page experiments on, so their rows render (CAN-3678). */
function publishPageExperimentsOn(): void {
  applyLabsExperimentsSnapshot(
    makeTestLabsSnapshot({ experiments: pageExperimentsOn() }),
  );
}

jest.mock(
  '../SidebarWorkspacesSection',
  (): {
    MoreStickyLead: (props: { lead?: ReactNode }) => JSX.Element | null;
    StickyWorkspaceControls: (props: {
      lead?: ReactNode;
      workspaceHeader?: ReactNode;
      workspaceSlot?: ReactNode;
    }) => JSX.Element;
    SidebarWorkspacesSection: (props: {
      stickyHeaderLead?: ReactNode;
    }) => JSX.Element;
  } => ({
    // The real section renders More as a SIBLING of the band, wrapped so it
    // carries `data-sidebar-more-lead` and its own `sticky top-px`. The rail
    // measures that wrapper to seat the Chats and Projects headers, so the
    // stub has to provide it too.
    MoreStickyLead: ({ lead }: { lead?: ReactNode }): JSX.Element | null =>
      lead === undefined ? null : (
        <div
          className="sticky top-px"
          data-sidebar-more-lead=""
          data-testid="sidebar-more-sticky-lead"
        >
          {lead}
        </div>
      ),
    StickyWorkspaceControls: ({ lead }: { lead?: ReactNode }): JSX.Element => (
      <div data-testid="sidebar-more-sticky-container">
        {lead}
        <div data-testid="sidebar-more-workspaces-gap" />
        <div data-testid="sidebar-sticky-workspace-slot" hidden />
      </div>
    ),
    SidebarWorkspacesSection: ({
      stickyHeaderLead,
    }: {
      stickyHeaderLead?: ReactNode;
    }): JSX.Element => (
      // Render counting: crossing the sticky threshold while the More menu is
      // closed must not re-render the sidebar (wheel scrolling runs on the
      // main thread, so a render would stall the scroll at the crossing).
      <div
        data-testid="sidebar-workspaces-section-stub"
        data-render-count={++globalThis.__workspacesSectionRenders}
      >
        <div data-testid="sidebar-section-code">
          {stickyHeaderLead !== undefined && (
            <div
              className="sticky top-px"
              data-sidebar-more-lead=""
              data-testid="sidebar-more-sticky-lead"
            >
              {stickyHeaderLead}
            </div>
          )}
          <div
            className="sidebar-sticky-workspace-controls sticky top-px"
            data-testid="sidebar-more-sticky-container"
          >
            <div className="h-3" data-testid="sidebar-more-workspaces-gap" />
            <div className="sidebar-sticky-header" />
            <div
              data-sidebar-sticky-workspace-slot=""
              data-testid="sidebar-sticky-workspace-slot"
              hidden
            >
              <div data-sidebar-sticky-slot-workspace-id="alpha" hidden>
                <button type="button">Alpha slot</button>
              </div>
              <div data-sidebar-sticky-slot-workspace-id="beta" hidden>
                <button type="button">Beta slot</button>
              </div>
            </div>
          </div>
          <div
            className="sidebar-workspaces-rows-clip"
            // The shared rail marks its rows container directly, and the
            // legacy rail matches the same element as a direct child of the
            // Code section. Carrying BOTH is what the real DOM looks like to
            // the occlusion selector, and it is the shape that caught the
            // selector-list bug: the occludable-row selector used to resolve
            // as "this container OR a row", so the container itself was
            // treated as the row the occlusion line passed through.
            data-sidebar-section-content=""
            data-sidebar-workspaces-rows=""
          >
            <div data-sidebar-workspace-id="alpha">
              <div
                className="sidebar-workspace-sticky-header"
                data-testid="stub-workspace-header"
              />
              <div
                data-sidebar-section-content=""
                data-testid="stub-workspace-rows"
              >
                <div data-testid="stub-row-alpha" data-worktree-id="alpha-1">
                  <span data-testid="worktree-row-title">Alpha one</span>
                  <span data-testid="worktree-row-subtitle">alpha-branch</span>
                </div>
              </div>
            </div>
            <div data-sidebar-workspace-id="beta">
              <div
                className="sidebar-workspace-sticky-header"
                data-testid="stub-second-workspace-header"
              />
              <div
                data-sidebar-section-content=""
                data-testid="stub-second-workspace-rows"
              >
                <div data-testid="stub-row-beta" data-worktree-id="beta-1">
                  <span data-testid="worktree-row-title">Beta one</span>
                  <span data-testid="worktree-row-subtitle">beta-branch</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    ),
  }),
);
interface SidebarAccountMenuStubProps {
  footerBanner?: ReactNode;
  canopyPortalEnabled: boolean;
  onCanopyPortalClick: () => void;
}
jest.mock(
  '../SidebarAccountMenu',
  (): {
    SidebarAccountMenu: (props: SidebarAccountMenuStubProps) => JSX.Element;
  } => ({
    // Render the footerBanner slot so the DEV banner (passed through it, below
    // the guest credits CTA) stays assertable from this suite, and expose the
    // Remote Control props the sidebar forwards (CAN-3659).
    SidebarAccountMenu: (props: SidebarAccountMenuStubProps): JSX.Element => (
      <div
        data-testid="sidebar-account-menu-stub"
        data-canopy-portal-enabled={String(props.canopyPortalEnabled)}
      >
        <button
          type="button"
          data-testid="sidebar-account-menu-stub-remote-control"
          onClick={props.onCanopyPortalClick}
        />
        {props.footerBanner}
      </div>
    ),
  }),
);
jest.mock('@/hooks/useDesktopWorkspaceContextSwitcher', () => ({
  useDesktopWorkspaceContextAvailability: (): { available: boolean } => ({
    available: false,
  }),
}));
// The switcher's own availability and menu are covered by
// DesktopSidebarContextSwitcher.test.tsx; here only its mount point matters.
jest.mock(
  '../DesktopSidebarContextSwitcher',
  (): { DesktopSidebarContextSwitcher: () => JSX.Element } => ({
    DesktopSidebarContextSwitcher: (): JSX.Element => (
      <div data-testid="desktop-context-switcher-stub" />
    ),
  }),
);
jest.mock('@/hooks/useUpdateState', () => ({
  useUpdateState: jest.fn(),
}));
jest.mock(
  '../WakeLockIndicator',
  (): { WakeLockIndicator: () => JSX.Element | null } => ({
    WakeLockIndicator: (): JSX.Element | null => null,
  }),
);
jest.mock('../DesktopSidebarActivityToggle', () => ({
  DesktopSidebarActivityToggle: (): JSX.Element => (
    <button data-testid="sidebar-activity-toggle">Activity</button>
  ),
}));
jest.mock(
  '../../resource-diagnostics/ResourceDiagnosticsPill',
  (): {
    ResourceDiagnosticsPill: (props: {
      compactLabel?: boolean;
      statusBar?: boolean;
    }) => JSX.Element;
  } => ({
    ResourceDiagnosticsPill: ({
      compactLabel,
      statusBar,
    }: {
      compactLabel?: boolean;
      statusBar?: boolean;
    }): JSX.Element => (
      <div
        data-testid="sidebar-resource-diagnostics-pill-stub"
        data-compact-label={compactLabel}
        data-status-bar={statusBar}
      />
    ),
  }),
);

function makePreferences(
  overrides: Partial<PreferencesData> = {},
): PreferencesData {
  return makeTestPreferences({
    showDiagnosticsPill: false,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    ...overrides,
  });
}

function installWindowApi(
  preferences: PreferencesData = makePreferences(),
  snapshot?: SessionViewModel,
): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: jest.fn().mockResolvedValue(preferences),
      getDesktopSessionSnapshot: jest.fn().mockResolvedValue(
        snapshot ?? {
          workspaces: [],
          worktrees: [],
          chatProjects: [],
          standaloneChats: [],
          scriptDescriptors: [],
          scriptRuns: [],
          hookDescriptors: [],
          hookRuns: [],
          plans: [],
          pipelines: [],
          pipelineRuns: [],
          chatMessages: [],
          chatSummaries: [],
          terminalSessions: [],
          terminalBuffers: {},
          changedFiles: {},
          diffSnapshots: {},
          prStatuses: {},
          fileRoots: [],
          fileTree: {},
          filePreviews: {},
          refreshing: false,
          connectionStatus: 'active',
        },
      ),
      onDesktopSessionSnapshotStale: jest.fn().mockReturnValue(() => undefined),
      observability: {
        loadSnapshot: jest.fn().mockResolvedValue({
          recentEntries: [],
          usage: { updatedAt: new Date(0).toISOString(), providers: [] },
          retentionDays: 7,
        }),
        onUpdate: jest.fn().mockReturnValue(() => undefined),
      },
      getWakeLockState: jest
        .fn()
        .mockResolvedValue({ active: false, enabled: false, holderCount: 0 }),
      onWakeLockStateChanged: jest.fn().mockReturnValue(() => undefined),
      getResourceMonitorSnapshot: jest
        .fn()
        .mockRejectedValue(new Error('Resource monitor unavailable in test')),
      onResourceMonitorSnapshot: jest.fn().mockReturnValue(() => undefined),
    },
  });
  Object.defineProperty(window, 'platform', {
    configurable: true,
    value: 'darwin',
  });
  Object.defineProperty(window, 'devInfo', {
    configurable: true,
    value: { isDev: false, branch: null },
  });
}

function mockSidebarUpdateState(state: UpdateState): void {
  jest.mocked(useUpdateState).mockReturnValue({
    appVersion: '0.26.8',
    dependencyVersions: null,
    state,
    refresh: (): Promise<void> => Promise.resolve(),
  });
}

const BASE_PROPS: AppSidebarProps = {
  activePage: 'main',
  onNavigate: jest.fn(),
  onReturnToSectionRoot: jest.fn(),
  onSettingsClick: jest.fn(),
  settingsOpen: false,
  onCanopyPortalClick: jest.fn(),
  canopyPortalEnabled: false,
  claudeTuiWorkersEnabled: true,
  onAppAdvisorClick: jest.fn(),
  appAdvisorOpen: false,
  appAdvisorThinking: false,
  appAdvisorUnread: false,
  workersActive: false,
};

/** jsdom geometry in the viewport's CSS coordinate system. */
function mockNavigationGeometry(
  viewport: HTMLElement,
  boundary: () => number,
): void {
  const sentinel = viewport.querySelector<HTMLElement>(
    '[data-testid="sidebar-sticky-workspace-sentinel"]',
  );
  if (!sentinel) throw new Error('Expected navigation sentinel');
  jest.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => ({
    top: 0,
    bottom: 560,
    left: 0,
    right: 280,
    width: 280,
    height: 560,
    x: 0,
    y: 0,
    toJSON: (): Record<string, never> => ({}),
  }));
  jest.spyOn(sentinel, 'getBoundingClientRect').mockImplementation(() => ({
    top: boundary() - viewport.scrollTop,
    bottom: boundary() + 1 - viewport.scrollTop,
    left: 0,
    right: 280,
    width: 280,
    height: 1,
    x: 0,
    y: boundary() - viewport.scrollTop,
    toJSON: (): Record<string, never> => ({}),
  }));
}

/** Put an ungated item in More for tests of menu interactions. */
function seedMoreMenu(): void {
  useSidebarStore.getState().hydrateFromPreferences(
    makePreferences({
      sidebarNavLayout: {
        order: [
          ...DEFAULT_SIDEBAR_NAV_LAYOUT.order.filter(
            (key) => key !== 'plugins',
          ),
          'plugins',
        ],
        moreStartIndex: DEFAULT_SIDEBAR_NAV_LAYOUT.order.length - 1,
      },
    }),
  );
}

async function renderSidebar(
  props: Partial<AppSidebarProps> = {},
  preferences: PreferencesData = makePreferences(),
  devInfo: Window['devInfo'] = { isDev: false, branch: null },
  snapshot?: SessionViewModel,
  menuPlacement: ContextMenuPlacement = 'anchored',
): Promise<{ container: HTMLElement; root: Root; unmount: () => void }> {
  installWindowApi(preferences, snapshot);
  Object.defineProperty(window, 'devInfo', {
    configurable: true,
    value: devInfo,
  });
  const container = document.createElement('div');
  const statusHost = document.createElement('div');
  statusHost.id = 'app-bottom-status-host';
  statusHost.dataset.testid = 'app-bottom-status';
  const mount = document.createElement('div');
  container.append(statusHost, mount);
  document.body.appendChild(container);
  const root = createRoot(mount);
  await act(async () => {
    root.render(
      <CanopyClientProvider client={createFakeClient().client}>
        <ContextMenuPlacementProvider value={menuPlacement}>
          <AppSidebar {...BASE_PROPS} {...props} />
        </ContextMenuPlacementProvider>
      </CanopyClientProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    container,
    root,
    unmount: (): void => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function waitForSidebarLayout(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

const MAX_MANUAL_ANIMATION_FRAMES = 10;

/**
 * Queues animation frames until the test flushes them. The sidebar's mount
 * effect schedules its first layout pass and defers the host's sticky layout
 * by one more frame; with real jsdom frames, a slow commit lets both run
 * before the test stubs its geometry, so the host measures zero layout and
 * nothing re-runs it. Install this before rendering so every pass waits for
 * the stubs.
 */
function installManualAnimationFrames(): {
  flushFrames: () => Promise<void>;
  restore: () => void;
} {
  let nextId = 1;
  let queue: Array<{ id: number; callback: FrameRequestCallback }> = [];
  const rafSpy = jest
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback: FrameRequestCallback): number => {
      const id = nextId;
      nextId += 1;
      queue.push({ id, callback });
      return id;
    });
  const cafSpy = jest
    .spyOn(window, 'cancelAnimationFrame')
    .mockImplementation((id: number): void => {
      queue = queue.filter((entry) => entry.id !== id);
    });
  return {
    // Runs frames until none are queued. Each frame only runs the callbacks
    // queued before it, so a callback that schedules another frame (the
    // host layout deferral) lands in the next one.
    flushFrames: async (): Promise<void> => {
      for (
        let frame = 0;
        frame < MAX_MANUAL_ANIMATION_FRAMES && queue.length > 0;
        frame += 1
      ) {
        const pending = queue;
        queue = [];
        await act(async () => {
          for (const { callback } of pending) callback(performance.now());
          await Promise.resolve();
        });
      }
      if (queue.length > 0) {
        throw new Error(
          `Animation frames still queued after ${MAX_MANUAL_ANIMATION_FRAMES} frames`,
        );
      }
    },
    restore: (): void => {
      rafSpy.mockRestore();
      cafSpy.mockRestore();
    },
  };
}

describe('AppSidebar', () => {
  it('hands the Remote Control flag and opener to the account menu (CAN-3659)', async () => {
    const onCanopyPortalClick = jest.fn();
    const { container, unmount } = await renderSidebar({
      canopyPortalEnabled: true,
      onCanopyPortalClick,
    });
    try {
      expect(
        container
          .querySelector('[data-testid="sidebar-account-menu-stub"]')
          ?.getAttribute('data-canopy-portal-enabled'),
      ).toBe('true');
      act(() => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-account-menu-stub-remote-control"]',
          )
          ?.click();
      });
      expect(onCanopyPortalClick).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
    }
  });

  // Cold CI transforms of the shared host can exceed a test's five-second
  // budget. Load modules before mounting so a timeout cannot strand a root
  // that reads restored window globals in the following tests.
  beforeAll(async () => {
    await import('../DesktopSharedSidebarHost');
    await import('../DesktopSidebarShadowPanel');
  }, 30_000);

  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    window,
    'platform',
  );
  const originalDevInfoDescriptor = Object.getOwnPropertyDescriptor(
    window,
    'devInfo',
  );

  beforeEach(() => {
    mockSidebarUpdateState({ phase: 'idle' });
    window.localStorage.clear();
    // The shared surface is the default rail (CAN-3053 flag flip); this suite
    // pins the legacy section through the '0' escape hatch and opts back in
    // per test where it exercises the shared host.
    window.localStorage.setItem(DESKTOP_SHARED_SIDEBAR_STORAGE_KEY, '0');
    useProjectsStore.setState({
      projects: [],
      isLoading: false,
      hasHydratedProjects: true,
    });
    useResourceMonitorStore.setState({ initialized: false, loading: true });
    useNavigationStore.setState({
      commandPaletteOpen: false,
      commandPaletteInitialQuery: '',
    });
    useObservabilityStore.setState({
      initialized: false,
      usage: { updatedAt: new Date(0).toISOString(), providers: [] },
    });
    // Reset the sidebar nav layout to its default arrangement so each test
    // starts from the pre-customization order (the store is a module
    // singleton shared across tests).
    useSidebarStore.getState().hydrateFromPreferences(makePreferences());
  });

  // The shared tooltip opens only for keyboard-driven focus; bare `.focus()`
  // is programmatic, so a keydown precedes it. Shift marks keyboard modality
  // without Tab's side effect of closing an open floating menu. Main nav rows,
  // New task, Search, and More entries name themselves, so none of them opens
  // a tooltip (CAN-2673 descriptions removed per design review).
  function focusViaKeyboard(element: HTMLElement): void {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }),
    );
    element.focus();
  }

  function expectNoTooltip(element: HTMLElement): void {
    expect(element.getAttribute('aria-describedby')).toBeNull();
    expect(element.hasAttribute('title')).toBe(false);
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  }

  it('renders a nav row as a bare full-width button that keeps its ref', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const ref: { current: HTMLButtonElement | null } = { current: null };
    act(() =>
      root.render(
        <SidebarNavRow ref={ref} icon={null}>
          Section
        </SidebarNavRow>,
      ),
    );
    const row = ref.current;
    try {
      if (!row) throw new Error('Row missing');
      expect(row.tagName).toBe('BUTTON');
      expect(row.parentElement).toBe(container);
      expect(row.className).toContain('w-full');
      act(() => focusViaKeyboard(row));
      expectNoTooltip(row);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('keeps More items focusable with arrow navigation and no tooltips', async () => {
    seedMoreMenu();
    const { container, unmount } = await renderSidebar();
    try {
      const more = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-more"]',
      );
      if (!more) throw new Error('More button missing');
      act(() => focusViaKeyboard(more));
      expectNoTooltip(more);
      act(() => more.click());
      const menu = document.body.querySelector<HTMLElement>(
        '[data-testid="sidebar-more-menu"]',
      );
      if (!menu) throw new Error('More menu missing');
      const items =
        menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
      expect(items.length).toBeGreaterThan(1);
      act(() => focusViaKeyboard(items[0]));
      expectNoTooltip(items[0]);
      act(() => {
        items[0].dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
      });
      expect(document.activeElement).toBe(items[1]);
      expectNoTooltip(items[1]);
      act(() => {
        items[1].dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      expect(
        document.body.querySelector('[data-testid="sidebar-more-menu"]'),
      ).toBeNull();
      expect(document.activeElement).toBe(more);
    } finally {
      unmount();
    }
  });

  it.each([
    'sidebar-create-task',
    'sidebar-search',
    'sidebar-nav-app-advisor',
    'sidebar-nav-plugins',
  ])('leaves %s without a tooltip once focused', async (testId) => {
    const { container, unmount } = await renderSidebar();
    try {
      const row = container.querySelector<HTMLButtonElement>(
        `[data-testid="${testId}"]`,
      );
      if (!row) throw new Error(`${testId} missing`);
      act(() => focusViaKeyboard(row));
      expectNoTooltip(row);
    } finally {
      unmount();
    }
  });

  it('does not mount the shared sidebar shadow when its dev flag is off', async () => {
    const { container, unmount } = await renderSidebar({}, makePreferences(), {
      isDev: true,
      branch: 'test',
    });
    try {
      expect(
        container.querySelector('[data-testid="desktop-sidebar-shadow-panel"]'),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  it('pins native rendering while the shared sidebar switch is off', async () => {
    const { container, unmount } = await renderSidebar();
    try {
      expect(
        container.querySelector(
          '[data-testid="sidebar-workspaces-section-stub"]',
        ),
      ).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it('lazy mounts the shared sidebar and its mapped fixture ids when enabled', async () => {
    window.localStorage.setItem(DESKTOP_SHARED_SIDEBAR_STORAGE_KEY, '1');
    const snapshot = {
      workspaces: [
        {
          localId: 'fixture-workspace',
          name: 'Fixture',
          type: 'single-repo',
          collapsed: false,
        },
      ],
      worktrees: [
        {
          localId: 'fixture-worktree',
          workspaceLocalId: 'fixture-workspace',
          branch: 'main',
          status: 'active',
        },
      ],
      chatProjects: [],
      standaloneChats: [],
      scriptDescriptors: [],
      scriptRuns: [],
      hookDescriptors: [],
      hookRuns: [],
      plans: [],
      pipelines: [],
      pipelineRuns: [],
      chatMessages: [],
      chatSummaries: [],
      terminalSessions: [],
      terminalBuffers: {},
      changedFiles: {},
      diffSnapshots: {},
      prStatuses: {},
      fileRoots: [],
      fileTree: {},
      filePreviews: {},
      refreshing: false,
      connectionStatus: 'active',
    } as SessionViewModel;
    const { container, unmount } = await renderSidebar(
      {},
      makePreferences(),
      { isDev: false, branch: null },
      snapshot,
    );
    try {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(
        container.querySelector(
          '[data-testid="sidebar-workspaces-section-stub"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="sidebar-section-code"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="worktree-row"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="sidebar-search"]'),
      ).not.toBeNull();
      // The shared surface is NESTED inside this rail, which already owns the
      // command chrome. Under its default `'full'` chrome it would contribute
      // a second New Task button — permanently disabled, since the host
      // supplies no `onCreateTask` — directly above the Projects header. This
      // is the rendered-DOM half of the contract: the host's own test proves
      // it passes `chrome="navigation-only"`, and this proves the button that
      // survives is the rail's, exactly once.
      expect(
        container.querySelectorAll('[data-testid="portal-create-task"]'),
      ).toHaveLength(0);
      expect(
        container.querySelectorAll('[data-testid="portal-more"]'),
      ).toHaveLength(0);
      expect(window.api.onDesktopSessionSnapshotStale).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
    }
  });

  it('smoke-mounts the flagged shared sidebar with a fixture snapshot', async () => {
    window.localStorage.setItem('canopy.dev.desktopSidebarShadow', '1');
    const snapshot: SessionViewModel = {
      workspaces: [
        {
          localId: 'workspace-fixture',
          name: 'Fixture',
          type: 'single-repo',
        },
      ],
      worktrees: [
        {
          localId: 'worktree-fixture',
          workspaceLocalId: 'workspace-fixture',
          branch: 'fixture',
          status: 'active',
        },
      ],
      chatProjects: [],
      standaloneChats: [],
      scriptDescriptors: [],
      scriptRuns: [],
      hookDescriptors: [],
      hookRuns: [],
      plans: [],
      pipelines: [],
      pipelineRuns: [],
      chatMessages: [],
      chatSummaries: [],
      terminalSessions: [],
      terminalBuffers: {},
      changedFiles: {},
      diffSnapshots: {},
      prStatuses: {},
      fileRoots: [],
      fileTree: {},
      filePreviews: {},
      refreshing: false,
      connectionStatus: 'active',
    };
    const { container, unmount } = await renderSidebar(
      {},
      makePreferences(),
      { isDev: true, branch: 'test' },
      snapshot,
    );
    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const panel = container.querySelector<HTMLElement>(
        '[data-testid="desktop-sidebar-shadow-panel"]',
      );
      expect(panel).not.toBeNull();

      act(() => panel?.querySelector<HTMLButtonElement>('button')?.click());

      expect(
        container.querySelector(
          '[data-testid="desktop-sidebar-shadow-parity-readout"]',
        ),
      ).not.toBeNull();
    } finally {
      unmount();
    }
  });

  afterEach(() => {
    resetExperimentalFeaturesStoreForTest();
    resetLabsExperimentsStoreForTest();
    window.localStorage.removeItem('canopy.dev.desktopSidebarShadow');
    window.localStorage.removeItem(DESKTOP_SHARED_SIDEBAR_STORAGE_KEY);
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
    if (originalPlatformDescriptor) {
      Object.defineProperty(window, 'platform', originalPlatformDescriptor);
    } else {
      Reflect.deleteProperty(window, 'platform');
    }
    if (originalDevInfoDescriptor) {
      Object.defineProperty(window, 'devInfo', originalDevInfoDescriptor);
    } else {
      Reflect.deleteProperty(window, 'devInfo');
    }
  });

  it('renders Search directly below New task and opens the command palette', async () => {
    const { container, unmount } = await renderSidebar();
    try {
      const topLevelOrder = [
        ...Array.from(
          container
            .querySelector('[data-testid="sidebar-fixed-navigation"]')
            ?.querySelectorAll('[data-sidebar-nav-row]') ?? [],
        ),
        ...Array.from(
          container
            .querySelector('[data-testid="sidebar-scrolling-navigation"]')
            ?.querySelectorAll(
              '[data-testid^="sidebar-nav-"], [data-testid="sidebar-more"]',
            ) ?? [],
        ),
      ].map((el) => el?.getAttribute('data-testid'));

      expect(topLevelOrder).toEqual([
        'sidebar-create-task',
        'sidebar-search',
        'sidebar-nav-app-advisor',
        'sidebar-nav-workflows',
        'sidebar-nav-plugins',
        'sidebar-more',
      ]);
      const search = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-search"]',
      );
      expect(search?.textContent).toContain('Search');
      expect(search?.getAttribute('aria-label')).toBe('Search');
      expect(search?.getAttribute('type')).toBe('button');
      expect(search?.getAttribute('data-onboarding-anchor')).toBe(
        'sidebar-search',
      );
      expect(
        container.querySelector('[data-onboarding-anchor="sidebar-search"]'),
      ).toBe(search);

      act(() => search?.click());

      expect(useNavigationStore.getState().commandPaletteOpen).toBe(true);
    } finally {
      unmount();
    }
  });

  it('anchors the surfaced DEV branch banner above the account footer', async () => {
    const { container, unmount } = await renderSidebar({}, makePreferences(), {
      isDev: true,
      branch: 'codex/footer-alignment',
    });
    try {
      const item = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-dev-item"]',
      );
      expect(item).not.toBeNull();
      expect(item?.className).toContain('h-7');
      expect(item?.className).toContain('gap-1.5');
      expect(item?.className).toContain('pl-1');
      expect(item?.className).not.toContain('hover:bg-subtle');
      expect(item?.className).toContain('text-xs');
      expect(item?.className).toContain('rounded-row');
      // The warning tint is the engine's subtle fill in both modes, not a
      // hand-mixed wash over the quaternary surface.
      expect(item?.className).toContain('bg-warning-subtle');
      expect(item?.className).not.toContain('bg-quaternary');
      expect(item?.className).not.toContain('bg-tertiary');
      expect(item?.className).not.toContain('background-image');
      expect(item?.className).not.toContain('bg-warning/10');
      // The branch label stays fg-primary on the tint.
      expect(item?.className).toContain('fg-primary');
      expect(item?.className).not.toContain('fg-warning ');
      expect(item?.className).toContain('shadow-md');
      // Spacing is owned by the account menu's banner stack; the slot wrapper
      // itself is bare.
      expect(item?.parentElement?.className).toBe('');
      expect(item?.textContent).toContain('Dev build');
      expect(item?.textContent).toContain('codex/footer-alignment');
      const [iconSlot, branchLabel, badge] = Array.from(item?.children ?? []);
      expect(iconSlot?.className).toContain('ml-0.5');
      expect(iconSlot?.className).toContain('h-5');
      expect(iconSlot?.className).toContain('w-5');
      expect(iconSlot?.className).toContain('shrink-0');
      expect(iconSlot?.className).toContain('fg-warning');
      const devIcon = iconSlot?.querySelector(
        '[data-testid="sidebar-dev-icon"]',
      );
      expect(devIcon).not.toBeNull();
      expect(devIcon?.getAttribute('aria-hidden')).toBe('true');
      // AppIconBase sizing contract (matches the generated app glyphs).
      expect(devIcon?.getAttribute('width')).toBe('16px');
      expect(devIcon?.getAttribute('height')).toBe('16px');
      expect(devIcon?.getAttribute('viewBox')).toBe('0 0 24 24');
      // The tent body of the custom DEV glyph.
      const bodyPath = devIcon?.querySelector('path[d^="M16 3C16 8.15877"]');
      expect(bodyPath).not.toBeNull();
      expect(bodyPath?.getAttribute('stroke')).toBe('currentColor');
      // Pinned literally: 1.55 keeps this app-local stroke glyph 0.05
      // heavier than the Material Symbols weight-300 strokes (1.5 units on a
      // 24px grid) around it, the same offset it was tuned to before.
      expect(bodyPath?.getAttribute('stroke-width')).toBe('1.55');
      expect(BANNER_GLYPH_STROKE_WIDTH).toBe(1.55);
      expect(bodyPath?.getAttribute('stroke-linecap')).toBe('round');
      expect(bodyPath?.getAttribute('stroke-linejoin')).toBe('round');
      expect(devIcon?.querySelector('path[d^="M4 16H20"]')).not.toBeNull();
      expect(devIcon?.querySelector('path[d^="M12 7V20"]')).not.toBeNull();
      expect(branchLabel?.textContent).toBe('codex/footer-alignment');
      expect(branchLabel?.className).toContain('min-w-0');
      expect(branchLabel?.className).toContain('flex-1');
      expect(branchLabel?.className).toContain('truncate');
      expect(badge?.getAttribute('data-testid')).toBe('sidebar-dev-badge');
      expect(item?.className).toContain('items-center');
      expect(item?.className).toContain('pr-2');
      // The shared 18px warning Badge, 5px from the 28px banner's top,
      // bottom and trailing edge (its 8px padding less a 3px margin).
      expect(badge?.textContent).toBe('Dev build');
      expect(badge?.className).toContain('h-4.5');
      expect(badge?.className).toContain('rounded-full');
      expect(badge?.className).toContain('-mr-0.75');
      expect(badge?.className).toContain('shrink-0');
      expect(badge?.className).toContain('bg-warning-subtle fg-warning-strong');
      expect(badge?.className).not.toContain('fg-emphasis');
      expect(badge?.className).not.toContain('uppercase');
      expect(item?.lastElementChild).toBe(badge);
      // The mask class is unconditional; the CSS only paints the fade while
      // the footer banner stack has content (banner-driven, not dev-driven).
      expect(
        container.querySelector('[data-testid="sidebar-scroll-container"]')
          ?.className,
      ).toContain('sidebar-scroll-mask');

      const status = container.querySelector<HTMLElement>(
        '[data-testid="app-sidebar-bottom-status"]',
      );
      expect(
        status?.querySelector('[data-testid="sidebar-dev-item"]'),
      ).toBeNull();
      const footer = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-footer-items"]',
      );
      expect(footer?.querySelector('[data-testid="sidebar-dev-item"]')).toBe(
        item,
      );
      expect(footer?.lastElementChild).toBe(
        container.querySelector('[data-testid="sidebar-account-menu-stub"]'),
      );
    } finally {
      unmount();
    }
  });

  it('insets the dev build badge 7px on every side of the 32px early-access banner', async () => {
    setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    const { container, unmount } = await renderSidebar({}, makePreferences(), {
      isDev: true,
      branch: 'codex/footer-alignment',
    });
    try {
      const item = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-dev-item"]',
      );
      const badge = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-dev-badge"]',
      );
      // 32px banner, 18px badge: 7px above and below. The banner's 8px right
      // padding less the badge's -1px margin: 7px on the right too.
      expect(item?.classList).toContain('h-8');
      expect(badge?.classList).toContain('h-4.5');
      expect(badge?.classList).toContain('-mr-px');
      expect(badge?.classList).not.toContain('-mr-0.75');
      expect(badge?.classList).toContain('rounded-full');
    } finally {
      unmount();
    }
  });

  it('fades the bottom of the project scroll area in non-dev builds too', async () => {
    // Footer banners (update prompt, guest credits CTA) render in packaged
    // builds where isDev is false, so the bottom fade cannot be dev-only —
    // otherwise scrolled rows clip with a hard edge above those banners.
    const { container, unmount } = await renderSidebar({}, makePreferences(), {
      isDev: false,
      branch: null,
    });
    try {
      expect(
        container.querySelector('[data-testid="sidebar-scroll-container"]')
          ?.className,
      ).toContain('sidebar-scroll-mask');
    } finally {
      unmount();
    }
  });

  it('hosts the update prompt inside the account menu banner stack, not the sidebar footer', async () => {
    // The update prompt moved into SidebarAccountMenu's banner stack (update >
    // credits > DEV) so banner spacing is owned in one place; SidebarAccountMenu
    // tests cover its rendering and ordering. At the AppSidebar level the
    // footer's last child is the account menu and no stray prompt renders.
    mockSidebarUpdateState({
      phase: 'available',
      info: { version: '0.29.0' },
    });
    const { container, unmount } = await renderSidebar();
    try {
      const footer = container.querySelector(
        '[data-testid="sidebar-footer-items"]',
      );
      expect(footer?.lastElementChild).toBe(
        container.querySelector('[data-testid="sidebar-account-menu-stub"]'),
      );
      // The mocked account menu stub does not mount UpdatePrompt, so no
      // prompt may appear anywhere else in the sidebar.
      expect(
        container.querySelector('[data-testid="update-prompt"]'),
      ).toBeNull();
      expect(
        container
          .querySelector('[data-testid="app-sidebar-bottom-status"]')
          ?.querySelector('[data-testid="update-prompt"]'),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  it('uses a consistent 1px gap throughout the primary navigation', async () => {
    const { container, unmount } = await renderSidebar();
    try {
      const fixedNavigation = container.querySelector(
        '[data-testid="sidebar-fixed-navigation"]',
      );
      const primaryNavigation = container.querySelector(
        '[data-testid="sidebar-primary-navigation"]',
      );
      const nav = primaryNavigation?.querySelector('nav');
      const scrollingNavigation = container.querySelector(
        '[data-testid="sidebar-scroll-container"]',
      );

      // 8px plus the top bar's bottom hairline, so New task centres on the
      // first chat tab beside it.
      expect(fixedNavigation?.className).toContain(
        'pt-[calc(8px+var(--border-hairline))]',
      );
      expect(fixedNavigation?.className).toContain('pb-px');
      expect(fixedNavigation?.className).toContain('px-2');
      expect(fixedNavigation?.className).not.toContain('mr-');
      expect(primaryNavigation?.className).toContain('gap-px');
      expect(primaryNavigation?.className).not.toContain('pt-2');
      expect(nav?.className).toContain('gap-px');
      expect(nav?.className).not.toContain('gap-1');
      expect(scrollingNavigation?.className).toContain('scrollbar-hide');
      expect(scrollingNavigation?.className).not.toContain(
        'sidebar-nav-scroll-mask',
      );
      expect(scrollingNavigation?.className).not.toContain('px-2');
      expect(scrollingNavigation?.className).not.toMatch(/\bpr-/);
      expect(scrollingNavigation?.className).not.toMatch(/\bmr-/);
      expect(scrollingNavigation?.getAttribute('style') ?? '').not.toContain(
        'scrollbar-gutter',
      );
      const sidebarScrollbar =
        scrollingNavigation?.parentElement?.querySelector(
          '[data-sidebar-scrollbar]',
        );
      expect(sidebarScrollbar?.className).toContain('absolute');
      expect(sidebarScrollbar?.className).toContain('z-50');
      expect(
        container.querySelector('[data-sidebar-selected-pin-bottom]')
          ?.className,
      ).toContain('z-20');
      expect(
        scrollingNavigation?.querySelector('[data-sidebar-scroll-content]')
          ?.className,
      ).toContain('px-2');
      expect(
        fixedNavigation?.querySelector('[data-testid="sidebar-create-task"]'),
      ).not.toBeNull();
      expect(
        fixedNavigation?.querySelector('[data-testid="sidebar-search"]'),
      ).not.toBeNull();
      expect(
        primaryNavigation?.querySelector('[data-testid="sidebar-create-task"]'),
      ).toBeNull();
      expect(
        primaryNavigation?.querySelector('[data-testid="sidebar-search"]'),
      ).toBeNull();
      expect(
        scrollingNavigation?.querySelector('[data-testid="sidebar-sections"]'),
      ).not.toBeNull();
      expect(
        scrollingNavigation?.querySelector(
          '[data-testid="sidebar-scroll-top-gradient"]',
        ),
      ).toBeNull();
      expect(
        scrollingNavigation?.querySelector(
          '[data-testid="sidebar-scroll-top-mask"]',
        ),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  it('keeps one Projects header inside the native sticky controls group', async () => {
    const { container, unmount } = await renderSidebar();
    try {
      const workspacesHeader = container.querySelector<HTMLElement>(
        '.sidebar-sticky-header',
      );
      expect(workspacesHeader).not.toBeNull();
      expect(workspacesHeader?.classList.contains('sticky')).toBe(false);
      expect(container.querySelectorAll('.sidebar-sticky-header')).toHaveLength(
        1,
      );
      expect(
        workspacesHeader?.closest(
          '[data-testid="sidebar-more-sticky-container"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="sidebar-workspaces-sticky-header-host"]',
        ),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  // More is an action menu, so it takes the action-menu rows (small text,
  // tertiary icons) under either menu placement.
  it.each([
    ['early access', 'cursor', 'text-xs', 'fg-tertiary'],
    ['without early access', 'anchored', 'text-xs', 'fg-tertiary'],
  ] as const)(
    '%s: the More menu uses the action-menu row style',
    async (_name, placement, textClassName, iconClassName): Promise<void> => {
      seedMoreMenu();
      const { container, unmount } = await renderSidebar(
        {},
        makePreferences(),
        { isDev: false, branch: null },
        undefined,
        placement,
      );
      try {
        act((): void =>
          container
            .querySelector<HTMLButtonElement>('[data-testid="sidebar-more"]')
            ?.click(),
        );
        const item = document.body.querySelector(
          '[data-testid="sidebar-more-menu"] [role="menuitem"]',
        );
        expect(item).not.toBeNull();
        expect(item?.classList.contains(textClassName)).toBe(true);
        expect(item?.querySelector(`.${iconClassName}`)).toBeInstanceOf(
          Element,
        );
      } finally {
        unmount();
      }
    },
  );

  it('separates Customize sidebar from the section items in More', async (): Promise<void> => {
    seedMoreMenu();
    const { container, unmount } = await renderSidebar();
    try {
      const moreButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-more"]',
      );
      act((): void => moreButton?.click());
      const menu = document.body.querySelector(
        '[data-testid="sidebar-more-menu"]',
      );
      expect(menu).not.toBeNull();
      const divider = menu?.querySelector(
        '[role="separator"][data-testid="sidebar-more-customize-divider"]',
      );
      expect(divider).not.toBeNull();
      const customize = menu?.querySelector(
        '[data-testid="sidebar-more-item-customize"]',
      );
      expect(customize).not.toBeNull();
      expect(customize?.previousElementSibling).toBe(divider);
      expect(divider?.previousElementSibling?.getAttribute('role')).toBe(
        'menuitem',
      );
    } finally {
      unmount();
    }
  });

  it.each([
    {
      name: 'nothing is after the divider',
      moreStartIndex: DEFAULT_SIDEBAR_NAV_LAYOUT.order.length,
    },
    {
      // Only Overview, whose experiment is off, is left in More.
      name: 'More holds only a key of an experiment that is off',
      moreStartIndex: DEFAULT_SIDEBAR_NAV_LAYOUT.order.length - 1,
      order: [
        ...DEFAULT_SIDEBAR_NAV_LAYOUT.order.filter((key) => key !== 'overview'),
        'overview',
      ],
    },
  ])(
    'keeps Customize available when $name (CAN-4402)',
    async ({ moreStartIndex, order }): Promise<void> => {
      const preferences = makePreferences({
        sidebarNavLayout: {
          order: order ?? [...DEFAULT_SIDEBAR_NAV_LAYOUT.order],
          moreStartIndex,
        },
      });
      useSidebarStore.getState().hydrateFromPreferences(preferences);
      const { container, unmount } = await renderSidebar({}, preferences);
      try {
        // With dev pages disabled, Customize is the only menu item.
        expect(isHeaderStatesPageEnabled()).toBe(false);
        expect(isWorktreeStatesPageEnabled()).toBe(false);
        expect(isActivityStatesPageEnabled()).toBe(false);
        expect(isMessageBubbleStatesPageEnabled()).toBe(false);
        expect(isChangeReviewPageEnabled()).toBe(false);
        const trigger = container.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-more"]',
        );
        expect(trigger).not.toBeNull();
        expect(
          container.querySelector('[data-testid="sidebar-more-sticky-lead"]'),
        ).not.toBeNull();
        act(() => trigger?.click());
        const menu = document.body.querySelector(
          '[data-testid="sidebar-more-menu"]',
        );
        expect(
          Array.from(
            menu?.querySelectorAll('[role="menuitem"]') ?? [],
            (item) => item.getAttribute('data-testid'),
          ),
        ).toEqual(['sidebar-more-item-customize']);
        expect(menu?.querySelectorAll('[role="separator"]')).toHaveLength(0);
        expect(
          container.querySelector('[data-testid="sidebar-nav-environments"]'),
        ).toBeNull();
      } finally {
        unmount();
      }
    },
  );

  it('shows Customize without retired Environments in the default layout', async () => {
    const { container, unmount } = await renderSidebar();
    try {
      act((): void => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="sidebar-more"]')
          ?.click();
      });
      const menu = document.body.querySelector(
        '[data-testid="sidebar-more-menu"]',
      );
      expect(
        menu?.querySelector('[data-testid="sidebar-more-item-environments"]'),
      ).toBeNull();
      expect(
        menu?.querySelector('[data-testid="sidebar-more-item-customize"]'),
      ).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it('opens Customize sidebar from a right-click on the main nav (CAN-3678)', async () => {
    const { container, unmount } = await renderSidebar();
    try {
      const nav = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-main-nav"]',
      );
      const row = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-nav-plugins"]',
      );
      if (nav === null || row === null) throw new Error('Expected main nav');

      // A row that handles its own context menu wins over the nav menu.
      const ownMenu = (event: Event): void => event.preventDefault();
      row.addEventListener('contextmenu', ownMenu);
      act((): void => {
        row.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
      });
      expect(
        document.body.querySelector(
          '[data-testid="sidebar-nav-context-customize"]',
        ),
      ).toBeNull();
      row.removeEventListener('contextmenu', ownMenu);

      act((): void => {
        row.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 40,
            clientY: 80,
          }),
        );
      });
      const item = document.body.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-nav-context-customize"]',
      );
      expect(item?.textContent).toContain('Customize sidebar…');
      act((): void => item?.click());
      expect(
        document.body.querySelector(
          '[data-testid="sidebar-nav-context-customize"]',
        ),
      ).toBeNull();
      expect(
        document.body.querySelector('[data-testid="customize-sidebar-modal"]'),
      ).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it('packs every dev page into one More entry that opens the first one', async () => {
    const onNavigate = jest.fn();
    // Packaged build: no dev pages, so no entry.
    const packaged = await renderSidebar({ onNavigate }, makePreferences(), {
      isDev: false,
      branch: null,
    });
    try {
      act((): void => {
        packaged.container
          .querySelector<HTMLButtonElement>('[data-testid="sidebar-more"]')
          ?.click();
      });
      expect(
        document.body.querySelector(
          '[data-testid="sidebar-more-item-dev-pages"]',
        ),
      ).toBeNull();
      expect(
        document.body.querySelector('[data-testid="sidebar-entry-marker-dev"]'),
      ).toBeNull();
    } finally {
      packaged.unmount();
    }

    window.localStorage.setItem(CHANGE_REVIEW_PAGE_STORAGE_KEY, '1');
    const { container, unmount } = await renderSidebar(
      { onNavigate },
      makePreferences(),
      { isDev: true, branch: null },
    );
    try {
      act((): void => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="sidebar-more"]')
          ?.click();
      });
      const item = document.body.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-more-item-dev-pages"]',
      );
      expect(item?.textContent).toContain('Dev pages');
      expect(
        item
          ?.querySelector('[data-testid="sidebar-entry-marker-dev"]')
          ?.getAttribute('aria-label'),
      ).toBe('Dev');
      // One entry replaces the per-page ones.
      for (const page of [
        'notice-states',
        'header-states',
        'worktree-states',
        'activity-states',
        'message-bubble-states',
        'change-review',
      ]) {
        expect(
          document.body.querySelector(
            `[data-testid="sidebar-more-item-${page}"]`,
          ),
        ).toBeNull();
      }
      // The entry sits above the Customize divider.
      expect(
        document.body.querySelector(
          '[data-testid="sidebar-more-customize-divider"]',
        ),
      ).not.toBeNull();
      act((): void => {
        item?.click();
      });
      expect(onNavigate).toHaveBeenCalledWith('notice-states');
    } finally {
      unmount();
    }
  });

  it.each([false, true])(
    'rolls navigation into More at restored scroll independently of Projects (no Projects: %s)',
    async (noProjects) => {
      seedMoreMenu();
      const { container, unmount } = await renderSidebar();
      try {
        const viewport = container.querySelector<HTMLElement>(
          '[data-testid="sidebar-scroll-container"]',
        );
        const sentinel = container.querySelector<HTMLElement>(
          '[data-testid="sidebar-sticky-workspace-sentinel"]',
        );
        const trigger = container.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-more"]',
        );
        if (!viewport || !sentinel || !trigger)
          throw new Error('Expected sidebar geometry');
        if (noProjects) {
          viewport
            .querySelectorAll<HTMLElement>(
              '.sidebar-sticky-workspace-controls, [data-sidebar-section-content]',
            )
            .forEach((element) => element.remove());
        }
        // Navigation ends at 120px. Expanded Chats push Projects much further down.
        Object.defineProperty(sentinel, 'offsetTop', {
          configurable: true,
          value: 120,
        });
        mockNavigationGeometry(viewport, () => 120);
        const chats = container.querySelector('[data-sidebar-chats-mask]');
        if (chats)
          Object.defineProperty(chats, 'offsetHeight', {
            configurable: true,
            value: 400,
          });
        // Restore scroll without dispatching a scroll event. Opening must measure directly.
        viewport.scrollTop = 160;
        act(() => trigger.click());
        expect(
          document.body.querySelector(
            '[data-testid="sidebar-more-item-app-advisor"]',
          ),
        ).not.toBeNull();
        expect(viewport.scrollTop).toBe(160);
      } finally {
        unmount();
      }
    },
  );

  it.each([
    { custom: false, dev: false, scrolled: false },
    { custom: false, dev: false, scrolled: true },
    { custom: true, dev: false, scrolled: false },
    { custom: true, dev: false, scrolled: true },
    { custom: false, dev: true, scrolled: false },
    { custom: false, dev: true, scrolled: true },
    { custom: true, dev: true, scrolled: false },
    { custom: true, dev: true, scrolled: true },
  ])(
    'composes rendered More groups: $custom custom, $dev dev, $scrolled rolled up',
    async ({ custom, dev, scrolled }) => {
      if (dev) localStorage.setItem(CHANGE_REVIEW_PAGE_STORAGE_KEY, '1');
      publishPageExperimentsOn();
      const order = [
        ...DEFAULT_SIDEBAR_NAV_LAYOUT.order.filter((key) => key !== 'plugins'),
        'plugins',
      ];
      const preferences = makePreferences({
        sidebarNavLayout: {
          order,
          moreStartIndex: order.length - (custom ? 1 : 0),
        },
      });
      useSidebarStore.getState().hydrateFromPreferences(preferences);
      const { container, unmount } = await renderSidebar({}, preferences, {
        isDev: dev,
        branch: null,
      });
      try {
        const viewport = container.querySelector<HTMLElement>(
          '[data-testid="sidebar-scroll-container"]',
        );
        const trigger = container.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-more"]',
        );
        if (!viewport || !trigger)
          throw new Error('Expected More and viewport');
        mockNavigationGeometry(viewport, () => 120);
        viewport.scrollTop = scrolled ? 120 : 0;
        const mainIds = Array.from(
          container.querySelectorAll(
            '[data-testid="sidebar-main-nav"] [data-testid^="sidebar-nav-"]',
          ),
          (item) =>
            item
              .getAttribute('data-testid')
              ?.replace('sidebar-nav-', 'sidebar-more-item-'),
        );
        act(() => trigger.click());
        const menu = document.body.querySelector(
          '[data-testid="sidebar-more-menu"]',
        );
        expect(menu).not.toBeNull();
        const groups = [
          scrolled ? mainIds : [],
          [
            ...(custom ? ['sidebar-more-item-plugins'] : []),
            ...(dev ? ['sidebar-more-item-dev-pages'] : []),
          ],
          ['sidebar-more-item-customize'],
        ].filter((group) => group.length > 0);
        const expected = groups.flatMap((group, index) =>
          index === 0 ? group : ['separator', ...group],
        );
        const actual = Array.from(
          menu?.querySelectorAll('[role="menuitem"], [role="separator"]') ?? [],
          (item) =>
            item.getAttribute('role') === 'separator'
              ? 'separator'
              : item.getAttribute('data-testid'),
        );
        expect(actual).toEqual(expected);
        expect(new Set(actual.filter((id) => id !== 'separator')).size).toBe(
          actual.filter((id) => id !== 'separator').length,
        );
        // A Labs row rolled into More keeps its marker (CAN-3679).
        const rolledOverview = menu?.querySelector(
          '[data-testid="sidebar-more-item-overview"]',
        );
        expect(
          rolledOverview
            ?.querySelector('[data-testid="sidebar-entry-marker-labs"]')
            ?.getAttribute('aria-label'),
        ).toBe(scrolled ? 'Labs' : undefined);
        if (dev)
          expect(
            menu?.querySelector(
              '[data-testid="sidebar-more-item-dev-pages"] [data-testid="sidebar-entry-marker-dev"]',
            ),
          ).not.toBeNull();
      } finally {
        unmount();
      }
    },
  );

  it('renders no empty roll-up group or duplicate destinations when every destination is assigned to More', async () => {
    const preferences = makePreferences({
      sidebarNavLayout: {
        order: [...DEFAULT_SIDEBAR_NAV_LAYOUT.order],
        moreStartIndex: 0,
      },
    });
    useSidebarStore.getState().hydrateFromPreferences(preferences);
    const sidebar = await renderSidebar({}, preferences);
    try {
      const viewport = sidebar.container.querySelector<HTMLElement>(
        '[data-testid="sidebar-scroll-container"]',
      );
      const trigger = sidebar.container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-more"]',
      );
      if (!viewport || !trigger) throw new Error('Expected More and viewport');
      mockNavigationGeometry(viewport, () => 0);
      viewport.scrollTop = 100;
      act(() => trigger.click());
      const menu = document.body.querySelector(
        '[data-testid="sidebar-more-menu"]',
      );
      expect(menu).not.toBeNull();
      const rows = Array.from(
        menu?.querySelectorAll('[role="menuitem"]') ?? [],
        (item) => item.getAttribute('data-testid'),
      );
      expect(rows.at(-1)).toBe('sidebar-more-item-customize');
      expect(new Set(rows).size).toBe(rows.length);
      expect(menu?.querySelectorAll('[role="separator"]')).toHaveLength(1);
      expect(
        menu?.querySelector('[data-testid="sidebar-more-workspace-divider"]'),
      ).toBeNull();
    } finally {
      sidebar.unmount();
    }
  });

  it('closes on layout-driven navigation crossings at unchanged scroll and on eligibility changes', async () => {
    const frames = installManualAnimationFrames();
    seedMoreMenu();
    const sidebar = await renderSidebar();
    try {
      const viewport = sidebar.container.querySelector<HTMLElement>(
        '[data-testid="sidebar-scroll-container"]',
      );
      const trigger = sidebar.container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-more"]',
      );
      if (!viewport || !trigger) throw new Error('Expected More and viewport');
      let boundary = 120;
      mockNavigationGeometry(viewport, () => boundary);
      viewport.scrollTop = 160;
      await frames.flushFrames();
      act(() => trigger.click());
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      // Changing layout at the same scroll position must invalidate the cache.
      boundary = 200;
      await act(async () => {
        const resizedHeader = document.createElement('div');
        resizedHeader.className = 'sidebar-workspace-sticky-header';
        viewport.appendChild(resizedHeader);
        await Promise.resolve();
      });
      await frames.flushFrames();
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      act(() => trigger.click());
      expect(
        document.body.querySelector(
          '[data-testid="sidebar-more-item-app-advisor"]',
        ),
      ).toBeNull();
      const focusedItem = document.body.querySelector<HTMLElement>(
        '[data-testid="sidebar-more-item-plugins"]',
      );
      if (!focusedItem) throw new Error('Expected eligible Plugins item');
      act(() => focusedItem.focus());
      const focusTrigger = jest.spyOn(trigger, 'focus');
      act(() => {
        applyLabsExperimentsSnapshot(
          makeTestLabsSnapshot({
            experiments: [
              {
                id: 'plugins-fixture',
                pages: ['plugins'],
                sidebarKeys: ['plugins'],
              },
            ],
          }),
        );
      });
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(trigger);
      expect(focusTrigger).toHaveBeenCalledWith({ preventScroll: true });
      expect(viewport.scrollTop).toBe(160);
      act(() => trigger.click());
      expect(
        document.body.querySelector(
          '[data-testid="sidebar-more-item-plugins"]',
        ),
      ).toBeNull();
      // Closing for an order change must preserve focus already handed to
      // another surface, rather than pulling it back into the sidebar.
      const destination = document.createElement('button');
      sidebar.container.appendChild(destination);
      act(() => destination.focus());
      focusTrigger.mockClear();
      act(() => {
        const layout = useSidebarStore.getState().sidebarNavLayout;
        useSidebarStore.setState({
          sidebarNavLayout: { ...layout, order: [...layout.order].reverse() },
        });
      });
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(destination);
      expect(focusTrigger).not.toHaveBeenCalled();
    } finally {
      sidebar.unmount();
      frames.restore();
    }
  });

  it('keeps More in its normal layout until scrolling, then exposes primary navigation below a divider', async () => {
    useSidebarStore.getState().hydrateFromPreferences(
      makePreferences({
        sidebarNavLayout: {
          order: [
            ...DEFAULT_SIDEBAR_NAV_LAYOUT.order.filter(
              (key) => key !== 'audit',
            ),
            'audit',
          ],
          moreStartIndex: DEFAULT_SIDEBAR_NAV_LAYOUT.order.length - 1,
        },
      }),
    );
    applyLabsExperimentsSnapshot(
      makeTestLabsSnapshot({
        experiments: pageExperimentsOn().map((entry) => ({
          ...entry,
          choice: entry.id === 'audit-trail-page',
        })),
      }),
    );
    const onNavigate = jest.fn();
    const onAppAdvisorClick = jest.fn();
    // jsdom has no layout. Seed the sentinel before mounting so an early
    // startup frame cannot cache a zero sticky threshold.
    const offsetTop = jest
      .spyOn(HTMLElement.prototype, 'offsetTop', 'get')
      .mockImplementation(function (this: HTMLElement): number {
        return this.dataset.testid === 'sidebar-sticky-workspace-sentinel'
          ? 120
          : 0;
      });
    const { container, unmount } = await renderSidebar({
      onNavigate,
      onAppAdvisorClick,
    });
    try {
      // Exercise the CI ordering where startup layout finishes before the
      // assertions. The first real scroll must still build the geometry cache.
      await act(async () => {
        await waitForSidebarLayout();
      });
      const stickyContainer = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-more-sticky-container"]',
      );
      const moreButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-more"]',
      );
      expect(stickyContainer?.className).toContain('sticky');
      expect(stickyContainer?.className).toContain('top-px');
      expect(stickyContainer?.className).not.toContain('bg-');

      act(() => moreButton?.click());
      expect(moreButton?.getAttribute('aria-expanded')).toBe('true');
      expect(moreButton?.className).not.toContain('bg-muted');
      expect(
        document.body.querySelector(
          '[data-testid="sidebar-more-workspace-divider"]',
        ),
      ).toBeNull();
      expect(
        document.body.querySelector(
          '[data-testid="sidebar-more-item-app-advisor"]',
        ),
      ).toBeNull();
      expect(moreButton?.closest('nav')?.getAttribute('aria-label')).toBe(
        'Project navigation actions',
      );

      const viewport = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-scroll-container"]',
      );
      if (!viewport) {
        throw new Error('Expected sidebar scroll viewport');
      }
      mockNavigationGeometry(viewport, () => 120);

      const stickySentinel = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-sticky-workspace-sentinel"]',
      );
      if (!stickySentinel) {
        throw new Error('Expected sticky workspace sentinel');
      }
      const viewportQuerySelectorAll = jest.spyOn(viewport, 'querySelectorAll');
      await act(async () => {
        stickySentinel.append(document.createComment('threshold ready'));
        await Promise.resolve();
        await waitForSidebarLayout();
      });
      // Layout-only startup mutations at scrollTop=0 leave the large
      // workspace geometry cache cold.
      expect(viewportQuerySelectorAll).not.toHaveBeenCalled();
      act(() => {
        viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      expect(viewportQuerySelectorAll).not.toHaveBeenCalled();
      Object.defineProperty(viewport, 'scrollTop', {
        configurable: true,
        value: 200,
      });
      act(() => {
        viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      expect(viewportQuerySelectorAll).toHaveBeenCalled();
      viewportQuerySelectorAll.mockClear();
      expect(moreButton?.getAttribute('aria-expanded')).toBe('false');
      expect(
        document.body.querySelector('[data-testid="sidebar-more-menu"]'),
      ).toBeNull();

      const workspaceRows = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-section-code"] > [data-sidebar-section-content]',
      );
      const primaryNavigation = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-primary-navigation"]',
      );
      expect(
        primaryNavigation?.style.getPropertyValue(
          '--sidebar-new-task-mask-start',
        ),
      ).toBe('200px');
      expect(
        primaryNavigation?.style.getPropertyValue(
          '--sidebar-new-task-mask-end',
        ),
      ).toBe('212px');
      expect(workspaceRows?.style.clipPath).toBe('');
      expect(workspaceRows?.style.translate).toBe('');
      expect(workspaceRows?.style.willChange).toBe('');
      expect(
        container
          .querySelector<HTMLElement>(
            '[data-testid="sidebar-section-code"] > [data-sidebar-section-content]',
          )
          ?.style.getPropertyValue('--sidebar-workspaces-clip-top'),
      ).toBe('');

      const stickyHeader = container.querySelector('.sidebar-sticky-header');
      const viewportQuerySelector = jest.spyOn(viewport, 'querySelector');
      Object.defineProperty(viewport, 'scrollTop', {
        configurable: true,
        value: 50,
        writable: true,
      });
      Object.defineProperty(viewport, 'scrollHeight', {
        configurable: true,
        value: 500,
      });
      Object.defineProperty(viewport, 'clientHeight', {
        configurable: true,
        value: 200,
      });
      const preStickyWheel = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 10,
      });
      act(() => {
        viewport.dispatchEvent(preStickyWheel);
      });
      // Even pre-threshold wheels are canceled and applied on the main
      // thread: leaving the first event of a trackpad sequence uncanceled
      // would latch the whole gesture to composited scrolling, whose frames
      // outrun the main-thread sticky sync on fast flings.
      expect(preStickyWheel.defaultPrevented).toBe(true);
      expect(viewport.scrollTop).toBe(60);

      const rendersBeforeCrossings = globalThis.__workspacesSectionRenders;
      for (const scrollTop of [119, 121, 119, 200]) {
        Object.defineProperty(viewport, 'scrollTop', {
          configurable: true,
          value: scrollTop,
        });
        act(() => {
          viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        expect(
          container.querySelector(
            '[data-testid="sidebar-more-sticky-container"]',
          ),
        ).toBe(stickyContainer);
        expect(container.querySelector('.sidebar-sticky-header')).toBe(
          stickyHeader,
        );
      }
      // Crossing the sticky threshold with the More menu closed performs no
      // React render: the sticky flag lives in a ref, and the menu snapshots
      // it when it opens. Main-thread wheel scrolling would otherwise stall
      // on a sidebar-wide render exactly at the crossing.
      expect(globalThis.__workspacesSectionRenders).toBe(
        rendersBeforeCrossings,
      );
      expect(
        container
          .querySelector<HTMLElement>(
            '[data-testid="sidebar-section-code"] > [data-sidebar-section-content]',
          )
          ?.style.getPropertyValue('--sidebar-workspaces-clip-top'),
      ).toBe('');
      expect(workspaceRows?.style.clipPath).toBe('');
      expect(workspaceRows?.style.translate).toBe('');

      Object.defineProperty(viewport, 'scrollTop', {
        configurable: true,
        value: 119,
        writable: true,
      });
      Object.defineProperty(viewport, 'scrollHeight', {
        configurable: true,
        value: 500,
      });
      Object.defineProperty(viewport, 'clientHeight', {
        configurable: true,
        value: 200,
      });
      const zoomWheel = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: 81,
      });
      act(() => {
        viewport.dispatchEvent(zoomWheel);
      });
      expect(zoomWheel.defaultPrevented).toBe(false);
      expect(viewport.scrollTop).toBe(119);

      Object.defineProperty(viewport, 'scrollHeight', {
        configurable: true,
        value: 200,
      });
      const nonOverflowingWheel = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 81,
      });
      act(() => {
        viewport.dispatchEvent(nonOverflowingWheel);
      });
      expect(nonOverflowingWheel.defaultPrevented).toBe(false);
      expect(viewport.scrollTop).toBe(119);

      Object.defineProperty(viewport, 'scrollHeight', {
        configurable: true,
        value: 500,
      });
      const forwardWheel = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 81,
      });
      act(() => {
        viewport.dispatchEvent(forwardWheel);
      });
      // Wheel capture commits the scroll position and every sticky style
      // write in the same main-thread frame; occlusion of the moving rows is
      // owned by the always-on scroll-driven clip animation, never by inline
      // per-scroll style writes.
      expect(forwardWheel.defaultPrevented).toBe(true);
      expect(viewport.scrollTop).toBe(200);
      expect(workspaceRows?.style.clipPath).toBe('');
      expect(workspaceRows?.style.translate).toBe('');

      // A non-cancelable event belongs to a compositor-latched sequence whose
      // delta is applied natively; applying it manually as well would double
      // the scroll speed for the rest of the gesture.
      const latchedWheel = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: false,
        deltaY: 81,
      });
      act(() => {
        viewport.dispatchEvent(latchedWheel);
      });
      expect(viewport.scrollTop).toBe(200);

      Object.defineProperty(viewport, 'scrollTop', {
        configurable: true,
        value: 200,
        writable: true,
      });
      const reverseWheel = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: -200,
      });
      act(() => {
        viewport.dispatchEvent(reverseWheel);
      });
      expect(reverseWheel.defaultPrevented).toBe(true);
      expect(viewport.scrollTop).toBe(0);
      expect(workspaceRows?.style.clipPath).toBe('');
      expect(workspaceRows?.style.translate).toBe('');
      expect(workspaceRows?.style.willChange).toBe('');

      Object.defineProperty(viewport, 'scrollTop', {
        configurable: true,
        value: 0,
      });
      act(() => {
        viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      expect(
        primaryNavigation?.style.getPropertyValue(
          '--sidebar-new-task-mask-start',
        ),
      ).toBe('-12px');
      expect(
        primaryNavigation?.style.getPropertyValue(
          '--sidebar-new-task-mask-end',
        ),
      ).toBe('0px');
      expect(workspaceRows?.style.clipPath).toBe('');
      expect(workspaceRows?.style.translate).toBe('');
      // Layout nodes and thresholds are measured once, then reused for the
      // wheel/scroll hot path until a real mutation or resize invalidates them.
      expect(viewportQuerySelector).not.toHaveBeenCalled();
      expect(viewportQuerySelectorAll).not.toHaveBeenCalled();
      viewportQuerySelector.mockRestore();
      viewportQuerySelectorAll.mockRestore();

      Object.defineProperty(viewport, 'scrollTop', {
        configurable: true,
        value: 200,
      });
      act(() => {
        viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      });

      const rendersBeforeMenuOpen = globalThis.__workspacesSectionRenders;
      act(() => moreButton?.click());
      // Opening the menu is allowed to render (it snapshots the sticky flag)
      // — this also proves the render counter frozen above is live.
      expect(globalThis.__workspacesSectionRenders).toBeGreaterThan(
        rendersBeforeMenuOpen,
      );
      expect(moreButton?.getAttribute('aria-expanded')).toBe('true');
      expect(moreButton?.className).not.toContain('bg-muted');
      const menu = document.body.querySelector<HTMLElement>(
        '[data-testid="sidebar-more-menu"]',
      );
      const scrollViewport = menu?.querySelector<HTMLElement>(
        '[data-floating-menu-scroll-viewport="true"]',
      );
      // Menu rows sit inside the shared OverlayScrollArea's content wrapper,
      // so the ordered row list comes from that element rather than the
      // scroll viewport itself.
      const menuRowParent =
        scrollViewport?.querySelector<HTMLElement>(
          '[data-overlay-scroll-content]',
        ) ?? scrollViewport;
      const menuTestIds = Array.from(menuRowParent?.children ?? []).map(
        (child) => child.getAttribute('data-testid'),
      );
      const dividerIndex = menuTestIds.indexOf(
        'sidebar-more-workspace-divider',
      );
      expect(dividerIndex).toBeGreaterThan(0);
      expect(
        menuTestIds.indexOf('sidebar-more-item-customize'),
      ).toBeGreaterThan(dividerIndex);

      const primaryItemIds = [
        'sidebar-more-item-app-advisor',
        'sidebar-more-item-workflows',
        'sidebar-more-item-plugins',
      ];
      expect(
        primaryItemIds.map((testId) => menuTestIds.indexOf(testId)),
      ).toEqual([0, 1, 2]);
      expect(dividerIndex).toBe(primaryItemIds.length);

      act(() => {
        document.body
          .querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-more-item-plugins"]',
          )
          ?.click();
      });
      expect(onNavigate).toHaveBeenCalledWith('plugins');
      expect(onAppAdvisorClick).not.toHaveBeenCalled();

      // Keyboard opening (FloatingMenu's ArrowDown anchor path) goes through
      // the same open chokepoint and re-snapshots the live sticky flag. The
      // previous open (while sticky) left a stale `true` snapshot; scrolling
      // back to rest and reopening via keyboard must NOT show the
      // sticky-only workspace items.
      expect(
        document.body.querySelector('[data-testid="sidebar-more-menu"]'),
      ).toBeNull();
      Object.defineProperty(viewport, 'scrollTop', {
        configurable: true,
        value: 0,
      });
      act(() => {
        viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      act(() => {
        moreButton?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
      });
      const keyboardMenuIds = Array.from(
        document.body.querySelector<HTMLElement>(
          '[data-testid="sidebar-more-menu"] [data-floating-menu-scroll-viewport="true"] [data-overlay-scroll-content]',
        )?.children ?? [],
      ).map((child) => child.getAttribute('data-testid'));
      expect(keyboardMenuIds).toContain('sidebar-more-item-customize');
      expect(keyboardMenuIds).not.toContain('sidebar-more-workspace-divider');
    } finally {
      unmount();
      offsetTop.mockRestore();
    }
  });

  it.each([false, true])('swaps slots (collapsed: %s)', async (collapsed) => {
    const frames = installManualAnimationFrames();
    const { container, unmount } = await renderSidebar().catch(
      (error: unknown) => {
        frames.restore();
        throw error;
      },
    );
    try {
      const viewport = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-scroll-container"]',
      );
      const sentinel = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-sticky-workspace-sentinel"]',
      );
      const header = container.querySelector<HTMLElement>(
        '[data-testid="stub-workspace-header"]',
      );
      const rows = container.querySelector<HTMLElement>(
        '[data-testid="stub-workspace-rows"]',
      );
      const secondHeader = container.querySelector<HTMLElement>(
        '[data-testid="stub-second-workspace-header"]',
      );
      const secondRows = container.querySelector<HTMLElement>(
        '[data-testid="stub-second-workspace-rows"]',
      );
      const slot = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-sticky-workspace-slot"]',
      );
      const alphaSlot = container.querySelector<HTMLElement>(
        '[data-sidebar-sticky-slot-workspace-id="alpha"]',
      );
      const betaSlot = container.querySelector<HTMLElement>(
        '[data-sidebar-sticky-slot-workspace-id="beta"]',
      );
      if (
        !viewport ||
        !sentinel ||
        !header ||
        !rows ||
        !secondHeader ||
        !secondRows ||
        !slot ||
        !alphaSlot ||
        !betaSlot
      ) {
        throw new Error('Expected sticky viewport and project stub elements');
      }
      const workspaceFlow = container.querySelector<HTMLElement>(
        '.sidebar-workspaces-rows-clip',
      );
      if (!workspaceFlow) {
        throw new Error('Expected project flow');
      }
      const clipGeometryOrder: string[] = [];
      const originalSetProperty = workspaceFlow.style.setProperty.bind(
        workspaceFlow.style,
      );
      jest
        .spyOn(workspaceFlow.style, 'setProperty')
        .mockImplementation((property, value, priority) => {
          if (property.startsWith('--sidebar-workspaces-clip-')) {
            clipGeometryOrder.push(`write:${property}`);
          }
          originalSetProperty(property, value, priority);
        });

      Object.defineProperty(header, 'offsetTop', {
        configurable: true,
        value: 100,
      });
      Object.defineProperty(header, 'offsetHeight', {
        configurable: true,
        value: 32,
      });
      Object.defineProperty(rows, 'offsetTop', {
        configurable: true,
        value: 132,
      });
      Object.defineProperty(rows, 'offsetHeight', {
        configurable: true,
        value: 168,
      });
      Object.defineProperty(secondHeader, 'offsetTop', {
        configurable: true,
        value: 300,
      });
      Object.defineProperty(secondHeader, 'offsetHeight', {
        configurable: true,
        value: 32,
      });
      Object.defineProperty(secondRows, 'offsetTop', {
        configurable: true,
        value: 332,
      });
      Object.defineProperty(secondRows, 'offsetHeight', {
        configurable: true,
        value: 200,
      });
      Object.defineProperty(sentinel, 'offsetTop', {
        configurable: true,
        get: () => {
          clipGeometryOrder.push('read:offsetTop');
          return 120;
        },
      });
      Object.defineProperty(viewport, 'scrollTop', {
        configurable: true,
        value: 249.75,
        writable: true,
      });
      Object.defineProperty(viewport, 'scrollHeight', {
        configurable: true,
        get: () => {
          clipGeometryOrder.push('read:scrollHeight');
          return 1000;
        },
      });
      Object.defineProperty(viewport, 'clientHeight', {
        configurable: true,
        get: () => {
          clipGeometryOrder.push('read:clientHeight');
          return 200;
        },
      });
      jest
        .spyOn(viewport, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 0, 200, 200));
      const slotRect = jest
        .spyOn(slot, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 50, 200, 32));

      await act(async () => {
        if (collapsed) rows.remove();
        else rows.append(document.createComment('layout ready'));
        await Promise.resolve();
      });
      await frames.flushFrames();
      viewport.style.setProperty('--sidebar-workspace-header-top', '50px');
      const firstClipWrite = clipGeometryOrder.findIndex((entry) =>
        entry.startsWith('write:'),
      );
      const clipOffsetRead = clipGeometryOrder.indexOf('read:offsetTop');
      expect(firstClipWrite).toBeGreaterThanOrEqual(0);
      expect(clipOffsetRead).toBeLessThan(firstClipWrite);
      expect(
        clipGeometryOrder.lastIndexOf('read:scrollHeight', firstClipWrite),
      ).toBeGreaterThan(clipOffsetRead);
      expect(
        clipGeometryOrder.lastIndexOf('read:clientHeight', firstClipWrite),
      ).toBeGreaterThan(clipOffsetRead);
      expect(
        clipGeometryOrder
          .slice(firstClipWrite)
          .some((entry) => entry.startsWith('read:')),
      ).toBe(false);

      viewport.scrollTop = 0;
      act(() => {
        viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      expect(slot.hidden).toBe(true);
      expect(slot.dataset.activeWorkspaceId).toBeUndefined();
      expect(alphaSlot.hidden).toBe(true);
      expect(betaSlot.hidden).toBe(true);
      expect(header.inert).not.toBe(true);
      expect(secondHeader.inert).not.toBe(true);
      expect(
        workspaceFlow.hasAttribute('data-sidebar-workspace-sticky-active'),
      ).toBe(false);

      const assertSlotState = (
        scrollTop: number,
        expectedWorkspaceId: 'alpha' | 'beta',
      ): void => {
        viewport.scrollTop = scrollTop;
        act(() => {
          viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        expect(slot.hidden).toBe(false);
        expect(slot.dataset.activeWorkspaceId).toBe(expectedWorkspaceId);
        expect(slot.getBoundingClientRect().top).toBe(50);
        expect(alphaSlot.hidden).toBe(expectedWorkspaceId !== 'alpha');
        // Beta begins its natural approach before taking ownership at 250.
        expect(betaSlot.hidden).toBe(false);
        const incomingDistance = Math.max(0, 250 - scrollTop);
        expect(betaSlot.style.transform).toBe(
          `translateY(${incomingDistance}px)`,
        );
        if (expectedWorkspaceId === 'alpha') {
          expect(alphaSlot.style.transform).toBe(
            `translateY(${incomingDistance - 40}px)`,
          );
          const outgoingIsExposed = incomingDistance > 8;
          expect(alphaSlot.inert).toBe(!outgoingIsExposed);
          expect(alphaSlot.hasAttribute('aria-hidden')).toBe(
            !outgoingIsExposed,
          );
          expect(secondHeader.inert).toBe(true);
          expect(secondRows.inert).not.toBe(true);
        }
        expect(
          [alphaSlot, betaSlot].filter((candidate) => !candidate.hidden),
        ).toHaveLength(expectedWorkspaceId === 'alpha' ? 2 : 1);
        expect(
          workspaceFlow.getAttribute('data-sidebar-workspace-sticky-active'),
        ).toBe('true');
      };

      // The slot stays fixed while its two copies push past one another.
      // Identity changes only when beta reaches the 50px slot threshold.
      assertSlotState(234, 'alpha');
      assertSlotState(249.75, 'alpha');
      assertSlotState(249.99, 'alpha');
      assertSlotState(250, 'beta');
      assertSlotState(250.01, 'beta');

      // A large/fast delta uses the same synchronous path and cannot move the
      // slot container or reveal both workspace copies.
      const fastWheel = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 449.99,
      });
      act(() => {
        viewport.dispatchEvent(fastWheel);
      });
      expect(fastWheel.defaultPrevented).toBe(true);
      expect(viewport.scrollTop).toBe(700);
      expect(slot.dataset.activeWorkspaceId).toBe('beta');
      expect(slot.getBoundingClientRect().top).toBe(50);

      expect(header.style.clipPath).toBe('');
      expect(header.inert).toBe(true);
      expect(secondHeader.style.clipPath).toBe('');
      expect(secondHeader.inert).toBe(true);
      expect(rows.style.clipPath).toBe('');
      if (!collapsed) expect(rows.inert).toBe(true);
      expect(
        workspaceFlow?.style.getPropertyValue(
          '--sidebar-workspaces-clip-start',
        ),
      ).toBe('120px');
      expect(
        workspaceFlow?.style.getPropertyValue(
          '--sidebar-workspaces-clip-distance',
        ),
      ).toBe('680px');
      expect(slotRect).toHaveBeenCalledTimes(6);

      // Reverse into the handoff, then leave it entirely. Both projected
      // transforms and the incoming original's inert state must be cleared.
      assertSlotState(234, 'alpha');
      viewport.scrollTop = 0;
      act(() => {
        viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      expect(slot.hidden).toBe(true);
      expect(slot.dataset.activeWorkspaceId).toBeUndefined();
      expect(header.inert).toBe(false);
      if (!collapsed) expect(rows.inert).toBe(false);
      expect(secondHeader.inert).toBe(false);
      expect(secondRows.inert).toBe(false);
      expect(alphaSlot.style.transform).toBe('');
      expect(betaSlot.style.transform).toBe('');
      expect(
        workspaceFlow.hasAttribute('data-sidebar-workspace-sticky-active'),
      ).toBe(false);
    } finally {
      frames.restore();
      unmount();
    }
  });

  it('keeps adjacent copies in natural flow while the controls approach sticky', async () => {
    const frames = installManualAnimationFrames();
    const { container, unmount } = await renderSidebar().catch(
      (error: unknown) => {
        frames.restore();
        throw error;
      },
    );
    try {
      const get = (selector: string): HTMLElement => {
        const node = container.querySelector<HTMLElement>(selector);
        if (!node) throw new Error(`Missing ${selector}`);
        return node;
      };
      const viewport = get('[data-testid="sidebar-scroll-container"]');
      const sentinel = get('[data-testid="sidebar-sticky-workspace-sentinel"]');
      const header = get('[data-testid="stub-workspace-header"]');
      const next = get('[data-testid="stub-second-workspace-header"]');
      const alpha = get('[data-sidebar-sticky-slot-workspace-id="alpha"]');
      const beta = get('[data-sidebar-sticky-slot-workspace-id="beta"]');
      for (const [node, top] of [
        [sentinel, 120],
        [header, 170],
        [next, 202],
      ] as const) {
        Object.defineProperty(node, 'offsetTop', {
          configurable: true,
          value: top,
        });
      }
      Object.defineProperty(header, 'offsetHeight', {
        configurable: true,
        value: 32,
      });
      Object.defineProperty(viewport, 'scrollTop', {
        configurable: true,
        value: 90,
        writable: true,
      });
      await act(async () => {
        get('[data-testid="stub-workspace-rows"]').remove();
        await Promise.resolve();
      });
      await frames.flushFrames();
      viewport.style.setProperty('--sidebar-workspace-header-top', '50px');
      for (const scrollTop of [100, 110, 120, 128, 110]) {
        viewport.scrollTop = scrollTop;
        act(() => {
          viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        expect(beta.hidden).toBe(false);
        const distance = 32 - Math.max(0, scrollTop - 120);
        expect(beta.style.transform).toBe(`translateY(${distance}px)`);
        expect(alpha.style.transform).toBe(
          `translateY(${Math.min(0, distance - 32)}px)`,
        );
      }
    } finally {
      frames.restore();
      unmount();
    }
  });

  it.each([false, true])('pins at rest (collapsed: %s)', async (collapsed) => {
    const frames = installManualAnimationFrames();
    const { container, unmount } = await renderSidebar().catch(
      (error: unknown) => {
        frames.restore();
        throw error;
      },
    );
    try {
      const viewport = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-scroll-container"]',
      );
      const sentinel = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-sticky-workspace-sentinel"]',
      );
      const header = container.querySelector<HTMLElement>(
        '[data-testid="stub-workspace-header"]',
      );
      const rows = container.querySelector<HTMLElement>(
        '[data-testid="stub-workspace-rows"]',
      );
      const slot = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-sticky-workspace-slot"]',
      );
      const alphaSlot = container.querySelector<HTMLElement>(
        '[data-sidebar-sticky-slot-workspace-id="alpha"]',
      );
      if (!viewport || !sentinel || !header || !rows || !slot || !alphaSlot) {
        throw new Error('Expected sticky viewport and project stub elements');
      }

      // Every nav item lives in More: the sentinel (threshold) sits above the
      // 40px clip band, so the always-on scroll-driven clip already bites the
      // first workspace header at scrollTop 0.
      Object.defineProperty(sentinel, 'offsetTop', {
        configurable: true,
        value: 20,
      });
      Object.defineProperty(header, 'offsetTop', {
        configurable: true,
        value: 24,
      });
      Object.defineProperty(header, 'offsetHeight', {
        configurable: true,
        value: 32,
      });
      Object.defineProperty(rows, 'offsetTop', {
        configurable: true,
        value: 56,
      });
      Object.defineProperty(viewport, 'scrollTop', {
        configurable: true,
        value: 0,
        writable: true,
      });
      Object.defineProperty(viewport, 'scrollHeight', {
        configurable: true,
        value: 600,
      });
      Object.defineProperty(viewport, 'clientHeight', {
        configurable: true,
        value: 200,
      });

      if (collapsed) {
        // The collapse must land before the queued host layout pass runs.
        await act(async () => {
          rows.remove();
          await Promise.resolve();
        });
      }
      await frames.flushFrames();

      const workspaceFlow = container.querySelector<HTMLElement>(
        '.sidebar-workspaces-rows-clip',
      );
      // The clip geometry is published with the sub-band threshold…
      expect(
        workspaceFlow?.style.getPropertyValue(
          '--sidebar-workspaces-clip-start',
        ),
      ).toBe('20px');
      expect(
        workspaceFlow?.style.getPropertyValue(
          '--sidebar-workspaces-clip-distance',
        ),
      ).toBe('380px');
      // …and the pinned slot stands in from rest, covering the in-flow header
      // the clip is already eating (the copies are pixel-coincident at rest).
      expect(slot.hidden).toBe(false);
      expect(slot.dataset.activeWorkspaceId).toBe('alpha');
      expect(alphaSlot.hidden).toBe(false);
      expect(header.inert).toBe(true);
      expect(header.getAttribute('data-sidebar-sticky-flow-hidden')).toBe(
        'true',
      );
    } finally {
      frames.restore();
      unmount();
    }
  });

  it('keeps flow headers painted when no slot row can stand in', async () => {
    const { container, unmount } = await renderSidebar();
    try {
      const viewport = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-scroll-container"]',
      );
      const sentinel = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-sticky-workspace-sentinel"]',
      );
      const header = container.querySelector<HTMLElement>(
        '[data-testid="stub-workspace-header"]',
      );
      const rows = container.querySelector<HTMLElement>(
        '[data-testid="stub-workspace-rows"]',
      );
      const slot = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-sticky-workspace-slot"]',
      );
      if (!viewport || !sentinel || !header || !rows || !slot) {
        throw new Error('Expected sticky viewport and project stub elements');
      }
      await act(async () => {
        await waitForSidebarLayout();
      });
      // Surfaces like the shared-sidebar host render the sticky controls
      // without any slot rows: there is no replacement copy to pin, so the
      // in-flow header must never be hidden.
      for (const row of Array.from(
        slot.querySelectorAll('[data-sidebar-sticky-slot-workspace-id]'),
      )) {
        row.remove();
      }
      await act(async () => {
        await Promise.resolve();
        await waitForSidebarLayout();
      });
      Object.defineProperty(sentinel, 'offsetTop', {
        configurable: true,
        value: 120,
      });
      Object.defineProperty(header, 'offsetTop', {
        configurable: true,
        value: 124,
      });
      Object.defineProperty(rows, 'offsetTop', {
        configurable: true,
        value: 156,
      });
      Object.defineProperty(viewport, 'scrollTop', {
        configurable: true,
        value: 300,
        writable: true,
      });
      Object.defineProperty(viewport, 'scrollHeight', {
        configurable: true,
        value: 1000,
      });
      Object.defineProperty(viewport, 'clientHeight', {
        configurable: true,
        value: 200,
      });
      act(() => {
        viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      expect(slot.hidden).toBe(true);
      expect(header.inert).not.toBe(true);
      expect(header.hasAttribute('data-sidebar-sticky-flow-hidden')).toBe(
        false,
      );
      expect(header.hasAttribute('aria-hidden')).toBe(false);
    } finally {
      unmount();
    }
  });

  it('preserves subpixel precision in the project header sticky offset', async () => {
    const frames = installManualAnimationFrames();
    const { container, unmount } = await renderSidebar().catch(
      (error: unknown) => {
        frames.restore();
        throw error;
      },
    );
    try {
      const viewport = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-scroll-container"]',
      );
      const stickyContainer = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-more-sticky-container"]',
      );
      if (!viewport || !stickyContainer) {
        throw new Error('Expected sticky viewport and controls');
      }

      jest
        .spyOn(stickyContainer, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 0, 100, 38.5));
      await frames.flushFrames();

      expect(
        viewport.style.getPropertyValue('--sidebar-workspace-header-top'),
      ).toBe('39.5px');
    } finally {
      frames.restore();
      unmount();
    }
  });

  it('reads all at-rest rail geometry before writing any rail custom property', async () => {
    // A custom property written on the rail restyles every descendant that
    // inherits it, and the next layout read forces that restyle
    // synchronously. With dozens of worktrees each forced restyle costs tens
    // of milliseconds, so the at-rest pass must take every measurement first
    // and only then publish the vars: one restyle per frame, not one per
    // interleaved read. The log is split per animation frame because each
    // frame legitimately starts from a clean layout.
    const log: string[] = [];
    const setProperty = jest.spyOn(
      CSSStyleDeclaration.prototype,
      'setProperty',
    );
    let checkedWrites = 0;
    const railWritesSinceCheck = (): string[] => {
      const writes = setProperty.mock.calls
        .slice(checkedWrites)
        .map(([property]) => property)
        .filter((property) => property.startsWith('--sidebar-'));
      checkedWrites = setProperty.mock.calls.length;
      return writes;
    };
    const recordRead = (name: string): void => {
      const writes = railWritesSinceCheck();
      if (writes.length > 0) {
        log.push(`read-after-write:${name}:${writes.join(',')}`);
      }
    };
    const spies: jest.SpyInstance[] = [setProperty];
    const watchElementGetter = (
      property: 'scrollHeight' | 'clientHeight' | 'scrollTop',
    ): void => {
      spies.push(
        jest
          .spyOn(Element.prototype, property, 'get')
          .mockImplementation((): number => {
            recordRead(property);
            return 0;
          }),
      );
    };
    const watchHtmlGetter = (
      property: 'offsetHeight' | 'offsetTop',
      value: (element: HTMLElement) => number,
    ): void => {
      spies.push(
        jest
          .spyOn(HTMLElement.prototype, property, 'get')
          .mockImplementation(function (this: HTMLElement): number {
            recordRead(property);
            return value(this);
          }),
      );
    };
    watchHtmlGetter('offsetHeight', () => 0);
    watchHtmlGetter('offsetTop', (element) =>
      element.dataset.testid === 'sidebar-sticky-workspace-sentinel' ? 120 : 0,
    );
    watchElementGetter('scrollHeight');
    watchElementGetter('clientHeight');
    watchElementGetter('scrollTop');
    spies.push(
      jest
        .spyOn(Element.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: Element): DOMRect {
          recordRead('getBoundingClientRect');
          return this.matches('[data-testid="sidebar-more-sticky-container"]')
            ? new DOMRect(0, 0, 100, 40)
            : new DOMRect();
        }),
    );
    // Frames run on timers so each one can start from a clean layout.
    spies.push(
      jest
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation((callback: FrameRequestCallback): number =>
          window.setTimeout(() => {
            // Every frame starts with style and layout already clean.
            railWritesSinceCheck();
            log.push('frame');
            callback(performance.now());
          }, 16),
        ),
      jest
        .spyOn(window, 'cancelAnimationFrame')
        .mockImplementation((handle: number): void => {
          window.clearTimeout(handle);
        }),
    );
    const { container, unmount } = await renderSidebar();
    try {
      await act(async () => {
        await waitForSidebarLayout();
        await waitForSidebarLayout();
      });
      const viewport = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-scroll-container"]',
      );
      // The pass ran and published values the vars did not hold before, so
      // every write below really invalidated style.
      expect(viewport?.style.getPropertyValue('--sidebar-more-height')).toBe(
        '0px',
      );
      expect(
        viewport?.style.getPropertyValue('--sidebar-chats-header-height'),
      ).toBe('0px');
      expect(
        viewport?.style.getPropertyValue('--sidebar-workspace-header-top'),
      ).toBe('41px');
      expect(
        container
          .querySelector<HTMLElement>('[data-sidebar-workspaces-rows]')
          ?.style.getPropertyValue('--sidebar-workspaces-clip-start'),
      ).toBe('120px');
      expect(log).toContain('frame');
      expect(log.filter((entry) => entry !== 'frame')).toEqual([]);
    } finally {
      unmount();
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('measures the sticky stack before publishing any of its geometry', async () => {
    const frames = installManualAnimationFrames();
    const { container, unmount } = await renderSidebar().catch(
      (error: unknown) => {
        frames.restore();
        throw error;
      },
    );
    const events: string[] = [];
    let pass = 0;
    const offsetHeight = jest
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement): number {
        events.push('read');
        if (this.hasAttribute('data-sidebar-more-lead')) return 32 + pass;
        if (this.hasAttribute('data-sidebar-workspaces-rows'))
          return 400 + pass;
        return 0;
      });
    const rect = jest
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element): DOMRect {
        events.push('read');
        return new DOMRect(0, 0, 100, 40 + pass);
      });
    const { setProperty } = Object.getOwnPropertyDescriptors(
      CSSStyleDeclaration.prototype,
    );
    const setPropertyValue = setProperty.value;
    if (typeof setPropertyValue !== 'function') {
      throw new Error('Expected CSSStyleDeclaration.setProperty');
    }
    const write = jest
      .spyOn(CSSStyleDeclaration.prototype, 'setProperty')
      .mockImplementation(function (
        this: CSSStyleDeclaration,
        name: string,
        value: string | null,
        priority?: string,
      ): void {
        if (name.startsWith('--sidebar-')) events.push(`write:${name}`);
        Reflect.apply(setPropertyValue, this, [name, value, priority]);
      });
    try {
      const stickyContainer = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-more-sticky-container"]',
      );
      if (!stickyContainer) throw new Error('Expected sticky controls');
      pass = 1;
      events.length = 0;
      await frames.flushFrames();

      // Every write is an inherited custom property on the scroll viewport,
      // so it restyles the whole rail. A measurement taken after it forces
      // that restyle synchronously, once per write.
      // The rows' clip geometry is measured in the same read phase as the
      // stack, since the offsets published for the stack do not move rows.
      const headerTop = events.indexOf('write:--sidebar-workspace-header-top');
      const clip = events.indexOf(
        'write:--sidebar-workspaces-bottom-clip-start',
      );
      const firstWrite = events.findIndex((event) =>
        event.startsWith('write:'),
      );
      expect(headerTop).toBeGreaterThan(-1);
      expect(clip).toBeGreaterThan(headerTop);
      expect(events.slice(firstWrite, clip + 1)).not.toContain('read');
    } finally {
      offsetHeight.mockRestore();
      rect.mockRestore();
      write.mockRestore();
      frames.restore();
      unmount();
    }
  });

  it('uses 16px alignment wrappers for primary navigation icons', async () => {
    const { container, unmount } = await renderSidebar();
    try {
      const buttons = container.querySelectorAll(
        '[data-testid="sidebar-create-task"], [data-testid="sidebar-search"], [data-testid^="sidebar-nav-"], [data-testid="sidebar-more"]',
      );

      expect(buttons.length).toBeGreaterThan(0);
      buttons.forEach((button) => {
        expect(button.classList.contains('h-8')).toBe(true);
        expect(button.classList.contains('rounded-row')).toBe(true);
        const iconWrapper = button.firstElementChild;
        expect(iconWrapper?.classList.contains('h-4')).toBe(true);
        expect(iconWrapper?.classList.contains('w-4')).toBe(true);
        expect(iconWrapper?.classList.contains('fg-secondary')).toBe(true);
        expect(iconWrapper?.classList.contains('h-5')).toBe(false);
        expect(iconWrapper?.classList.contains('w-5')).toBe(false);
      });
    } finally {
      unmount();
    }
  });

  it('uses the standard idle and selected navigation states for New task', async () => {
    const idleRender = await renderSidebar({ activePage: 'main' });
    try {
      const idle = idleRender.container.querySelector(
        '[data-testid="sidebar-create-task"]',
      );
      expect(idle?.className).toContain('fg-primary');
      expect(idle?.className).not.toContain('fg-primary/80');
      expect(idle?.className).toContain('hover:bg-subtle');
      expect(idle?.className).not.toContain('fg-accent');
      expect(idle?.getAttribute('aria-current')).toBeNull();
      expect(idle?.textContent).toContain('New task');
    } finally {
      idleRender.unmount();
    }

    const selectedRender = await renderSidebar({ activePage: 'home' });
    try {
      const selected = selectedRender.container.querySelector(
        '[data-testid="sidebar-create-task"]',
      );
      expect(selected?.className).toContain('bg-muted');
      expect(selected?.className).toContain('fg-primary');
      expect(selected?.getAttribute('aria-current')).toBe('page');
    } finally {
      selectedRender.unmount();
    }
  });

  it('keeps a literal 12px gap inside the sticky controls group', async () => {
    const { container, unmount } = await renderSidebar();
    try {
      const gap = container.querySelector(
        '[data-testid="sidebar-more-workspaces-gap"]',
      );
      expect(gap?.className).toContain('h-3');
      expect(gap?.parentElement?.getAttribute('data-testid')).toBe(
        'sidebar-more-sticky-container',
      );
    } finally {
      unmount();
    }
  });

  it('renders an item in main nav when the layout places it before the divider', async () => {
    useSidebarStore.getState().hydrateFromPreferences(
      makePreferences({
        sidebarNavLayout: {
          order: [
            'app-advisor',
            'automations',
            'plugins',
            'pipelines',
            'overview',
            'kanban',
            'environments',
            'agents',
            'statistics',
            'remote-control',
          ],
          moreStartIndex: 5, // overview promoted to main nav
        },
      }),
    );
    publishPageExperimentsOn();
    const { container, unmount } = await renderSidebar();
    try {
      expect(
        container.querySelector('[data-testid="sidebar-nav-overview"]'),
      ).not.toBeNull();
      expect(
        document.body.querySelector(
          '[data-testid="sidebar-more-item-overview"]',
        ),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  it.each([true, false])(
    'renders no Remote Control nav row or More item (flag %s)',
    async (canopyPortalEnabled) => {
      seedMoreMenu();
      publishPageExperimentsOn();
      const { container, unmount } = await renderSidebar({
        canopyPortalEnabled,
      });
      try {
        // CAN-3659: desktop reports Remote Control on the account row and opens
        // it from the account menu, so neither nav region lists it.
        expect(
          container.querySelector('[data-testid="sidebar-nav-remote-control"]'),
        ).toBeNull();

        act(() => {
          container
            .querySelector<HTMLButtonElement>('[data-testid="sidebar-more"]')
            ?.click();
        });

        expect(
          document.body.querySelector(
            '[data-testid="sidebar-more-item-remote-control"]',
          ),
        ).toBeNull();
        // The Labs pages sit in main nav (CAN-3678); Environments is in Settings.
        for (const key of ['overview', 'kanban', 'statistics']) {
          expect(
            container.querySelector(`[data-testid="sidebar-nav-${key}"]`),
          ).not.toBeNull();
        }
        expect(
          document.body.querySelector(
            '[data-testid="sidebar-more-item-environments"]',
          ),
        ).toBeNull();
        expect(
          container.querySelector('[data-testid="sidebar-nav-agents"]'),
        ).toBeNull();
      } finally {
        unmount();
      }
    },
  );

  it('closes the portaled More menu when Settings opens', async () => {
    seedMoreMenu();
    const { container, root, unmount } = await renderSidebar();
    try {
      act(() => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="sidebar-more"]')
          ?.click();
      });
      expect(
        document.body.querySelector('[data-testid="sidebar-more-menu"]'),
      ).not.toBeNull();

      await act(async () => {
        root.render(
          <CanopyClientProvider client={createFakeClient().client}>
            <AppSidebar {...BASE_PROPS} settingsOpen />
          </CanopyClientProvider>,
        );
        await Promise.resolve();
      });

      expect(
        document.body.querySelector('[data-testid="sidebar-more-menu"]'),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  it('renders no retired Agents row from a stored layout that still lists it', async () => {
    useSidebarStore.getState().hydrateFromPreferences(
      makePreferences({
        sidebarNavLayout: {
          order: ['agents', 'app-advisor', 'automations', 'plugins'],
          moreStartIndex: 4,
        },
      }),
    );
    publishPageExperimentsOn();
    const { container, unmount } = await renderSidebar();
    try {
      expect(
        container.querySelector('[data-testid="sidebar-nav-agents"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="sidebar-nav-plugins"]'),
      ).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it('keeps App Advisor and Workflows in the Sidebar whether early access is on or off', async () => {
    setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    const { container, unmount } = await renderSidebar(
      { canopyPortalEnabled: true },
      makePreferences(),
    );
    const keys = ['app-advisor', 'workflows'];
    try {
      for (const enabled of [true, false, true]) {
        act(() => {
          setTestEarlyAccessFeatures({ enabled, hydrated: true });
        });
        for (const key of keys) {
          expect(
            container.querySelectorAll(`[data-testid="sidebar-nav-${key}"]`),
          ).toHaveLength(1);
        }
        act(() => {
          container
            .querySelector<HTMLButtonElement>('[data-testid="sidebar-more"]')
            ?.click();
        });
        for (const key of keys) {
          expect(
            document.body.querySelector(
              `[data-testid="sidebar-more-item-${key}"]`,
            ),
          ).toBeNull();
        }
        act(() => {
          container
            .querySelector<HTMLButtonElement>('[data-testid="sidebar-more"]')
            ?.click();
        });
      }
    } finally {
      unmount();
    }
  });

  it('keeps App Advisor in its saved More order through an early access toggle', async () => {
    publishPageExperimentsOn();
    useSidebarStore.getState().hydrateFromPreferences(
      makePreferences({
        sidebarNavLayout: {
          order: [
            'workflows',
            'plugins',
            'overview',
            'remote-control',
            'kanban',
            'app-advisor',
          ],
          moreStartIndex: 2,
        },
      }),
    );
    const { container, unmount } = await renderSidebar({
      canopyPortalEnabled: true,
    });
    const moreKeys = (): string[] =>
      Array.from(
        document.body.querySelectorAll('[data-testid^="sidebar-more-item-"]'),
        (item) =>
          item.getAttribute('data-testid')?.replace('sidebar-more-item-', '') ??
          '',
      ).filter((key) =>
        ['overview', 'remote-control', 'kanban', 'app-advisor'].includes(key),
      );
    try {
      for (const enabled of [false, true, false]) {
        act(() => {
          setTestEarlyAccessFeatures({ enabled, hydrated: true });
        });
        expect(
          container.querySelector('[data-testid="sidebar-nav-app-advisor"]'),
        ).toBeNull();
        act(() => {
          container
            .querySelector<HTMLButtonElement>('[data-testid="sidebar-more"]')
            ?.click();
        });
        // The stored Remote Control entry stays hidden (CAN-3659).
        expect(moreKeys()).toEqual(['overview', 'kanban', 'app-advisor']);
        act(() => {
          container
            .querySelector<HTMLButtonElement>('[data-testid="sidebar-more"]')
            ?.click();
        });
      }
    } finally {
      unmount();
    }
  });

  // Free access is an entitlement read inside the switcher and the account
  // menu; the mount point does not depend on it.
  it.each([
    ['normal', false],
    ['early access', true],
  ] as const)(
    'mounts the context switcher at the top, before New task, in %s (CAN-4053)',
    async (_mode, earlyAccess) => {
      setTestEarlyAccessFeatures({
        enabled: earlyAccess,
        hydrated: true,
      });
      const { container, unmount } = await renderSidebar({}, makePreferences());
      try {
        const switchers = container.querySelectorAll(
          '[data-testid="desktop-context-switcher-stub"]',
        );
        expect(switchers).toHaveLength(1);
        const switcher = switchers[0];
        const fixedNavigation = container.querySelector(
          '[data-testid="sidebar-fixed-navigation"]',
        );
        expect(fixedNavigation).not.toBeNull();
        // Directly before the fixed navigation, inside the no-drag column, so
        // the titlebar drag region never swallows its clicks.
        expect(switcher?.nextElementSibling).toBe(fixedNavigation);
        expect(
          switcher?.parentElement?.classList.contains('electron-no-drag'),
        ).toBe(true);
        expect(
          container
            .querySelector('[data-testid="sidebar-footer-items"]')
            ?.querySelector('[data-testid="desktop-context-switcher-stub"]'),
        ).toBeNull();
      } finally {
        unmount();
      }
    },
  );

  it('hides a sidebar entry owned by an experiment that is off, live', async () => {
    seedMoreMenu();
    // Gate the stored More item to exercise live menu visibility.
    const fixture = {
      id: 'plugins-fixture',
      pages: ['plugins' as const],
      sidebarKeys: ['plugins'],
    };
    applyLabsExperimentsSnapshot(
      makeTestLabsSnapshot({ earlyAccess: true, experiments: [fixture] }),
    );
    const { container, unmount } = await renderSidebar();
    try {
      // More remains available when its only destination is filtered out.
      expect(
        container.querySelector('[data-testid="sidebar-more"]'),
      ).not.toBeNull();

      act(() => {
        applyLabsExperimentsSnapshot(
          makeTestLabsSnapshot({
            earlyAccess: true,
            experiments: [{ ...fixture, choice: true }],
            revision: 2,
          }),
        );
      });
      act(() => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="sidebar-more"]')
          ?.click();
      });
      expect(
        document.body.querySelector(
          '[data-testid="sidebar-more-item-plugins"] [data-testid="sidebar-entry-marker-labs"]',
        ),
      ).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it('shows a Labs page row in main nav only while its experiment is on (CAN-3678)', async () => {
    const pagesOff = pageExperimentsOn().map((entry) => ({
      ...entry,
      choice: false,
    }));
    applyLabsExperimentsSnapshot(
      makeTestLabsSnapshot({ experiments: pagesOff }),
    );
    const { container, unmount } = await renderSidebar();
    const labsRows = (): string[] =>
      ['overview', 'kanban', 'statistics', 'audit'].filter(
        (key) =>
          container.querySelector(`[data-testid="sidebar-nav-${key}"]`) !==
          null,
      );
    try {
      expect(labsRows()).toEqual([]);

      act(() => {
        applyLabsExperimentsSnapshot(
          makeTestLabsSnapshot({
            experiments: pagesOff.map((entry) =>
              entry.id === 'kanban-page' ? { ...entry, choice: true } : entry,
            ),
            revision: 2,
          }),
        );
      });
      expect(labsRows()).toEqual(['kanban']);
    } finally {
      unmount();
    }
  });

  it('marks every Labs row with the Labs marker and no other row (CAN-3679)', async () => {
    publishPageExperimentsOn();
    const { container, unmount } = await renderSidebar({
      ledgerEnabled: true,
    });
    try {
      for (const key of ['overview', 'kanban', 'statistics', 'audit']) {
        const markers = container.querySelectorAll(
          `[data-testid="sidebar-nav-${key}"] [data-testid="sidebar-entry-marker-labs"]`,
        );
        expect(markers).toHaveLength(1);
        expect(markers[0]?.getAttribute('aria-label')).toBe('Labs');
      }
      for (const key of ['plugins', 'workflows', 'feed', 'app-advisor']) {
        const row = container.querySelector(
          `[data-testid="sidebar-nav-${key}"]`,
        );
        expect(row).not.toBeNull();
        expect(
          row?.querySelector('[data-testid^="sidebar-entry-marker-"]'),
        ).toBeNull();
      }
    } finally {
      unmount();
    }
  });

  it('drops the Labs marker from a key whose experiment leaves the registry, live (CAN-3679)', async () => {
    applyLabsExperimentsSnapshot(
      makeTestLabsSnapshot({
        experiments: pageExperimentsOn().filter(
          (entry) => entry.id !== 'kanban-page',
        ),
      }),
    );
    const { container, unmount } = await renderSidebar();
    const marker = (key: string): Element | null =>
      container.querySelector(
        `[data-testid="sidebar-nav-${key}"] [data-testid="sidebar-entry-marker-labs"]`,
      );
    try {
      // No owner, so not hidden and not marked.
      expect(
        container.querySelector('[data-testid="sidebar-nav-kanban"]'),
      ).not.toBeNull();
      expect(marker('kanban')).toBeNull();
      expect(marker('overview')).not.toBeNull();

      act(() => {
        applyLabsExperimentsSnapshot(
          makeTestLabsSnapshot({
            experiments: pageExperimentsOn(),
            revision: 2,
          }),
        );
      });
      expect(marker('kanban')).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it('marks Labs and dev entries in More and leaves the rest bare (CAN-3679)', async () => {
    window.localStorage.setItem(CHANGE_REVIEW_PAGE_STORAGE_KEY, '1');
    publishPageExperimentsOn();
    const order = [
      ...DEFAULT_SIDEBAR_NAV_LAYOUT.order.filter(
        (key) => key !== 'kanban' && key !== 'plugins',
      ),
      'kanban',
      'plugins',
    ];
    const preferences = makePreferences({
      sidebarNavLayout: { order, moreStartIndex: order.length - 2 },
    });
    useSidebarStore.getState().hydrateFromPreferences(preferences);
    const { container, unmount } = await renderSidebar({}, preferences, {
      isDev: true,
      branch: null,
    });
    try {
      act(() => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="sidebar-more"]')
          ?.click();
      });
      const markerIn = (id: string): Element | null | undefined =>
        document.body
          .querySelector(`[data-testid="${id}"]`)
          ?.querySelector('[data-testid^="sidebar-entry-marker-"]');
      expect(
        markerIn('sidebar-more-item-kanban')?.getAttribute('aria-label'),
      ).toBe('Labs');
      expect(
        markerIn('sidebar-more-item-dev-pages')?.getAttribute('aria-label'),
      ).toBe('Dev');
      expect(
        markerIn('sidebar-more-item-dev-pages')?.getAttribute('data-testid'),
      ).toBe('sidebar-entry-marker-dev');
      expect(markerIn('sidebar-more-item-plugins')).toBeNull();
      expect(markerIn('sidebar-more-item-customize')).toBeNull();
    } finally {
      unmount();
    }
  });

  it('keeps Usage out of More and navigates from Audit Trail', async () => {
    const onNavigate = jest.fn();
    publishPageExperimentsOn();
    const { container, unmount } = await renderSidebar({ onNavigate });
    try {
      act(() => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="sidebar-more"]')
          ?.click();
      });

      expect(
        document.body.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-more-item-usage"]',
        ),
      ).toBeNull();

      // Audit Trail is a main-nav row while its experiment is on (CAN-3678).
      const auditItem = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-nav-audit"]',
      );
      expect(auditItem).not.toBeNull();
      expect(auditItem?.textContent).toContain('Audit trail');

      act(() => {
        auditItem?.click();
      });
      expect(onNavigate).toHaveBeenCalledWith('audit');
    } finally {
      unmount();
    }
  });

  it('does not attach usage alerts to More', async () => {
    const { container, unmount } = await renderSidebar();
    try {
      act(() => {
        useObservabilityStore.setState({
          usage: {
            updatedAt: new Date(0).toISOString(),
            providers: [
              {
                provider: 'claude',
                authState: 'authenticated',
                hasRemainingLimits: true,
                rateLimits: [{ primary: { usedPercent: 85 } }],
              },
            ],
          },
        });
      });
      expect(
        container.querySelector('[data-testid="sidebar-more-alert-dot"]'),
      ).toBeNull();
      act(() => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="sidebar-more"]')
          ?.click();
      });
      expect(
        document.body.querySelector(
          '[data-testid="sidebar-more-usage-alert-dot"]',
        ),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  it('hides Claude Workers from the sidebar when not in terminal mode and no worker is active', async () => {
    const { container, unmount } = await renderSidebar({
      workersActive: false,
    });
    try {
      act(() => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="sidebar-more"]')
          ?.click();
      });
      expect(
        document.body.querySelector(
          '[data-testid="sidebar-more-item-workers"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="sidebar-nav-workers"]'),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  it('shows Claude Workers in main nav when a worker is active', async () => {
    const { container, unmount } = await renderSidebar({ workersActive: true });
    try {
      // Workers moved to main nav with the default layout (CAN-3678).
      const workersItem = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-nav-workers"]',
      );
      expect(workersItem).not.toBeNull();
      expect(workersItem?.textContent).toContain('Claude workers');
      // The active affordance carried over from the old account-menu item:
      // an "active" aria-label and the pulsing indicator dots.
      expect(workersItem?.getAttribute('aria-label')).toBe(
        'Claude workers: active',
      );
      expect(
        document.body.querySelector('[data-testid="sidebar-workers-active"]'),
      ).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it('shows Claude Workers in main nav when preferences enable terminal mode', async () => {
    const { container, unmount } = await renderSidebar(
      { workersActive: false },
      makePreferences({ canopyBackgroundProcessesMode: 'terminal' }),
    );
    try {
      expect(
        container.querySelector('[data-testid="sidebar-nav-workers"]'),
      ).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it('hides Claude Workers from the sidebar when the TUI workers flag is disabled', async () => {
    const { container, unmount } = await renderSidebar(
      {
        claudeTuiWorkersEnabled: false,
        workersActive: true,
      },
      makePreferences({ canopyBackgroundProcessesMode: 'terminal' }),
    );
    try {
      act(() => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="sidebar-more"]')
          ?.click();
      });
      expect(
        document.body.querySelector(
          '[data-testid="sidebar-more-item-workers"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="sidebar-nav-workers"]'),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  it('gives thinking priority over unread and open for the App Advisor button', async () => {
    const { container, unmount } = await renderSidebar({
      appAdvisorThinking: true,
      appAdvisorUnread: true,
      appAdvisorOpen: true,
    });
    try {
      const button = container.querySelector(
        '[data-testid="sidebar-nav-app-advisor"]',
      );
      // A background change means "selected" in the sidebar, so the status
      // rides on the leading glyph's ink; the open row keeps its selection.
      expect(button?.className).not.toContain('bg-info-subtle');
      expect(button?.className).toContain('bg-muted');
      const icon = button?.querySelector('span');
      expect(icon?.className).toContain('fg-info');
      expect(icon?.className).not.toContain('fg-secondary');
      expect(
        container.querySelector('[data-testid="sidebar-app-advisor-thinking"]'),
      ).not.toBeNull();
      expect(button?.getAttribute('aria-label')).toBe('Orchestrator: thinking');
    } finally {
      unmount();
    }
  });

  it('gives unread priority over open (without thinking) for the App Advisor button', async () => {
    const { container, unmount } = await renderSidebar({
      appAdvisorThinking: false,
      appAdvisorUnread: true,
      appAdvisorOpen: true,
    });
    try {
      const button = container.querySelector(
        '[data-testid="sidebar-nav-app-advisor"]',
      );
      expect(button?.className).not.toContain('bg-info-subtle');
      expect(button?.className).toContain('bg-muted');
      expect(button?.querySelector('span')?.className).toContain('fg-info');
      expect(button?.getAttribute('aria-label')).toBe('Orchestrator: unread');
    } finally {
      unmount();
    }
  });

  it('uses the selected surface when App Advisor is open without a status', async () => {
    const { container, unmount } = await renderSidebar({
      appAdvisorThinking: false,
      appAdvisorUnread: false,
      appAdvisorOpen: true,
    });
    try {
      const button = container.querySelector(
        '[data-testid="sidebar-nav-app-advisor"]',
      );
      expect(button?.className).toContain('bg-muted');
      expect(button?.className).toContain('fg-primary');
      expect(button?.getAttribute('aria-label')).toBe('Orchestrator');
      expect(button?.getAttribute('aria-pressed')).toBe('true');
    } finally {
      unmount();
    }
  });

  it.each(['workflows', 'workflows-schedule', 'workflows-library'] as const)(
    'selects the Workflows row on the %s page (CAN-3981)',
    async (activePage) => {
      const { container, unmount } = await renderSidebar({ activePage });
      try {
        expect(
          container.querySelector('[data-testid="sidebar-nav-workflows"]')
            ?.className,
        ).toContain('bg-muted');
      } finally {
        unmount();
      }
    },
  );

  it.each([
    // Workflows opens on Runs; on one of its tabs the row is the current one,
    // so a click returns it to its root instead (2026-10-22).
    ['overview', 'workflows', ['workflows'], []],
    ['workflows-schedule', 'workflows', [], ['workflows']],
    ['workflows-library', 'workflows', [], ['workflows']],
    ['overview', 'plugins', ['plugins'], []],
    ['plugins', 'plugins', [], ['plugins']],
  ] as const)(
    'on the %s page the %s row navigates to %j and returns to the root of %j',
    async (activePage, key, navigated, returned) => {
      const onNavigate = jest.fn();
      const onReturnToSectionRoot = jest.fn();
      const { container, unmount } = await renderSidebar({
        activePage,
        onNavigate,
        onReturnToSectionRoot,
      });
      try {
        act(() => {
          container
            .querySelector<HTMLElement>(`[data-testid="sidebar-nav-${key}"]`)
            ?.click();
        });
        expect(onNavigate.mock.calls).toEqual(navigated.map((page) => [page]));
        expect(onReturnToSectionRoot.mock.calls).toEqual(
          returned.map((page) => [page]),
        );
      } finally {
        unmount();
      }
    },
  );

  it('uses subtle hover and muted selected states for navigation items', async () => {
    const { container, unmount } = await renderSidebar({
      activePage: 'workflows',
    });
    try {
      const selected = container.querySelector(
        '[data-testid="sidebar-nav-workflows"]',
      );
      const idle = container.querySelector(
        '[data-testid="sidebar-nav-plugins"]',
      );
      expect(selected?.className).toContain('bg-muted');
      expect(selected?.className).toContain('fg-primary');
      expect(idle?.className).toContain('hover:bg-subtle');
      expect(idle?.className).not.toContain('hover:fg-primary');
    } finally {
      unmount();
    }
  });

  it('draws only the sidebar right-edge divider', async () => {
    const { container, unmount } = await renderSidebar();
    try {
      const sidebarMaterial = container.querySelector(
        '[data-testid="app-sidebar"] > .sidebar-resizable-clip > .app-sidebar-material',
      );
      const sidebarContent = sidebarMaterial?.querySelector(
        '.app-sidebar-content',
      );
      const sidebar = container.querySelector('[data-testid="app-sidebar"]');
      const resizeHandle = container.querySelector(
        '[data-testid="app-sidebar"] > .sidebar-resize-handle',
      );

      expect(sidebarMaterial?.className).toContain('border-r');
      expect(sidebarMaterial?.className).toContain('border-y-0');
      expect(sidebarMaterial?.className).toContain('border-l-0');
      expect(sidebarMaterial?.className).not.toMatch(/(?:^|\s)border(?:\s|$)/);
      expect(sidebarContent?.getAttribute('data-page-active')).toBe('true');
      expect(sidebar?.className).not.toContain('overflow-hidden');
      expect(sidebar?.className).toContain('select-none');
      expect(resizeHandle).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it('keeps the shell fixed while hiding only its content for Settings', async () => {
    const { container, unmount } = await renderSidebar({
      settingsOpen: true,
    });
    try {
      const sidebarMaterial = container.querySelector('.app-sidebar-material');
      const sidebarContent = sidebarMaterial?.querySelector(
        '.app-sidebar-content',
      );

      expect(sidebarMaterial).not.toBeNull();
      expect(sidebarMaterial?.className).not.toContain('app-sidebar-content');
      expect(sidebarContent?.getAttribute('data-page-active')).toBe('false');
    } finally {
      unmount();
    }
  });

  it('stays mounted at width 0 (aria-hidden + inert) when the sidebar store reports hidden', async () => {
    const { useSidebarStore } = await import('@/stores/sidebarStore');
    useSidebarStore.setState({ hidden: true });
    try {
      const { container, unmount } = await renderSidebar();
      try {
        const aside = container.querySelector<HTMLElement>(
          '[data-testid="app-sidebar"]',
        );
        // The aside no longer unmounts on hide — it switches to width 0
        // (aria-hidden + inert). The toggle stays stationary because it lives
        // in App.tsx's persistent titlebar corner, not here.
        expect(aside).not.toBeNull();
        expect(aside?.style.width).toBe('0px');
        expect(aside?.getAttribute('aria-hidden')).toBe('true');
        // The floor is a real length while hidden and animates with the
        // width: a floor applied at once on re-open would snap the sidebar
        // open while the page spacer is still closing.
        expect(Number.parseFloat(aside?.style.minWidth ?? '')).toBe(0);
        expect(aside?.className).toContain('transition-[width,min-width]');
        expect(aside?.className).toContain('sidebar-instant-interactions');
        expect(aside?.className).toContain('sidebar-layout-transition');

        // The dedicated inner clip preserves the collapse animation without
        // clipping the resize handle's outside hit target.
        const clip = aside?.querySelector<HTMLElement>(
          ':scope > .sidebar-resizable-clip',
        );
        expect(clip?.className).toContain('overflow-hidden');

        // The material wrapper keeps the expanded width (no content squish),
        // is inert (nothing tabbable inside the width-0 aside), and drops
        // pointer events plus every border while hidden.
        const inner = clip?.firstElementChild;
        expect(inner?.hasAttribute('inert')).toBe(true);
        expect(inner?.className).toContain('pointer-events-none');
        expect(inner?.className).toContain('border-0');
        expect(
          aside?.querySelector(':scope > .sidebar-resize-handle'),
        ).toBeNull();
      } finally {
        unmount();
      }
    } finally {
      useSidebarStore.setState({ hidden: false });
    }
  });

  it('reserves the persistent-corner width and never renders titlebar chrome inside the sidebar', async () => {
    const { container, unmount } = await renderSidebar();
    try {
      const aside = container.querySelector<HTMLElement>(
        '[data-testid="app-sidebar"]',
      );
      const titlebarRow = aside?.querySelector('.electron-drag');
      // The drag row's only child is a spacer sized to the persistent
      // titlebar corner: traffic-light reserve (kept physical under the
      // interface-scale zoom) plus three controls (toggle, back, forward)
      // and their surrounding gap, which zoom with the UI.
      // (installed by installWindowApi).
      const spacer = titlebarRow?.firstElementChild;
      expect(spacer?.getAttribute('style')).toContain(
        'width: calc(72px / var(--ui-zoom, 1) + 112px)',
      );
      expect(titlebarRow?.children).toHaveLength(1);

      // The toggle is NOT rendered inside the aside — it lives in App.tsx's
      // persistent titlebar corner (the app root's LAST child, so its
      // no-drag rect wins the -webkit-app-region paint-order accumulation
      // and the button stays clickable at constant window coordinates).
      expect(aside?.querySelector('[data-testid="sidebar-toggle"]')).toBeNull();
    } finally {
      unmount();
    }
  });

  it('keeps guest Activity beside Search instead of crowding titlebar history', async () => {
    window.localStorage.setItem(DESKTOP_SHARED_SIDEBAR_STORAGE_KEY, '1');
    const { container, unmount } = await renderSidebar(
      {},
      makePreferences({ showDiagnosticsPill: true, sidebarWidth: 220 }),
    );
    try {
      const search = container.querySelector('[data-testid="sidebar-search"]');
      const activity = container.querySelector(
        '[data-testid="sidebar-activity-toggle"]',
      );
      expect(activity).not.toBeNull();
      expect(search?.parentElement?.contains(activity)).toBe(true);
      expect(
        container
          .querySelector('[data-testid="sidebar-titlebar"]')
          ?.contains(activity),
      ).toBe(false);
      expect(
        container.querySelectorAll('[data-testid="sidebar-activity-toggle"]'),
      ).toHaveLength(1);
    } finally {
      unmount();
    }
  });

  it('keeps compact resource metrics mounted so their label can adapt to the available width', async () => {
    useResourceMonitorStore.setState({ initialized: true, loading: false });
    const { container, unmount } = await renderSidebar(
      {},
      makePreferences({ showDiagnosticsPill: true }),
    );
    try {
      const titlebar = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-titlebar"]',
      );
      const resourceHost = container.querySelector<HTMLElement>(
        '[data-testid="sidebar-titlebar-resource-monitor"]',
      );
      const resourcePill = resourceHost?.querySelector<HTMLElement>(
        '[data-testid="sidebar-resource-diagnostics-pill-stub"]',
      );

      expect(titlebar?.className).toContain('@container/sidebar-titlebar');
      // The row's vertical padding is no longer a static utility: it holds
      // the macOS traffic lights' physical centre line through `--ui-zoom`,
      // so it has to be an inline length (`sidebar-layout.ts`).
      expect(titlebar?.className).not.toContain('pt-1.5');
      expect(titlebar?.getAttribute('style')).toContain('--ui-zoom');
      expect(resourceHost?.className).toContain('ml-auto');
      expect(resourceHost?.className).toContain('flex');
      expect(resourceHost?.className).toContain('h-7');
      expect(resourceHost?.className).toContain('min-w-0');
      expect(resourceHost?.className).toContain('flex-1');
      expect(resourceHost?.className).toContain('items-center');
      expect(resourceHost?.className).toContain('justify-end');
      expect(resourceHost?.className).toContain(
        'sidebar-page-stationary-control',
      );
      expect(resourceHost?.className).not.toContain('translate-y-');
      expect(resourceHost?.className).not.toContain(
        '@min-[292px]/sidebar-titlebar:flex',
      );
      expect(resourceHost?.className).not.toContain(
        '@container/resource-monitor',
      );
      // The resource glyph and the Activity bell below share an 8px inset.
      expect(resourceHost?.className).toContain('pr-2');
      expect(resourceHost?.className).not.toContain('pr-2.25');
      expect(resourceHost?.className).not.toContain('pr-[19px]');
      expect(resourcePill?.dataset.compactLabel).toBe('true');
      expect(resourcePill?.dataset.statusBar).toBe('true');
      expect(
        container
          .querySelector('[data-testid="app-sidebar-bottom-status"]')
          ?.querySelector(
            '[data-testid="sidebar-resource-diagnostics-pill-stub"]',
          ),
      ).toBeNull();
    } finally {
      unmount();
    }
  });

  it('labels every nav row with its static registry label', async () => {
    const registryLabels = Object.values(getSidebarNavItemDefs()).map(
      (def) => def.label,
    );
    useSidebarStore.getState().hydrateFromPreferences(
      makePreferences({
        sidebarNavLayout: {
          order: [
            'app-advisor',
            'automations',
            'plugins',
            'pipelines',
            'overview',
            'kanban',
            'environments',
            'agents',
            'statistics',
            'remote-control',
            'audit',
            'workers',
          ],
          moreStartIndex: 12,
        },
      }),
    );
    publishPageExperimentsOn();
    const { container, unmount } = await renderSidebar({
      canopyPortalEnabled: true,
      claudeTuiWorkersEnabled: true,
    });
    try {
      const rows = Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-testid="sidebar-fixed-navigation"] [data-sidebar-nav-row], [data-testid="sidebar-scrolling-navigation"] [data-sidebar-nav-row]',
        ),
      );
      // The label without any trailing Labs or Dev marker (CAN-3679) or
      // shortcut glyph.
      const labelOf = (row: HTMLElement): string | null => {
        const copy = row.cloneNode(true);
        if (!(copy instanceof HTMLElement)) return row.textContent;
        copy
          .querySelectorAll(
            '[data-testid^="sidebar-entry-marker-"], [data-testid="sidebar-row-shortcut"]',
          )
          .forEach((marker) => marker.remove());
        return copy.textContent;
      };
      const labels = rows.map(labelOf);
      expect(labels).toEqual(
        expect.arrayContaining([
          'New task',
          'Search',
          'Orchestrator',
          'Workflows',
          'Audit trail',
        ]),
      );
      for (const row of rows) {
        expect([...registryLabels, 'New task', 'Search', 'More']).toContain(
          labelOf(row),
        );
      }
    } finally {
      unmount();
    }
  });
});

describe('resolveStickyWorkspaceRows', () => {
  function build(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
  }

  it("takes the native rail shape: rows as the header's next sibling", () => {
    const host = build(`
      <div data-sidebar-workspace-id="alpha">
        <div class="sidebar-workspace-sticky-header"></div>
        <div data-sidebar-section-content="" id="rows"></div>
      </div>`);
    const header = host.querySelector<HTMLElement>(
      '.sidebar-workspace-sticky-header',
    );
    const root = host.querySelector<HTMLElement>('[data-sidebar-workspace-id]');
    if (!header || !root) throw new Error('fixture');
    expect(resolveStickyWorkspaceRows(header, root)?.id).toBe('rows');
  });

  it('takes the shared rail shape: header wrapped in a row, content beside the wrapper', () => {
    const host = build(`
      <section data-sidebar-workspace-id="alpha">
        <div class="header-row">
          <div class="flex-1"><div class="sidebar-workspace-sticky-header"></div></div>
          <div class="actions"></div>
        </div>
        <div data-sidebar-section-content="" id="rows">
          <section data-sidebar-workspace-id="nested">
            <div data-sidebar-section-content="" id="nested-rows"></div>
          </section>
        </div>
      </section>`);
    const header = host.querySelector<HTMLElement>(
      '.sidebar-workspace-sticky-header',
    );
    const root = host.querySelector<HTMLElement>('[data-sidebar-workspace-id]');
    if (!header || !root) throw new Error('fixture');
    expect(resolveStickyWorkspaceRows(header, root)?.id).toBe('rows');
  });

  it('reads a collapsed workspace with no rows container as row-less', () => {
    const host = build(`
      <section data-sidebar-workspace-id="alpha">
        <div class="header-row"><div class="sidebar-workspace-sticky-header"></div></div>
      </section>`);
    const header = host.querySelector<HTMLElement>(
      '.sidebar-workspace-sticky-header',
    );
    const root = host.querySelector<HTMLElement>('[data-sidebar-workspace-id]');
    if (!header || !root) throw new Error('fixture');
    expect(resolveStickyWorkspaceRows(header, root)).toBeNull();
  });
});
