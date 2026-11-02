import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import type { PortalClientPlatform } from '@canopy/protocol/portal';

/** Map a host operating-system identifier to the Portal protocol platform. */
export function portalClientPlatformFor(
  os: string,
): PortalClientPlatform | undefined {
  switch (os) {
    case 'darwin':
      return 'mac';
    case 'win32':
      return 'windows';
    case 'linux':
      return 'linux';
    default:
      return undefined;
  }
}

/** Resolve the Portal platform without allowing host detection failures to block a session. */
export function resolvePortalClientPlatform():
  | PortalClientPlatform
  | undefined {
  try {
    return portalClientPlatformFor(hostPlatformOperatingSystem());
  } catch {
    return undefined;
  }
}

/** Check whether a server-provided host code is exactly ten lowercase Crockford base32 characters. */
export function isPortalHostCode(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-hjkmnp-tv-z]{10}$/.test(value);
}
