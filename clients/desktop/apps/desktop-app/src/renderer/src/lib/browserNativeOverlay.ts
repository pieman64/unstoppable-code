import { ABOVE_BROWSER_ATTRIBUTE } from '@canopy/ui-shared/lib/above-browser';

export const BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE =
  'data-canopy-browser-native-overlay';

/**
 * The design system's floating z-index layers (`--z-index-*` in
 * canopy-tokens.css), everything above `sticky`. A surface on one of these
 * layers floats over the page, so it blocks the native Browser view by
 * default: a new popover, tooltip or dialog needs no marker of its own.
 */
export const BROWSER_NATIVE_VIEW_OVERLAY_LAYERS = [
  'drawer',
  'modal',
  'dropdown',
  'toast',
  'tooltip',
  'spotlight',
] as const;

/**
 * What counts as an overlay: any floating layer, the menu and dialog roles
 * (surfaces that set their z-index another way), and an explicit
 * `data-canopy-browser-native-overlay="true"` for anything else. The same
 * attribute set to `"false"` opts a surface out. The nearest element carrying
 * the attribute (the element itself or an ancestor) decides, so a `"true"`
 * inside a `"false"` region counts again.
 */
export const BROWSER_NATIVE_VIEW_OVERLAY_SELECTOR = [
  `[${BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE}="true"]`,
  '[aria-modal="true"]',
  '[role="dialog"]',
  '[role="listbox"]',
  '[role="menu"]',
  // A layer is a `z-*` class or an inline `z-index: var(--z-index-*)`.
  ...BROWSER_NATIVE_VIEW_OVERLAY_LAYERS.flatMap((layer) => [
    `.z-${layer}`,
    `[style*="--z-index-${layer}"]`,
  ]),
].join(', ');

const BROWSER_NATIVE_VIEW_OVERLAY_MARKER_SELECTOR = `[${BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE}]`;

/**
 * Marks an area where a native Browser view can be shown (`"true"`). The
 * notification corner's overlay layer only lifts toasts above such an area.
 */
export const BROWSER_NATIVE_VIEW_AVAILABLE_ATTRIBUTE =
  'data-browser-native-view-available';

/**
 * `"true"` on a Browser page area while an overlay covers it. Set by the
 * pane's own overlay check, in the frame it runs in.
 */
export const BROWSER_NATIVE_VIEW_COVERED_ATTRIBUTE =
  'data-browser-native-view-covered';

/**
 * `"true"` on a Browser page area while its freeze frame stands in for the
 * live view. While a page is covered but not frozen yet, the above-browser
 * mirror draws its overlays over the live page, so the live view never cuts
 * one off while a frame is captured.
 */
export const BROWSER_NATIVE_VIEW_FROZEN_ATTRIBUTE =
  'data-browser-native-view-frozen';

/**
 * Dispatched on `window` when a page area's covered or frozen state changes.
 * Not part of the observed overlay topology, so it never re-tests the panes.
 */
export const BROWSER_NATIVE_VIEW_COVER_CHANGED_EVENT =
  'canopy:browser-native-view-cover-changed';

const HIDDEN_ATTRIBUTE_SELECTOR = '[hidden], [inert], [aria-hidden="true"]';

const ABOVE_BROWSER_SELECTOR = `[${ABOVE_BROWSER_ATTRIBUTE}]`;

// Whether the above-browser mirror is drawing marked elements over pages.
// While it is, those elements need no freeze frame; once it cannot (no layer
// on this page), they count as overlays again.
let aboveBrowserMirrorActive = false;
// The page area the mirror draws over, or `null` while it draws nothing. A
// marked element still counts as an overlay for any other page, since the
// layer covers one page only.
let aboveBrowserMirrorPage: BrowserNativeViewOverlayTargetRect | null = null;

/** Set by the above-browser mirror; re-tests every pane on a change. */
export function setAboveBrowserMirrorActive(active: boolean): void {
  if (aboveBrowserMirrorActive === active) {
    return;
  }
  aboveBrowserMirrorActive = active;
  notifyBrowserOverlayTopologyChanged();
}

/** Set by the above-browser mirror; re-tests every pane on a change. */
export function setAboveBrowserMirrorPage(
  page: BrowserNativeViewOverlayTargetRect | null,
): void {
  const current = aboveBrowserMirrorPage;
  if (
    current === page ||
    (current !== null &&
      page !== null &&
      current.left === page.left &&
      current.top === page.top &&
      current.right === page.right &&
      current.bottom === page.bottom)
  ) {
    return;
  }
  aboveBrowserMirrorPage = page;
  notifyBrowserOverlayTopologyChanged();
}

/** Whether marked elements over `targetRect` are the mirror's to draw. */
function mirrorDraws(
  targetRect: BrowserNativeViewOverlayTargetRect | null,
): boolean {
  return (
    aboveBrowserMirrorActive &&
    (targetRect === null ||
      aboveBrowserMirrorPage === null ||
      rectsOverlap(targetRect, aboveBrowserMirrorPage))
  );
}

/**
 * Whether the nearest `data-canopy-browser-native-overlay` marker (on the
 * element or an ancestor) opts the element out. An element without a marker
 * ancestor keeps its default.
 */
