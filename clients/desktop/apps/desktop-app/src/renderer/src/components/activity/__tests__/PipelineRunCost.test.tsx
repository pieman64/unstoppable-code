/** @jest-environment jsdom */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

jest.mock(
  '../details/PipelineExecutionActionBar',
  (): {
    PipelineExecutionActionBar: () => null;
  } => ({
    PipelineExecutionActionBar: (): null => null,
  }),
);
jest.mock(
  '../details/PipelinePauseResumeContent',
  (): {
    PipelinePauseResumeContent: () => null;
  } => ({
    PipelinePauseResumeContent: (): null => null,
  }),
);
jest.mock(
  '../../pipeline/flow/PipelineFlowDiagram',
  (): {
    PipelineFlowDiagram: () => null;
  } => ({
    PipelineFlowDiagram: (): null => null,
  }),
);
jest.mock('../usePipelineExecutionActions', () => ({
  usePipelineExecutionActions: (): {
    dialogs: null;
    dialogAnchorRef: () => void;
  } => ({
    dialogs: null,
    dialogAnchorRef: (): void => undefined,
  }),
  usePipelineExecutionWatchers: (): never[] => [],
}));
jest.mock('@/lib/cost/cost-navigator', () => ({
  DESKTOP_COST_NAVIGATOR: { openPipelineJob: jest.fn() },
}));

import { act } from 'react';
import type {
  ExecutionState,
  NormalizedStep,
  StepResult,
} from '@canopy/desktop-shared/types/pipeline';
import type { PipelineRunCostView } from '@canopy/protocol/cost-view';
import {
  createFakeCostClient,
  createCostRenderer,
  ENTRY_SCOPE,
  flush,
  ok,
  pipelineRunView,
  totals,
  type CostRenderer,
} from '../../../../../../../../packages/ui-app/src/cost/__tests__/cost-test-utils';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';
import { PipelineExecutionDetail } from '../details/PipelineExecutionDetail';
import { PipelineRunCostProvider } from '../details/PipelineRunCostPanel';
import { resetPipelineDetailLeasesForTests } from '@/lib/pipelineDetailLeases';
import { resetStepLogStoreForTests } from '@/stores/pipelineStepLogStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { createFakePipelineExecutionActions } from './fakePipelineExecutionActions';

Object.defineProperty(globalThis, 'CSS', { configurable: true, value: {} });

const OWNER = { projectId: 'project-1', worktreeId: 'worktree-1' };
const STARTED_AT = '2026-10-09T12:00:00.000Z';
const AGENT_STEP: NormalizedStep = {
  id: 'agent-step',
  name: 'Agent step',
  uses: 'builtin/agent-prompt',
  shell: 'bash',
  continue_on_error: false,
  timeout_minutes: 30,
  skip_on_missing_action: false,
};
const SCRIPT_STEP: NormalizedStep = {
  id: 'script',
  name: 'Script step',
  run: 'echo ok',
  shell: 'bash',
  continue_on_error: false,
  timeout_minutes: 30,
  skip_on_missing_action: false,
};

function stepResult(): StepResult {
  return {
    status: 'success',
    outputs: {},
    dynamic_env: {},
    started_at: STARTED_AT,
    completed_at: '2026-10-09T12:00:20.000Z',
  };
}

function executionState(
  withAgentStep: boolean = true,
  retry: boolean = false,
): ExecutionState {
  const step = withAgentStep ? AGENT_STEP : SCRIPT_STEP;
  const result = stepResult();
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
          max_retries: retry ? 1 : 0,
          continue_on_error: false,
          steps: [step],
        },
      },
    },
    status: 'success',
    jobs: {
      build: {
        status: 'success',
        steps: { [step.id]: result },
        outputs: {},
        started_at: STARTED_AT,
        completed_at: '2026-10-09T12:00:30.000Z',
        retry_count: retry ? 1 : 0,
        ...(retry
          ? {
              retry_history: [
                {
                  attempt: 0,
                  status: 'failure' as const,
                  steps: { [step.id]: result },
                },
              ],
            }
          : {}),
        iteration_count: 1,
      },
    },
    job_definitions: {},
    job_groups: {},
    pending_pauses: [],
    status_reasons: [],
    started_at: STARTED_AT,
    completed_at: '2026-10-09T12:00:30.000Z',
    cwd: '/repo',
    env: {},
    inputs: {},
    event_name: 'dispatch',
    project_id: OWNER.projectId,
    worktree_id: OWNER.worktreeId,
  };
}

