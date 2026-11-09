import { STANDALONE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { CoworkFolderStatus } from '@canopy/protocol/canopy-core';
import {
  assertExternalCoworkRoot,
  checkExternalCoworkRoot,
  filesystemErrorCode,
  prepareExternalCoworkDirectory,
} from '@canopy/core-runtime/node/workspace/cowork-folder';
import { resolveCoworkWorkspaceId } from './cowork-migration-map';
import { validateId } from './validation';
import {
  getWorkspaceExternalPath,
  getWorkspaceType,
  isCoworkWorkspace,
  listRegisteredWorkspaceIds,
} from './workspace-registry';

export { CoworkFolderMissingError } from '@canopy/core-runtime/node/workspace/cowork-folder';

/** Core send policy over the host's authoritative, currently registered roots. */
export async function checkCoworkExternalFolder(
  projectId: string,
): Promise<CoworkFolderStatus> {
  validateId(projectId, 'projectId');
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  if (!isCoworkWorkspace(workspaceId))
    throw new Error('Chat project not found');
  const root = getWorkspaceExternalPath(workspaceId);
  return root === null
    ? { kind: 'managed' }
    : checkExternalCoworkRoot(workspaceId, root);
}

export async function assertCoworkWorkspaceRootPresent(
  projectId: string,
): Promise<void> {
  validateId(projectId, 'projectId');
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  if (!isCoworkWorkspace(workspaceId))
    throw new Error('Chat project not found');
  const root = getWorkspaceExternalPath(workspaceId);
  if (root !== null) await assertExternalCoworkRoot(workspaceId, root);
}

/**
 * Path-only legacy writers still share this guard. Resolve safety at write time,
 * including callers that copied a destination before the folder disappeared.
 */
export async function ensureWorkspaceWriteDirectory(
  directory: string,
  mode?: number,
): Promise<void> {
  const destination = resolve(directory);
  for (const workspaceId of listRegisteredWorkspaceIds().sort(
    (left, right) =>
      (getWorkspaceExternalPath(right)?.length ?? 0) -
      (getWorkspaceExternalPath(left)?.length ?? 0),
  )) {
    if (getWorkspaceType(workspaceId) !== 'cowork') continue;
    const root = getWorkspaceExternalPath(workspaceId);
    if (root === null) continue;
    const suffix = relative(resolve(root), destination);
    if (
      !isAbsolute(suffix) &&
      suffix !== '..' &&
      !suffix.startsWith(`..${sep}`)
    ) {
      await prepareExternalCoworkDirectory(
        workspaceId,
        root,
        destination,
        mode,
      );
      return;
    }
  }
  await mkdir(destination, { recursive: true, mode });
}

/** Reclassify only when a fresh check proves the external root disappeared. */
export async function withCoworkWrite<T>(
  projectId: string,
  write: () => Promise<T>,
): Promise<T> {
  await assertCoworkWorkspaceRootPresent(projectId);
  try {
    return await write();
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(String(filesystemErrorCode(error))))
      throw error;
    await assertCoworkWorkspaceRootPresent(projectId);
    throw error;
  }
}

export async function withWorkspaceDirectoryWrite<T>(
  directory: string,
  write: () => Promise<T>,
): Promise<T> {
  await ensureWorkspaceWriteDirectory(directory);
  try {
    return await write();
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(String(filesystemErrorCode(error))))
      throw error;
    for (const workspaceId of listRegisteredWorkspaceIds().sort(
      (left, right) =>
        (getWorkspaceExternalPath(right)?.length ?? 0) -
        (getWorkspaceExternalPath(left)?.length ?? 0),
    )) {
      if (getWorkspaceType(workspaceId) !== 'cowork') continue;
      const root = getWorkspaceExternalPath(workspaceId);
      if (root === null) continue;
      const suffix = relative(resolve(root), resolve(directory));
      if (
        !isAbsolute(suffix) &&
        suffix !== '..' &&
        !suffix.startsWith(`..${sep}`)
      )
        await assertCoworkWorkspaceRootPresent(workspaceId);
    }
    throw error;
  }
}

/** Both permanent legacy keying and canonical Work Entry keying. */
export async function assertCoworkChatRootPresent(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  if (
    projectId === STANDALONE_CHAT_PROJECT_ID ||
    getWorkspaceType(projectId) === 'cowork'
  )
    await assertCoworkWorkspaceRootPresent(
      projectId === STANDALONE_CHAT_PROJECT_ID ? worktreeId : projectId,
    );
}
