import { SIDEBAR_MIN_WIDTH } from '@canopy/desktop-shared/constants/preferences';
import {
  TITLEBAR_ROW_BOTTOM_OVERHANG_PX,
  TITLEBAR_ROW_CENTER_PX,
  TITLEBAR_ROW_HEIGHT_PX,
  TITLEBAR_ROW_PADDING_TOP_PX,
  TITLEBAR_TOGGLE_FOOTPRINT_PX,
  titlebarRowContentCenterCssPx,
} from '@canopy/desktop-shared/lib/titlebar-geometry';

// The row's vertical geometry is shared with Electron main, which moves the
// macOS traffic lights onto the row wherever the row cannot reach them.
export {
  TITLEBAR_ROW_BOTTOM_OVERHANG_PX,
  TITLEBAR_ROW_CENTER_PX,
  TITLEBAR_ROW_HEIGHT_PX,
  TITLEBAR_ROW_PADDING_TOP_PX,
  TITLEBAR_TOGGLE_FOOTPRINT_PX,
};

export function shouldReserveSidebarTrafficLightRegion(
  platform: NodeJS.Platform,
): boolean {
  return platform === 'darwin';
}

/**
 * Width in LOGICAL (pre-zoom) pixels reserved for macOS traffic-light window
 * buttons (`trafficLightPosition: {x:16,y:16}` in the main-process
 * BrowserWindow config). Shared by the expanded sidebar's own titlebar row
 * and the full-width titlebar strip rendered above content when the sidebar
 * is hidden, so both surfaces protect the exact same region.
 *
 * The lights sit at a fixed on-screen position while the interface scale is
 * a uniform page zoom, so in CSS this reserve is divided by the live zoom
 * (`--ui-zoom`, published by `lib/theme.ts`): see
 * {@link withTrafficLightReserveCss}.
 */
export const TRAFFIC_LIGHT_RESERVE_PX = 72;

/**
 * A CSS length that keeps the traffic-light reserve in physical units while
 * `scaledPx` (controls, gaps, padding) zooms with the rest of the UI:
 * `calc(72px / var(--ui-zoom, 1) + <scaledPx>px)` on macOS, plain
 * `<scaledPx>px` elsewhere. Every surface that reserves space for the lights
 * must build its width/padding through this helper so the corner never
 * drifts at 125/150%.
 */
export function withTrafficLightReserveCss(
  reserveTrafficLights: boolean,
  scaledPx: number,
): string {
  return reserveTrafficLights
    ? `calc(${TRAFFIC_LIGHT_RESERVE_PX}px / var(--ui-zoom, 1) + ${scaledPx}px)`
    : `${scaledPx}px`;
}

/**
 * The band of zoom factors where the traffic lights' exact centre is
 * reachable without the control leaving the window at the top or reaching
 * the nav row below.
 *
 * Upper bound: half a `28 x zoom` control outgrows the 23px centre above
 * `2 x CENTER / FOOTPRINT` = 164.29%. Lower bound: the control's bottom
 * outgrows the row plus its overhang budget below
 * `CENTER / (HEIGHT + OVERHANG - FOOTPRINT / 2)` = 67.65%. Both sit outside
 * the 75–150% the Display slider used to offer, so the whole band that
 * shipped before the range opened up is unchanged. Outside the band the row's
 * centre gives way and Electron main moves the lights onto it instead
 * (`macWindowButtonPosition` in `@canopy/desktop-shared/lib/titlebar-geometry`).
 */
export const TITLEBAR_UPPER_ALIGNED_ZOOM =
  (2 * TITLEBAR_ROW_CENTER_PX) / TITLEBAR_TOGGLE_FOOTPRINT_PX;

/** Lower bound of {@link TITLEBAR_UPPER_ALIGNED_ZOOM}'s band. */
export const TITLEBAR_LOWER_ALIGNED_ZOOM =
  TITLEBAR_ROW_CENTER_PX /
  (TITLEBAR_ROW_HEIGHT_PX +
    TITLEBAR_ROW_BOTTOM_OVERHANG_PX -
    TITLEBAR_TOGGLE_FOOTPRINT_PX / 2);

/**
 * Vertical padding (in CSS px) that lands the titlebar row's content on
 * {@link titlebarRowContentCenterCssPx} at `zoomFactor`, inside an outer box
 * that stays {@link TITLEBAR_ROW_HEIGHT_PX} CSS px tall.
 *
 * Centring a content box of `[top, HEIGHT - bottom]` on `centre` needs
 * `top - bottom = 2 x centre - HEIGHT`, so exactly one side ever pads: above
 * 100% the row pads its bottom to pull the controls up, below 100% it pads
 * its top to push them down. On platforms with no traffic lights there is
 * nothing fixed to line up with, so the row keeps its plain zooming geometry.
 *
 * The controls overflow the row rather than shrinking, which is what keeps
 * the centre exact inside the band: below 100% they hang past the row's
 * bottom edge into the padding beneath it.
 */
