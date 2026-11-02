/** @jest-environment jsdom */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AppAdvisorWatcherSummary } from '@canopy/desktop-shared/types';
import { buildPipelineRunArtifactReceipt } from '@canopy/desktop-shared/lib/agent-artifacts';

const mockRecordCarry = jest.fn();
const mockRelease = jest.fn();
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
// A run this chat launched, watched by a watcher pinned to its execution. Its
// pipeline differs from the `exec-external` summary's so only it matches.
const mockChatRunReceipt = buildPipelineRunArtifactReceipt({
  operation: 'pipeline.run',
  executionId: 'exec-chat',
  pipelineId: 'pipe-chat',
  pipelineName: 'Chat build',
  initialStatus: 'running',
  queuedAt: '2026-08-05T12:02:00.000Z',
  createdAt: '2026-08-05T12:02:00.000Z',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  navigationTarget: {
    kind: 'pipeline_execution',
    executionId: 'exec-chat',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
  },
});
const mockPinnedWatcher: AppAdvisorWatcherSummary = {
  ...mockWatcher,
  id: 'watch-chat',
  target: {
    kind: 'worktree_pipeline',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    pipelineId: 'pipe-chat',
    executionId: 'exec-chat',
  },
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
  completedWatchers: AppAdvisorWatcherSummary[];
} = {
  watchers: [mockWatcher],
  completedWatchers: [],
};
const mockRetainBridge = jest.fn(() => mockRelease);

jest.mock('@/stores/appAdvisorWatchersStore', () => ({
  useAppAdvisorWatchersStore: (
    selector: (state: typeof mockWatcherState) => unknown,
  ): unknown => selector(mockWatcherState),
  retainAppAdvisorWatchersBridge: (): (() => void) => mockRetainBridge(),
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
import { WatchedRunCarryRecorder } from '../useRecordWatchedRunCarry';

describe('useRecordWatchedRunCarry', () => {
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

  it('persists a watched run that this chat did not start, holding the watcher bridge', () => {
    act(() => {
      root.render(
        <WatchedRunCarryRecorder
          knownPipelineRuns={{}}
          ownerUserMessageId="turn-1"
          chatTarget={mockDestination}
        />,
      );
    });

    expect(mockRecordCarry).toHaveBeenCalledWith(mockDestination, 'turn-1', [
      expect.objectContaining({ executionId: 'exec-external' }),
    ]);
    expect(mockRetainBridge).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    expect(mockRelease).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });

  it('persists a watched GitHub workflow run', () => {
    mockWatcherState.watchers = [mockGitHubWatcher];
    act(() => {
      root.render(
        <WatchedRunCarryRecorder
          knownPipelineRuns={{}}
          ownerUserMessageId="turn-1"
          chatTarget={mockDestination}
        />,
      );
    });

    expect(mockRecordCarry).toHaveBeenCalledWith(mockDestination, 'turn-1', [
      expect.objectContaining({
        kind: 'github_workflow_run',
        watcherId: 'gh-watch-1',
        runId: '101',
        jobs: [expect.objectContaining({ jobId: '501' })],
      }),
    ]);
  });

  it('does not persist a watched run this chat launched', () => {
    mockWatcherState.watchers = [mockPinnedWatcher, mockWatcher];
    act(() => {
      root.render(
        <WatchedRunCarryRecorder
          knownPipelineRuns={{ 'exec-chat': mockChatRunReceipt }}
          ownerUserMessageId="turn-1"
          chatTarget={mockDestination}
        />,
      );
    });

    expect(mockRecordCarry).toHaveBeenCalledWith(mockDestination, 'turn-1', [
      expect.objectContaining({ executionId: 'exec-external' }),
    ]);
    expect(mockRecordCarry).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ executionId: 'exec-chat' }),
      ]),
    );
  });

  it('keeps persisting a run this chat only watched through a tool', () => {
    mockWatcherState.watchers = [mockPinnedWatcher];
    act(() => {
      root.render(
        <WatchedRunCarryRecorder
          knownPipelineRuns={{
            'exec-chat': { ...mockChatRunReceipt, operation: 'pipeline.watch' },
          }}
          ownerUserMessageId="turn-1"
          chatTarget={mockDestination}
        />,
      );
    });

    expect(mockRecordCarry).toHaveBeenCalledWith(mockDestination, 'turn-1', [
      expect.objectContaining({ executionId: 'exec-chat' }),
    ]);
  });

  it('persists nothing when every watched run was launched by this chat', () => {
    mockWatcherState.watchers = [mockPinnedWatcher];
    act(() => {
      root.render(
        <WatchedRunCarryRecorder
          knownPipelineRuns={{ 'exec-chat': mockChatRunReceipt }}
          ownerUserMessageId="turn-1"
          chatTarget={mockDestination}
        />,
      );
    });

    expect(mockRecordCarry).not.toHaveBeenCalled();
  });
});
