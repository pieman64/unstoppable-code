import { useEffect, useRef } from 'react';

// Per-document Escape-dismissal stacks shared by every overlay primitive
// (DialogModal, Sheet). Escape must close only the topmost open overlay in the
// document that received the event; auxiliary windows must not block each
// other or the main window.

let nextOverlayId = 0;
const escapeEnabledOverlayStacks = new WeakMap<Document, number[]>();
const overlayGenerations = new WeakMap<Document, number>();
// Stack entries registered with `layer: 'page'`, per document.
const pageLayerOverlays = new WeakMap<Document, Set<number>>();

function getPageLayer(ownerDocument: Document): Set<number> {
  const existing = pageLayerOverlays.get(ownerDocument);
  if (existing) return existing;
  const created = new Set<number>();
  pageLayerOverlays.set(ownerDocument, created);
  return created;
}

function bumpOverlayGeneration(ownerDocument: Document): void {
  overlayGenerations.set(
    ownerDocument,
    (overlayGenerations.get(ownerDocument) ?? 0) + 1,
  );
}

const escapeBoundarySelector = [
  '[data-canopy-escape-boundary="true"]',
  '[role="combobox"][aria-expanded="true"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="tree"]',
  '[role="grid"]',
].join(',');

function getOverlayStack(ownerDocument: Document): number[] {
  const existing = escapeEnabledOverlayStacks.get(ownerDocument);
  if (existing) return existing;
  const created: number[] = [];
  escapeEnabledOverlayStacks.set(ownerDocument, created);
  return created;
}

function addOverlayToStack(
  ownerDocument: Document,
  overlayId: number,
  layer: OverlayEscapeLayer,
): void {
  const stack = getOverlayStack(ownerDocument);
  if (layer === 'page') {
    // A page's own Escape (Back) never sits above a dialog, even when it
    // becomes available while the dialog is open.
    const pages = getPageLayer(ownerDocument);
    pages.add(overlayId);
    const firstOverlay = stack.findIndex((id) => !pages.has(id));
    if (firstOverlay === -1) stack.push(overlayId);
    else stack.splice(firstOverlay, 0, overlayId);
  } else {
    stack.push(overlayId);
  }
  bumpOverlayGeneration(ownerDocument);
}

function removeOverlayFromStack(
  ownerDocument: Document,
  overlayId: number,
): void {
  getPageLayer(ownerDocument).delete(overlayId);
  const stack = getOverlayStack(ownerDocument);
  const index = stack.lastIndexOf(overlayId);
  if (index !== -1) {
    stack.splice(index, 1);
    bumpOverlayGeneration(ownerDocument);
  }
}

function isTopmostEscapeEnabledOverlay(
  ownerDocument: Document,
  overlayId: number,
): boolean {
  const stack = getOverlayStack(ownerDocument);
  return stack[stack.length - 1] === overlayId;
}

/**
 * Changes whenever an overlay that owns Escape opens or closes in this
 * document, so delayed work can tell the user moved on while it waited.
 */
export function overlayGeneration(ownerDocument: Document): number {
  return overlayGenerations.get(ownerDocument) ?? 0;
}

/** Whether this document currently has an overlay that owns Escape. */
export function hasEscapeEnabledOverlay(ownerDocument: Document): boolean {
  return getOverlayStack(ownerDocument).length > 0;
}

function escapeStartedInBoundary(
  target: EventTarget | null,
  ownerDocument: Document,
): boolean {
  const ElementConstructor = ownerDocument.defaultView?.Element;
  return (
    ElementConstructor !== undefined &&
    target instanceof ElementConstructor &&
    target.closest(escapeBoundarySelector) !== null
  );
}

/**
 * `overlay` (the default) joins the top of the stack. `page` is for a page's
 * own Escape, such as Back from a detail sub-page: it joins beneath every
 * overlay, so a dialog open over the page always takes Escape first, even
 * when the page's Escape becomes available after the dialog opened.
 */
export type OverlayEscapeLayer = 'overlay' | 'page';

export interface OverlayEscapeOptions {
  readonly layer?: OverlayEscapeLayer;
}

/**
 * Close an overlay on Escape, but only while it is the topmost Escape-enabled
 * overlay across all primitives in the event's document. Overlays join that
 * document's stack when `enabled` becomes true (typically mount or open) and
 * leave it when `enabled` turns false or on unmount.
 */
export function useOverlayEscape(
  enabled: boolean,
  onClose: () => void,
  ownerDocument?: Document,
  options?: OverlayEscapeOptions,
): void {
  const layer = options?.layer ?? 'overlay';
  const overlayIdRef = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);

  if (overlayIdRef.current === null) {
    nextOverlayId += 1;
    overlayIdRef.current = nextOverlayId;
  }
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!enabled) return;

    const overlayId = overlayIdRef.current;
    if (overlayId === null) return;
    const eventDocument = ownerDocument ?? document;

    addOverlayToStack(eventDocument, overlayId, layer);

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        !isTopmostEscapeEnabledOverlay(eventDocument, overlayId) ||
        escapeStartedInBoundary(event.target, eventDocument)
      ) {
        return;
      }
      event.preventDefault();
      onCloseRef.current();
    };

    eventDocument.addEventListener('keydown', handleKeyDown);
    return (): void => {
      removeOverlayFromStack(eventDocument, overlayId);
      eventDocument.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, layer, ownerDocument]);
}