export function titlebarRowPaddingPx(
  reserveTrafficLights: boolean,
  zoomFactor: number,
): { top: number; bottom: number } {
  if (!reserveTrafficLights) {
    return { top: TITLEBAR_ROW_PADDING_TOP_PX, bottom: 0 };
  }
  const shift =
    2 * titlebarRowContentCenterCssPx(zoomFactor) - TITLEBAR_ROW_HEIGHT_PX;
  return { top: Math.max(0, shift), bottom: Math.max(0, -shift) };
}

/**
 * Where {@link titlebarRowPaddingPx} actually puts the row's controls at
 * `zoomFactor`, in physical px below the window top — 23 on macOS inside the
 * aligned band (clamped outside it, where the lights move to match), and the
 * plain zooming `23 x zoom` elsewhere.
 */
export function titlebarRowContentCenterAtZoomPx(
  reserveTrafficLights: boolean,
  zoomFactor: number,
): number {
  const { top, bottom } = titlebarRowPaddingPx(
    reserveTrafficLights,
    zoomFactor,
  );
  return ((top + TITLEBAR_ROW_HEIGHT_PX - bottom) / 2) * zoomFactor;
}

/**
 * `2 x centre` as a CSS length — the shared term in both padding
 * expressions. `clamp()` mirrors {@link titlebarRowContentCenterCssPx}:
 * scaling a clamp's value and both its bounds by the same positive number is
 * the same clamp, so doubling all three keeps the two in step.
 */
function titlebarRowDoubleCenterCss(): string {
  const lower = TITLEBAR_TOGGLE_FOOTPRINT_PX;
  const upper =
    2 *
    (TITLEBAR_ROW_HEIGHT_PX +
      TITLEBAR_ROW_BOTTOM_OVERHANG_PX -
      TITLEBAR_TOGGLE_FOOTPRINT_PX / 2);
  return `clamp(${lower}px, ${2 * TITLEBAR_ROW_CENTER_PX}px / var(--ui-zoom, 1), ${upper}px)`;
}

/**
 * The CSS length form of {@link titlebarRowPaddingPx}'s `top`. The `max()`
 * guard is what lets one expression serve both directions: it collapses to
 * zero for every zoom above 100%, where the bottom pad does the work.
 */
export function titlebarRowPaddingTopCss(
  reserveTrafficLights: boolean,
): string {
  if (!reserveTrafficLights) return `${TITLEBAR_ROW_PADDING_TOP_PX}px`;
  return `max(0px, calc(${titlebarRowDoubleCenterCss()} - ${TITLEBAR_ROW_HEIGHT_PX}px))`;
}

/** The CSS length form of {@link titlebarRowPaddingPx}'s `bottom`. */
export function titlebarRowPaddingBottomCss(
  reserveTrafficLights: boolean,
): string {
  if (!reserveTrafficLights) return '0px';
  return `max(0px, calc(${TITLEBAR_ROW_HEIGHT_PX}px - ${titlebarRowDoubleCenterCss()}))`;
}

/**
 * Number of controls in the titlebar corner for a sidebar state. Both states
 * show the sidebar toggle and the back/forward history arrows; the collapsed
 * state adds the icon-only New Task button (the expanded sidebar has its own
 * full-width New Task button instead).
 */
export function titlebarCornerControlCount(sidebarHidden: boolean): number {
  return sidebarHidden ? 4 : 3;
}

/**
 * Horizontal breathing room (in pixels) between the macOS traffic lights (or
 * the window's left edge on other platforms) and the sidebar toggle.
 */
export const TITLEBAR_TOGGLE_GAP_PX = 16;

/**
 * Gap between titlebar control groups: sidebar toggle → history arrows, and
 * (while collapsed) history arrows → New Task.
 */
export const TITLEBAR_HISTORY_GAP_PX = 4;

/**
 * Trailing space (in pixels) between the history controls and the content
 * following the persistent titlebar corner.
 */
export const TITLEBAR_CORNER_TRAILING_PX = 8;

/**
 * Left padding (in pixels, at 100% scale) before the toggle: the
 * traffic-light reserve (macOS only) plus the toggle gap. Applied to both
 * the collapsed titlebar corner and the expanded sidebar's toggle row so the
 * toggle lands at the exact same x offset in both states. Renderers use
 * {@link titlebarToggleLeadingCss}, which keeps the reserve physical under
 * the interface-scale zoom.
 */
export function titlebarToggleLeadingPx(reserveTrafficLights: boolean): number {
  return (
    (reserveTrafficLights ? TRAFFIC_LIGHT_RESERVE_PX : 0) +
    TITLEBAR_TOGGLE_GAP_PX
  );
}

/** The CSS length form of {@link titlebarToggleLeadingPx}. */
export function titlebarToggleLeadingCss(
  reserveTrafficLights: boolean,
): string {
  return withTrafficLightReserveCss(
    reserveTrafficLights,
    TITLEBAR_TOGGLE_GAP_PX,
  );
}

