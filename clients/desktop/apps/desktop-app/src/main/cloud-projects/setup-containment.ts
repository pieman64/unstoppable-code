import type { Stats } from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { isErrnoException } from '../lib/type-guards';

/*
 * Where a cloud project setup (CAN-5192) may write inside the folder it is
 * building. A cloned root repository is untrusted content: a link it commits
 * at or above a nested repository's folder would send that clone, and every
 * later write there, outside the project folder. So every folder from the
 * root down must be a real directory, never a link, and resolve to the path
 * it is named by.
 */

function segmentsOf(relativePath: string | null): string[] | null {
  if (relativePath === null) return [];
  if (isAbsolute(relativePath) || normalize(relativePath) !== relativePath)
    return null;
  const segments = relativePath.split(/[\\/]/);
  return segments.every(
    (segment) => segment !== '' && segment !== '.' && segment !== '..',
  )
    ? segments
    : null;
}

/** The entry itself, never what a link points at; null when it is missing. */
async function entryAt(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      isErrnoException(error) &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      return null;
    throw error;
  }
}

/**
 * Whether `root` and every folder down to `relativePath` are real
 * directories, none of them a link, that resolve inside `root`. A disk that
 * cannot answer rejects.
 */
export async function isContainedDirectory(
  root: string,
  relativePath: string | null,
): Promise<boolean> {
  const segments = segmentsOf(relativePath);
  if (segments === null) return false;
  let path = root;
  if (!(await entryAt(path))?.isDirectory()) return false;
  for (const segment of segments) {
    path = join(path, segment);
    if (!(await entryAt(path))?.isDirectory()) return false;
  }
  return (await realpath(path)) === join(await realpath(root), ...segments);
}

/**
 * Creates `relativePath` under `root` as a new, empty directory, and the
 * missing folders on the way. False, creating nothing more, when something is
 * already there or a folder on the way is not a real directory inside `root`.
 */
export async function createContainedDirectory(
  root: string,
  relativePath: string,
): Promise<boolean> {
  const segments = segmentsOf(relativePath);
  if (
    segments === null ||
    segments.length === 0 ||
    !(await isContainedDirectory(root, null))
  )
    return false;
  let path = root;
  for (const [index, segment] of segments.entries()) {
    path = join(path, segment);
    const found = await entryAt(path);
    if (found !== null) {
      if (index === segments.length - 1 || !found.isDirectory()) return false;
      continue;
    }
    try {
      await mkdir(path);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'EEXIST') return false;
      throw error;
    }
  }
  return isContainedDirectory(root, relativePath);
}
