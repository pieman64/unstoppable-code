/** @jest-environment jsdom */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { buildPipelineRunArtifactReceipt } from '@canopy/desktop-shared/lib/agent-artifacts';
import type {
  AppAdvisorWatcherSummary,
  GitHubWorkflowRunArtifactReceiptV1,
  PipelineRunArtifactReceiptV1,
} from '@canopy/desktop-shared/types';

const mockPipelineState: {
  summaries: unknown[];
  statesById: Record<string, { status: string }>;
  rowStatesById: Record<string, { status: string }>;
} = { summaries: [], statesById: {}, rowStatesById: {} };

const mockWatcherState: {
  watchers: AppAdvisorWatcherSummary[];
  completedWatchers: AppAdvisorWatcherSummary[];
} = { watchers: [], completedWatchers: [] };

jest.mock('@/stores/appAdvisorWatchersStore', () => ({
  useAppAdvisorWatchersStore: (
    selector: (state: typeof mockWatcherState) => unknown,
  ): unknown => selector(mockWatcherState),
}));
jest.mock('@/stores/pipelineRunsStore', () => ({
  usePipelineRunsStore: (
    selector: (state: typeof mockPipelineState) => unknown,
  ): unknown => selector(mockPipelineState),
}));

import { useLiveAgentRunKeys } from '../useLiveAgentRunKeys';

const AT = '2026-10-22T12:00:00.000Z';
const target = { projectId: 'project', worktreeId: 'worktree', chatId: 'c' };

function watcher(
  status: AppAdvisorWatcherSummary['status'],
  observedAt: string,
  runState: GitHubWorkflowRunArtifactReceiptV1['state'],
): AppAdvisorWatcherSummary {
  return {
    id: 'gh-watch-1',
    trigger: 'github_workflow_runs_changed',
    status,
    label: 'CI',
    target: {
      kind: 'github_workflow_runs',
      items: [{ kind: 'workflow_run', repository: 'acme/api', runId: '101' }],
      notifyOn: { statuses: [], conclusions: [], jobConclusions: [] },
      display: {
        repositories: ['acme/api'],
        sample: [{ repository: 'acme/api', runId: '101', runAttempt: 1 }],
      },
    },
    destination: target,
    createdAt: '2026-10-22T15:41:48.571Z',
    githubProgress: {
      runs: [
        {
          repository: 'acme/api',
          runId: '101',
          runAttempt: 1,
          htmlUrl: 'https://github.com/acme/api/actions/runs/101',
          state: runState,
          observedAt,
        },
      ],
    },
  };
}

function run(
  operation: string,
  executionId: string,
): PipelineRunArtifactReceiptV1 {
  return buildPipelineRunArtifactReceipt({
    operation,
    createdAt: AT,
    executionId,
    pipelineId: 'pipe-1',
    pipelineName: 'Build',
    initialStatus: 'running',
    queuedAt: AT,
    projectId: 'project',
    worktreeId: 'worktree',
    navigationTarget: {
      kind: 'pipeline_execution',
      executionId,
      projectId: 'project',
      worktreeId: 'worktree',
    },
  });
}

function liveKeys(
  knownPipelineRuns: Record<string, PipelineRunArtifactReceiptV1>,
  chatPipelineRuns: readonly PipelineRunArtifactReceiptV1[],
): string[] {
  let keys: string[] = [];
  function Probe(): JSX.Element | null {
    keys = Array.from(
      useLiveAgentRunKeys(target, knownPipelineRuns, chatPipelineRuns),
    );
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return keys;
}

describe('useLiveAgentRunKeys', () => {
  afterEach(() => {
    mockWatcherState.watchers = [];
    mockWatcherState.completedWatchers = [];
    mockPipelineState.statesById = {};
    mockPipelineState.rowStatesById = {};
  });

  const finishedStates: GitHubWorkflowRunArtifactReceiptV1['state'][] = [
    { kind: 'terminal', conclusion: 'success' },
    {
      kind: 'unsupported',
      terminal: true,
      status: 'completed',
      conclusion: 'future_conclusion',
    },
  ];
  it.each(finishedStates)(
    'returns a watched GitHub run to its turn for newer %j history',
    (state) => {
      mockWatcherState.watchers = [
        watcher('active', AT, { kind: 'intermediate', status: 'in_progress' }),
      ];
      expect(liveKeys({}, [])).toHaveLength(1);
      mockWatcherState.completedWatchers = [
        watcher('firing', '2026-10-22T12:01:00.000Z', state),
      ];
      expect(liveKeys({}, [])).toEqual([]);
    },
  );

  // A watcher leaves the active list while it delivers an update (`firing`)
  // and returns once delivered; the run stayed live, so it must not fall
  // back to its turn's Agent activity for that window.
  it('keeps a GitHub run live while its watcher delivers an update', () => {
    mockWatcherState.completedWatchers = [
      watcher('firing', AT, { kind: 'intermediate', status: 'in_progress' }),
    ];
    expect(liveKeys({}, [])).toHaveLength(1);
  });

  it('keeps an unsupported nonterminal GitHub state live', () => {
    mockWatcherState.watchers = [
      watcher('active', AT, {
        kind: 'unsupported',
        terminal: false,
        status: 'future_running',
        conclusion: null,
      }),
    ];
    expect(liveKeys({}, [])).toHaveLength(1);
  });

  it('keeps a running launched run live and drops a finished one', () => {
    const running = run('pipeline.run', 'exec-1');
    const finished = run('pipeline.run', 'exec-2');
    mockPipelineState.statesById = {
      'exec-1': { status: 'running' },
      'exec-2': { status: 'success' },
    };
    expect(
      liveKeys({ 'exec-1': running, 'exec-2': finished }, [running, finished]),
    ).toEqual([running.dedupeKey]);
  });

  // Sol review on #6080: a run the chat shows only through carry, still
  // running after its watcher was deleted, lost its live status and moved
  // inline.
  it('keeps a still-running carried run live after its watcher is gone', () => {
    const carried = run('pipeline.watch', 'exec-3');
    mockPipelineState.statesById = { 'exec-3': { status: 'paused' } };
    expect(liveKeys({}, [carried])).toEqual([carried.dedupeKey]);
  });

  // Chat cards follow runs through row states only, so a finished run with no
  // summary or full state must not fall back to the receipt's launch status.
  it('reads a run row the way its card does', () => {
    const finished = run('pipeline.run', 'exec-4');
    const running = run('pipeline.run', 'exec-5');
    mockPipelineState.rowStatesById = {
      'exec-4': { status: 'success' },
      'exec-5': { status: 'running' },
    };
    expect(
      liveKeys({ 'exec-4': finished, 'exec-5': running }, [finished, running]),
    ).toEqual([running.dedupeKey]);
  });
});