/**
 * Total width (in pixels, at 100% scale) of the titlebar corner container
 * for a sidebar state (leading pad + controls + trailing pad). The
 * `PageTitlebar` layout helper places each page's top bar flush against a
 * container of this width while the sidebar is hidden, and the expanded
 * sidebar's titlebar row reserves the expanded-state width. Renderers use
 * {@link titlebarCornerWidthCss}.
 */
export function titlebarCornerWidthPx(
  reserveTrafficLights: boolean,
  sidebarHidden: boolean,
): number {
  return (
    titlebarToggleLeadingPx(reserveTrafficLights) +
    titlebarCornerControlCount(sidebarHidden) * TITLEBAR_TOGGLE_FOOTPRINT_PX +
    TITLEBAR_HISTORY_GAP_PX * (sidebarHidden ? 2 : 1) +
    TITLEBAR_CORNER_TRAILING_PX
  );
}

/**
 * The CSS length form of {@link titlebarCornerWidthPx}: the controls, gaps
 * and padding zoom with the UI while the traffic-light reserve stays
 * physical.
 */
export function titlebarCornerWidthCss(
  reserveTrafficLights: boolean,
  sidebarHidden: boolean,
): string {
  return withTrafficLightReserveCss(
    reserveTrafficLights,
    titlebarCornerWidthPx(false, sidebarHidden),
  );
}

/**
 * Left edge (in pixels, at 100% scale) of the collapsed corner's New Task
 * control, from the window's left edge. It is the corner's last control, so
 * it sits one footprint plus the trailing pad in from the collapsed width.
 */
export function titlebarCreateTaskLeftPx(
  reserveTrafficLights: boolean,
): number {
  return (
    titlebarCornerWidthPx(reserveTrafficLights, true) -
    TITLEBAR_CORNER_TRAILING_PX -
    TITLEBAR_TOGGLE_FOOTPRINT_PX
  );
}

/** The CSS length form of {@link titlebarCreateTaskLeftPx}. */
export function titlebarCreateTaskLeftCss(
  reserveTrafficLights: boolean,
): string {
  return withTrafficLightReserveCss(
    reserveTrafficLights,
    titlebarCreateTaskLeftPx(false),
  );
}

/**
 * The docked sidebar's right edge, from the window's left edge, as the
 * sidebar's `<aside>` lays it out: its width with the `min-width` floor, or 0
 * while hidden. The aside animates between these two values, so anything that
 * must move with its edge animates the same lengths on the same curve.
 */
export function sidebarDockedEdgeCss(
  reserveTrafficLights: boolean,
  hidden: boolean,
  width: number,
): string {
  return hidden
    ? '0px'
    : `max(${width}px, ${sidebarMinWidthCss(reserveTrafficLights)})`;
}

/**
 * What {@link titlebarCornerWidthCss} actually measures at `zoomFactor`, in
 * CSS px. The traffic-light reserve is physical, so it costs MORE CSS px the
 * further the zoom drops below 100%: 184px at 100%, 208px at 75%.
 */
export function titlebarCornerWidthAtZoomPx(
  reserveTrafficLights: boolean,
  sidebarHidden: boolean,
  zoomFactor: number,
): number {
  return (
    (reserveTrafficLights ? TRAFFIC_LIGHT_RESERVE_PX / zoomFactor : 0) +
    titlebarCornerWidthPx(false, sidebarHidden)
  );
}

/**
 * The sidebar's minimum width in CSS px at `zoomFactor`.
 *
 * The expanded sidebar's titlebar row is the corner spacer plus the status
 * area, and the status area must keep the one-button budget asserted in
 * `sidebar-layout.test.ts`. Since the corner's traffic-light reserve is
 * physical, below 100% it eats extra CSS px out of that row, so the floor
 * grows by exactly that extra. Above 100% the extra is negative and the
 * floor stays at `SIDEBAR_MIN_WIDTH` — the status area simply gets roomier.
 */
export function sidebarMinWidthPx(
  reserveTrafficLights: boolean,
  zoomFactor: number,
): number {
  if (!reserveTrafficLights) return SIDEBAR_MIN_WIDTH;
  const extraReserve =
    TRAFFIC_LIGHT_RESERVE_PX / zoomFactor - TRAFFIC_LIGHT_RESERVE_PX;
  return SIDEBAR_MIN_WIDTH + Math.max(0, extraReserve);
}

/**
 * The CSS length form of {@link sidebarMinWidthPx}, for the rendered floor.
 * `max()` keeps a zoom above 100% (where the extra is negative) from pulling
 * the sidebar below `SIDEBAR_MIN_WIDTH`.
 */
export function sidebarMinWidthCss(reserveTrafficLights: boolean): string {
  if (!reserveTrafficLights) return `${SIDEBAR_MIN_WIDTH}px`;
  return `max(${SIDEBAR_MIN_WIDTH}px, calc(${SIDEBAR_MIN_WIDTH}px + ${TRAFFIC_LIGHT_RESERVE_PX}px / var(--ui-zoom, 1) - ${TRAFFIC_LIGHT_RESERVE_PX}px))`;
}
