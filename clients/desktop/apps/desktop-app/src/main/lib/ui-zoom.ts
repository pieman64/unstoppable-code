import { BrowserWindow, screen, type Rectangle } from 'electron';
import {
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
} from '@canopy/desktop-shared/lib/ui-scale';
import { isVisualPreviewWindow } from '../browser/visual-preview-service';

/**
 * Interface scale as a uniform zoom.
 *
 * `PreferencesData.uiScale` (50–200, percent) is applied as Electron's page
 * zoom factor on every app window, so text, controls, radii, icons, insets
 * and shadows grow together instead of only the rem-based sizes. The main
 * process owns the application of that zoom because the preference is the
 * single source of truth and every renderer window (main, App Advisor,
 * panel pull-outs) must follow it:
 *
 * - window construction passes `webPreferences.zoomFactor` so the very first
 *   paint is already zoomed ({@link uiZoomWebPreferences});
 * - `did-finish-load` re-asserts the persisted value, because Chromium keeps
 *   its own per-origin zoom memory that could otherwise win over an
 *   externally edited `preferences.json`;
 * - the preferences save handler fans a changed `uiScale` out to every open
 *   window ({@link applyUiZoomToAllWindows}).
 *
 * Window minimum sizes zoom too. Every layout floor in the renderer (the
 * 320px panel floor, the sidebar) is in CSS px, and a CSS px is `zoom`
 * logical px, so a window keeps its 100% minimum in CSS px only if its
 * logical minimum is `base × zoom` ({@link scaledMinimumSize}). Windows
 * register their 100% minimum ({@link registerUiZoomMinimumSize}) and a zoom
 * change re-derives it, growing a window that became too small.
 *
 * The renderer never sets zoom itself; it observes the effective zoom (see
 * `renderer/src/lib/theme.ts`) to republish `--ui-zoom` and recompute the
 * one-device-pixel `--border-hairline`. Main-process code that positions
 * native surfaces from renderer rectangles (the in-app browser view)
 * converts those CSS px to window DIPs with {@link cssRectToWindowDips}.
 */

export { UI_SCALE_DEFAULT, UI_SCALE_MAX, UI_SCALE_MIN };

/** A window's minimum size, in logical (DIP) pixels. */
export interface WindowMinimumSize {
  width: number;
  height: number;
}

/** Structural window shape so unit tests and fakes need no real Electron. */
export interface ZoomableBrowserWindow {
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  getBounds(): Rectangle;
  setBounds(bounds: Partial<Rectangle>): void;
  setMinimumSize(width: number, height: number): void;
  /** macOS only; absent from fakes and other platforms. */
  setWindowButtonPosition?(position: Electron.Point | null): void;
  webContents: {
    isDestroyed(): boolean;
    setZoomFactor(factor: number): void;
  };
}

/**
 * 100% minimum sizes of the windows that follow the zoom. Keyed weakly so a
 * closed window never pins memory; unregistered windows only get the zoom.
 */
const baseMinimumSizes = new WeakMap<object, WindowMinimumSize>();

/** Where each registered window keeps its macOS traffic lights per zoom. */
type WindowButtonPositionForZoom = (zoomFactor: number) => Electron.Point;

const windowButtonPositions = new WeakMap<
  object,
  WindowButtonPositionForZoom
>();

/**
 * Zoom factor for a persisted UI scale percentage: 100 → 1, 150 → 1.5.
 * Out-of-range or non-finite input clamps into the supported range, and a
 * non-number falls back to 100%, mirroring `normalizePreferences`.
 */
export function uiScaleToZoomFactor(uiScale: number | undefined): number {
  if (typeof uiScale !== 'number' || !Number.isFinite(uiScale)) {
    return UI_SCALE_DEFAULT / 100;
  }
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, uiScale)) / 100;
}

/**
 * `webPreferences` fragment for a window created while `uiScale` is in
 * effect, so its first navigation is zoomed before the first paint.
 */
export function uiZoomWebPreferences(
  uiScale: number | undefined,
): Pick<Electron.WebPreferences, 'zoomFactor'> {
  return { zoomFactor: uiScaleToZoomFactor(uiScale) };
}

/**
 * The logical minimum that keeps a window's 100% minimum in CSS px at
 * `zoomFactor`: `base × zoom`, rounded up, and capped to the work area of
 * the window's display so a large zoom on a small screen never demands a
 * window the screen cannot hold.
 */
export function scaledMinimumSize(
  base: WindowMinimumSize,
  zoomFactor: number,
  workArea?: Pick<Rectangle, 'width' | 'height'>,
): WindowMinimumSize {
  const width = Math.ceil(base.width * zoomFactor);
  const height = Math.ceil(base.height * zoomFactor);
  if (!workArea) return { width, height };
  return {
    width: Math.min(width, workArea.width),
    height: Math.min(height, workArea.height),
  };
}

/**
 * Bounds grown to `minimum`, kept inside `workArea` where the growth would
 * push the window past its right or bottom edge. Returns null when the
 * bounds already satisfy the minimum.
 */
