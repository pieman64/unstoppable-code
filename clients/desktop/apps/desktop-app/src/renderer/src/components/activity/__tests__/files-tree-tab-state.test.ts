import type {
  FileIndexEntry,
  FileTreeRoot,
} from '@canopy/desktop-shared/types';
import type { CachedRootsEntry } from '@/stores/fileListStore';
import {
  APP_MANAGED_ROOTS_TREE_PATH,
  buildFilteredFileTree,
  getAutoExpandRepoPath,
  getRepoTreePath,
  isVisibleExpandedTreePath,
  matchesFileTreeSearchQuery,
  shouldFetchFilesTreeIndex,
  shouldFetchFilesTreeRoots,
  type FilteredFileTreeDirectory,
  type FilteredFileTreeNode,
} from '../files-tree-tab-state';

function createRoot(overrides: Partial<FileTreeRoot> = {}): FileTreeRoot {
  return {
    repoId: 'repo-1',
    repoName: 'repo-1',
    absolutePath: '/repo',
    rootKind: 'git-repo',
    ...overrides,
  };
}

function createCacheEntry(
  fetchedAt: number,
  roots: FileTreeRoot[],
): CachedRootsEntry {
  return {
    fetchedAt,
    data: { roots },
  };
}

describe('shouldFetchFilesTreeRoots', () => {
  it('does not schedule a second fetch while a request is already in flight', () => {
    const staleEntry = createCacheEntry(0, [createRoot()]);

    expect(
      shouldFetchFilesTreeRoots(
        'project-1',
        'wt-1',
        staleEntry,
        true,
        undefined,
      ),
    ).toBe(false);
  });

  it('fetches stale data once no request is in flight', () => {
    const staleEntry = createCacheEntry(0, [createRoot()]);

    expect(
      shouldFetchFilesTreeRoots(
        'project-1',
        'wt-1',
        staleEntry,
        false,
        undefined,
      ),
    ).toBe(true);
  });

  it('does not auto-retry while the current file tree load error is still present', () => {
    expect(
      shouldFetchFilesTreeRoots(
        'project-1',
        'wt-1',
        undefined,
        false,
        'Load failed',
      ),
    ).toBe(false);
  });
});

describe('getAutoExpandRepoPath', () => {
  it('auto-expands a single root before the first expansion lock-in', () => {
    expect(getAutoExpandRepoPath([createRoot()], false)).toBe('repo:repo-1');
  });

  it('does not auto-expand again after the tab has already expanded once', () => {
    expect(getAutoExpandRepoPath([createRoot()], true)).toBeNull();
  });

  it('does not auto-expand multiple roots', () => {
    expect(
      getAutoExpandRepoPath(
        [createRoot(), createRoot({ repoId: 'repo-2' })],
        false,
      ),
    ).toBeNull();
  });

  it('expands only the Cowork working folder among its catalog roots', () => {
    const cowork = [
      createRoot({ repoId: 'workspace', rootKind: 'standalone' }),
      createRoot({ repoId: 'notes', rootKind: 'standalone' }),
      createRoot({ repoId: 'prompts', rootKind: 'standalone' }),
      createRoot({ repoId: 'attachments', rootKind: 'attachments' }),
    ];
    expect(getAutoExpandRepoPath(cowork, false)).toBe('repo:workspace');
    expect(getAutoExpandRepoPath(cowork, true)).toBeNull();
  });

  it('does not treat a git repository with the workspace id as Cowork', () => {
    expect(
      getAutoExpandRepoPath(
        [
          createRoot({ repoId: 'workspace', rootKind: 'git-repo' }),
          createRoot({ repoId: 'notes', rootKind: 'standalone' }),
        ],
        false,
      ),
    ).toBeNull();
  });
});

describe('isVisibleExpandedTreePath', () => {
  const grouped = new Set(['repo:notes']);

  it('requires the group to be expanded for roots inside it', () => {
    const expanded = new Set(['repo:notes', 'repo:notes/daily']);
    expect(isVisibleExpandedTreePath('repo:notes', expanded, grouped)).toBe(
      false,
    );
    expect(
      isVisibleExpandedTreePath('repo:notes/daily', expanded, grouped),
    ).toBe(false);
    expanded.add(APP_MANAGED_ROOTS_TREE_PATH);
    expect(
      isVisibleExpandedTreePath('repo:notes/daily', expanded, grouped),
    ).toBe(true);
  });

  it('never treats the group key as a refreshable directory', () => {
    expect(
      isVisibleExpandedTreePath(
        APP_MANAGED_ROOTS_TREE_PATH,
        new Set([APP_MANAGED_ROOTS_TREE_PATH]),
        grouped,
      ),
    ).toBe(false);
  });

  it('keeps ungrouped roots independent of the group state', () => {
    expect(
      isVisibleExpandedTreePath(
        'repo:workspace/src',
        new Set(['repo:workspace', 'repo:workspace/src']),
        grouped,
      ),
    ).toBe(true);
  });
});

describe('getRepoTreePath', () => {
  it('uses the root repo id as the stable expansion key', () => {
    expect(getRepoTreePath({ repoId: 'attachments' })).toBe('repo:attachments');
  });
});

