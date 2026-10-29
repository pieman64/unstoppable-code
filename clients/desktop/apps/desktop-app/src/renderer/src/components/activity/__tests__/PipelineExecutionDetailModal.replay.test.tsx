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

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import type {
  ExecutionState,
  ExecutionSummary,
} from '@canopy/desktop-shared/types/pipeline';
import { PipelineExecutionDetailModal } from '../PipelineExecutionDetailModal';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: {},
});

const summary: ExecutionSummary = {
  id: 'execution-1',
  pipeline_id: 'pipeline-1',
  pipeline_name: 'Private pipeline name',
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
    id: 'pipeline-1',
    name: 'Private pipeline name',
    jobs: {},
  },
  status: 'success',
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
  event_name: 'manual',
  project_id: 'project',
  worktree_id: 'worktree',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
    summaries: [summary],
    statesById: { 'execution-1': state },
    advisorSnapshotsByExecutionId: {},
    stepOutputBuffer: {},
    loadExecutionDetails: jest.fn<Promise<ExecutionState | null>, [string]>(
      () => Promise.resolve(state),
    ),
    handleAdvisorEvent: jest.fn(),
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

describe('PipelineExecutionDetailModal session-replay privacy', () => {
  it('records the modal frame and the detail body', () => {
    act(() => {
      root.render(
        createElement(PipelineExecutionDetailModal, {
          executionId: 'execution-1',
          onClose: jest.fn(),
        }),
      );
    });

    const card = container.querySelector('[role="dialog"]');
    const title = card?.querySelector('h2');
    expect(title).toBeTruthy();
    expect(card?.getAttribute('aria-labelledby')).toBe(title?.id);
    expect(card?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    expect(
      card
        ?.querySelector('[data-testid="pipeline-execution-detail"]')
        ?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS),
    ).toBe(false);
  });
});
