import { realpath } from 'node:fs/promises';
import type { CanopyWorkspaceScope } from '@canopy/protocol/canopy-core';
import {
  COWORK_MANAGED_DIR_NAME_PATTERN,
  resolveFilesystemScopeOwner,
  type FilesystemReadOperation,
  type FilesystemScopeDependencies,
} from './scope-reader';

export interface FilesystemScopeResolverOptions {
  /**
   * The realpath of the data root. Catalog revisions hash canonical root
   * paths, so every reader that projects a revision must use this same root.
   */
  readonly canonicalDataRoot: string;
  /** The verified local authority this host serves. */
  readonly authorityId: string;
  /** The execution target whose records this host reads. */
  readonly targetId: string;
  /** The build brand's managed Cowork folder name, such as `.canopy`. */
  readonly coworkManagedDirName: string;
  readonly paths: FilesystemScopeDependencies['paths'];
  readonly rootIdentity: FilesystemScopeDependencies['rootIdentity'];
  readonly readFile?: FilesystemScopeDependencies['readFile'];
}

/** Per-request scope dependencies, with ownership read from trusted records. */
export type FilesystemScopeResolver = (
  scope: CanopyWorkspaceScope,
  operation: FilesystemReadOperation,
) => Promise<FilesystemScopeDependencies>;

/**
 * Fixes the host inputs once and resolves the selected workspace's owner on
 * every request, so one resolver serves Personal and any number of
 * organization-owned workspaces. Throws when an input cannot be trusted.
 */
export async function createFilesystemScopeResolver(
  options: FilesystemScopeResolverOptions,
): Promise<FilesystemScopeResolver> {
  const { canonicalDataRoot, authorityId, targetId, paths } = options;
  if (authorityId.trim() === '' || targetId.trim() === '')
    throw new Error('Filesystem scope authority and target are required.');
  if (!COWORK_MANAGED_DIR_NAME_PATTERN.test(options.coworkManagedDirName))
    throw new Error('The managed Cowork folder name is invalid.');
  if (
    !paths.isAbsolute(canonicalDataRoot) ||
    paths.resolve(canonicalDataRoot) !== canonicalDataRoot ||
    (await realpath(canonicalDataRoot)) !== canonicalDataRoot
  )
    throw new Error('The filesystem scope data root is not canonical.');
  const host: Omit<FilesystemScopeDependencies, 'organizationId'> = {
    dataRoot: canonicalDataRoot,
    authorityId,
    targetId,
    paths,
    coworkManagedDirName: options.coworkManagedDirName,
    rootIdentity: options.rootIdentity,
    ...(options.readFile && { readFile: options.readFile }),
  };
  return async (scope, operation) => {
    const organizationId = await resolveFilesystemScopeOwner(
      scope,
      host,
      operation,
    );
    return organizationId === undefined
      ? { ...host }
      : { ...host, organizationId };
  };
}
