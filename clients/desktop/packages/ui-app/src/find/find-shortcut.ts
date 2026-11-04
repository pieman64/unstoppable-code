/**
 * Cmd/Ctrl+F routing for the floating find bar (CAN-3048).
 *
 * The surface that owns the keydown target picks the bar's mode: the browser
 * chrome (`[data-browser-surface]`), else the nearest `[data-find-surface]`
 * marker (chat transcripts, file previews, plans, diagrams, and terminals),
 * else a host-provided fallback (the active panel group). Keydowns inside
 * the native browser page never reach the renderer; the main process
 * forwards those as a `find-in-page` browser shortcut event.
 */
import {
  hasClosestMethod,
  isShortcutEvent,
  readTargetOwnerDocument,
  type ShortcutEventLike,
} from './shortcut-target';
import {
  SURFACE_FIND_BAR_SELECTOR,
  findControllerKey,
  useSurfaceFindStore,
  type FindSurfaceMode,
} from './surface-find-store';

export interface FindTarget {
  mode: FindSurfaceMode;
  scopeKey: string;
}

export interface FindShortcutEvent extends ShortcutEventLike {
  preventDefault: () => void;
  target: EventTarget | null;
  defaultPrevented?: boolean;
}

const FIND_SURFACE_SELECTOR = '[data-find-surface], [data-browser-surface]';

/** Structural so elements of a popped-out panel window qualify too. */
function isElementLike(value: unknown): value is Element {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getAttribute' in value &&
    typeof value.getAttribute === 'function'
  );
}

function parseFindMode(value: string | null): FindSurfaceMode | null {
  switch (value) {
    case 'chat':
    case 'browser':
    case 'file':
    case 'plan':
    case 'diagram':
    case 'terminal':
      return value;
    default:
      return null;
  }
}

/** Reads the find target a surface marker element declares. */
export function readFindSurfaceElement(element: Element): FindTarget | null {
  if (element.hasAttribute('data-browser-surface')) {
    const browserId = element.getAttribute('data-browser-id');
    return browserId ? { mode: 'browser', scopeKey: browserId } : null;
  }
  const mode = parseFindMode(element.getAttribute('data-find-surface'));
  const scopeKey = element.getAttribute('data-find-scope');
  return mode !== null && scopeKey ? { mode, scopeKey } : null;
}

function isRegistered(target: FindTarget | null): target is FindTarget {
  return (
    target !== null &&
    useSurfaceFindStore.getState().hasController(target.mode, target.scopeKey)
  );
}

/**
 * The find target owning `target`: the open bar's own scope (a repeated
 * shortcut from inside the bar), the browser chrome, the nearest find
 * marker, or `fallback()`.
 */
export function resolveFindTarget(
  target: EventTarget | null,
  fallback: () => FindTarget | null,
): FindTarget | null {
  if (hasClosestMethod(target)) {
    if (isElementLike(target.closest(SURFACE_FIND_BAR_SELECTOR))) {
      const state = useSurfaceFindStore.getState();
      const scopeKey =
        state.mode === null ? undefined : state.activeScope[state.mode];
      if (state.open && state.mode !== null && scopeKey !== undefined) {
        return { mode: state.mode, scopeKey };
      }
    }
    const browser = target.closest('[data-browser-surface]');
    if (isElementLike(browser)) {
      return readFindSurfaceElement(browser);
    }
    const surface = target.closest('[data-find-surface]');
    if (isElementLike(surface)) {
      return readFindSurfaceElement(surface);
    }
  }
  return fallback();
}

/**
 * Fallback for a keydown that no surface owns (focus on the page body or on
 * panel chrome): the registered surface inside the active panel group, or
 * nothing when that group has none. Without a panel grid, the only
 * registered surface in the document (hidden surfaces are unregistered).
 */
export function resolveFallbackFindTarget(
  doc: Document,
  activeGroupId: string | null,
): FindTarget | null {
  if (activeGroupId !== null) {
    const group = doc.querySelector(
      `[data-testid="panel-group-${activeGroupId}"]`,
    );
    for (const element of Array.from(
      group?.querySelectorAll(FIND_SURFACE_SELECTOR) ?? [],
    )) {
      const candidate = readFindSurfaceElement(element);
      if (isRegistered(candidate)) return candidate;
    }
    return null;
  }
  const registered = Array.from(doc.querySelectorAll(FIND_SURFACE_SELECTOR))
    .map(readFindSurfaceElement)
    .filter(isRegistered);
  return registered.length === 1 ? registered[0] : null;
}

/**
 * Handles Cmd/Ctrl+F. Returns whether the bar opened (and the event was
 * claimed). Leaves the event untouched when another handler already claimed
 * it or no searchable surface resolves. Dialogs can search only their own
 * explicitly registered surfaces, never a background fallback.
 */
export function runFindShortcut(
  event: FindShortcutEvent,
  fallback: () => FindTarget | null,
): boolean {
  if (!isShortcutEvent(event, 'f')) return false;
  if (event.defaultPrevented === true) {
    return false;
  }
  const dialog = hasClosestMethod(event.target)
    ? event.target.closest('[role="dialog"], [aria-modal="true"]')
    : null;
  const target = resolveFindTarget(
    event.target,
    dialog ? (): null => null : fallback,
  );
  if (!isRegistered(target)) return false;
  if (dialog) {
    const controller =
      useSurfaceFindStore.getState().controllers[
        findControllerKey(target.mode, target.scopeKey)
      ]?.controller;
    if (
      controller?.anchor.closest('[role="dialog"], [aria-modal="true"]') !==
      dialog
    )
      return false;
  }
  event.preventDefault();
  const doc = readTargetOwnerDocument(event.target) ?? document;
  useSurfaceFindStore
    .getState()
    .openFor(target.mode, target.scopeKey, doc.activeElement);
  return true;
}
