import {
  shouldReserveSidebarTrafficLightRegion,
  sidebarDockedEdgeCss,
  sidebarMinWidthCss,
  sidebarMinWidthPx,
  TITLEBAR_CORNER_TRAILING_PX,
  TITLEBAR_LOWER_ALIGNED_ZOOM,
  TITLEBAR_ROW_BOTTOM_OVERHANG_PX,
  TITLEBAR_ROW_CENTER_PX,
  TITLEBAR_ROW_HEIGHT_PX,
  TITLEBAR_ROW_PADDING_TOP_PX,
  TITLEBAR_TOGGLE_FOOTPRINT_PX,
  TITLEBAR_UPPER_ALIGNED_ZOOM,
  titlebarCornerControlCount,
  titlebarCornerWidthAtZoomPx,
  titlebarCornerWidthCss,
  titlebarCornerWidthPx,
  titlebarCreateTaskLeftCss,
  titlebarCreateTaskLeftPx,
  titlebarRowContentCenterAtZoomPx,
  titlebarRowPaddingBottomCss,
  titlebarRowPaddingPx,
  titlebarRowPaddingTopCss,
  titlebarToggleLeadingCss,
  titlebarToggleLeadingPx,
  withTrafficLightReserveCss,
} from '../sidebar-layout';
import { shouldSubscribeResourceMonitor } from '../sidebar-resource-monitor';
import { SIDEBAR_MIN_WIDTH } from '@/stores/sidebarStore';

describe('Sidebar resource monitor subscription gating', () => {
  it('waits for loaded preferences before subscribing', () => {
    expect(shouldSubscribeResourceMonitor(false, true)).toBe(false);
  });

  it('subscribes only when the diagnostics pill preference is enabled', () => {
    expect(shouldSubscribeResourceMonitor(true, false)).toBe(false);
    expect(shouldSubscribeResourceMonitor(true, true)).toBe(true);
  });
});

describe('Sidebar platform spacing', () => {
  it('reserves the traffic-light region only on macOS', () => {
    expect(shouldReserveSidebarTrafficLightRegion('darwin')).toBe(true);
    expect(shouldReserveSidebarTrafficLightRegion('win32')).toBe(false);
    expect(shouldReserveSidebarTrafficLightRegion('linux')).toBe(false);
  });

  it('reserves only the toggle and history controls while the sidebar is expanded', () => {
    expect(titlebarCornerControlCount(false)).toBe(3);
    expect(titlebarCornerWidthPx(true, false)).toBe(184);
  });

  it('adds only New task while the sidebar is collapsed', () => {
    expect(titlebarCornerControlCount(true)).toBe(4);
    expect(titlebarCornerWidthPx(true, true)).toBe(216);
  });
});

describe('Collapsed New task seat', () => {
  it("places New task as the collapsed corner's last control", () => {
    // 216px corner minus the 8px trailing pad and New task's 28px footprint.
    expect(titlebarCreateTaskLeftPx(true)).toBe(180);
    expect(titlebarCreateTaskLeftPx(false)).toBe(
      titlebarCornerWidthPx(false, true) -
        TITLEBAR_CORNER_TRAILING_PX -
        TITLEBAR_TOGGLE_FOOTPRINT_PX,
    );
    // The traffic-light reserve stays physical, like the corner's own width.
    expect(titlebarCreateTaskLeftCss(true)).toBe(
      withTrafficLightReserveCss(true, titlebarCreateTaskLeftPx(false)),
    );
  });

  it('tracks the docked sidebar edge, floor included, and 0 while hidden', () => {
    expect(sidebarDockedEdgeCss(true, true, 320)).toBe('0px');
    expect(sidebarDockedEdgeCss(true, false, 320)).toBe(
      `max(320px, ${sidebarMinWidthCss(true)})`,
    );
    expect(sidebarDockedEdgeCss(false, false, 260)).toBe(
      `max(260px, ${sidebarMinWidthCss(false)})`,
    );
  });
});

