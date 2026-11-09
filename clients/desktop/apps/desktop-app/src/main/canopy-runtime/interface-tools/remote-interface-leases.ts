import type { InterfaceToolName } from '@canopy/protocol/canopy-core';
import type { RemoteSurface } from '@canopy/desktop-shared/remote-control/surfaces';
import type { DesktopInterfaceLeases } from './desktop-interface-leases';

/**
 * CAN-5823: the catalog tools a controller's window implements on each remote
 * surface, over channels remote control tunnels. A session is admitted only
 * when both computers speak the same remote protocol version, which fixes
 * these. The Pipeline Editor's tools are absent: their channels are not
 * tunneled.
 */
export const REMOTE_SURFACE_INTERFACE_TOOLS: Readonly<
  Record<RemoteSurface, readonly InterfaceToolName[]>
> = {
  main: ['ui.app_advisor.present', 'ui.get_current_ui_state', 'ui.show_files'],
  'app-advisor': ['ui.app_advisor.show_files'],
};

type RemoteLeaseHost = Pick<DesktopInterfaceLeases, 'openRemote' | 'end'>;

let host: RemoteLeaseHost | null = null;

/** Set by the renderer relay host that owns the desktop leases; null on disposal. */
export function setRemoteInterfaceLeaseHost(
  next: RemoteLeaseHost | null,
): void {
  host = next;
}

/**
 * Opens the lease of one controller bridge window. Returns false when no
 * lease host is installed or the registration was refused; the controller's
 * tools are then simply absent.
 */
export function openRemoteInterfaceLease(input: {
  webContentsId: number;
  surface: RemoteSurface;
  controllerDeviceId: string;
}): boolean {
  if (!host) return false;
  try {
    host.openRemote({
      ...input,
      tools: REMOTE_SURFACE_INTERFACE_TOOLS[input.surface],
    });
    return true;
  } catch {
    return false;
  }
}

/** Ends a bridge window's lease, failing its pending calls. */
export function endRemoteInterfaceLease(webContentsId: number): void {
  host?.end(webContentsId);
}
