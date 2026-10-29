import {
  DEFAULT_LAYOUT_TIER,
  LAYOUT_TIERS,
  MOBILE_MEDIA_QUERY,
  PHONE_MAX_WIDTH_PX,
  PHONE_MEDIA_QUERY,
  TABLET_MAX_WIDTH_PX,
  isLayoutTier,
  isMobileLayoutTier,
  isPhoneLayoutTier,
  layoutTierForWidth,
  normalizeLayoutTier,
  type LayoutTier,
} from '../layout-tier';

describe('layoutTierForWidth', () => {
  it('places the reference viewports in the intended tiers', () => {
    // The three viewports the responsive work is specified against.
    expect(layoutTierForWidth(390)).toBe('phone'); // iPhone-class
    expect(layoutTierForWidth(412)).toBe('phone'); // Pixel 7
    expect(layoutTierForWidth(768)).toBe('tablet');
    expect(layoutTierForWidth(1440)).toBe('desktop');
  });

  it('puts each boundary on the narrower side and the next pixel on the wider', () => {
    expect(layoutTierForWidth(PHONE_MAX_WIDTH_PX)).toBe('phone');
    expect(layoutTierForWidth(PHONE_MAX_WIDTH_PX + 1)).toBe('tablet');
    expect(layoutTierForWidth(TABLET_MAX_WIDTH_PX)).toBe('tablet');
    expect(layoutTierForWidth(TABLET_MAX_WIDTH_PX + 1)).toBe('desktop');
  });

  it('lands the boundaries one below the Tailwind sm and lg breakpoints', () => {
    // Tier boundaries must sit on the existing utility scale, or the classes
    // and the hook disagree about where a phone stops being a phone.
    expect(PHONE_MAX_WIDTH_PX + 1).toBe(640);
    expect(TABLET_MAX_WIDTH_PX + 1).toBe(1024);
  });

  it('treats a degenerate width as the narrowest tier rather than throwing', () => {
    expect(layoutTierForWidth(0)).toBe('phone');
  });
});

describe('media queries', () => {
  /**
   * The historical `useIsMobile()` query, unchanged. `useIsMobile()` is being
   * re-expressed as `useLayoutTier() !== 'desktop'`, and every existing call
   * site depends on that being a rename rather than a behavior change.
   */
  it('keeps the mobile query at the pre-existing lg boundary', () => {
    expect(MOBILE_MEDIA_QUERY).toBe('(max-width: 1023px)');
  });

  it('derives the phone query from the same constants', () => {
    expect(PHONE_MEDIA_QUERY).toBe('(max-width: 639px)');
  });

  /**
   * THE PLAYWRIGHT PROJECTS MUST KEEP TESTING WHAT THEY CLAIM TO.
   *
   * `playwright.web.config.mjs` hard-codes a viewport per project, and the
   * project NAMES are the claim about which tier each one exercises. Nothing
   * connected those widths to the boundaries defined here, so moving a boundary
   * would silently leave the `tablet` project running at phone width (or vice
   * versa) while still reporting green under its old name.
   *
   * The widths below MIRROR that config rather than importing it — pulling a
   * root Playwright config into a ui-shared Jest test would be a worse boundary
   * violation than the duplication. So the pin is one-directional and worth
   * being precise about: moving a boundary constant here fails this test, but
   * retargeting a Playwright project's viewport does not. That is the half that
   * actually matters, since the boundaries are what this module owns.
   */
  it('classifies each Playwright project viewport as the tier it is named for', () => {
    const projectWidths: ReadonlyArray<readonly [string, number, LayoutTier]> =
      [
        ['phone', 390, 'phone'],
        ['phone-wide', 412, 'phone'],
        ['tablet', 768, 'tablet'],
        ['desktop', 1280, 'desktop'],
      ];
    for (const [name, width, expected] of projectWidths) {
      expect([name, layoutTierForWidth(width)]).toEqual([name, expected]);
    }
  });

  it('describes exactly one tier per query, with no gap and no overlap', () => {
    const widths = [0, 320, 639, 640, 800, 1023, 1024, 2000];
    for (const width of widths) {
      const tier = layoutTierForWidth(width);
      expect(isPhoneLayoutTier(tier)).toBe(width <= 639);
      expect(isMobileLayoutTier(tier)).toBe(width <= 1023);
    }
  });
});

describe('tier predicates', () => {
  it('counts tablet as mobile but not as phone', () => {
    expect(isMobileLayoutTier('tablet')).toBe(true);
    expect(isPhoneLayoutTier('tablet')).toBe(false);
  });

  it('counts desktop as neither', () => {
    expect(isMobileLayoutTier('desktop')).toBe(false);
    expect(isPhoneLayoutTier('desktop')).toBe(false);
  });
});

describe('LAYOUT_TIERS', () => {
  it('is ordered narrow to wide with no duplicates', () => {
    expect(LAYOUT_TIERS).toEqual(['phone', 'tablet', 'desktop']);
    expect(new Set(LAYOUT_TIERS).size).toBe(LAYOUT_TIERS.length);
  });
});

describe('isLayoutTier / normalizeLayoutTier', () => {
  it('accepts every member of the union', () => {
    for (const tier of LAYOUT_TIERS) {
      expect(isLayoutTier(tier)).toBe(true);
      expect(normalizeLayoutTier(tier)).toBe(tier);
    }
  });

  it('rejects everything else', () => {
    for (const value of [
      undefined,
      null,
      '',
      'Phone',
      'mobile',
      0,
      {},
      ['phone'],
    ]) {
      expect(isLayoutTier(value)).toBe(false);
      expect(normalizeLayoutTier(value)).toBe(DEFAULT_LAYOUT_TIER);
    }
  });

  /**
   * An unseeded render must look like today, not like a new guess. The old
   * `useMediaQuery` server snapshot was `false` (not mobile), so the default
   * has to be `desktop` or every SSR path that does not seed the tier changes
   * behavior as a side effect of this module existing.
   */
  it('defaults to desktop, matching the pre-existing server snapshot', () => {
    expect(DEFAULT_LAYOUT_TIER).toBe('desktop');
    expect(isMobileLayoutTier(DEFAULT_LAYOUT_TIER)).toBe(false);
  });
});
