import {
  type CanopyWorkspaceScope,
  type WorkerFilesystemRootsListParams,
  type WorkerFilesystemRootsListResult,
  type WorkerFilesystemDirectoryListParams,
  type WorkerFilesystemDirectoryListResult,
} from '@canopy/protocol/canopy-core';
import { isSafePortableRelativePath } from '@canopy/protocol/safe-relative-path';
import { CanopyOperationError } from '../../runtime/errors';
import { createCatalogRevision } from './catalog-revision';
import {
  readFilesystemDirectory,
  type DirectoryReadOptions,
} from './directory-reader';
import { readRootVisibility, type FilesystemRootCatalog } from './root-catalog';
import {
  readFilesystemScope,
  filesystemScopeError,
  type FilesystemReadOperation,
  type FilesystemScopeDependencies,
} from './scope-reader';

async function snapshot(
  scope: CanopyWorkspaceScope,
  dependencies: FilesystemScopeDependencies,
  operation: FilesystemReadOperation,
): Promise<{ catalog: FilesystemRootCatalog; catalogRevision: string }> {
  // Visibility is a view of directory contents, not part of the trusted root mapping.
  const catalog = await readFilesystemScope(
    scope,
    { ...dependencies, rootVisibility: () => Promise.resolve(true) },
    operation,
  );
  const key = JSON.stringify([
    dependencies.authorityId,
    dependencies.targetId,
    dependencies.organizationId ?? null,
    scope.workspaceId,
    scope.worktreeId ?? null,
    catalog.containerCreatedAt,
  ]);
  try {
    return {
      catalog,
      catalogRevision: await createCatalogRevision(catalog, dependencies, key),
    };
  } catch {
    throw filesystemScopeError(operation, 'invalidState');
  }
}

/** Opt-in adapters must refuse unversioned daemon results, without a legacy fallback. */
export function requireFilesystemCatalogRevision(
  result: { catalogRevision?: unknown },
  operation: FilesystemReadOperation,
): string {
  if (
    typeof result.catalogRevision !== 'string' ||
    result.catalogRevision.length === 0 ||
    result.catalogRevision.length > 128
  ) {
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      code: `worker.filesystem.${operation}.invalidState`,
      message:
        'This filesystem response has no supported catalog revision. Update the daemon before using trusted filesystem reads.',
      retry: { kind: 'never' },
    });
  }
  return result.catalogRevision;
}

/** R4 supplies local projection; this guard re-resolves authority without relisting a directory. */
export async function withVerifiedFilesystemCatalog<Result>(
  scope: CanopyWorkspaceScope,
  catalogRevision: string,
  dependencies: FilesystemScopeDependencies,
  operation: FilesystemReadOperation,
  project: (catalog: FilesystemRootCatalog) => Promise<Result>,
): Promise<Result> {
  const current = async (): Promise<Awaited<ReturnType<typeof snapshot>>> => {
    try {
      return await snapshot(scope, dependencies, operation);
    } catch {
      throw filesystemScopeError(operation, 'revisionConflict');
    }
  };
  const before = await current();
  if (before.catalogRevision !== catalogRevision)
    throw filesystemScopeError(operation, 'revisionConflict');
  const result = await project(before.catalog);
  if ((await current()).catalogRevision !== catalogRevision)
    throw filesystemScopeError(operation, 'revisionConflict');
  return result;
}

export async function listFilesystemScopeRoots(
  params: WorkerFilesystemRootsListParams,
  dependencies: FilesystemScopeDependencies,
): Promise<WorkerFilesystemRootsListResult> {
  const initial = await snapshot(params.scope, dependencies, 'roots');
  if (
    params.catalogRevision !== undefined &&
    params.catalogRevision !== initial.catalogRevision
  )
    throw filesystemScopeError('roots', 'revisionConflict');
  return withVerifiedFilesystemCatalog(
    params.scope,
    initial.catalogRevision,
    dependencies,
    'roots',
    async (catalog) => {
      const visible = await Promise.all(
        catalog.roots.map(
          async (root) =>
            root.kind !== 'attachments' ||
            (await (dependencies.rootVisibility ?? readRootVisibility)(
              root.absolutePath,
            )),
        ),
      );
      return {
        catalogRevision: initial.catalogRevision,
        roots: catalog.roots
          .filter((_root, index) => visible[index])
          .map((root) => ({
            fileRootId: root.id,
            name: root.name,
            kind: root.kind,
          })),
      };
    },
  );
}

export async function listFilesystemScopeDirectory(
  params: WorkerFilesystemDirectoryListParams,
  dependencies: FilesystemScopeDependencies,
  options: DirectoryReadOptions,
): Promise<WorkerFilesystemDirectoryListResult> {
  if (
    params.relativePath.includes('\0') ||
    (params.relativePath !== '' &&
      !isSafePortableRelativePath(params.relativePath))
  )
    throw filesystemScopeError('directory', 'invalidState');
  const initial = await snapshot(params.scope, dependencies, 'directory');
  if (
    params.catalogRevision !== undefined &&
    params.catalogRevision !== initial.catalogRevision
  )
    throw filesystemScopeError('directory', 'revisionConflict');
  return withVerifiedFilesystemCatalog(
    params.scope,
    initial.catalogRevision,
    dependencies,
    'directory',
    async (catalog) => {
      const root = catalog.byId.get(params.fileRootId);
      if (!root) throw filesystemScopeError('directory', 'notFound');
      const entries = await readFilesystemDirectory(
        root,
        params.relativePath,
        options,
      ).catch(() => {
        throw filesystemScopeError('directory', 'invalidState');
      });
      return {
        catalogRevision: initial.catalogRevision,
        entries: entries.map((entry) => ({
          name: entry.name,
          relativePath: entry.relativePath,
          kind: entry.kind,
          isIgnored: entry.isIgnored,
          isIndexExcluded: entry.isIndexExcluded,
          isSymlink: entry.isSymlink,
          hasChildren: entry.hasChildren,
        })),
      };
    },
  );
}
