/**
 * @jest-environment jsdom
 */
jest.mock('../AnsiOutput', () => ({
  AnsiOutput: ({ lines }: { lines: string[] }): JSX.Element => (
    <div data-testid="ansi-lines">{lines.join('|')}</div>
  ),
}));
jest.mock('../../chat/TranscriptViewer', () => ({
  TranscriptViewer: ({ lines }: { lines: string[] }): JSX.Element => (
    <div data-testid="transcript-lines">{lines.join('|')}</div>
  ),
}));
jest.mock('../PipelineAdvisorMarkdown', () => ({
  PipelineAdvisorMarkdownText: (): null => null,
}));
jest.mock('../PipelineReportModal', () => ({
  PipelineReportModal: (): null => null,
}));
jest.mock('../PipelineReportMarkdown', () => ({
  PipelineReportMarkdown: (): null => null,
}));
jest.mock('../../pipeline/flow/PipelineFlowDiagram', () => ({
  PipelineFlowDiagram: (): null => null,
}));
jest.mock('@/lib/app-actions/dispatcher', () => ({
  dispatchAppAction: jest.fn(),
}));
jest.mock('@/lib/pipelineAttemptTimeline', () => {
  const actual = jest.requireActual<typeof AttemptTimelineModule>(
    '@/lib/pipelineAttemptTimeline',
  );
  return {
    ...actual,
    buildAttemptViews: jest.fn(actual.buildAttemptViews),
  };
});
jest.mock('@/lib/pipelineTranscriptAvailability', () => ({
  ...jest.requireActual<typeof TranscriptAvailabilityModule>(
    '@/lib/pipelineTranscriptAvailability',
  ),
  hasRenderableTranscriptPrefix: jest.fn(() => false),
}));

import { act, type JSX } from 'react';
import type * as AttemptTimelineModule from '@/lib/pipelineAttemptTimeline';
import type * as TranscriptAvailabilityModule from '@/lib/pipelineTranscriptAvailability';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ExecutionState,
  ExecutionSummary,
  IPCResult,
  StepLogReadResult,
  StepResult,
} from '@canopy/desktop-shared/types/pipeline';
import { buildAttemptViews } from '@/lib/pipelineAttemptTimeline';
import { hasRenderableTranscriptPrefix } from '@/lib/pipelineTranscriptAvailability';
import {
  getPipelineDetailLeaseCount,
  resetPipelineDetailLeasesForTests,
} from '@/lib/pipelineDetailLeases';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import {
  getStepLogInterestCount,
  resetStepLogStoreForTests,
  routeStepOutputEvents,
} from '@/stores/pipelineStepLogStore';
import { PipelineExecutionDetailModal } from '../PipelineExecutionDetailModal';
import { PipelineStepDetail } from '../details/PipelineStepDetail';
import { PipelineExecutionInlineDetail } from '../details/PipelineExecutionInlineDetail';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: {},
});

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const LOG_FILE = '/data/pipeline-executions/exec-1/logs/build--compile.log';

function stepResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    status: 'running',
    outputs: {},
    dynamic_env: {},
    started_at: '2026-05-19T00:00:00.000Z',
    log_file: LOG_FILE,
    ...overrides,
  };
}

function executionState(
  overrides: Partial<ExecutionState> = {},
): ExecutionState {
  return {
    version: 8,
    id: 'exec-1',
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: {
      name: 'Build pipeline',
      scope: ['directory'],
      jobs: {
        build: {
          name: 'Build',
          needs: [],
          timeout_minutes: 60,
          max_retries: 0,
          continue_on_error: false,
          steps: [
            {
              id: 'compile',
              name: 'Compile',
              run: 'npm run build',
              shell: 'bash',
              continue_on_error: false,
              timeout_minutes: 30,
              skip_on_missing_action: false,
            },
          ],
        },
      },
    },
    status: 'running',
    jobs: {
      build: {
        status: 'running',
        steps: { compile: stepResult() },
        outputs: {},
        started_at: '2026-05-19T00:00:00.000Z',
        iteration_count: 1,
      },
    },
    job_definitions: {},
    job_groups: {},
    pending_pauses: [],
    status_reasons: [],
    started_at: '2026-05-19T00:00:00.000Z',
    cwd: '/repo',
    env: {},
    inputs: {},
    event_name: 'dispatch',
    project_id: 'project',
    worktree_id: 'other-worktree',
    ...overrides,
  };
}

const getExecution = jest.fn<Promise<IPCResult<ExecutionState>>, [string]>();
const readStepLog = jest.fn<
  Promise<IPCResult<StepLogReadResult>>,
  [unknown, unknown]
>();

