/**
 * @jest-environment jsdom
 */
jest.mock('../AnsiOutput', () => ({
  AnsiOutput: ({ lines }: { lines: string[] }): JSX.Element => (
    <div data-testid="ansi-lines">{lines.join('|')}</div>
  ),
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
jest.mock('@/lib/app-actions/dispatcher', () => ({
  dispatchAppAction: jest.fn(),
}));

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DialogModal } from '@canopy/ui-shared/components';
import type {
  ExecutionState,
  IPCResult,
  NormalizedStep,
  StepLogReadResult,
  StepResult,
} from '@canopy/desktop-shared/types/pipeline';
import { resetPipelineDetailLeasesForTests } from '@/lib/pipelineDetailLeases';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { resetStepLogStoreForTests } from '@/stores/pipelineStepLogStore';
import { PipelineExecutionDetailModal } from '../PipelineExecutionDetailModal';
import { createFakePipelineExecutionActions } from './fakePipelineExecutionActions';

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

const STARTED_AT = '2026-05-19T00:00:00.000Z';
const LOG_FILE = '/data/pipeline-executions/exec-1/logs/build--compile.log';

const COMPILE_STEP: NormalizedStep = {
  id: 'compile',
  name: 'Compile',
  run: 'npm run build',
  shell: 'bash',
  continue_on_error: false,
  timeout_minutes: 30,
  skip_on_missing_action: false,
};

function stepResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    status: 'running',
    outputs: {},
    dynamic_env: {},
    started_at: STARTED_AT,
    log_file: LOG_FILE,
    ...overrides,
  };
}

function executionState(
  overrides: Partial<ExecutionState> = {},
  steps: NormalizedStep[] = [COMPILE_STEP],
  stepResults: Record<string, StepResult> = { compile: stepResult() },
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
          steps,
        },
      },
    },
    status: 'running',
    jobs: {
      build: {
        status: 'running',
        steps: stepResults,
        outputs: {},
        started_at: STARTED_AT,
        iteration_count: 1,
      },
    },
    job_definitions: {},
    job_groups: {},
    pending_pauses: [],
    status_reasons: [],
    started_at: STARTED_AT,
    cwd: '/repo',
    env: {},
    inputs: {},
    event_name: 'dispatch',
    project_id: 'project',
    worktree_id: 'worktree',
    ...overrides,
  };
}

const getExecution = jest.fn<Promise<IPCResult<ExecutionState>>, [string]>();
const readStepLog = jest.fn<
  Promise<IPCResult<StepLogReadResult>>,
  [unknown, unknown]
>();

function byTestId(root: ParentNode, testId: string): HTMLElement | null {
  return root.querySelector(`[data-testid="${testId}"]`);
}

async function click(element: Element | null): Promise<void> {
  expect(element).toBeInstanceOf(HTMLElement);
  await act(async () => {
    element?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await flushAsyncWork();
  });
}

async function pressEscape(target: EventTarget): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    await flushAsyncWork();
  });
}

