import type { PlatformOperatingSystem } from '@canopy/core-runtime';

/** Resolve the supported host OS at the platform boundary. */
export function hostOperatingSystem(): PlatformOperatingSystem | null {
  const platform = process.platform;
  if (platform === 'linux' || platform === 'darwin' || platform === 'win32') {
    return platform;
  }
  return null;
}
