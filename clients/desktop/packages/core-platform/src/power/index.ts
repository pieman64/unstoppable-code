import { existsSync } from 'node:fs';
import type {
  PlatformExecutionProcessServices,
  PlatformOperatingSystem,
  PlatformPowerServices,
} from '@canopy/core-runtime';
import { createExecutionProcessServices } from '../supervision/execution-process';
import { loadExecutionState } from '../supervision/owned-child';
import {
  createHelperPowerServices,
  DARWIN_POWER_HELPER,
  linuxPowerHelper,
} from './helper';
import { createWindowsPowerServices } from './windows';

export interface PowerHostOptions {
  /** win32: the owned-child addon, fully qualified. Absent leaves power unavailable. */
  readonly ownedChildPath?: string;
  /** linux: who holds the inhibitor, as `systemd-inhibit --list` shows it. */
  readonly applicationName?: string;
}

const UNSTAGED = 'Owned child support is not staged on this host.';

/**
 * Power for `os`: a `caffeinate` assertion on darwin, a logind inhibitor on
 * linux (both helpers under execution-process custody), and the thread
 * execution state on win32. Nothing loads or starts until the first request.
 */
export function createPowerServices(
  os: PlatformOperatingSystem,
  host: PowerHostOptions = {},
): PlatformPowerServices {
  if (os === 'win32') {
    const { ownedChildPath } = host;
    return Object.freeze(
      createWindowsPowerServices(() => {
        if (ownedChildPath === undefined) throw new Error(UNSTAGED);
        return loadExecutionState(os, ownedChildPath);
      }),
    );
  }
  let processes: PlatformExecutionProcessServices | undefined;
  const helperProcesses = (): PlatformExecutionProcessServices =>
    (processes ??= createExecutionProcessServices({ os }));
  return Object.freeze(
    createHelperPowerServices(
      os === 'darwin'
        ? DARWIN_POWER_HELPER
        : linuxPowerHelper({
            applicationName: host.applicationName ?? 'Core daemon',
            exists: existsSync,
          }),
      helperProcesses,
    ),
  );
}