export function boundsSatisfyingMinimum(
  bounds: Rectangle,
  minimum: WindowMinimumSize,
  workArea: Rectangle,
): Rectangle | null {
  if (bounds.width >= minimum.width && bounds.height >= minimum.height) {
    return null;
  }
  const width = Math.max(bounds.width, minimum.width);
  const height = Math.max(bounds.height, minimum.height);
  return {
    x: Math.max(
      workArea.x,
      Math.min(bounds.x, workArea.x + workArea.width - width),
    ),
    y: Math.max(
      workArea.y,
      Math.min(bounds.y, workArea.y + workArea.height - height),
    ),
    width,
    height,
  };
}

/**
 * Converts a rectangle in a renderer's CSS px to its window's DIPs. Edges
 * are rounded rather than the size, so two panes that share an edge in CSS
 * still share it after conversion.
 */
export function cssRectToWindowDips(
  rect: Rectangle,
  zoomFactor: number,
): Rectangle {
  const left = Math.round(rect.x * zoomFactor);
  const top = Math.round(rect.y * zoomFactor);
  return {
    x: left,
    y: top,
    width: Math.round((rect.x + rect.width) * zoomFactor) - left,
    height: Math.round((rect.y + rect.height) * zoomFactor) - top,
  };
}

function workAreaFor(window: ZoomableBrowserWindow): Rectangle {
  return screen.getDisplayMatching(window.getBounds()).workArea;
}

/**
 * Records a window's 100% minimum so zoom changes can rescale it. The caller
 * creates the window with {@link scaledMinimumSize} of the current zoom; this
 * only makes later zoom changes follow.
 */
export function registerUiZoomMinimumSize(
  window: ZoomableBrowserWindow,
  base: WindowMinimumSize,
): void {
  baseMinimumSizes.set(window, base);
}

/**
 * Makes the window's macOS traffic lights follow the zoom. The lights are OS
 * chrome the page zoom cannot move, so a window whose titlebar row cannot
 * hold them at every zoom registers where they belong instead
 * (`macWindowButtonPosition` for the main window). The caller creates the
 * window with the current zoom's position as `trafficLightPosition`.
 */
export function registerUiZoomWindowButtons(
  window: ZoomableBrowserWindow,
  positionForZoom: WindowButtonPositionForZoom,
): void {
  windowButtonPositions.set(window, positionForZoom);
}

/**
 * Applies `zoomFactor` to one window, skipping windows that are gone. A
 * window with registered traffic lights has them moved for the new zoom. A
 * window with a registered minimum also gets its minimum rescaled, and is
 * grown to it when the zoom made it too small; maximized and full-screen
 * windows already fill their display and are left alone.
 */
export function applyUiZoomToWindow(
  window: ZoomableBrowserWindow,
  zoomFactor: number,
): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.setZoomFactor(zoomFactor);
  const buttonPosition = windowButtonPositions.get(window);
  if (buttonPosition) {
    window.setWindowButtonPosition?.(buttonPosition(zoomFactor));
  }
  const base = baseMinimumSizes.get(window);
  if (!base) return;
  const workArea = workAreaFor(window);
  const minimum = scaledMinimumSize(base, zoomFactor, workArea);
  window.setMinimumSize(minimum.width, minimum.height);
  if (window.isMaximized() || window.isFullScreen()) return;
  const grown = boundsSatisfyingMinimum(window.getBounds(), minimum, workArea);
  if (grown) window.setBounds(grown);
}

/**
 * Applies the scale saved now to a window that just loaded, for windows built
 * from options captured earlier. Unreadable preferences mean 100%.
 */
export async function applySavedUiZoom(
  window: ZoomableBrowserWindow,
  readUiScale: () => Promise<number | undefined>,
): Promise<void> {
  const uiScale = await readUiScale().catch(() => undefined);
  applyUiZoomToWindow(window, uiScaleToZoomFactor(uiScale));
}

interface ZoomableContents {
  isDestroyed(): boolean;
  setZoomFactor(factor: number): void;
}

/**
 * App pages hosted in views rather than windows (the early access App
 * Advisor panel), with what to do after each zoom change.
 */
const zoomedContents = new Map<
  ZoomableContents,
  (zoomFactor: number) => void
>();

/**
 * Zooms a page that no window owns along with the app windows. `onZoom` runs
 * after each change (to refit the view hosting it). Registration ends when
 * the returned function is called.
 */
export function registerUiZoomContents(
  contents: ZoomableContents,
  onZoom: (zoomFactor: number) => void,
): () => void {
  zoomedContents.set(contents, onZoom);
  return (): void => {
    zoomedContents.delete(contents);
  };
}

/** Applies `zoomFactor` to every open app window and registered page. */
export function applyUiZoomToAllWindows(zoomFactor: number): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (isVisualPreviewWindow(window)) continue;
    applyUiZoomToWindow(window, zoomFactor);
  }
  for (const [contents, onZoom] of Array.from(zoomedContents)) {
    if (contents.isDestroyed()) {
      zoomedContents.delete(contents);
      continue;
    }
    contents.setZoomFactor(zoomFactor);
    onZoom(zoomFactor);
  }
}
