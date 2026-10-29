import {
  SIDEBAR_ITEM_IDLE_CLASSNAME,
  SIDEBAR_ITEM_SELECTED_CLASSNAME,
  SIDEBAR_LIST_ICON_CLASSNAME,
  SIDEBAR_LIST_ITEM_CLASSNAME,
  SIDEBAR_NAV_ICON_CLASSNAME,
  SIDEBAR_NAV_ITEM_CLASSNAME,
  SIDEBAR_ROW_GRID_CLASSNAME,
  SIDEBAR_ROW_LEADING_SLOT_CLASSNAME,
  SIDEBAR_ROW_TEXT_INSET_CLASSNAME,
  sidebarNavItemClassName,
} from '../sidebar-item-classes';

/**
 * Literal assertions on purpose.
 *
 * Every consumer builds its row by calling `sidebarNavItemClassName`, so a
 * test that compares a rendered row against another call of that same helper
 * is tautological: drop `bg-muted` inside the helper and both sides change
 * together while the test stays green. These are the only assertions that
 * pin the contract itself, so they name the classes rather than deriving them.
 */
describe('sidebar item classes', () => {
  it('states a row at rest in primary text', () => {
    // Not `fg-secondary`. A sidebar row is a destination, not supporting
    // copy — the portal drew these secondary and read as greyed-out links
    // beside desktop's white ones.
    expect(SIDEBAR_ITEM_IDLE_CLASSNAME).toBe('fg-primary hover:bg-subtle');
  });

  it('states the selected row neutrally, without the accent', () => {
    // The accent is reserved for what the user can act on. Every row in the
    // list is equally actionable, so tinting the current one makes it read as
    // the only live entry.
    expect(SIDEBAR_ITEM_SELECTED_CLASSNAME).toBe('bg-muted fg-primary');
    expect(SIDEBAR_ITEM_SELECTED_CLASSNAME).not.toContain('accent');
  });

  it('keeps the row geometry both hosts lay out against', () => {
    for (const token of [
      'h-8',
      'gap-2',
      'rounded-row',
      'px-2',
      'py-0',
      'text-s',
      'font-normal',
    ]) {
      expect(SIDEBAR_LIST_ITEM_CLASSNAME).toContain(token);
    }
  });

  it('sizes the leading icon consistently', () => {
    expect(SIDEBAR_LIST_ICON_CLASSNAME).toContain('h-4');
    expect(SIDEBAR_LIST_ICON_CLASSNAME).toContain('w-4');
    expect(SIDEBAR_LIST_ICON_CLASSNAME).toContain('shrink-0');
    // The nav alias is the same box, muted.
    expect(SIDEBAR_NAV_ICON_CLASSNAME).toContain(SIDEBAR_LIST_ICON_CLASSNAME);
    expect(SIDEBAR_NAV_ICON_CLASSNAME).toContain('fg-secondary');
  });

  it('keeps the nav alias pointing at the list item', () => {
    expect(SIDEBAR_NAV_ITEM_CLASSNAME).toBe(SIDEBAR_LIST_ITEM_CLASSNAME);
  });

  describe('row grid', () => {
    // 6px inset + 20px leading slot + 6px gap puts every row title at 32px
    // (2rem). The three literals below are that sum; change one and the
    // others have to move with it.
    it('insets a row with a leading slot by 6px and gaps it by 6px', () => {
      expect(SIDEBAR_ROW_GRID_CLASSNAME).toBe('gap-1.5 pl-1.5');
    });

    it('reserves a 20px leading slot that never shrinks', () => {
      expect(SIDEBAR_ROW_LEADING_SLOT_CLASSNAME).toBe(
        'inline-flex h-5 w-5 shrink-0 items-center justify-center',
      );
    });

    it('puts a text-only row on the title column', () => {
      expect(SIDEBAR_ROW_TEXT_INSET_CLASSNAME).toBe('pl-8');
    });

    it('is a different tier from the nav rows', () => {
      // Nav rows keep an 8px inset and a 16px icon; their label lands on the
      // same 32px column by a different sum.
      expect(SIDEBAR_LIST_ITEM_CLASSNAME).toContain('px-2');
      expect(SIDEBAR_LIST_ITEM_CLASSNAME).not.toContain('pl-1.5');
    });
  });

  describe('sidebarNavItemClassName', () => {
    it('composes geometry with the idle state', () => {
      const className = sidebarNavItemClassName(false);
      expect(className).toContain(SIDEBAR_NAV_ITEM_CLASSNAME);
      expect(className).toContain('fg-primary');
      expect(className).not.toContain('bg-muted');
    });

    it('composes geometry with the selected state', () => {
      const className = sidebarNavItemClassName(true);
      expect(className).toContain(SIDEBAR_NAV_ITEM_CLASSNAME);
      expect(className).toContain('bg-muted');
    });

    it('raises the row to the touch minimum without replacing its height', () => {
      // `min-h-11` on top of `h-8`, not instead of it: a coarse-pointer layout
      // keeps the same rounding, padding and type as the pointer one.
      const touch = sidebarNavItemClassName(false, true);
      expect(touch).toContain('min-h-11');
      expect(touch).toContain('h-8');
      expect(sidebarNavItemClassName(false, false)).not.toContain('min-h-11');
      expect(sidebarNavItemClassName(false)).not.toContain('min-h-11');
    });
  });
});
