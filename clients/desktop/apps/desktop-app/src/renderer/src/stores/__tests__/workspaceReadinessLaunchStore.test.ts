/** @jest-environment jsdom */
import type {
  SidebarItem,
  WorkspaceReadinessIssue,
} from '@canopy/desktop-shared/types';
import { reconcileWorkspaceReadinessLaunches } from '@/hooks/useWorkspaceReadinessLaunchReconciliation';
import {
  WORKSPACE_READINESS_LAUNCHES_STORAGE_KEY,
  launchedReadinessFixKey,
  type LaunchedReadinessFix,
} from '@/lib/workspaceReadinessLaunches';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  pruneResolvedWorkspaceReadinessLaunches,
  selectWorkspaceReadinessLaunch,
  snapshotWorkspaceReadinessLaunches,
  useWorkspaceReadinessLaunchStore,
} from '../workspaceReadinessLaunchStore';

const record: LaunchedReadinessFix = {
  workspaceId: 'workspace-1',
  issueKey: 'API:configure-agent-instructions',
  issueCode: 'configure-agent-instructions',
  worktreeId: 'fix-worktree',
  chatId: 'fix-chat',
  launchedAt: '2026-10-31T12:00:00.000Z',
};

const issue: WorkspaceReadinessIssue = {
  code: 'configure-agent-instructions',
  title: 'Initialize agent instructions',
  message: 'No AGENTS.md.',
  repoName: 'API',
  fixPrompt: 'Write instructions.',
};

function workspace(worktreeIds: string[]): SidebarItem {
  return {
    id: 'workspace-1',
    name: 'Workspace',
    type: 'single-repo',
    repoPath: '/repos/api',
    color: '#fff',
    collapsed: false,
    order: 0,
    worktrees: worktreeIds.map((id) => ({
      id,
      branchName: id,
      createdAt: new Date(0).toISOString(),
    })),
  };
}

interface FreshStoreModule {
  useWorkspaceReadinessLaunchStore: typeof useWorkspaceReadinessLaunchStore;
}

const originalProjectsState = useProjectsStore.getState();

