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
