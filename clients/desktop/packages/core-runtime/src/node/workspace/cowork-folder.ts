import { mkdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  COWORK_FOLDER_MISSING_CODE,
  type CoworkFolderMissing,
  type CoworkFolderStatus,
} from '@canopy/protocol/canopy-core';

export function filesystemErrorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

export class CoworkFolderMissingError
  extends Error
  implements CoworkFolderMissing
{
  readonly code = COWORK_FOLDER_MISSING_CODE;
  readonly folderName: string;
  constructor(
    readonly workspaceId: string,
    root: string,
  ) {
    const folderName = basename(resolve(root)) || 'root';
    super(`Couldn't find the "${folderName}" folder.`);
    this.name = 'CoworkFolderMissingError';
    this.folderName = folderName;
  }
}

/** Worker filesystem inspection. Permission and I/O errors propagate unchanged. */
export async function checkExternalCoworkRoot(
  workspaceId: string,
  root: string,
): Promise<CoworkFolderStatus> {
  const missing = new CoworkFolderMissingError(workspaceId, root);
  try {
    if ((await stat(root)).isDirectory())
      return {
        kind: 'external',
        status: 'present',
        folderName: missing.folderName,
      };
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(String(filesystemErrorCode(error))))
      throw error;
  }
  return {
    kind: 'external',
    status: 'missing',
    folderName: missing.folderName,
    code: missing.code,
    message: missing.message,
  };
}

export async function assertExternalCoworkRoot(
  workspaceId: string,
  root: string,
): Promise<void> {
  const status = await checkExternalCoworkRoot(workspaceId, root);
  if (status.kind === 'external' && status.status === 'missing')
    throw new CoworkFolderMissingError(workspaceId, root);
}

/** Never mkdir the root or its parents, even if it disappears after inspection. */
export async function prepareExternalCoworkDirectory(
  workspaceId: string,
  root: string,
  directory: string,
  mode?: number,
): Promise<void> {
  const suffix = relative(resolve(root), resolve(directory));
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`))
    throw new Error('Invalid project directory');
  await assertExternalCoworkRoot(workspaceId, root);
  let current = resolve(root);
  try {
    for (const part of suffix.split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        await mkdir(current, { mode });
      } catch (error) {
        if (filesystemErrorCode(error) !== 'EEXIST') throw error;
        if (!(await stat(current)).isDirectory()) throw error;
      }
    }
  } catch (error) {
    // Only the root's fresh observation may classify a disappearance.
    if (!['ENOENT', 'ENOTDIR'].includes(String(filesystemErrorCode(error))))
      throw error;
    await assertExternalCoworkRoot(workspaceId, root);
    throw error;
  }
}
