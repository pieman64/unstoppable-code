import type {
  CanopyApi,
  MultiRepoSidebarItem,
  RepoBranchInfo,
  SidebarItem,
  SingleRepoSidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';
import { useActivityStore } from '@/stores/activityStore';

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const REPO_ID = 'repo-1';

function makeWorktree(overrides?: Partial<WorktreeData>): WorktreeData {
  return {
    id: WORKTREE_ID,
    branchName: 'feature-x',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSingleRepoProject(
  worktreeOverrides?: Partial<WorktreeData>,
): SingleRepoSidebarItem {
  return {
    id: PROJECT_ID,
    type: 'single-repo',
    name: 'test-project',
    repoPath: '/tmp/repo',
    color: '#000000',
    order: 0,
    collapsed: false,
    worktrees: [makeWorktree(worktreeOverrides)],
    scripts: {},
    effectiveScripts: {},
    hooks: {},
    effectiveHooks: {},
  };
}

function makeMultiRepoProject(
  worktreeOverrides?: Partial<WorktreeData>,
): MultiRepoSidebarItem {
  return {
    id: PROJECT_ID,
    type: 'multi-repo',
    name: 'test-project',
    color: '#000000',
    order: 0,
    collapsed: false,
    repos: [{ id: REPO_ID, name: 'Repo 1', repoPath: '/tmp/repo-1' }],
    worktrees: [makeWorktree(worktreeOverrides)],
    scripts: {},
    effectiveScripts: {},
    hooks: {},
    effectiveHooks: {},
  };
}

/**
 * Test-only helper: cowork sidebar items have no `worktrees`, so tests that
 * read a worktree back off the store's `SidebarItem[]` need to narrow past
 * that variant first.
 */
function getProjectWorktrees(project: SidebarItem | undefined): WorktreeData[] {
  if (!project || project.type === 'cowork') {
    return [];
  }
  return project.worktrees;
}

declare global {
  interface Window {
    api: CanopyApi;
  }
}

// Mock window.api.saveProjects used by saveProjects()
const mockSaveProjects = jest.fn().mockResolvedValue(undefined);
const mockSetWorktreeLabel = jest.fn().mockResolvedValue(undefined);
const mockSetTrackedBaseBranch = jest.fn().mockResolvedValue(undefined);

const mockGetDiffStatsBatch = jest.fn().mockResolvedValue([]);
const mockGetChangedFiles = jest.fn().mockResolvedValue({
  uncommitted: [],
  committed: [],
});

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        saveProjects: mockSaveProjects,
        setWorktreeLabel: mockSetWorktreeLabel,
        setTrackedBaseBranch: mockSetTrackedBaseBranch,
        getDiffStatsBatch: mockGetDiffStatsBatch,
        activity: {
          getChangedFiles: mockGetChangedFiles,
        },
      },
    },
  });
});

