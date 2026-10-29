/** @jest-environment jsdom */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AppAdvisorWatcherSummary } from '@canopy/desktop-shared/types';

const mockRecordCarry = jest.fn();
const mockUnsubscribe = jest.fn();
const mockDestination = {
  projectId: 'advisor',
  worktreeId: 'entry',
  chatId: 'chat-1',
};
const mockWatcher: AppAdvisorWatcherSummary = {
  id: 'watch-1',
  trigger: 'worktree_pipeline_completion',
  status: 'active',
  label: 'Build watcher',
  target: {
    kind: 'worktree_pipeline',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    pipelineId: 'pipe-1',
  },
  destination: mockDestination,
  createdAt: '2026-08-05T12:00:00.000Z',
};
const mockGitHubWatcher: AppAdvisorWatcherSummary = {
  id: 'gh-watch-1',
  trigger: 'github_workflow_runs_changed',
  status: 'active',
  label: 'CI workflow runs',
  target: {
    kind: 'github_workflow_runs',
    items: [{ kind: 'workflow_run', repository: 'acme/api', runId: '101' }],
    notifyOn: { statuses: [], conclusions: [], jobConclusions: ['success'] },
    display: {
      repositories: ['acme/api'],
      sample: [{ repository: 'acme/api', runId: '101', runAttempt: 1 }],
    },
  },
  destination: mockDestination,
  createdAt: '2026-08-05T12:00:00.000Z',
  githubProgress: {
    runs: [
      {
        repository: 'acme/api',
        runId: '101',
        runAttempt: 1,
        workflowName: 'CI',
        runNumber: 42,
        htmlUrl: 'https://github.com/acme/api/actions/runs/101',
        state: { kind: 'intermediate', status: 'in_progress' },
        observedAt: '2026-08-05T12:00:05.000Z',
        jobs: [
          {
            jobId: '501',
            name: 'Build macOS',
            status: 'in_progress',
            conclusion: null,
            htmlUrl: 'https://github.com/acme/api/actions/runs/101/job/501',
            observedAt: '2026-08-05T12:00:05.000Z',
          },
        ],
      },
    ],
  },
};
const mockWatcherState: {
  watchers: AppAdvisorWatcherSummary[];
  hydrated: boolean;
  loading: boolean;
  subscribeBridge: jest.Mock;
  hydrate: jest.Mock;
} = {
  watchers: [mockWatcher],
  hydrated: true,
  loading: false,
  subscribeBridge: jest.fn(() => mockUnsubscribe),
  hydrate: jest.fn(),
};

jest.mock('@/stores/appAdvisorWatchersStore', () => ({
  useAppAdvisorWatchersStore: Object.assign(
    (selector: (state: typeof mockWatcherState) => unknown): unknown =>
      selector(mockWatcherState),
    { getState: (): typeof mockWatcherState => mockWatcherState },
  ),
}));
jest.mock('@/stores/pipelineRunsStore', () => ({
  usePipelineRunsStore: (
    selector: (state: { summaries: unknown[] }) => unknown,
  ): unknown =>
    selector({
      summaries: [
        {
          id: 'exec-external',
          pipeline_id: 'pipe-1',
          pipeline_name: 'External build',
          status: 'running',
          status_reasons: [],
          started_at: '2026-08-05T12:01:00.000Z',
          cwd: '/repo',
          project_id: 'project-1',
          worktree_id: 'worktree-1',
        },
      ],
    }),
}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): { recordAgentArtifactCarry: typeof mockRecordCarry } => ({
      recordAgentArtifactCarry: mockRecordCarry,
    }),
  },
}));
jest.mock('../DesktopAgentActivitySection', () => ({
  DesktopAgentActivitySection: ({
    artifacts,
    ownerUserMessageId,
  }: {
    artifacts: Array<{ executionId?: string; runId?: string }>;
    ownerUserMessageId?: string;
  }): JSX.Element => (
    <div data-testid="mock-agent-activity" data-owner={ownerUserMessageId}>
      {artifacts
        .map((artifact) => artifact.executionId ?? artifact.runId)
        .join(',')}
    </div>
  ),
}));

import { ActiveAgentActivitySection } from '../ActiveAgentActivitySection';

describe('ActiveAgentActivitySection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    mockWatcherState.watchers = [mockWatcher];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows and persists a watched run that this chat did not start', () => {
    act(() => {
      root.render(
        <ActiveAgentActivitySection
          projectedArtifacts={[]}
          knownPipelineRuns={{}}
          ownerUserMessageId="turn-1"
          chatTarget={mockDestination}
        />,
      );
    });

    expect(container.textContent).toContain('exec-external');
    expect(mockRecordCarry).toHaveBeenCalledWith(mockDestination, 'turn-1', [
      expect.objectContaining({ executionId: 'exec-external' }),
    ]);
  });

  it.each(['active', 'completed'] as const)(
    'shows and persists a GitHub workflow run on a %s turn',
    (variant) => {
      mockWatcherState.watchers = [mockGitHubWatcher];
      act(() => {
        root.render(
          <ActiveAgentActivitySection
            projectedArtifacts={[]}
            knownPipelineRuns={{}}
            ownerUserMessageId="turn-1"
            chatTarget={mockDestination}
            variant={variant}
          />,
        );
      });

      expect(container.textContent).toContain('101');
      expect(
        container
          .querySelector('[data-testid="mock-agent-activity"]')
          ?.getAttribute('data-owner'),
      ).toBe('turn-1');
      expect(mockRecordCarry).toHaveBeenCalledWith(mockDestination, 'turn-1', [
        expect.objectContaining({
          kind: 'github_workflow_run',
          watcherId: 'gh-watch-1',
          runId: '101',
          jobs: [expect.objectContaining({ jobId: '501' })],
        }),
      ]);
    },
  );
});
