/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CostFreshness } from '../CostFreshness';
import { CostLegend } from '../CostLegend';
import { CostObservedTotal } from '../CostObservedTotal';
import { CostRow } from '../CostRow';
import { CostSplitBar } from '../CostSplitBar';
import type { CostSegment } from '../cost-format';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const SEGMENTS: readonly CostSegment[] = [
  {
    key: 'chat',
    label: 'Chat turns',
    value: 3,
    color: 'var(--primitive-blue-500)',
  },
  {
    key: 'subagents',
    label: 'Subagents',
    value: 1,
    color: 'var(--primitive-purple-500)',
  },
  {
    key: 'background',
    label: 'Background',
    value: 0,
    color: 'var(--primitive-green-500)',
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function byTestId(testId: string): HTMLElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing ${testId}`);
  }
  return element;
}

describe('CostSplitBar', () => {
  it('labels visible parts and amounts, normalizes segment growth, and applies scale', () => {
    act(() =>
      root.render(
        <CostSplitBar
          segments={SEGMENTS}
          label="Fix flaky checkout test cost"
          scale={0.6}
          testId="split-bar"
        />,
      ),
    );

    const bar = byTestId('split-bar');
    expect(bar.getAttribute('role')).toBe('img');
    expect(bar.getAttribute('aria-label')).toBe(
      'Fix flaky checkout test cost: Chat turns $3.00, Subagents $1.00',
    );
    const filled = bar.firstElementChild;
    expect(filled).not.toBeNull();
    expect((filled as HTMLElement).style.width).toBe('60%');
    const parts = Array.from(filled?.children ?? []) as HTMLElement[];
    const shares = parts.map((part) => Number(part.style.flexGrow));
    expect(shares).toEqual([0.75, 0.25]);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(1);
    expect(parts.every((part) => part.style.flexBasis === '0px')).toBe(true);
  });

  it('labels an empty meter as none and draws no filled segments', () => {
    act(() =>
      root.render(
        <CostSplitBar
          segments={[]}
          label="Cost in this entry"
          testId="empty-split-bar"
        />,
      ),
    );

    const bar = byTestId('empty-split-bar');
    expect(bar.getAttribute('aria-label')).toBe('Cost in this entry: none');
    expect(bar.firstElementChild).toBeNull();
  });
});

describe('CostLegend', () => {
  it('skips zero values and shows inline shares in tertiary ink', () => {
    act(() =>
      root.render(
        <CostLegend segments={SEGMENTS} showShare testId="inline-legend" />,
      ),
    );

    const legend = byTestId('inline-legend');
    expect(
      Array.from(legend.querySelectorAll('dt')).map((item) => item.textContent),
    ).toEqual(['Chat turns', 'Subagents']);
    expect(legend.textContent).toContain('$3.00');
    expect(legend.textContent).toContain('75%');
    expect(legend.textContent).toContain('$1.00');
    expect(legend.textContent).toContain('25%');
    expect(legend.querySelectorAll('dd')).toHaveLength(4);
    expect(legend.querySelectorAll('dd')[1]?.className).toContain(
      'fg-tertiary',
    );
  });

  it('lists one value row per part with its swatch, amount and share', () => {
    act(() =>
      root.render(
        <CostLegend
          segments={SEGMENTS}
          showShare
          layout="list"
          testId="list-legend"
        />,
      ),
    );

    const legend = byTestId('list-legend');
    expect(legend.getAttribute('data-surface')).toBe('list');
    expect(legend.querySelector('dl')).toBeNull();
    expect(legend.children).toHaveLength(2);
    expect(legend.children[0]?.textContent).toBe('Chat turns$3.0075%');
    expect(legend.children[1]?.textContent).toBe('Subagents$1.0025%');
    expect(legend.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
  });
});

describe('CostRow', () => {
  it('names an interactive row, marks selected state, and opens on click', () => {
    const onOpen = jest.fn();
    act(() =>
      root.render(
        <CostRow
          name="Fix flaky checkout test"
          archived
          running
          amountLabel="$3.10"
          segments={SEGMENTS}
          scale={1}
          selected
          onOpen={onOpen}
          testId="archived-row"
        />,
      ),
    );

    const button = byTestId('archived-row');
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-label')).toBe(
      'Fix flaky checkout test, archived, $3.10',
    );
    expect(button.getAttribute('aria-current')).toBe('true');
    expect(button.tabIndex).toBe(0);
    expect(button.querySelector('.sr-only')?.textContent).toBe('Archived');
    expect(
      button.querySelector('[title="Fix flaky checkout test"]'),
    ).not.toBeNull();

    act(() => button.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('masks a user-written name and keeps it out of recorded attributes', () => {
    act(() =>
      root.render(
        <CostRow
          name="Private launch plan"
          maskName
          archived
          amountLabel="$3.10"
          segments={SEGMENTS}
          scale={1}
          onOpen={jest.fn()}
          testId="masked-row"
        />,
      ),
    );

    const button = byTestId('masked-row');
    const name = button.querySelector('.ph-mask');
    expect(name?.textContent).toBe('Private launch plan');
    // Replay records attributes verbatim, so the name is in none of them.
    const attributes = [button, ...Array.from(button.querySelectorAll('*'))]
      .flatMap((element) => Array.from(element.attributes))
      .map((attribute) => attribute.value);
    expect(
      attributes.filter((value) => value.includes('Private launch plan')),
    ).toEqual([]);
    // The accessible name still reads the name, the state and the amount.
    const labelledBy = (button.getAttribute('aria-labelledby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent);
    expect(labelledBy).toEqual(['Private launch plan', 'Archived', '$3.10']);
  });

  it('uses running in the accessible name when the row is not archived', () => {
    act(() =>
      root.render(
        <CostRow
          name="Add cost index checkpoints"
          running
          amountLabel="$6.84"
          segments={SEGMENTS}
          scale={0.5}
          onOpen={jest.fn()}
          testId="running-row"
        />,
      ),
    );

    const button = byTestId('running-row');
    expect(button.getAttribute('aria-label')).toBe(
      'Add cost index checkpoints, running, $6.84',
    );
    expect(button.querySelector('.sr-only')?.textContent).toBe('Running');
  });

  it('keeps a row static without an open callback and shows starts only at panel density', () => {
    act(() =>
      root.render(
        <CostRow
          name="Release checks"
          startedLabel="Today 9:12 AM"
          amountLabel="$1.10"
          segments={SEGMENTS}
          scale={1}
          testId="static-panel-row"
        />,
      ),
    );
    expect(byTestId('static-panel-row').tagName).toBe('DIV');
    expect(container.querySelector('button')).toBeNull();
    expect(byTestId('static-panel-row').textContent).toContain('Today 9:12 AM');

    act(() =>
      root.render(
        <CostRow
          name="Release checks"
          startedLabel="Today 9:12 AM"
          amountLabel="$1.10"
          segments={SEGMENTS}
          scale={1}
          density="card"
          testId="static-card-row"
        />,
      ),
    );
    expect(byTestId('static-card-row').textContent).not.toContain(
      'Today 9:12 AM',
    );
  });

  it('does not mark an unselected button current', () => {
    act(() =>
      root.render(
        <CostRow
          name="Open chat"
          amountLabel="$0.62"
          segments={SEGMENTS}
          scale={0.3}
          onOpen={jest.fn()}
        />,
      ),
    );
    expect(
      container.querySelector('button')?.hasAttribute('aria-current'),
    ).toBe(false);
  });
});

describe('CostFreshness', () => {
  it('shows relative freshness and keeps the time while refresh is busy', () => {
    const now = Date.parse('2026-10-08T12:00:00.000Z');
    const onRefresh = jest.fn();
    act(() =>
      root.render(
        <CostFreshness
          updatedAt={new Date(now - 4 * 60_000).toISOString()}
          now={now}
          refreshing
          onRefresh={onRefresh}
        />,
      ),
    );

    expect(byTestId('cost-freshness-label').textContent).toBe(
      'Updated 4 min ago',
    );
    const refresh = byTestId('cost-refresh') as HTMLButtonElement;
    expect(refresh.getAttribute('aria-label')).toBe(
      'Refresh cost (in progress)',
    );
    expect(refresh.disabled).toBe(true);
  });

  it('shows failure copy with its tooltip reason', () => {
    act(() =>
      root.render(
        <CostFreshness
          updatedAt="2026-10-08T11:56:00.000Z"
          now={Date.parse('2026-10-08T12:00:00.000Z')}
          failureReason="The activity log could not be read."
        />,
      ),
    );

    const label = byTestId('cost-freshness-label');
    expect(label.textContent).toBe("Couldn't refresh");
    expect(label.className).toContain('fg-warning');
    act(() => {
      label.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'The activity log could not be read.',
    );
  });

  it('shows the sealed date without a refresh button', () => {
    act(() =>
      root.render(
        <CostFreshness
          updatedAt={null}
          sealedAt="2026-10-06"
          onRefresh={jest.fn()}
        />,
      ),
    );

    expect(byTestId('cost-freshness-label').textContent).toBe(
      'Final as of Oct 6',
    );
    expect(container.querySelector('[data-testid="cost-refresh"]')).toBeNull();
  });

  it('uses the shared refresh button and announces only post-mount completions', () => {
    const now = Date.parse('2026-10-08T12:00:00.000Z');
    const onRefresh = jest.fn();
    act(() =>
      root.render(
        <CostFreshness
          updatedAt={new Date(now).toISOString()}
          now={now}
          completedRefreshes={4}
          onRefresh={onRefresh}
        />,
      ),
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(byTestId('cost-refresh').getAttribute('aria-label')).toBe(
      'Refresh cost',
    );
    act(() => byTestId('cost-refresh').click());
    expect(onRefresh).toHaveBeenCalledTimes(1);

    act(() =>
      root.render(
        <CostFreshness
          updatedAt={new Date(now).toISOString()}
          now={now}
          completedRefreshes={5}
          onRefresh={onRefresh}
        />,
      ),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Cost updated',
    );
  });
});

describe('CostObservedTotal', () => {
  it('shows observed without coverage and observed since a coverage day', () => {
    act(() =>
      root.render(
        <CostObservedTotal amountLabel="$21.66" testId="plain-total" />,
      ),
    );
    expect(byTestId('plain-total-amount').textContent).toBe('$21.66');
    expect(byTestId('plain-total').textContent).toBe('$21.66observed');

    act(() =>
      root.render(
        <CostObservedTotal
          amountLabel="Not priced"
          coverageStart="2026-10-01"
          size="inline"
          testId="covered-total"
        />,
      ),
    );
    expect(byTestId('covered-total').textContent).toBe(
      'Not pricedobserved since Oct 1',
    );
    expect(byTestId('covered-total-amount').className).toContain('text-s');
  });
});
