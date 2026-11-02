import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export interface HFileSnapshot {
  path: string;
  size: number;
  sha256: string;
  mtimeMs: number;
}

/** Includes broker records outside chat-storage-v2, not merely the manifest. */
export async function snapshotHFiles(root: string): Promise<HFileSnapshot[]> {
  const files: HFileSnapshot[] = [];
  async function visit(directory: string, relative: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await visit(absolute, path);
      else if (entry.isFile()) {
        const info = await stat(absolute);
        files.push({
          path,
          size: info.size,
          sha256: createHash('sha256')
            .update(await readFile(absolute))
            .digest('hex'),
          mtimeMs: info.mtimeMs,
        });
      }
    }
  }
  await visit(root, '');
  return files;
}
