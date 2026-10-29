// ---------------------------------------------------------------------------
// Browser address-bar focus bus (renderer)
// ---------------------------------------------------------------------------
//
// A tiny module-level pub/sub (mirroring `browserDrawerActivation`) used to
// ask a mounted `BrowserBar` to focus + select its URL input. Callers are the
// browser hotkey paths (ECW-7984): the main process forwards Cmd/Ctrl+T and
// Cmd/Ctrl+L pressed inside the native page, and the renderer's global
// shortcut handler routes the same chords when browser chrome owns focus.
//
// The target bar may not be mounted yet when the request fires (a brand-new
// browser tab renders on the next commit), so the last request is retained as
// `pending` and consumed by the bar on mount.

type Listener = (browserId: string) => void;

const listeners = new Set<Listener>();
let pendingBrowserId: string | null = null;

/** Ask the `BrowserBar` owning `browserId` to focus + select its URL input. */
export function requestBrowserUrlFocus(browserId: string): void {
  pendingBrowserId = browserId;
  listeners.forEach((listener) => {
    listener(browserId);
  });
}

/** Subscribe to address-bar focus requests. Returns an unsubscribe fn. */
export function subscribeBrowserUrlFocus(listener: Listener): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/**
 * Claims the pending focus request for `browserId`. Returns true when the
 * caller should focus its URL input (at most one claimant wins).
 */
export function consumePendingBrowserUrlFocus(browserId: string): boolean {
  if (pendingBrowserId !== browserId) {
    return false;
  }
  pendingBrowserId = null;
  return true;
}
