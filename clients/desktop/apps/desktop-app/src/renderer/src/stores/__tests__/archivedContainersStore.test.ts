/**
 * @jest-environment jsdom
 */
import type {
  ArchivedContainerRestoreResponse,
  ArchivedContainerSummary,
  ArchivedContainersChangedEvent,
} from '@canopy/desktop-shared/types';
import {
  EMPTY_ARCHIVED_CONTAINERS,
  ensureArchivedContainersSubscription,
  resetArchivedContainersSubscriptionForTest,
  useArchivedContainersStore,
} from '@/stores/archivedContainersStore';

const loadProjectsMock = jest.fn().mockResolvedValue(undefined);
const loadChatProjectsMock = jest.fn().mockResolvedValue(undefined);
const refreshWorkEntriesMock = jest.fn().mockResolvedValue(undefined);
const loadSidebarProjectEntriesMock = jest.fn().mockResolvedValue(undefined);

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): unknown => ({ loadProjects: loadProjectsMock }),
  },
}));

jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: (): unknown => ({
      loadChatProjects: loadChatProjectsMock,
      chatProjects: [{ id: 'workspace-1' }],
      activeChatProjectId: 'workspace-1',
      refreshWorkEntries: refreshWorkEntriesMock,
      loadSidebarProjectEntries: loadSidebarProjectEntriesMock,
    }),
  },
}));

function summary(
  overrides: Partial<ArchivedContainerSummary> = {},
): ArchivedContainerSummary {
  return {
    version: 1,
    id: 'container-1',
    kind: 'worktree',
    projectId: 'workspace-1',
    name: 'feature-branch',
    createdAt: '2026-07-01T00:00:00.000Z',
    archivedAt: '2026-07-20T00:00:00.000Z',
    retentionDays: 7,
    expiresAt: '2026-07-27T00:00:00.000Z',
    chatCount: 2,
    archivedChatCount: 1,
    executionCount: 1,
    ...overrides,
  };
}

const listMock = jest.fn<Promise<ArchivedContainerSummary[]>, [unknown]>();
const restoreMock = jest.fn<
  Promise<ArchivedContainerRestoreResponse>,
  [unknown]
>();
interface DeleteRequest {
  projectId: string;
  containerId: string;
  onlyIfDeleted?: boolean;
}

interface DeleteResponse {
  deleted: boolean;
}

const deleteMock = jest.fn<Promise<DeleteResponse>, [DeleteRequest]>();
let changedListener: ((event: ArchivedContainersChangedEvent) => void) | null =
  null;
const onChangedMock = jest.fn(
  (cb: (event: ArchivedContainersChangedEvent) => void): (() => void) => {
    changedListener = cb;
    return (): void => {
      changedListener = null;
    };
  },
);

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue([summary()]);
  restoreMock.mockReset();
  restoreMock.mockResolvedValue({
    kind: 'worktree',
    restoredWorktreeId: 'restored-worktree',
    branchName: 'feature-branch',
    warnings: [],
  });
  deleteMock.mockReset();
  deleteMock.mockResolvedValue({ deleted: true });
  onChangedMock.mockClear();
  loadProjectsMock.mockClear();
  loadChatProjectsMock.mockClear();
  refreshWorkEntriesMock.mockClear();
  loadSidebarProjectEntriesMock.mockClear();
  changedListener = null;
  resetArchivedContainersSubscriptionForTest();

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      archivedContainers: {
        list: listMock,
        restore: restoreMock,
        delete: deleteMock,
        onChanged: onChangedMock,
      },
    },
  });

  useArchivedContainersStore.setState({
    byWorkspace: {},
    loadedWorkspaces: {},
    loadingWorkspaces: {},
    viewer: null,
    overview: null,
    restoringContainer: null,
    emptyTrashRun: null,
    pendingByWorkspace: {},
  });
});

afterEach(() => {
  resetArchivedContainersSubscriptionForTest();
});

