/**
 * Whether this window can read or change who may control this computer.
 *
 * A window that shows another computer runs against that computer's main
 * process, but the remote access channels are `local` in the remote-control
 * disposition table: they answer for the computer the user sits at. An action
 * there would report or change the wrong computer's remote access, so it is
 * refused until those channels tunnel.
 */
import { IPC_REMOTE_DISPOSITIONS } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import { readRemoteControlContext } from '@/stores/remoteControlStore';

/** True unless this window shows another computer. */
export function isRemoteAccessSettingAvailable(): boolean {
  if (readRemoteControlContext().mode !== 'remote') {
    return true;
  }
  return (
    IPC_REMOTE_DISPOSITIONS.remoteControlGetState === 'tunnel' &&
    IPC_REMOTE_DISPOSITIONS.remoteControlSetAllowIncoming === 'tunnel'
  );
}
