import type { SessionViewModel } from '@canopy/app-core';
import {
  createOverviewStore,
  selectAwaitingApprovalWorktrees,
  selectInProgressChatWorktrees,
  selectOverviewCounts,
  selectRunningPipelineRuns,
  selectUnreadPipelineRuns,
  selectUnreadWorktrees,
  selectWorktreeLabel,
  type OverviewWorktree,
} from '../create-overview-store';

type PipelineRun = SessionViewModel['pipelineRuns'][number];

function worktree(
  partial: Partial<OverviewWorktree> &
    Pick<OverviewWorktree, 'localId' | 'workspaceLocalId' | 'branch'>,
): OverviewWorktree {
  return { ...partial };
}

function makeSnapshot(
  overrides: Partial<SessionViewModel> = {},
): SessionViewModel {
  return {
    workspaces: [],
    worktrees: [],
    chatProjects: [],
    standaloneChats: [],
    scriptDescriptors: [],
    scriptRuns: [],
    hookDescriptors: [],
    hookRuns: [],
    plans: [],
    pipelines: [],
    pipelineRuns: [],
    chatMessages: [],
    chatSummaries: [],
    terminalSessions: [],
    terminalBuffers: {},
    changedFiles: {},
    diffSnapshots: {},
    prStatuses: {},
    fileRoots: [],
    fileTree: {},
    filePreviews: {},
    refreshing: false,
    connectionStatus: 'active',
    ...overrides,
  };
}

