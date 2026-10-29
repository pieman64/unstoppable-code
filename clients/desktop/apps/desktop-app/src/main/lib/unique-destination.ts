import { stat } from 'node:fs/promises';
import { join } from 'node:path';

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function ensureUniqueDestination(
  baseDir: string,
  preferredName: string,
): Promise<string> {
  let attempt = 1;
  let candidate = join(baseDir, preferredName);
  while (await pathExists(candidate)) {
    attempt += 1;
    candidate = join(baseDir, `${preferredName}-${attempt}`);
  }
  return candidate;
}