function isOptedOutOfNativeOverlay(element: Element): boolean {
  return (
    element
      .closest(BROWSER_NATIVE_VIEW_OVERLAY_MARKER_SELECTOR)
      ?.getAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE) === 'false'
  );
}

interface BrowserNativeViewOverlayTargetRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function isElementVisibleForNativeOverlay(
  element: Element,
  skipMarked: boolean,
): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected) {
    return false;
  }

  if (
    element.closest(HIDDEN_ATTRIBUTE_SELECTOR) ||
    isOptedOutOfNativeOverlay(element) ||
    (skipMarked && element.closest(ABOVE_BROWSER_SELECTOR))
  ) {
    return false;
  }

  let current: HTMLElement | null = element;
  while (current) {
    const style = window.getComputedStyle(current);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    ) {
      return false;
    }
    current = current.parentElement;
  }

  return true;
}

function rectsOverlap(
  a: BrowserNativeViewOverlayTargetRect,
  b: BrowserNativeViewOverlayTargetRect,
): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) {
    return false;
  }
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}

function intersectsTargetRect(
  element: HTMLElement,
  targetRect: BrowserNativeViewOverlayTargetRect | null,
): boolean {
  if (targetRect === null) {
    return true;
  }
  return rectsOverlap(element.getBoundingClientRect(), targetRect);
}

export function hasBrowserNativeViewOverlay(
  root: ParentNode = document,
  targetRect: BrowserNativeViewOverlayTargetRect | null = null,
): boolean {
  const skipMarked = mirrorDraws(targetRect);
  return Array.from(
    root.querySelectorAll(BROWSER_NATIVE_VIEW_OVERLAY_SELECTOR),
  ).some(
    (element) =>
      isElementVisibleForNativeOverlay(element, skipMarked) &&
      intersectsTargetRect(element, targetRect),
  );
}

/**
 * The outermost overlays (as {@link hasBrowserNativeViewOverlay} counts them)
 * that intersect `targetRect`; an overlay inside another is left out.
 */
export function findBrowserNativeViewOverlays(
  root: ParentNode,
  targetRect: BrowserNativeViewOverlayTargetRect,
): HTMLElement[] {
  const skipMarked = mirrorDraws(targetRect);
  const overlays = Array.from(
    root.querySelectorAll(BROWSER_NATIVE_VIEW_OVERLAY_SELECTOR),
  ).filter(
    (element): element is HTMLElement =>
      isElementVisibleForNativeOverlay(element, skipMarked) &&
      intersectsTargetRect(element, targetRect),
  );
  return overlays.filter(
    (element) =>
      !overlays.some((other) => other !== element && other.contains(element)),
  );
}

// ---------------------------------------------------------------------------
// Shared overlay-topology observation (ref-counted)
// ---------------------------------------------------------------------------
//
// Multiple Browser panes may be mounted simultaneously (side-by-side
// panels). Each pane independently tests blocking-overlay intersection
// against ITS OWN rectangle, but they all watch the same document body for
// overlay topology changes — so exactly ONE `MutationObserver` is shared and
// ref-counted across subscribers. Unmounting one pane must not disconnect
// observation while other panes remain subscribed.

type OverlayTopologyListener = () => void;

const overlayTopologyListeners = new Set<OverlayTopologyListener>();
let overlayTopologyObserver: MutationObserver | null = null;

const OVERLAY_OBSERVED_ATTRIBUTES = [
  'aria-hidden',
  'aria-modal',
  ABOVE_BROWSER_ATTRIBUTE,
  'class',
  BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE,
  BROWSER_NATIVE_VIEW_AVAILABLE_ATTRIBUTE,
  'hidden',
  'role',
  'style',
];

function notifyOverlayTopologyListeners(): void {
  for (const listener of Array.from(overlayTopologyListeners)) {
    listener();
  }
}

/** Re-runs every subscriber, for a change the DOM observer cannot see. */
export function notifyBrowserOverlayTopologyChanged(): void {
  notifyOverlayTopologyListeners();
}

/**
 * Subscribe to document-body overlay topology changes. The underlying
 * `MutationObserver` is created for the first subscriber and disconnected
 * only when the LAST subscriber unsubscribes. Returns an unsubscribe fn.
 */
export function subscribeBrowserOverlayTopology(
  listener: OverlayTopologyListener,
): () => void {
  overlayTopologyListeners.add(listener);
  if (
    overlayTopologyObserver === null &&
    typeof MutationObserver !== 'undefined' &&
    typeof document !== 'undefined' &&
    document.body
  ) {
    overlayTopologyObserver = new MutationObserver(
      notifyOverlayTopologyListeners,
    );
    overlayTopologyObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: OVERLAY_OBSERVED_ATTRIBUTES,
    });
  }
  let unsubscribed = false;
  return (): void => {
    if (unsubscribed) {
      return;
    }
    unsubscribed = true;
    overlayTopologyListeners.delete(listener);
    if (overlayTopologyListeners.size === 0 && overlayTopologyObserver) {
      overlayTopologyObserver.disconnect();
      overlayTopologyObserver = null;
    }
  };
}
