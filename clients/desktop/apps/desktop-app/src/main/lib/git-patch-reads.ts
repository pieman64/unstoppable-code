import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import {
  gitPatchReadArgs,
  type GitPatchReader,
  type GitPatchRead,
  type GitUntrackedContent,
} from '@canopy/core-runtime/node/git';
import { readGitStdoutPrefix } from './git';
import { isPathInside } from './path-safety';

/** Repository-relative and `/`-separated, with no empty, `.` or `..` part. */
function isPlainRelativePath(path: string): boolean {
  return (
    path !== '' &&
    !path.startsWith('/') &&
    !/^[A-Za-z]:/.test(path) &&
    path
      .split(/[\\/]/)
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

/**
 * An untracked file's content, confined to the checkout: the parent
 * directory must resolve inside it, and the final component is not
 * followed. `null` for anything else.
 */
async function readUntrackedContent(
  repoPath: string,
  path: string,
  maxBytes: number,
): Promise<GitUntrackedContent | null> {
  if (!isPlainRelativePath(path)) return null;
  const fullPath = join(repoPath, path);
  try {
    const [root, parent] = await Promise.all([
      realpath(repoPath),
      realpath(dirname(fullPath)),
    ]);
    if (!isPathInside(root, parent)) return null;
    const entry = await lstat(fullPath);
    if (entry.isSymbolicLink())
      return { kind: 'symlink', target: await readlink(fullPath) };
    if (!entry.isFile()) return null;
    const handle = await open(
      fullPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const status = await handle.stat();
      if (!status.isFile()) return null;
      const length = Math.min(status.size, maxBytes);
      const data = Buffer.alloc(length);
      const { bytesRead } = await handle.read(data, 0, length, 0);
      return {
        kind: 'file',
        // Git records the owner's execute bit; Windows records none.
        executable:
          hostPlatformOperatingSystem() !== 'win32' &&
          (status.mode & 0o100) !== 0,
        data: data.subarray(0, bytesRead),
        size: status.size,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Patch reads for the `worker.git.diff.get` engine in one checkout. */
export function gitPatchReads(repoPath: string): GitPatchReader {
  return {
    // One byte past the cut tells whether Git printed more.
    readPatch: async (read: GitPatchRead, maxBytes: number) => {
      const data = await readGitStdoutPrefix(
        repoPath,
        gitPatchReadArgs(read),
        maxBytes + 1,
      );
      return {
        data: data.subarray(0, maxBytes),
        truncated: data.byteLength > maxBytes,
      };
    },
    readUntracked: (path, maxBytes) =>
      readUntrackedContent(repoPath, path, maxBytes),
  };
}
