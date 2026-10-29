/**
 * Vertical geometry of the main window's titlebar row, shared by the renderer
 * (which lays the row out) and Electron main (which places the macOS traffic
 * lights on it).
 *
 * The interface scale is a uniform page zoom, but the traffic lights are OS
 * chrome the zoom cannot touch. The row therefore holds the lights' physical
 * centre while it can, and inside a band of zooms nothing else is needed.
 * Outside that band the row's centre has to give way so its controls stay
 * whole, and the lights are moved onto the new centre instead
 * ({@link macWindowButtonPosition}), so the two never drift apart.
 *
 * Browser-safe and dependency-free.
 */

/**
 * Outer height (in pixels, at 100% scale) of the titlebar row: the persistent
 * corner in `App.tsx` and the expanded sidebar's own titlebar in
 * `AppSidebar.tsx`. It stays a zooming CSS length, so everything laid out
 * below the titlebar keeps its place at every interface scale.
 */
export const TITLEBAR_ROW_HEIGHT_PX = 40;

/** Top padding (in pixels, at 100% scale) inside {@link TITLEBAR_ROW_HEIGHT_PX}. */
export const TITLEBAR_ROW_PADDING_TOP_PX = 6;

/**
 * Where the titlebar row centres its controls at 100%, in px below the
 * window's top edge: the row's own midpoint, `(6 + 40) / 2`. It is also the
 * centre of the macOS traffic lights at their 100% position `{x:16, y:16}`
 * (`16 + 14 / 2`).
 */
export const TITLEBAR_ROW_CENTER_PX =
  (TITLEBAR_ROW_PADDING_TOP_PX + TITLEBAR_ROW_HEIGHT_PX) / 2;

/**
 * Rendered footprint (in pixels) of each titlebar corner control (the
 * `SidebarToggleButton`, the history arrows, and the collapsed-state New Task
 * button): a 16px glyph plus 6px horizontal padding on every side.
 */
export const TITLEBAR_TOGGLE_FOOTPRINT_PX = 28;

/**
 * How far (in CSS px) the row's controls may hang below its own bottom edge
 * before they would touch the first nav row. `sidebar-fixed-navigation` pads
 * itself by `pt-2`, and the controls already use part of that gap at 75%.
 */
export const TITLEBAR_ROW_BOTTOM_OVERHANG_PX = 8;

/** Horizontal position of the macOS traffic lights, in window points. */
export const MAC_WINDOW_BUTTON_X_PX = 16;

/** Height of a macOS traffic-light button frame, in window points. */
export const MAC_WINDOW_BUTTON_HEIGHT_PX = 14;

/**
 * Where the row centres its controls at `zoomFactor`, in CSS px: the traffic
 * lights' 100% centre expressed in this zoom's pixels, clamped to the band
 * where a whole control still fits.
 *
 * Holding the physical centre unconditionally is right inside the band and
 * wrong outside it: at 200% a 28 CSS px control centred on 23 physical px
 * would put 5 physical px above the window's top edge, and at 50% it would
 * reach ~6 physical px into the first nav row. Outside the band the centre
 * gives way by the least it can — the control sits flush against the window
 * top above the band and flush against the nav row below it — and the lights
 * follow it. Both limits scale with the zoom, so in CSS px they are the
 * constants 14 and 34.
 */
export function titlebarRowContentCenterCssPx(zoomFactor: number): number {
  return Math.min(
    TITLEBAR_ROW_HEIGHT_PX +
      TITLEBAR_ROW_BOTTOM_OVERHANG_PX -
      TITLEBAR_TOGGLE_FOOTPRINT_PX / 2,
    Math.max(
      TITLEBAR_TOGGLE_FOOTPRINT_PX / 2,
      TITLEBAR_ROW_CENTER_PX / zoomFactor,
    ),
  );
}

/**
 * {@link titlebarRowContentCenterCssPx} in window points (physical px below
 * the window's top edge): 23 inside the band, 28 at 200%, 17 at 50%.
 */
export function titlebarRowCenterAtZoomDip(zoomFactor: number): number {
  return titlebarRowContentCenterCssPx(zoomFactor) * zoomFactor;
}

/**
 * The macOS traffic-light position (`trafficLightPosition` /
 * `setWindowButtonPosition`) that centres the lights on the titlebar row at
 * `zoomFactor`. `{x:16, y:16}` everywhere inside the band; outside it the
 * lights move down (above ~164%) or up (below ~68%) to meet the row. Whole
 * points, so the lights land within half a point of the row's centre.
 */
export function macWindowButtonPosition(zoomFactor: number): {
  x: number;
  y: number;
} {
  return {
    x: MAC_WINDOW_BUTTON_X_PX,
    y: Math.round(
      titlebarRowCenterAtZoomDip(zoomFactor) - MAC_WINDOW_BUTTON_HEIGHT_PX / 2,
    ),
  };
}

/**
 * Outer height (in pixels, at 100% scale) of the App Advisor popout's header
 * row: the `AppAdvisorTitlebarCorner` overlay, the nav's header spacer and
 * the top bar (`h-10.75` / `min-h-10.75`).
 */
export const APP_ADVISOR_TITLEBAR_ROW_HEIGHT_PX = 43;

/**
 * The macOS traffic-light position that centres the lights on the App
 * Advisor popout's header row at `zoomFactor`.
 *
 * Unlike the main window, whose corner holds the lights' centre while the
 * rest of its page chrome does not share the row, every control in the
 * popout's header (nav controls, title, Open in, layout) is centred on one
 * zooming row. Moving the lights onto that row lines all of them up at once,
 * at every scale, with no per-control compensation.
 */
export function appAdvisorWindowButtonPosition(zoomFactor: number): {
  x: number;
  y: number;
} {
  return {
    x: MAC_WINDOW_BUTTON_X_PX,
    y: Math.round(
      (APP_ADVISOR_TITLEBAR_ROW_HEIGHT_PX / 2) * zoomFactor -
        MAC_WINDOW_BUTTON_HEIGHT_PX / 2,
    ),
  };
}
