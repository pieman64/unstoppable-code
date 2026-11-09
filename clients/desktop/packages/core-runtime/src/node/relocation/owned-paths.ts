import { lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path';
import {
  isWithin,
  movedOwnedPath,
  RelocationRefusedError,
  type RelocationTransition,
} from './transition';

import {
  assertRelocationWorkingRoot,
  relocationWorkingPath,
} from './working-root';

async function checkedLinkTarget(
  transition: RelocationTransition,
  workingRoot: string,
  link: string,
  text: string,
  paths: ReadonlySet<string>,
  prefixes: ReadonlySet<string>,
  published: boolean,
): Promise<string> {
  const root = parse(text).root;
  if (root && !isAbsolute(text))
    throw new RelocationRefusedError('noncanonical-owned-link-target');
  const parts = text.slice(root.length).split(sep === '\\' ? /[\\/]/ : '/');
  let target = isAbsolute(text) ? root : dirname(link);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === '' || part === '.') continue;
    target = part === '..' ? dirname(target) : join(target, part);
    if (isWithin(transition.from.canonicalDataRoot, target))
      throw new RelocationRefusedError('stale-owned-link');
    if (!prefixes.has(target))
      throw new RelocationRefusedError('unproven-owned-link-target');
    if (index !== parts.length - 1 && part !== '..') {
      // Check before consuming ..: lexical normalization can hide a link traversal.
      const actual = published
        ? target
        : relocationWorkingPath(transition, workingRoot, target);
      const state = await lstat(actual);
      if (state.isSymbolicLink())
        throw new RelocationRefusedError('symlink-owned-parent');
      if (!state.isDirectory())
        throw new RelocationRefusedError('nondirectory-owned-parent');
      if ((await realpath(actual)) !== actual)
        throw new RelocationRefusedError('noncanonical-owned-path');
    }
  }
  if (!paths.has(target))
    throw new RelocationRefusedError('unproven-owned-link-target');
  return target;
}

/** Read only inventoried projected paths and their parents; never follow a link. */
export async function assertRelocationOwnedPathsSafe(
  transition: RelocationTransition,
  ownedPaths: readonly string[],
  workingRoot: string,
  published = false,
): Promise<void> {
  const root = transition.to.canonicalDataRoot;
  if (published) {
    if (
      workingRoot !== root ||
      !(await lstat(root)).isDirectory() ||
      (await realpath(root)) !== root
    )
      throw new RelocationRefusedError('noncanonical-published-root');
  } else await assertRelocationWorkingRoot(transition, workingRoot);
  const paths = new Set(
    ownedPaths.map((path) => movedOwnedPath(transition, path)),
  );
  const prefixes = new Set<string>();
  for (const path of paths) {
    let current = path;
    while (!prefixes.has(current)) {
      prefixes.add(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const links = new Map<string, string>();
  for (const path of paths) {
    if (path === root) continue;
    const base = isWithin(root, path) ? root : parse(path).root;
    const parts = relative(base, path).split(sep);
    let current = base;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      const actual = published
        ? current
        : relocationWorkingPath(transition, workingRoot, current);
      const state = await lstat(actual).catch((error: unknown) => {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return null;
        throw error;
      });
      // Archived owner paths may already be absent.
      if (!state) {
        if ((await realpath(dirname(actual))) !== dirname(actual))
          throw new RelocationRefusedError('noncanonical-owned-path');
        break;
      }
      if (state.isSymbolicLink()) {
        if ((await realpath(dirname(actual))) !== dirname(actual))
          throw new RelocationRefusedError('noncanonical-owned-path');
        const target = await checkedLinkTarget(
          transition,
          workingRoot,
          current,
          await readlink(actual),
          paths,
          prefixes,
          published,
        );
        if (index !== parts.length - 1)
          throw new RelocationRefusedError('symlink-owned-parent');
        links.set(path, target);
      } else if (index !== parts.length - 1 && !state.isDirectory()) {
        throw new RelocationRefusedError('nondirectory-owned-parent');
      } else if (
        index === parts.length - 1 &&
        (await realpath(actual)) !== actual
      ) {
        throw new RelocationRefusedError('noncanonical-owned-path');
      }
    }
  }
  const checked = new Set<string>();
  for (const path of links.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = path;
    while (current !== undefined && !checked.has(current)) {
      if (seen.has(current))
        throw new RelocationRefusedError('cyclic-owned-link');
      seen.add(current);
      current = links.get(current);
    }
    for (const path of seen) checked.add(path);
  }
}
