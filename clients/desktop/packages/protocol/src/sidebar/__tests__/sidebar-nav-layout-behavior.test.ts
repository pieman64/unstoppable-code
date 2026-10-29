import {
  DEFAULT_SIDEBAR_NAV_LAYOUT,
  LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT,
  RETIRED_SIDEBAR_NAV_KEY_ALIASES,
  SIDEBAR_NAV_ITEM_KEYS,
  createDefaultSidebarNavLayout,
  isLegacyDefaultSidebarNavLayout,
  reconcileSidebarNavLayout,
} from '../index';

describe('reconcileSidebarNavLayout', () => {
  it('returns the default when input is undefined', () => {
    expect(reconcileSidebarNavLayout(undefined)).toEqual(
      DEFAULT_SIDEBAR_NAV_LAYOUT,
    );
  });

  it('drops unknown keys and appends missing default keys to their default section', () => {
    const result = reconcileSidebarNavLayout({
      order: ['plugins', 'bogus', 'overview'],
      moreStartIndex: 1,
    });
    // known kept in order (plugins, overview), unknown dropped, missing appended.
    expect(
      result.order.filter((k) => !SIDEBAR_NAV_ITEM_KEYS.includes(k)),
    ).toEqual([]);
    expect(new Set(result.order)).toEqual(new Set(SIDEBAR_NAV_ITEM_KEYS));
    expect(result.order).toHaveLength(SIDEBAR_NAV_ITEM_KEYS.length);
    expect(result.order.slice(0, result.moreStartIndex)).toEqual([
      'plugins',
      'app-advisor',
      'workflows',
      'feed',
      'remote-control',
      'kanban',
      'statistics',
      'audit',
      'workers',
    ]);
    expect(result.order.slice(result.moreStartIndex)).toEqual(['overview']);
    expect(result.moreStartIndex).toBe(9);
  });

  it('repairs missing default main-nav keys above the divider', () => {
    const result = reconcileSidebarNavLayout({
      order: ['overview', 'kanban'],
      moreStartIndex: 0,
    });

    expect(result.order.slice(0, result.moreStartIndex)).toEqual([
      'app-advisor',
      'workflows',
      'plugins',
      'feed',
      'remote-control',
      'statistics',
      'audit',
      'workers',
    ]);
    expect(result.order.slice(result.moreStartIndex)).toEqual([
      'overview',
      'kanban',
    ]);
  });

  it('repairs a missing Labs page key into main nav', () => {
    const order = SIDEBAR_NAV_ITEM_KEYS.filter((key) => key !== 'statistics');
    const result = reconcileSidebarNavLayout({
      order,
      moreStartIndex: order.length,
    });

    expect(result.order.slice(0, result.moreStartIndex)).toContain(
      'statistics',
    );
    expect(result.order.slice(result.moreStartIndex)).toEqual([]);
  });

  it('keeps all default items in main nav when stored there', () => {
    const result = reconcileSidebarNavLayout({
      order: [...SIDEBAR_NAV_ITEM_KEYS],
      moreStartIndex: SIDEBAR_NAV_ITEM_KEYS.length,
    });

    expect(result.order).toEqual(SIDEBAR_NAV_ITEM_KEYS);
    expect(result.moreStartIndex).toBe(SIDEBAR_NAV_ITEM_KEYS.length);
  });

  it('dedups a repeated known key while keeping the first occurrence', () => {
    const result = reconcileSidebarNavLayout({
      order: ['plugins', 'plugins', 'overview'],
      moreStartIndex: 1,
    });
    expect(result.order.filter((k) => k === 'plugins')).toHaveLength(1);
    expect(new Set(result.order).size).toBe(result.order.length);
    expect(new Set(result.order)).toEqual(new Set(SIDEBAR_NAV_ITEM_KEYS));
    expect(result.order).toHaveLength(SIDEBAR_NAV_ITEM_KEYS.length);
  });

  it('keeps repaired moreStartIndex in range', () => {
    for (const moreStartIndex of [999, -5]) {
      const result = reconcileSidebarNavLayout({ order: [], moreStartIndex });
      expect(result.moreStartIndex).toBe(
        DEFAULT_SIDEBAR_NAV_LAYOUT.moreStartIndex,
      );
      expect(result.moreStartIndex).toBeGreaterThanOrEqual(0);
      expect(result.moreStartIndex).toBeLessThanOrEqual(result.order.length);
    }
  });
});

