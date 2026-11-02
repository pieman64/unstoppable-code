import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import { searchDirectories } from './commands';

/** Whether `candidate` is a file spawn could start. */
export type ExecutableProbe = (candidate: string) => Promise<boolean>;

/** libuv's Windows test (exists, not a directory); execvp's on POSIX. */
export function nodeExecutableProbe(
  os: PlatformOperatingSystem,
): ExecutableProbe {
  return async (candidate) => {
    try {
      const found = await stat(candidate);
      if (os === 'win32') return !found.isDirectory();
      if (!found.isFile()) return false;
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * libuv's per-directory candidates: on Windows the name itself when it has an
 * extension, then `.com` and `.exe` (libuv ignores PATHEXT; `.cmd` and `.bat`
 * need a shell, which spawn refuses). libuv's extension test is its first dot
 * followed by any character, so `a.b.` is tried as-is but `git.` is not, and
 * it adds the dot before an extension only when the name lacks a trailing one
 * (`git.` gives `git.com`). A directory ending in `\`, `/` or `:` gets no
 * separator. On POSIX, the name. Joined literally, as libuv and execvp do:
 * normalizing `..` could pass a different file.
 */
export function candidatesIn(
  os: PlatformOperatingSystem,
  directory: string,
  name: string,
): string[] {
  const separator = os === 'win32' ? '\\' : '/';
  const trailing = os === 'win32' ? /[\\/:]$/ : /\/$/;
  const prefix = trailing.test(directory) ? directory : `${directory}${separator}`; // prettier-ignore
  if (os !== 'win32') return [`${prefix}${name}`];
  const dot = name.indexOf('.');
  const stem = name.endsWith('.') ? name : `${name}.`;
  const names = [
    ...(dot >= 0 && dot < name.length - 1 ? [name] : []),
    `${stem}com`,
    `${stem}exe`,
  ];
  return names.map((candidate) => `${prefix}${candidate}`);
}

/**
 * The first candidate, in PATH order, that `probe` accepts; `undefined` when
 * none does. Only the supplied PATH is searched: never the cwd or the host's.
 */
export async function resolveBareCommand(
  os: PlatformOperatingSystem,
  name: string,
  searchPath: string | undefined,
  probe: ExecutableProbe,
): Promise<string | undefined> {
  // libuv refuses these before searching; execvp finds no file for either.
  if (name === '' || name === '.') return undefined;
  for (const directory of searchDirectories(os, searchPath))
    for (const candidate of candidatesIn(os, directory, name))
      if (await probe(candidate)) return candidate;
  return undefined;
}
