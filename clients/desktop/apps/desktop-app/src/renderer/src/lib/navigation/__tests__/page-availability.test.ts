/** @jest-environment jsdom */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  NAVIGATION_PAGE_MAP,
  type NavigationPage,
} from '@canopy/desktop-shared/types';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { CHANGE_REVIEW_PAGE_STORAGE_KEY } from '@/components/sidebar/change-review-page-flag';
import { HEADER_STATES_PAGE_STORAGE_KEY } from '@/components/sidebar/header-states-page-flag';
import { MESSAGE_BUBBLE_STATES_PAGE_STORAGE_KEY } from '@/components/sidebar/message-bubble-states-page-flag';
import { WORKTREE_STATES_PAGE_STORAGE_KEY } from '@/components/sidebar/worktree-states-page-flag';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  applyLabsExperimentsSnapshot,
  resetLabsExperimentsStoreForTest,
} from '@/stores/labsExperimentsStore';
import {
  makeTestLabsSnapshot,
  pageExperimentsOn,
  type TestLabsExperiment,
} from '@/test-utils/labsExperiments';
import {
  NAVIGATION_FALLBACK_PAGE,
  formatPageUnavailableMessage,
  getPageAvailability,
  isPageAvailable,
  listAvailablePages,
  resolveNavigationTarget,
  useAvailablePages,
  useIsPageAvailable,
  usePageAvailability,
} from '../page-availability';

const WORKERS_FLAG = CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key;
const LEDGER_FLAG = CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key;

/** Dev pages and the per-machine opt-in each needs on top of a dev build. */
const DEV_PAGES: readonly { page: NavigationPage; optInKey: string | null }[] =
  [
    { page: 'notice-states', optInKey: null },
    { page: 'activity-states', optInKey: null },
    { page: 'header-states', optInKey: HEADER_STATES_PAGE_STORAGE_KEY },
    { page: 'worktree-states', optInKey: WORKTREE_STATES_PAGE_STORAGE_KEY },
    {
      page: 'message-bubble-states',
      optInKey: MESSAGE_BUBBLE_STATES_PAGE_STORAGE_KEY,
    },
    { page: 'change-review', optInKey: CHANGE_REVIEW_PAGE_STORAGE_KEY },
  ];

const UNGATED_PAGES: readonly NavigationPage[] = [
  'main',
  'home',
  'chat',
  'pipelines',
  'workflows',
  'workflows-schedule',
  'workflows-library',
  'automations',
  'watchers',
  'plugins',
  'usage',
];

/** Pages owned by the registry's Labs page experiments (CAN-3678). */
const LABS_PAGES: readonly { page: NavigationPage; label: string }[] = [
  { page: 'overview', label: 'Overview' },
  { page: 'kanban', label: 'Kanban' },
  { page: 'statistics', label: 'Statistics' },
  { page: 'audit', label: 'Audit trail' },
];

/** Publishes a ready snapshot with every Labs page experiment on. */
function publishPagesOn(revision = 1): void {
  applyLabsExperimentsSnapshot(
    makeTestLabsSnapshot({ revision, experiments: pageExperimentsOn() }),
  );
}

/** Minimal hook harness: renders `useValue` and exposes its latest result. */
function renderHook<T>(useValue: () => T): {
  result: { current: T };
  unmount: () => void;
} {
  const captured: { value?: T } = {};
  function Probe(): null {
    captured.value = useValue();
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Probe));
  });
  return {
    result: {
      get current(): T {
        if (!('value' in captured) || captured.value === undefined) {
          throw new Error('hook has not rendered');
        }
        return captured.value;
      },
    },
    unmount: (): void => {
      act(() => {
        root.unmount();
      });
    },
  };
}

function setFlags(
  values: Record<string, boolean>,
  status: FeatureFlagSnapshot['status'] = 'ready',
): void {
  const base = getDefaultFeatureFlagSnapshot();
  useFeatureFlagsStore.getState().setSnapshot({
    ...base,
    values: { ...base.values, ...values },
    status,
    initialized: true,
  });
}

function setDevBuild(isDev: boolean): void {
  Object.defineProperty(window, 'devInfo', {
    configurable: true,
    value: { isDev },
  });
}

function setE2eBuild(enabled: boolean): void {
  Object.defineProperty(globalThis, '__CANOPY_E2E__', {
    configurable: true,
    writable: true,
    value: enabled,
  });
}

