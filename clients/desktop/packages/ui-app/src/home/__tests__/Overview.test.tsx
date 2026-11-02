import { renderToString } from 'react-dom/server';
import type { OverviewState } from '@canopy/app-state';
import type { PortalSessionShellState } from '@canopy/protocol/portal';

let mockState: OverviewState;
let overviewNotifications = true;
jest.mock('@canopy/app-state', () => {
  const real: Record<string, unknown> = jest.requireActual('@canopy/app-state');
  return {
    __esModule: true,
    ...real,
    useOverviewStore: <T,>(selector: (state: OverviewState) => T): T =>
      selector(mockState),
    useCapabilities: (): { overviewNotifications: boolean } => ({
      overviewNotifications,
    }),
  };
});

import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { Overview } from '../Overview';

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

function overview(snapshot: PortalSessionShellState | null): OverviewState {
  return { snapshot, hydrate: (): void => {} };
}

describe('Overview', () => {
  beforeEach(() => {
    overviewNotifications = true;
  });

  it('renders all sections empty for a null snapshot', () => {
    mockState = overview(null);
    const out = renderToString(<Overview onSelectWorktree={(): void => {}} />);
    expect(out).toContain('data-testid="overview"');
    expect(out).toContain('data-testid="overview-unread-empty"');
    expect(out).toContain('data-testid="overview-in-progress-empty"');
    expect(out).toContain('data-testid="overview-awaiting-empty"');
    expect(out).toContain('data-testid="overview-pipelines-empty"');
    expect(out).toContain('data-testid="overview-unread-pipelines-empty"');
  });

  it('opens the full-page layout with the shared page header', () => {
    mockState = overview(null);
    const out = renderToString(
      <Overview layout="page" onSelectWorktree={(): void => {}} />,
    );

    expect(out).toContain('data-testid="page-header"');
    expect(out).toContain('data-testid="page-header-title">Overview</h1>');
    expect(out).not.toContain('text-2xl font-semibold fg-primary');
  });

  it('renders host recommendations beside unread pipelines before notifications', () => {
    mockState = overview(null);
    const out = renderToString(
      <Overview
        onSelectWorktree={(): void => {}}
        notifications={<div>Notifications</div>}
        recommendations={
          <div data-testid="host-recommendations">Recommendations</div>
        }
      />,
    );

    expect(out).toContain('data-testid="host-recommendations"');
    expect(out).toContain('data-testid="overview-recommendations"');
    expect(out).toContain('order-first');
    expect(out).toContain('md:order-none');
    expect(out.indexOf('data-testid="host-recommendations"')).toBeGreaterThan(
      out.indexOf('data-testid="overview-unread-pipelines"'),
    );
    expect(out.indexOf('data-testid="host-recommendations"')).toBeLessThan(
      out.indexOf('data-testid="overview-notifications"'),
    );
  });

  it('does not reserve a grid cell when the host omits recommendations', () => {
    mockState = overview(null);
    const out = renderToString(<Overview onSelectWorktree={(): void => {}} />);

    expect(out).not.toContain('data-testid="overview-recommendations"');
  });

  it('renders cards from the snapshot with worktree labels', () => {
    mockState = overview(
      shell({
        workspaces: [
          { localId: 'ws1', name: 'Proj', type: 'single-repo', repos: [] },
        ],
        worktrees: [
          {
            localId: 'wt1',
            workspaceLocalId: 'ws1',
            branch: 'main',
            hasUnread: true,
            awaitingApproval: true,
          },
          {
            localId: 'wt2',
            workspaceLocalId: 'ws1',
            branch: 'feat',
            isStreaming: true,
          },
          {
            localId: 'wt3',
            workspaceLocalId: 'ws1',
            branch: 'plan',
            awaitingApproval: true,
          },
        ],
        pipelineRuns: [
          {
            localId: 'r1',
            pipelineName: 'deploy',
            status: 'running',
            workspaceLocalId: 'ws1',
            worktreeLocalId: 'wt1',
          },
          {
            localId: 'r2',
            pipelineName: 'nightly',
            status: 'failure',
            workspaceLocalId: 'ws1',
            worktreeLocalId: 'wt1',
          },
        ],
        chatSummaries: [
          {
            localId: 'wt1',
            chatId: 'wt1',
            scope: 'worktree',
            workspaceLocalId: 'ws1',
            worktreeLocalId: 'wt1',
            title: 'Review auth flow',
            description: 'I found the failing request.',
            planMode: true,
          },
          {
            localId: 'wt2',
            chatId: 'wt2',
            scope: 'worktree',
            workspaceLocalId: 'ws1',
            worktreeLocalId: 'wt2',
            title: 'Fixing tests',
            description: 'Updating the regression suite.',
          },
          {
            localId: 'wt1',
            chatId: 'wt1',
            scope: 'standalone',
            title: 'Standalone collision title',
          },
        ],
      }),
    );
    const out = renderToString(
      <Overview onSelectWorktree={(): void => {}} />,
    ).replace(/<!-- -->/g, '');
    expect(out).toContain('data-testid="overview-unread-chat-card"');
    expect(out).toContain('data-testid="overview-in-progress-chat-card"');
    expect(out).toContain('data-testid="overview-awaiting-card"');
    expect(out).toContain('data-testid="overview-in-progress-pipeline-card"');
    expect(out).toContain('data-testid="overview-unread-pipeline-card"');
    expect(out).toContain('Proj · main');
    expect(out).toContain('deploy');
    expect(out).toContain('nightly');
    expect(out).toContain('Review auth flow');
    expect(out).toContain('I found the failing request.');
    expect(out).toContain('Fixing tests');
    expect(out).toContain('Updating the regression suite.');
    // Previews quote the chat's last reply, so session replay blocks them.
    expect(out).toContain(
      `<span class="${REPLAY_BLOCK_CLASS}">I found the failing request.</span>`,
    );
    expect(out).toContain(
      `<span class="${REPLAY_BLOCK_CLASS}">Updating the regression suite.</span>`,
    );
    expect(out).not.toContain('Standalone collision title');
    expect(out).toContain('Review plan');
    expect(out).toContain('Streaming');
    expect(out).toMatch(
      /class="(?=[^"]*\bmax-h-96\b)(?=[^"]*\boverflow-y-auto\b)[^"]*"/,
    );
    // No empty states when populated.
    expect(out).not.toContain('data-testid="overview-unread-empty"');
  });

  it('excludes hidden worktrees from unread but not in-progress or awaiting', () => {
    mockState = overview(
      shell({
        workspaces: [
          { localId: 'ws1', name: 'Proj', type: 'single-repo', repos: [] },
        ],
        worktrees: [
          {
            localId: 'wt1',
            workspaceLocalId: 'ws1',
            branch: 'h',
            hasUnread: true,
            hidden: true,
          },
          {
            localId: 'wt2',
            workspaceLocalId: 'ws1',
            branch: 's',
            isStreaming: true,
            hidden: true,
          },
          {
            localId: 'wt3',
            workspaceLocalId: 'ws1',
            branch: 'a',
            awaitingApproval: true,
            hidden: true,
          },
        ],
      }),
    );
    const out = renderToString(<Overview onSelectWorktree={(): void => {}} />);
    // Hidden unread → excluded; hidden streaming + awaiting → still shown.
    expect(out).toContain('data-testid="overview-unread-empty"');
    expect(out).toContain('data-testid="overview-in-progress-chat-card"');
    expect(out).toContain('data-testid="overview-awaiting-card"');
  });

  it('renders a non-interactive pipeline card when the run has no worktree', () => {
    mockState = overview(
      shell({
        pipelineRuns: [
          { localId: 'r1', pipelineName: 'nightly', status: 'running' },
        ],
      }),
    );
    const out = renderToString(<Overview onSelectWorktree={(): void => {}} />);
    expect(out).toContain('data-testid="overview-in-progress-pipeline-card"');
    expect(out).toContain('nightly');
    // No worktreeLocalId → no action overlay.
    expect(out).not.toContain(
      'data-testid="overview-in-progress-pipeline-card-open"',
    );
  });

  it('renders a non-interactive unread-pipeline card when the run has no worktree', () => {
    mockState = overview(
      shell({
        pipelineRuns: [
          { localId: 'r1', pipelineName: 'nightly', status: 'failure' },
        ],
      }),
    );
    const out = renderToString(<Overview onSelectWorktree={(): void => {}} />);
    expect(out).toContain('data-testid="overview-unread-pipeline-card"');
    expect(out).toContain('nightly');
    expect(out).not.toContain(
      'data-testid="overview-unread-pipeline-card-open"',
    );
  });

  it('renders host notifications only when the capability is available', () => {
    mockState = overview(null);
    const enabled = renderToString(
      <Overview
        onSelectWorktree={(): void => {}}
        notifications={<div>Desktop notification</div>}
      />,
    );
    expect(enabled).toContain('data-testid="overview-notifications"');
    expect(enabled).toContain('Desktop notification');

    overviewNotifications = false;
    const disabled = renderToString(
      <Overview
        onSelectWorktree={(): void => {}}
        notifications={<div>Desktop notification</div>}
      />,
    );
    expect(disabled).not.toContain('data-testid="overview-notifications"');
  });

  it('renders host-neutral details for running and unread pipeline cards', () => {
    mockState = overview(
      shell({
        pipelineRuns: [
          { localId: 'r1', pipelineName: 'build', status: 'running' },
          { localId: 'r2', pipelineName: 'deploy', status: 'success' },
        ],
      }),
    );
    const out = renderToString(
      <Overview
        onSelectWorktree={(): void => {}}
        renderPipelineRunDetails={(run, unread) => (
          <span>{`${run.localId}:${unread ? 'unread' : 'running'}`}</span>
        )}
      />,
    );
    expect(out).toContain('r1:running');
    expect(out).toContain('r2:unread');
  });
});
