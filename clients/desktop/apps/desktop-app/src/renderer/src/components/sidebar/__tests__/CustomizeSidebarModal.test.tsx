/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_SIDEBAR_NAV_LAYOUT } from '@canopy/desktop-shared/lib/sidebar-nav-layout';
import type { CanopyApi } from '@canopy/desktop-shared/types';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { useIsPageAvailable } from '@/lib/navigation/page-availability';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  applyLabsExperimentsSnapshot,
  resetLabsExperimentsStoreForTest,
} from '@/stores/labsExperimentsStore';
import {
  makeTestLabsSnapshot,
  pageExperimentsOn,
} from '@/test-utils/labsExperiments';
import { useSidebarStore } from '@/stores/sidebarStore';
import { CustomizeSidebarModal } from '../CustomizeSidebarModal';

declare global {
  interface Window {
    api: CanopyApi;
  }
}

describe('CustomizeSidebarModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        savePreferences: jest.fn().mockResolvedValue(undefined),
      },
    });
    // Reset the shared store singleton to the default nav layout so each test
    // starts from the pre-customization arrangement.
    useSidebarStore.setState({
      sidebarNavLayout: {
        order: [
          'app-advisor',
          'workflows',
          'plugins',
          'overview',
          'kanban',
          'agents',
          'statistics',
          'remote-control',
        ],
        moreStartIndex: 3,
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetExperimentalFeaturesStoreForTest();
    useFeatureFlagsStore
      .getState()
      .setSnapshot(getDefaultFeatureFlagSnapshot());
    resetLabsExperimentsStoreForTest();
  });

  it.each([true, false])(
    'updates available rows without remounting (initially enabled: %s)',
    (initiallyEnabled) => {
      function setPageFlags(enabled: boolean): void {
        const snapshot = getDefaultFeatureFlagSnapshot('ready');
        useFeatureFlagsStore.getState().setSnapshot({
          ...snapshot,
          values: {
            ...snapshot.values,
            [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key]: enabled,
          },
        });
      }
      function Host(): React.JSX.Element {
        const workers = useIsPageAvailable('workers');
        return (
          <CustomizeSidebarModal onClose={() => {}} workersVisible={workers} />
        );
      }
      const layout = {
        ...DEFAULT_SIDEBAR_NAV_LAYOUT,
        order: [...DEFAULT_SIDEBAR_NAV_LAYOUT.order],
      };
      useSidebarStore.setState({ sidebarNavLayout: layout });
      // Keep the Labs page experiments (CAN-3678) on so only the feature flag
      // decides.
      applyLabsExperimentsSnapshot(
        makeTestLabsSnapshot({ experiments: pageExperimentsOn() }),
      );
      setPageFlags(initiallyEnabled);
      act(() => root.render(<Host />));
      const modal = document.querySelector(
        '[data-testid="customize-sidebar-modal"]',
      );
      const row = (key: string): Element | null =>
        document.querySelector(`[data-testid="customize-sidebar-row-${key}"]`);
      for (const enabled of [false, true, false, true]) {
        act(() => setPageFlags(enabled));
        expect(
          document.querySelector('[data-testid="customize-sidebar-modal"]'),
        ).toBe(modal);
        expect(row('workers') !== null).toBe(enabled);
        expect(row('overview')).not.toBeNull();
        expect(useSidebarStore.getState().sidebarNavLayout).toEqual(layout);
      }
      act(() => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="customize-sidebar-save"]',
          )
          ?.click();
      });
      expect(useSidebarStore.getState().sidebarNavLayout).toEqual(layout);
    },
  );

  it('renders a row per nav item, the More divider, and footer controls', () => {
    act(() => {
      root.render(<CustomizeSidebarModal onClose={() => {}} workersVisible />);
    });
    expect(
      document.querySelector(
        '[data-testid="customize-sidebar-row-app-advisor"]',
      ),
    ).not.toBeNull();
    // Desktop reports Remote Control on the account row (CAN-3659).
    expect(
      document.querySelector(
        '[data-testid="customize-sidebar-row-remote-control"]',
      ),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="customize-sidebar-more-divider"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="customize-sidebar-save"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="customize-sidebar-cancel"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="customize-sidebar-reset"]'),
    ).not.toBeNull();
  });

  it('groups the rows under Sidebar and More menu headings instead of a dashed row', () => {
    act(() => {
      root.render(<CustomizeSidebarModal onClose={() => {}} workersVisible />);
    });
    const sidebarHeading = document.querySelector(
      '[data-testid="customize-sidebar-group-sidebar"]',
    );
    const moreHeading = document.querySelector(
      '[data-testid="customize-sidebar-more-divider"]',
    );
    expect(sidebarHeading?.textContent).toBe('Sidebar');
    expect(moreHeading?.textContent).toBe('More menu');
    // No bracketing outline and no chevron: a heading marks the group.
    expect(moreHeading?.className).not.toContain('border-dashed');
    expect(moreHeading?.querySelector('svg')).toBeNull();
  });

  it('draws each row as a sidebar nav row with a drag handle always in view', () => {
    act(() => {
      root.render(<CustomizeSidebarModal onClose={() => {}} workersVisible />);
    });
    const row = document.querySelector<HTMLElement>(
      '[data-testid="customize-sidebar-row-workflows"]',
    );
    for (const shape of [
      'h-8',
      'rounded-row',
      'px-2',
      'gap-2',
      'hover:bg-subtle',
    ]) {
      expect(row?.classList.contains(shape)).toBe(true);
    }
    expect(row?.className).not.toContain('hover:bg-secondary');
    const handle = document.querySelector<HTMLElement>(
      '[data-testid="customize-sidebar-row-workflows-handle"]',
    );
    expect(handle).not.toBeNull();
    expect(handle?.closest('[class~="opacity-0"]')).toBeNull();
  });

  it('builds the footer from the shared buttons', () => {
    act(() => {
      root.render(<CustomizeSidebarModal onClose={() => {}} workersVisible />);
    });
    const save = document.querySelector<HTMLElement>(
      '[data-testid="customize-sidebar-save"]',
    );
    // The hand-rolled accent button hovered with an opacity hack.
    expect(save?.className).not.toContain('hover:bg-accent/90');
    expect(save?.className).toContain('bg-accent');
    for (const id of ['reset', 'cancel', 'save']) {
      expect(
        document.querySelector(`[data-testid="customize-sidebar-${id}"]`)
          ?.className,
      ).toContain('h-7');
    }
  });

  it('never lists remote-control (CAN-3659: it lives on the account row and menu)', () => {
    act(() => {
      root.render(<CustomizeSidebarModal onClose={() => {}} workersVisible />);
    });
    expect(
      document.querySelector(
        '[data-testid="customize-sidebar-row-remote-control"]',
      ),
    ).toBeNull();
    // Other rows still render.
    expect(
      document.querySelector(
        '[data-testid="customize-sidebar-row-app-advisor"]',
      ),
    ).not.toBeNull();
  });

  it('never lists the retired agents row from a stored layout that still has it', () => {
    act(() => {
      root.render(<CustomizeSidebarModal onClose={() => {}} workersVisible />);
    });
    expect(
      useSidebarStore.getState().sidebarNavLayout.order.includes('agents'),
    ).toBe(true);
    expect(
      document.querySelector('[data-testid="customize-sidebar-row-agents"]'),
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-testid="customize-sidebar-row-app-advisor"]',
      ),
    ).not.toBeNull();
  });

  it('hides the workers row when Claude Workers is not available', () => {
    useSidebarStore.setState({
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
        moreStartIndex: 4,
      },
    });
    act(() => {
      root.render(
        <CustomizeSidebarModal onClose={() => {}} workersVisible={false} />,
      );
    });
    expect(
      document.querySelector('[data-testid="customize-sidebar-row-workers"]'),
    ).toBeNull();
    // Audit still renders — only workers is gated. Usage is a fixed More-menu
    // action rather than a customizable nav item.
    expect(
      document.querySelector('[data-testid="customize-sidebar-row-usage"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="customize-sidebar-row-audit"]'),
    ).not.toBeNull();
  });

  it('shows the workers row when Claude Workers is available', () => {
    useSidebarStore.setState({
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
        moreStartIndex: 4,
      },
    });
    act(() => {
      root.render(<CustomizeSidebarModal onClose={() => {}} workersVisible />);
    });
    expect(
      document.querySelector('[data-testid="customize-sidebar-row-workers"]'),
    ).not.toBeNull();
  });

  it('resets a hidden remote-control entry to the default position before saving', () => {
    const onClose = jest.fn();
    useSidebarStore.setState({
      sidebarNavLayout: {
        order: [
          'app-advisor',
          'automations',
          'plugins',
          'remote-control',
          'pipelines',
          'overview',
          'kanban',
          'environments',
          'agents',
          'statistics',
        ],
        moreStartIndex: 4,
      },
    });
    act(() => {
      root.render(<CustomizeSidebarModal onClose={onClose} workersVisible />);
    });

    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="customize-sidebar-reset"]',
        )
        ?.click();
    });
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="customize-sidebar-save"]',
        )
        ?.click();
    });

    expect(useSidebarStore.getState().sidebarNavLayout).toEqual(
      DEFAULT_SIDEBAR_NAV_LAYOUT,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('while early access is on', () => {
    const row = (key: string): HTMLElement | null =>
      document.querySelector<HTMLElement>(
        `[data-testid="customize-sidebar-row-${key}"]`,
      );
    const divider = (): Element | null =>
      document.querySelector('[data-testid="customize-sidebar-more-divider"]');
    const isAboveDivider = (key: string): boolean => {
      const node = row(key);
      const more = divider();
      if (node === null || more === null) throw new Error(`no row ${key}`);
      return (
        (node.compareDocumentPosition(more) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
        0
      );
    };
    const rowKeys = (): string[] =>
      Array.from(
        document.querySelectorAll('[data-testid^="customize-sidebar-row-"]'),
        (node) => node.getAttribute('data-testid') ?? '',
      )
        .filter((id) => !id.endsWith('-handle'))
        .map((id) => id.replace('customize-sidebar-row-', ''));
    const click = (id: string): void => {
      act(() => {
        document
          .querySelector<HTMLButtonElement>(
            `[data-testid="customize-sidebar-${id}"]`,
          )
          ?.click();
      });
    };

    beforeEach(() => {
      setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    });

    it('lists App Advisor and Remote Control as sortable Sidebar rows for the default layout', () => {
      useSidebarStore.setState({
        sidebarNavLayout: {
          ...DEFAULT_SIDEBAR_NAV_LAYOUT,
          order: [...DEFAULT_SIDEBAR_NAV_LAYOUT.order],
        },
      });
      act(() => {
        root.render(
          <CustomizeSidebarModal onClose={() => {}} workersVisible />,
        );
      });
      for (const key of ['app-advisor', 'workflows', 'plugins']) {
        expect(isAboveDivider(key)).toBe(true);
        const handle = row(key)?.closest('[aria-roledescription="sortable"]');
        expect(handle?.getAttribute('tabindex')).toBe('0');
        expect(handle?.getAttribute('role')).toBe('button');
      }
      expect(row('automations')).toBeNull();
      expect(row('pipelines')).toBeNull();
      const keys = rowKeys();
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('keeps App Advisor in its saved More order and Remote Control hidden', () => {
      useSidebarStore.setState({
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
      });
      act(() => {
        root.render(
          <CustomizeSidebarModal onClose={() => {}} workersVisible />,
        );
      });
      expect(rowKeys()).toEqual([
        'workflows',
        'plugins',
        'overview',
        'kanban',
        'app-advisor',
      ]);
      expect(isAboveDivider('app-advisor')).toBe(false);
    });

    it('keeps the draft across an early access toggle and saves it', () => {
      const custom = {
        order: [
          'workflows',
          'plugins',
          'overview',
          'remote-control',
          'kanban',
          'app-advisor',
        ],
        moreStartIndex: 2,
      };
      useSidebarStore.setState({ sidebarNavLayout: custom });
      act(() => {
        root.render(
          <CustomizeSidebarModal onClose={() => {}} workersVisible />,
        );
      });
      click('reset');
      act(() => {
        setTestEarlyAccessFeatures({
          enabled: false,
          hydrated: true,
        });
      });
      // The toggle neither discards the draft nor writes the stored layout.
      expect(isAboveDivider('app-advisor')).toBe(true);
      expect(isAboveDivider('plugins')).toBe(true);
      expect(useSidebarStore.getState().sidebarNavLayout).toEqual(custom);
      click('save');
      expect(useSidebarStore.getState().sidebarNavLayout).toEqual(
        DEFAULT_SIDEBAR_NAV_LAYOUT,
      );
    });

    it('leaves the saved layout alone when a reset is cancelled', () => {
      const onClose = jest.fn();
      const custom = {
        order: ['workflows', 'overview', 'remote-control', 'app-advisor'],
        moreStartIndex: 1,
      };
      useSidebarStore.setState({ sidebarNavLayout: custom });
      act(() => {
        root.render(<CustomizeSidebarModal onClose={onClose} workersVisible />);
      });
      click('reset');
      click('cancel');
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(useSidebarStore.getState().sidebarNavLayout).toEqual(custom);
    });
  });
});