describe('archivedContainersStore', () => {
  it('loadForWorkspace caches summaries per project', async () => {
    const summaries = [summary({ id: 'a' }), summary({ id: 'b' })];
    listMock.mockResolvedValueOnce(summaries);

    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');

    expect(listMock).toHaveBeenCalledWith({ projectId: 'workspace-1' });
    const state = useArchivedContainersStore.getState();
    expect(state.byWorkspace['workspace-1']).toEqual(summaries);
    expect(state.loadedWorkspaces['workspace-1']).toBe(true);
  });

  it('coalesces concurrent loads for the same project', async () => {
    let resolveList: ((summaries: ArchivedContainerSummary[]) => void) | null =
      null;
    listMock.mockImplementationOnce(
      () =>
        new Promise<ArchivedContainerSummary[]>((resolve) => {
          resolveList = resolve;
        }),
    );

    const firstLoad = useArchivedContainersStore
      .getState()
      .loadForWorkspace('workspace-1');
    const secondLoad = useArchivedContainersStore
      .getState()
      .loadForWorkspace('workspace-1');

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(
      useArchivedContainersStore.getState().loadingWorkspaces['workspace-1'],
    ).toBe(true);
    resolveList?.([summary()]);
    await Promise.all([firstLoad, secondLoad]);

    expect(
      useArchivedContainersStore.getState().byWorkspace['workspace-1'],
    ).toEqual([summary()]);
    expect(
      useArchivedContainersStore.getState().loadingWorkspaces['workspace-1'],
    ).toBeUndefined();
  });

  it('performs a trailing authoritative read after an in-flight load', async () => {
    let resolveStaleList:
      | ((summaries: ArchivedContainerSummary[]) => void)
      | null = null;
    listMock
      .mockImplementationOnce(
        () =>
          new Promise<ArchivedContainerSummary[]>((resolve) => {
            resolveStaleList = resolve;
          }),
      )
      .mockResolvedValueOnce([summary({ id: 'new-archive' })]);

    const staleLoad = useArchivedContainersStore
      .getState()
      .loadForWorkspace('workspace-1');
    const trailingLoad = useArchivedContainersStore
      .getState()
      .loadForWorkspace('workspace-1', { trailing: true });

    expect(listMock).toHaveBeenCalledTimes(1);
    resolveStaleList?.([]);
    await Promise.all([staleLoad, trailingLoad]);

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(
      useArchivedContainersStore.getState().byWorkspace['workspace-1'],
    ).toEqual([summary({ id: 'new-archive' })]);
  });

  it('preserves cached summaries when a refresh returns equivalent data', async () => {
    listMock.mockResolvedValueOnce([
      summary({
        restoredTo: {
          kind: 'worktree',
          id: 'restored-worktree',
          restoredAt: '2026-07-21T00:00:00.000Z',
          createdAt: '2026-07-20T00:00:00.000Z',
        },
      }),
    ]);
    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');
    const firstSummaries =
      useArchivedContainersStore.getState().byWorkspace['workspace-1'];

    listMock.mockResolvedValueOnce([
      summary({
        restoredTo: {
          kind: 'worktree',
          id: 'restored-worktree',
          restoredAt: '2026-07-21T00:00:00.000Z',
          createdAt: '2026-07-20T00:00:00.000Z',
        },
      }),
    ]);
    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');

    expect(
      useArchivedContainersStore.getState().byWorkspace['workspace-1'],
    ).toBe(firstSummaries);
  });

  it('loadForWorkspace failure keeps prior state (best-effort)', async () => {
    listMock.mockRejectedValueOnce(new Error('boom'));
    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');
    expect(
      useArchivedContainersStore.getState().byWorkspace['workspace-1'],
    ).toBeUndefined();
  });

  it('loadForWorkspace strict mode rejects instead of blessing stale state', async () => {
    listMock.mockRejectedValueOnce(new Error('authoritative reload failed'));

    await expect(
      useArchivedContainersStore
        .getState()
        .loadForWorkspace('workspace-1', { strict: true }),
    ).rejects.toThrow('authoritative reload failed');
  });

  it('isolates a strict in-flight failure from best-effort joiners', async () => {
    let rejectList: ((error: Error) => void) | null = null;
    listMock
      .mockImplementationOnce(
        () =>
          new Promise<ArchivedContainerSummary[]>((_resolve, reject) => {
            rejectList = reject;
          }),
      )
      .mockResolvedValueOnce([]);

    const strictLoad = useArchivedContainersStore
      .getState()
      .loadForWorkspace('workspace-1', { strict: true });
    const bestEffortLoad = useArchivedContainersStore
      .getState()
      .loadForWorkspace('workspace-1');
    const trailingBestEffortLoad = useArchivedContainersStore
      .getState()
      .loadForWorkspace('workspace-1', { trailing: true });

    expect(listMock).toHaveBeenCalledTimes(1);
    const strictExpectation = expect(strictLoad).rejects.toThrow(
      'authoritative reload failed',
    );
    const bestEffortExpectation =
      expect(bestEffortLoad).resolves.toBeUndefined();
    const trailingExpectation = expect(
      trailingBestEffortLoad,
    ).resolves.toBeUndefined();

    rejectList?.(new Error('authoritative reload failed'));
    await Promise.all([
      strictExpectation,
      bestEffortExpectation,
      trailingExpectation,
    ]);
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('preserves strict failure reporting for a best-effort in-flight load', async () => {
    let rejectList: ((error: Error) => void) | null = null;
    listMock.mockImplementationOnce(
      () =>
        new Promise<ArchivedContainerSummary[]>((_resolve, reject) => {
          rejectList = reject;
        }),
    );

    const bestEffortLoad = useArchivedContainersStore
      .getState()
      .loadForWorkspace('workspace-1');
    const strictLoad = useArchivedContainersStore
      .getState()
      .loadForWorkspace('workspace-1', { strict: true });

    const bestEffortExpectation =
      expect(bestEffortLoad).resolves.toBeUndefined();
    const strictExpectation = expect(strictLoad).rejects.toThrow(
      'authoritative reload failed',
    );

    rejectList?.(new Error('authoritative reload failed'));
    await Promise.all([bestEffortExpectation, strictExpectation]);
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it('openViewer sets viewer state and lazily loads unseen projects', async () => {
    useArchivedContainersStore
      .getState()
      .openViewer('workspace-1', 'container-1', { chatId: 'chat-1' });

    expect(useArchivedContainersStore.getState().viewer).toEqual({
      workspaceId: 'workspace-1',
      containerId: 'container-1',
      tab: 'chats',
      selectedChatId: 'chat-1',
    });
    await flushAsync();
    expect(listMock).toHaveBeenCalledWith({ projectId: 'workspace-1' });
  });

  it('openViewer honors an explicit pipelines tab', () => {
    useArchivedContainersStore
      .getState()
      .openViewer('workspace-1', 'container-1', { tab: 'pipelines' });
    expect(useArchivedContainersStore.getState().viewer?.tab).toBe('pipelines');
  });

  it('selectTab switches tab and clears the selected document', () => {
    const store = useArchivedContainersStore.getState();
    store.openViewer('workspace-1', 'container-1', {
      chatId: 'chat-1',
      planId: 'plan-1',
    });
    useArchivedContainersStore.getState().selectTab('pipelines');

    expect(useArchivedContainersStore.getState().viewer).toEqual({
      workspaceId: 'workspace-1',
      containerId: 'container-1',
      tab: 'pipelines',
      selectedChatId: undefined,
      selectedPlanId: undefined,
    });
  });

  it('selectChat updates the viewer selection', () => {
    useArchivedContainersStore
      .getState()
      .openViewer('workspace-1', 'container-1');
    useArchivedContainersStore.getState().selectChat('chat-9');
    expect(useArchivedContainersStore.getState().viewer?.selectedChatId).toBe(
      'chat-9',
    );
  });

  it('selectPlan updates the viewer selection', () => {
    useArchivedContainersStore
      .getState()
      .openViewer('workspace-1', 'container-1');
    useArchivedContainersStore.getState().selectPlan('plan-9');
    expect(useArchivedContainersStore.getState().viewer?.selectedPlanId).toBe(
      'plan-9',
    );
  });

  it('closeViewer clears viewer state and the overview beneath it', () => {
    useArchivedContainersStore
      .getState()
      .openViewer('workspace-1', 'container-1');
    expect(useArchivedContainersStore.getState().overview).toEqual({
      workspaceId: 'workspace-1',
    });
    useArchivedContainersStore.getState().closeViewer();
    expect(useArchivedContainersStore.getState().viewer).toBeNull();
    expect(useArchivedContainersStore.getState().overview).toBeNull();
  });

  it('openOverview opens the project list, closes any viewer, and loads', async () => {
    useArchivedContainersStore
      .getState()
      .openViewer('workspace-1', 'container-1');
    useArchivedContainersStore.getState().openOverview('workspace-2');
    expect(useArchivedContainersStore.getState().viewer).toBeNull();
    expect(useArchivedContainersStore.getState().overview).toEqual({
      workspaceId: 'workspace-2',
    });
    await flushAsync();
    expect(listMock).toHaveBeenCalledWith({ projectId: 'workspace-2' });
  });

  it('closeViewerToOverview keeps the overview so Back lands on the list', () => {
    useArchivedContainersStore
      .getState()
      .openViewer('workspace-1', 'container-1');
    useArchivedContainersStore.getState().closeViewerToOverview();
    expect(useArchivedContainersStore.getState().viewer).toBeNull();
    expect(useArchivedContainersStore.getState().overview).toEqual({
      workspaceId: 'workspace-1',
    });
    useArchivedContainersStore.getState().closeOverview();
    expect(useArchivedContainersStore.getState().overview).toBeNull();
  });

  it('a container that disappears on reload closes the viewer but keeps the overview', async () => {
    useArchivedContainersStore
      .getState()
      .openViewer('workspace-1', 'container-1');
    // Let the lazy first load (which still lists the container) settle before
    // the authoritative reload drops it.
    await flushAsync();
    listMock.mockResolvedValue([]);
    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');
    expect(useArchivedContainersStore.getState().viewer).toBeNull();
    expect(useArchivedContainersStore.getState().overview).toEqual({
      workspaceId: 'workspace-1',
    });
  });

  it('emptyTrash permanently deletes only unlocked (Deleted) containers and reports failures', async () => {
    const archived = summary({
      id: 'archived-1',
      lockedAt: '2026-07-21T00:00:00.000Z',
    });
    const deletedA = summary({ id: 'deleted-a' });
    const deletedB = summary({ id: 'deleted-b' });
    listMock.mockResolvedValueOnce([archived, deletedA, deletedB]);
    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');
    useArchivedContainersStore
      .getState()
      .openViewer('workspace-1', 'deleted-a');
    deleteMock.mockImplementation((request: DeleteRequest) => {
      const { containerId } = request;
      return containerId === 'deleted-b'
        ? Promise.reject(new Error('busy'))
        : Promise.resolve({ deleted: true });
    });
    listMock.mockResolvedValue([archived, deletedB]);

    const result = await useArchivedContainersStore
      .getState()
      .emptyTrash('workspace-1');

    expect(result).toEqual({
      deletedIds: ['deleted-a'],
      failedIds: ['deleted-b'],
      cancelled: false,
      remainingIds: [],
    });
    expect(useArchivedContainersStore.getState().emptyTrashRun).toBeNull();
    expect(deleteMock).toHaveBeenCalledTimes(2);
    expect(deleteMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ containerId: 'archived-1' }),
    );
    // The viewer's container was emptied: land on the overview list.
    expect(useArchivedContainersStore.getState().viewer).toBeNull();
    expect(useArchivedContainersStore.getState().overview).toEqual({
      workspaceId: 'workspace-1',
    });
    expect(
      useArchivedContainersStore.getState().byWorkspace['workspace-1'],
    ).toEqual([archived, deletedB]);
  });

  it('emptyTrash preserves and reports an item archived before its turn', async () => {
    const first = summary({ id: 'first' });
    const archivedDuringRun = summary({ id: 'second' });
    listMock.mockResolvedValueOnce([first, archivedDuringRun]);
    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');
    deleteMock
      .mockResolvedValueOnce({ deleted: true })
      .mockResolvedValueOnce({ deleted: false });
    listMock.mockResolvedValue([
      summary({
        id: 'second',
        lockedAt: '2026-07-21T00:00:00.000Z',
      }),
    ]);

    const result = await useArchivedContainersStore
      .getState()
      .emptyTrash('workspace-1');

    expect(result).toEqual({
      deletedIds: ['first'],
      failedIds: [],
      cancelled: false,
      remainingIds: ['second'],
    });
    expect(deleteMock).toHaveBeenNthCalledWith(1, {
      projectId: 'workspace-1',
      containerId: 'first',
      onlyIfDeleted: true,
    });
    expect(deleteMock).toHaveBeenNthCalledWith(2, {
      projectId: 'workspace-1',
      containerId: 'second',
      onlyIfDeleted: true,
    });
  });

  it('emptyTrash does not report a concurrently missing item as archived', async () => {
    const first = summary({ id: 'first' });
    const missingDuringRun = summary({ id: 'second' });
    listMock.mockResolvedValueOnce([first, missingDuringRun]);
    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');
    deleteMock
      .mockResolvedValueOnce({ deleted: true })
      .mockResolvedValueOnce({ deleted: false });
    listMock.mockResolvedValue([]);

    const result = await useArchivedContainersStore
      .getState()
      .emptyTrash('workspace-1');

    expect(result).toEqual({
      deletedIds: ['first'],
      failedIds: [],
      cancelled: false,
      remainingIds: [],
    });
  });

  it('emptyTrash rejects when its authoritative result reload fails', async () => {
    const first = summary({ id: 'first' });
    listMock.mockResolvedValueOnce([first]);
    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');
    deleteMock.mockResolvedValueOnce({ deleted: false });
    listMock.mockRejectedValueOnce(new Error('post-delete reload failed'));

    await expect(
      useArchivedContainersStore.getState().emptyTrash('workspace-1'),
    ).rejects.toThrow('post-delete reload failed');
    expect(useArchivedContainersStore.getState().emptyTrashRun).toBeNull();
  });

  it('emptyTrash waits for a trailing authoritative result reload', async () => {
    const deleted = summary({ id: 'deleted' });
    listMock.mockResolvedValueOnce([deleted]);
    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');

    let resolveStaleList:
      | ((summaries: ArchivedContainerSummary[]) => void)
      | null = null;
    listMock
      .mockImplementationOnce(
        () =>
          new Promise<ArchivedContainerSummary[]>((resolve) => {
            resolveStaleList = resolve;
          }),
      )
      .mockResolvedValueOnce([]);
    const staleLoad = useArchivedContainersStore
      .getState()
      .loadForWorkspace('workspace-1');
    deleteMock.mockResolvedValueOnce({ deleted: false });

    const emptyTrash = useArchivedContainersStore
      .getState()
      .emptyTrash('workspace-1');
    await flushAsync();
    expect(listMock).toHaveBeenCalledTimes(2);

    resolveStaleList?.([deleted]);
    await staleLoad;
    const result = await emptyTrash;

    expect(listMock).toHaveBeenCalledTimes(3);
    expect(result.remainingIds).toEqual([]);
    expect(
      useArchivedContainersStore.getState().byWorkspace['workspace-1'],
    ).toEqual([]);
  });

  it('emptyTrash honors cancel only between items and reports what is left', async () => {
    const first = summary({ id: 'first' });
    const second = summary({ id: 'second' });
    const third = summary({ id: 'third' });
    listMock.mockResolvedValueOnce([first, second, third]);
    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');
    let finishFirst: () => void = () => undefined;
    deleteMock.mockImplementationOnce(
      () =>
        new Promise<DeleteResponse>((resolve) => {
          finishFirst = (): void => resolve({ deleted: true });
        }),
    );
    listMock.mockResolvedValue([second, third]);

    const run = useArchivedContainersStore.getState().emptyTrash('workspace-1');
    await flushAsync();
    expect(useArchivedContainersStore.getState().emptyTrashRun).toEqual({
      workspaceId: 'workspace-1',
      total: 3,
      completed: 0,
      cancelRequested: false,
    });
    // Cancel while the first delete is still in flight: that delete must
    // finish, and nothing after it may start.
    useArchivedContainersStore.getState().cancelEmptyTrash();
    expect(
      useArchivedContainersStore.getState().emptyTrashRun?.cancelRequested,
    ).toBe(true);
    finishFirst();
    const result = await run;

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      deletedIds: ['first'],
      failedIds: [],
      cancelled: true,
      remainingIds: ['second', 'third'],
    });
    expect(useArchivedContainersStore.getState().emptyTrashRun).toBeNull();
    expect(
      useArchivedContainersStore.getState().byWorkspace['workspace-1'],
    ).toEqual([second, third]);
  });

  it('emptyTrash publishes progress per item and ignores a second concurrent run', async () => {
    listMock.mockResolvedValueOnce([
      summary({ id: 'a' }),
      summary({ id: 'b' }),
    ]);
    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');
    const seen: number[] = [];
    deleteMock.mockImplementation(() => {
      seen.push(
        useArchivedContainersStore.getState().emptyTrashRun?.completed ?? -1,
      );
      return Promise.resolve({ deleted: true });
    });
    listMock.mockResolvedValue([]);
    const run = useArchivedContainersStore.getState().emptyTrash('workspace-1');
    const duplicate = await useArchivedContainersStore
      .getState()
      .emptyTrash('workspace-1');
    expect(duplicate).toEqual({
      deletedIds: [],
      failedIds: [],
      cancelled: false,
      remainingIds: ['a', 'b'],
    });
    await run;
    expect(seen).toEqual([0, 1]);
    expect(deleteMock).toHaveBeenCalledTimes(2);
    // cancelEmptyTrash is a no-op with nothing running.
    useArchivedContainersStore.getState().cancelEmptyTrash();
    expect(useArchivedContainersStore.getState().emptyTrashRun).toBeNull();
  });

  it('treats a disk-usage change as new data on refresh', async () => {
    listMock.mockResolvedValueOnce([summary()]);
    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');
    const before =
      useArchivedContainersStore.getState().byWorkspace['workspace-1'];
    listMock.mockResolvedValueOnce([
      summary({
        diskUsage: {
          filesBytes: 10,
          gitBytes: 5,
          totalBytes: 15,
          computedAt: '2026-07-21T00:00:00.000Z',
        },
      }),
    ]);
    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');
    const after =
      useArchivedContainersStore.getState().byWorkspace['workspace-1'];
    expect(after).not.toBe(before);
    expect(after?.[0]?.diskUsage?.totalBytes).toBe(15);
  });

  it('restore returns the backend result and refreshes project + sidebar', async () => {
    const result = await useArchivedContainersStore
      .getState()
      .restore('workspace-1', 'container-1');

    expect(restoreMock).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      containerId: 'container-1',
    });
    expect(result?.restoredWorktreeId).toBe('restored-worktree');
    expect(listMock).toHaveBeenCalledWith({ projectId: 'workspace-1' });
    await flushAsync();
    expect(loadProjectsMock).toHaveBeenCalledWith({ silent: true });
    expect(loadChatProjectsMock).toHaveBeenCalled();
    expect(refreshWorkEntriesMock).toHaveBeenCalledWith('workspace-1');
  });

  it('restore surfaces warnings from a partial result to the caller', async () => {
    restoreMock.mockResolvedValueOnce({
      kind: 'worktree',
      restoredWorktreeId: 'restored-worktree',
      warnings: ['pipeline runs pending'],
    });
    const result = await useArchivedContainersStore
      .getState()
      .restore('workspace-1', 'container-1');
    expect(result?.warnings).toEqual(['pipeline runs pending']);
  });

  it('restore returns null on transport failure', async () => {
    restoreMock.mockRejectedValueOnce(new Error('nope'));
    const result = await useArchivedContainersStore
      .getState()
      .restore('workspace-1', 'container-1');
    expect(result).toBeNull();
  });

  it('closes the viewer when a reload no longer contains the open container', async () => {
    useArchivedContainersStore
      .getState()
      .openViewer('workspace-1', 'container-gone');
    listMock.mockResolvedValue([summary({ id: 'other' })]);

    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');

    expect(useArchivedContainersStore.getState().viewer).toBeNull();
  });

  it('keeps the viewer open when its container is still listed', async () => {
    useArchivedContainersStore
      .getState()
      .openViewer('workspace-1', 'container-1');
    listMock.mockResolvedValue([summary({ id: 'container-1' })]);

    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');

    expect(useArchivedContainersStore.getState().viewer?.containerId).toBe(
      'container-1',
    );
  });

  it('restore pins the viewer open while the consumed container disappears', async () => {
    useArchivedContainersStore
      .getState()
      .openViewer('workspace-1', 'container-1');
    await flushAsync();
    // The restore consumed the container: the post-restore reload returns an
    // empty list, which would normally auto-close the viewer.
    listMock.mockResolvedValue([]);

    const result = await useArchivedContainersStore
      .getState()
      .restore('workspace-1', 'container-1');

    expect(result?.restoredWorktreeId).toBe('restored-worktree');
    expect(useArchivedContainersStore.getState().viewer?.containerId).toBe(
      'container-1',
    );
    expect(useArchivedContainersStore.getState().restoringContainer).toEqual({
      workspaceId: 'workspace-1',
      containerId: 'container-1',
    });

    // Navigation closes the viewer last; that also releases the pin.
    useArchivedContainersStore.getState().closeViewer();
    expect(useArchivedContainersStore.getState().viewer).toBeNull();
    expect(useArchivedContainersStore.getState().restoringContainer).toBeNull();
  });

  it('restore releases the pin when the container is still listed (partial restore)', async () => {
    useArchivedContainersStore
      .getState()
      .openViewer('workspace-1', 'container-1');
    await flushAsync();
    listMock.mockResolvedValue([summary({ id: 'container-1' })]);

    await useArchivedContainersStore
      .getState()
      .restore('workspace-1', 'container-1');

    expect(useArchivedContainersStore.getState().viewer?.containerId).toBe(
      'container-1',
    );
    expect(useArchivedContainersStore.getState().restoringContainer).toBeNull();

    // With the pin released, a later background disappearance closes it.
    listMock.mockResolvedValue([]);
    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');
    expect(useArchivedContainersStore.getState().viewer).toBeNull();
  });

  it('restore failure releases the pin', async () => {
    useArchivedContainersStore
      .getState()
      .openViewer('workspace-1', 'container-1');
    await flushAsync();
    restoreMock.mockRejectedValueOnce(new Error('nope'));

    const result = await useArchivedContainersStore
      .getState()
      .restore('workspace-1', 'container-1');

    expect(result).toBeNull();
    expect(useArchivedContainersStore.getState().restoringContainer).toBeNull();
    expect(useArchivedContainersStore.getState().viewer?.containerId).toBe(
      'container-1',
    );
  });

  it('deletePermanently closes the viewer, deletes, and refreshes', async () => {
    useArchivedContainersStore
      .getState()
      .openViewer('workspace-1', 'container-1');
    listMock.mockResolvedValue([]);

    const ok = await useArchivedContainersStore
      .getState()
      .deletePermanently('workspace-1', 'container-1');

    expect(ok).toBe(true);
    expect(deleteMock).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      containerId: 'container-1',
    });
    expect(useArchivedContainersStore.getState().viewer).toBeNull();
    await flushAsync();
    expect(loadProjectsMock).toHaveBeenCalled();
  });

  it('deletePermanently returns false and keeps state on failure', async () => {
    deleteMock.mockRejectedValueOnce(new Error('nope'));
    useArchivedContainersStore
      .getState()
      .openViewer('workspace-1', 'container-1');

    const ok = await useArchivedContainersStore
      .getState()
      .deletePermanently('workspace-1', 'container-1');

    expect(ok).toBe(false);
    expect(useArchivedContainersStore.getState().viewer?.containerId).toBe(
      'container-1',
    );
  });

  it('changed events reload projects that were previously loaded, coalescing bursts', async () => {
    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');
    listMock.mockClear();

    ensureArchivedContainersSubscription();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
    jest.useFakeTimers();
    try {
      // A retention sweep broadcasts one event per purged container; the
      // handler must coalesce the burst into a single refresh round.
      changedListener?.({ workspaceId: 'workspace-1' });
      changedListener?.({ workspaceId: 'workspace-1' });
      changedListener?.({ workspaceId: 'workspace-1' });
      jest.advanceTimersByTime(300);
    } finally {
      jest.useRealTimers();
    }
    await flushAsync();

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledWith({ projectId: 'workspace-1' });
    expect(loadProjectsMock).toHaveBeenCalledTimes(1);
    expect(loadProjectsMock).toHaveBeenCalledWith({ silent: true });
    expect(loadChatProjectsMock).toHaveBeenCalledTimes(1);
  });

  it('changed events for never-loaded projects refresh only sidebar data', async () => {
    ensureArchivedContainersSubscription();
    jest.useFakeTimers();
    try {
      changedListener?.({ workspaceId: 'workspace-other' });
      jest.advanceTimersByTime(300);
    } finally {
      jest.useRealTimers();
    }
    await flushAsync();

    expect(listMock).not.toHaveBeenCalled();
    expect(loadProjectsMock).toHaveBeenCalled();
  });

  it('subscription is idempotent', () => {
    ensureArchivedContainersSubscription();
    ensureArchivedContainersSubscription();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it('exports a stable empty-list constant for selectors', () => {
    expect(EMPTY_ARCHIVED_CONTAINERS).toEqual([]);
    expect(Object.isFrozen(EMPTY_ARCHIVED_CONTAINERS)).toBe(true);
  });
});