describe('PipelineExecutionDetailModal chrome', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function render(node: JSX.Element): Promise<void> {
    await act(async () => {
      root.render(node);
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
        archivedContainers: {
          listExecutions: jest.fn().mockResolvedValue({ executions: [] }),
          readExecution: jest.fn().mockResolvedValue(executionState()),
          readExecutionStepLog: jest.fn().mockResolvedValue({ lines: [] }),
          readExecutionReport: jest.fn(),
        },
      },
    });
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: {
        getExecution,
        readStepLog,
        runAdvisor: jest.fn(),
        readReportFile: jest.fn().mockResolvedValue({
          success: true,
          data: { content: 'report' },
        }),
      },
    });
    getExecution.mockResolvedValue({ success: true, data: executionState() });
    readStepLog.mockResolvedValue({ success: true, data: { lines: [] } });
    usePipelineRunsStore.setState({
      summaries: [],
      statesById: { 'exec-1': executionState() },
      advisorSnapshotsByExecutionId: {},
    });
    useCurrentUiStateStore.setState({ revision: 0, slices: {} });
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

  it('closes on an unhandled Escape', async () => {
    const onClose = jest.fn();
    await render(
      <PipelineExecutionDetailModal executionId="exec-1" onClose={onClose} />,
    );
    await pressEscape(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open when the log search already handled Escape', async () => {
    const onClose = jest.fn();
    await render(
      <PipelineExecutionDetailModal
        executionId="exec-1"
        initialJobId="build"
        onClose={onClose}
      />,
    );
    const searchInput = byTestId(
      container,
      'pipeline-step-detail-compile',
    )?.querySelector('input');
    expect(searchInput).toBeInstanceOf(HTMLInputElement);
    await pressEscape(searchInput ?? document.body);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays open when an earlier listener prevented Escape', async () => {
    const onClose = jest.fn();
    await render(
      <PipelineExecutionDetailModal executionId="exec-1" onClose={onClose} />,
    );
    const prevent = (event: KeyboardEvent): void => event.preventDefault();
    document.addEventListener('keydown', prevent, true);
    try {
      await pressEscape(document.body);
    } finally {
      document.removeEventListener('keydown', prevent, true);
    }
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves Escape to a nested dialog that owns it', async () => {
    const onClose = jest.fn();
    const onDialogClose = jest.fn();
    await render(
      <>
        <PipelineExecutionDetailModal executionId="exec-1" onClose={onClose} />
        <DialogModal onClose={onDialogClose} title="Watchers">
          <div />
        </DialogModal>
      </>,
    );
    await pressEscape(document.body);
    expect(onDialogClose).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('scopes its title id per instance', async () => {
    await render(
      <>
        <PipelineExecutionDetailModal
          executionId="exec-1"
          onClose={jest.fn()}
        />
        <PipelineExecutionDetailModal
          executionId="exec-1"
          onClose={jest.fn()}
        />
      </>,
    );
    const dialogs = Array.from(container.querySelectorAll('[role="dialog"]'));
    expect(dialogs).toHaveLength(2);
    const labelIds = dialogs.map((dialog) =>
      dialog.getAttribute('aria-labelledby'),
    );
    expect(new Set(labelIds).size).toBe(2);
    dialogs.forEach((dialog, index) => {
      const title = dialog.querySelector(`[id="${labelIds[index] ?? ''}"]`);
      expect(title?.textContent).toContain('Build pipeline');
    });
    expect(
      container.querySelector('#pipeline-execution-detail-title'),
    ).toBeNull();
  });

  it('only the reporting modal clears the detail-modal UI state key', async () => {
    const key = 'pipelineRuns.detailModal';
    const tree = (extras: JSX.Element): JSX.Element => (
      <>
        <PipelineExecutionDetailModal
          executionId="exec-1"
          onClose={jest.fn()}
        />
        {extras}
      </>
    );
    await render(
      tree(
        <>
          <PipelineExecutionDetailModal
            executionId="exec-1"
            onClose={jest.fn()}
            archivedSource={{ projectId: 'ws-1', containerId: 'c-1' }}
          />
        </>,
      ),
    );
    expect(useCurrentUiStateStore.getState().slices[key]).toMatchObject({
      executionId: 'exec-1',
    });

    // The archived modal goes away.
    await render(tree(<></>));
    expect(useCurrentUiStateStore.getState().slices[key]).toMatchObject({
      executionId: 'exec-1',
    });

    await render(<></>);
    expect(useCurrentUiStateStore.getState().slices[key]).toBeUndefined();
  });

  it('closes to reveal another surface, except for a report chat follow-up', async () => {
    usePipelineRunsStore.setState({
      statesById: {
        'exec-1': executionState({
          status: 'failure',
          report_outputs: { report_file: '/repo/report.md' },
        }),
      },
    });
    const onClose = jest.fn();
    const actions = createFakePipelineExecutionActions();
    await render(
      <PipelineExecutionDetailModal
        executionId="exec-1"
        onClose={onClose}
        actions={actions}
      />,
    );

    await click(
      byTestId(container, 'pipeline-detail-report-chat-follow-up-exec-1'),
    );
    expect(actions.reportChatFollowUp).toHaveBeenCalledWith('exec-1');
    expect(onClose).not.toHaveBeenCalled();

    await click(byTestId(container, 'pipeline-detail-view-report-exec-1'));
    expect(actions.openReport).toHaveBeenCalledWith('exec-1');
    expect(onClose).toHaveBeenCalledTimes(1);

    await click(byTestId(container, 'pipeline-details-open-definition'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps an action-less modal open for dialogs it hosts itself', async () => {
    usePipelineRunsStore.setState({
      statesById: {
        'exec-1': executionState({
          status: 'failure',
          report_outputs: { report_file: '/repo/report.md' },
        }),
      },
    });
    const onClose = jest.fn();
    await render(
      <PipelineExecutionDetailModal executionId="exec-1" onClose={onClose} />,
    );
    await click(byTestId(container, 'pipeline-detail-view-report-exec-1'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
