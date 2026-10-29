import type { FileTreeEntry } from '@canopy/desktop-shared/types';

/**
 * Sort directory entries directories-first, then by `localeCompare` on
 * `name`. Backend already returns sorted output, but we re-sort defensively
 * so renderer-side merges (e.g. local optimistic insertions) stay consistent.
 */
export function sortDirectoryEntries(
  entries: readonly FileTreeEntry[],
): FileTreeEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

/**
 * Join a parent directory path and a child segment, omitting the leading
 * slash when the parent path is empty (root).
 */
export function joinRelativePath(
  parentRelativePath: string,
  segment: string,
): string {
  if (parentRelativePath.length === 0) return segment;
  return `${parentRelativePath}/${segment}`;
}
