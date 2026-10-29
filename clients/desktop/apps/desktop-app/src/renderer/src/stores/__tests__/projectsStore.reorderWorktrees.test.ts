import type {
  CanopyApi,
  SingleRepoSidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useBranchGroupingPreferenceStore } from '@/stores/branchGroupingPreferenceStore';

const PROJECT_ID = 'project-1';

function makeWorktree(id: string, hidden?: boolean): WorktreeData {
  if (hidden) {
    return {
      id,
      branchName: id,
      createdAt: '2026-05-04T00:00:00.000Z',
      hidden: true,
    };
  }

  return {
    id,
    branchName: id,
    createdAt: '2026-05-04T00:00:00.000Z',
  };
}

function makeProject(worktrees: WorktreeData[]): SingleRepoSidebarItem {
  return {
    id: PROJECT_ID,
    type: 'single-repo',
    name: 'test-project',
    repoPath: '/tmp/repo',
    color: '#000000',
    order: 0,
    collapsed: false,
    worktrees,
    scripts: {},
    effectiveScripts: {},
    hooks: {},
    effectiveHooks: {},
  };
}

declare global {
  interface Window {
    api: CanopyApi;
  }
}

const mockReorderWorktrees = jest.fn().mockResolvedValue(undefined);
const mockLoadProjects = jest.fn();
const mockSaveProjects = jest.fn().mockResolvedValue(undefined);
const mockSetWorktreeBranchGrouping = jest.fn().mockResolvedValue(undefined);
const mockSetWorktreePinned = jest.fn().mockResolvedValue(undefined);
const mockUpdateWorkspaceMetadata = jest.fn().mockResolvedValue(undefined);

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        saveProjects: mockSaveProjects,
        reorderWorktrees: mockReorderWorktrees,
        loadProjects: mockLoadProjects,
        setWorktreeBranchGrouping: mockSetWorktreeBranchGrouping,
        setWorktreePinned: mockSetWorktreePinned,
        updateWorkspaceMetadata: mockUpdateWorkspaceMetadata,
      },
    },
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('projectsStore.reorderWorktrees', () => {
  beforeEach(() => {
    mockSaveProjects.mockClear();
    mockReorderWorktrees.mockReset().mockResolvedValue(undefined);
    mockLoadProjects
      .mockReset()
      .mockImplementation(() =>
        Promise.resolve({ items: useProjectsStore.getState().projects }),
      );
    useProjectsStore.setState({
      projects: [
        makeProject([
          makeWorktree('visible-a'),
          makeWorktree('hidden-b', true),
          makeWorktree('visible-c'),
          makeWorktree('visible-d'),
        ]),
      ],
    });
  });

  it('reorders visible worktrees without moving hidden entries', async () => {
    await useProjectsStore
      .getState()
      .reorderWorktrees(PROJECT_ID, 'visible-d', 'visible-a');

    const project = useProjectsStore.getState().projects[0];
    const worktrees =
      project?.type === 'cowork' ? [] : (project?.worktrees ?? []);

    expect(worktrees.map((worktree) => worktree.id)).toEqual([
      'visible-d',
      'hidden-b',
      'visible-a',
      'visible-c',
    ]);
    expect(worktrees[1].hidden).toBe(true);
    expect(mockSaveProjects).not.toHaveBeenCalled();
    expect(mockReorderWorktrees).toHaveBeenCalledWith({
      workspaceId: PROJECT_ID,
      activeWorktreeId: 'visible-d',
      overWorktreeId: 'visible-a',
    });
  });
  it.each([
    ['missing-project', 'visible-d', 'visible-a'],
    [PROJECT_ID, 'missing-worktree', 'visible-a'],
    [PROJECT_ID, 'hidden-b', 'visible-a'],
    [PROJECT_ID, 'visible-a', 'visible-a'],
  ])(
    'does not persist an invalid or unchanged move: %s %s %s',
    async (projectId, active, over) => {
      const original = useProjectsStore.getState().projects;
      await useProjectsStore
        .getState()
        .reorderWorktrees(projectId, active, over);
      expect(useProjectsStore.getState().projects).toBe(original);
      expect(mockReorderWorktrees).not.toHaveBeenCalled();
      expect(mockSaveProjects).not.toHaveBeenCalled();
      expect(mockLoadProjects).not.toHaveBeenCalled();
    },
  );

  it('restores canonical state when the targeted reorder fails', async () => {
    const canonical = makeProject([
      makeWorktree('visible-a'),
      makeWorktree('concurrent-created'),
    ]);
    mockReorderWorktrees.mockRejectedValueOnce(
      new Error('Target was archived'),
    );
    mockLoadProjects.mockResolvedValueOnce({ items: [canonical] });
    const toast = jest
      .spyOn(useGitHubStore.getState(), 'addToast')
      .mockImplementation(() => undefined);
    try {
      await useProjectsStore
        .getState()
        .reorderWorktrees(PROJECT_ID, 'visible-d', 'visible-a');
      // Loading also hydrates PR status; assert the canonical inventory and order.
      expect(useProjectsStore.getState().projects).toMatchObject([canonical]);
      expect(mockSaveProjects).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalled();
    } finally {
      toast.mockRestore();
    }
  });

  it('reconciles after acknowledgement and supersedes an older pending load', async () => {
    let resolveOld:
      | ((value: { items: SingleRepoSidebarItem[] }) => void)
      | undefined;
    let acknowledge: (() => void) | undefined;
    const oldItems = useProjectsStore.getState().projects;
    const oldProject = oldItems[0];
    if (!oldProject || oldProject.type !== 'single-repo')
      throw new Error('Expected project');
    const canonical = makeProject([
      makeWorktree('visible-d'),
      makeWorktree('hidden-b', true),
      makeWorktree('concurrent-created'),
      makeWorktree('visible-a'),
      makeWorktree('visible-c'),
    ]);
    mockLoadProjects.mockImplementationOnce(
      () =>
        new Promise<{ items: SingleRepoSidebarItem[] }>((resolve) => {
          resolveOld = resolve;
        }),
    );
    mockLoadProjects.mockResolvedValueOnce({ items: [canonical] });
    mockReorderWorktrees.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const pendingLoad = useProjectsStore
      .getState()
      .loadProjects({ silent: true });
    const pendingReorder = useProjectsStore
      .getState()
      .reorderWorktrees(PROJECT_ID, 'visible-d', 'visible-a');
    expect(mockLoadProjects).toHaveBeenCalledTimes(1);
    acknowledge?.();
    await pendingReorder;
    resolveOld?.({ items: [oldProject] });
    await pendingLoad;
    expect(mockReorderWorktrees).toHaveBeenCalledTimes(1);
    expect(mockLoadProjects).toHaveBeenCalledTimes(2);
    // Loading also hydrates PR status; assert the canonical inventory and order.
    expect(useProjectsStore.getState().projects).toMatchObject([canonical]);
    expect(mockSaveProjects).not.toHaveBeenCalled();
  });
});

