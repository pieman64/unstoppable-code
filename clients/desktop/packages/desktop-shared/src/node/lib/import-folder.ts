import { stat } from 'node:fs/promises';

/**
 * Thrown when a folder import names a path that does not exist or is not a
 * folder. Import never creates the folder: explicit creation and the repair of
 * an already imported Cowork project are separate paths (CAN-3799).
 */
export class ImportFolderNotFoundError extends Error {
  constructor(
    readonly folderPath: string,
    reason: 'missing' | 'not-a-folder' = 'missing',
  ) {
    super(
      reason === 'missing'
        ? `Couldn't add the folder because it doesn't exist: ${folderPath}. Choose an existing folder.`
        : `Couldn't add the folder because it isn't a folder: ${folderPath}. Choose a folder.`,
    );
    this.name = 'ImportFolderNotFoundError';
  }
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = Reflect.get(error, 'code');
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Rejects an import of a path that does not exist or is not a folder. `stat`
 * follows symlinks, so a dangling link counts as missing and a link to a file
 * as not a folder. Other failures, such as a permission error, propagate
 * unchanged.
 */
export async function assertImportFolderExists(
  folderPath: string,
): Promise<void> {
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(folderPath)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new ImportFolderNotFoundError(folderPath);
    }
    throw error;
  }
  if (!isDirectory) {
    throw new ImportFolderNotFoundError(folderPath, 'not-a-folder');
  }
}
