import { realpathSync } from 'node:fs';
import * as path from 'node:path';

export function isPathInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(
    path.resolve(parentPath),
    path.resolve(childPath),
  );
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/**
 * The realpath of `value`, or of its deepest existing ancestor joined with the
 * rest of the resolved path when the end of it does not exist yet. Null when
 * a component cannot be resolved for any other reason.
 */
function realpathOrAncestor(value: string): string | null {
  const resolved = path.resolve(value);
  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missing.reverse());
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined;
      const parent = path.dirname(current);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === current)
        return null;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * `childPath` relative to `parentPath` when it is lexically inside the parent
 * as named, or when its own realpath is inside the parent's realpath; null
 * otherwise. Both sides are resolved, so a symlink under the parent that
 * leaves it is refused.
 */
export function relativeInsideByNameOrRealpath(
  parentPath: string,
  childPath: string,
): string | null {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  if (isPathInside(parent, child)) return path.relative(parent, child);
  const realParent = realpathOrAncestor(parent);
  const realChild = realpathOrAncestor(child);
  if (realParent === null || realChild === null) return null;
  return isPathInside(realParent, realChild)
    ? path.relative(realParent, realChild)
    : null;
}
