import {
  DEFAULT_SIDEBAR_NAV_LAYOUT,
  SIDEBAR_NAV_ITEM_KEYS,
  createDefaultSidebarNavLayout,
  reconcileSidebarNavLayout,
  splitSidebarNavLayout,
} from '../index';

/**
 * The nav model moved from `@canopy/desktop-shared/lib/sidebar-nav-layout` to
 * the protocol package so `apps/web` (which may not import desktop-shared) can
 * render the same sidebar nav as the desktop app. These assertions pin the
 * contract at its new home; the exhaustive behavioral suite lives alongside in
 * the sibling file that moved with the implementation.
 */
describe('protocol sidebar nav layout contract', () => {
  it('exposes the canonical key set in default order', () => {
    expect(SIDEBAR_NAV_ITEM_KEYS).toEqual([
      'app-advisor',
      'workflows',
      'plugins',
      'feed',
      'remote-control',
      'overview',
      'kanban',
      'statistics',
      'audit',
      'workers',
    ]);
  });

  it('places the More divider after all default items', () => {
    expect(DEFAULT_SIDEBAR_NAV_LAYOUT.moreStartIndex).toBe(
      SIDEBAR_NAV_ITEM_KEYS.length,
    );
  });

  it('hands back a fresh mutable default layout each call', () => {
    const first = createDefaultSidebarNavLayout();
    first.order.push('mutated');
    expect(createDefaultSidebarNavLayout().order).not.toContain('mutated');
  });

  it('reconciles an unknown key out and repairs missing defaults', () => {
    const reconciled = reconcileSidebarNavLayout({
      order: ['plugins', 'not-a-real-key'],
      moreStartIndex: 1,
    });
    expect(reconciled.order).not.toContain('not-a-real-key');
    expect([...reconciled.order].sort()).toEqual(
      [...SIDEBAR_NAV_ITEM_KEYS].sort(),
    );
  });

  it('splits a layout on the stored divider without applying host policy', () => {
    const { mainNav, more } = splitSidebarNavLayout(
      createDefaultSidebarNavLayout(),
    );
    expect(mainNav).toContain('plugins');
    // No flags were supplied, so nothing is filtered out: which keys a host
    // renders is that host's policy, applied after this split.
    expect(mainNav).toContain('remote-control');
    expect(mainNav).toContain('audit');
    expect(more).toEqual([]);
  });
});
