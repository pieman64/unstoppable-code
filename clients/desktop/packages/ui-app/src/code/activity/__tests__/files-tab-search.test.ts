import {
  buildFilesTabSearchTree,
  flattenFilesTabSearchTree,
  normalizeFilesTabSearchQuery,
} from '../files-tab-search';
describe('file search', () => {
  it('nests matches, orders folders first and respects collapsed paths', () => {
    const tree = buildFilesTabSearchTree(
      ['src/z.ts', 'src/lib/b.ts', 'README.md', 'src/a.ts'],
      ' SRC ',
    );
    expect(normalizeFilesTabSearchQuery(' SRC ')).toBe('src');
    expect(tree.matchCount).toBe(3);
    expect(
      flattenFilesTabSearchTree(tree.nodes, new Set()).map(
        ({ node, depth }) => [node.relativePath, depth],
      ),
    ).toEqual([
      ['src', 0],
      ['src/lib', 1],
      ['src/lib/b.ts', 2],
      ['src/a.ts', 1],
      ['src/z.ts', 1],
    ]);
    expect(
      flattenFilesTabSearchTree(tree.nodes, new Set(['src'])),
    ).toHaveLength(1);
  });
  it('counts all matches while limiting displayed files and ignores empty queries', () => {
    expect(buildFilesTabSearchTree(['a.ts', 'b.ts'], '.ts', 1)).toMatchObject({
      shownCount: 1,
      matchCount: 2,
    });
    expect(buildFilesTabSearchTree(['a.ts'], '')).toEqual({
      nodes: [],
      shownCount: 0,
      matchCount: 0,
    });
  });
});
