import {
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type WebContents,
} from 'electron';

/**
 * Device-to-device remote control: when the request came from a paired
 * computer's bridge, the picker is shown on that computer instead of this
 * one. Returns null for ordinary senders.
 */
export type RemoteOpenDialogProvider = (
  sender: WebContents,
  options: OpenDialogOptions,
) => Promise<OpenDialogReturnValue> | null;

let remoteOpenDialogProvider: RemoteOpenDialogProvider | null = null;

export function setRemoteOpenDialogProvider(
  provider: RemoteOpenDialogProvider | null,
): void {
  remoteOpenDialogProvider = provider;
}

/** The paired computer's picker when the request came from its bridge. */
export function showRemoteOpenDialogForEvent(
  event: Pick<IpcMainInvokeEvent, 'sender'> | undefined,
  options: OpenDialogOptions,
): Promise<OpenDialogReturnValue> | null {
  if (!event || !remoteOpenDialogProvider) return null;
  return remoteOpenDialogProvider(event.sender, options);
}

/**
 * Resolve the window an IPC request came from, so a dialog raised in response
 * to it can be owned by that window. Returns `null` when the sender's window
 * has already gone away (a panel closed while its request was in flight).
 */
export function resolveDialogParentWindow(
  event: Pick<IpcMainInvokeEvent, 'sender'> | undefined,
): BrowserWindow | null {
  if (!event) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  return win && !win.isDestroyed() ? win : null;
}

/**
 * Raise an open panel owned by the window that asked for it.
 *
 * An unparented `dialog.showOpenDialog` is application-modal and floats free of
 * the app: macOS centers it on the screen rather than presenting it as a
 * window-modal sheet over Canopy, so it opens visibly off-axis (CAN-2706).
 * Parenting also keeps the panel attached to the correct window when the
 * request comes from an auxiliary panel window rather than the main one.
 */
export function showOpenDialogForEvent(
  event: Pick<IpcMainInvokeEvent, 'sender'> | undefined,
  options: OpenDialogOptions,
): Promise<OpenDialogReturnValue> {
  const remote = showRemoteOpenDialogForEvent(event, options);
  if (remote) return remote;
  const parent = resolveDialogParentWindow(event);
  return parent
    ? dialog.showOpenDialog(parent, options)
    : dialog.showOpenDialog(options);
}

/**
 * Pick one or more files through a window-owned open panel. Returns an empty
 * array when the user cancels, so callers can treat "cancelled" and "picked
 * nothing" identically.
 */
export async function chooseFilesForEvent(
  event: Pick<IpcMainInvokeEvent, 'sender'> | undefined,
  title: string,
): Promise<string[]> {
  const result = await showOpenDialogForEvent(event, {
    title,
    properties: ['openFile', 'multiSelections'],
  });
  return result.canceled ? [] : result.filePaths;
}

/**
 * Pick a single directory through a window-owned open panel, allowing the user
 * to create one. Returns `null` when the user cancels.
 */
export async function chooseDirectoryForEvent(
  event: Pick<IpcMainInvokeEvent, 'sender'> | undefined,
  title: string,
): Promise<string | null> {
  const result = await showOpenDialogForEvent(event, {
    title,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
}