function costView(agentStepCount: number = 1): PipelineRunCostView {
  const base = pipelineRunView();
  const totalsValue = totals({ pipeline: 1.1 });
  return pipelineRunView({
    run: {
      ...base.run,
      executionId: 'exec-1',
      pipelineName: 'Build pipeline',
      agentStepCount,
      totals: totalsValue,
    },
    steps:
      agentStepCount === 0
        ? []
        : [
            {
              jobId: 'build',
              stepId: 'agent-step',
              label: 'Agent step',
              attemptCount: 2,
              model: 'Sonnet 5.5',
              harness: 'Claude',
              totals: totals({ pipeline: 0.21 }),
              executionId: 'exec-1',
            },
          ],
    childRuns: [],
    advisor: undefined,
    byModel: [
      {
        model: 'Sonnet 5.5',
        turnCount: 2,
        usd: totalsValue.usd,
        notPricedCount: 0,
        tokens: totalsValue.tokens,
      },
    ],
  });
}

function renderDetail(
  renderer: CostRenderer,
  client: ReturnType<typeof createFakeCostClient>,
  options: {
    readonly initialTarget?: { entry?: 'cost'; jobId?: string };
    readonly retry?: boolean;
    readonly withAgentStep?: boolean;
    /** Lists each plain job as its own single-variant group, as runs do. */
    readonly singleJobGroups?: boolean;
  } = {},
): void {
  const baseState = executionState(options.withAgentStep, options.retry);
  const state: ExecutionState = options.singleJobGroups
    ? {
        ...baseState,
        job_groups: Object.fromEntries(
          Object.keys(baseState.jobs).map((jobId) => [
            jobId,
            {
              job_id: jobId,
              kind: 'single',
              expansion: 'expanded',
              variant_job_ids: [jobId],
              status: 'success',
            },
          ]),
        ),
      }
    : baseState;
  usePipelineRunsStore.setState({
    summaries: [],
    statesById: { 'exec-1': state },
    advisorSnapshotsByExecutionId: {},
  });
  renderer.render(
    <PipelineRunCostProvider
      client={client}
      scope={ENTRY_SCOPE}
      executionId="exec-1"
    >
      <PipelineExecutionDetail
        executionId="exec-1"
        owner={OWNER}
        initialTarget={options.initialTarget}
        actions={createFakePipelineExecutionActions()}
      />
    </PipelineRunCostProvider>,
  );
}

function byTestId(parent: ParentNode, testId: string): HTMLElement | null {
  return parent.querySelector(`[data-testid="${testId}"]`);
}

async function click(element: Element | null): Promise<void> {
  expect(element).toBeInstanceOf(HTMLElement);
  await act(async () => {
    element?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await flush();
  });
}

