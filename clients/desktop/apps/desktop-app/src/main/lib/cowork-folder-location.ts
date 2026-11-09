import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { filesystemErrorCode } from '@canopy/core-runtime/node/workspace/cowork-folder';
import { requireCoworkFolderProject } from './cowork-folder-project';
import { getCoworkWorkspaceRootDir } from './paths';

/** Trusted host projection: callers supply an ID, never an arbitrary OS path. */
export async function revealCoworkFolderLocation(
  projectId: string,
  openPath: (path: string) => Promise<string>,
): Promise<void> {
  const workspaceId = await requireCoworkFolderProject(projectId);
  let location = getCoworkWorkspaceRootDir(workspaceId);
  while (true) {
    let directory = false;
    try {
      directory = (await stat(location)).isDirectory();
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(String(filesystemErrorCode(error))))
        throw error;
    }
    if (directory) {
      const failure = await openPath(location);
      if (failure) throw new Error(failure);
      return;
    }
    const parent = dirname(location);
    if (parent === location)
      throw new Error('No existing folder could be opened.');
    location = parent;
  }
}