describe('createOverviewStore', () => {
  it('starts empty and hydrates a snapshot', () => {
    const store = createOverviewStore();
    expect(store.getState().snapshot).toBeNull();
    expect(selectUnreadWorktrees(store.getState())).toEqual([]);
    const snapshot = makeSnapshot();
    store.getState().hydrate(snapshot);
    expect(store.getState().snapshot).toBe(snapshot);

    // Clearing the snapshot resets the derived selectors to empty.
    store.getState().hydrate(null);
    expect(store.getState().snapshot).toBeNull();
    expect(selectUnreadWorktrees(store.getState())).toEqual([]);
    expect(selectRunningPipelineRuns(store.getState())).toEqual([]);
  });

  it('selects unread (excluding hidden), streaming, and awaiting-approval worktrees', () => {
    const store = createOverviewStore();
    store.getState().hydrate(
      makeSnapshot({
        worktrees: [
          worktree({
            localId: 'wt1',
            workspaceLocalId: 'ws1',
            branch: 'a',
            hasUnread: true,
          }),
          worktree({
            localId: 'wt2',
            workspaceLocalId: 'ws1',
            branch: 'b',
            hasUnread: true,
            hidden: true,
          }),
          worktree({
            localId: 'wt3',
            workspaceLocalId: 'ws1',
            branch: 'c',
            isStreaming: true,
          }),
          worktree({
            localId: 'wt4',
            workspaceLocalId: 'ws1',
            branch: 'd',
            awaitingApproval: true,
          }),
        ],
      }),
    );

    // Hidden worktree excluded from unread.
    expect(
      selectUnreadWorktrees(store.getState()).map((w) => w.localId),
    ).toEqual(['wt1']);
    expect(
      selectInProgressChatWorktrees(store.getState()).map((w) => w.localId),
    ).toEqual(['wt3']);
    expect(
      selectAwaitingApprovalWorktrees(store.getState()).map((w) => w.localId),
    ).toEqual(['wt4']);
  });

  it('selects pending and running pipeline runs as active', () => {
    const runs: PipelineRun[] = [
      { pipelineName: 'p0', status: 'pending', worktreeLocalId: 'wt1' },
      { pipelineName: 'p1', status: 'running', worktreeLocalId: 'wt1' },
      { pipelineName: 'p2', status: 'success', worktreeLocalId: 'wt1' },
      { pipelineName: 'p3', status: 'running', worktreeLocalId: 'wt2' },
    ];
    const store = createOverviewStore();
    store.getState().hydrate(makeSnapshot({ pipelineRuns: runs }));
    expect(
      selectRunningPipelineRuns(store.getState()).map((r) => r.pipelineName),
    ).toEqual(['p0', 'p1', 'p3']);
  });

  it('selects only terminal (unread) pipeline runs', () => {
    const runs: PipelineRun[] = [
      { pipelineName: 'p0', status: 'pending', worktreeLocalId: 'wt1' },
      { pipelineName: 'p1', status: 'running', worktreeLocalId: 'wt1' },
      { pipelineName: 'p2', status: 'success', worktreeLocalId: 'wt1' },
      { pipelineName: 'p3', status: 'failure', worktreeLocalId: 'wt2' },
      { pipelineName: 'p4', status: 'paused', worktreeLocalId: 'wt2' },
      { pipelineName: 'p5', status: 'cancelled', worktreeLocalId: 'wt3' },
    ];
    const store = createOverviewStore();
    store.getState().hydrate(makeSnapshot({ pipelineRuns: runs }));
    expect(
      selectUnreadPipelineRuns(store.getState()).map((r) => r.pipelineName),
    ).toEqual(['p2', 'p3', 'p4', 'p5']);
  });

  it('aggregates overview counts', () => {
    const store = createOverviewStore();
    store.getState().hydrate(
      makeSnapshot({
        worktrees: [
          worktree({
            localId: 'wt1',
            workspaceLocalId: 'ws1',
            branch: 'a',
            hasUnread: true,
            isStreaming: true,
          }),
          worktree({
            localId: 'wt2',
            workspaceLocalId: 'ws1',
            branch: 'b',
            awaitingApproval: true,
          }),
        ],
        pipelineRuns: [
          { pipelineName: 'p0', status: 'pending', worktreeLocalId: 'wt1' },
          { pipelineName: 'p1', status: 'running', worktreeLocalId: 'wt1' },
          { pipelineName: 'p2', status: 'success', worktreeLocalId: 'wt1' },
        ],
      }),
    );
    expect(selectOverviewCounts(store.getState())).toEqual({
      unreadChats: 1,
      inProgressChats: 1,
      runningPipelines: 2,
      unreadPipelines: 1,
      awaitingApproval: 1,
    });
  });

  it('resolves worktree labels with workspace name and branch fallback', () => {
    const store = createOverviewStore();
    store.getState().hydrate(
      makeSnapshot({
        workspaces: [{ localId: 'ws1', name: 'My WS', type: 'single-repo' }],
        worktrees: [
          worktree({
            localId: 'wt1',
            workspaceLocalId: 'ws1',
            branch: 'main',
            label: 'Feature X',
          }),
          worktree({ localId: 'wt2', workspaceLocalId: 'ws1', branch: 'dev' }),
        ],
      }),
    );
    expect(selectWorktreeLabel(store.getState(), 'wt1')).toEqual({
      workspaceName: 'My WS',
      worktreeName: 'Feature X',
    });
    // Falls back to the branch when no label.
    expect(selectWorktreeLabel(store.getState(), 'wt2')).toEqual({
      workspaceName: 'My WS',
      worktreeName: 'dev',
    });
    expect(selectWorktreeLabel(store.getState(), 'missing')).toBeNull();
  });

  it('disambiguates workspace-scoped worktree ids when resolving labels', () => {
    const store = createOverviewStore();
    store.getState().hydrate(
      makeSnapshot({
        workspaces: [
          { localId: 'ws1', name: 'First', type: 'single-repo' },
          { localId: 'ws2', name: 'Second', type: 'single-repo' },
        ],
        worktrees: [
          worktree({ localId: 'shared', workspaceLocalId: 'ws1', branch: 'a' }),
          worktree({ localId: 'shared', workspaceLocalId: 'ws2', branch: 'b' }),
        ],
      }),
    );
    expect(selectWorktreeLabel(store.getState(), 'shared', 'ws2')).toEqual({
      workspaceName: 'Second',
      worktreeName: 'b',
    });
  });
});
