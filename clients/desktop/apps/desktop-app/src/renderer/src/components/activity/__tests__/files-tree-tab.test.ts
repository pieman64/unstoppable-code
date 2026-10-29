import { joinRelativePath, sortDirectoryEntries } from '../files-tree-helpers';
import type { FileTreeEntry } from '@canopy/desktop-shared/types';

function createEntry(
  overrides: Partial<FileTreeEntry> & { name: string },
): FileTreeEntry {
  return {
    name: overrides.name,
    relativePath: overrides.relativePath ?? overrides.name,
    absolutePath: overrides.absolutePath ?? `/repo/${overrides.name}`,
    kind: overrides.kind ?? 'file',
    isIgnored: overrides.isIgnored ?? false,
    isIndexExcluded: overrides.isIndexExcluded ?? false,
    isSymlink: overrides.isSymlink ?? false,
    hasChildren: overrides.hasChildren ?? false,
  };
}

describe('sortDirectoryEntries', () => {
  it('orders directories before files and ties break by localeCompare', () => {
    const entries: FileTreeEntry[] = [
      createEntry({ name: 'zeta.txt' }),
      createEntry({ name: 'alpha', kind: 'directory' }),
      createEntry({ name: 'beta.txt' }),
      createEntry({ name: 'gamma', kind: 'directory' }),
    ];

    const sorted = sortDirectoryEntries(entries);

    // Directories come before files; within each kind, names sort by
    // `localeCompare` (locale-sensitive, so case-insensitive on most
    // platforms — we deliberately avoid mixed-case names here).
    expect(sorted.map((e) => e.name)).toEqual([
      'alpha',
      'gamma',
      'beta.txt',
      'zeta.txt',
    ]);
  });

  it('returns a new array (does not mutate the input)', () => {
    const entries = [
      createEntry({ name: 'b.txt' }),
      createEntry({ name: 'a.txt' }),
    ];

    const sorted = sortDirectoryEntries(entries);

    expect(sorted).not.toBe(entries);
    expect(entries.map((e) => e.name)).toEqual(['b.txt', 'a.txt']);
  });
});

describe('joinRelativePath', () => {
  it('returns just the segment when the parent path is empty', () => {
    expect(joinRelativePath('', 'src')).toBe('src');
  });

  it('joins a parent path with a child segment using a forward slash', () => {
    expect(joinRelativePath('src', 'index.ts')).toBe('src/index.ts');
    expect(joinRelativePath('a/b', 'c')).toBe('a/b/c');
  });
});