describe('reconcileSidebarNavLayout retired Workflows keys (CAN-3980)', () => {
  it('maps automations and pipelines to workflows', () => {
    expect(RETIRED_SIDEBAR_NAV_KEY_ALIASES).toEqual({
      automations: 'workflows',
      pipelines: 'workflows',
    });
    expect(SIDEBAR_NAV_ITEM_KEYS).not.toContain('automations');
    expect(SIDEBAR_NAV_ITEM_KEYS).not.toContain('pipelines');
  });

  it('collapses both retired keys into one workflows key at the automations position', () => {
    const result = reconcileSidebarNavLayout({
      order: ['app-advisor', 'automations', 'plugins', 'pipelines', 'feed'],
      moreStartIndex: 5,
    });

    expect(result.order.filter((key) => key === 'workflows')).toHaveLength(1);
    expect(result.order.slice(0, 3)).toEqual([
      'app-advisor',
      'workflows',
      'plugins',
    ]);
  });

  it('puts workflows at the pipelines position when pipelines was stored first', () => {
    const result = reconcileSidebarNavLayout({
      order: ['pipelines', 'app-advisor', 'plugins', 'automations'],
      moreStartIndex: 4,
    });

    expect(result.order.slice(0, 3)).toEqual([
      'workflows',
      'app-advisor',
      'plugins',
    ]);
  });

  it('drops the divider by one when both retired keys sit before it', () => {
    const result = reconcileSidebarNavLayout({
      order: [
        'app-advisor',
        'automations',
        'plugins',
        'pipelines',
        'feed',
        'remote-control',
        'overview',
        'kanban',
        'environments',
        'agents',
        'statistics',
        'audit',
        'workers',
      ],
      moreStartIndex: 6,
    });

    expect(result.moreStartIndex).toBe(5);
    expect(result.order.slice(0, result.moreStartIndex)).toEqual([
      'app-advisor',
      'workflows',
      'plugins',
      'feed',
      'remote-control',
    ]);
    expect(result.order.slice(result.moreStartIndex)).toEqual([
      'overview',
      'kanban',
      'statistics',
      'audit',
      'workers',
    ]);
  });

  it('keeps workflows on the main side when the retired keys straddle the divider', () => {
    const result = reconcileSidebarNavLayout({
      order: [
        'app-advisor',
        'automations',
        'plugins',
        'feed',
        'remote-control',
        'pipelines',
        'overview',
        'kanban',
        'agents',
        'statistics',
        'audit',
        'workers',
      ],
      moreStartIndex: 5,
    });

    expect(result.moreStartIndex).toBe(5);
    expect(result.order.slice(0, result.moreStartIndex)).toEqual([
      'app-advisor',
      'workflows',
      'plugins',
      'feed',
      'remote-control',
    ]);
    expect(result.order.slice(result.moreStartIndex)).not.toContain(
      'workflows',
    );
  });

  it('appends workflows to the main side when neither retired key is stored', () => {
    const result = reconcileSidebarNavLayout({
      order: ['app-advisor', 'plugins', 'overview'],
      moreStartIndex: 2,
    });

    expect(result.order.slice(0, result.moreStartIndex)).toContain('workflows');
  });

  it('is idempotent', () => {
    const stored = {
      order: [
        'pipelines',
        'app-advisor',
        'overview',
        'automations',
        'plugins',
        'audit',
      ],
      moreStartIndex: 3,
    };
    const once = reconcileSidebarNavLayout(stored);

    expect(reconcileSidebarNavLayout(once)).toEqual(once);
  });

  it('keeps the pre-CAN-3678 More section for the main-process migration to move', () => {
    // The desktop `sidebar_more_pages_to_main` migration, not reconcile,
    // turns this layout into the current default.
    expect(
      reconcileSidebarNavLayout({
        order: [
          'app-advisor',
          'automations',
          'plugins',
          'pipelines',
          'feed',
          'remote-control',
          'overview',
          'kanban',
          'environments',
          'agents',
          'statistics',
          'audit',
          'workers',
        ],
        moreStartIndex: 6,
      }),
    ).toEqual({
      order: [
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
      ],
      moreStartIndex: 5,
    });
  });
});

