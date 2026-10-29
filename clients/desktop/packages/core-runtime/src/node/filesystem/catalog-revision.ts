import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import type * as path from 'node:path';

import type { FilesystemRoot, FilesystemRootCatalog } from './root-catalog';

type PathDependencies = Pick<typeof path, 'resolve' | 'sep'>;

/** Missing optional roots are tied to their existing ancestor's native identity. */
export async function readNativeRootIdentity(
  absolutePath: string,
): Promise<string> {
  try {
    const canonical = await realpath(absolutePath);
    const info = await stat(canonical, { bigint: true });
    return JSON.stringify([
      canonical,
      String(info.dev),
      String(info.ino),
      String(info.birthtimeNs),
    ]);
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      Reflect.get(error, 'code') !== 'ENOENT'
    )
      throw error;
    const parent = dirname(absolutePath);
    if (parent === absolutePath) throw error;
    return JSON.stringify([
      'absent',
      basename(absolutePath),
      await readNativeRootIdentity(parent),
    ]);
  }
}

function normalizeAbsolutePath(path: string, paths: PathDependencies): string {
  if (paths.sep === '\\') {
    return paths.resolve(path.replace(/\//g, '\\')).toLowerCase();
  }
  return paths.resolve(path);
}

/** An opaque cache token, not a filesystem containment or authorization check. */
export async function createCatalogRevision(
  catalog: FilesystemRootCatalog,
  dependencies: {
    paths: PathDependencies;
    rootIdentity(absolutePath: string): Promise<string>;
  },
  scopeKey: string,
): Promise<string> {
  const identities = new Map<string, Promise<string>>();
  const describePath = async (path: string): Promise<[string, string]> => {
    const normalized = normalizeAbsolutePath(path, dependencies.paths);
    let identity = identities.get(normalized);
    if (identity === undefined) {
      identity = dependencies.rootIdentity(normalized);
      identities.set(normalized, identity);
    }
    return [normalized, await identity];
  };
  const describeRoot = async (root: FilesystemRoot): Promise<unknown> => ({
    id: root.id,
    name: root.name,
    kind: root.kind,
    gitAware: root.gitAware,
    path: await describePath(root.absolutePath),
    exclusions: await Promise.all(
      root.excludedDescendantRoots.map((path) => describePath(path)),
    ),
  });

  const roots = await Promise.all(catalog.roots.map(describeRoot));
  const byId = await Promise.all(
    Array.from(catalog.byId)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(
        async ([id, root]): Promise<[string, unknown]> => [
          id,
          await describeRoot(root),
        ],
      ),
  );
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, scopeKey, roots, byId }))
    .digest('hex');
}
