/**
 * @jest-environment jsdom
 */
jest.mock('../AnsiOutput', () => ({
  AnsiOutput: (): null => null,
}));
jest.mock('../../chat/TranscriptViewer', () => ({
  TranscriptViewer: (): null => null,
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
jest.mock('../RunOutputControls', () => ({
  ChevronIcon: (): null => null,
}));
jest.mock('@/lib/app-actions/dispatcher', () => ({
  dispatchAppAction: jest.fn(),
}));
jest.mock('@/lib/panels/open-pipeline-execution', () => ({
  openPipelineExecutionFromUi: jest.fn(() =>
    Promise.resolve({ status: 'applied' }),
  ),
}));

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ExecutionState,
  ExecutionSummary,
  NormalizedJob,
} from '@canopy/desktop-shared/types/pipeline';
import { resetPipelineDetailLeasesForTests } from '@/lib/pipelineDetailLeases';
import { openPipelineExecutionFromUi } from '@/lib/panels/open-pipeline-execution';
import { useChatStore } from '@/stores/chatStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { resetStepLogStoreForTests } from '@/stores/pipelineStepLogStore';
import { PipelineRunsSection } from '../PipelineRunsSection';

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

function job(name: string): NormalizedJob {
  return {
    name,
    needs: [],
    timeout_minutes: 60,
    max_retries: 0,
    continue_on_error: false,
    steps: [
      {
        id: `${name.toLowerCase()}-step`,
        name: `${name} step`,
        run: 'true',
        shell: 'bash',
        continue_on_error: false,
        timeout_minutes: 30,
        skip_on_missing_action: false,
      },
    ],
  };
}

const summary: ExecutionSummary = {
  id: 'execution-1',
  pipeline_id: 'pipeline-1',
  pipeline_name: 'Build pipeline',
  status: 'success',
  started_at: '2026-05-19T00:00:00.000Z',
  completed_at: '2026-05-19T00:01:00.000Z',
  cwd: '/repo',
  event_name: 'manual',
  project_id: 'project',
  worktree_id: 'worktree',
};

const state: ExecutionState = {
  version: 8,
  id: 'execution-1',
  pipeline_id: 'pipeline-1',
  pipeline_snapshot: {
    name: 'Build pipeline',
    jobs: { build: job('Build'), deploy: job('Deploy') },
  },
  status: 'success',
  jobs: {
    build: { status: 'success', steps: {}, outputs: {} },
    deploy: { status: 'success', steps: {}, outputs: {} },
  },
  job_definitions: {},
  job_groups: {},
  pending_pauses: [],
  status_reasons: [],
  started_at: '2026-05-19T00:00:00.000Z',
  completed_at: '2026-05-19T00:01:00.000Z',
  cwd: '/repo',
  env: {},
  inputs: {},
  event_name: 'manual',
  project_id: 'project',
  worktree_id: 'worktree',
};

const openRun = jest.mocked(openPipelineExecutionFromUi);

describe('PipelineRunsSection detail links', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function click(element: Element | null): Promise<void> {
    expect(element).not.toBeNull();
    await act(async () => {
      element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushAsyncWork();
    });
  }

  async function renderSection(): Promise<void> {
    await act(async () => {
      root.render(<PipelineRunsSection onDispatchPipeline={jest.fn()} />);
      await flushAsyncWork();
    });
  }

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
        getExecution: jest
          .fn()
          .mockResolvedValue({ success: true, data: state }),
        readStepLog: jest
          .fn()
          .mockResolvedValue({ success: true, data: { lines: [] } }),
        runAdvisor: jest.fn(),
        readReportFile: jest.fn(),
      },
    });
    useChatStore.setState({
      // The selection is deliberately another worktree: links take their
      // owner from the listed run, never from the selection.
      selectedWorktree: { projectId: 'project', worktreeId: 'selected' },
    });
    usePipelineRunsStore.setState({
      summaries: [
        summary,
        {
          ...summary,
          id: 'execution-2',
          pipeline_name: 'Rerun pipeline',
          rerun_source_id: 'execution-1',
        },
      ],
      statesById: { 'execution-1': state },
      advisorSnapshotsByExecutionId: {},
      pendingExecutions: {},
      failedPendingExecutions: {},
      queuedExecutionsByWorktree: {},
      failedQueuedExecutionsByWorktree: {},
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

  it("opens a run's panel through the opener with the run's own owner", async () => {
    await renderSection();

    await click(
      container.querySelector('[data-testid="pipeline-run-card-execution-1"]'),
    );

    expect(openRun).toHaveBeenCalledWith({
      executionId: 'execution-1',
      owner: { projectId: 'project', worktreeId: 'worktree' },
      target: { viewStack: [] },
    });
    // The section hosts no takeover detail of its own any more.
    expect(
      document.body.querySelector('[data-testid="pipeline-details-nav"]'),
    ).toBeNull();
  });

  it('opens a job link at that job', async () => {
    await renderSection();

    await click(
      container.querySelector(
        '[data-testid="pipeline-run-card-execution-1"] [data-job-id="deploy"]',
      ),
    );

    expect(openRun).toHaveBeenLastCalledWith({
      executionId: 'execution-1',
      owner: { projectId: 'project', worktreeId: 'worktree' },
      target: { viewStack: [], jobId: 'deploy' },
    });
  });

  it('opens the rerun source run through the opener', async () => {
    await renderSection();

    const sourceLink = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="pipeline-run-card-execution-2"] button',
      ),
    ).find((button) => button.textContent?.includes('Started over from'));
    await click(sourceLink ?? null);

    expect(openRun).toHaveBeenLastCalledWith({
      executionId: 'execution-1',
      owner: { projectId: 'project', worktreeId: 'worktree' },
      target: { viewStack: [] },
    });
  });
});
