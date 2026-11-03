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
jest.mock('../PipelineReportMarkdown', () => ({
  PipelineReportMarkdown: (): JSX.Element => (
    <button type="button" data-testid="report-body-link">
      Report link
    </button>
  ),
}));
jest.mock('../../pipeline/flow/PipelineFlowDiagram', () => ({
  PipelineFlowDiagram: (): null => null,
}));
jest.mock('@/lib/app-actions/dispatcher', () => ({
  dispatchAppAction: jest.fn(),
}));

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ExecutionState } from '@canopy/desktop-shared/types/pipeline';
import { resetPipelineDetailLeasesForTests } from '@/lib/pipelineDetailLeases';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { resetStepLogStoreForTests } from '@/stores/pipelineStepLogStore';
import { PipelineExecutionDetailModal } from '../PipelineExecutionDetailModal';

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

// An ownerless finished run with a report: no `project_id`/`worktree_id`,
// the shape the app-level compat host opens as a page dialog.
const FINISHED_RUN: ExecutionState = {
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
  status: 'failure',
  jobs: {
    build: {
      status: 'failure',
      steps: {
        compile: {
          status: 'failure',
          outputs: {},
          dynamic_env: {},
          started_at: STARTED_AT,
        },
      },
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
  report_outputs: { report_file: '/repo/report.md' },
};

function byTestId(testId: string): HTMLElement {
  const element = document.body.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing ${testId}`);
  return element;
}

describe('PipelineExecutionDetailModal stacked dialogs', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
          .mockResolvedValue({ success: true, data: FINISHED_RUN }),
        readStepLog: jest
          .fn()
          .mockResolvedValue({ success: true, data: { lines: [] } }),
        runAdvisor: jest.fn(),
        readReportFile: jest.fn().mockResolvedValue({
          success: true,
          data: { content: 'report' },
        }),
      },
    });
    usePipelineRunsStore.setState({
      summaries: [],
      statesById: { 'exec-1': FINISHED_RUN },
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

  it('keeps Tab in a report opened over an action-less run page', async () => {
    await act(async () => {
      root.render(
        <PipelineExecutionDetailModal
          executionId="exec-1"
          detailOwner={null}
          onClose={() => undefined}
        />,
      );
      await flushAsyncWork();
    });
    await act(async () => {
      byTestId('pipeline-detail-view-report-exec-1').click();
      await flushAsyncWork();
    });

    const report = byTestId('pipeline-report-modal-exec-1');
    const page = byTestId('pipeline-details-nav').closest<HTMLElement>(
      '[role="dialog"]',
    );
    if (page === null) throw new Error('Missing the run page dialog');
    expect(page.contains(report)).toBe(false);
    // The run page shows the report inline too; take the stacked dialog's.
    const link = report.querySelector<HTMLElement>(
      '[data-testid="report-body-link"]',
    );
    if (link === null) throw new Error('Missing the report body');
    const pageClose = page.querySelector<HTMLButtonElement>(
      'button[aria-label="Close"]',
    );
    if (pageClose === null) throw new Error('Missing the page Close button');
    const pageFocus = jest.spyOn(pageClose, 'focus');

    link.focus();
    const tab = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      link.dispatchEvent(tab);
    });

    expect(tab.defaultPrevented).toBe(false);
    expect(pageFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(link);
  });
});
