/**
 * Whether this window can use the in-app browser.
 *
 * A window that shows another computer runs this renderer against that
 * computer's main process, but the in-app browser is a native view on the
 * computer the user sits at: its channels are `blocked` in the remote-control
 * disposition table, so a session can never be created or shown there. A
 * Browser tab placed in such a window would stay broken and, because panel
 * layouts tunnel, be saved into the other computer's layout.
 *
 * The answer is derived from the disposition table rather than hard-coded, so
 * the gate lifts on its own if the browser channels are ever tunneled.
 */
import { IPC_REMOTE_DISPOSITIONS } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import type { ScriptDevServerOpenTarget } from '@canopy/desktop-shared/scripts';
import { readRemoteControlContext } from '@/stores/remoteControlStore';

/** True unless this window shows another computer that cannot host a browser. */
export function isInAppBrowserAvailable(): boolean {
  if (readRemoteControlContext().mode !== 'remote') {
    return true;
  }
  return IPC_REMOTE_DISPOSITIONS.browserCreate === 'tunnel';
}

/**
 * True unless this window shows another computer whose system-browser open
 * is unavailable. Dev-server URLs from that computer are its local servers,
 * which this computer usually cannot reach either.
 */
export function isExternalBrowserOpenAvailable(): boolean {
  if (readRemoteControlContext().mode !== 'remote') {
    return true;
  }
  return IPC_REMOTE_DISPOSITIONS.browserOpenExternal === 'tunnel';
}

/**
 * Whether a URL can be opened in `target` from this window. A window that
 * shows another computer opens no fallback for an unavailable in-app target:
 * the URL names that computer's local server.
 */
export function isBrowserOpenTargetAvailable(
  target: ScriptDevServerOpenTarget,
): boolean {
  return target === 'external'
    ? isExternalBrowserOpenAvailable()
    : isInAppBrowserAvailable();
}