describe('reconcileSidebarNavLayout removed Environments key (CAN-4269)', () => {
  it('no longer lists environments as a nav key', () => {
    expect(SIDEBAR_NAV_ITEM_KEYS).not.toContain('environments');
  });

  it('drops environments pinned in the main region and shifts the divider down by one', () => {
    const result = reconcileSidebarNavLayout({
      order: [
        'app-advisor',
        'environments',
        'workflows',
        'plugins',
        'feed',
        'remote-control',
        'overview',
        'kanban',
        'statistics',
        'audit',
        'workers',
      ],
      moreStartIndex: 6,
    });

    expect(result.order).not.toContain('environments');
    expect(result.moreStartIndex).toBe(5);
    expect(result.order.slice(0, result.moreStartIndex)).toEqual([
      'app-advisor',
      'workflows',
      'plugins',
      'feed',
      'remote-control',
    ]);
    expect(result.order.slice(result.moreStartIndex)).toEqual([
      'overview',
      'kanban',
      'statistics',
      'audit',
      'workers',
    ]);
  });

  it('drops environments from More without moving the divider', () => {
    const result = reconcileSidebarNavLayout({
      order: [
        'plugins',
        'app-advisor',
        'workflows',
        'feed',
        'remote-control',
        'workers',
        'environments',
        'overview',
        'kanban',
        'statistics',
        'audit',
      ],
      moreStartIndex: 5,
    });

    expect(result.order).not.toContain('environments');
    expect(result.moreStartIndex).toBe(5);
    expect(result.order).toEqual([
      'plugins',
      'app-advisor',
      'workflows',
      'feed',
      'remote-control',
      'workers',
      'overview',
      'kanban',
      'statistics',
      'audit',
    ]);
  });
});

describe('reconcileSidebarNavLayout removed Agents key (CAN-4266)', () => {
  it('no longer lists agents as a nav key', () => {
    expect(SIDEBAR_NAV_ITEM_KEYS).not.toContain('agents');
  });

  it('drops agents pinned in the main region and shifts the divider down by one', () => {
    const result = reconcileSidebarNavLayout({
      order: [
        'app-advisor',
        'agents',
        'workflows',
        'plugins',
        'feed',
        'remote-control',
        'overview',
        'kanban',
        'statistics',
        'audit',
        'workers',
      ],
      moreStartIndex: 6,
    });

    expect(result.order).not.toContain('agents');
    expect(result.moreStartIndex).toBe(5);
    expect(result.order.slice(0, result.moreStartIndex)).toEqual([
      'app-advisor',
      'workflows',
      'plugins',
      'feed',
      'remote-control',
    ]);
    expect(result.order.slice(result.moreStartIndex)).toEqual([
      'overview',
      'kanban',
      'statistics',
      'audit',
      'workers',
    ]);
  });

  it('drops agents from More without moving the divider', () => {
    const result = reconcileSidebarNavLayout({
      order: [
        'plugins',
        'app-advisor',
        'workflows',
        'feed',
        'remote-control',
        'workers',
        'overview',
        'kanban',
        'agents',
        'statistics',
        'audit',
      ],
      moreStartIndex: 5,
    });

    expect(result.order).not.toContain('agents');
    expect(result.moreStartIndex).toBe(5);
    expect(result.order).toEqual([
      'plugins',
      'app-advisor',
      'workflows',
      'feed',
      'remote-control',
      'workers',
      'overview',
      'kanban',
      'statistics',
      'audit',
    ]);
  });

  it('is idempotent once agents is dropped', () => {
    const once = reconcileSidebarNavLayout({
      order: [...SIDEBAR_NAV_ITEM_KEYS, 'agents'],
      moreStartIndex: SIDEBAR_NAV_ITEM_KEYS.length + 1,
    });

    expect(once).toEqual(DEFAULT_SIDEBAR_NAV_LAYOUT);
    expect(reconcileSidebarNavLayout(once)).toEqual(once);
  });
});