describe('page availability policy', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setDevBuild(false);
    setE2eBuild(false);
    setFlags({
      [WORKERS_FLAG]: true,
      [LEDGER_FLAG]: true,
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    Reflect.deleteProperty(window, 'devInfo');
    setE2eBuild(false);
    resetLabsExperimentsStoreForTest();
    useFeatureFlagsStore
      .getState()
      .setSnapshot(getDefaultFeatureFlagSnapshot());
  });

  it('falls back to New task', () => {
    expect(NAVIGATION_FALLBACK_PAGE).toBe('home');
  });

  describe('feature-flag pages', () => {
    it.each([
      { page: 'workers' as const, flag: WORKERS_FLAG, label: 'Claude workers' },
      { page: 'feed' as const, flag: LEDGER_FLAG, label: 'Feed' },
    ])('gates $page on its flag', ({ page, flag, label }) => {
      publishPagesOn();
      expect(getPageAvailability(page)).toEqual({ available: true, page });

      setFlags({
        [WORKERS_FLAG]: true,
        [LEDGER_FLAG]: true,
        [flag]: false,
      });

      expect(getPageAvailability(page)).toEqual({
        available: false,
        page,
        label,
        reason: 'feature-flag',
      });
      expect(isPageAvailable(page)).toBe(false);
      expect(resolveNavigationTarget(page)).toBe('home');
    });

    it.each(['not_configured', 'error'] as const)(
      'keeps each flag’s own default when the snapshot is %s and has no value',
      (status) => {
        const base = getDefaultFeatureFlagSnapshot();
        const values = { ...base.values };
        Reflect.deleteProperty(values, WORKERS_FLAG);
        Reflect.deleteProperty(values, LEDGER_FLAG);
        useFeatureFlagsStore
          .getState()
          .setSnapshot({ ...base, values, status, initialized: true });
        publishPagesOn();

        const isEnabled = useFeatureFlagsStore.getState().isEnabled;
        expect(isPageAvailable('workers')).toBe(isEnabled(WORKERS_FLAG));
        expect(isPageAvailable('feed')).toBe(isEnabled(LEDGER_FLAG));
      },
    );

    it('leaves Workers available on an unconfigured install', () => {
      useFeatureFlagsStore
        .getState()
        .setSnapshot(getDefaultFeatureFlagSnapshot());

      expect(getDefaultFeatureFlagSnapshot().status).toBe('not_configured');
      expect(isPageAvailable('workers')).toBe(
        useFeatureFlagsStore.getState().isEnabled(WORKERS_FLAG),
      );
    });
  });

  describe('dev pages', () => {
    it.each(DEV_PAGES)(
      'denies $page in a packaged build, even with its opt-in set',
      ({ page, optInKey }) => {
        if (optInKey) window.localStorage.setItem(optInKey, '1');

        const availability = getPageAvailability(page);

        expect(availability).toMatchObject({
          available: false,
          page,
          reason: 'dev-only',
        });
        expect(resolveNavigationTarget(page)).toBe('home');
      },
    );

    it.each(DEV_PAGES)(
      'follows the development opt-in for $page',
      ({ page, optInKey }) => {
        setDevBuild(true);

        // Pages without a per-machine opt-in are on in every dev build.
        expect(isPageAvailable(page)).toBe(optInKey === null);

        if (optInKey) {
          window.localStorage.setItem(optInKey, '1');
          expect(isPageAvailable(page)).toBe(true);
        }
      },
    );

    it.each(DEV_PAGES)('allows $page in an E2E build', ({ page }) => {
      setE2eBuild(true);

      expect(getPageAvailability(page)).toEqual({ available: true, page });
    });
  });

  it.each(UNGATED_PAGES)('always allows %s', (page) => {
    setFlags({
      [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: false,
      [WORKERS_FLAG]: false,
      [LEDGER_FLAG]: false,
    });

    expect(getPageAvailability(page)).toEqual({ available: true, page });
    expect(resolveNavigationTarget(page)).toBe(page);
  });

  describe('Labs page experiments (CAN-3678)', () => {
    it.each(LABS_PAGES)(
      'refuses $page before a ready snapshot',
      ({ page, label }) => {
        // No snapshot yet: refused without a flash of the page.
        expect(getPageAvailability(page)).toMatchObject({
          available: false,
          label,
          reason: 'experiment',
        });
        expect(resolveNavigationTarget(page)).toBe('home');
      },
    );

    it.each(LABS_PAGES)(
      'refuses $page while its experiment is off, even with Early access on',
      ({ page, label }) => {
        applyLabsExperimentsSnapshot(
          makeTestLabsSnapshot({
            earlyAccess: true,
            experiments: pageExperimentsOn().map((entry) => ({
              ...entry,
              choice: false,
            })),
          }),
        );
        expect(getPageAvailability(page)).toEqual({
          available: false,
          page,
          label,
          reason: 'experiment',
        });
      },
    );

    it.each(LABS_PAGES)(
      'allows $page once switched on with Early access off',
      ({ page }) => {
        applyLabsExperimentsSnapshot(
          makeTestLabsSnapshot({
            earlyAccess: false,
            experiments: pageExperimentsOn(),
          }),
        );
        expect(getPageAvailability(page)).toEqual({ available: true, page });
      },
    );

    it('lets a page flag win over a switched-on experiment owning the page', () => {
      setFlags({ [WORKERS_FLAG]: false });
      applyLabsExperimentsSnapshot(
        makeTestLabsSnapshot({
          earlyAccess: true,
          experiments: [
            ...pageExperimentsOn(),
            { id: 'workers-fixture', pages: ['workers'], choice: true },
          ],
        }),
      );

      expect(getPageAvailability('workers')).toMatchObject({
        available: false,
        reason: 'feature-flag',
      });
    });
  });

  it.each(['mcp-account-connections', 'environments'] as const)(
    'keeps the %s Settings alias navigable but unlisted',
    (page) => {
      expect(isPageAvailable(page)).toBe(true);
      expect(resolveNavigationTarget(page)).toBe(page);
      expect(listAvailablePages()).not.toContain(page);
    },
  );

  describe('listAvailablePages', () => {
    it('lists every page once, in the shared page order', () => {
      setDevBuild(true);
      for (const { optInKey } of DEV_PAGES) {
        if (optInKey) window.localStorage.setItem(optInKey, '1');
      }
      publishPagesOn();

      const pages = listAvailablePages();

      expect(pages).toEqual(
        Object.values(NAVIGATION_PAGE_MAP).filter(
          (page) =>
            page !== 'mcp-account-connections' && page !== 'environments',
        ),
      );
      expect(new Set(pages).size).toBe(pages.length);
    });

    it('omits exactly the pages that are switched off', () => {
      setFlags({
        [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: false,
        [WORKERS_FLAG]: true,
        [LEDGER_FLAG]: false,
      });

      expect(listAvailablePages()).toEqual(
        [...UNGATED_PAGES, 'workers'].sort(
          (a, b) =>
            Object.keys(NAVIGATION_PAGE_MAP).indexOf(a) -
            Object.keys(NAVIGATION_PAGE_MAP).indexOf(b),
        ),
      );
    });
  });

  describe('formatPageUnavailableMessage', () => {
    it('explains a feature-flag refusal without blaming the account', () => {
      expect(
        formatPageUnavailableMessage({
          label: 'Claude Workers',
          reason: 'feature-flag',
        }),
      ).toBe("The Claude Workers page isn't available right now.");
    });

    it('explains a dev-gate refusal without promising a dev build is enough', () => {
      expect(
        formatPageUnavailableMessage({
          label: 'Header states',
          reason: 'dev-only',
        }),
      ).toBe(
        "The Header states page isn't enabled in this build or development configuration.",
      );
    });

    it('points an experiment refusal at Settings', () => {
      expect(
        formatPageUnavailableMessage({
          label: 'Example',
          reason: 'experiment',
        }),
      ).toBe(
        'The Example page is switched off. Turn it on in Settings → Labs.',
      );
    });

    it('maps exactly the Labs pages to the experiment reason', () => {
      setFlags({ [WORKERS_FLAG]: false, [LEDGER_FLAG]: true });

      const experimentPages = Object.values(NAVIGATION_PAGE_MAP).filter(
        (page) => {
          const availability = getPageAvailability(page);
          return (
            !availability.available && availability.reason === 'experiment'
          );
        },
      );

      expect(experimentPages.sort()).toEqual(
        LABS_PAGES.map(({ page }) => page).sort(),
      );
    });
  });

  describe('experiment pages', () => {
    // Owns pages no registry entry owns, so the registry never interferes.
    const AUDIT: TestLabsExperiment = {
      id: 'usage-fixture',
      name: 'Usage log',
      pages: ['usage'],
      sidebarKeys: ['environments'],
    };
    let revision = 0;

    function publish(
      options: Parameters<typeof makeTestLabsSnapshot>[0] = {},
    ): void {
      revision += 1;
      applyLabsExperimentsSnapshot(
        makeTestLabsSnapshot({ revision, ...options }),
      );
    }

    it('refuses an owned page while Early access is off, even when rolled out on', () => {
      publish({
        earlyAccess: false,
        experiments: [{ ...AUDIT, availability: 'on' }],
      });
      expect(getPageAvailability('usage')).toEqual({
        available: false,
        page: 'usage',
        label: 'Usage log',
        reason: 'experiment',
      });
      expect(resolveNavigationTarget('usage')).toBe(NAVIGATION_FALLBACK_PAGE);
      expect(listAvailablePages()).not.toContain('usage');
    });

    it('allows an owned page only once the person opts in under offered', () => {
      publish({ earlyAccess: true, experiments: [AUDIT] });
      expect(isPageAvailable('usage')).toBe(false);

      publish({ earlyAccess: true, experiments: [{ ...AUDIT, choice: true }] });
      expect(isPageAvailable('usage')).toBe(true);
      expect(listAvailablePages()).toContain('usage');
    });

    it('fails closed while the snapshot is not ready', () => {
      publish({
        ready: false,
        earlyAccess: true,
        experiments: [{ ...AUDIT, choice: true }],
      });
      expect(getPageAvailability('usage')).toMatchObject({
        available: false,
        reason: 'experiment',
      });
    });

    it('reports the flag reason first when both gates refuse', () => {
      setFlags({ [WORKERS_FLAG]: false });
      publish({
        earlyAccess: false,
        experiments: [
          ...pageExperimentsOn().map((entry) => ({
            ...entry,
            choice: false,
          })),
          { id: 'workers-fixture', pages: ['workers'], choice: false },
        ],
      });
      expect(getPageAvailability('workers')).toMatchObject({
        reason: 'feature-flag',
      });
    });

    it('re-evaluates hooks on a Labs push, including a kill switch', () => {
      publish({ earlyAccess: true, experiments: [{ ...AUDIT, choice: true }] });
      const { result, unmount } = renderHook(() => ({
        available: useIsPageAvailable('usage'),
        pages: useAvailablePages(),
      }));
      expect(result.current.available).toBe(true);
      expect(result.current.pages).toContain('usage');

      act(() => {
        publish({
          earlyAccess: true,
          experiments: [{ ...AUDIT, choice: true, availability: 'hidden' }],
        });
      });
      expect(result.current.available).toBe(false);
      expect(result.current.pages).not.toContain('usage');

      act(() => {
        publish({
          earlyAccess: true,
          experiments: [{ ...AUDIT, choice: true }],
        });
      });
      expect(result.current.available).toBe(true);

      // Opting out of Early access removes the page too.
      act(() => {
        publish({
          earlyAccess: false,
          experiments: [{ ...AUDIT, choice: true }],
        });
      });
      expect(result.current.available).toBe(false);
      unmount();
    });
  });

  describe('hooks', () => {
    it('re-evaluates when a flag changes while mounted', () => {
      publishPagesOn();
      const { result, unmount } = renderHook(() => ({
        available: useIsPageAvailable('workers'),
        availability: usePageAvailability('workers'),
        pages: useAvailablePages(),
      }));
      expect(result.current.available).toBe(true);
      expect(result.current.pages).toContain('workers');

      act(() => {
        setFlags({ [WORKERS_FLAG]: false, [LEDGER_FLAG]: true });
      });

      expect(result.current.available).toBe(false);
      expect(result.current.availability).toMatchObject({
        available: false,
        reason: 'feature-flag',
      });
      expect(result.current.pages).not.toContain('workers');

      act(() => {
        setFlags({ [WORKERS_FLAG]: true, [LEDGER_FLAG]: true });
      });

      expect(result.current.available).toBe(true);
      expect(result.current.pages).toContain('workers');
      unmount();
    });

    it('returns stable results across unrelated flag snapshots', () => {
      const { result, unmount } = renderHook(() => ({
        availability: usePageAvailability('workers'),
        pages: useAvailablePages(),
      }));
      const before = result.current;

      act(() => {
        setFlags({
          [WORKERS_FLAG]: true,
          [LEDGER_FLAG]: true,
          [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: false,
        });
      });

      expect(result.current.availability).toBe(before.availability);
      expect(result.current.pages).toBe(before.pages);
      unmount();
    });
  });
});
