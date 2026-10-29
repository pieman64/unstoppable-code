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
jest.mock('@/lib/pipelineTranscriptAvailability', () => {
  const actual = jest.requireActual<typeof TranscriptAvailabilityModule>(
    '@/lib/pipelineTranscriptAvailability',
  );
  return {
    ...actual,
    // A line renders once it is complete JSON; a partial final line does not.
    hasRenderableTranscriptPrefix: jest.fn((lines: readonly string[]) =>
      lines.some((line) => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      }),
    ),
  };
});

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as TranscriptAvailabilityModule from '@/lib/pipelineTranscriptAvailability';
import type {
  IPCResult,
  NormalizedStep,
  StepLogReadResult,
  StepResult,
} from '@canopy/desktop-shared/types/pipeline';
import { hasRenderableTranscriptPrefix } from '@/lib/pipelineTranscriptAvailability';
import {
  resetStepLogStoreForTests,
  routeStepOutputEvents,
} from '@/stores/pipelineStepLogStore';
import { PipelineStepDetail } from '../details/PipelineStepDetail';

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

const STEP: NormalizedStep = {
  id: 'compile',
  name: 'Compile',
  run: 'npm run build',
  shell: 'bash',
  continue_on_error: false,
  timeout_minutes: 30,
  skip_on_missing_action: false,
};

function stepResult(
  status: StepResult['status'],
  overrides: Partial<StepResult> = {},
): StepResult {
  return {
    status,
    outputs: {},
    dynamic_env: {},
    started_at: '2026-05-19T00:00:00.000Z',
    log_file: LOG_FILE,
    ...overrides,
  };
}

const readStepLog = jest.fn<
  Promise<IPCResult<StepLogReadResult>>,
  [unknown, unknown]
>();

