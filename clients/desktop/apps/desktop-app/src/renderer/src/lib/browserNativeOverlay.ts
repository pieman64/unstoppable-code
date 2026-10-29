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

const HIDDEN_ATTRIBUTE_SELECTOR = '[hidden], [inert], [aria-hidden="true"]';

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
): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected) {
    return false;
  }

  if (
    element.closest(HIDDEN_ATTRIBUTE_SELECTOR) ||
    isOptedOutOfNativeOverlay(element)
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
  return Array.from(
    root.querySelectorAll(BROWSER_NATIVE_VIEW_OVERLAY_SELECTOR),
  ).some(
    (element) =>
      isElementVisibleForNativeOverlay(element) &&
      intersectsTargetRect(element, targetRect),
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
