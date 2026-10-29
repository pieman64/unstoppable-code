/**
 * @jest-environment jsdom
 */
import type {
  MultiRepoSidebarItem,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';

const loadProjectsMock = jest.fn();

function makeMultiRepoItem(
  id: string,
  overrides: {
    temporary?: boolean;
    archivedContainerCount?: number;
    alwaysShow?: boolean;
    worktrees?: MultiRepoSidebarItem['worktrees'];
  } = {},
): SidebarItem {
  return {
    type: 'multi-repo',
    id,
    name: `Workspace ${id}`,
    color: '#336699',
    repos: [],
    worktrees: overrides.worktrees ?? [],
    collapsed: false,
    order: 0,
    ...(overrides.alwaysShow !== undefined
      ? { alwaysShow: overrides.alwaysShow }
      : {}),
    ...(overrides.temporary !== undefined
      ? { temporary: overrides.temporary }
      : {}),
    ...(overrides.archivedContainerCount !== undefined
      ? { archivedContainerCount: overrides.archivedContainerCount }
      : {}),
  };
}

async function loadWithItems(items: SidebarItem[]): Promise<string[]> {
  loadProjectsMock.mockResolvedValue({ items, warnings: [] });
  await useProjectsStore.getState().loadProjects();
  return useProjectsStore.getState().projects.map((item) => item.id);
}

beforeEach(() => {
  loadProjectsMock.mockReset();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadProjects: loadProjectsMock,
      // Defensive: `loadProjects` refreshes workspace drift per worktree. The
      // items in these tests carry no worktrees, but stub it anyway so an
      // incidental call cannot crash the run.
      readWorkspaceDriftSummary: jest.fn().mockResolvedValue({
        hasDrift: false,
        blockingIssueCount: 0,
        warningIssueCount: 0,
      }),
      savePreferences: jest.fn().mockResolvedValue(undefined),
    },
  });
  useProjectsStore.setState({
    projects: [],
    isLoading: false,
    hasHydratedProjects: false,
    projectLoadWarningKeys: new Set<string>(),
  });
});

it('reports a failed required inventory refresh while preserving the current projects', async () => {
  await loadWithItems([
    makeMultiRepoItem('kept', { archivedContainerCount: 1 }),
  ]);
  const before = useProjectsStore.getState().projects;
  loadProjectsMock.mockRejectedValue(new Error('inventory offline'));
  await expect(
    useProjectsStore
      .getState()
      .loadProjects({ silent: true, requireSuccess: true }),
  ).rejects.toThrow('inventory offline');
  expect(useProjectsStore.getState().projects).toEqual(before);
  await expect(
    useProjectsStore.getState().loadProjects({ silent: true }),
  ).resolves.toBeUndefined();
});

describe('projectsStore archived-container visibility (filterVisibleWorkspaceItems)', () => {
  it('keeps a temporary empty multi-repo project that still owns archived containers', async () => {
    const ids = await loadWithItems([
      makeMultiRepoItem('temp-with-archives', {
        temporary: true,
        archivedContainerCount: 2,
      }),
    ]);

    expect(ids).toEqual(['temp-with-archives']);
  });

  it('drops a temporary empty multi-repo project whose archived count is 0', async () => {
    const ids = await loadWithItems([
      makeMultiRepoItem('temp-zero-archives', {
        temporary: true,
        archivedContainerCount: 0,
      }),
    ]);

    expect(ids).toEqual([]);
  });

  it('drops a temporary empty multi-repo project with no archived count at all', async () => {
    const ids = await loadWithItems([
      makeMultiRepoItem('temp-undefined-archives', { temporary: true }),
    ]);

    expect(ids).toEqual([]);
  });

  it('keeps a temporary empty multi-repo project with explicit Always show', async () => {
    const ids = await loadWithItems([
      makeMultiRepoItem('temp-kept', {
        temporary: true,
        alwaysShow: true,
        archivedContainerCount: 0,
      }),
    ]);

    expect(ids).toEqual(['temp-kept']);
  });

  it('drops a temporary empty multi-repo project with Always show off', async () => {
    const ids = await loadWithItems([
      makeMultiRepoItem('temp-disposable', {
        temporary: true,
        alwaysShow: false,
        archivedContainerCount: 0,
      }),
    ]);

    expect(ids).toEqual([]);
  });

  it('keeps a temporary multi-repo project with a worktree whatever Always show says', async () => {
    const worktrees = [
      {
        id: 'worktree-1',
        branchName: 'feature',
        createdAt: new Date(0).toISOString(),
      },
    ];
    const ids = await loadWithItems([
      makeMultiRepoItem('temp-live-off', {
        temporary: true,
        alwaysShow: false,
        worktrees,
      }),
      makeMultiRepoItem('temp-live-unset', { temporary: true, worktrees }),
    ]);

    expect(ids).toEqual(['temp-live-off', 'temp-live-unset']);
  });

  it('keeps a temporary empty multi-repo project with archives and Always show off', async () => {
    const ids = await loadWithItems([
      makeMultiRepoItem('temp-archived-off', {
        temporary: true,
        alwaysShow: false,
        archivedContainerCount: 1,
      }),
    ]);

    expect(ids).toEqual(['temp-archived-off']);
  });

  it('keeps a non-temporary empty multi-repo project regardless of archived count', async () => {
    const ids = await loadWithItems([makeMultiRepoItem('permanent-empty')]);

    expect(ids).toEqual(['permanent-empty']);
  });

  it('filters only the archive-less temporary project out of a mixed list', async () => {
    const ids = await loadWithItems([
      makeMultiRepoItem('temp-with-archives', {
        temporary: true,
        archivedContainerCount: 1,
      }),
      makeMultiRepoItem('temp-without-archives', { temporary: true }),
      makeMultiRepoItem('permanent-empty'),
    ]);

    expect(ids).toEqual(
      expect.arrayContaining(['temp-with-archives', 'permanent-empty']),
    );
    expect(ids).not.toContain('temp-without-archives');
    expect(ids).toHaveLength(2);
  });
});