describe('projectsStore.applyDependentBaseBranchUpdates', () => {
  beforeEach(() => {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject({ trackedBaseBranch: 'feature-parent' }),
      ],
      baseBranches: {},
      repoBranches: {},
      baseBranchExistsLocally: {},
      baseBranchExistsInRemote: {},
    });
  });

  it('updates single-repo project state and loaded base branch maps', () => {
    const key = `${PROJECT_ID}/${WORKTREE_ID}`;
    useProjectsStore.setState({
      baseBranches: { [key]: 'feature-parent' },
      baseBranchExistsLocally: { [key]: false },
      baseBranchExistsInRemote: { [key]: false },
    });

    useProjectsStore.getState().applyDependentBaseBranchUpdates([
      {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        previousBaseBranch: 'feature-parent',
        nextBaseBranch: 'main',
        branchGroupingParentWorktreeId: 'parent-worktree',
      },
    ]);

    const state = useProjectsStore.getState();
    expect(getProjectWorktrees(state.projects[0])[0]?.trackedBaseBranch).toBe(
      'main',
    );
    expect(
      getProjectWorktrees(state.projects[0])[0]?.branchGroupingParentWorktreeId,
    ).toBe('parent-worktree');
    expect(state.baseBranches[key]).toBe('main');
    expect(state.baseBranchExistsLocally[key]).toBe(false);
    expect(state.baseBranchExistsInRemote[key]).toBe(true);
  });

  it('updates multi-repo project state and loaded repo branch maps', () => {
    const key = `${PROJECT_ID}/${WORKTREE_ID}`;
    const repoBranches: RepoBranchInfo[] = [
      {
        repoId: REPO_ID,
        repoName: 'Repo 1',
        branch: 'feature-x',
        baseBranch: 'feature-parent',
        insertions: 1,
        deletions: 0,
        baseBranchExistsLocally: false,
        baseBranchExistsInRemote: false,
      },
      {
        repoId: 'repo-2',
        repoName: 'Repo 2',
        branch: 'feature-y',
        baseBranch: 'feature-parent',
        insertions: 0,
        deletions: 0,
      },
    ];
    useProjectsStore.setState({
      projects: [
        makeMultiRepoProject({
          trackedRepoBaseBranches: { [REPO_ID]: 'feature-parent' },
        }),
      ],
      repoBranches: { [key]: repoBranches },
    });

    useProjectsStore.getState().applyDependentBaseBranchUpdates([
      {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        repoId: REPO_ID,
        previousBaseBranch: 'feature-parent',
        nextBaseBranch: 'main',
      },
    ]);

    const state = useProjectsStore.getState();
    expect(
      getProjectWorktrees(state.projects[0])[0]?.trackedRepoBaseBranches?.[
        REPO_ID
      ],
    ).toBe('main');
    expect(state.repoBranches[key][0]).toMatchObject({
      repoId: REPO_ID,
      baseBranch: 'main',
      baseBranchExistsLocally: false,
      baseBranchExistsInRemote: true,
    });
    expect(state.repoBranches[key][1]).toBe(repoBranches[1]);
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('projectsStore.setTrackedBaseBranch', () => {
  beforeEach(() => {
    mockSaveProjects.mockClear();
    mockSetWorktreeLabel.mockClear();
    mockSetTrackedBaseBranch.mockClear();
    mockGetDiffStatsBatch.mockReset().mockResolvedValue([]);
    mockGetChangedFiles.mockReset().mockResolvedValue({
      uncommitted: [],
      committed: [],
    });
    useActivityStore.setState({ changedFiles: {} });
    useProjectsStore.setState({
      projects: [makeSingleRepoProject()],
    });
  });

  it('prioritizes targeted stats and an already-loaded changed-files list', async () => {
    const key = `${PROJECT_ID}/${WORKTREE_ID}`;
    const freshChangedFiles = {
      uncommitted: [],
      committed: [
        {
          path: 'fresh.ts',
          status: 'modified' as const,
          insertions: 3,
          deletions: 1,
        },
      ],
    };
    useActivityStore.setState({
      changedFiles: {
        [key]: {
          uncommitted: [],
          committed: [],
        },
      },
    });
    mockGetChangedFiles.mockResolvedValue(freshChangedFiles);

    await useProjectsStore
      .getState()
      .setTrackedBaseBranch(PROJECT_ID, WORKTREE_ID, 'develop');

    expect(mockGetDiffStatsBatch).toHaveBeenCalledWith({
      worktrees: [{ projectId: PROJECT_ID, worktreeId: WORKTREE_ID }],
      skipFetch: undefined,
      source: 'renderer-targeted',
    });
    expect(mockGetChangedFiles).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(useActivityStore.getState().changedFiles[key]).toEqual(
      freshChangedFiles,
    );
  });

  it('sets trackedBaseBranch for single-repo worktree', async () => {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject({
          branchGroupingParentWorktreeId: 'merged-parent',
        }),
      ],
    });
    await useProjectsStore
      .getState()
      .setTrackedBaseBranch(PROJECT_ID, WORKTREE_ID, 'develop');

    const wt = getProjectWorktrees(useProjectsStore.getState().projects[0])[0];
    expect(wt.trackedBaseBranch).toBe('develop');
    expect(wt.branchGroupingParentWorktreeId).toBeUndefined();
    // Explicit intent goes through the targeted channel, never the wholesale
    // snapshot the main process now protects `trackedBaseBranch` against.
    expect(mockSetTrackedBaseBranch).toHaveBeenCalledWith({
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      repoId: undefined,
      baseBranch: 'develop',
    });
    expect(mockSaveProjects).not.toHaveBeenCalled();
  });

  it('restores optimistic state when the targeted write fails', async () => {
    const key = `${PROJECT_ID}/${WORKTREE_ID}`;
    mockSetTrackedBaseBranch.mockRejectedValueOnce(
      new Error('temporary write failure'),
    );
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject({
          branchGroupingParentWorktreeId: 'merged-parent',
        }),
      ],
      baseBranches: { [key]: 'main' },
      baseBranchExistsLocally: { [key]: true },
      baseBranchExistsInRemote: { [key]: true },
    });

    await expect(
      useProjectsStore
        .getState()
        .setTrackedBaseBranch(
          PROJECT_ID,
          WORKTREE_ID,
          'release/next',
          undefined,
          { existsLocally: false, existsInRemote: false },
        ),
    ).rejects.toThrow('temporary write failure');

    const state = useProjectsStore.getState();
    const worktree = getProjectWorktrees(state.projects[0])[0];
    expect(worktree.trackedBaseBranch).toBeUndefined();
    expect(worktree.branchGroupingParentWorktreeId).toBe('merged-parent');
    expect(state.baseBranches[key]).toBe('main');
    expect(state.baseBranchExistsLocally[key]).toBe(true);
    expect(state.baseBranchExistsInRemote[key]).toBe(true);
    expect(mockGetDiffStatsBatch).not.toHaveBeenCalled();
    expect(mockGetChangedFiles).not.toHaveBeenCalled();
  });

  it('does not let an older failed write roll back a newer successful retarget', async () => {
    let rejectFirstWrite: ((error: Error) => void) | undefined;
    mockGetDiffStatsBatch.mockResolvedValue([
      {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        insertions: 0,
        deletions: 0,
        branchName: 'feature-x',
        baseBranch: 'release/new',
      },
    ]);
    mockSetTrackedBaseBranch
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirstWrite = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject({
          branchGroupingParentWorktreeId: 'merged-parent',
        }),
      ],
      baseBranches: { [`${PROJECT_ID}/${WORKTREE_ID}`]: 'main' },
    });

    const olderWrite = useProjectsStore
      .getState()
      .setTrackedBaseBranch(PROJECT_ID, WORKTREE_ID, 'release/old');
    const newerWrite = useProjectsStore
      .getState()
      .setTrackedBaseBranch(PROJECT_ID, WORKTREE_ID, 'release/new');

    await newerWrite;
    rejectFirstWrite?.(new Error('older write failed'));
    await expect(olderWrite).rejects.toThrow('older write failed');

    const state = useProjectsStore.getState();
    const worktree = getProjectWorktrees(state.projects[0])[0];
    expect(worktree.trackedBaseBranch).toBe('release/new');
    expect(worktree.branchGroupingParentWorktreeId).toBeUndefined();
    expect(state.baseBranches[`${PROJECT_ID}/${WORKTREE_ID}`]).toBe(
      'release/new',
    );
  });

  it('clears trackedBaseBranch for single-repo worktree when null', async () => {
    // Set it first
    useProjectsStore.setState({
      projects: [makeSingleRepoProject({ trackedBaseBranch: 'develop' })],
    });

    await useProjectsStore
      .getState()
      .setTrackedBaseBranch(PROJECT_ID, WORKTREE_ID, null);

    const wt = getProjectWorktrees(useProjectsStore.getState().projects[0])[0];
    expect(wt.trackedBaseBranch).toBeNull();
    // A clear must use the same targeted channel as a set: the main process
    // now preserves `trackedBaseBranch` across a wholesale renderer save, so
    // `saveProjects()` can no longer carry the removal to disk.
    expect(mockSetTrackedBaseBranch).toHaveBeenCalledWith({
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      repoId: undefined,
      baseBranch: null,
    });
    expect(mockSaveProjects).not.toHaveBeenCalled();
  });

  it('sets trackedRepoBaseBranches entry for multi-repo worktree', async () => {
    await useProjectsStore
      .getState()
      .setTrackedBaseBranch(PROJECT_ID, WORKTREE_ID, 'develop', REPO_ID);

    const wt = getProjectWorktrees(useProjectsStore.getState().projects[0])[0];
    expect(wt.trackedRepoBaseBranches).toEqual({ [REPO_ID]: 'develop' });
    expect(mockSetTrackedBaseBranch).toHaveBeenCalledWith({
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      repoId: REPO_ID,
      baseBranch: 'develop',
    });
    expect(mockSaveProjects).not.toHaveBeenCalled();
  });

  it('updates the loaded multi-repo base after targeted persistence succeeds', async () => {
    const key = `${PROJECT_ID}/${WORKTREE_ID}`;
    let releaseSave: (() => void) | undefined;
    mockGetDiffStatsBatch.mockResolvedValue([
      {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        insertions: 0,
        deletions: 0,
        branchName: 'feature-x',
        baseBranch: null,
        repoBranches: [
          {
            repoId: REPO_ID,
            repoName: 'Repo 1',
            branch: 'feature-x',
            baseBranch: 'release/next',
            baseBranchExistsLocally: true,
            baseBranchExistsInRemote: true,
          },
        ],
      },
    ]);
    mockSetTrackedBaseBranch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve;
        }),
    );
    useProjectsStore.setState({
      projects: [makeMultiRepoProject()],
      repoBranches: {
        [key]: [
          {
            repoId: REPO_ID,
            repoName: 'Repo 1',
            branch: 'feature-x',
            baseBranch: 'main',
            baseBranchExistsLocally: true,
            baseBranchExistsInRemote: true,
          },
        ],
      },
    });

    const update = useProjectsStore
      .getState()
      .setTrackedBaseBranch(PROJECT_ID, WORKTREE_ID, 'release/next', REPO_ID);

    expect(useProjectsStore.getState().repoBranches[key][0]).toMatchObject({
      baseBranch: 'main',
      baseBranchExistsLocally: true,
      baseBranchExistsInRemote: true,
    });
    releaseSave?.();
    await update;
    expect(useProjectsStore.getState().repoBranches[key][0]).toMatchObject({
      baseBranch: 'release/next',
      baseBranchExistsLocally: true,
      baseBranchExistsInRemote: true,
    });
  });

  it('deletes trackedRepoBaseBranches entry for multi-repo when null', async () => {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject({
          trackedRepoBaseBranches: {
            [REPO_ID]: 'develop',
            'repo-2': 'main',
          },
        }),
      ],
    });

    await useProjectsStore
      .getState()
      .setTrackedBaseBranch(PROJECT_ID, WORKTREE_ID, null, REPO_ID);

    const wt = getProjectWorktrees(useProjectsStore.getState().projects[0])[0];
    // Only repo-2 should remain
    expect(wt.trackedRepoBaseBranches).toEqual({ 'repo-2': 'main' });
    expect(mockSetTrackedBaseBranch).toHaveBeenCalledWith({
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      repoId: REPO_ID,
      baseBranch: null,
    });
    expect(mockSaveProjects).not.toHaveBeenCalled();
  });

  it('removes trackedRepoBaseBranches entirely when last entry is deleted', async () => {
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject({
          trackedRepoBaseBranches: { [REPO_ID]: 'develop' },
        }),
      ],
    });

    await useProjectsStore
      .getState()
      .setTrackedBaseBranch(PROJECT_ID, WORKTREE_ID, null, REPO_ID);

    const wt = getProjectWorktrees(useProjectsStore.getState().projects[0])[0];
    expect(wt.trackedRepoBaseBranches).toBeUndefined();
    expect(mockSetTrackedBaseBranch).toHaveBeenCalledWith({
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      repoId: REPO_ID,
      baseBranch: null,
    });
    expect(mockSaveProjects).not.toHaveBeenCalled();
  });

  it('does not modify other worktrees in the same project', async () => {
    const otherWorktree = makeWorktree({
      id: 'worktree-2',
      branchName: 'other-branch',
    });
    useProjectsStore.setState({
      projects: [
        {
          ...makeSingleRepoProject(),
          worktrees: [makeWorktree(), otherWorktree],
        },
      ],
    });

    await useProjectsStore
      .getState()
      .setTrackedBaseBranch(PROJECT_ID, WORKTREE_ID, 'develop');

    const worktrees = getProjectWorktrees(
      useProjectsStore.getState().projects[0],
    );
    expect(worktrees[0]?.trackedBaseBranch).toBe('develop');
    expect(worktrees[1]?.trackedBaseBranch).toBeUndefined();
  });

  it('persists through the targeted IPC instead of the wholesale save', async () => {
    // The main process preserves `trackedBaseBranch` across a wholesale
    // renderer save, so a wholesale save can no longer carry this change.
    await useProjectsStore
      .getState()
      .setTrackedBaseBranch(PROJECT_ID, WORKTREE_ID, 'main');

    expect(mockSetTrackedBaseBranch).toHaveBeenCalledTimes(1);
    expect(mockSetTrackedBaseBranch).toHaveBeenCalledWith({
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      repoId: undefined,
      baseBranch: 'main',
    });
    expect(mockSaveProjects).not.toHaveBeenCalled();
  });

  it('optimistically updates baseBranchExistsInRemote when presence is provided', async () => {
    // Mock getDiffStatsBatch to return matching data so the authoritative
    // refresh after the optimistic set retains the value.
    const key = `${PROJECT_ID}/${WORKTREE_ID}`;
    mockGetDiffStatsBatch.mockResolvedValue([
      {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        insertions: 0,
        deletions: 0,
        branchName: 'feature-x',
        baseBranch: 'main',
        baseBranchExistsLocally: false,
        baseBranchExistsInRemote: true,
      },
    ]);

    useProjectsStore.setState({
      projects: [makeSingleRepoProject()],
      baseBranchExistsLocally: {},
      baseBranchExistsInRemote: {},
    });

    await useProjectsStore
      .getState()
      .setTrackedBaseBranch(PROJECT_ID, WORKTREE_ID, 'main', undefined, {
        existsLocally: false,
        existsInRemote: true,
      });

    expect(useProjectsStore.getState().baseBranchExistsInRemote[key]).toBe(
      true,
    );
  });

  it('optimistically updates baseBranchExistsLocally when presence is provided', async () => {
    const key = `${PROJECT_ID}/${WORKTREE_ID}`;
    mockGetDiffStatsBatch.mockResolvedValue([
      {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        insertions: 0,
        deletions: 0,
        branchName: 'feature-x',
        baseBranch: 'main',
        baseBranchExistsLocally: true,
        baseBranchExistsInRemote: false,
      },
    ]);

    useProjectsStore.setState({
      projects: [makeSingleRepoProject()],
      baseBranchExistsLocally: {},
      baseBranchExistsInRemote: {},
    });

    await useProjectsStore
      .getState()
      .setTrackedBaseBranch(PROJECT_ID, WORKTREE_ID, 'main', undefined, {
        existsLocally: true,
        existsInRemote: false,
      });

    expect(useProjectsStore.getState().baseBranchExistsLocally[key]).toBe(true);
  });

  it('optimistically updates baseBranches for single-repo', async () => {
    const key = `${PROJECT_ID}/${WORKTREE_ID}`;
    mockGetDiffStatsBatch.mockResolvedValue([
      {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        insertions: 0,
        deletions: 0,
        branchName: 'feature-x',
        baseBranch: 'develop',
      },
    ]);

    useProjectsStore.setState({
      projects: [makeSingleRepoProject()],
      baseBranches: {},
    });

    await useProjectsStore
      .getState()
      .setTrackedBaseBranch(PROJECT_ID, WORKTREE_ID, 'develop');

    expect(useProjectsStore.getState().baseBranches[key]).toBe('develop');
  });

  it('does not modify baseBranchExistsInRemote when presence is omitted', async () => {
    const key = `${PROJECT_ID}/${WORKTREE_ID}`;
    mockGetDiffStatsBatch.mockResolvedValue([
      {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        insertions: 0,
        deletions: 0,
        branchName: 'feature-x',
        baseBranch: 'main',
        baseBranchExistsLocally: false,
        baseBranchExistsInRemote: false,
      },
    ]);

    useProjectsStore.setState({
      projects: [makeSingleRepoProject()],
      baseBranchExistsLocally: { [key]: false },
      baseBranchExistsInRemote: { [key]: false },
    });

    await useProjectsStore
      .getState()
      .setTrackedBaseBranch(PROJECT_ID, WORKTREE_ID, 'main');

    // Should remain false (reconciled from backend)
    expect(useProjectsStore.getState().baseBranchExistsInRemote[key]).toBe(
      false,
    );
  });
});

