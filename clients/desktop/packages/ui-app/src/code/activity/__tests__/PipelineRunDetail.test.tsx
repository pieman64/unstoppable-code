/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PipelineRunDetail,
  type PipelineRunDetailProps,
} from '../pipeline/PipelineRunDetail';
import {
  buildPipelineRunDetailJobs,
  flattenPipelineRunDetailSteps,
  pipelineRunDetailStatusTone,
  pipelineRunStepKey,
  type PipelineRunDetailView,
} from '../pipeline/PipelineRunDetailModel';
import type {
  PipelineRunExecutionState,
  PipelineRunPauseResponse,
  PipelineRunSummary,
} from '../pipeline/PipelineRunRows';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

// `AnsiOutput` autoscrolls to the bottom when new lines arrive; jsdom has no
// layout and no `Element.scrollTo`.
Object.defineProperty(Element.prototype, 'scrollTo', {
  configurable: true,
  value: (): void => undefined,
});

// The shared DAG progress bar reaches for `CSS.supports` / `CSS.escape` when
// it measures tier overflow; jsdom implements neither.
Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: {
    supports: (): boolean => false,
    escape: (value: string): string => value.replace(/[^\w-]/g, '\\$&'),
  },
});

const RUN: PipelineRunDetailView = {
  id: 'exec-1',
  pipeline_name: 'Ship it',
  jobs: [
    {
      job_id: 'build',
      name: 'Build',
      status: 'running',
      steps: [
        { step_id: 'compile', name: 'Compile', status: 'success' },
        { step_id: 'bundle', name: 'Bundle', status: 'running' },
      ],
      variants: [
        {
          job_id: 'build__linux',
          name: 'Build (linux)',
          status: 'running',
          steps: [{ step_id: 'compile', name: 'Compile', status: 'running' }],
        },
      ],
    },
    {
      job_id: 'deploy',
      name: 'Deploy',
      status: 'pending',
      steps: [{ step_id: 'compile', name: 'Compile', status: 'pending' }],
    },
  ],
};

const RUNNING_SUMMARY: PipelineRunSummary = {
  id: 'exec-1',
  pipeline_id: 'pipe-1',
  pipeline_name: 'Ship it',
  status: 'running',
  status_reasons: [],
  started_at: '2026-09-11T10:00:00.000Z',
};

function summaryWithStatus(
  status: PipelineRunSummary['status'],
): PipelineRunSummary {
  return { ...RUNNING_SUMMARY, status };
}

const REPLAYABLE_STATE: PipelineRunExecutionState = {
  pipeline_snapshot: { jobs: {} },
  jobs: {},
  job_groups: {},
  inputs_persisted: true,
};

const roots: Root[] = [];

function render(props: Partial<PipelineRunDetailProps> = {}): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <PipelineRunDetail
        run={RUN}
        summary={RUNNING_SUMMARY}
        selectedStep={null}
        onSelectStep={(): void => undefined}
        log={{ lines: [] }}
        {...props}
      />,
    );
  });
  return container;
}

function click(container: HTMLElement, testId: string): void {
  const button = container.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  expect(button).not.toBeNull();
  act(() => button?.click());
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) act(() => root.unmount());
  }
  document.body.innerHTML = '';
});

describe('buildPipelineRunDetailJobs', () => {
  it('groups steps under their job and nests variants exactly one level', () => {
    const groups = buildPipelineRunDetailJobs(RUN.jobs);

    expect(groups.map((group) => group.job_id)).toEqual(['build', 'deploy']);
    expect(groups[0]?.variants.map((variant) => variant.job_id)).toEqual([
      'build__linux',
    ]);
    expect(groups[1]?.variants).toEqual([]);
  });

  it('carries the physical job id on every step entry', () => {
    // A matrix variant's steps must key to the VARIANT's job id — that is the
    // id a host needs to request the right log.
    const entries = flattenPipelineRunDetailSteps(
      buildPipelineRunDetailJobs(RUN.jobs),
    );

    expect(
      entries.map((entry) =>
        pipelineRunStepKey(entry.job_id, entry.step.step_id),
      ),
    ).toEqual([
      'build:compile',
      'build:bundle',
      'build__linux:compile',
      'deploy:compile',
    ]);
  });
});

describe('pipelineRunDetailStatusTone', () => {
  it('maps every canonical terminal portal status to its semantic tone', () => {
    expect(pipelineRunDetailStatusTone('completed')).toEqual({
      tone: 'success',
      muted: false,
    });
    expect(pipelineRunDetailStatusTone('failed')).toEqual({
      tone: 'failed',
      muted: false,
    });
    expect(pipelineRunDetailStatusTone('timed_out')).toEqual({
      tone: 'failed',
      muted: false,
    });
  });
});

