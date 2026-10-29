/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { StatTable, type StatColumn } from '../StatTable';

interface Row {
  id: string;
  name: string;
  score: number;
  rate?: number | null;
}

const ROWS: Row[] = [
  { id: 'a', name: 'Bravo', score: 5 },
  { id: 'b', name: 'Alpha', score: 9 },
  { id: 'c', name: 'Charlie', score: 1 },
];

// Charlie has a "missing" rate (null) which must always sort to the bottom.
const RATE_ROWS: Row[] = [
  { id: 'a', name: 'Bravo', score: 5, rate: 0.5 },
  { id: 'b', name: 'Alpha', score: 9, rate: 0.9 },
  { id: 'c', name: 'Charlie', score: 1, rate: null },
];

const RATE_COLUMNS: Array<StatColumn<Row>> = [
  { key: 'name', header: 'Name', render: (row) => row.name },
  {
    key: 'rate',
    header: 'Rate',
    align: 'right',
    sortValue: (row) => row.rate ?? null,
    render: (row) => (row.rate == null ? '—' : `${row.rate}`),
  },
];

const SORTABLE_COLUMNS: Array<StatColumn<Row>> = [
  {
    key: 'name',
    header: 'Name',
    sortValue: (row) => row.name,
    render: (row) => row.name,
  },
  {
    key: 'score',
    header: 'Score',
    align: 'right',
    sortValue: (row) => row.score,
    render: (row) => row.score,
  },
];

const STATIC_COLUMNS: Array<StatColumn<Row>> = [
  { key: 'name', header: 'Name', render: (row) => row.name },
  { key: 'score', header: 'Score', render: (row) => row.score },
];

describe('StatTable sorting', () => {
  let container: HTMLElement;
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

  function bodyNames(): string[] {
    return Array.from(
      container.querySelectorAll('tbody tr td:first-child'),
    ).map((cell) => cell.textContent ?? '');
  }

  it('renders static (input-order) rows with no header buttons when not sortable', () => {
    act(() => {
      root.render(
        <StatTable
          columns={STATIC_COLUMNS}
          rows={ROWS}
          rowKey={(row) => row.id}
          emptyLabel="empty"
        />,
      );
    });
    expect(bodyNames()).toEqual(['Bravo', 'Alpha', 'Charlie']);
    expect(container.querySelectorAll('thead button')).toHaveLength(0);
  });

  it('sorts by the default sort key descending on first render', () => {
    act(() => {
      root.render(
        <StatTable
          columns={SORTABLE_COLUMNS}
          rows={ROWS}
          rowKey={(row) => row.id}
          emptyLabel="empty"
          testId="t"
          defaultSortKey="score"
        />,
      );
    });
    expect(bodyNames()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    const scoreHeader = container.querySelector('th[scope="col"]:last-child');
    expect(scoreHeader?.getAttribute('aria-sort')).toBe('descending');
  });

  it.each([
    {
      name: 'toggles direction when the active sort header is clicked again',
      column: 'score',
      expectedNames: ['Charlie', 'Bravo', 'Alpha'],
    },
    // Name desc: Charlie, Bravo, Alpha
    {
      name: 'switches the active column and defaults it to descending',
      column: 'name',
      expectedNames: ['Charlie', 'Bravo', 'Alpha'],
    },
  ])('$name', ({ column, expectedNames }) => {
    act(() => {
      root.render(
        <StatTable
          columns={SORTABLE_COLUMNS}
          rows={ROWS}
          rowKey={(row) => row.id}
          emptyLabel="empty"
          testId="t"
          defaultSortKey="score"
        />,
      );
    });
    const button = container.querySelector<HTMLButtonElement>(
      `[data-testid="t-sort-${column}"]`,
    );
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(bodyNames()).toEqual(expectedNames);
  });

  it('keeps missing (null) sort values at the bottom in both directions', () => {
    act(() => {
      root.render(
        <StatTable
          columns={RATE_COLUMNS}
          rows={RATE_ROWS}
          rowKey={(row) => row.id}
          emptyLabel="empty"
          testId="t"
          defaultSortKey="rate"
        />,
      );
    });
    // Descending: highest rate first, missing last.
    expect(bodyNames()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    const rateButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="t-sort-rate"]',
    );
    act(() => {
      rateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Ascending: lowest real rate first, but missing STILL last.
    expect(bodyNames()).toEqual(['Bravo', 'Alpha', 'Charlie']);
  });

  it('renders a spanning group header row when columnGroups is provided', () => {
    act(() => {
      root.render(
        <StatTable
          columns={SORTABLE_COLUMNS}
          rows={ROWS}
          rowKey={(row) => row.id}
          emptyLabel="empty"
          defaultSortKey="score"
          columnGroups={[
            { label: 'Identity', span: 1 },
            { label: 'Metrics', span: 1 },
          ]}
        />,
      );
    });
    const groupCells = container.querySelectorAll('th[scope="colgroup"]');
    expect(Array.from(groupCells).map((c) => c.textContent)).toEqual([
      'Identity',
      'Metrics',
    ]);
    expect(groupCells[1]?.getAttribute('colspan')).toBe('1');
  });
});
