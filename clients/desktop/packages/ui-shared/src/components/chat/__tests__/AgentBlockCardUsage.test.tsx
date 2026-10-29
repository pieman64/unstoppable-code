/** @jest-environment jsdom */

import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentBlockCard, type AgentBlockUsage } from '../AgentBlockCard';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The expanded card's usage cells, or null when it renders no usage row. */
function usageCells(node: ReactNode): string[] | null {
  const container = document.createElement('div');
  const root = createRoot(container);
  act((): void => root.render(node));
  const toggle = container.querySelector<HTMLButtonElement>('[aria-expanded]');
  if (!toggle) throw new Error('Agent card expand control was not rendered.');
  act((): void => toggle.click());
  const grid = container.querySelector(
    '[data-testid="agent-block-usage-grid"]',
  );
  const cells =
    grid === null
      ? null
      : Array.from(grid.children, (cell) => cell.textContent ?? '');
  act((): void => root.unmount());
  return cells;
}

function cellsFor(usage: AgentBlockUsage): string[] | null {
  return usageCells(<AgentBlockCard subagentType="Explore" usage={usage} />);
}

describe('AgentBlockCard usage cells', () => {
  it('formats the desktop usage layout', () => {
    expect(
      cellsFor({
        contextTokens: 48_400,
        contextWindow: 400_000,
        outputTokens: 3_400,
        toolUses: 5,
        apiCalls: 7,
        durationMs: 83_000,
        model: 'claude-sonnet-4-5',
      }),
    ).toEqual([
      '48.4k / 400.0k context (12.1%)',
      '3.4k output',
      '5 tool uses',
      '7 API calls',
      '1m 23s',
      'claude-sonnet-4-5',
    ]);
  });

  it('assumes a 200k window and caps the fill at 100%', () => {
    expect(cellsFor({ contextTokens: 50_000, apiCalls: 1 })).toEqual([
      '50.0k / 200.0k context (25.0%)',
      '1 API call',
    ]);
    expect(
      cellsFor({ contextTokens: 300_000, contextWindow: 0, apiCalls: 1 }),
    ).toEqual(['300.0k / 200.0k context (100.0%)', '1 API call']);
  });

  it('shows no row before the first API call', () => {
    expect(
      cellsFor({ contextTokens: 1_000, outputTokens: 10, apiCalls: 0 }),
    ).toBeNull();
  });

  it('shows the cells a host has when it does not count API calls', () => {
    expect(
      cellsFor({ toolUses: 1, durationMs: 4_500, inputTokens: 900 }),
    ).toEqual(['1 tool use', '5s']);
    expect(cellsFor({ inputTokens: 900, totalCostUsd: 0.4 })).toBeNull();
  });

  it('keeps a host override in place of the default cells', () => {
    expect(
      usageCells(
        <AgentBlockCard
          subagentType="Explore"
          usage={{}}
          usageOverride={<span>3 tool calls</span>}
        />,
      ),
    ).toEqual(['3 tool calls']);
  });
});