beforeEach(() => {
  window.localStorage.clear();
  useWorkspaceReadinessLaunchStore.setState({
    records: {},
    pendingSendKeys: {},
    failedSendKeys: {},
  });
  useProjectsStore.setState({
    projects: [workspace(['fix-worktree'])],
    hasHydratedProjects: true,
    projectInventoryStatus: 'ready',
    projectInventorySnapshot: {
      projects: [workspace(['fix-worktree'])],
      startedAt: Date.now(),
    },
    isLoading: false,
    failedWorkspaceIds: new Set(),
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  useProjectsStore.setState(originalProjectsState, true);
});

describe('useWorkspaceReadinessLaunchStore', () => {
  it('writes through to storage and hydrates a fresh store', () => {
    useWorkspaceReadinessLaunchStore.getState().recordLaunch(record);

    jest.isolateModules(() => {
      // A fresh module reads storage the way a relaunched renderer does.
      const fresh = jest.requireActual<FreshStoreModule>(
        '../workspaceReadinessLaunchStore',
      );
      expect(
        selectWorkspaceReadinessLaunch(
          fresh.useWorkspaceReadinessLaunchStore.getState(),
          'workspace-1',
          undefined,
          record.issueKey,
        ),
      ).toEqual(record);
    });
  });

  it('ignores malformed storage on hydration', () => {
    window.localStorage.setItem(WORKSPACE_READINESS_LAUNCHES_STORAGE_KEY, '{');
    useWorkspaceReadinessLaunchStore.getState().hydrate();
    expect(useWorkspaceReadinessLaunchStore.getState().records).toEqual({});
  });

  it('keeps the session working when storage throws', () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation((): void => {
      throw new Error('quota');
    });
    useWorkspaceReadinessLaunchStore.getState().recordLaunch(record);
    expect(
      useWorkspaceReadinessLaunchStore.getState().records[
        launchedReadinessFixKey(record)
      ],
    ).toEqual(record);

    jest.spyOn(Storage.prototype, 'getItem').mockImplementation((): string => {
      throw new Error('denied');
    });
    useWorkspaceReadinessLaunchStore.getState().hydrate();
    expect(
      Object.values(useWorkspaceReadinessLaunchStore.getState().records),
    ).toEqual([record]);
  });

  it('removes only the same launch, idempotently', () => {
    const store = useWorkspaceReadinessLaunchStore.getState();
    store.recordLaunch(record);
    const newer = {
      ...record,
      chatId: 'newer-chat',
      launchedAt: '2026-11-01T00:00:00.000Z',
    };
    store.recordLaunch(newer);

    store.removeLaunches([record]);
    expect(
      useWorkspaceReadinessLaunchStore.getState().records[
        launchedReadinessFixKey(record)
      ],
    ).toEqual(newer);

    store.removeLaunches([newer]);
    store.removeLaunches([newer]);
    expect(useWorkspaceReadinessLaunchStore.getState().records).toEqual({});
    expect(
      window.localStorage.getItem(WORKSPACE_READINESS_LAUNCHES_STORAGE_KEY),
    ).toBe(JSON.stringify({ version: 1, records: [] }));
  });
});

describe('audit pruning', () => {
  it.each([false, undefined])(
    'keeps links without complete audit evidence (%s)',
    (complete) => {
      useWorkspaceReadinessLaunchStore.getState().recordLaunch(record);
      const snapshot = snapshotWorkspaceReadinessLaunches(
        'workspace-1',
        undefined,
      );
      pruneResolvedWorkspaceReadinessLaunches(snapshot, [], complete);
      expect(
        Object.values(useWorkspaceReadinessLaunchStore.getState().records),
      ).toEqual([record]);
    },
  );

  it('clears a launch the audit of its target no longer reports', () => {
    useWorkspaceReadinessLaunchStore.getState().recordLaunch(record);
    const snapshot = snapshotWorkspaceReadinessLaunches(
      'workspace-1',
      undefined,
    );

    pruneResolvedWorkspaceReadinessLaunches(snapshot, [issue], true);
    expect(
      Object.keys(useWorkspaceReadinessLaunchStore.getState().records),
    ).toHaveLength(1);

    pruneResolvedWorkspaceReadinessLaunches(snapshot, [], true);
    expect(useWorkspaceReadinessLaunchStore.getState().records).toEqual({});
  });

  it('does not clear a launch written while the audit ran', () => {
    const snapshot = snapshotWorkspaceReadinessLaunches(
      'workspace-1',
      undefined,
    );
    useWorkspaceReadinessLaunchStore.getState().recordLaunch(record);

    pruneResolvedWorkspaceReadinessLaunches(snapshot, [], true);
    expect(
      Object.keys(useWorkspaceReadinessLaunchStore.getState().records),
    ).toHaveLength(1);
  });

  it('does not clear a replacement launch for the same issue', () => {
    useWorkspaceReadinessLaunchStore.getState().recordLaunch(record);
    const snapshot = snapshotWorkspaceReadinessLaunches(
      'workspace-1',
      undefined,
    );
    const replacement = {
      ...record,
      worktreeId: 'replacement',
      chatId: 'replacement-chat',
    };
    useWorkspaceReadinessLaunchStore.getState().recordLaunch(replacement);

    pruneResolvedWorkspaceReadinessLaunches(snapshot, [], true);
    expect(
      Object.values(useWorkspaceReadinessLaunchStore.getState().records),
    ).toEqual([replacement]);
  });

  it('scopes audit pruning to the audited target', () => {
    const targeted = { ...record, baseWorktreeId: 'base-worktree' };
    useWorkspaceReadinessLaunchStore.getState().recordLaunch(record);
    useWorkspaceReadinessLaunchStore.getState().recordLaunch(targeted);

    pruneResolvedWorkspaceReadinessLaunches(
      snapshotWorkspaceReadinessLaunches('workspace-1', 'base-worktree'),
      [],
      true,
    );
    expect(
      Object.values(useWorkspaceReadinessLaunchStore.getState().records),
    ).toEqual([record]);
  });
});

describe('reconcileWorkspaceReadinessLaunches', () => {
  it('does not infer removal from an optimistic sidebar change', async () => {
    const loadProjects = jest
      .fn()
      .mockResolvedValue({ items: [workspace(['fix-worktree'])] });
    const refreshWorkspaceDrift =
      useProjectsStore.getState().refreshWorkspaceDrift;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { loadProjects },
    });
    useProjectsStore.setState({
      refreshWorkspaceDrift: jest.fn().mockResolvedValue(undefined),
    });
    try {
      await useProjectsStore.getState().loadProjects();
      useWorkspaceReadinessLaunchStore.getState().recordLaunch(record);
      useProjectsStore.setState({ projects: [workspace([])] });
      reconcileWorkspaceReadinessLaunches();
      expect(
        Object.values(useWorkspaceReadinessLaunchStore.getState().records),
      ).toEqual([record]);
      loadProjects.mockResolvedValue({ items: [workspace([])] });
      await useProjectsStore.getState().loadProjects();
      reconcileWorkspaceReadinessLaunches();
      expect(useWorkspaceReadinessLaunchStore.getState().records).toEqual({});
    } finally {
      useProjectsStore.setState({ refreshWorkspaceDrift });
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('waits for a silent refresh to succeed before accepting absence', async () => {
    useWorkspaceReadinessLaunchStore.getState().recordLaunch(record);
    let finishRead: ((file: { items: SidebarItem[] }) => void) | undefined;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadProjects: (): Promise<{ items: SidebarItem[] }> =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
      },
    });
    try {
      const refresh = useProjectsStore
        .getState()
        .loadProjects({ silent: true });
      // The last successful inventory predates this persisted destination.
      // Silent reads deliberately don't set the spinner's isLoading flag.
      useProjectsStore.setState({ projects: [] });
      reconcileWorkspaceReadinessLaunches();
      expect(
        Object.values(useWorkspaceReadinessLaunchStore.getState().records),
      ).toEqual([record]);
      finishRead?.({ items: [] });
      await refresh;
      reconcileWorkspaceReadinessLaunches();
      expect(useWorkspaceReadinessLaunchStore.getState().records).toEqual({});
    } finally {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('keeps persisted links when the initial project inventory read fails', async () => {
    useWorkspaceReadinessLaunchStore.getState().recordLaunch(record);
    useProjectsStore.setState({
      projects: [],
      hasHydratedProjects: false,
      failedWorkspaceIds: new Set(),
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadProjects: jest.fn().mockRejectedValue(new Error('offline')),
      },
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await useProjectsStore.getState().loadProjects();
      reconcileWorkspaceReadinessLaunches();
      expect(
        Object.values(useWorkspaceReadinessLaunchStore.getState().records),
      ).toEqual([record]);
    } finally {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('keeps launches while the worktree list is incomplete', () => {
    useWorkspaceReadinessLaunchStore.getState().recordLaunch(record);
    useProjectsStore.setState({ projects: [workspace([])], isLoading: true });
    reconcileWorkspaceReadinessLaunches();
    useProjectsStore.setState({ hasHydratedProjects: false, isLoading: false });
    reconcileWorkspaceReadinessLaunches();
    useProjectsStore.setState({
      hasHydratedProjects: true,
      projectInventoryStatus: 'ready',
      projectInventorySnapshot: {
        projects: [workspace(['fix-worktree'])],
        startedAt: Date.now(),
      },
      failedWorkspaceIds: new Set(['workspace-1']),
    });
    reconcileWorkspaceReadinessLaunches();
    expect(
      Object.keys(useWorkspaceReadinessLaunchStore.getState().records),
    ).toHaveLength(1);
  });

  it('keeps a launch whose first send is still settling', () => {
    const store = useWorkspaceReadinessLaunchStore.getState();
    store.setSendPending(launchedReadinessFixKey(record), true);
    store.recordLaunch(record);
    useProjectsStore.setState({ projects: [workspace([])] });
    reconcileWorkspaceReadinessLaunches();
    expect(
      Object.keys(useWorkspaceReadinessLaunchStore.getState().records),
    ).toHaveLength(1);
  });

  it('clears a launch whose fix worktree left a complete list', () => {
    useWorkspaceReadinessLaunchStore.getState().recordLaunch(record);
    useProjectsStore.setState({
      projects: [workspace(['other'])],
      projectInventorySnapshot: {
        projects: [workspace(['other'])],
        startedAt: Date.now(),
      },
    });
    reconcileWorkspaceReadinessLaunches();
    expect(useWorkspaceReadinessLaunchStore.getState().records).toEqual({});
  });
});
