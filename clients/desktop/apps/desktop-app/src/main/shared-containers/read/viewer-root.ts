import {
  COWORK_WORKSPACE_FILE_ROOT_ID,
  type SharedContainerReplicaState,
} from '@canopy/desktop-shared/types';
import { getSharedContainerReader, type SharedContainerReader } from './reader';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { MAX_SHARED_CONTAINER_ARTIFACT_BYTES } from '@canopy/protocol/shared-containers';

export interface SharedContainerViewerReadRoot {
  repoId: string;
  repoName: string;
  absolutePath: string;
  revisionRoot: string;
  revisionId: string;
}

type ReadableReplicaState = Extract<
  SharedContainerReplicaState,
  { status: 'available' | 'pinned' }
>;

async function currentState(
  reader: SharedContainerReader,
  containerId: string,
): Promise<ReadableReplicaState> {
  const state = await reader.store.get(containerId);
  if (state?.status !== 'available' && state?.status !== 'pinned') {
    throw new Error('Shared-container revision is not available');
  }
  return state;
}

/** Resolve the currently promoted sealed replica roots for a viewer scope. */
export async function resolveSharedContainerViewerReadRoots(
  containerId: string,
  reader: SharedContainerReader = getSharedContainerReader(),
): Promise<SharedContainerViewerReadRoot[]> {
  const state = await currentState(reader, containerId);
  const { root, layout } = await reader.readForkLayout({
    containerId,
    revisionId: state.revisionId,
  });
  const typedLayout = layout;
  if (typedLayout.containerType === 'COWORK_WORK_ENTRY') {
    const absolutePath = reader.store.resolvePathBelowForRead(root, 'content');
    await reader.store.assertRealDirectoryForRead(root, absolutePath);
    return [
      {
        repoId: COWORK_WORKSPACE_FILE_ROOT_ID,
        repoName: 'Workspace',
        absolutePath,
        revisionRoot: root,
        revisionId: state.revisionId,
      },
    ];
  }
  const roots = typedLayout.repositories.map((repository) => ({
    repoId: repository.repoId,
    repoName: repository.repoName,
    absolutePath: reader.store.resolvePathBelowForRead(
      root,
      'repos',
      repository.repoId,
    ),
    revisionRoot: root,
    revisionId: state.revisionId,
  }));
  await Promise.all(
    roots.map(({ absolutePath }) =>
      reader.store.assertRealDirectoryForRead(root, absolutePath),
    ),
  );
  return roots;
}

export async function resolveSharedContainerViewerReadRoot(
  containerId: string,
  repoId?: string,
  reader: SharedContainerReader = getSharedContainerReader(),
): Promise<SharedContainerViewerReadRoot> {
  const roots = await resolveSharedContainerViewerReadRoots(
    containerId,
    reader,
  );
  const root = repoId
    ? roots.find((candidate) => candidate.repoId === repoId)
    : roots.length === 1
      ? roots[0]
      : undefined;
  if (!root) {
    throw new Error(
      repoId
        ? 'Shared-container repository is not declared'
        : 'Shared-container repository is ambiguous',
    );
  }
  return root;
}

export async function resolveSharedContainerViewerFileForRead(
  containerId: string,
  absolutePath: string,
  reader: SharedContainerReader = getSharedContainerReader(),
): Promise<{
  root: SharedContainerViewerReadRoot;
  target: string;
  relativePath: string;
}> {
  if (!isAbsolute(absolutePath)) {
    throw new Error('Viewer file path is not absolute');
  }
  const target = resolve(absolutePath);
  const roots = await resolveSharedContainerViewerReadRoots(
    containerId,
    reader,
  );
  for (const root of roots) {
    const relativePath = relative(resolve(root.absolutePath), target);
    if (
      relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath)
    ) {
      return { root, target, relativePath: relativePath.split(sep).join('/') };
    }
  }
  throw new Error('Cannot read file outside the shared-container replica');
}

export async function assertSharedContainerViewerFileForRead(
  containerId: string,
  absolutePath: string,
  reader: SharedContainerReader = getSharedContainerReader(),
): Promise<
  Awaited<ReturnType<typeof resolveSharedContainerViewerFileForRead>>
> {
  const resolved = await resolveSharedContainerViewerFileForRead(
    containerId,
    absolutePath,
    reader,
  );
  const info = await reader.store.lstatEntryForRead(
    resolved.root.revisionRoot,
    resolved.target,
  );
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Shared-container content is not a regular file');
  }
  return resolved;
}

export async function readSharedContainerViewerFile(
  containerId: string,
  absolutePath: string,
  maximumBytes = MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
  reader: SharedContainerReader = getSharedContainerReader(),
): Promise<{
  bytes: Buffer;
  filename: string;
  sizeBytes: number;
  modifiedAtMs: number;
}> {
  const resolved = await assertSharedContainerViewerFileForRead(
    containerId,
    absolutePath,
    reader,
  );
  const info = await reader.store.lstatEntryForRead(
    resolved.root.revisionRoot,
    resolved.target,
  );
  const bytes = await reader.store.readBoundedFileForRead(
    resolved.root.revisionRoot,
    resolved.target,
    maximumBytes,
  );
  return {
    bytes,
    filename: resolved.relativePath.split('/').pop() ?? '',
    sizeBytes: Number(info.size),
    modifiedAtMs: Number(info.mtimeMs),
  };
}
