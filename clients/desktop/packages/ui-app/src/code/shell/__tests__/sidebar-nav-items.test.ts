import { SIDEBAR_NAV_ITEM_KEYS } from '@canopy/protocol/sidebar';
import {
  CustomizeIcon,
  StorefrontIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { getSidebarNavItemDefs } from '../sidebar-nav-items';

describe('shared sidebar nav item registry', () => {
  it('covers exactly the canonical key set', () => {
    // The `Record<SidebarNavItemKey, …>` return type already makes a missing
    // key a compile error. This pins the other direction — a stray key that is
    // not in the canonical set would render a row no layout can order.
    expect(Object.keys(getSidebarNavItemDefs()).sort()).toEqual(
      [...SIDEBAR_NAV_ITEM_KEYS].sort(),
    );
  });

  it('keys every def to its own record entry', () => {
    for (const [key, def] of Object.entries(getSidebarNavItemDefs())) {
      expect(def.key).toBe(key);
      expect(def.label.length).toBeGreaterThan(0);
    }
  });

  it('lets the host size the icons', () => {
    const defs = getSidebarNavItemDefs(20);
    expect(defs.plugins.icon.props).toMatchObject({ size: 20 });
    // Desktop keeps the 16px default.
    expect(getSidebarNavItemDefs().plugins.icon.props).toMatchObject({
      size: 16,
    });
  });

  it('names the plugins row after the page it opens', () => {
    const { plugins } = getSidebarNavItemDefs();

    // The key stays `plugins`: routes, page ids and test ids hang off it.
    expect(plugins.key).toBe('plugins');
    expect(plugins.label).toBe('Customize');
  });

  it('keeps the Ledger row named Feed', () => {
    // The organization page is called Timeline; the Ledger page keeps Feed.
    expect(getSidebarNavItemDefs().feed.label).toBe('Feed');
  });

  it('draws the Customize row with the briefcase glyph', () => {
    const { plugins } = getSidebarNavItemDefs(20);

    expect(plugins.icon.type).toBe(CustomizeIcon);
    expect(plugins.icon.type).not.toBe(StorefrontIcon);
    const html = renderToString(plugins.icon);
    expect(html).toBe(
      renderToString(createElement(CustomizeIcon, { size: 20 })),
    );
    expect(html).toContain('data-glyph="briefcase"');
    expect(html).not.toContain('data-glyph="store"');
  });
});
