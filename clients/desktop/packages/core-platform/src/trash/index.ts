import { existsSync } from 'node:fs';
import type {
  PlatformExecutionProcessServices,
  PlatformOperatingSystem,
  PlatformTrashServices,
} from '@canopy/core-runtime';
import { createExecutionProcessServices } from '../supervision/execution-process';
import { loadRecycleItem } from '../supervision/owned-child';
import { darwinTrashAttempt } from './darwin';
import { linuxTrashBackend } from './linux';
import {
  createTrashServices,
  type TrashAttempter,
  type TrashBackend,
} from './trash';
import { windowsTrashBackend } from './windows';

export interface NativeTrashOptions {
  /** win32: the owned-child addon, fully qualified. Absent leaves Trash unavailable. */
  readonly ownedChildPath?: string;
}

/**
 * The native Trash backend for `os`, for a host to pass as
 * `PlatformHostOptions.trash`: `trashItemAtURL` through osascript on darwin,
 * the owned-child addon's `IFileOperation` recycle on win32, and `gio trash`
 * on linux. Nothing loads or starts until the first request. Hosts opt in;
 * `createPlatformServices` never composes it on its own.
 */
export function createNativeTrashServices(
  os: PlatformOperatingSystem,
  options: NativeTrashOptions = {},
): PlatformTrashServices {
  let processes: PlatformExecutionProcessServices | undefined;
  const helperProcesses = (): PlatformExecutionProcessServices =>
    (processes ??= createExecutionProcessServices({ os }));
  let backend: TrashBackend;
  if (os === 'darwin') {
    backend = (): TrashAttempter => (entry) =>
      darwinTrashAttempt(helperProcesses(), entry);
  } else if (os === 'linux') {
    backend = linuxTrashBackend({
      exists: existsSync,
      processes: helperProcesses,
      environment: () => process.env,
    });
  } else {
    const { ownedChildPath } = options;
    backend = windowsTrashBackend(
      ownedChildPath === undefined
        ? null
        : (): ((path: string) => Promise<unknown>) =>
            loadRecycleItem(os, ownedChildPath),
    );
  }
  return Object.freeze(createTrashServices(os, backend));
}
