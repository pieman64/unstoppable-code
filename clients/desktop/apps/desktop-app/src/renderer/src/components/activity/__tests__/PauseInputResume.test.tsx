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

import { act, createElement, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ExecutionState,
  ExecutionSummary,
} from '@canopy/desktop-shared/types/pipeline';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { PauseInputPanel } from '../PauseInputPanel';
import { PipelineExecutionDetailModal } from '../PipelineExecutionDetailModal';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: {},
});

function render(node: JSX.Element): {
  container: HTMLDivElement;
  cleanup: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    cleanup: (): void => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function click(button: Element | null): Promise<void> {
  expect(button).toBeInstanceOf(HTMLButtonElement);
  await act(async () => {
    button?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

const pausedSummary: ExecutionSummary = {
  id: 'paused-execution',
  pipeline_id: 'pipeline-1',
  pipeline_name: 'Paused pipeline',
  status: 'paused',
  status_reasons: [],
  started_at: '2026-05-30T00:00:00.000Z',
  cwd: '/repo',
  event_name: 'dispatch',
  project_id: 'project',
  worktree_id: 'worktree',
};

const pausedState: ExecutionState = {
  version: 8,
  id: 'paused-execution',
  pipeline_id: 'pipeline-1',
  pipeline_snapshot: {
    name: 'Paused pipeline',
    scope: ['directory'],
    jobs: {
      gate: {
        name: 'Gate',
        needs: [],
        if: 'true',
        env: {},
        outputs: {},
        timeout_minutes: 60,
        max_retries: 0,
        continue_on_error: false,
        steps: [
          {
            id: 'ask',
            name: 'Ask',
            shell: 'bash',
            run: 'true',
            continue_on_error: false,
            timeout_minutes: 30,
            skip_on_missing_action: false,
          },
        ],
      },
    },
  },
  status: 'paused',
  jobs: {
    gate: {
      status: 'paused',
      steps: {
        ask: {
          status: 'success',
          outputs: {},
          dynamic_env: {},
          pause_requested: true,
          input_request: {
            fields: [
              {
                key: 'scope',
                label: 'Scope',
                type: 'string',
                required: true,
                default: 'desktop',
              },
            ],
          },
        },
      },
      outputs: {},
    },
  },
  job_definitions: {
    gate: {
      physical_job_id: 'gate',
      logical_job_id: 'gate',
      name: 'Gate',
      needs: [],
      if: 'true',
      env: {},
      outputs: {},
      timeout_minutes: 60,
      max_retries: 0,
      continue_on_error: false,
      steps: [
        {
          id: 'ask',
          name: 'Ask',
          shell: 'bash',
          run: 'true',
          continue_on_error: false,
          timeout_minutes: 30,
          skip_on_missing_action: false,
        },
      ],
    },
  },
  job_groups: {
    gate: {
      job_id: 'gate',
      kind: 'single',
      expansion: 'expanded',
      variant_job_ids: ['gate'],
      status: 'paused',
    },
  },
  pending_pauses: [
    {
      id: 'pause-1',
      kind: 'input',
      job_id: 'gate',
      logical_job_id: 'gate',
      step_id: 'ask',
      attempt: 0,
      iteration: 1,
      detected_at: '2026-05-30T00:00:00.000Z',
      request: {
        fields: [
          {
            key: 'scope',
            label: 'Scope',
            type: 'string',
            required: true,
            default: 'desktop',
          },
        ],
      },
    },
  ],
  status_reasons: [],
  started_at: '2026-05-30T00:00:00.000Z',
  cwd: '/repo',
  env: {},
  inputs: {},
  event_name: 'dispatch',
  project_id: 'project',
  worktree_id: 'worktree',
};

describe('paused pipeline resume controls', () => {
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
      summaries: [],
      statesById: {},
      advisorSnapshotsByExecutionId: {},
      loadExecutionDetails: jest.fn<Promise<ExecutionState | null>, [string]>(
        () => Promise.resolve(null),
      ),
      handleAdvisorEvent: jest.fn(),
    });
  });

  it('clears submitting and shows an error when structured resume rejects', async () => {
    const resumeExecution = jest
      .fn()
      .mockRejectedValue(new Error('IPC timeout'));
    usePipelineRunsStore.setState({ resumeExecution });
    const rendered = render(
      <PauseInputPanel executionId="paused-execution" state={pausedState} />,
    );

    try {
      const button = document.body.querySelector(
        '[data-testid="pause-input-resume"]',
      );

      await click(button);

      expect(resumeExecution).toHaveBeenCalledWith('paused-execution', {
        pauseResponses: [
          {
            checkpoint_id: 'pause-1',
            job_id: 'gate',
            step_id: 'ask',
            answers: { scope: 'desktop' },
          },
        ],
      });
      expect((button as HTMLButtonElement).disabled).toBe(false);
      expect(document.body.textContent).toContain('IPC timeout');
    } finally {
      rendered.cleanup();
    }
  });

  it('clears busy and shows an error when resume rejects', async () => {
    const resumeExecution = jest
      .fn()
      .mockRejectedValue(new Error('IPC timeout'));
    usePipelineRunsStore.setState({
      summaries: [pausedSummary],
      statesById: { 'paused-execution': pausedState },
      resumeExecution,
      loadExecutionDetails: jest.fn<Promise<ExecutionState | null>, [string]>(
        () => Promise.resolve(pausedState),
      ),
    });
    const rendered = render(
      createElement(PipelineExecutionDetailModal, {
        executionId: 'paused-execution',
        onClose: jest.fn(),
      }),
    );

    try {
      const button = document.body.querySelector(
        '[data-testid="pause-input-resume"]',
      );

      await click(button);

      expect(resumeExecution).toHaveBeenCalledWith('paused-execution', {
        pauseResponses: [
          {
            answers: { scope: 'desktop' },
            checkpoint_id: pausedState.pending_pauses[0].id,
            job_id: 'gate',
            step_id: 'ask',
          },
        ],
      });
      expect((button as HTMLButtonElement).disabled).toBe(false);
      expect(document.body.textContent).toContain('IPC timeout');
    } finally {
      rendered.cleanup();
    }
  });

  it('offers resume when one step is paused while the run is still running', async () => {
    const reasonId = '123e4567-e89b-42d3-a456-426614174000';
    const runningState: ExecutionState = {
      ...pausedState,
      version: 6,
      status: 'running',
      status_reasons: [
        {
          id: reasonId,
          kind: 'provider_usage_limit',
          code: 'usage_limit_exceeded',
          provider: 'claude',
          account_scope: 'native',
          detected_at: '2026-05-30T00:01:00.000Z',
          source: {
            job_id: 'limited',
            step_id: 'prompt',
            attempt: 0,
            iteration: 1,
          },
        },
      ],
    };
    const runningSummary: ExecutionSummary = {
      ...pausedSummary,
      status: 'running',
    };
    const resumeExecution = jest.fn().mockResolvedValue({ success: true });
    usePipelineRunsStore.setState({
      summaries: [runningSummary],
      statesById: { 'paused-execution': runningState },
      resumeExecution,
      loadExecutionDetails: jest.fn<Promise<ExecutionState | null>, [string]>(
        () => Promise.resolve(runningState),
      ),
    });
    const rendered = render(
      createElement(PipelineExecutionDetailModal, {
        executionId: 'paused-execution',
        onClose: jest.fn(),
      }),
    );

    try {
      const button = document.body.querySelector(
        '[data-testid="pause-formless-resume"]',
      );
      await click(button);
      expect(resumeExecution).toHaveBeenCalledWith('paused-execution', {
        statusReasonIds: [reasonId],
      });
    } finally {
      rendered.cleanup();
    }
  });

  it('offers pending input while sibling work keeps the run running', async () => {
    const runningState: ExecutionState = {
      ...pausedState,
      status: 'running',
    };
    const runningSummary: ExecutionSummary = {
      ...pausedSummary,
      status: 'running',
    };
    const resumeExecution = jest.fn().mockResolvedValue({ success: true });
    usePipelineRunsStore.setState({
      summaries: [runningSummary],
      statesById: { 'paused-execution': runningState },
      resumeExecution,
      loadExecutionDetails: jest.fn<Promise<ExecutionState | null>, [string]>(
        () => Promise.resolve(runningState),
      ),
    });
    const rendered = render(
      createElement(PipelineExecutionDetailModal, {
        executionId: 'paused-execution',
        onClose: jest.fn(),
      }),
    );

    try {
      const button = document.body.querySelector(
        '[data-testid="pause-input-resume"]',
      );
      await click(button);
      expect(resumeExecution).toHaveBeenCalledWith('paused-execution', {
        pauseResponses: [
          {
            answers: { scope: 'desktop' },
            checkpoint_id: pausedState.pending_pauses[0].id,
            job_id: 'gate',
            step_id: 'ask',
          },
        ],
      });
    } finally {
      rendered.cleanup();
    }
  });

  it('hides formless recovery controls for child executions', () => {
    const childState: ExecutionState = {
      ...pausedState,
      id: 'child-execution',
      parent_execution_id: 'paused-execution',
    };
    const childSummary: ExecutionSummary = {
      ...pausedSummary,
      id: 'child-execution',
      parent_execution_id: 'paused-execution',
    };
    usePipelineRunsStore.setState({
      summaries: [childSummary],
      statesById: { 'child-execution': childState },
      resumeExecution: jest.fn(),
      loadExecutionDetails: jest.fn<Promise<ExecutionState | null>, [string]>(
        () => Promise.resolve(childState),
      ),
    });

    const rendered = render(
      createElement(PipelineExecutionDetailModal, {
        executionId: 'child-execution',
        onClose: jest.fn(),
      }),
    );

    try {
      expect(
        document.body.querySelector('[data-testid="pause-formless-resume"]'),
      ).toBeNull();
    } finally {
      rendered.cleanup();
    }
  });
});
