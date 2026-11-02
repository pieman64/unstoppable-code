/**
 * Marks the element a just-opened copy focused (CAN-4782) until it blurs.
 *
 * A Cowork copy's chat composer mounts after the copy's provenance line has
 * focus, and the composer focuses itself whenever the selection or tab
 * changes. Without this mark it would take focus straight back. Only that
 * automatic focus defers to the mark; anything the user does still moves
 * focus normally.
 */
const FORKED_CONTAINER_FOCUS_ATTRIBUTE = 'data-forked-container-focus';

/** Focus `target` for an opened copy; `true` when focus landed. */
export function focusForkedContainerTarget(target: HTMLElement): boolean {
  target.setAttribute(FORKED_CONTAINER_FOCUS_ATTRIBUTE, '');
  target.addEventListener(
    'blur',
    (): void => target.removeAttribute(FORKED_CONTAINER_FOCUS_ATTRIBUTE),
    { once: true },
  );
  target.focus({ preventScroll: true });
  if (target.ownerDocument.activeElement === target) return true;
  target.removeAttribute(FORKED_CONTAINER_FOCUS_ATTRIBUTE);
  return false;
}

/** An opened copy still holds the focus it was given. */
export function hasForkedContainerFocus(doc: Document): boolean {
  return (
    doc.activeElement?.hasAttribute(FORKED_CONTAINER_FOCUS_ATTRIBUTE) === true
  );
}