describe('projectsStore.reorderProjects', () => {
  beforeEach(() => {
    mockSaveProjects.mockClear();
    useProjectsStore.setState({
      projects: [
        { ...makeProject([]), id: 'project-a', name: 'A', order: 0 },
        { ...makeProject([]), id: 'project-b', name: 'B', order: 1 },
      ],
    });
  });

  it('marks an intentional desktop reorder as a workspace-order replacement', async () => {
    await useProjectsStore.getState().reorderProjects('project-b', 'project-a');

    expect(mockSaveProjects).toHaveBeenCalledWith(
      [
        expect.objectContaining({ id: 'project-b', order: 0 }),
        expect.objectContaining({ id: 'project-a', order: 1 }),
      ],
      { replaceWorkspaceOrder: true },
    );
  });
});

describe('projectsStore sidebar pinning and ordering', () => {
  beforeEach(() => {
    mockSetWorktreePinned.mockClear();
    mockUpdateWorkspaceMetadata.mockClear();
    useProjectsStore.setState({
      projects: [makeProject([makeWorktree('worktree-a')])],
    });
  });

  it('optimistically pins a worktree and persists the exact IPC payload', async () => {
    await useProjectsStore
      .getState()
      .setWorktreePinned(PROJECT_ID, 'worktree-a', true);

    const project = useProjectsStore.getState().projects[0];
    expect(
      project?.type === 'cowork' ? undefined : project?.worktrees[0]?.pinned,
    ).toBe(true);
    expect(mockSetWorktreePinned).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: 'worktree-a',
      pinned: true,
    });
  });

  it('persists workspace pin and child sort mode through metadata IPC', async () => {
    await useProjectsStore.getState().setWorkspacePinned(PROJECT_ID, true);
    await useProjectsStore
      .getState()
      .setWorkspaceItemSortMode(PROJECT_ID, 'last-updated');

    expect(useProjectsStore.getState().projects[0]).toMatchObject({
      pinned: true,
      itemSortMode: 'last-updated',
    });
    expect(mockUpdateWorkspaceMetadata).toHaveBeenNthCalledWith(1, {
      workspaceId: PROJECT_ID,
      pinned: true,
    });
    expect(mockUpdateWorkspaceMetadata).toHaveBeenNthCalledWith(2, {
      workspaceId: PROJECT_ID,
      itemSortMode: 'last-updated',
    });
  });

  it('treats a workspace with no persisted sort mode as manual order', async () => {
    await useProjectsStore
      .getState()
      .setWorkspaceItemSortMode(PROJECT_ID, 'manual');

    expect(
      useProjectsStore.getState().projects[0]?.itemSortMode,
    ).toBeUndefined();
    expect(mockUpdateWorkspaceMetadata).not.toHaveBeenCalled();
  });

  it('rolls back a rejected worktree pin without discarding concurrent activity', async () => {
    let rejectPin!: (reason?: unknown) => void;
    mockSetWorktreePinned.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPin = reject;
        }),
    );

    const pinPromise = useProjectsStore
      .getState()
      .setWorktreePinned(PROJECT_ID, 'worktree-a', true);
    useProjectsStore.setState((state) => ({
      projects: state.projects.map((project) =>
        project.id !== PROJECT_ID || project.type === 'cowork'
          ? project
          : {
              ...project,
              worktrees: project.worktrees.map((worktree) =>
                worktree.id === 'worktree-a'
                  ? {
                      ...worktree,
                      lastTouchedAt: '2026-09-16T12:00:00.000Z',
                    }
                  : worktree,
              ),
            },
      ),
    }));
    rejectPin(new Error('write failed'));
    await pinPromise;

    const project = useProjectsStore.getState().projects[0];
    const worktree =
      project?.type === 'cowork' ? undefined : project?.worktrees[0];
    expect(worktree).toMatchObject({
      id: 'worktree-a',
      lastTouchedAt: '2026-09-16T12:00:00.000Z',
    });
    expect(worktree?.pinned).toBeUndefined();
  });

  it('rolls back a rejected workspace pin without discarding concurrent metadata', async () => {
    let rejectPin!: (reason?: unknown) => void;
    mockUpdateWorkspaceMetadata.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPin = reject;
        }),
    );

    const pinPromise = useProjectsStore
      .getState()
      .setWorkspacePinned(PROJECT_ID, true);
    useProjectsStore.setState((state) => ({
      projects: state.projects.map((project) =>
        project.id === PROJECT_ID
          ? { ...project, name: 'Concurrent rename' }
          : project,
      ),
    }));
    rejectPin(new Error('write failed'));
    await pinPromise;

    expect(useProjectsStore.getState().projects[0]).toMatchObject({
      name: 'Concurrent rename',
    });
    expect(useProjectsStore.getState().projects[0]?.pinned).toBeUndefined();
  });

  it('rolls back a rejected sort mode without discarding concurrent metadata', async () => {
    let rejectSort!: (reason?: unknown) => void;
    mockUpdateWorkspaceMetadata.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSort = reject;
        }),
    );

    const sortPromise = useProjectsStore
      .getState()
      .setWorkspaceItemSortMode(PROJECT_ID, 'last-updated');
    useProjectsStore.setState((state) => ({
      projects: state.projects.map((project) =>
        project.id === PROJECT_ID
          ? { ...project, name: 'Concurrent rename' }
          : project,
      ),
    }));
    rejectSort(new Error('write failed'));
    await sortPromise;

    expect(useProjectsStore.getState().projects[0]).toMatchObject({
      name: 'Concurrent rename',
    });
    expect(
      useProjectsStore.getState().projects[0]?.itemSortMode,
    ).toBeUndefined();
  });

  it('does not overwrite a newer sort choice when an older write rejects', async () => {
    let rejectSort!: (reason?: unknown) => void;
    mockUpdateWorkspaceMetadata.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSort = reject;
        }),
    );

    const olderSortPromise = useProjectsStore
      .getState()
      .setWorkspaceItemSortMode(PROJECT_ID, 'last-updated');
    useProjectsStore.setState((state) => ({
      projects: state.projects.map((project) =>
        project.id === PROJECT_ID
          ? { ...project, itemSortMode: 'manual' }
          : project,
      ),
    }));
    rejectSort(new Error('older write failed'));
    await olderSortPromise;

    expect(useProjectsStore.getState().projects[0]?.itemSortMode).toBe(
      'manual',
    );
  });
});

