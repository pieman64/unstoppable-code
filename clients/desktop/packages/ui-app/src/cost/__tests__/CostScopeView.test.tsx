/** @jest-environment jsdom */
import { act } from 'react';
import type { CostNavigator } from '@canopy/app-core';
import type {
  CostScopeRef,
  CostUpdatedEvent,
} from '@canopy/protocol/cost-view';
import { CostScopeView, type CostScopeViewProps } from '../CostScopeView';
import {
  createCostRenderer,
  createFakeCostClient,
  ENTRY_SCOPE,
  flush,
  minutesAgo,
  NOW,
  ok,
  RETAINED_SCOPE,
  chatRow,
  runRow,
  scopeView,
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

/** A row's accessible name: its `aria-label`, or the text it is labelled by. */
function accessibleName(element: HTMLElement): string {
  const label = element.getAttribute('aria-label');
  if (label !== null) return label.toLowerCase();
  return (element.getAttribute('aria-labelledby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(', ')
    .toLowerCase();
}

function renderView(
  renderer: CostRenderer,
  client = createFakeCostClient(),
  options: {
    readonly navigator?: CostNavigator;
    readonly scope?: CostScopeRef;
    readonly props?: Partial<CostScopeViewProps>;
  } = {},
): ReturnType<typeof createFakeCostClient> {
  renderer.render(
    <CostScopeView
      client={client}
      navigator={options.navigator ?? {}}
      scope={options.scope ?? ENTRY_SCOPE}
      now={NOW}
      {...options.props}
    />,
  );
  return client;
}

describe('CostScopeView', () => {
  let renderer: CostRenderer | null = null;

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  it('shows the first-build notice, zero total and empty bar without rows', async () => {
    renderer = createCostRenderer();
    const view = scopeView({
      building: true,
      retentionDays: 1,
      chats: [],
      pipelineRuns: [],
      totals: totals(),
      unattached: totals(),
    });
    renderView(renderer, createFakeCostClient({ scope: ok(view) }));
    await flush();

    expect(
      byTestId(renderer.container, 'cost-scope-view').getAttribute(
        'data-dimension',
      ),
    ).toBe('source');
    expect(byTestId(renderer.container, 'cost-total-amount').textContent).toBe(
      '$0.00',
    );
    expect(
      byTestId(renderer.container, 'cost-entry-bar').getAttribute('aria-label'),
    ).toBe('Cost in this entry: none');
    expect(byTestId(renderer.container, 'cost-notice').textContent).toContain(
      'Building cost history.',
    );
    expect(byTestId(renderer.container, 'cost-notice').textContent).toContain(
      'Reading the last 1 day of activity, as Retention days allows. Figures fill in as it goes.',
    );
    expect(
      renderer.container.querySelector('[data-testid^="cost-chat-row-"]'),
    ).toBeNull();
    expect(
      renderer.container.querySelector('[data-testid^="cost-run-row-"]'),
    ).toBeNull();
  });

  it('shows the empty-state copy and keeps the zero entry bar', async () => {
    renderer = createCostRenderer();
    const view = scopeView({
      chats: [],
      pipelineRuns: [],
      totals: totals(),
      unattached: totals(),
    });
    renderView(renderer, createFakeCostClient({ scope: ok(view) }));
    await flush();

    expect(byTestId(renderer.container, 'cost-empty').textContent).toBe(
      'Costs appear after the first reply.',
    );
    expect(byTestId(renderer.container, 'cost-entry-bar')).not.toBeNull();
  });

  it('keeps its last rows visible while a scope update read is pending', async () => {
    renderer = createCostRenderer();
    const client = renderView(renderer);
    await flush();
    client.getScope.mockClear();
    let releaseRead: (() => void) | undefined;
    client.getScope.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRead = (): void => resolve(ok(scopeView()));
        }),
    );

    act(() => {
      client.emit({
        scopes: [ENTRY_SCOPE],
        revision: 3,
      } satisfies CostUpdatedEvent);
    });

    expect(byTestId(renderer.container, 'cost-chat-row-chat-1')).not.toBeNull();
    expect(byTestId(renderer.container, 'cost-run-row-run-1')).not.toBeNull();

    await act(async () => {
      releaseRead?.();
      await Promise.resolve();
    });
  });

  it('shows older-entry coverage on the observed total', async () => {
    renderer = createCostRenderer();
    renderView(
      renderer,
      createFakeCostClient({
        scope: ok(scopeView({ coverageStart: '2026-10-01' })),
      }),
    );
    await flush();

    expect(byTestId(renderer.container, 'cost-total').textContent).toContain(
      'observed since Oct 1',
    );
  });

  it('keeps rows after a failed refresh and reports the failure', async () => {
    renderer = createCostRenderer();
    const client = createFakeCostClient({
      refresh: {
        status: 'error',
        reason: 'UNKNOWN',
        message: 'The cost refresh failed.',
      },
    });
    renderView(renderer, client);
    await flush();

    expect(
      byTestId(renderer.container, 'cost-freshness-label').textContent,
    ).toBe("Couldn't refresh");
    expect(byTestId(renderer.container, 'cost-chat-row-chat-1')).not.toBeNull();
  });

  it('switches every entry and row bar between source and billing', async () => {
    renderer = createCostRenderer();
    renderView(renderer);
    await flush();

    expect(
      byTestId(renderer.container, 'cost-chat-row-chat-1')
        .querySelector('[role="img"]')
        ?.getAttribute('aria-label'),
    ).toContain('Chat turns');
    expect(
      byTestId(renderer.container, 'cost-run-row-run-1')
        .querySelector('[role="img"]')
        ?.getAttribute('aria-label'),
    ).toContain('Workflow steps');

    click(byTestId(renderer.container, 'cost-split-billing'));

    expect(
      byTestId(renderer.container, 'cost-scope-view').getAttribute(
        'data-dimension',
      ),
    ).toBe('billing');
    expect(
      byTestId(renderer.container, 'cost-entry-bar').getAttribute('aria-label'),
    ).toContain('Subscription');
    expect(
      byTestId(renderer.container, 'cost-chat-row-chat-1')
        .querySelector('[role="img"]')
        ?.getAttribute('aria-label'),
    ).toContain('Subscription');
    expect(
      byTestId(renderer.container, 'cost-run-row-run-1')
        .querySelector('[role="img"]')
        ?.getAttribute('aria-label'),
    ).toContain('Subscription');
  });

  it('shares a scale across chat and run rows', async () => {
    renderer = createCostRenderer();
    const view = scopeView({
      chats: [
        chatRow({
          chatId: 'less-expensive',
          totals: totals({ chat: 5 }),
        }),
        chatRow({
          chatId: 'chat-expensive',
          label: 'Most expensive',
          totals: totals({ chat: 20 }),
        }),
        chatRow({
          chatId: 'another-chat',
          totals: totals({ chat: 1 }),
        }),
      ],
      pipelineRuns: [
        runRow({
          executionId: 'run-cheaper',
          totals: totals({ pipeline: 10 }),
        }),
      ],
      unattached: totals(),
    });
    renderView(renderer, createFakeCostClient({ scope: ok(view) }));
    await flush();

    const largestWidth = byTestId(
      renderer.container,
      'cost-chat-row-chat-expensive',
    )
      .querySelector('[role="img"] > div')
      ?.getAttribute('style');
    const smallerWidth = byTestId(
      renderer.container,
      'cost-run-row-run-cheaper',
    )
      .querySelector('[role="img"] > div')
      ?.getAttribute('style');
    expect(largestWidth).toContain('width: 100%');
    expect(smallerWidth).toContain('width: 50%');
  });

  it('sorts chats and runs together and hides archived chats from the menu', async () => {
    renderer = createCostRenderer();
    const view = scopeView({
      chats: [
        chatRow({
          chatId: 'older-chat',
          state: 'open',
          totals: totals({ chat: 8 }),
          lastActivityAt: minutesAgo(30),
        }),
        chatRow({
          chatId: 'recent-archived',
          state: 'archived',
          totals: totals({ chat: 1 }),
          lastActivityAt: minutesAgo(1),
        }),
      ],
      pipelineRuns: [
        runRow({
          executionId: 'older-run',
          totals: totals({ pipeline: 8 }),
          startedAt: minutesAgo(60),
        }),
        runRow({
          executionId: 'recent-run',
          totals: totals({ pipeline: 1 }),
          startedAt: minutesAgo(1),
        }),
      ],
      unattached: totals(),
    });
    renderView(renderer, createFakeCostClient({ scope: ok(view) }));
    await flush();

    click(byTestId(renderer.container, 'cost-sort'));
    click(byTestId(document.body, 'cost-sort-option-recent'));

    expect(
      byTestId(
        renderer.container,
        'cost-chat-row-recent-archived',
      ).compareDocumentPosition(
        byTestId(renderer.container, 'cost-chat-row-older-chat'),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      byTestId(
        renderer.container,
        'cost-run-row-recent-run',
      ).compareDocumentPosition(
        byTestId(renderer.container, 'cost-run-row-older-run'),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    click(byTestId(renderer.container, 'cost-sort'));
    click(byTestId(document.body, 'cost-sort-show-archived'));
    expect(
      byTestId(renderer.container, 'cost-chats-heading').textContent,
    ).toContain('Chats 1');
    expect(
      renderer.container.querySelector(
        '[data-testid="cost-chat-row-recent-archived"]',
      ),
    ).toBeNull();
  });

  it('keeps the archive filter in reach when it hides every row', async () => {
    renderer = createCostRenderer();
    const { unattached: _unattached, ...view } = scopeView({
      chats: [
        chatRow({
          chatId: 'only-archived',
          state: 'archived',
          totals: totals({ chat: 2 }),
        }),
      ],
      pipelineRuns: [],
    });
    expect(_unattached).toBeDefined();
    renderView(renderer, createFakeCostClient({ scope: ok(view) }));
    await flush();

    click(byTestId(renderer.container, 'cost-sort'));
    click(byTestId(document.body, 'cost-sort-show-archived'));

    // The filtered list is empty, but this is not an entry with no cost.
    expect(
      renderer.container.querySelector('[data-testid="cost-empty"]'),
    ).toBeNull();
    expect(
      byTestId(renderer.container, 'cost-archived-hidden').textContent,
    ).toBe('Archived chats are hidden.');

    // The sort control is still mounted, so the filter can be turned back on.
    expect(byTestId(renderer.container, 'cost-sort')).toBeTruthy();
    if (
      document.body.querySelector('[data-testid="cost-sort-show-archived"]') ===
      null
    ) {
      click(byTestId(renderer.container, 'cost-sort'));
    }
    click(byTestId(document.body, 'cost-sort-show-archived'));
    expect(
      byTestId(renderer.container, 'cost-chat-row-only-archived'),
    ).toBeTruthy();
  });

  it('announces archived and running state in row names and shows unattached not-priced work', async () => {
    renderer = createCostRenderer();
    const view = scopeView({
      chats: [
        chatRow({
          chatId: 'running-chat',
          label: 'Running work',
          running: true,
        }),
        chatRow({ chatId: 'chat-2', state: 'archived' }),
      ],
      unattached: totals({ notPricedCount: 1 }),
    });
    renderView(renderer, createFakeCostClient({ scope: ok(view) }), {
      navigator: { openSessionBreakdown: jest.fn() },
    });
    await flush();

    expect(
      accessibleName(byTestId(renderer.container, 'cost-chat-row-chat-2')),
    ).toContain('archived');
    expect(
      accessibleName(
        byTestId(renderer.container, 'cost-chat-row-running-chat'),
      ),
    ).toContain('running');
    expect(
      byTestId(renderer.container, 'cost-unattached-row').textContent,
    ).toContain('Not priced');
  });

  it('seals a retained entry, selects rows and calls onSelectRow instead of navigation', async () => {
    renderer = createCostRenderer();
    const onSelectRow = jest.fn();
    const openSessionBreakdown = jest.fn();
    const view = scopeView({
      scope: RETAINED_SCOPE,
      sealedAt: '2026-10-06T12:00:00.000Z',
      chats: [chatRow({ running: true })],
      pipelineRuns: [runRow({ status: 'running' })],
    });
    renderView(renderer, createFakeCostClient({ scope: ok(view) }), {
      scope: RETAINED_SCOPE,
      navigator: { openSessionBreakdown },
      props: {
        selectedRow: { kind: 'chat', chatId: 'chat-1' },
        onSelectRow,
      },
    });
    await flush();

    expect(
      renderer.container.querySelector('[data-testid="cost-refresh"]'),
    ).toBeNull();
    expect(
      byTestId(renderer.container, 'cost-freshness-label').textContent,
    ).toContain('Final as of Oct 6');
    expect(
      byTestId(renderer.container, 'cost-chat-row-chat-1').getAttribute(
        'aria-current',
      ),
    ).toBe('true');
    const chatName = accessibleName(
      byTestId(renderer.container, 'cost-chat-row-chat-1'),
    );
    expect(chatName).toContain('$');
    expect(chatName).not.toContain('running');
    expect(
      accessibleName(byTestId(renderer.container, 'cost-run-row-run-1')),
    ).not.toContain('running');

    click(byTestId(renderer.container, 'cost-chat-row-chat-1'));
    expect(onSelectRow).toHaveBeenCalledWith({
      kind: 'chat',
      chatId: 'chat-1',
    });
    expect(openSessionBreakdown).not.toHaveBeenCalled();
  });

  it('leaves rows static when navigation methods are absent', async () => {
    renderer = createCostRenderer();
    renderView(renderer);
    await flush();

    expect(byTestId(renderer.container, 'cost-chat-row-chat-1').tagName).toBe(
      'DIV',
    );
    expect(byTestId(renderer.container, 'cost-run-row-run-1').tagName).toBe(
      'DIV',
    );
  });

  it('manually refreshes the scope and announces a successful update', async () => {
    renderer = createCostRenderer();
    const client = renderView(renderer);
    await flush();
    client.refresh.mockClear();

    click(byTestId(renderer.container, 'cost-refresh'));
    await flush();

    expect(client.refresh).toHaveBeenCalledWith({
      scope: ENTRY_SCOPE,
      trigger: 'manual',
    });
    expect(
      renderer.container.querySelector('[role="status"]')?.textContent,
    ).toBe('Cost updated');
  });

  it('re-reads when a cost update includes its scope', async () => {
    renderer = createCostRenderer();
    const client = renderView(renderer);
    await flush();
    client.getScope.mockClear();

    act(() => {
      client.emit({ scopes: [ENTRY_SCOPE], revision: 4 });
    });
    await flush();

    expect(client.getScope).toHaveBeenCalledTimes(1);
  });

  it('gates capability-off hosts without creating a store', () => {
    renderer = createCostRenderer({ costInsights: false });
    const client = createFakeCostClient();
    renderView(renderer, client);

    expect(renderer.container.textContent).toContain(
      'Cost is not available here.',
    );
    expect(
      renderer.container.querySelector('[data-testid="cost-scope-view"]'),
    ).toBeNull();
    expect(client.getScope).not.toHaveBeenCalled();
  });

  it('shows a failed first read instead of an empty entry', async () => {
    renderer = createCostRenderer();
    renderView(
      renderer,
      createFakeCostClient({
        scope: {
          status: 'error',
          reason: 'UNKNOWN',
          message: 'The first cost read failed.',
        },
      }),
    );
    await flush();

    expect(renderer.container.textContent).toContain("Couldn't load cost.");
    expect(renderer.container.textContent).toContain(
      'The first cost read failed.',
    );
    expect(
      renderer.container.querySelector('[data-testid="cost-empty"]'),
    ).toBeNull();
  });

  it('masks chat names for session replay and leaves pipeline names readable', async () => {
    renderer = createCostRenderer();
    renderView(renderer);
    await flush();

    const view = scopeView();
    const chat = view.chats[0];
    const run = view.pipelineRuns[0];
    if (chat === undefined || run === undefined) {
      throw new Error('Fixture rows missing');
    }
    const chatRow = byTestId(
      renderer.container,
      `cost-chat-row-${chat.chatId}`,
    );
    expect(chatRow.querySelector('.ph-mask')?.textContent).toBe(chat.label);
    expect(chatRow.outerHTML.split(chat.label)).toHaveLength(2);
    const runRow = byTestId(
      renderer.container,
      `cost-run-row-${run.executionId}`,
    );
    expect(runRow.querySelector('.ph-mask')).toBeNull();
  });
});