describe('projectsStore.setWorktreeLabel', () => {
  beforeEach(() => {
    mockSetWorktreeLabel.mockClear();
    useProjectsStore.setState({
      projects: [makeSingleRepoProject()],
    });
  });

  it('optimistically sets a trimmed label and persists it', async () => {
    await useProjectsStore
      .getState()
      .setWorktreeLabel(PROJECT_ID, WORKTREE_ID, '  My Label  ');

    expect(mockSetWorktreeLabel).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      label: 'My Label',
    });
    expect(
      getProjectWorktrees(useProjectsStore.getState().projects[0])[0]?.label,
    ).toBe('My Label');
  });

  it('clears the label with no label field when emptied', async () => {
    useProjectsStore.setState({
      projects: [makeSingleRepoProject({ label: 'Old' })],
    });

    await useProjectsStore
      .getState()
      .setWorktreeLabel(PROJECT_ID, WORKTREE_ID, '   ');

    expect(mockSetWorktreeLabel).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(
      getProjectWorktrees(useProjectsStore.getState().projects[0])[0]?.label,
    ).toBeUndefined();
  });

  it('no-ops when the label is unchanged', async () => {
    useProjectsStore.setState({
      projects: [makeSingleRepoProject({ label: 'Same' })],
    });

    await useProjectsStore
      .getState()
      .setWorktreeLabel(PROJECT_ID, WORKTREE_ID, 'Same');

    expect(mockSetWorktreeLabel).not.toHaveBeenCalled();
  });
});
