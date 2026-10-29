import {
  DEFAULT_SIDEBAR_NAV_LAYOUT,
  reconcileSidebarNavLayout,
} from '@canopy/protocol/sidebar';
import {
  deriveSidebarNavRegions,
  isSidebarNavKeyVisible,
} from '../sidebar-nav-layout';

/**
 * The layout model itself lives in `@canopy/protocol/sidebar` and is covered
 * there. This suite covers the piece that stayed desktop-side: the app's own
 * feature-flag visibility policy over the regions.
 */
describe('deriveSidebarNavRegions', () => {
  it('splits order at moreStartIndex', () => {
    const regions = deriveSidebarNavRegions(DEFAULT_SIDEBAR_NAV_LAYOUT, {
      workersVisible: true,
    });
    expect(regions.mainNav).toEqual([
      'app-advisor',
      'workflows',
      'plugins',
      'overview',
      'kanban',
      'statistics',
      'audit',
      'workers',
    ]);
    expect(regions.more).toEqual([]);
  });

  it('hides keys owned by experiments that are off without moving the rest', () => {
    const base = {
      workersVisible: true,
    };
    const hidden = deriveSidebarNavRegions(DEFAULT_SIDEBAR_NAV_LAYOUT, {
      ...base,
      experimentHiddenKeys: ['audit'],
    });
    expect(hidden.mainNav).toEqual([
      'app-advisor',
      'workflows',
      'plugins',
      'overview',
      'kanban',
      'statistics',
      'workers',
    ]);
    expect(hidden.more).toEqual([]);
    expect(isSidebarNavKeyVisible('audit', base)).toBe(true);
    expect(
      isSidebarNavKeyVisible('audit', { ...base, experimentHiddenKeys: [] }),
    ).toBe(true);
    // Turning the experiment back on restores the key in its stored place.
    expect(
      deriveSidebarNavRegions(DEFAULT_SIDEBAR_NAV_LAYOUT, base).mainNav,
    ).toContain('audit');
    expect(
      deriveSidebarNavRegions(DEFAULT_SIDEBAR_NAV_LAYOUT, base).mainNav.indexOf(
        'audit',
      ),
    ).toBe(6);
  });

  it('never lists remote-control on desktop (CAN-3659: it lives on the account row and menu)', () => {
    const regions = deriveSidebarNavRegions(DEFAULT_SIDEBAR_NAV_LAYOUT, {});
    expect(regions.mainNav).not.toContain('remote-control');
    expect(regions.more).not.toContain('remote-control');
    expect(isSidebarNavKeyVisible('remote-control', {})).toBe(false);
  });

  it('keeps a stored remote-control position although desktop hides it', () => {
    const stored = {
      order: [
        'workflows',
        'overview',
        'remote-control',
        'kanban',
        ...DEFAULT_SIDEBAR_NAV_LAYOUT.order.filter(
          (key) =>
            !['workflows', 'overview', 'remote-control', 'kanban'].includes(
              key,
            ),
        ),
      ],
      moreStartIndex: 1,
    };
    const reconciled = reconcileSidebarNavLayout(stored);
    expect(reconciled.order.slice(0, 4)).toEqual([
      'workflows',
      'overview',
      'remote-control',
      'kanban',
    ]);
    expect(reconciled.moreStartIndex).toBe(1);
    expect(deriveSidebarNavRegions(reconciled, {}).more).not.toContain(
      'remote-control',
    );
  });

  it('never lists the retired agents key from a persisted layout (CAN-4266)', () => {
    const reconciled = reconcileSidebarNavLayout({
      order: [
        'app-advisor',
        'agents',
        ...DEFAULT_SIDEBAR_NAV_LAYOUT.order.filter(
          (key) => key !== 'app-advisor',
        ),
      ],
      moreStartIndex: DEFAULT_SIDEBAR_NAV_LAYOUT.order.length + 1,
    });
    expect(reconciled).toEqual(DEFAULT_SIDEBAR_NAV_LAYOUT);
    const regions = deriveSidebarNavRegions(reconciled, {
      workersVisible: true,
      ledgerEnabled: true,
    });
    expect(regions.mainNav).not.toContain('agents');
    expect(regions.more).not.toContain('agents');
  });

  it('filters workers from both regions when workers are not visible', () => {
    const hidden = deriveSidebarNavRegions(DEFAULT_SIDEBAR_NAV_LAYOUT, {});
    expect(hidden.mainNav).not.toContain('workers');
    expect(hidden.more).not.toContain('workers');

    const shown = deriveSidebarNavRegions(DEFAULT_SIDEBAR_NAV_LAYOUT, {
      workersVisible: true,
    });
    expect(shown.mainNav).toContain('workers');
  });

  it('shows the Feed in main nav only while the Ledger is on', () => {
    const off = deriveSidebarNavRegions(DEFAULT_SIDEBAR_NAV_LAYOUT, {});
    expect(off.mainNav).not.toContain('feed');
    expect(off.more).not.toContain('feed');

    const on = deriveSidebarNavRegions(DEFAULT_SIDEBAR_NAV_LAYOUT, {
      ledgerEnabled: true,
    });
    expect(on.mainNav.slice(0, 5)).toEqual([
      'app-advisor',
      'workflows',
      'plugins',
      'feed',
      'overview',
    ]);
  });

  it('keeps App Advisor in its stored Sidebar position', () => {
    const regions = deriveSidebarNavRegions(
      {
        order: [
          'workflows',
          'app-advisor',
          'plugins',
          'remote-control',
          'overview',
        ],
        moreStartIndex: 4,
      },
      {},
    );
    expect(regions.mainNav).toEqual(['workflows', 'app-advisor', 'plugins']);
    expect(regions.more).toEqual(['overview']);
  });

  it('keeps App Advisor in its stored More position', () => {
    const regions = deriveSidebarNavRegions(
      {
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
      {},
    );
    expect(regions.mainNav).toEqual(['workflows', 'plugins']);
    // App Advisor stays behind the other More items rather than being pinned
    // first, and nothing is listed twice.
    expect(regions.more).toEqual(['overview', 'kanban', 'app-advisor']);
    const all = [...regions.mainNav, ...regions.more];
    expect(new Set(all).size).toBe(all.length);
  });
});