describe('Sidebar floor under the interface-scale zoom', () => {
  // The Display slider and `normalizePreferences` both span 50-200%.
  const SUPPORTED_ZOOMS = [0.5, 0.75, 0.8, 1, 1.25, 1.5, 2];

  it.each(SUPPORTED_ZOOMS)(
    'keeps one full header-button target in the status space at %s zoom',
    (zoomFactor) => {
      const statusWidth =
        sidebarMinWidthPx(true, zoomFactor) -
        titlebarCornerWidthAtZoomPx(true, false, zoomFactor);

      expect(statusWidth).toBeGreaterThanOrEqual(
        TITLEBAR_TOGGLE_FOOTPRINT_PX + TITLEBAR_CORNER_TRAILING_PX,
      );
    },
  );

  it('allows a 220px sidebar while keeping the traffic-light reserve physical', () => {
    expect(sidebarMinWidthPx(true, 1)).toBe(220);
    expect(sidebarMinWidthPx(true, 0.75)).toBe(244);
    expect(sidebarMinWidthPx(true, 0.8)).toBe(238);
    expect(sidebarMinWidthPx(true, 0.5)).toBe(292);
  });

  it('uses the normal floor once the titlebar fits above 100%', () => {
    expect(sidebarMinWidthPx(true, 1.25)).toBeCloseTo(220);
    expect(sidebarMinWidthPx(true, 1.5)).toBe(220);
    expect(sidebarMinWidthPx(true, 2)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it('leaves platforms without traffic lights on the plain floor', () => {
    expect(sidebarMinWidthPx(false, 0.75)).toBe(SIDEBAR_MIN_WIDTH);
    expect(sidebarMinWidthCss(false)).toBe(`${SIDEBAR_MIN_WIDTH}px`);
  });

  it('expresses the same floor as a CSS length for the rendered sidebar', () => {
    expect(sidebarMinWidthCss(true)).toBe(
      'max(220px, calc(72px / var(--ui-zoom, 1) + 148px))',
    );
  });
});

describe('Titlebar geometry under the interface-scale zoom', () => {
  it('keeps the traffic-light reserve physical and zooms everything else', () => {
    expect(withTrafficLightReserveCss(true, 40)).toBe(
      'calc(72px / var(--ui-zoom, 1) + 40px)',
    );
    expect(withTrafficLightReserveCss(false, 40)).toBe('40px');
  });

  it('derives the toggle leading pad from the same numbers as the px form', () => {
    expect(titlebarToggleLeadingPx(true)).toBe(88);
    expect(titlebarToggleLeadingCss(true)).toBe(
      'calc(72px / var(--ui-zoom, 1) + 16px)',
    );
    expect(titlebarToggleLeadingCss(false)).toBe('16px');
  });

  it('derives the corner width from the same numbers as the px form', () => {
    // 184 = 72 reserve + 112 scaled (gap, three controls, one gap, trailing).
    expect(titlebarCornerWidthCss(true, false)).toBe(
      'calc(72px / var(--ui-zoom, 1) + 112px)',
    );
    // 216 = 72 reserve + 144 scaled (gap, four controls, two gaps, trailing).
    expect(titlebarCornerWidthCss(true, true)).toBe(
      'calc(72px / var(--ui-zoom, 1) + 144px)',
    );
    expect(titlebarCornerWidthCss(false, false)).toBe('112px');
  });
});

describe('Titlebar row centre line under the interface-scale zoom', () => {
  // The Display slider and `normalizePreferences` both span 50-200%.
  const SUPPORTED_ZOOMS = [0.5, 0.75, 0.8, 1, 1.25, 1.5, 2];

  /**
   * The band where the lights' exact centre is reachable: the control must
   * stay inside the window at the top and clear the first nav row below.
   */
  const ALIGNED_ZOOMS = [0.75, 0.8, 1, 1.25, 1.5];

  it('matches the macOS traffic lights at 100%, where nothing is scaled', () => {
    // 23 = (6 + 40) / 2, and also `trafficLightPosition.y` (16) plus half the
    // window button's 14px frame.
    expect(TITLEBAR_ROW_HEIGHT_PX).toBe(40);
    expect(TITLEBAR_ROW_CENTER_PX).toBe(23);
    expect(titlebarRowPaddingPx(true, 1)).toEqual({
      top: TITLEBAR_ROW_PADDING_TOP_PX,
      bottom: 0,
    });
  });

  it.each(ALIGNED_ZOOMS)(
    'holds the corner controls on the traffic lights at %s zoom',
    (zoomFactor) => {
      // The lights are fixed-size OS chrome at `trafficLightPosition:
      // {x:16,y:16}`, so their centre never leaves 23 physical px however
      // far the page zoom moves ours.
      expect(titlebarRowContentCenterAtZoomPx(true, zoomFactor)).toBeCloseTo(
        TITLEBAR_ROW_CENTER_PX,
        6,
      );
    },
  );

  it('degrades instead of clipping outside the band where the lights are reachable', () => {
    // Measured physical centre per scale across the whole 50-200% range.
    // Inside the band the centre is the lights' fixed 23px; outside it the
    // centre is pushed to the nearest value that keeps the control whole.
    const measured = SUPPORTED_ZOOMS.map((zoomFactor) => [
      zoomFactor,
      Number(titlebarRowContentCenterAtZoomPx(true, zoomFactor).toFixed(4)),
    ]);
    expect(measured).toEqual([
      [0.5, 17], // clamped down: 23 would put the control into the nav row
      [0.75, 23],
      [0.8, 23],
      [1, 23],
      [1.25, 23],
      [1.5, 23],
      [2, 28], // clamped up: 23 would put 5px of the control off-window
    ]);
  });

  it.each(SUPPORTED_ZOOMS)(
    'keeps the whole control inside the window at %s zoom',
    (zoomFactor) => {
      const center = titlebarRowContentCenterAtZoomPx(true, zoomFactor);
      const halfControl = (TITLEBAR_TOGGLE_FOOTPRINT_PX * zoomFactor) / 2;
      expect(center - halfControl).toBeGreaterThanOrEqual(0);
    },
  );

  it.each(SUPPORTED_ZOOMS)(
    'keeps the control clear of the first nav row at %s zoom',
    (zoomFactor) => {
      // The row is 40 CSS px tall and `sidebar-fixed-navigation` adds `pt-2`
      // (8 CSS px) before the first nav row. The control may hang into that
      // gap — it does already at 75% — but never past it.
      const center = titlebarRowContentCenterAtZoomPx(true, zoomFactor);
      const halfControl = (TITLEBAR_TOGGLE_FOOTPRINT_PX * zoomFactor) / 2;
      const firstNavRowTop =
        (TITLEBAR_ROW_HEIGHT_PX + TITLEBAR_ROW_BOTTOM_OVERHANG_PX) * zoomFactor;
      expect(center + halfControl).toBeLessThanOrEqual(firstNavRowTop + 1e-9);
    },
  );

  it('names the thresholds where the exact centre stops being reachable', () => {
    // Upper: half a `28 x zoom` control outgrows the 23px centre above
    // 46/28 = 164.29%. Lower: the control's bottom outgrows the row plus its
    // 8px gap below 23/34 = 67.65%.
    expect(TITLEBAR_UPPER_ALIGNED_ZOOM).toBeCloseTo(46 / 28, 6);
    expect(TITLEBAR_LOWER_ALIGNED_ZOOM).toBeCloseTo(23 / 34, 6);
    for (const zoomFactor of [
      TITLEBAR_LOWER_ALIGNED_ZOOM,
      TITLEBAR_UPPER_ALIGNED_ZOOM,
    ]) {
      expect(titlebarRowContentCenterAtZoomPx(true, zoomFactor)).toBeCloseTo(
        TITLEBAR_ROW_CENTER_PX,
        6,
      );
    }
  });

  it('keeps the row 40px tall at every zoom so content below never moves', () => {
    for (const zoomFactor of SUPPORTED_ZOOMS) {
      const padding = titlebarRowPaddingPx(true, zoomFactor);
      expect(padding.top).toBeGreaterThanOrEqual(0);
      expect(padding.bottom).toBeGreaterThanOrEqual(0);
      // Only one side ever pads: the content box slides inside a constant
      // 40px outer box rather than resizing it.
      expect(Math.min(padding.top, padding.bottom)).toBe(0);
    }
  });

  it('moves the centre monotonically, so a scale step never jumps the corner', () => {
    const centers = [0.5, 0.6, 0.7, 0.75, 1, 1.5, 1.65, 2, 2.5, 3].map(
      (zoomFactor) => titlebarRowContentCenterAtZoomPx(true, zoomFactor),
    );
    for (let index = 1; index < centers.length; index += 1) {
      expect(centers[index]).toBeGreaterThanOrEqual(centers[index - 1]);
    }
  });

  it('leaves platforms without traffic lights on the plain zooming row', () => {
    for (const zoomFactor of SUPPORTED_ZOOMS) {
      expect(titlebarRowPaddingPx(false, zoomFactor)).toEqual({
        top: TITLEBAR_ROW_PADDING_TOP_PX,
        bottom: 0,
      });
      expect(titlebarRowContentCenterAtZoomPx(false, zoomFactor)).toBeCloseTo(
        TITLEBAR_ROW_CENTER_PX * zoomFactor,
        6,
      );
    }
    expect(titlebarRowPaddingTopCss(false)).toBe('6px');
    expect(titlebarRowPaddingBottomCss(false)).toBe('0px');
  });

  it('expresses the same padding as CSS lengths for the rendered rows', () => {
    // 46 = 2 x the 23px centre, clamped to 2 x the reachable band (28-68)
    // so the rendered rows degrade exactly like `titlebarRowPaddingPx`. The
    // `max()` guards keep either side from going negative across 100%.
    expect(titlebarRowPaddingTopCss(true)).toBe(
      'max(0px, calc(clamp(28px, 46px / var(--ui-zoom, 1), 68px) - 40px))',
    );
    expect(titlebarRowPaddingBottomCss(true)).toBe(
      'max(0px, calc(40px - clamp(28px, 46px / var(--ui-zoom, 1), 68px)))',
    );
  });
});
