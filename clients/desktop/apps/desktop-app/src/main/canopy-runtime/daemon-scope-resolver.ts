import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import {
  createFilesystemScopeResolver,
  readNativeRootIdentity,
  type FilesystemScopeResolver,
} from '@canopy/core-runtime/node';
import { CANOPY_IN_PROCESS_WORKER_TARGET_ID } from '@canopy/protocol/canopy-core';
import { getElectronDaemonFilesContext } from './electron-daemon-access';

let resolver: Promise<FilesystemScopeResolver> | undefined;

/**
 * The scope resolver the daemon routes read the daemon's tracking records
 * with, over the daemon's verified data root and authority; reset when it
 * cannot be built (CAN-5088, CAN-5087).
 */
export function getDaemonScopeResolver(): Promise<FilesystemScopeResolver> {
  if (resolver) return resolver;
  const pending = getElectronDaemonFilesContext().then((host) =>
    createFilesystemScopeResolver({
      canonicalDataRoot: host.canonicalDataRoot,
      authorityId: host.authorityId,
      targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
      // `build-core-daemon.mjs` bakes the same name into the daemon.
      coworkManagedDirName: BRAND.storage.projectConfigDirNames[0] ?? '',
      paths: { join, resolve, isAbsolute, sep, basename },
      rootIdentity: readNativeRootIdentity,
    }),
  );
  resolver = pending;
  void pending.catch(() => {
    if (resolver === pending) resolver = undefined;
  });
  return pending;
}
