import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { getEnhancedEnv } from '../../pipelines/config-paths';

type HostOperatingSystem = ReturnType<typeof hostPlatformOperatingSystem>;

/** macOS's own tool; never a same-named binary from the user's PATH. */
const XATTR_PATH = '/usr/bin/xattr';

/**
 * The `com.apple.quarantine` value browsers write for downloads: flags, the
 * download time in hex seconds, and the app that downloaded the file.
 */
export function quarantineValue(nowMs: number, agentName: string): string {
  return `0081;${Math.floor(nowMs / 1000).toString(16)};${agentName};`;
}

function setQuarantine(path: string, value: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      XATTR_PATH,
      ['-w', 'com.apple.quarantine', value, path],
      {
        env: getEnhancedEnv({
          environment: false,
          includeCanopySecrets: false,
        }),
        timeout: 10_000,
      },
      (error): void => {
        if (error) {
          reject(
            error instanceof Error
              ? error
              : new Error('Could not mark the file as downloaded.'),
          );
        } else resolve();
      },
    );
  });
}

export interface MarkAsDownloadedOptions {
  agentName: string;
  os?: HostOperatingSystem;
  nowMs?: number;
}

/**
 * Marks a file copied from another computer the way a browser marks a
 * download, so the operating system checks it before running anything in it:
 * the quarantine attribute on macOS, the internet zone's Mark of the Web on
 * Windows.
 */
export async function markAsDownloaded(
  path: string,
  options: MarkAsDownloadedOptions,
): Promise<void> {
  const os = options.os ?? hostPlatformOperatingSystem();
  if (os === 'darwin') {
    await setQuarantine(
      path,
      quarantineValue(options.nowMs ?? Date.now(), options.agentName),
    );
  } else if (os === 'win32') {
    await writeFile(
      `${path}:Zone.Identifier`,
      '[ZoneTransfer]\r\nZoneId=3\r\n',
    );
  }
}
