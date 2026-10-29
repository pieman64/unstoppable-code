/**
 * Swallow the `click` that completes an outside-dismiss press.
 *
 * Menus close on `mousedown`/`pointerdown` outside their surface, but the
 * same press still delivers a `click` to whatever sits under the pointer —
 * selecting a row or pushing a button the user only meant to dismiss with.
 * Call this from the dismiss handler to trap exactly one subsequent click at
 * the document capture phase; a short timer drops the trap if no click
 * follows (e.g. the press turned into a drag out of the window).
 */
export function suppressNextClick(doc: Document): void {
  let armingPressEnded = false;
  const handler = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    remove();
  };
  const markPressEnd = (): void => {
    armingPressEnded = true;
  };
  // The arming press itself dispatches further pointer/mouse events
  // (pointerdown → mousedown → mouseup → click); only a press that starts
  // AFTER the arming press's mouseup means the swallowed click never came
  // (drag-out, focus steal) — disarm so that new press clicks normally.
  const disarmOnNewPress = (): void => {
    if (armingPressEnded) {
      remove();
    }
  };
  const remove = (): void => {
    doc.removeEventListener('click', handler, true);
    doc.removeEventListener('mouseup', markPressEnd, true);
    doc.removeEventListener('mousedown', disarmOnNewPress, true);
    doc.removeEventListener('pointerdown', disarmOnNewPress, true);
  };
  doc.addEventListener('click', handler, true);
  doc.addEventListener('mouseup', markPressEnd, true);
  doc.addEventListener('mousedown', disarmOnNewPress, true);
  doc.addEventListener('pointerdown', disarmOnNewPress, true);
  doc.defaultView?.setTimeout(remove, 500);
}
