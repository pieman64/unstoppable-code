import { lstatSync, realpathSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';

export interface StoragePathObservation {
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly kind: 'directory' | 'file' | 'other' | 'missing';
  readonly stat: Stats | undefined;
  readonly existingAncestor: string;
  readonly missingComponents: readonly string[];
  readonly symbolicLinkComponents: readonly string[];
}

function kind(stat: Stats): 'directory' | 'file' | 'other' {
  return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
}

/** Filesystem facts only: callers still own admission and effect-time rechecks. */
export function observeStoragePathSync(path: string): StoragePathObservation {
  const windows = sep === '\\';
  // Keep this leaf independent of core-platform/paths.ts: Playwright and tsx load it in both module formats.
  const qualified = windows
    ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}(?![?.][\\/])[^\\/]+[\\/]+[^\\/])/.test(path)
    : isAbsolute(path);
  if (path.includes('\0') || !qualified)
    throw new TypeError('Storage paths must be fully qualified.');
  const requestedPath = resolve(path);
  const root = parse(requestedPath).root;
  const components = requestedPath
    .slice(root.length)
    .split(sep)
    .filter(Boolean);
  const symbolicLinkComponents: string[] = [];
  let requested = root;
  let canonical = realpathSync.native(root);
  let stat = statSync(canonical);
  for (const [index, component] of components.entries()) {
    // Windows may report ENOENT, not ENOTDIR, when traversing a file.
    if (!stat.isDirectory())
      throw Object.assign(
        new Error('Storage path traverses a non-directory.'),
        { code: 'ENOTDIR' },
      );
    requested = join(requested, component);
    let entry: Stats;
    try {
      entry = lstatSync(requested);
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
      const missingComponents = components.slice(index);
      return {
        requestedPath,
        canonicalPath: join(canonical, ...missingComponents),
        kind: 'missing',
        stat: undefined,
        existingAncestor: canonical,
        missingComponents,
        symbolicLinkComponents,
      };
    }
    if (entry.isSymbolicLink()) symbolicLinkComponents.push(requested);
    // Dangling links and cycles must throw, never become missing suffixes.
    canonical = realpathSync.native(requested);
    stat = entry.isSymbolicLink() ? statSync(canonical) : entry;
  }
  return {
    requestedPath,
    canonicalPath: canonical,
    kind: kind(stat),
    stat,
    existingAncestor: canonical,
    missingComponents: [],
    symbolicLinkComponents,
  };
}