describe('isLegacyDefaultSidebarNavLayout', () => {
  it('still recognizes the pre-CAN-1082 default after reconcile merges the Workflows keys', () => {
    const raw = {
      order: [...LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.order],
      moreStartIndex: LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.moreStartIndex,
    };
    const reconciled = reconcileSidebarNavLayout(raw);

    expect(reconciled.order).not.toContain('automations');
    expect(reconciled.order).not.toContain('pipelines');
    expect(isLegacyDefaultSidebarNavLayout(raw)).toBe(true);
    expect(isLegacyDefaultSidebarNavLayout(reconciled)).toBe(true);
  });

  it('still recognizes the pre-CAN-1082 default after reconcile drops environments (CAN-4269)', () => {
    const raw = {
      order: [...LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.order],
      moreStartIndex: LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.moreStartIndex,
    };
    expect(raw.order).toContain('environments');

    const reconciled = reconcileSidebarNavLayout(raw);

    expect(reconciled.order).not.toContain('environments');
    expect(isLegacyDefaultSidebarNavLayout(raw)).toBe(true);
    expect(isLegacyDefaultSidebarNavLayout(reconciled)).toBe(true);
  });

  it('still recognizes the pre-CAN-1082 default after reconcile drops agents (CAN-4266)', () => {
    const raw = {
      order: [...LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.order],
      moreStartIndex: LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.moreStartIndex,
    };
    expect(raw.order).toContain('agents');

    const reconciled = reconcileSidebarNavLayout(raw);

    expect(reconciled.order).not.toContain('agents');
    expect(isLegacyDefaultSidebarNavLayout(raw)).toBe(true);
    expect(isLegacyDefaultSidebarNavLayout(reconciled)).toBe(true);
  });

  it('rejects a reconciled customized layout', () => {
    const reconciled = reconcileSidebarNavLayout({
      order: [...LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.order].reverse(),
      moreStartIndex: 3,
    });

    expect(isLegacyDefaultSidebarNavLayout(reconciled)).toBe(false);
  });

  it('recognizes only the exact pre-CAN-1082 default layout', () => {
    expect(
      isLegacyDefaultSidebarNavLayout({
        order: [...LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.order],
        moreStartIndex: LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.moreStartIndex,
      }),
    ).toBe(true);
    expect(isLegacyDefaultSidebarNavLayout(undefined)).toBe(false);
    expect(isLegacyDefaultSidebarNavLayout(DEFAULT_SIDEBAR_NAV_LAYOUT)).toBe(
      false,
    );
    expect(
      isLegacyDefaultSidebarNavLayout({
        order: [...LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.order].reverse(),
        moreStartIndex: LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.moreStartIndex,
      }),
    ).toBe(false);
  });

  it('still recognizes a legacy layout that reconcile extended with a future nav key', () => {
    // Simulates the shape `reconcileSidebarNavLayout` produces once a key is
    // added to SIDEBAR_NAV_ITEM_KEYS after CAN-1082: the stored legacy order is
    // preserved, the new main-nav key is injected at the divider, and
    // moreStartIndex shifts. These users have never customized anything and
    // must still be migrated.
    const legacy = [...LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.order];
    const reconciled = {
      order: [...legacy.slice(0, 4), 'future-key', ...legacy.slice(4)],
      moreStartIndex: 5,
    };

    expect(reconciled.order).toHaveLength(legacy.length + 1);
    expect(isLegacyDefaultSidebarNavLayout(reconciled)).toBe(true);
  });

  it('rejects a customized layout even when a future nav key is present', () => {
    const legacy = [...LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.order];
    const customized = [...legacy].reverse();

    expect(
      isLegacyDefaultSidebarNavLayout({
        order: [
          ...customized.slice(0, 4),
          'future-key',
          ...customized.slice(4),
        ],
        moreStartIndex: 5,
      }),
    ).toBe(false);
  });

  it('rejects a legacy order whose divider was moved by the user', () => {
    expect(
      isLegacyDefaultSidebarNavLayout({
        order: [...LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.order],
        moreStartIndex: LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.moreStartIndex + 1,
      }),
    ).toBe(false);
  });
});

describe('LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT', () => {
  it('is frozen so it cannot be mutated out from under the migration check', () => {
    expect(Object.isFrozen(LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT)).toBe(true);
    expect(Object.isFrozen(LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.order)).toBe(true);
  });
});

describe('createDefaultSidebarNavLayout', () => {
  it('returns a fresh object and array on each call so callers cannot corrupt the shared default', () => {
    const a = createDefaultSidebarNavLayout();
    const b = createDefaultSidebarNavLayout();

    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.order).not.toBe(b.order);
  });

  it('agrees with DEFAULT_SIDEBAR_NAV_LAYOUT so Reset and fresh-install cannot drift', () => {
    expect(createDefaultSidebarNavLayout()).toEqual(DEFAULT_SIDEBAR_NAV_LAYOUT);
  });

  it('puts all default items before the More divider', () => {
    const layout = createDefaultSidebarNavLayout();
    expect(layout.order.slice(layout.moreStartIndex)).toEqual([]);
  });
});
