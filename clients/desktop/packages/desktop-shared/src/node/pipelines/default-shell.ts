import type { ShellType } from '../../types/pipeline';

export function getDefaultShellTypeForPlatform(
  platform: NodeJS.Platform,
): ShellType {
  return platform === 'win32' ? 'powershell' : 'bash';
}

export function getDefaultShellTypeForCurrentProcess(): ShellType {
  return getDefaultShellTypeForPlatform(process.platform);
}
