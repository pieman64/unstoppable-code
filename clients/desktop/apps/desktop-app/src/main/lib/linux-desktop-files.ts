import { constants } from 'node:fs';
import { access, open, opendir, realpath, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { homedir } from 'node:os';
import {
  getLoginShellPath,
  prewarmLoginShellPath,
} from '@canopy/desktop-shared/pipelines/config-paths';
import {
  hasDesktopControlCharacters,
  isSafeDesktopCommand,
} from './linux-desktop-exec';

const MAX_ENTRIES = 8192;
const MAX_DIRECTORIES = 512;
const MAX_DEPTH = 12;
const MAX_ROOTS = 32;

function validRoot(value: string): boolean {
  return posix.isAbsolute(value) && !hasDesktopControlCharacters(value);
}

export function linuxDataRoots(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const user =
    env.XDG_DATA_HOME && validRoot(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : posix.join(home, '.local/share');
  const system = (env.XDG_DATA_DIRS ?? '').split(':').filter(validRoot);
  return Array.from(
    new Set([
      user,
      ...(system.length ? system : ['/usr/local/share', '/usr/share']),
    ]),
  ).slice(0, MAX_ROOTS);
}

/** Bounded reads also avoid blocking the main thread on FIFO/special-file entries. */
export async function readDesktopBytes(
  file: string,
  limit: number,
): Promise<Buffer | undefined> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > limit) return undefined;
      const buffer = Buffer.alloc(limit + 1);
      let size = 0;
      while (size <= limit) {
        const read = await handle.read(
          buffer,
          size,
          buffer.length - size,
          null,
        );
        if (read.bytesRead === 0) break;
        size += read.bytesRead;
      }
      return size > limit ? undefined : buffer.subarray(0, size);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export async function readDesktopText(
  file: string,
): Promise<string | undefined> {
  const bytes = await readDesktopBytes(file, 128 * 1024);
  return bytes?.toString('utf8');
}

function missing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

/**
 * Claim IDs before opening/parsing files: hidden, invalid, oversized and dangling
 * user entries must never resurrect lower-priority system launchers.
 * An incomplete scan fails closed rather than weakening precedence.
 */
export async function desktopFileIndex(
  roots: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  let entries = 0;
  let directories = 0;
  const walk = async (
    root: string,
    relative: string,
    depth: number,
  ): Promise<void> => {
    if (++directories > MAX_DIRECTORIES || depth > MAX_DEPTH)
      throw new Error('Desktop scan limit');
    let directory;
    try {
      directory = await opendir(posix.join(root, relative));
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    // opendir streams entries instead of allocating an unbounded readdir result.
    const children: string[] = [];
    for await (const entry of directory) {
      if (++entries > MAX_ENTRIES) throw new Error('Desktop scan limit');
      const name = posix.join(relative, entry.name);
      if (entry.isDirectory()) children.push(name);
      else if (entry.name.endsWith('.desktop')) {
        const id = name.replace(/\//g, '-');
        if (!result.has(id)) result.set(id, posix.join(root, name));
      }
    }
    // Top-level IDs win same-root nested collisions; deterministic nested traversal.
    for (const child of children.sort()) await walk(root, child, depth + 1);
  };
  try {
    for (const root of roots)
      await walk(posix.join(root, 'applications'), '', 0);
    return result;
  } catch {
    return new Map();
  }
}

export async function linuxExecutable(
  command: string,
): Promise<{ command: string; canonical: string } | undefined> {
  if (!isSafeDesktopCommand(command)) return undefined;
  // Share the app's cached login-shell PATH, including a cold startup from a
  // desktop launcher with a minimal inherited PATH. Absolute entries need no probe.
  const searchPath = !posix.isAbsolute(command) && !command.includes('/');
  if (searchPath) await prewarmLoginShellPath();
  const candidates = posix.isAbsolute(command)
    ? [command]
    : command.includes('/')
      ? []
      : (getLoginShellPath() || '/usr/local/bin:/usr/bin:/bin')
          .split(':')
          .filter(validRoot)
          .slice(0, 64)
          .map((root) => posix.join(root, command));
  for (const file of candidates) {
    try {
      const resolved = await realpath(file);
      if (!isSafeDesktopCommand(resolved) || !(await stat(resolved)).isFile())
        continue;
      await access(resolved, constants.X_OK);
      // Keep the selected executable path (CLI symlinks can have dispatch semantics).
      return { command: file, canonical: resolved };
    } catch {
      /* Missing/unexecutable PATH entries are normal. */
    }
  }
  return undefined;
}