describe('PipelineExecutionDetailModal detail data lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    resetPipelineDetailLeasesForTests();
    resetStepLogStoreForTests();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: jest.fn().mockResolvedValue({}),
        savePreferences: jest.fn().mockResolvedValue(undefined),
      },
    });
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: {
        getExecution,
        readStepLog,
        runAdvisor: jest.fn(),
        readReportFile: jest.fn(),
      },
    });
    getExecution.mockResolvedValue({ success: true, data: executionState() });
    readStepLog.mockResolvedValue({
      success: true,
      data: { lines: ['persisted line'] },
    });
    usePipelineRunsStore.setState({
      currentCwd: '/repo',
      currentProjectId: 'project',
      currentWorktreeId: 'worktree',
      summaries: [],
      statesById: {},
      advisorSnapshotsByExecutionId: {},
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('leases its execution while open, even outside the selected scope, and evicts it on close', async () => {
    await act(async () => {
      root.render(
        <PipelineExecutionDetailModal
          executionId="exec-1"
          onClose={jest.fn()}
        />,
      );
      await flushAsyncWork();
    });

    expect(getExecution).toHaveBeenCalledTimes(1);
    expect(getPipelineDetailLeaseCount('exec-1')).toBe(1);
    expect(document.body.textContent).toContain('Build pipeline');

    // An out-of-scope event for the leased run reaches the open detail.
    await act(async () => {
      usePipelineRunsStore.getState().handleExecutionEvent({
        type: 'execution.completed',
        executionId: 'exec-1',
        state: executionState({ status: 'success' }),
        timestamp: '2026-05-19T00:02:00.000Z',
      });
      await flushAsyncWork();
    });
    expect(usePipelineRunsStore.getState().statesById['exec-1']?.status).toBe(
      'success',
    );

    await act(async () => {
      root.render(<></>);
      await flushAsyncWork();
    });
    expect(getPipelineDetailLeaseCount('exec-1')).toBe(0);
    expect(
      usePipelineRunsStore.getState().statesById['exec-1'],
    ).toBeUndefined();
  });

  it('keeps a row projection, not full detail, when the selected run remains listed', async () => {
    const listed: ExecutionSummary = {
      id: 'exec-1',
      pipeline_id: 'pipeline-1',
      pipeline_name: 'Build pipeline',
      status: 'running',
      status_reasons: [],
      started_at: '2026-05-19T00:00:00.000Z',
      cwd: '/repo',
      project_id: 'project',
      worktree_id: 'worktree',
    };
    usePipelineRunsStore.setState({ summaries: [listed] });
    await act(async () => {
      root.render(
        <PipelineExecutionDetailModal
          executionId="exec-1"
          onClose={jest.fn()}
        />,
      );
      await flushAsyncWork();
    });
    await act(async () => {
      root.render(<></>);
      await flushAsyncWork();
    });

    expect(
      usePipelineRunsStore.getState().statesById['exec-1'],
    ).toBeUndefined();
    expect(
      usePipelineRunsStore.getState().rowStatesById['exec-1'],
    ).toBeDefined();
  });

  it('shows the load failure when the snapshot read fails', async () => {
    getExecution.mockResolvedValue({ success: false, error: 'missing' });
    await act(async () => {
      root.render(
        <PipelineExecutionDetailModal
          executionId="exec-1"
          onClose={jest.fn()}
        />,
      );
      await flushAsyncWork();
    });

    expect(document.body.textContent).toContain(
      'Failed to load execution details.',
    );
  });

  it('does not build the inline accordion in full-modal mode', async () => {
    usePipelineRunsStore.setState({
      statesById: { 'exec-1': executionState() },
    });
    await act(async () => {
      root.render(
        <PipelineExecutionDetailModal
          executionId="exec-1"
          onClose={jest.fn()}
        />,
      );
      await flushAsyncWork();
    });
    expect(buildAttemptViews).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        <PipelineExecutionInlineDetail executionId="exec-1" owner={null} />,
      );
      await flushAsyncWork();
    });
    expect(buildAttemptViews).toHaveBeenCalled();
  });

  it('the inline step detail does the final authoritative read when a pending step settles', async () => {
    const withStep = (status: StepResult['status']): ExecutionState =>
      executionState({
        jobs: {
          build: {
            status: status === 'pending' ? 'running' : status,
            steps: { compile: stepResult({ status }) },
            outputs: {},
            started_at: '2026-05-19T00:00:00.000Z',
            iteration_count: 1,
          },
        },
      });
    usePipelineRunsStore.setState({
      statesById: { 'exec-1': withStep('pending') },
    });
    await act(async () => {
      root.render(
        <PipelineExecutionInlineDetail executionId="exec-1" owner={null} />,
      );
      await flushAsyncWork();
    });
    const stepButton = Array.from(
      document.body.querySelectorAll('button'),
    ).find((button) => button.textContent?.includes('Compile'));
    await act(async () => {
      stepButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushAsyncWork();
    });
    expect(readStepLog).toHaveBeenCalledTimes(1);

    // The step settles without ever being observed running.
    await act(async () => {
      usePipelineRunsStore.setState({
        statesById: { 'exec-1': withStep('success') },
      });
      await flushAsyncWork();
    });

    expect(readStepLog).toHaveBeenCalledTimes(2);
  });

  it('a step detail holds one log interest, follows only its own output, and releases it on unmount', async () => {
    const state = executionState();
    await act(async () => {
      root.render(
        <PipelineStepDetail
          executionId="exec-1"
          jobId="build"
          stepDef={state.pipeline_snapshot.jobs.build.steps[0]}
          stepResult={stepResult()}
          attempt={0}
          iteration={1}
          source="current"
        />,
      );
      await flushAsyncWork();
    });

    expect(readStepLog).toHaveBeenCalledTimes(1);
    expect(readStepLog).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: 'exec-1',
        jobId: 'build',
        stepId: 'compile',
        attempt: 0,
        logFilePath: LOG_FILE,
      }),
      { format: 'text' },
    );
    expect(getStepLogInterestCount()).toBe(1);

    await act(async () => {
      routeStepOutputEvents([
        {
          executionId: 'exec-1',
          jobId: 'build',
          jobName: 'Build',
          stepId: 'compile',
          stepName: 'Compile',
          attempt: 0,
          stream: 'stdout',
          data: 'live line\n',
        },
        {
          executionId: 'exec-2',
          jobId: 'build',
          jobName: 'Build',
          stepId: 'compile',
          stepName: 'Compile',
          attempt: 0,
          stream: 'stdout',
          data: 'other run\n',
        },
      ]);
      await flushAsyncWork();
    });
    expect(
      document.body.querySelector('[data-testid="ansi-lines"]')?.textContent,
    ).toBe('persisted line|live line');

    await act(async () => {
      root.render(<></>);
      await flushAsyncWork();
    });
    expect(getStepLogInterestCount()).toBe(0);
  });

  it('reads a plain step once and never probes it for a transcript', async () => {
    const state = executionState();
    await act(async () => {
      root.render(
        <PipelineStepDetail
          executionId="exec-1"
          jobId="build"
          stepDef={state.pipeline_snapshot.jobs.build.steps[0]}
          stepResult={stepResult({ status: 'success' })}
          attempt={0}
          iteration={1}
          source="current"
        />,
      );
      await flushAsyncWork();
    });

    expect(readStepLog).toHaveBeenCalledTimes(1);
    expect(hasRenderableTranscriptPrefix).not.toHaveBeenCalled();
    expect(
      document.body.querySelector('[data-testid="transcript-lines"]'),
    ).toBe(null);
  });

  it('serves an agent step plain and rich views from one read and parses only when rich is shown', async () => {
    jest.mocked(hasRenderableTranscriptPrefix).mockReturnValue(true);
    readStepLog.mockResolvedValue({
      success: true,
      data: { lines: ['{"type":"assistant"}'] },
    });
    const state = executionState();
    await act(async () => {
      root.render(
        <PipelineStepDetail
          executionId="exec-1"
          jobId="build"
          stepDef={state.pipeline_snapshot.jobs.build.steps[0]}
          stepResult={stepResult({
            status: 'success',
            log_format_hint: 'agent',
          })}
          attempt={0}
          iteration={1}
          source="current"
        />,
      );
      await flushAsyncWork();
    });

    // One file backs both views: one read, one interest.
    expect(readStepLog).toHaveBeenCalledTimes(1);
    expect(getStepLogInterestCount()).toBe(1);
    // The probe found a message, so the rich view is the default and the
    // transcript lines go to the (single) viewer parse.
    expect(hasRenderableTranscriptPrefix).toHaveBeenCalledTimes(1);
    expect(
      document.body.querySelector('[data-testid="transcript-lines"]')
        ?.textContent,
    ).toBe('{"type":"assistant"}');

    const rawButton = document.body.querySelector(
      '[data-testid="pipeline-step-log-mode-raw-compile"]',
    );
    await act(async () => {
      rawButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushAsyncWork();
    });
    expect(
      document.body.querySelector('[data-testid="transcript-lines"]'),
    ).toBe(null);
    expect(hasRenderableTranscriptPrefix).toHaveBeenCalledTimes(1);
  });
});
