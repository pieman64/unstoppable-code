import { DEFAULT_SIDEBAR_NAV_LAYOUT } from '@canopy/desktop-shared/lib/sidebar-nav-layout';
import type { SidebarNavLayout } from '@canopy/desktop-shared/types';
import {
  MORE_DIVIDER_ID,
  buildLayoutFromEntries,
  toEntries,
} from '../customize-sidebar-layout';

describe('customize-sidebar-layout', () => {
  describe('toEntries', () => {
    it('inserts the More divider sentinel at moreStartIndex', () => {
      const entries = toEntries(['a', 'b', 'c', 'd'], 2);
      expect(entries).toEqual(['a', 'b', MORE_DIVIDER_ID, 'c', 'd']);
    });

    it('places the divider first when moreStartIndex is 0', () => {
      expect(toEntries(['a', 'b'], 0)).toEqual([MORE_DIVIDER_ID, 'a', 'b']);
    });

    it('places the divider last when moreStartIndex equals order length', () => {
      expect(toEntries(['a', 'b'], 2)).toEqual(['a', 'b', MORE_DIVIDER_ID]);
    });
  });

  describe('buildLayoutFromEntries', () => {
    it('round-trips a portal-ON reorder (move overview below the divider)', () => {
      const stored = DEFAULT_SIDEBAR_NAV_LAYOUT;
      // Default: everything but Environments in main nav (CAN-3678). Drag
      // `overview` below the divider into More.
      const edited = [
        'app-advisor',
        'workflows',
        'plugins',
        'remote-control',
        'kanban',
        'agents',
        'statistics',
        'audit',
        'workers',
        MORE_DIVIDER_ID,
        'overview',
        'environments',
      ];
      const result = buildLayoutFromEntries(edited, stored);
      // feed (hidden while the Ledger is off) re-integrates at its stored
      // main-nav index.
      expect(result.order).toEqual([
        'app-advisor',
        'workflows',
        'plugins',
        'feed',
        'remote-control',
        'kanban',
        'agents',
        'statistics',
        'audit',
        'workers',
        'overview',
        'environments',
      ]);
      expect(result.moreStartIndex).toBe(10);
    });

    it('sets moreStartIndex to 0 when the divider is dragged to the top (all in More)', () => {
      const stored = DEFAULT_SIDEBAR_NAV_LAYOUT;
      const edited = [MORE_DIVIDER_ID, ...stored.order];
      const result = buildLayoutFromEntries(edited, stored);
      expect(result.moreStartIndex).toBe(0);
      expect(result.order).toEqual(stored.order);
    });

    it('sets moreStartIndex to order length when the divider is at the bottom (all main nav)', () => {
      const stored = DEFAULT_SIDEBAR_NAV_LAYOUT;
      const edited = [...stored.order, MORE_DIVIDER_ID];
      const result = buildLayoutFromEntries(edited, stored);
      expect(result.moreStartIndex).toBe(stored.order.length);
      expect(result.order).toEqual(stored.order);
    });

    it('re-integrates a hidden remote-control (portal OFF) at its stored index while reordering visible keys', () => {
      const stored: SidebarNavLayout = DEFAULT_SIDEBAR_NAV_LAYOUT;
      // Portal disabled: `remote-control` is excluded from the edited list.
      // The user swaps app-advisor and workflows, everything else unchanged.
      const edited = [
        'workflows',
        'app-advisor',
        'plugins',
        'overview',
        'kanban',
        'agents',
        'statistics',
        'audit',
        'workers',
        MORE_DIVIDER_ID,
        'environments',
      ];
      const result = buildLayoutFromEntries(edited, stored);
      // CAN-1082: remote-control is re-pinned at its original stored index,
      // which the default puts in main nav (4, after the hidden feed).
      expect(result.order.indexOf('remote-control')).toBe(4);
      expect(result.order).toEqual([
        'workflows',
        'app-advisor',
        'plugins',
        'feed',
        'remote-control',
        'overview',
        'kanban',
        'agents',
        'statistics',
        'audit',
        'workers',
        'environments',
      ]);
      // The re-pinned keys stay on the main-nav side of the divider, so only
      // Environments is in More.
      expect(result.moreStartIndex).toBe(11);
    });

    it('keeps a hidden remote-control in main nav when saving with portal off', () => {
      const stored: SidebarNavLayout = {
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
      };
      const edited = [
        'app-advisor',
        'automations',
        'plugins',
        MORE_DIVIDER_ID,
        'pipelines',
        'overview',
        'kanban',
        'environments',
        'agents',
        'statistics',
      ];

      const result = buildLayoutFromEntries(edited, stored);

      expect(result.order).toEqual([
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
      ]);
      expect(result.moreStartIndex).toBe(4);
    });
  });
});
