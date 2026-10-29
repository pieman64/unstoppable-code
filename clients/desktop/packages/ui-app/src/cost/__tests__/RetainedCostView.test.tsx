/** @jest-environment jsdom */
import { act } from 'react';
import { RetainedCostView, defaultRetainedCostRow } from '../RetainedCostView';
import {
  RETAINED_SCOPE,
  NOW,
  breakdownView,
  chatRow,
  createCostRenderer,
  createFakeCostClient,
  flush,
  ok,
  runRow,
  scopeView,
  totals,
  type CostRenderer,
} from './cost-test-utils';

const SEALED_AT = new Date(2026, 9, 6, 15, 0).toISOString();

function retainedScope(): ReturnType<typeof scopeView> {
  return scopeView({
    scope: RETAINED_SCOPE,
    sealedAt: SEALED_AT,
    chats: [
      chatRow({
        chatId: 'chat-1',
        label: 'Add cost index checkpoints',
        running: true,
      }),
      chatRow({
        chatId: 'chat-2',
        label: 'Fix flaky checkout test',
        state: 'archived',
        totals: totals({ chat: 2.62, subagents: 0.31 }),
      }),
    ],
    pipelineRuns: [runRow({ status: 'running' })],
  });
}

function byTestId(root: ParentNode, testId: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (element === null) throw new Error(`Missing ${testId}`);
  return element;
}

describe('RetainedCostView', () => {
  let renderer: CostRenderer | undefined;

  afterEach(() => {
    renderer?.unmount();
    renderer = undefined;
  });

  it('shows the sealed list beside the most expensive chat, with no refresh or running state', async () => {
    renderer = createCostRenderer();
    const client = createFakeCostClient({
      scope: ok(retainedScope()),
      chat: ok({
        kind: 'full',
        breakdown: breakdownView({
          chat: chatRow({ running: true }),
          sealedAt: SEALED_AT,
        }),
      }),
    });
    renderer.render(
      <RetainedCostView
        client={client}
        navigator={{}}
        scope={RETAINED_SCOPE}
        now={NOW}
      />,
    );
    await flush();
    await flush();

    const list = byTestId(renderer.container, 'retained-cost-list');
    expect(list.className).toContain('w-96');
    expect(
      byTestId(list, 'cost-chat-row-chat-1').getAttribute('aria-current'),
    ).toBe('true');
    expect(
      byTestId(list, 'cost-chat-row-chat-2').getAttribute('aria-current'),
    ).toBeNull();
    expect(byTestId(list, 'cost-freshness-label').textContent).toBe(
      'Final as of Oct 6',
    );
    expect(list.textContent).not.toContain('Running');

    const detail = byTestId(renderer.container, 'retained-cost-detail');
    expect(byTestId(detail, 'session-breakdown-view')).toBeTruthy();
    expect(
      detail.querySelector('[data-testid="session-breakdown-open-chat"]'),
    ).toBeNull();
    expect(detail.textContent).toContain('Final as of Oct 6');
    expect(detail.textContent).not.toContain('Running');

    expect(
      renderer.container.querySelector('[data-testid="cost-refresh"]'),
    ).toBeNull();
    expect(client.refresh).not.toHaveBeenCalled();
    expect(client.watchScope).not.toHaveBeenCalled();
    expect(client.getChat).toHaveBeenCalledWith({
      scope: RETAINED_SCOPE,
      chatId: 'chat-1',
      detail: 'full',
    });
  });

  it('opens a chosen run on the right and moves aria-current to it', async () => {
    renderer = createCostRenderer();
    const client = createFakeCostClient({ scope: ok(retainedScope()) });
    const onSelectRow = jest.fn();
    renderer.render(
      <RetainedCostView
        client={client}
        navigator={{
          openPipelineRun: jest.fn(),
          openSessionBreakdown: jest.fn(),
        }}
        scope={RETAINED_SCOPE}
        onSelectRow={onSelectRow}
        now={NOW}
      />,
    );
    await flush();

    const runRowButton = byTestId(renderer.container, 'cost-run-row-run-1');
    act(() => runRowButton.click());
    await flush();

    expect(onSelectRow).toHaveBeenCalledWith({
      kind: 'pipeline-run',
      executionId: 'run-1',
    });
    expect(
      byTestId(renderer.container, 'cost-run-row-run-1').getAttribute(
        'aria-current',
      ),
    ).toBe('true');
    expect(
      byTestId(renderer.container, 'cost-chat-row-chat-1').getAttribute(
        'aria-current',
      ),
    ).toBeNull();
    const detail = byTestId(renderer.container, 'retained-cost-detail');
    expect(byTestId(detail, 'pipeline-run-cost-view').className).toContain(
      'max-w-2xl',
    );
    expect(client.getPipelineRun).toHaveBeenCalledWith({
      scope: RETAINED_SCOPE,
      executionId: 'run-1',
    });
    expect(
      renderer.container.querySelector('[data-testid="cost-refresh"]'),
    ).toBeNull();
  });

  it('follows a host-held selection', async () => {
    renderer = createCostRenderer();
    const client = createFakeCostClient({ scope: ok(retainedScope()) });
    renderer.render(
      <RetainedCostView
        client={client}
        navigator={{}}
        scope={RETAINED_SCOPE}
        selectedRow={{ kind: 'chat', chatId: 'chat-2' }}
        now={NOW}
      />,
    );
    await flush();

    expect(
      byTestId(renderer.container, 'cost-chat-row-chat-2').getAttribute(
        'aria-current',
      ),
    ).toBe('true');
    expect(client.getChat).toHaveBeenCalledWith({
      scope: RETAINED_SCOPE,
      chatId: 'chat-2',
      detail: 'full',
    });
  });

  it('renders the unavailable state without reading when the capability is off', () => {
    renderer = createCostRenderer({ costInsights: false });
    const client = createFakeCostClient();
    renderer.render(
      <RetainedCostView
        client={client}
        navigator={{}}
        scope={RETAINED_SCOPE}
        now={NOW}
      />,
    );

    expect(byTestId(renderer.container, 'cost-unavailable').textContent).toBe(
      'Cost is not available here.',
    );
    expect(client.getScope).not.toHaveBeenCalled();
  });
});

describe('defaultRetainedCostRow', () => {
  it('picks the most expensive chat, then a run, then nothing', () => {
    expect(defaultRetainedCostRow(null)).toBeNull();
    expect(defaultRetainedCostRow(retainedScope())).toEqual({
      kind: 'chat',
      chatId: 'chat-1',
    });
    expect(
      defaultRetainedCostRow(
        scopeView({ chats: [], pipelineRuns: [runRow()] }),
      ),
    ).toEqual({ kind: 'pipeline-run', executionId: 'run-1' });
    expect(
      defaultRetainedCostRow(scopeView({ chats: [], pipelineRuns: [] })),
    ).toBeNull();
  });
});
