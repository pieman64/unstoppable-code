/**
 * Brings the main window forward when a request came from a popped-out
 * panel (CAN-4072): the Workflows edit shell opens in the main window, so a
 * pop-out's Edit, New or View runs would otherwise land behind it. A request
 * from the main window itself needs nothing. Pop-outs share the main
 * renderer, so `window` is the main window here, as `ChatShareHost` relies on.
 */
export function bringMainWindowForward(
  ownerDocument: Document | null | undefined,
): void {
  if (ownerDocument == null || ownerDocument === document) return;
  window.focus();
}