describe('projectsStore.setWorktreeBranchGroupingOverride', () => {
  let reload: jest.SpyInstance;
  afterEach(() => reload.mockRestore());
  beforeEach(() => {
    mockSetWorktreeBranchGrouping.mockClear();
    reload = jest
      .spyOn(useProjectsStore.getState(), 'loadProjects')
      .mockResolvedValue(undefined);
    useBranchGroupingPreferenceStore.setState({ enabled: true });
    useProjectsStore.setState({
      projects: [
        makeProject([
          { ...makeWorktree('parent'), branchName: 'feature/parent' },
          { ...makeWorktree('unrelated'), branchName: 'feature/unrelated' },
          {
            ...makeWorktree('child-1'),
            branchName: 'feature/child-1',
            trackedBaseBranch: 'feature/parent',
          },
          {
            ...makeWorktree('child-2'),
            branchName: 'feature/child-2',
            trackedBaseBranch: 'feature/parent',
          },
        ]),
      ],
      baseBranches: {
        [`${PROJECT_ID}/parent`]: 'main',
        [`${PROJECT_ID}/unrelated`]: 'main',
        [`${PROJECT_ID}/child-1`]: 'feature/parent',
        [`${PROJECT_ID}/child-2`]: 'feature/parent',
      },
      defaultBranches: {
        [`${PROJECT_ID}/parent`]: 'main',
        [`${PROJECT_ID}/unrelated`]: 'main',
        [`${PROJECT_ID}/child-1`]: 'main',
        [`${PROJECT_ID}/child-2`]: 'main',
      },
    });
  });

  it('reconciles an acknowledged grouping write after a stale load replaces its optimistic state', async () => {
    const staleProjects = useProjectsStore.getState().projects;
    let acknowledgedProjects = staleProjects;
    mockSetWorktreeBranchGrouping.mockImplementationOnce(() => {
      acknowledgedProjects = useProjectsStore.getState().projects;
      useProjectsStore.setState({ projects: staleProjects });
      return Promise.resolve();
    });
    reload.mockImplementation(() => {
      useProjectsStore.setState({ projects: acknowledgedProjects });
      return Promise.resolve();
    });
    try {
      await useProjectsStore
        .getState()
        .setWorktreeBranchGroupingOverride(PROJECT_ID, 'child-1', 'ungroup');
      const project = useProjectsStore.getState().projects[0];
      expect(
        project?.type === 'cowork'
          ? undefined
          : project?.worktrees.find((worktree) => worktree.id === 'child-1')
              ?.branchGroupingOverride,
      ).toBe('ungroup');
    } finally {
      reload.mockRestore();
    }
  });

  it('materializes the nested order before manually ungrouping a child', async () => {
    await useProjectsStore
      .getState()
      .setWorktreeBranchGroupingOverride(PROJECT_ID, 'child-1', 'ungroup');

    const project = useProjectsStore.getState().projects[0];
    const worktrees =
      project?.type === 'cowork' ? [] : (project?.worktrees ?? []);
    expect(worktrees.map((worktree) => worktree.id)).toEqual([
      'parent',
      'child-1',
      'child-2',
      'unrelated',
    ]);
    expect(worktrees[1].branchGroupingOverride).toBe('ungroup');
    expect(mockSetWorktreeBranchGrouping).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: 'child-1',
      override: 'ungroup',
      worktreeOrder: ['parent', 'child-1', 'child-2', 'unrelated'],
    });
  });

  it('materializes nested order for an all-hidden project', async () => {
    useProjectsStore.setState({
      projects: [
        {
          ...makeProject([
            {
              ...makeWorktree('parent', true),
              branchName: 'feature/parent',
            },
            {
              ...makeWorktree('unrelated', true),
              branchName: 'feature/unrelated',
            },
            {
              ...makeWorktree('child-1', true),
              branchName: 'feature/child-1',
              trackedBaseBranch: 'feature/parent',
            },
            {
              ...makeWorktree('child-2', true),
              branchName: 'feature/child-2',
              trackedBaseBranch: 'feature/parent',
            },
          ]),
          alwaysShow: false,
        },
      ],
      baseBranches: {
        [`${PROJECT_ID}/parent`]: 'main',
        [`${PROJECT_ID}/unrelated`]: 'main',
        [`${PROJECT_ID}/child-1`]: 'feature/parent',
        [`${PROJECT_ID}/child-2`]: 'feature/parent',
      },
      defaultBranches: {
        [`${PROJECT_ID}/parent`]: 'main',
        [`${PROJECT_ID}/unrelated`]: 'main',
        [`${PROJECT_ID}/child-1`]: 'main',
        [`${PROJECT_ID}/child-2`]: 'main',
      },
    });

    await useProjectsStore
      .getState()
      .setWorktreeBranchGroupingOverride(PROJECT_ID, 'child-1', 'ungroup');

    const project = useProjectsStore.getState().projects[0];
    const worktrees =
      project?.type === 'cowork' ? [] : (project?.worktrees ?? []);
    expect(worktrees.map((worktree) => worktree.id)).toEqual([
      'parent',
      'child-1',
      'child-2',
      'unrelated',
    ]);
    expect(mockSetWorktreeBranchGrouping).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: 'child-1',
      override: 'ungroup',
      worktreeOrder: ['parent', 'child-1', 'child-2', 'unrelated'],
    });
  });

  it('preserves sibling order while ungrouping all descendants in reverse mutation order', async () => {
    useProjectsStore.setState({
      projects: [
        makeProject([
          { ...makeWorktree('parent'), branchName: 'feature/parent' },
          { ...makeWorktree('unrelated'), branchName: 'feature/unrelated' },
          {
            ...makeWorktree('child-1'),
            branchName: 'feature/child-1',
            trackedBaseBranch: 'feature/parent',
          },
          {
            ...makeWorktree('child-2'),
            branchName: 'feature/child-2',
            trackedBaseBranch: 'feature/parent',
          },
          {
            ...makeWorktree('grandchild'),
            branchName: 'feature/grandchild',
            trackedBaseBranch: 'feature/child-1',
          },
        ]),
      ],
      baseBranches: {
        [`${PROJECT_ID}/parent`]: 'main',
        [`${PROJECT_ID}/unrelated`]: 'main',
        [`${PROJECT_ID}/child-1`]: 'feature/parent',
        [`${PROJECT_ID}/child-2`]: 'feature/parent',
        [`${PROJECT_ID}/grandchild`]: 'feature/child-1',
      },
      defaultBranches: {
        [`${PROJECT_ID}/parent`]: 'main',
        [`${PROJECT_ID}/unrelated`]: 'main',
        [`${PROJECT_ID}/child-1`]: 'main',
        [`${PROJECT_ID}/child-2`]: 'main',
        [`${PROJECT_ID}/grandchild`]: 'main',
      },
    });

    // ProjectSection applies the breadth-first descendant list in reverse when
    // "Ungroup children" is selected.
    for (const worktreeId of ['grandchild', 'child-2', 'child-1']) {
      await useProjectsStore
        .getState()
        .setWorktreeBranchGroupingOverride(PROJECT_ID, worktreeId, 'ungroup');
    }

    const project = useProjectsStore.getState().projects[0];
    const worktrees =
      project?.type === 'cowork' ? [] : (project?.worktrees ?? []);
    expect(worktrees.map((worktree) => worktree.id)).toEqual([
      'parent',
      'child-1',
      'child-2',
      'grandchild',
      'unrelated',
    ]);
    expect(
      worktrees.slice(1, 4).map((worktree) => worktree.branchGroupingOverride),
    ).toEqual(['ungroup', 'ungroup', 'ungroup']);
  });
});
