/** @jest-environment jsdom */

import { act } from 'react';
import type { CostNavigator } from '@canopy/app-core';
import type {
  CostBackgroundRow,
  CostScopeRef,
} from '@canopy/protocol/cost-view';
import { SessionBreakdownView } from '../SessionBreakdownView';
import {
  attributedItem,
  breakdownView,
  createCostRenderer,
  createFakeCostClient,
  ENTRY_SCOPE,
  flush,
  NOW,
  ok,
  RETAINED_SCOPE,
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
    readonly props?: Partial<React.ComponentProps<typeof SessionBreakdownView>>;
  } = {},
): ReturnType<typeof createFakeCostClient> {
  renderer.render(
    <SessionBreakdownView
      client={client}
      navigator={options.navigator ?? {}}
      scope={options.scope ?? ENTRY_SCOPE}
      chatId="chat-1"
      now={NOW}
      {...options.props}
    />,
  );
  return client;
}

describe('SessionBreakdownView', () => {
  let renderer: CostRenderer | null = null;

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  it('keeps the header and tabs outside the scrolling tab panel', async () => {
    renderer = createCostRenderer();
    renderView(renderer);
    await flush();

    const scroll = byTestId(renderer.container, 'session-breakdown-scroll');
    const meta = byTestId(renderer.container, 'session-breakdown-meta');
    const tabs = byTestId(renderer.container, 'session-breakdown-tabs');
    const panel = byTestId(renderer.container, 'session-breakdown-panel-cost');

    expect(scroll.contains(panel)).toBe(true);
    expect(scroll.contains(meta)).toBe(false);
    expect(scroll.contains(tabs)).toBe(false);
  });

  it('shows the chat name, running marker and observed metadata', async () => {
    renderer = createCostRenderer();
    renderView(renderer);
    await flush();

    expect(renderer.container.textContent).toContain(
      'Add cost index checkpoints',
    );
    expect(renderer.container.textContent).toContain('Running');
    expect(
      byTestId(renderer.container, 'session-breakdown-meta').textContent,
    ).toContain('$6.84');
    expect(
      byTestId(renderer.container, 'session-breakdown-meta').textContent,
    ).toContain('observed');
    expect(
      byTestId(renderer.container, 'session-breakdown-meta').textContent,
    ).toContain('42 turns');
    expect(
      byTestId(renderer.container, 'session-breakdown-meta').textContent,
    ).toContain('Sonnet 5.5 and Opus 5.5');
  });

  it('shows an archived marker and the chat coverage start', async () => {
    renderer = createCostRenderer();
    renderView(
      renderer,
      createFakeCostClient({
        chat: ok({
          kind: 'full',
          breakdown: breakdownView({
            chat: {
              ...breakdownView().chat,
              state: 'archived',
              running: false,
              coverageStart: '2026-10-01',
            },
          }),
        }),
      }),
    );
    await flush();

    expect(renderer.container.textContent).toContain('Archived');
    expect(
      byTestId(renderer.container, 'session-breakdown-meta').textContent,
    ).toContain('observed since Oct 1');
  });

  it('opens the chat when supported and omits the action otherwise', async () => {
    renderer = createCostRenderer();
    const openChat = jest.fn();
    renderView(renderer, createFakeCostClient(), {
      navigator: { openChat },
    });
    await flush();

    click(byTestId(renderer.container, 'session-breakdown-open-chat'));
    expect(openChat).toHaveBeenCalledWith(ENTRY_SCOPE, 'chat-1');

    renderer.unmount();
    renderer = createCostRenderer();
    renderView(renderer, createFakeCostClient());
    await flush();
    expect(
      renderer.container.querySelector(
        '[data-testid="session-breakdown-open-chat"]',
      ),
    ).toBeNull();
  });

  it('wires selected tabs to the one tab panel', async () => {
    renderer = createCostRenderer();
    renderView(renderer);
    await flush();

    const selections = [
      ['cost', 'Where it went'],
      ['context', 'Context'],
      ['activity', 'Total time'],
    ] as const;
    for (const [tab, expected] of selections) {
      const button = byTestId(
        renderer.container,
        `session-breakdown-tab-${tab}`,
      );
      if (tab !== 'cost') click(button);
      expect(button.getAttribute('aria-selected')).toBe('true');
      const panel = byTestId(
        renderer.container,
        `session-breakdown-panel-${tab}`,
      );
      expect(button.getAttribute('aria-controls')).toBe(panel.id);
      expect(panel.getAttribute('aria-labelledby')).toBe(button.id);
      expect(panel.textContent).toContain(expected);
    }
  });

  it('expands chat turns by model only when several models were used', async () => {
    renderer = createCostRenderer();
    renderView(renderer);
    await flush();

    const multiModelRow = byTestId(
      renderer.container,
      'session-breakdown-source-chat',
    );
    expect(multiModelRow.tagName).toBe('BUTTON');
    expect(multiModelRow.getAttribute('aria-expanded')).toBe('false');
    click(multiModelRow);
    expect(multiModelRow.getAttribute('aria-expanded')).toBe('true');
    expect(renderer.container.textContent).toContain('Sonnet 5.5');
    expect(renderer.container.textContent).toContain('30 turns');

    renderer.unmount();
    renderer = createCostRenderer();
    renderView(
      renderer,
      createFakeCostClient({
        chat: ok({
          kind: 'full',
          breakdown: breakdownView({
            chatTurnsByModel: [breakdownView().chatTurnsByModel[0]],
          }),
        }),
      }),
    );
    await flush();

    const singleModelRow = byTestId(
      renderer.container,
      'session-breakdown-source-chat',
    );
    expect(singleModelRow.tagName).toBe('DIV');
    expect(singleModelRow.querySelector('svg')).toBeNull();
  });

  it('opens subagent and delegation items through the optional navigator', async () => {
    renderer = createCostRenderer();
    const openSubagent = jest.fn();
    renderView(renderer, createFakeCostClient(), {
      navigator: { openSubagent },
    });
    await flush();

    click(byTestId(renderer.container, 'session-breakdown-source-subagents'));
    click(byTestId(renderer.container, 'session-breakdown-item-sub-1'));
    expect(openSubagent).toHaveBeenCalledWith(ENTRY_SCOPE, {
      chatId: 'chat-1',
      subagentId: 'sub-1',
      kind: 'claude_task',
    });

    click(byTestId(renderer.container, 'session-breakdown-source-delegations'));
    click(byTestId(renderer.container, 'session-breakdown-item-del-1'));
    expect(openSubagent).toHaveBeenCalledWith(ENTRY_SCOPE, {
      chatId: 'chat-1',
      subagentId: 'del-1',
      kind: 'delegation',
    });
  });

  it('shows included subagent share and an additional delegation amount', async () => {
    renderer = createCostRenderer();
    renderView(renderer);
    await flush();

    click(byTestId(renderer.container, 'session-breakdown-source-subagents'));
    // $0.40 of the $4.50 the turns cost: $4.10 of their own plus this share.
    expect(
      byTestId(renderer.container, 'session-breakdown-item-sub-1').textContent,
    ).toContain('9% of chat turns');
    click(byTestId(renderer.container, 'session-breakdown-source-delegations'));
    expect(
      byTestId(renderer.container, 'session-breakdown-item-del-1').textContent,
    ).toContain('$1.30');
  });

  it.each([
    { own: 2, included: 8, share: '80%' },
    { own: 0, included: 5, share: '100%' },
  ])(
    'shows an included subagent as $share of a turn that kept $$own of its own',
    async ({ own, included, share }) => {
      renderer = createCostRenderer();
      const base = breakdownView();
      renderView(
        renderer,
        createFakeCostClient({
          chat: ok({
            kind: 'full',
            breakdown: breakdownView({
              bySource: {
                ...base.bySource,
                chat: { usd: own, turnCount: 1 },
                subagents: {
                  usd: included,
                  items: [attributedItem({ usd: included })],
                },
              },
            }),
          }),
        }),
      );
      await flush();

      click(byTestId(renderer.container, 'session-breakdown-source-subagents'));
      expect(
        byTestId(renderer.container, 'session-breakdown-item-sub-1')
          .textContent,
      ).toContain(`${share} of chat turns`);
    },
  );

  it('labels the background helper kinds and includes each run count', async () => {
    renderer = createCostRenderer();
    const kinds: readonly CostBackgroundRow['kind'][] = [
      'chat_title',
      'branch_name',
      'handoff_summary',
      'commit_message',
      'entry_summary',
      'pull_request_text',
      'pipeline_advisor',
      'other',
    ];
    const rows: CostBackgroundRow[] = kinds.map((kind) => ({
      kind,
      runCount: 1,
      usd: 0.01,
      notPricedCount: 0,
      tokens: breakdownView().chat.totals.tokens,
    }));
    renderView(
      renderer,
      createFakeCostClient({
        chat: ok({
          kind: 'full',
          breakdown: breakdownView({
            bySource: {
              ...breakdownView().bySource,
              background: { usd: 0.08, rows },
            },
          }),
        }),
      }),
    );
    await flush();
    click(byTestId(renderer.container, 'session-breakdown-source-background'));

    for (const label of [
      'Chat title',
      'Branch name',
      'Handoff summary',
      'Commit messages',
      'Entry summary',
      'Pull request text',
      'Workflow Advisor',
      'Other',
    ]) {
      expect(renderer.container.textContent).toContain(label);
    }
  });

  it('shows all token categories and labels reasoning as part of output', async () => {
    renderer = createCostRenderer();
    renderView(renderer);
    await flush();

    expect(
      byTestId(renderer.container, 'session-breakdown-tokens').textContent,
    ).toContain('Part of output');
    expect(
      byTestId(renderer.container, 'session-breakdown-tokens').textContent,
    ).toContain('Cache read');
    expect(
      byTestId(renderer.container, 'session-breakdown-tokens').textContent,
    ).toContain('Cache write');
  });

  it('includes cached input tokens in attributed Codex subagent totals, but not reasoning', async () => {
    renderer = createCostRenderer();
    const base = breakdownView();
    const view = breakdownView({
      bySource: {
        ...base.bySource,
        subagents: {
          ...base.bySource.subagents,
          items: [
            attributedItem({
              kind: 'codex_agent',
              model: 'GPT 6 Sol',
              tokens: {
                input: 90,
                output: 92_975,
                cacheReadInputTokens: 10_848_711,
                cacheCreationInputTokens: 351_582,
                reasoningOutputTokens: 80_000_000,
              },
            }),
          ],
        },
      },
    });
    renderView(
      renderer,
      createFakeCostClient({ chat: ok({ kind: 'full', breakdown: view }) }),
    );
    await flush();

    click(byTestId(renderer.container, 'session-breakdown-source-subagents'));
    const item = byTestId(renderer.container, 'session-breakdown-item-sub-1');
    expect(item.textContent).toContain('11.3M tokens');
    expect(item.textContent).not.toContain('91.3M tokens');
  });

  it('uses a total-only token count for an attributed Codex subagent', async () => {
    renderer = createCostRenderer();
    const base = breakdownView();
    const view = breakdownView({
      bySource: {
        ...base.bySource,
        subagents: {
          ...base.bySource.subagents,
          items: [
            attributedItem({
              kind: 'codex_agent',
              model: 'GPT 6 Sol',
              totalTokens: 11_293_358,
              tokens: {
                input: 0,
                output: 0,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                reasoningOutputTokens: 0,
              },
            }),
          ],
        },
      },
    });
    renderView(
      renderer,
      createFakeCostClient({ chat: ok({ kind: 'full', breakdown: view }) }),
    );
    await flush();

    click(byTestId(renderer.container, 'session-breakdown-source-subagents'));
    const item = byTestId(renderer.container, 'session-breakdown-item-sub-1');
    expect(item.textContent).toContain('11.3M tokens');
    expect(item.textContent).not.toContain('0 tokens');
  });

  it('shows context, peak, compaction totals, and an accessible timeline', async () => {
    renderer = createCostRenderer();
    renderView(renderer, createFakeCostClient(), {
      props: { initialTab: 'context' },
    });
    await flush();

    const context = byTestId(renderer.container, 'session-breakdown-context');
    expect(context.textContent).toContain('120.4k / 200.0k (60%)');
    expect(context.textContent).toContain('174.4k of 200.0k');
    expect(context.textContent).toContain('3: 2 automatic, 1 manual');
    expect(
      context.querySelector('svg[role="img"]')?.getAttribute('aria-label'),
    ).toBe('Context at the end of each turn, 3 compactions');
    expect(context.textContent).toContain(
      'Lines mark compactions; a dashed line was started by hand.',
    );
  });

  it('shows the empty context message when no latest context was reported', async () => {
    renderer = createCostRenderer();
    renderView(
      renderer,
      createFakeCostClient({
        chat: ok({
          kind: 'full',
          breakdown: breakdownView({
            context: { categories: [], timeline: [] },
          }),
        }),
      }),
      { props: { initialTab: 'context' } },
    );
    await flush();

    expect(
      byTestId(renderer.container, 'session-breakdown-context').textContent,
    ).toBe('ContextNo context reported for this chat.');
  });

  it('shows activity statistics and model shares', async () => {
    renderer = createCostRenderer();
    renderView(renderer, createFakeCostClient(), {
      props: { initialTab: 'activity' },
    });
    await flush();

    const activity = byTestId(renderer.container, 'session-breakdown-activity');
    expect(activity.textContent).toContain('42');
    expect(activity.textContent).toContain('Total time');
    expect(activity.textContent).toContain('P95 turn');
    expect(activity.textContent).toContain('388');
    expect(activity.textContent).toContain('9.2');
    expect(
      byTestId(renderer.container, 'session-breakdown-by-model').textContent,
    ).toContain('57%');
  });

  it('seals retained breakdowns without open, refresh, or running state', async () => {
    renderer = createCostRenderer();
    const client = createFakeCostClient({
      chat: ok({
        kind: 'full',
        breakdown: breakdownView({
          sealedAt: '2026-10-06T12:00:00.000Z',
          chat: { ...breakdownView().chat, running: true },
        }),
      }),
    });
    renderView(renderer, client, { scope: RETAINED_SCOPE });
    await flush();

    expect(renderer.container.textContent).toContain('Final as of Oct 6');
    expect(renderer.container.textContent).not.toContain('Running');
    expect(
      renderer.container.querySelector(
        '[data-testid="session-breakdown-open-chat"]',
      ),
    ).toBeNull();
    expect(
      renderer.container.querySelector('[data-testid="cost-refresh"]'),
    ).toBeNull();
    expect(client.refresh).not.toHaveBeenCalled();
  });

  it('manually refreshes cost', async () => {
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
  });

  it('gates capability-off hosts without reading cost', () => {
    renderer = createCostRenderer({ costInsights: false });
    const client = createFakeCostClient();
    renderView(renderer, client);

    expect(renderer.container.textContent).toContain(
      'Cost is not available here.',
    );
    expect(client.getChat).not.toHaveBeenCalled();
  });

  it('shows a failed first read instead of an empty breakdown', async () => {
    renderer = createCostRenderer();
    renderView(
      renderer,
      createFakeCostClient({
        chat: {
          status: 'error',
          reason: 'UNKNOWN',
          message: 'The first breakdown read failed.',
        },
      }),
    );
    await flush();

    expect(renderer.container.textContent).toContain("Couldn't load cost.");
    expect(renderer.container.textContent).toContain(
      'The first breakdown read failed.',
    );
    expect(
      renderer.container.querySelector(
        '[data-testid="session-breakdown-view"]',
      ),
    ).toBeNull();
  });

  it('masks the chat name and item names for session replay', async () => {
    renderer = createCostRenderer();
    renderView(renderer);
    await flush();

    const view = breakdownView();
    const heading = renderer.container.querySelector('h2');
    expect(heading?.textContent).toBe(view.chat.label);
    // The whole name is masked, inside the heading.
    expect(heading?.querySelector('.ph-mask')?.textContent).toBe(
      view.chat.label,
    );
    expect(heading?.getAttribute('title')).toBeNull();

    click(byTestId(renderer.container, 'session-breakdown-source-subagents'));
    const item = byTestId(renderer.container, 'session-breakdown-item-sub-1');
    const label = view.bySource.subagents.items[0]?.label ?? '';
    expect(item.querySelector('.ph-mask')?.textContent).toBe(label);
    // Once as masked text, and in no attribute.
    expect(item.outerHTML.split(label)).toHaveLength(2);
    expect(item.getAttribute('aria-label')).toBeNull();
    expect(item.getAttribute('aria-labelledby')).not.toBeNull();
  });

  it('shows a subagent of a running turn as priced when the turn ends', async () => {
    renderer = createCostRenderer();
    const base = breakdownView();
    renderView(
      renderer,
      createFakeCostClient({
        chat: ok({
          kind: 'full',
          breakdown: breakdownView({
            bySource: {
              ...base.bySource,
              subagents: {
                usd: 0,
                items: [
                  attributedItem({
                    usd: undefined,
                    costStatus: 'not_priced',
                    status: 'running',
                  }),
                ],
              },
            },
          }),
        }),
      }),
    );
    await flush();

    click(byTestId(renderer.container, 'session-breakdown-source-subagents'));
    const row = byTestId(renderer.container, 'session-breakdown-item-sub-1');
    expect(row.textContent).toContain('Priced when the turn ends');
    expect(row.textContent).not.toContain('Not priced');
  });

  it("labels tools by name and the app's own tools by the host's app name", async () => {
    const view = breakdownView();
    const withTools = breakdownView({
      activity: {
        ...view.activity,
        topTools: [
          { tool: 'canopy', count: 7 },
          { tool: 'readLines', count: 5 },
          { tool: 'bash', count: 2 },
        ],
      },
    });
    const labels = (): (string | null)[] =>
      Array.from(
        byTestId(
          renderer?.container ?? document,
          'session-breakdown-top-tools',
        ).querySelectorAll('[data-settings-row-label]'),
      ).map((term) => term.textContent);

    renderer = createCostRenderer();
    renderView(
      renderer,
      createFakeCostClient({
        chat: ok({ kind: 'full', breakdown: withTools }),
      }),
      { props: { appName: 'Acme Code' } },
    );
    await flush();
    click(byTestId(renderer.container, 'session-breakdown-tab-activity'));
    expect(labels()).toEqual(['Acme Code', 'Read lines', 'Bash']);
    renderer.unmount();

    // A host that names no app falls back to a neutral label.
    renderer = createCostRenderer();
    renderView(
      renderer,
      createFakeCostClient({
        chat: ok({ kind: 'full', breakdown: withTools }),
      }),
    );
    await flush();
    click(byTestId(renderer.container, 'session-breakdown-tab-activity'));
    expect(labels()).toEqual(['Built-in', 'Read lines', 'Bash']);
  });
});
