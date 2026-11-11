import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type { ShellType } from '../../types/pipeline';

export function getDefaultShellTypeForPlatform(
  platform: NodeJS.Platform | null,
): ShellType {
  return platform === 'win32' ? 'powershell' : 'bash';
}

export function getDefaultShellTypeForCurrentProcess(): ShellType {
  return getDefaultShellTypeForPlatform(hostOperatingSystem());
}