describe('PipelineStepDetail', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    resetStepLogStoreForTests();
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: { readStepLog },
    });
    readStepLog.mockResolvedValue({
      success: true,
      data: { lines: ['persisted line'] },
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

  async function renderStep(result: StepResult | undefined): Promise<void> {
    await act(async () => {
      root.render(
        <PipelineStepDetail
          executionId="exec-1"
          jobId="build"
          stepDef={STEP}
          stepResult={result}
          attempt={0}
          iteration={1}
          source="current"
        />,
      );
      await flushAsyncWork();
    });
  }

  it('does the final authoritative read when a pending step settles without being seen running', async () => {
    await renderStep(stepResult('pending'));
    expect(readStepLog).toHaveBeenCalledTimes(1);

    // Coalesced or batched events can skip the running state entirely.
    await renderStep(stepResult('success'));

    expect(readStepLog).toHaveBeenCalledTimes(2);
  });

  it('does the final authoritative read when a step that has not started settles', async () => {
    await renderStep(undefined);
    expect(readStepLog).toHaveBeenCalledTimes(1);

    await renderStep(stepResult('cancelled'));

    expect(readStepLog).toHaveBeenCalledTimes(2);
  });

  it('does the final authoritative read when a paused step settles', async () => {
    await renderStep(stepResult('paused'));
    expect(readStepLog).toHaveBeenCalledTimes(1);

    await renderStep(stepResult('failure'));

    expect(readStepLog).toHaveBeenCalledTimes(2);
  });

  it('reads a step first observed settled exactly once', async () => {
    await renderStep(stepResult('success'));
    await renderStep(stepResult('success', { exit_code: 0 }));

    expect(readStepLog).toHaveBeenCalledTimes(1);
  });

  it('does not re-read when a pending step starts running', async () => {
    await renderStep(stepResult('pending'));
    await renderStep(stepResult('running'));

    expect(readStepLog).toHaveBeenCalledTimes(1);

    await renderStep(stepResult('success'));
    expect(readStepLog).toHaveBeenCalledTimes(2);
  });

  it('re-probes for a transcript when the final JSONL line completes in place', async () => {
    readStepLog.mockResolvedValue({
      success: true,
      data: {
        lines: [],
        text: '{"type":"assis',
        byteLength: 14,
        generation: 1,
      },
    });
    await renderStep(stepResult('running', { log_format_hint: 'agent' }));
    expect(
      container.querySelector('[data-testid="ansi-lines"]')?.textContent,
    ).toBe('{"type":"assis');
    expect(hasRenderableTranscriptPrefix).toHaveBeenCalledTimes(1);

    // Same line count; the partial final line completes into a message.
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
          data: 'tant"}\n',
          logPosition: { generation: 1, offset: 14, byteLength: 7 },
        },
      ]);
      await flushAsyncWork();
    });

    expect(hasRenderableTranscriptPrefix).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('[data-testid="transcript-lines"]')?.textContent,
    ).toBe('{"type":"assistant"}');
  });

  describe('archived source', () => {
    const readExecutionStepLog = jest.fn<
      Promise<{ lines: string[] }>,
      [Record<string, unknown>]
    >();
    const ARCHIVED_SOURCE = { projectId: 'ws-1', containerId: 'container-1' };

    beforeEach(() => {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { archivedContainers: { readExecutionStepLog } },
      });
      readExecutionStepLog.mockResolvedValue({ lines: ['archived line'] });
    });

    async function renderArchivedStep(result: StepResult): Promise<void> {
      await act(async () => {
        root.render(
          <PipelineStepDetail
            executionId="exec-1"
            jobId="build"
            stepDef={STEP}
            stepResult={result}
            attempt={0}
            iteration={1}
            source="current"
            archivedSource={ARCHIVED_SOURCE}
          />,
        );
        await flushAsyncWork();
      });
    }

    it('reads the log once through the archive transport and never the live API', async () => {
      await renderArchivedStep(stepResult('success'));

      expect(readStepLog).not.toHaveBeenCalled();
      expect(readExecutionStepLog).toHaveBeenCalledTimes(1);
      expect(readExecutionStepLog).toHaveBeenCalledWith({
        projectId: 'ws-1',
        containerId: 'container-1',
        executionId: 'exec-1',
        jobId: 'build',
        stepId: 'compile',
        attempt: 0,
        iteration: 1,
        recovery: undefined,
        logFilePath: LOG_FILE,
      });
      expect(
        container.querySelector('[data-testid="ansi-lines"]')?.textContent,
      ).toBe('archived line');

      // Live output never reaches an archived step.
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
        ]);
        await flushAsyncWork();
      });
      expect(
        container.querySelector('[data-testid="ansi-lines"]')?.textContent,
      ).toBe('archived line');
      expect(readStepLog).not.toHaveBeenCalled();
    });

    it('reads a separate archived transcript through the archive transport', async () => {
      readExecutionStepLog.mockImplementation((request) =>
        Promise.resolve({
          lines:
            request.logFilePath === '/archive/transcript.jsonl'
              ? ['{"type":"assistant"}']
              : ['plain line'],
        }),
      );
      await renderArchivedStep(
        stepResult('success', {
          log_format_hint: 'agent',
          outputs: { transcript_file: '/archive/transcript.jsonl' },
        }),
      );

      expect(readStepLog).not.toHaveBeenCalled();
      expect(
        readExecutionStepLog.mock.calls.map(([request]) => request.logFilePath),
      ).toEqual(
        expect.arrayContaining([LOG_FILE, '/archive/transcript.jsonl']),
      );
      expect(
        container.querySelector('[data-testid="transcript-lines"]')
          ?.textContent,
      ).toBe('{"type":"assistant"}');
    });

    it('hides the live worker jump for an archived terminal-mode step', async () => {
      await renderArchivedStep(
        stepResult('success', {
          agentTerminalMode: true,
          workerId: 'worker-1',
        }),
      );

      expect(
        container.querySelector(
          '[data-testid="pipeline-step-terminal-mode-banner"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="pipeline-step-view-worker-button"]',
        ),
      ).toBeNull();
    });
  });

  it('holds no live log interest while its detail is hidden', async () => {
    await act(async () => {
      root.render(
        <PipelineStepDetail
          executionId="exec-1"
          jobId="build"
          stepDef={STEP}
          stepResult={stepResult('running')}
          attempt={0}
          iteration={1}
          source="current"
          logsEnabled={false}
        />,
      );
      await flushAsyncWork();
    });

    expect(readStepLog).not.toHaveBeenCalled();
  });
});