describe('PipelineRunDetail', () => {
  it('renders a job heading per job and nests the matrix variant', () => {
    const container = render();

    expect(
      container.querySelector('[data-testid="pipeline-run-job-build"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="pipeline-run-job-deploy"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="pipeline-run-variant-build__linux"]',
      ),
    ).not.toBeNull();
  });

  it('reports the selected step with its physical job id', () => {
    const onSelectStep = jest.fn();
    const container = render({ onSelectStep });

    // Two different jobs both own a step named `Compile`; the flat list this
    // replaces made them indistinguishable.
    click(container, 'portal-pipeline-step-build__linux-compile');
    expect(onSelectStep).toHaveBeenCalledWith({
      job_id: 'build__linux',
      step_id: 'compile',
    });

    click(container, 'portal-pipeline-step-deploy-compile');
    expect(onSelectStep).toHaveBeenLastCalledWith({
      job_id: 'deploy',
      step_id: 'compile',
    });
  });

  it('renders the supplied log lines', () => {
    const container = render({
      log: { lines: ['compiled successfully', 'bundled 12 modules'] },
    });

    const log = container.querySelector(
      '[data-testid="portal-pipeline-step-log"]',
    );
    expect(log?.textContent).toContain('compiled successfully');
    expect(log?.textContent).toContain('bundled 12 modules');
    // The log uses the shared panel surface, not a terminal look of its own.
    const outputClassName =
      log?.querySelector('[data-testid="ansi-output"]')?.className ?? '';
    expect(outputClassName).toContain('bg-secondary');
    expect(outputClassName).not.toContain('text-emerald-200');
    expect(outputClassName).not.toContain('bg-[#0c0c0e]');
  });

  it('remounts the ANSI renderer when the physical step selection changes', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    act(() => {
      root.render(
        <PipelineRunDetail
          run={RUN}
          summary={RUNNING_SUMMARY}
          selectedStep={{ job_id: 'build', step_id: 'compile' }}
          onSelectStep={(): void => undefined}
          log={{ lines: ['compile one', 'compile two'] }}
        />,
      );
    });
    const firstRenderer = container.querySelector(
      '[data-testid="ansi-output"]',
    );
    expect(firstRenderer).not.toBeNull();

    act(() => {
      root.render(
        <PipelineRunDetail
          run={RUN}
          summary={RUNNING_SUMMARY}
          selectedStep={{ job_id: 'build__linux', step_id: 'compile' }}
          onSelectStep={(): void => undefined}
          log={{ lines: ['linux one', 'linux two'] }}
        />,
      );
    });

    expect(container.querySelector('[data-testid="ansi-output"]')).not.toBe(
      firstRenderer,
    );
  });

  it('omits every action whose handler the host did not supply', () => {
    // Absent, not disabled: a host with no command behind an action renders
    // no control at all (CAN-2865).
    const container = render({ summary: summaryWithStatus('failure') });

    for (const testId of [
      'pipeline-run-detail-cancel',
      'pipeline-run-detail-retry',
      'pipeline-run-detail-rerun',
      'pipeline-run-detail-resume',
    ]) {
      expect(container.querySelector(`[data-testid="${testId}"]`)).toBeNull();
    }
  });

  it('offers Cancel only while the run is active', () => {
    const active = render({ onCancel: jest.fn() });
    expect(
      active.querySelector('[data-testid="pipeline-run-detail-cancel"]'),
    ).not.toBeNull();

    const finished = render({
      summary: summaryWithStatus('success'),
      onCancel: jest.fn(),
    });
    expect(
      finished.querySelector('[data-testid="pipeline-run-detail-cancel"]'),
    ).toBeNull();
  });

  it('offers Retry only for a terminal root run', () => {
    const failed = render({
      summary: summaryWithStatus('failure'),
      onRetry: jest.fn(),
    });
    expect(
      failed.querySelector('[data-testid="pipeline-run-detail-retry"]'),
    ).not.toBeNull();

    const running = render({ onRetry: jest.fn() });
    expect(
      running.querySelector('[data-testid="pipeline-run-detail-retry"]'),
    ).toBeNull();
  });

  it('offers Start over only when the host carries rerun replay data', () => {
    const without = render({
      summary: summaryWithStatus('success'),
      onRerun: jest.fn(),
    });
    expect(
      without.querySelector('[data-testid="pipeline-run-detail-rerun"]'),
    ).toBeNull();

    const with_ = render({
      summary: summaryWithStatus('success'),
      executionState: REPLAYABLE_STATE,
      onRerun: jest.fn(),
    });
    expect(
      with_.querySelector('[data-testid="pipeline-run-detail-rerun"]'),
    ).not.toBeNull();
  });

  it('suppresses the bare Resume chip while a checkpoint form is showing', () => {
    const container = render({
      summary: summaryWithStatus('paused'),
      run: {
        ...RUN,
        pending_pauses: [
          {
            id: 'checkpoint-approval',
            kind: 'input',
            job_id: 'review',
            logical_job_id: 'review',
            step_id: 'approve',
            request: {
              title: 'Release approval',
              fields: [
                {
                  key: 'approved',
                  label: 'Approve',
                  type: 'boolean',
                  required: true,
                  default: false,
                },
              ],
            },
          },
        ],
      },
      onResume: jest.fn(),
    });

    // The form's submit IS the resume affordance; a second bare chip would
    // discard typed answers.
    expect(
      container.querySelector('[data-testid="portal-pipeline-pause-submit"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="pipeline-run-detail-resume"]'),
    ).toBeNull();
  });

  it('hides every Resume affordance for a nested paused run', () => {
    const container = render({
      summary: {
        ...summaryWithStatus('paused'),
        parent_execution_id: 'exec-parent',
      },
      run: {
        ...RUN,
        pending_pauses: [
          {
            id: 'checkpoint-child',
            kind: 'action',
            job_id: 'review',
            logical_job_id: 'review',
            step_id: 'approve',
          },
        ],
      },
      onResume: jest.fn(),
    });

    // The checkpoint form is itself a Resume action, so it must share the
    // same root-execution guard as the bare chip.
    expect(
      container.querySelector('[data-testid="pipeline-run-pause-form"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="pipeline-run-detail-resume"]'),
    ).toBeNull();
  });

  it('submits the exact checkpoint identity and collected answers', () => {
    const onResume = jest.fn<
      void,
      [string, readonly PipelineRunPauseResponse[] | undefined]
    >();
    const container = render({
      summary: summaryWithStatus('paused'),
      run: {
        ...RUN,
        pending_pauses: [
          {
            id: 'checkpoint-approval',
            kind: 'input',
            job_id: 'review__1',
            logical_job_id: 'review',
            step_id: 'approve',
            request: {
              fields: [
                {
                  key: 'approved',
                  label: 'Approve',
                  type: 'boolean',
                  required: true,
                  default: true,
                },
              ],
            },
          },
        ],
      },
      onResume,
    });

    click(container, 'portal-pipeline-pause-submit');
    expect(onResume).toHaveBeenCalledWith('exec-1', [
      {
        checkpoint_id: 'checkpoint-approval',
        job_id: 'review__1',
        step_id: 'approve',
        answers: { approved: true },
      },
    ]);
  });

  it('does not submit a checkpoint the host cannot answer', () => {
    const container = render({
      summary: summaryWithStatus('paused'),
      run: {
        ...RUN,
        pending_pauses: [
          {
            id: 'checkpoint-oversized',
            kind: 'input',
            job_id: 'review',
            logical_job_id: 'review',
            step_id: 'approve',
            request_unavailable_reason: 'too_large',
          },
        ],
      },
      onResume: jest.fn(),
    });

    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-pipeline-pause-submit"]',
      )?.disabled,
    ).toBe(true);
  });

  it('bounds checkpoint fields in their own scroller and keeps Submit fixed', () => {
    const container = render({
      summary: summaryWithStatus('paused'),
      run: {
        ...RUN,
        pending_pauses: [
          {
            id: 'checkpoint-long',
            kind: 'input',
            job_id: 'review',
            logical_job_id: 'review',
            step_id: 'approve',
            request: {
              fields: Array.from({ length: 12 }, (_, index) => ({
                key: `note_${index + 1}`,
                label: `Note ${index + 1}`,
                type: 'string' as const,
              })),
            },
          },
        ],
      },
      onResume: jest.fn(),
    });

    const form = container.querySelector(
      '[data-testid="pipeline-run-pause-form"]',
    );
    expect(form?.className).toContain('max-h-[40vh]');
    expect(form?.className).toContain('flex-col');

    const fields = container.querySelector(
      '[data-testid="pipeline-run-pause-fields"]',
    );
    expect(fields?.className).toContain('overflow-y-auto');
    expect(
      container.querySelector('[data-testid="portal-pipeline-pause-submit"]')
        ?.parentElement,
    ).toBe(form);
  });

  it('keeps the tree and the log in two independent panes', () => {
    // `min-w-0` on the log column is mandatory: without it the flex item
    // floors at the widest unwrapped log line and crushes the tree — the same
    // defect CAN-3020 fixes, relocated.
    const container = render();

    const tree = container.querySelector(
      '[data-testid="pipeline-run-detail-steps"]',
    );
    expect(tree?.className).toContain('overflow-y-auto');
    expect(tree?.className).toContain('md:w-72');

    const log = container.querySelector(
      '[data-testid="portal-pipeline-step-log"]',
    );
    expect(log?.className).toContain('min-w-0');
  });
});
