import type { PortalSessionShellState } from '@canopy/protocol/portal';
import {
  compareWorktrees,
  deriveWorktreeUiStatus,
  deriveWorkspaceBackend,
  orderedWorkspaces,
  sidebarRowLabel,
  worktreesForWorkspace,
} from '../worktree-status';

describe('deriveWorktreeUiStatus', () => {
  // Desktop canonical priority: done > unread > working > planning > idle.
  it('maps single flags to their status', () => {
    expect(deriveWorktreeUiStatus({ status: 'done' })).toBe('done');
    expect(deriveWorktreeUiStatus({ hasUnread: true })).toBe('unread');
    expect(deriveWorktreeUiStatus({ isStreaming: true })).toBe('working');
    expect(deriveWorktreeUiStatus({ busy: true })).toBe('working');
    expect(deriveWorktreeUiStatus({ isRunningRun: true })).toBe('working');
    expect(deriveWorktreeUiStatus({ awaitingApproval: true })).toBe('planning');
    expect(deriveWorktreeUiStatus({})).toBe('idle');
  });

  it('matches the desktop precedence for ambiguous combinations', () => {
    // done outranks everything
    expect(
      deriveWorktreeUiStatus({
        status: 'done',
        isStreaming: true,
        hasUnread: true,
      }),
    ).toBe('done');
    // unread outranks working + planning
    expect(deriveWorktreeUiStatus({ hasUnread: true, isStreaming: true })).toBe(
      'unread',
    );
    expect(
      deriveWorktreeUiStatus({ hasUnread: true, awaitingApproval: true }),
    ).toBe('unread');
    // working outranks planning
    expect(
      deriveWorktreeUiStatus({ isStreaming: true, awaitingApproval: true }),
    ).toBe('working');
  });

  it('treats only status "done" (not "archived") as done', () => {
    expect(deriveWorktreeUiStatus({ status: 'archived' })).toBe('idle');
  });
});

describe('sidebarRowLabel', () => {
  it('prefers a trimmed human label', () => {
    expect(
      sidebarRowLabel(
        { type: 'single-repo' },
        { branch: 'main', label: ' Fix ' },
      ),
    ).toBe('Fix');
  });

  it('falls back to the branch for a single-repo cloud row', () => {
    // A cloud repository project is classified `single-repo`, so its rows are
    // named by their real branch, never by the Cowork "Session" fallback.
    expect(
      sidebarRowLabel(
        { type: 'single-repo' },
        { branch: 'feature/cloud-branch', label: undefined },
      ),
    ).toBe('feature/cloud-branch');
    expect(
      sidebarRowLabel(
        { type: 'single-repo' },
        { branch: 'feature/cloud-branch', label: '  ' },
      ),
    ).toBe('feature/cloud-branch');
  });

  it('keeps the Cowork "Session" fallback for a Cowork row', () => {
    expect(
      sidebarRowLabel(
        { type: 'cowork' },
        { branch: 'cloud', label: undefined },
      ),
    ).toBe('Session');
  });
});

function shell(
  partial: Partial<PortalSessionShellState>,
): PortalSessionShellState {
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
    ...partial,
  };
}

describe('orderedWorkspaces / worktreesForWorkspace', () => {
  const snapshot = shell({
    workspaces: [
      { localId: 'b', name: 'B', type: 'single-repo', order: 2, repos: [] },
      { localId: 'a', name: 'A', type: 'single-repo', order: 1, repos: [] },
      {
        localId: 'h',
        name: 'H',
        type: 'single-repo',
        order: 0,
        hidden: true,
        repos: [],
      },
    ],
    worktrees: [
      { localId: 'w2', workspaceLocalId: 'a', branch: 'f2', order: 2 },
      { localId: 'w1', workspaceLocalId: 'a', branch: 'f1', order: 1 },
      {
        localId: 'wh',
        workspaceLocalId: 'a',
        branch: 'fh',
        order: 0,
        hidden: true,
      },
      { localId: 'wb', workspaceLocalId: 'b', branch: 'fb' },
    ],
  });

  it('orders visible projects by order and drops hidden', () => {
    expect(orderedWorkspaces(snapshot).map((w) => w.localId)).toEqual([
      'a',
      'b',
    ]);
  });
  it('filters worktrees to a project, ordered, hidden dropped', () => {
    expect(worktreesForWorkspace(snapshot, 'a').map((w) => w.localId)).toEqual([
      'w1',
      'w2',
    ]);
  });
  it('hides an alwaysShow:false project only when it has no visible worktree', () => {
    const withTemporary = shell({
      workspaces: [
        {
          localId: 'keep',
          name: 'Keep',
          type: 'single-repo',
          order: 0,
          repos: [],
        },
        // temporary + empty → hidden (matches desktop)
        {
          localId: 'ghost',
          name: 'Ghost',
          type: 'multi-repo',
          order: 1,
          alwaysShow: false,
          repos: [],
        },
        // temporary but has a visible worktree → shown
        {
          localId: 'temp',
          name: 'Temp',
          type: 'multi-repo',
          order: 2,
          alwaysShow: false,
          repos: [],
        },
      ],
      worktrees: [
        { localId: 'wk', workspaceLocalId: 'keep', branch: 'k' },
        { localId: 'wt', workspaceLocalId: 'temp', branch: 't' },
      ],
    });
    expect(orderedWorkspaces(withTemporary).map((w) => w.localId)).toEqual([
      'keep',
      'temp',
    ]);
  });

  it('returns empty for a null snapshot', () => {
    expect(orderedWorkspaces(null)).toEqual([]);
    expect(worktreesForWorkspace(null, 'a')).toEqual([]);
  });
});

it('uses the existing device treatment for desktop catalog rows', (): void => {
  expect(
    deriveWorkspaceBackend(
      { localId: 'org-project:catalog', backend: 'desktop' },
      [],
    ),
  ).toBe('remote-control');
});

describe('compareWorktrees', () => {
  const worktree = (
    localId: string,
    order: number,
    pinned?: boolean,
  ): PortalSessionShellState['worktrees'][number] => ({
    localId,
    workspaceLocalId: 'w',
    branch: localId,
    order,
    ...(pinned ? { pinned: true } : {}),
  });

  // Pinned rows lead their section, as on desktop, regardless of the
  // host's order; within each group the host's order still decides.
  it('leads with pinned rows before the host order', () => {
    const rows = [
      worktree('c', 2),
      worktree('b', 1, true),
      worktree('a', 0),
      worktree('d', 3, true),
    ];
    expect(rows.sort(compareWorktrees).map((row) => row.localId)).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
  });
});
