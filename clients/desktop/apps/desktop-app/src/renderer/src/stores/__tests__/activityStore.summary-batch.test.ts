import {
  WORKTREE_SUMMARY_BATCH_SIZE_LIMIT,
  type SidebarItem,
  type WorktreeSummaryData,
  type WorktreeSummaryLoadBatchRequest,
  type WorktreeSummaryLoadBatchResponse,
  type WorktreeSummaryLoadRequest,
} from '@canopy/desktop-shared/types';
import { useActivityStore } from '../activityStore';
import { useProjectsStore } from '../projectsStore';

const SUMMARY: WorktreeSummaryData = {
  title: 'Batch summary',
  description: 'Loaded through the batch bridge.',
  highlights: ['One atomic merge'],
  generatedAt: '2026-07-20T12:00:00.000Z',
  turnCountAtGeneration: 4,
  lastFullRefreshAt: '2026-07-20T12:00:00.000Z',
  lastFullRefreshTurnCount: 4,
};

let loadWorktreeSummariesMock: jest.Mock<
  Promise<WorktreeSummaryLoadBatchResponse>,
  [WorktreeSummaryLoadBatchRequest]
>;
let loadWorktreeSummaryMock: jest.Mock<
  Promise<WorktreeSummaryData | null>,
  [WorktreeSummaryLoadRequest]
>;

function setLiveWorktrees(ids: string[]): void {
  const projects: SidebarItem[] = [
    {
      type: 'single-repo',
      id: 'proj',
      name: 'Project',
      repoPath: '/tmp/project',
      color: 'blue',
      collapsed: false,
      order: 0,
      worktrees: ids.map((id) => ({
        id,
        name: id,
        path: `/tmp/${id}`,
      })),
    },
  ];
  useProjectsStore.setState({ projects });
}

beforeEach(() => {
  loadWorktreeSummariesMock = jest.fn<
    Promise<WorktreeSummaryLoadBatchResponse>,
    [WorktreeSummaryLoadBatchRequest]
  >();
  loadWorktreeSummaryMock = jest.fn<
    Promise<WorktreeSummaryData | null>,
    [WorktreeSummaryLoadRequest]
  >();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        activity: {
          loadWorktreeSummary: loadWorktreeSummaryMock,
          loadWorktreeSummaries: loadWorktreeSummariesMock,
        },
      },
    },
  });
  setLiveWorktrees(['wt-a', 'wt-b']);
  useActivityStore.setState({
    worktreeSummaries: {
      'proj/wt-b': {
        ...SUMMARY,
        title: 'Summary to remove',
      },
    },
  });
});

describe('activityStore.loadWorktreeSummaries', () => {
  it('merges present and missing summaries in one state update', async () => {
    loadWorktreeSummariesMock.mockResolvedValue({
      'proj/wt-a': SUMMARY,
      'proj/wt-b': null,
    });
    let updates = 0;
    const unsubscribe = useActivityStore.subscribe(() => {
      updates += 1;
    });

    await useActivityStore.getState().loadWorktreeSummaries([
      { projectId: 'proj', worktreeId: 'wt-a' },
      { projectId: 'proj', worktreeId: 'wt-b' },
    ]);
    unsubscribe();

    expect(loadWorktreeSummariesMock).toHaveBeenCalledWith({
      worktrees: [
        { projectId: 'proj', worktreeId: 'wt-a' },
        { projectId: 'proj', worktreeId: 'wt-b' },
      ],
    });
    expect(useActivityStore.getState().worktreeSummaries).toEqual({
      'proj/wt-a': SUMMARY,
    });
    expect(updates).toBe(1);
  });

  it('does not reintroduce a worktree removed while the batch is in flight', async () => {
    let resolveBatch:
      | ((value: Record<string, WorktreeSummaryData | null>) => void)
      | undefined;
    loadWorktreeSummariesMock.mockReturnValue(
      new Promise((resolve) => {
        resolveBatch = resolve;
      }),
    );

    const pending = useActivityStore
      .getState()
      .loadWorktreeSummaries([{ projectId: 'proj', worktreeId: 'wt-a' }]);
    setLiveWorktrees(['wt-b']);
    resolveBatch?.({ 'proj/wt-a': SUMMARY });
    await pending;

    expect(
      useActivityStore.getState().worktreeSummaries['proj/wt-a'],
    ).toBeUndefined();
  });

  it('preserves state identity when every returned summary is unchanged', async () => {
    const worktreeSummaries = {
      'proj/wt-a': SUMMARY,
    };
    useActivityStore.setState({ worktreeSummaries });
    loadWorktreeSummariesMock.mockResolvedValue({
      'proj/wt-a': { ...SUMMARY },
    });
    let updates = 0;
    const unsubscribe = useActivityStore.subscribe(() => {
      updates += 1;
    });

    await useActivityStore
      .getState()
      .loadWorktreeSummaries([{ projectId: 'proj', worktreeId: 'wt-a' }]);
    unsubscribe();

    expect(useActivityStore.getState().worktreeSummaries).toBe(
      worktreeSummaries,
    );
    expect(updates).toBe(0);
  });

  it('retains targeted single-worktree refresh behavior', async () => {
    const refreshed = {
      ...SUMMARY,
      title: 'Targeted refresh',
    };
    loadWorktreeSummaryMock.mockResolvedValue(refreshed);

    await useActivityStore.getState().loadWorktreeSummary('proj', 'wt-a');

    expect(loadWorktreeSummaryMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt-a',
    });
    expect(useActivityStore.getState().worktreeSummaries['proj/wt-a']).toEqual(
      refreshed,
    );
    expect(loadWorktreeSummariesMock).not.toHaveBeenCalled();
  });

  it('skips the bridge for an empty batch', async () => {
    await useActivityStore.getState().loadWorktreeSummaries([]);
    expect(loadWorktreeSummariesMock).not.toHaveBeenCalled();
  });

  it('chunks requests at the shared IPC limit and merges once', async () => {
    const ids = Array.from(
      { length: WORKTREE_SUMMARY_BATCH_SIZE_LIMIT + 1 },
      (_, index) => `wt-${index}`,
    );
    setLiveWorktrees(ids);
    loadWorktreeSummariesMock
      .mockResolvedValueOnce({ 'proj/wt-0': SUMMARY })
      .mockResolvedValueOnce({
        [`proj/wt-${WORKTREE_SUMMARY_BATCH_SIZE_LIMIT}`]: {
          ...SUMMARY,
          title: 'Final chunk',
        },
      });
    let updates = 0;
    const unsubscribe = useActivityStore.subscribe(() => {
      updates += 1;
    });

    await useActivityStore
      .getState()
      .loadWorktreeSummaries(
        ids.map((worktreeId) => ({ projectId: 'proj', worktreeId })),
      );
    unsubscribe();

    expect(loadWorktreeSummariesMock).toHaveBeenCalledTimes(2);
    expect(loadWorktreeSummariesMock.mock.calls[0]?.[0].worktrees).toHaveLength(
      WORKTREE_SUMMARY_BATCH_SIZE_LIMIT,
    );
    expect(loadWorktreeSummariesMock.mock.calls[1]?.[0].worktrees).toHaveLength(
      1,
    );
    expect(useActivityStore.getState().worktreeSummaries).toMatchObject({
      'proj/wt-0': SUMMARY,
      [`proj/wt-${WORKTREE_SUMMARY_BATCH_SIZE_LIMIT}`]: {
        ...SUMMARY,
        title: 'Final chunk',
      },
    });
    expect(updates).toBe(1);
  });
});
