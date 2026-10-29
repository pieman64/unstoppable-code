/**
 * Keyboard-target predicates shared by the desktop renderer's shortcut
 * routing and the web shell's find shortcut (CAN-3048). Structural checks
 * rather than `instanceof`, so targets from a popped-out panel window (another
 * realm) still qualify.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ClosestCapableTarget {
  closest: (selector: string) => unknown;
}

interface OwnerDocumentCapableTarget {
  ownerDocument: Document;
}

/**
 * Structural `Element`-ish check for an `EventTarget`.
 *
 * Shared by every shortcut-routing predicate in the app so target narrowing
 * happens in one place, as a type guard rather than an `as` cast (CAN-2309).
 * It is deliberately structural: an `instanceof Element` test is realm-bound
 * and returns false for targets originating in a popped-out panel window.
 */
export function hasClosestMethod(
  value: unknown,
): value is ClosestCapableTarget {
  return isRecord(value) && typeof value.closest === 'function';
}

function hasOwnerDocument(value: unknown): value is OwnerDocumentCapableTarget {
  return isRecord(value) && isRecord(value.ownerDocument);
}

/**
 * The document owning an event target, or `null` when the target has none
 * (the `Document` itself, or `window`). Structural for the realm reason
 * above — `instanceof Document` would silently report the main document for a
 * popped-out panel window's nodes.
 */
export function readTargetOwnerDocument(
  value: EventTarget | null,
): Document | null {
  return hasOwnerDocument(value) ? value.ownerDocument : null;
}

interface UserAgentDataLike {
  platform?: string;
}

interface NavigatorWithUserAgentData extends Navigator {
  userAgentData?: UserAgentDataLike;
}

function readUserAgentDataPlatform(nav: Navigator): string | undefined {
  const navigatorWithUserAgentData: NavigatorWithUserAgentData = nav;
  const platform = navigatorWithUserAgentData.userAgentData?.platform;
  return typeof platform === 'string' ? platform : undefined;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const platform =
    readUserAgentDataPlatform(navigator) ?? navigator.platform ?? '';
  return platform.toLowerCase().includes('mac');
}

export interface ShortcutEventLike {
  altKey: boolean;
  code?: string;
  ctrlKey: boolean;
  isComposing: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

export function isShortcutEvent(
  event: ShortcutEventLike,
  key: string,
  opts?: { shift?: boolean; alt?: boolean },
): boolean {
  if (event.isComposing) {
    return false;
  }

  // Alt participates as an explicit opt-in modifier. Only non-character keys
  // (arrows) should bind with alt: on macOS, Option+<letter> composes special
  // characters and changes `event.key`.
  const expectsAlt = opts?.alt === true;
  if (event.altKey !== expectsAlt) {
    return false;
  }

  const expectsShift = opts?.shift === true;
  if (event.shiftKey !== expectsShift) {
    return false;
  }

  const normalizedKey = event.key.toLowerCase();
  if (normalizedKey !== key.toLowerCase()) {
    return false;
  }

  return isMacPlatform()
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/**
 * True when the event target sits inside a modal dialog (Quick Prompt,
 * review/plan search overlays, task forms, ...). Used by the global shortcut
 * handler: chords that deliberately run before the editable-target guard
 * (⌘1–9/T/N/W) must not fire from a dialog's editor — they would mutate or
 * navigate the page hidden behind the overlay.
 */
export function isDialogTarget(target: EventTarget | null): boolean {
  if (!hasClosestMethod(target)) {
    return false;
  }

  return target.closest('[role="dialog"], [aria-modal="true"]') !== null;
}