describe('pipeline run cost details', (): void => {
  let renderer: CostRenderer;

  beforeEach(() => {
    resetPipelineDetailLeasesForTests();
    resetStepLogStoreForTests();
    resetExperimentalFeaturesStoreForTest();
    setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {},
    });
    renderer = createCostRenderer();
  });

  afterEach(() => {
    renderer.unmount();
    resetPipelineDetailLeasesForTests();
    resetStepLogStoreForTests();
    resetExperimentalFeaturesStoreForTest();
  });

  it('shows the Cost entry, Summary preview, and the aggregate retry cost beside its step', async () => {
    const client = createFakeCostClient({ pipelineRun: ok(costView()) });
    renderDetail(renderer, client, { retry: true });
    await flush();

    expect(
      byTestId(renderer.container, 'pipeline-job-list-cost')?.textContent,
    ).toContain('$1.10');
    expect(
      byTestId(renderer.container, 'pipeline-summary-cost-preview'),
    ).not.toBeNull();
    expect(
      byTestId(renderer.container, 'pipeline-run-cost-preview'),
    ).not.toBeNull();

    const jobRow = byTestId(
      renderer.container,
      'pipeline-details-nav-job-build',
    );
    expect(jobRow?.textContent).not.toContain('$0.21');
    await click(jobRow);

    const stepCosts = renderer.container.querySelectorAll(
      '[data-testid="pipeline-step-cost-agent-step"]',
    );
    expect(stepCosts).toHaveLength(1);
    expect(stepCosts[0]?.textContent).toBe('$0.21');
    // The combined cost sits on the current attempt, not an earlier failed one.
    const stepRows = renderer.container.querySelectorAll(
      '[data-testid="pipeline-step-agent-step"]',
    );
    expect(stepRows.length).toBeGreaterThan(1);
    expect(
      stepRows[stepRows.length - 1]?.querySelector(
        '[data-testid="pipeline-step-cost-agent-step"]',
      ),
    ).not.toBeNull();
  });

  it('opens the Cost entry from the Summary preview and a cost target wins over a job', async () => {
    const client = createFakeCostClient({ pipelineRun: ok(costView()) });
    renderDetail(renderer, client);
    await flush();
    await click(byTestId(renderer.container, 'pipeline-run-cost-preview'));

    expect(
      byTestId(renderer.container, 'pipeline-job-list-cost')?.getAttribute(
        'aria-current',
      ),
    ).toBe('true');
    expect(byTestId(renderer.container, 'pipeline-cost-view')).not.toBeNull();
    expect(byTestId(renderer.container, 'pipeline-summary-view')).toBeNull();

    renderer.unmount();
    renderer = createCostRenderer();
    const targetedClient = createFakeCostClient({
      pipelineRun: ok(costView()),
    });
    renderDetail(renderer, targetedClient, {
      initialTarget: { entry: 'cost', jobId: 'build' },
    });
    await flush();
    expect(
      byTestId(renderer.container, 'pipeline-job-list-cost')?.getAttribute(
        'aria-current',
      ),
    ).toBe('true');
    expect(byTestId(renderer.container, 'pipeline-cost-view')).not.toBeNull();
  });

  it('selects the step job in this detail when a breakdown step is clicked', async () => {
    const client = createFakeCostClient({ pipelineRun: ok(costView()) });
    renderDetail(renderer, client, {
      initialTarget: { entry: 'cost' },
    });
    await flush();
    await click(byTestId(renderer.container, 'pipeline-run-cost-step-build'));

    expect(
      byTestId(
        renderer.container,
        'pipeline-details-nav-job-build',
      )?.getAttribute('aria-current'),
    ).toBe('true');
    expect(
      byTestId(renderer.container, 'pipeline-job-view-build'),
    ).not.toBeNull();
  });

  it('marks a plain job current when its step is chosen from the breakdown', async () => {
    const client = createFakeCostClient({ pipelineRun: ok(costView()) });
    renderDetail(renderer, client, {
      initialTarget: { entry: 'cost' },
      singleJobGroups: true,
    });
    await flush();
    await click(byTestId(renderer.container, 'pipeline-run-cost-step-build'));

    expect(
      byTestId(
        renderer.container,
        'pipeline-details-nav-job-build',
      )?.getAttribute('aria-current'),
    ).toBe('true');
  });

  it('shows nothing for a failed cost read or a run with no agent steps', async () => {
    const failedClient = createFakeCostClient({
      pipelineRun: {
        status: 'error',
        reason: 'NOT_FOUND',
        message: 'No cost is recorded.',
      },
    });
    renderDetail(renderer, failedClient, {
      initialTarget: { entry: 'cost' },
    });
    await flush();
    expect(byTestId(renderer.container, 'pipeline-job-list-cost')).toBeNull();
    expect(
      byTestId(renderer.container, 'pipeline-summary-cost-preview'),
    ).toBeNull();
    expect(byTestId(renderer.container, 'pipeline-cost-view')).toBeNull();
    expect(
      byTestId(renderer.container, 'pipeline-summary-view'),
    ).not.toBeNull();

    renderer.unmount();
    renderer = createCostRenderer();
    const noAgentClient = createFakeCostClient({
      pipelineRun: ok(costView(0)),
    });
    renderDetail(renderer, noAgentClient, {
      withAgentStep: false,
      initialTarget: { entry: 'cost' },
    });
    await flush();
    expect(byTestId(renderer.container, 'pipeline-job-list-cost')).toBeNull();
    expect(
      byTestId(renderer.container, 'pipeline-summary-cost-preview'),
    ).toBeNull();
    expect(
      byTestId(renderer.container, 'pipeline-step-cost-agent-step'),
    ).toBeNull();
    expect(
      byTestId(renderer.container, 'pipeline-summary-view'),
    ).not.toBeNull();
  });
});
