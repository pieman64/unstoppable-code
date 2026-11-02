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
jest.mock('@/lib/app-actions/dispatcher', () => ({
  dispatchAppAction: jest.fn(),
}));

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import type {
  ExecutionState,
  ExecutionSummary,
} from '@canopy/desktop-shared/types/pipeline';
import { PipelineExecutionDetailModal } from '../PipelineExecutionDetailModal';
import { createFakePipelineExecutionActions } from './fakePipelineExecutionActions';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: {},
});

const failedSummary: ExecutionSummary = {
  id: 'execution-1',
  pipeline_id: 'pipeline-1',
  pipeline_name: 'Build pipeline',
  status: 'failure',
  status_reasons: [],
  started_at: '2026-05-19T00:00:00.000Z',
  completed_at: '2026-05-19T00:01:00.000Z',
  cwd: '/repo',
  event_name: 'dispatch',
  project_id: 'project',
  worktree_id: 'worktree',
};

const failedState: ExecutionState = {
  version: 8,
  id: 'execution-1',
  pipeline_id: 'pipeline-1',
  pipeline_snapshot: {
    name: 'Build pipeline',
    scope: ['directory'],
    jobs: {},
  },
  status: 'failure',
  jobs: {},
  job_definitions: {},
  job_groups: {},
  pending_pauses: [],
  status_reasons: [],
  started_at: '2026-05-19T00:00:00.000Z',
  completed_at: '2026-05-19T00:01:00.000Z',
  cwd: '/repo',
  env: {},
  inputs: {},
  event_name: 'dispatch',
  project_id: 'project',
  worktree_id: 'worktree',
};

describe('PipelineExecutionDetailModal Debug action', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
        runAdvisor: jest.fn(),
        readReportFile: jest.fn(),
        readStepLog: jest.fn(),
      },
    });
    usePipelineRunsStore.setState({
      summaries: [failedSummary],
      statesById: { 'execution-1': failedState },
      advisorSnapshotsByExecutionId: {},
      loadExecutionDetails: jest.fn<Promise<ExecutionState | null>, [string]>(
        () => Promise.resolve(failedState),
      ),
      handleAdvisorEvent: jest.fn(),
    });
  });

  it('closes before dispatching the failed-run App Advisor debug action', async () => {
    const onClose = jest.fn();
    const onDebugFailure = jest.fn<Promise<boolean>, [string]>(() =>
      Promise.resolve(true),
    );
    const actions = createFakePipelineExecutionActions({
      debugFailure: onDebugFailure,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      act(() => {
        root.render(
          createElement(PipelineExecutionDetailModal, {
            executionId: 'execution-1',
            onClose,
            actions,
          }),
        );
      });

      const debugButton = container.querySelector(
        '[data-testid="pipeline-detail-debug-failure-execution-1"]',
      );
      expect(debugButton).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        debugButton?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
        await Promise.resolve();
      });

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onDebugFailure).toHaveBeenCalledWith('execution-1');
      expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
        onDebugFailure.mock.invocationCallOrder[0],
      );
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });
});
