import { join } from 'node:path';
import { fsWithoutAsar } from './remove-tree-without-asar';

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === code
  );
}

export async function removeWindowsWorktreeReparsePoints(
  directoryPath: string,
): Promise<void> {
  if (process.platform !== 'win32') return;

  // Electron's patched `fs` would walk into `*.asar` files as folders: it
  // fails on a file that is not a valid archive, and tries to remove links
  // inside a read-only one. Scan with calls that see them as plain files.
  const fs = fsWithoutAsar();

  let entries;
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return;
    throw error;
  }

  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);
    let entryStat;
    try {
      entryStat = await fs.lstat(entryPath);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) continue;
      throw error;
    }

    if (entryStat.isSymbolicLink()) {
      // Git for Windows follows directory junctions during worktree removal.
      // Remove the link entry first so external targets stay intact.
      await fs.rm(entryPath, { recursive: true, force: true });
    } else if (entryStat.isDirectory()) {
      await removeWindowsWorktreeReparsePoints(entryPath);
    }
  }
}
