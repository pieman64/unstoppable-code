import type { WebContents } from 'electron';

type PermissionDeniedListener = (
  contents: WebContents,
  permission: string,
) => void;

const listeners = new Set<PermissionDeniedListener>();

/**
 * The in-app browser's permission policy: every request is denied. Each
 * denial is reported so an agent's action can list it in
 * `effects.permissionDenied` (CAN-1570 phase 09c).
 */
export function denyPermission(
  contents: WebContents,
  permission: string,
  callback: (granted: boolean) => void,
): void {
  callback(false);
  for (const listener of Array.from(listeners)) listener(contents, permission);
}

export function onPermissionDenied(
  listener: PermissionDeniedListener,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}
