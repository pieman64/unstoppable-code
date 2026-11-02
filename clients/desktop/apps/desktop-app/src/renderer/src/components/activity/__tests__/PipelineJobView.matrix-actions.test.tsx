/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ExecutionState,
  NormalizedJob,
} from '@canopy/desktop-shared/types/pipeline';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { PipelineJobView } from '../details/PipelineJobView';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function render(node: JSX.Element): {
  container: HTMLDivElement;
  cleanup: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    cleanup: (): void => {
      act((): void => root.unmount());
      container.remove();
    },
  };
}

async function clickButton(
  container: HTMLElement,
  label: string,
): Promise<void> {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

function matrixState(
  executionStatus: ExecutionState['status'],
  variantStatus: ExecutionState['jobs'][string]['status'],
): ExecutionState {
  const logicalJob: NormalizedJob = {
    name: 'Build matrix',
    needs: [],
    if: 'true',
    env: {},
    outputs: {},
    timeout_minutes: 60,
    max_retries: 0,
    continue_on_error: false,
    strategy: {
      matrix: { os: ['macos'] },
      dynamic: false,
      fail_fast: true,
    },
    steps: [
      {
        id: 'run',
        name: 'Run',
        shell: 'bash',
        continue_on_error: false,
        timeout_minutes: 30,
        skip_on_missing_action: false,
      },
    ],
  };
  return {
    version: 8,
    id: 'matrix-execution',
    pipeline_id: 'matrix-pipeline',
    pipeline_snapshot: {
      name: 'Matrix pipeline',
      scope: ['directory'],
      jobs: { build: logicalJob },
    },
    status: executionStatus,
    jobs: {
      __matrix__build__0: {
        status: variantStatus,
        steps: {},
        outputs: {},
        retry_count: 0,
        retry_history: [],
        iteration_count: 0,
      },
    },
    job_definitions: {
      __matrix__build__0: {
        ...logicalJob,
        physical_job_id: '__matrix__build__0',
        logical_job_id: 'build',
        matrix: { index: 0, total: 1, values: { os: 'macos' } },
      },
    },
    job_groups: {
      build: {
        job_id: 'build',
        kind: 'matrix',
        expansion: 'expanded',
        variant_job_ids: ['__matrix__build__0'],
        status: variantStatus,
        fail_fast: true,
        resolved_max_parallel: 1,
      },
    },
    pending_pauses: [],
    status_reasons: [],
    started_at: '2026-08-05T00:00:00.000Z',
    cwd: '/tmp',
    env: {},
    inputs: {},
  };
}

function view(state: ExecutionState): JSX.Element {
  return (
    <PipelineJobView
      state={state}
      jobId="build"
      executionId={state.id}
      childSummaries={[]}
      expandedChildSteps={new Set<string>()}
      onToggleChildStep={jest.fn()}
      renderChildExecution={() => <div />}
    />
  );
}

describe('PipelineJobView matrix action feedback', () => {
  it('surfaces a per-variant cancellation failure', async () => {
    usePipelineRunsStore.setState({
      cancelMatrixVariant: jest.fn().mockResolvedValue({
        success: false,
        error: 'Variant is no longer cancellable',
      }),
    });
    const rendered = render(view(matrixState('running', 'running')));

    await clickButton(rendered.container, 'Cancel variant');

    expect(rendered.container.textContent).toContain(
      'Variant is no longer cancellable',
    );
    rendered.cleanup();
  });

  it('surfaces a per-variant retry failure', async () => {
    usePipelineRunsStore.setState({
      retryMatrixJob: jest.fn().mockResolvedValue({
        success: false,
        error: 'Retry reservation unavailable',
      }),
    });
    const rendered = render(view(matrixState('failure', 'failure')));

    await clickButton(rendered.container, 'Retry variant');

    expect(rendered.container.textContent).toContain(
      'Retry reservation unavailable',
    );
    rendered.cleanup();
  });

  it('hides retry-failed when no variant is failed or cancelled', () => {
    const rendered = render(view(matrixState('success', 'success')));

    expect(rendered.container.textContent).toContain('Retry all variants');
    expect(rendered.container.textContent).not.toContain(
      'Retry failed variants',
    );
    rendered.cleanup();
  });

  it('hides group retry controls when the matrix has no variants', () => {
    const state = matrixState('success', 'success');
    state.job_groups.build.variant_job_ids = [];
    state.jobs = {};
    state.job_definitions = {};
    const rendered = render(view(state));

    expect(rendered.container.textContent).not.toContain('Retry all variants');
    expect(rendered.container.textContent).not.toContain(
      'Retry failed variants',
    );
    rendered.cleanup();
  });

  it('hides matrix retry and cancel controls for an archived run', () => {
    const archivedSource = { projectId: 'ws-1', containerId: 'container-1' };
    for (const [executionStatus, variantStatus] of [
      ['running', 'running'],
      ['failure', 'failure'],
      ['success', 'success'],
    ] as const) {
      const rendered = render(
        <PipelineJobView
          state={matrixState(executionStatus, variantStatus)}
          jobId="build"
          executionId="matrix-execution"
          childSummaries={[]}
          expandedChildSteps={new Set<string>()}
          onToggleChildStep={jest.fn()}
          renderChildExecution={() => <div />}
          archivedSource={archivedSource}
        />,
      );
      const labels = Array.from(rendered.container.querySelectorAll('button'))
        .map((button) => button.textContent ?? '')
        .filter((label) => /Retry|Cancel/.test(label));
      expect(labels).toEqual([]);
      // Variants stay navigable in the read-only view.
      expect(rendered.container.textContent).toContain('Build matrix');
      rendered.cleanup();
    }
  });

  it('offers expansion retry only for a failed dynamic expansion', () => {
    const state = matrixState('failure', 'failure');
    state.job_groups.build.expansion = 'failure';
    state.job_groups.build.variant_job_ids = [];
    state.jobs = {};
    state.job_definitions = {};
    state.pipeline_snapshot.jobs.build.strategy = {
      matrix: '${{ parseJson(needs.prepare.outputs.matrix) }}',
      dynamic: true,
      fail_fast: true,
    };
    const rendered = render(view(state));

    expect(rendered.container.textContent).toContain('Retry expansion');
    rendered.cleanup();

    state.pipeline_snapshot.jobs.build.strategy.dynamic = false;
    const staticRendered = render(view(state));
    expect(staticRendered.container.textContent).not.toContain(
      'Retry expansion',
    );
    staticRendered.cleanup();
  });
});
