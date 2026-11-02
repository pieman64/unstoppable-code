/** @jest-environment jsdom */

import { act } from 'react';
import type { CostNavigator } from '@canopy/app-core';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import { PipelineRunCostView } from '../PipelineRunCostView';
import {
  createCostRenderer,
  createFakeCostClient,
  ENTRY_SCOPE,
  flush,
  NOW,
  ok,
  pipelineRunView,
  RETAINED_SCOPE,
  runRow,
  totals,
  type CostRenderer,
} from './cost-test-utils';

function byTestId(parent: ParentNode, testId: string): HTMLElement {
  const element = parent.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Expected data-testid="${testId}"`);
  }
  return element;
}

function click(element: HTMLElement): void {
  act(() => element.click());
}

function renderView(
  renderer: CostRenderer,
  client = createFakeCostClient(),
  options: {
    readonly navigator?: CostNavigator;
    readonly scope?: CostScopeRef;
    readonly props?: Partial<React.ComponentProps<typeof PipelineRunCostView>>;
  } = {},
): ReturnType<typeof createFakeCostClient> {
  renderer.render(
    <PipelineRunCostView
      client={client}
      navigator={options.navigator ?? {}}
      scope={options.scope ?? ENTRY_SCOPE}
      executionId="run-1"
      now={NOW}
      {...options.props}
    />,
  );
  return client;
}

describe('PipelineRunCostView', () => {
  let renderer: CostRenderer | null = null;

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  it('shows the run total, attempts and step metadata', async () => {
    renderer = createCostRenderer();
    renderView(renderer);
    await flush();

    expect(
      byTestId(renderer.container, 'pipeline-run-cost-total').textContent,
    ).toContain('$1.10');
    expect(
      byTestId(renderer.container, 'pipeline-run-cost-total').textContent,
    ).toContain('observed');
    expect(
      byTestId(renderer.container, 'pipeline-run-cost-total').textContent,
    ).toContain('2 agent steps');
    expect(
      byTestId(renderer.container, 'pipeline-run-cost-step-fix').textContent,
    ).toContain('2 attempts');
    expect(
      byTestId(renderer.container, 'pipeline-run-cost-step-review').textContent,
    ).toContain('Sonnet 5.5 · Claude · 68.4k tokens');
  });

  it('includes cached input tokens in a step total but not reasoning tokens', async () => {
    renderer = createCostRenderer();
    const view = pipelineRunView({
      steps: pipelineRunView().steps.map((step) =>
        step.jobId === 'review'
          ? {
              ...step,
              totals: {
                ...step.totals,
                tokens: {
                  input: 90,
                  output: 92_975,
                  cacheReadInputTokens: 10_848_711,
                  cacheCreationInputTokens: 351_582,
                  reasoningOutputTokens: 80_000_000,
                },
              },
            }
          : step,
      ),
    });
    renderView(renderer, createFakeCostClient({ pipelineRun: ok(view) }));
    await flush();

    expect(
      byTestId(renderer.container, 'pipeline-run-cost-step-review').textContent,
    ).toContain('11.3M tokens');
    expect(
      byTestId(renderer.container, 'pipeline-run-cost-step-review').textContent,
    ).not.toContain('91.3M tokens');
  });

  it('opens a step job when supported and keeps the row static otherwise', async () => {
    renderer = createCostRenderer();
    const openPipelineJob = jest.fn();
    renderView(renderer, createFakeCostClient(), {
      navigator: { openPipelineJob },
    });
    await flush();

    const step = byTestId(renderer.container, 'pipeline-run-cost-step-review');
    expect(step.tagName).toBe('BUTTON');
    click(step);
    expect(openPipelineJob).toHaveBeenCalledWith(
      ENTRY_SCOPE,
      'run-1',
      'review',
    );

    renderer.unmount();
    renderer = createCostRenderer();
    renderView(renderer);
    await flush();
    expect(
      byTestId(renderer.container, 'pipeline-run-cost-step-review').tagName,
    ).toBe('DIV');
  });

  it('shows advisor reports and child runs with optional navigation', async () => {
    renderer = createCostRenderer();
    const openPipelineRun = jest.fn();
    const view = pipelineRunView({
      advisor: { reportCount: 1, usd: 0.05, notPricedCount: 0 },
      childRuns: [
        {
          executionId: 'child-run',
          pipelineName: 'Deploy child',
          usd: 0.3,
          agentStepCount: 2,
        },
      ],
    });
    renderView(renderer, createFakeCostClient({ pipelineRun: ok(view) }), {
      navigator: { openPipelineRun },
    });
    await flush();

    expect(
      byTestId(renderer.container, 'pipeline-run-cost-advisor').textContent,
    ).toContain('Run report');
    expect(
      byTestId(renderer.container, 'pipeline-run-cost-child-child-run').tagName,
    ).toBe('BUTTON');
    click(byTestId(renderer.container, 'pipeline-run-cost-child-child-run'));
    expect(openPipelineRun).toHaveBeenCalledWith(ENTRY_SCOPE, 'child-run');
  });

  it('lists a nested run as one child row instead of repeating its steps', async () => {
    renderer = createCostRenderer();
    const rootSteps = pipelineRunView().steps;
    const view = pipelineRunView({
      steps: [
        ...rootSteps,
        {
          jobId: 'child-review',
          stepId: 'child-agent',
          label: 'Child agent',
          attemptCount: 1,
          model: 'Sonnet 5.5',
          harness: 'Claude',
          totals: totals({ pipeline: 0.2 }),
          executionId: 'child-run',
        },
      ],
      childRuns: [
        {
          executionId: 'child-run',
          pipelineName: 'Nested review',
          usd: 0.2,
          agentStepCount: 1,
        },
      ],
    });
    renderView(renderer, createFakeCostClient({ pipelineRun: ok(view) }));
    await flush();

    expect(
      renderer.container.querySelector(
        '[data-testid="pipeline-run-cost-step-child-review"]',
      ),
    ).toBeNull();
    expect(
      byTestId(renderer.container, 'pipeline-run-cost-child-child-run')
        .textContent,
    ).toContain('Nested review');
    expect(
      byTestId(renderer.container, 'pipeline-run-cost-step-review'),
    ).toBeTruthy();
    expect(
      byTestId(renderer.container, 'pipeline-run-cost-step-fix'),
    ).toBeTruthy();
  });

  it('names the proxy account of each step and totals the run by account', async () => {
    renderer = createCostRenderer();
    const [review, fix] = pipelineRunView().steps;
    if (!review || !fix) throw new Error('fixture steps missing');
    const sam = {
      accountKey: 'proxy:conn-1:a1f3c2d4a1f3c2d4',
      label: 'sam@example.com',
      provider: 'claude',
    };
    const ops = {
      accountKey: 'proxy:conn-1:9b07e1aa9b07e1aa',
      label: 'ops@example.com',
      provider: 'claude',
    };
    const view = pipelineRunView({
      run: runRow({
        totals: totals({ pipeline: 1.05, account_proxy: 1.05 }),
      }),
      steps: [
        {
          ...review,
          proxyAccounts: [
            {
              ...sam,
              turnShare: 1,
              requestCount: 4,
              usd: 0.84,
              notPricedCount: 0,
            },
          ],
        },
        {
          ...fix,
          proxyAccounts: [
            {
              ...ops,
              turnShare: 1.5,
              requestCount: 3,
              usd: 0.16,
              notPricedCount: 0,
            },
            {
              ...sam,
              turnShare: 0.5,
              requestCount: 1,
              usd: 0.05,
              notPricedCount: 0,
            },
          ],
        },
      ],
      byProxyAccount: [
        {
          ...ops,
          turnShare: 1.5,
          requestCount: 3,
          usd: 0.16,
          notPricedCount: 0,
        },
        {
          ...sam,
          turnShare: 1.5,
          requestCount: 5,
          usd: 0.89,
          notPricedCount: 0,
        },
      ],
    });
    renderView(renderer, createFakeCostClient({ pipelineRun: ok(view) }), {
      navigator: { openPipelineJob: jest.fn() },
    });
    await flush();

    expect(
      byTestId(renderer.container, 'pipeline-run-cost-step-review-account')
        .textContent,
    ).toBe('sam@example.com via account proxy');
    expect(
      byTestId(renderer.container, 'pipeline-run-cost-step-fix-account')
        .textContent,
    ).toBe('2 accounts via account proxy · switched accounts');
    // Names stay out of attributes session replay records.
    const step = byTestId(renderer.container, 'pipeline-run-cost-step-fix');
    expect(step.getAttribute('aria-label')).toContain(
      'via account proxy, 2 accounts',
    );
    expect(step.getAttribute('aria-label')).not.toContain('@example.com');
    const rows = renderer.container.querySelectorAll(
      '[data-testid="pipeline-run-cost-account-row"]',
    );
    expect(Array.from(rows, (row) => row.textContent)).toEqual([
      'ops@example.com50% of attempts≈ $0.16',
      'sam@example.com50% of attempts≈ $0.89',
    ]);
    expect(renderer.container.textContent).toContain(
      'Subscription, AI Credits and account proxy amounts are estimates at API prices, not charges.',
    );
  });

  it('shows no account section for a run the proxy did not serve', async () => {
    renderer = createCostRenderer();
    renderView(renderer);
    await flush();
    expect(
      renderer.container.querySelector(
        '[data-testid="pipeline-run-cost-by-account"]',
      ),
    ).toBeNull();
  });

  it('reads Not priced for a child run with no priced work', async () => {
    renderer = createCostRenderer();
    const view = pipelineRunView({
      childRuns: [
        {
          executionId: 'gateway-child',
          pipelineName: 'Gateway child',
          usd: 0,
          agentStepCount: 1,
          notPricedCount: 2,
        },
      ],
    });
    renderView(renderer, createFakeCostClient({ pipelineRun: ok(view) }));
    await flush();

    const row = byTestId(
      renderer.container,
      'pipeline-run-cost-child-gateway-child',
    );
    expect(row.textContent).toContain('Not priced');
    expect(row.textContent).not.toContain('$0.00');
  });

  it('shows non-agent steps only when the count is defined and positive', async () => {
    renderer = createCostRenderer();
    renderView(renderer);
    await flush();
    expect(
      byTestId(renderer.container, 'pipeline-run-cost-non-agent').textContent,
    ).toBe('3 other steps ran no agent and cost nothing.');

    renderer.unmount();
    renderer = createCostRenderer();
    renderView(
      renderer,
      createFakeCostClient({
        pipelineRun: ok(pipelineRunView({ nonAgentStepCount: undefined })),
      }),
    );
    await flush();
    expect(
      renderer.container.querySelector(
        '[data-testid="pipeline-run-cost-non-agent"]',
      ),
    ).toBeNull();

    renderer.unmount();
    renderer = createCostRenderer();
    renderView(
      renderer,
      createFakeCostClient({
        pipelineRun: ok(pipelineRunView({ nonAgentStepCount: 0 })),
      }),
    );
    await flush();
    expect(
      renderer.container.querySelector(
        '[data-testid="pipeline-run-cost-non-agent"]',
      ),
    ).toBeNull();
  });

  it('shows billing estimate copy and cost by model', async () => {
    renderer = createCostRenderer();
    renderView(renderer);
    await flush();

    expect(renderer.container.textContent).toContain(
      'Subscription and AI Credits amounts are estimates at API prices, not charges.',
    );
    expect(
      byTestId(renderer.container, 'pipeline-run-cost-by-model').textContent,
    ).toContain('Sonnet 5.5');
    expect(
      byTestId(renderer.container, 'pipeline-run-cost-by-model').textContent,
    ).toContain('$0.84');
  });

  it('lists run subagents and delegations as static rows', async () => {
    renderer = createCostRenderer();
    const view = pipelineRunView({
      subagents: [
        {
          id: 'run-subagent',
          kind: 'codex_agent',
          label: 'Review API results',
          model: 'GPT 6 Sol',
          billingBasis: 'subscription',
          tokens: pipelineRunView().run.totals.tokens,
          usd: 0.12,
          costStatus: 'reported',
          inclusion: 'included',
        },
      ],
      delegations: [
        {
          id: 'run-delegation',
          kind: 'delegation',
          label: 'Generate fixture data',
          model: 'Haiku 4.5',
          harness: 'Claude',
          billingBasis: 'ai_credits',
          tokens: pipelineRunView().run.totals.tokens,
          usd: 0.25,
          costStatus: 'estimated',
          inclusion: 'additional',
          status: 'completed',
        },
      ],
    });
    renderView(renderer, createFakeCostClient({ pipelineRun: ok(view) }));
    await flush();

    expect(
      byTestId(renderer.container, 'pipeline-run-cost-item-run-subagent')
        .tagName,
    ).toBe('DIV');
    expect(
      byTestId(renderer.container, 'pipeline-run-cost-item-run-subagent')
        .textContent,
    ).toContain('Included in workflow step cost');
    expect(
      byTestId(renderer.container, 'pipeline-run-cost-item-run-delegation')
        .tagName,
    ).toBe('DIV');
    expect(
      byTestId(renderer.container, 'pipeline-run-cost-item-run-delegation')
        .textContent,
    ).toContain('$0.25');
  });

  it('seals a retained run and removes refresh', async () => {
    renderer = createCostRenderer();
    const client = createFakeCostClient({
      pipelineRun: ok(
        pipelineRunView({ sealedAt: '2026-10-06T12:00:00.000Z' }),
      ),
    });
    renderView(renderer, client, { scope: RETAINED_SCOPE });
    await flush();

    expect(renderer.container.textContent).toContain('Final as of Oct 6');
    expect(
      renderer.container.querySelector('[data-testid="cost-refresh"]'),
    ).toBeNull();
    expect(client.refresh).not.toHaveBeenCalled();
  });
});
