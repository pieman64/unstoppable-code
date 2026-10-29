import {
  IPC_CHANNELS,
  type LaunchAtLoginSetResult,
  type LaunchAtLoginStatus,
} from '@canopy/desktop-shared/types';
import { getLaunchAtLoginService } from '../lifecycle/launch-at-login';
import { registerIpcHandler } from './register';

/**
 * IPC surface for launch at sign-in (CAN-3449). There is no preference to
 * save: `set-enabled` writes to the OS and answers with its read-back, and
 * the service pushes that read-back to every window on
 * `launch-at-login:status-changed`.
 */

export function handleGetLaunchAtLoginStatus(): Promise<LaunchAtLoginStatus> {
  return getLaunchAtLoginService().getStatus();
}

export async function handleSetLaunchAtLoginEnabled(
  value: unknown,
): Promise<LaunchAtLoginSetResult> {
  if (typeof value !== 'boolean') {
    throw new Error(
      'Invalid launch at sign-in request: enabled must be a boolean.',
    );
  }
  return getLaunchAtLoginService().setEnabled(value);
}

export function handleOpenLaunchAtLoginSystemSettings(): Promise<void> {
  return getLaunchAtLoginService().openSystemSettings();
}

export function registerLaunchAtLoginHandlers(): void {
  registerIpcHandler<[], LaunchAtLoginStatus>(
    IPC_CHANNELS.launchAtLoginGetStatus,
    () => handleGetLaunchAtLoginStatus(),
  );
  registerIpcHandler<[unknown], LaunchAtLoginSetResult>(
    IPC_CHANNELS.launchAtLoginSetEnabled,
    (_event, enabled) => handleSetLaunchAtLoginEnabled(enabled),
  );
  registerIpcHandler<[], void>(
    IPC_CHANNELS.launchAtLoginOpenSystemSettings,
    () => handleOpenLaunchAtLoginSystemSettings(),
  );
}