describe('archivedContainersStore pending removals', () => {
  const pending = {
    workspaceId: 'workspace-1',
    containerId: 'wt-pending',
    kind: 'worktree' as const,
    name: 'feature/pending',
    branchName: 'feature/pending',
    state: 'deleted' as const,
  };

  it('registerPendingContainer adds a placeholder and loads an unseen project', async () => {
    useArchivedContainersStore.getState().registerPendingContainer(pending);
    const entries =
      useArchivedContainersStore.getState().pendingByWorkspace['workspace-1'];
    expect(entries).toHaveLength(1);
    expect(entries?.[0]).toMatchObject(pending);
    expect(typeof entries?.[0]?.startedAt).toBe('number');
    await flushAsync();
    // The workspace was not loaded yet, so counters can now derive from
    // store data (summaries + placeholder) instead of the sidebar snapshot.
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(
      useArchivedContainersStore.getState().loadedWorkspaces['workspace-1'],
    ).toBe(true);
  });

  it('registerPendingContainer dedupes by container id and skips loads for loaded projects', async () => {
    useArchivedContainersStore.setState({
      loadedWorkspaces: { 'workspace-1': true },
      byWorkspace: { 'workspace-1': [] },
    });
    const store = useArchivedContainersStore.getState();
    store.registerPendingContainer(pending);
    store.registerPendingContainer({ ...pending, state: 'archived' });
    await flushAsync();
    const entries =
      useArchivedContainersStore.getState().pendingByWorkspace['workspace-1'];
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.state).toBe('archived');
    expect(listMock).not.toHaveBeenCalled();
  });

  it('clearPendingContainer drops the placeholder (removal failed)', () => {
    const store = useArchivedContainersStore.getState();
    store.registerPendingContainer(pending);
    store.registerPendingContainer({ ...pending, containerId: 'wt-other' });
    store.clearPendingContainer('workspace-1', 'wt-pending');
    expect(
      useArchivedContainersStore
        .getState()
        .pendingByWorkspace['workspace-1']?.map((entry) => entry.containerId),
    ).toEqual(['wt-other']);
    store.clearPendingContainer('workspace-1', 'wt-other');
    expect(
      useArchivedContainersStore.getState().pendingByWorkspace['workspace-1'],
    ).toBeUndefined();
    // Unknown ids are a no-op.
    store.clearPendingContainer('workspace-1', 'missing');
  });

  it('a placeholder retires once its container appears in a load', async () => {
    useArchivedContainersStore.setState({
      loadedWorkspaces: { 'workspace-1': true },
      byWorkspace: { 'workspace-1': [summary()] },
    });
    const store = useArchivedContainersStore.getState();
    store.registerPendingContainer(pending);
    store.registerPendingContainer({ ...pending, containerId: 'wt-later' });

    // A refresh that still lacks the container keeps the placeholder, even
    // when the summaries are unchanged (the equality short-circuit must not
    // strand it).
    listMock.mockResolvedValueOnce([summary()]);
    await store.loadForWorkspace('workspace-1');
    expect(
      useArchivedContainersStore.getState().pendingByWorkspace['workspace-1'],
    ).toHaveLength(2);

    listMock.mockResolvedValueOnce([
      summary(),
      summary({ id: 'wt-pending', name: 'feature/pending' }),
    ]);
    await store.loadForWorkspace('workspace-1');
    expect(
      useArchivedContainersStore
        .getState()
        .pendingByWorkspace['workspace-1']?.map((entry) => entry.containerId),
    ).toEqual(['wt-later']);
  });

  it('a stale placeholder retires on the next load even without its container', async () => {
    useArchivedContainersStore.setState({
      loadedWorkspaces: { 'workspace-1': true },
      byWorkspace: { 'workspace-1': [summary()] },
      pendingByWorkspace: {
        'workspace-1': [{ ...pending, startedAt: Date.now() - 16 * 60_000 }],
      },
    });
    listMock.mockResolvedValueOnce([summary()]);
    await useArchivedContainersStore.getState().loadForWorkspace('workspace-1');
    expect(
      useArchivedContainersStore.getState().pendingByWorkspace['workspace-1'],
    ).toBeUndefined();
  });
});