describe('shouldFetchFilesTreeIndex', () => {
  it('fetches the flat index when nothing is cached yet', () => {
    expect(
      shouldFetchFilesTreeIndex(
        'project-1',
        'wt-1',
        undefined,
        false,
        undefined,
      ),
    ).toBe(true);
  });

  it('does not refetch a fresh index', () => {
    expect(
      shouldFetchFilesTreeIndex(
        'project-1',
        'wt-1',
        { fetchedAt: Date.now(), data: { repos: [] } },
        false,
        undefined,
      ),
    ).toBe(false);
  });

  it('does not stack a second request while one is in flight', () => {
    expect(
      shouldFetchFilesTreeIndex(
        'project-1',
        'wt-1',
        undefined,
        true,
        undefined,
      ),
    ).toBe(false);
  });

  it('does not auto-retry while the current index error is still present', () => {
    expect(
      shouldFetchFilesTreeIndex(
        'project-1',
        'wt-1',
        undefined,
        false,
        'Load failed',
      ),
    ).toBe(false);
  });

  it('needs a selected worktree', () => {
    expect(
      shouldFetchFilesTreeIndex(null, null, undefined, false, undefined),
    ).toBe(false);
  });
});

describe('matchesFileTreeSearchQuery', () => {
  it('matches case-insensitively anywhere in the relative path', () => {
    expect(matchesFileTreeSearchQuery('src/ui/Button.tsx', 'button')).toBe(
      true,
    );
    expect(matchesFileTreeSearchQuery('src/ui/Button.tsx', 'ui/but')).toBe(
      true,
    );
  });

  it('does not match an unrelated path', () => {
    expect(matchesFileTreeSearchQuery('src/ui/Button.tsx', 'modal')).toBe(
      false,
    );
  });

  it('treats an empty query as no filter rather than matching everything', () => {
    expect(matchesFileTreeSearchQuery('src/ui/Button.tsx', '')).toBe(false);
  });
});

describe('buildFilteredFileTree', () => {
  function createFile(relativePath: string): FileIndexEntry {
    const segments = relativePath.split('/');
    return {
      relativePath,
      filename: segments[segments.length - 1] ?? relativePath,
      absolutePath: `/repo/${relativePath}`,
      isIgnored: false,
    };
  }

  const FILES: FileIndexEntry[] = [
    createFile('README.md'),
    createFile('src/index.ts'),
    createFile('src/ui/Button.tsx'),
    createFile('src/ui/nested/ButtonGroup.tsx'),
    createFile('docs/button-guide.md'),
  ];

  function expectDirectory(
    node: FilteredFileTreeNode | undefined,
  ): FilteredFileTreeDirectory {
    if (!node || node.kind !== 'directory') {
      throw new Error(`Expected a directory node, received ${node?.kind}`);
    }
    return node;
  }

  it('returns nothing for an empty query', () => {
    expect(buildFilteredFileTree(FILES, '   ')).toEqual({
      nodes: [],
      shownCount: 0,
      matchCount: 0,
    });
  });

  it('keeps the folder parentage of a nested match', () => {
    const tree = buildFilteredFileTree(FILES, 'ButtonGroup');

    expect(tree.matchCount).toBe(1);
    expect(tree.shownCount).toBe(1);
    const src = expectDirectory(tree.nodes[0]);
    expect(src.name).toBe('src');
    expect(src.relativePath).toBe('src');
    expect(src.absolutePath).toBe('/repo/src');
    const ui = expectDirectory(src.children[0]);
    expect(ui.name).toBe('ui');
    expect(ui.absolutePath).toBe('/repo/src/ui');
    const nested = expectDirectory(ui.children[0]);
    expect(nested.name).toBe('nested');
    expect(nested.children).toEqual([
      {
        kind: 'file',
        name: 'ButtonGroup.tsx',
        relativePath: 'src/ui/nested/ButtonGroup.tsx',
        absolutePath: '/repo/src/ui/nested/ButtonGroup.tsx',
        isIgnored: false,
      },
    ]);
  });

  it('drops folders with no surviving descendant', () => {
    const tree = buildFilteredFileTree(FILES, 'index.ts');

    expect(tree.nodes).toHaveLength(1);
    const src = expectDirectory(tree.nodes[0]);
    expect(src.children.map((child) => child.name)).toEqual(['index.ts']);
  });

  it('collects every match across sibling folders and lists folders first', () => {
    const tree = buildFilteredFileTree(FILES, 'button');

    expect(tree.matchCount).toBe(3);
    expect(tree.nodes.map((node) => node.kind)).toEqual([
      'directory',
      'directory',
    ]);
    expect(tree.nodes.map((node) => node.name)).toEqual(['docs', 'src']);
    const ui = expectDirectory(expectDirectory(tree.nodes[1]).children[0]);
    // Nested directory sorts ahead of the sibling file at the same level.
    expect(ui.children.map((child) => child.name)).toEqual([
      'nested',
      'Button.tsx',
    ]);
  });

  it('caps rendered files while still reporting the full match total', () => {
    const tree = buildFilteredFileTree(FILES, 'button', 1);

    expect(tree.matchCount).toBe(3);
    expect(tree.shownCount).toBe(1);
    expect(tree.nodes).toHaveLength(1);
  });

  it('reports matches without rendering any when the budget is exhausted', () => {
    const tree = buildFilteredFileTree(FILES, 'button', 0);

    expect(tree.matchCount).toBe(3);
    expect(tree.shownCount).toBe(0);
    expect(tree.nodes).toEqual([]);
  });

  it('derives ancestor absolute paths with the host separator', () => {
    const tree = buildFilteredFileTree(
      [
        {
          relativePath: 'src/ui/Button.tsx',
          filename: 'Button.tsx',
          absolutePath: 'C:\\repo\\src\\ui\\Button.tsx',
          isIgnored: false,
        },
      ],
      'button',
    );

    const src = expectDirectory(tree.nodes[0]);
    expect(src.absolutePath).toBe('C:\\repo\\src');
    expect(expectDirectory(src.children[0]).absolutePath).toBe(
      'C:\\repo\\src\\ui',
    );
  });
});
