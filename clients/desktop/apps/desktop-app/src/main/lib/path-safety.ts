import * as path from 'path';

/**
 * Check whether `childPath` is inside (or equal to) `parentDir`.
 * Both paths are resolved and normalized before comparison.
 */
export function isPathInside(parentDir: string, childPath: string): boolean {
  const relative = path.relative(
    path.resolve(parentDir),
    path.resolve(childPath),
  );
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}
