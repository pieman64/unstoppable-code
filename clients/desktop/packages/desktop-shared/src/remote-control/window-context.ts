import {
  DEVICE_PLATFORMS,
  type DevicePlatform,
} from '@canopy/protocol/device-relay';
import { isRemoteSurface, type RemoteSurface } from './surfaces';

/**
 * How main tells a window's preload that the window shows another computer:
 * one `additionalArguments` entry carrying the computer's identity.
 */
export interface RemoteWindowContext {
  deviceId: string;
  name: string;
  platform: DevicePlatform;
  /** Which of that computer's windows this is; `main` when absent. */
  surface?: RemoteSurface;
}

export const REMOTE_WINDOW_ARGUMENT_PREFIX = '--canopy-remote-window=';

function isDevicePlatform(value: unknown): value is DevicePlatform {
  return DEVICE_PLATFORMS.some((platform) => platform === value);
}

export function encodeRemoteWindowArgument(
  context: RemoteWindowContext,
): string {
  return `${REMOTE_WINDOW_ARGUMENT_PREFIX}${encodeURIComponent(
    JSON.stringify(context),
  )}`;
}

export function readRemoteWindowContext(
  argv: ReadonlyArray<string>,
): RemoteWindowContext | null {
  const argument = argv.find((value) =>
    value.startsWith(REMOTE_WINDOW_ARGUMENT_PREFIX),
  );
  if (!argument) return null;
  try {
    const parsed: unknown = JSON.parse(
      decodeURIComponent(argument.slice(REMOTE_WINDOW_ARGUMENT_PREFIX.length)),
    );
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !('deviceId' in parsed) ||
      !('name' in parsed) ||
      !('platform' in parsed) ||
      typeof parsed.deviceId !== 'string' ||
      typeof parsed.name !== 'string' ||
      !isDevicePlatform(parsed.platform)
    ) {
      return null;
    }
    const surface =
      'surface' in parsed && isRemoteSurface(parsed.surface)
        ? parsed.surface
        : 'main';
    return {
      deviceId: parsed.deviceId,
      name: parsed.name,
      platform: parsed.platform,
      surface,
    };
  } catch {
    return null;
  }
}
