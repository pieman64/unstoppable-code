import type {
  RemoteControlDevice,
  RemoteControlHost,
} from '@canopy/desktop-shared/types';
import type { DotTone } from '@canopy/ui-shared/components';

/**
 * Copy shared by the remote access surfaces (sidebar machine picker, Settings
 * → Remote access, pairing dialogs). The feature is "Remote access" in the
 * UI so it never shares a name with the Portal's Remote Control.
 */
export const REMOTE_ACCESS_LABEL = 'Remote access';
export const ADD_COMPUTER_LABEL = 'Add a computer…';
export const THIS_COMPUTER_LABEL = 'This computer';
export const COMPUTERS_LABEL = 'Computers';
export const CONTROL_RISK_SENTENCE =
  'can see and change everything on this computer, including running commands';

type DevicePlatform = RemoteControlDevice['platform'];

const PLATFORM_LABELS: Record<DevicePlatform, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

export function platformLabel(platform: DevicePlatform): string {
  return PLATFORM_LABELS[platform];
}

/** `123456` → `123 456`, so the two halves are easy to compare aloud. */
export function formatPairingCode(code: string): string {
  const digits = code.replace(/\s+/g, '');
  if (digits.length !== 6) return digits;
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export type RemoteHostTone = 'connected' | 'pending' | 'failed' | 'idle';

export interface RemoteHostStatus {
  readonly label: string;
  readonly tone: RemoteHostTone;
}

/** What a paired computer is doing right now, in one short label. */
export function remoteHostStatus(
  host: Pick<RemoteControlHost, 'online' | 'connection'>,
): RemoteHostStatus {
  switch (host.connection) {
    case 'connected':
      return { label: 'Connected', tone: 'connected' };
    case 'connecting':
      return { label: 'Connecting…', tone: 'pending' };
    case 'error':
      return { label: "Can't connect", tone: 'failed' };
    case 'idle':
      return host.online
        ? { label: 'Online', tone: 'idle' }
        : { label: 'Offline', tone: 'idle' };
  }
}

/**
 * The connection Dot for a host tone: green when connected, red when it
 * can't connect; `null` when the label alone says it (connecting, idle).
 */
export function remoteHostDotTone(tone: RemoteHostTone): DotTone | null {
  switch (tone) {
    case 'connected':
      return 'success';
    case 'failed':
      return 'danger';
    case 'pending':
    case 'idle':
      return null;
  }
}

/** The message of a rejected action, for inline error lines. */
export function describeError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}
