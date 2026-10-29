/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import { act } from 'react';
import type * as ReactNamespace from 'react';
import type * as BrowserStoreModule from '@/stores/browserStore';
import { createRoot, type Root } from 'react-dom/client';
import type { BrowserSessionSnapshot } from '@canopy/desktop-shared/types';
import { useBrowserStore } from '@/stores/browserStore';
import { useChatStore } from '@/stores/chatStore';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';
import { resetWarmBrowserWorktreesForTest } from '@/lib/browserWarmWorktrees';
import { getBrowserFindController } from '@/stores/browserFindController';
import { useSurfaceFindStore } from '@/stores/surfaceFindStore';
import { BrowserPanelSurface } from '../BrowserPanelSurface';
import { BrowserPane } from '../BrowserPane';

// Stub the heavy pane (native browser views) and capture the wired props;
// keep the real browser store + selectors but stub hydration so mounting
// never reaches window.api.
jest.mock('../BrowserPane', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    BrowserPane: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'mock-browser-pane' }),
    ),
  };
});
jest.mock('@/stores/browserEventSubscription', () => ({
  ensureBrowserEventSubscription: jest.fn(),
}));
jest.mock('@/stores/browserStore', () => {
  const actual = jest.requireActual<typeof BrowserStoreModule>(
    '@/stores/browserStore',
  );
  return {
    ...actual,
    ensureBrowserWorktreeHydrated: jest.fn(() => Promise.resolve()),
  };
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
const BROWSER_ID = 'browser-1';

function snapshot(
  overrides: Partial<BrowserSessionSnapshot> = {},
): BrowserSessionSnapshot {
  return {
    id: BROWSER_ID,
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    createdAt: 1,
    updatedAt: 2,
    url: 'http://localhost:3000/',
    title: 'Local',
    status: 'ready',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    themeMode: 'light',
    pickMode: false,
    recording: false,
    ...overrides,
  };
}

function seedBucket(
  overrides: Partial<BrowserStoreModule.WorktreeBrowserBucket> = {},
): void {
  useBrowserStore.setState({
    worktrees: {
      [KEY]: {
        browserOrder: [BROWSER_ID],
        activeBrowserId: BROWSER_ID,
        browsers: { [BROWSER_ID]: snapshot() },
        live: new Set<string>(),
        hydrated: true,
        ...overrides,
      },
    },
  });
}
const releaseWorktreeViews = jest.fn();

describe('BrowserPanelSurface', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    useBrowserStore.setState({ worktrees: {}, releaseWorktreeViews });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(visible = true): void {
    act(() => {
      root.render(
        <BrowserPanelSurface
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          browserId={BROWSER_ID}
          visible={visible}
        />,
      );
    });
  }

  it('titles the browser find scope from the page title and follows it', () => {
    seedBucket();
    render(true);
    const title = (): string | undefined =>
      useSurfaceFindStore.getState().controllers[`browser:${BROWSER_ID}`]
        ?.title;
    expect(title()).toBe('Local');

    act(() => {
      seedBucket({
        browsers: { [BROWSER_ID]: snapshot({ title: 'Docs' }) },
      });
    });
    expect(title()).toBe('Docs');

    // An untitled page falls back to its URL.
    act(() => {
      seedBucket({
        browsers: {
          [BROWSER_ID]: snapshot({ title: '', url: 'http://localhost:3000/x' }),
        },
      });
    });
    expect(title()).toBe('http://localhost:3000/x');
  });

  it('re-runs the browser find once per finished page load (CAN-3048)', () => {
    seedBucket();
    render(true);
    const handle = getBrowserFindController(BROWSER_ID);
    if (!handle) throw new Error('browser find controller not registered');
    const handlePageLoad = jest.spyOn(handle, 'handlePageLoad');
    const show = (url: string, loading: boolean): void => {
      act(() => {
        seedBucket({ browsers: { [BROWSER_ID]: snapshot({ url, loading }) } });
      });
    };

    // A same-document URL change (pushState, hash) keeps the active match.
    show('http://localhost:3000/#section', false);
    expect(handlePageLoad).not.toHaveBeenCalled();

    // A navigation commits its URL while the new document is still loading.
    show('http://localhost:3000/next', true);
    expect(handlePageLoad).not.toHaveBeenCalled();

    // Searching once loading stops reflects the loaded page.
    show('http://localhost:3000/next', false);
    expect(handlePageLoad).toHaveBeenCalledTimes(1);
  });

  it('renders ONE BrowserPane for exactly the bound id, with no inner chrome', () => {
    seedBucket();
    render(false);

    const panes = container.querySelectorAll(
      '[data-testid="mock-browser-pane"]',
    );
    expect(panes).toHaveLength(1);
    const props = jest.mocked(BrowserPane).mock.calls[0][0];
    expect(props.projectId).toBe(PROJECT_ID);
    expect(props.worktreeId).toBe(WORKTREE_ID);
    expect(props.browserId).toBe(BROWSER_ID);
    expect(props.visible).toBe(false);

    // No inner browser group/tab/add/split chrome remains reachable.
    expect(container.querySelector('[data-testid="browser-new"]')).toBeNull();
    expect(container.querySelector('[data-testid="browser-split"]')).toBeNull();
    expect(container.querySelector('[data-testid^="browser-tab-"]')).toBeNull();

    // The pane (whose first content element is the BrowserBar) is the FIRST
    // child of the surface — no nested tab strip, toolbar, or divider first.
    const surface = container.querySelector(
      '[data-testid="browser-panel-surface"]',
    );
    expect(surface?.firstElementChild?.getAttribute('data-testid')).toBe(
      'mock-browser-pane',
    );
  });

  it('shows accessible loading copy during initial hydration', () => {
    render();
    const loading = container.querySelector(
      '[data-testid="browser-panel-loading"]',
    );
    expect(loading).not.toBeNull();
    expect(loading?.getAttribute('aria-label')).toBe('Opening Browser…');
    expect(loading?.textContent).toContain('Opening Browser…');
    expect(
      container.querySelector('[data-testid="mock-browser-pane"]'),
    ).toBeNull();
  });

  it('renders the pane for a just-opened tab before hydration finishes', () => {
    seedBucket({ hydrated: false });
    render();

    expect(
      container.querySelector('[data-testid="mock-browser-pane"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="browser-panel-loading"]'),
    ).toBeNull();
  });

  it('shows the recoverable hydration-failure surface with exact copy and Retry', async () => {
    useBrowserStore.setState({
      worktrees: {
        [KEY]: {
          browserOrder: [],
          activeBrowserId: null,
          browsers: {},
          live: new Set<string>(),
          hydrated: false,
          hydrationError: 'corrupt state',
        },
      },
    });
    const retryHydration = jest.fn().mockResolvedValue(undefined);
    useBrowserStore.setState({ retryHydration });

    render();

    const error = container.querySelector(
      '[data-testid="browser-panel-hydration-error"]',
    );
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain('Unable to open Browser');
    expect(error?.textContent).toContain(
      'Browser state could not be restored.',
    );

    const retry = Array.from(error?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.includes('Retry'),
    );
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    // Retry re-runs hydration (which also completes any pending migration
    // recovery through the store's recovery handler).
    expect(retryHydration).toHaveBeenCalledWith(PROJECT_ID, WORKTREE_ID);
  });

  it('renders the stale placeholder when the bound id is missing after hydration', () => {
    seedBucket({ browserOrder: [], browsers: {} });
    render();
    expect(
      container.querySelector('[data-testid="browser-panel-stale"]')
        ?.textContent,
    ).toBe('Browser session is no longer available.');
    expect(
      container.querySelector('[data-testid="mock-browser-pane"]'),
    ).toBeNull();
  });

  it('keeps native worktree views warm without a Labs opt-in', () => {
    const releaseWorktreeViews = jest.fn();
    useBrowserStore.setState({ releaseWorktreeViews });
    render();

    act(() => {
      root.unmount();
    });

    expect(releaseWorktreeViews).not.toHaveBeenCalled();
  });
});

describe('BrowserPanelSurface warm worktree views (early access)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    resetWarmBrowserWorktreesForTest();
    resetExperimentalFeaturesStoreForTest();
    setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    useBrowserStore.setState({ worktrees: {}, releaseWorktreeViews });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    resetWarmBrowserWorktreesForTest();
    resetExperimentalFeaturesStoreForTest();
    useChatStore.setState({ selectedWorktree: null });
  });

  function showWorktree(worktreeId: string): void {
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId },
    });
    act(() => {
      root.render(
        <BrowserPanelSurface
          projectId={PROJECT_ID}
          worktreeId={worktreeId}
          browserId={BROWSER_ID}
          visible
        />,
      );
    });
  }

  it('keeps a left worktree live so switching back does not reload it', () => {
    showWorktree('worktree-a');
    showWorktree('worktree-b');
    showWorktree('worktree-a');

    expect(releaseWorktreeViews).not.toHaveBeenCalled();
  });

  it('releases the least recently left worktree beyond the warm limit', async () => {
    for (const worktreeId of ['wt-1', 'wt-2', 'wt-3', 'wt-4', 'wt-5']) {
      showWorktree(worktreeId);
    }
    await act(async () => {
      await Promise.resolve();
    });

    // wt-5 is shown; wt-1..wt-4 were left in order and only three stay warm.
    expect(releaseWorktreeViews).toHaveBeenCalledTimes(1);
    expect(releaseWorktreeViews).toHaveBeenCalledWith(PROJECT_ID, 'wt-1');
  });

  it('keeps the oldest warm worktree when returning to it', async () => {
    for (const worktreeId of ['wt-x', 'wt-y', 'wt-z', 'wt-a', 'wt-x']) {
      showWorktree(worktreeId);
    }
    await act(async () => {
      await Promise.resolve();
    });

    expect(releaseWorktreeViews).not.toHaveBeenCalledWith(PROJECT_ID, 'wt-x');
    showWorktree('wt-b');
    await act(async () => {
      await Promise.resolve();
    });
    expect(releaseWorktreeViews).toHaveBeenCalledWith(PROJECT_ID, 'wt-y');
  });

  it('keeps warm worktrees when the legacy preference changes', () => {
    showWorktree('worktree-a');
    showWorktree('worktree-b');
    expect(releaseWorktreeViews).not.toHaveBeenCalled();

    act(() => {
      setTestEarlyAccessFeatures({ enabled: false });
    });

    expect(releaseWorktreeViews).not.toHaveBeenCalled();
  });
});
