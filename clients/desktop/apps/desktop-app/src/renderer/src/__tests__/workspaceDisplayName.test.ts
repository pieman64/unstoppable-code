import type {
  MultiRepoSidebarItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import {
  formatRepoListName,
  getWorkspaceDisplayName,
} from '../lib/workspaceDisplayName';

function makeMultiRepoSidebarItem(
  repos: { id: string; name: string }[],
  temporary: boolean,
): MultiRepoSidebarItem {
  return {
    type: 'multi-repo',
    id: 'workspace-id',
    name: 'workspace-stored-name',
    color: '#000000',
    repos: repos.map((repo) => ({
      id: repo.id,
      name: repo.name,
      repoPath: `/tmp/${repo.id}`,
    })),
    worktrees: [],
    collapsed: false,
    order: 0,
    temporary,
  };
}

function makeSingleRepoSidebarItem(name: string): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    id: 'workspace-id',
    name,
    color: '#000000',
    repoPath: '/tmp/single',
    collapsed: false,
    order: 0,
    worktrees: [],
  };
}

describe('formatRepoListName', () => {
  it('returns a `Temporary project` fallback for an empty list', () => {
    expect(formatRepoListName([])).toBe('Temporary project');
  });

  it('returns the single repo name when only one repo is present', () => {
    expect(formatRepoListName(['Solo Repo'])).toBe('Solo Repo');
  });

  it('joins two repos with an ampersand', () => {
    expect(formatRepoListName(['Repo A', 'Repo B'])).toBe('Repo A & Repo B');
  });

  it('uses an Oxford-style join for three or more repos', () => {
    expect(formatRepoListName(['Repo A', 'Repo B', 'Repo C'])).toBe(
      'Repo A, Repo B & Repo C',
    );
    expect(formatRepoListName(['One', 'Two', 'Three', 'Four'])).toBe(
      'One, Two, Three & Four',
    );
  });

  it('ignores blank repo names before deriving a temporary project name', () => {
    expect(formatRepoListName(['', '  ', 'Repo A'])).toBe('Repo A');
    expect(formatRepoListName(['', '  '])).toBe('Temporary project');
  });
});

describe('getWorkspaceDisplayName', () => {
  it('returns the stored name for single-repo projects', () => {
    expect(getWorkspaceDisplayName(makeSingleRepoSidebarItem('my-repo'))).toBe(
      'my-repo',
    );
  });

  it('returns the stored name for non-temporary multi-repo projects', () => {
    const item = makeMultiRepoSidebarItem(
      [
        { id: 'r1', name: 'Repo A' },
        { id: 'r2', name: 'Repo B' },
      ],
      false,
    );
    expect(getWorkspaceDisplayName(item)).toBe('workspace-stored-name');
  });

  it('returns the derived display name for temporary multi-repo projects', () => {
    const item = makeMultiRepoSidebarItem(
      [
        { id: 'r1', name: 'Repo A' },
        { id: 'r2', name: 'Repo B' },
      ],
      true,
    );
    expect(getWorkspaceDisplayName(item)).toBe('Repo A & Repo B');
  });

  it('falls back when persisted project metadata has no usable name', () => {
    const item = {
      ...makeSingleRepoSidebarItem('my-repo'),
      name: undefined,
    } as unknown as SingleRepoSidebarItem;

    expect(getWorkspaceDisplayName(item)).toBe('Untitled project');
  });

  it('falls back for temporary projects when repo names are missing', () => {
    const item = {
      ...makeMultiRepoSidebarItem([{ id: 'r1', name: 'Repo A' }], true),
      repos: [{ id: 'r1', repoPath: '/tmp/r1' }],
    } as unknown as MultiRepoSidebarItem;

    expect(getWorkspaceDisplayName(item)).toBe('Temporary project');
  });
});
