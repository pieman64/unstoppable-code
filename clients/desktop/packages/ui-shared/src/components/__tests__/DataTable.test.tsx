/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableFrame,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
  type DataTableColumn,
  type DataTableProps,
} from '../DataTable';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

interface Person {
  name: string;
  chats: number | null;
}

const PEOPLE: readonly Person[] = [
  { name: 'Kai', chats: 96 },
  { name: 'Ana', chats: null },
  { name: 'Sam', chats: 128 },
];

const COLUMNS: ReadonlyArray<DataTableColumn<Person>> = [
  {
    key: 'name',
    header: 'Person',
    render: (row) => row.name,
    sortValue: (row) => row.name,
  },
  {
    key: 'chats',
    header: 'Chats',
    align: 'right',
    render: (row) => (row.chats === null ? '—' : row.chats),
    sortValue: (row) => row.chats,
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderTable(props: Partial<DataTableProps<Person>> = {}): void {
  act(() => {
    root.render(
      <DataTable<Person>
        columns={COLUMNS}
        rows={PEOPLE}
        rowKey={(row) => row.name}
        testId="people"
        {...props}
      />,
    );
  });
}

function firstColumn(): string[] {
  return Array.from(container.querySelectorAll('tbody tr')).map(
    (row) => row.querySelector('td, th')?.textContent ?? '',
  );
}

function click(element: Element | null): void {
  if (!(element instanceof HTMLElement)) throw new Error('missing element');
  act(() => element.click());
}

describe('DataTable', () => {
  it('keeps the input order when no sort is set and labels have no sort buttons', () => {
    renderTable();

    expect(firstColumn()).toEqual(['Kai', 'Ana', 'Sam']);
    expect(container.querySelector('th button')).toBeNull();
    expect(container.querySelector('th[aria-sort]')).toBeNull();
  });

  it('sorts by the default column and flips direction on a second click', () => {
    renderTable({ defaultSort: { key: 'chats', direction: 'desc' } });

    // A missing value sorts last in both directions.
    expect(firstColumn()).toEqual(['Sam', 'Kai', 'Ana']);
    const chats = container.querySelector('[data-testid="people-sort-chats"]');
    expect(chats?.closest('th')?.getAttribute('aria-sort')).toBe('descending');

    click(chats);
    expect(firstColumn()).toEqual(['Kai', 'Sam', 'Ana']);
    expect(chats?.closest('th')?.getAttribute('aria-sort')).toBe('ascending');
  });

  it('starts a text column ascending and reports the sort to a controlling caller', () => {
    const onSortChange = jest.fn();
    renderTable({ sort: null, onSortChange });

    click(container.querySelector('[data-testid="people-sort-name"]'));

    expect(onSortChange).toHaveBeenCalledWith({
      key: 'name',
      direction: 'asc',
    });
    // The caller owns the sort, so nothing moves until it passes one back.
    expect(firstColumn()).toEqual(['Kai', 'Ana', 'Sam']);

    renderTable({ sort: { key: 'name', direction: 'asc' }, onSortChange });
    expect(firstColumn()).toEqual(['Ana', 'Kai', 'Sam']);
  });

  it('shows the empty line in place of rows', () => {
    renderTable({ rows: [], emptyLabel: 'No activity yet' });

    const empty = container.querySelector('[data-testid="people-empty"]');
    expect(empty?.textContent).toBe('No activity yet');
    expect(empty?.closest('td')?.getAttribute('colspan')).toBe('2');
    // The header stays, so the empty table still says what it lists.
    expect(container.querySelector('thead')?.textContent).toContain('Person');
  });

  it('shows placeholder rows with one loading status while loading', () => {
    renderTable({ loading: true, loadingRows: 4 });

    expect(container.querySelectorAll('tbody tr')).toHaveLength(4);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('table')?.getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(container.textContent).not.toContain('Kai');
  });

  it('activates a row on click and Enter, but not from a control inside it', () => {
    const onRowActivate = jest.fn();
    act(() => {
      root.render(
        <DataTable<Person>
          columns={[
            ...COLUMNS,
            {
              key: 'actions',
              header: 'Actions',
              headerHidden: true,
              render: (): JSX.Element => <button type="button">Edit</button>,
            },
          ]}
          rows={PEOPLE}
          rowKey={(row) => row.name}
          onRowActivate={onRowActivate}
          isRowInert={(row) => row.name === 'Ana'}
          rowAttributes={(row) => ({ 'data-person': row.name })}
        />,
      );
    });

    const kai = container.querySelector('[data-person="Kai"]');
    click(kai?.querySelector('td') ?? null);
    expect(onRowActivate).toHaveBeenLastCalledWith(PEOPLE[0]);

    click(kai?.querySelector('button') ?? null);
    expect(onRowActivate).toHaveBeenCalledTimes(1);

    act(() => {
      kai?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onRowActivate).toHaveBeenCalledTimes(2);
    expect(kai?.getAttribute('tabindex')).toBe('0');

    const ana = container.querySelector('[data-person="Ana"]');
    click(ana?.querySelector('td') ?? null);
    expect(onRowActivate).toHaveBeenCalledTimes(2);
    expect(ana?.hasAttribute('tabindex')).toBe(false);

    // The actions header is named for screen readers only.
    expect(container.querySelector('thead .sr-only')?.textContent).toBe(
      'Actions',
    );
  });

  it('activates a row rendered into another window, such as a popped-out panel', () => {
    // An auxiliary window is another realm: its elements fail `instanceof
    // Element` from this one, so the row guard must not rely on it.
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const otherDocument = frame.contentDocument;
    if (otherDocument === null) throw new Error('missing iframe document');
    const host = otherDocument.createElement('div');
    otherDocument.body.append(host);
    const otherRoot = createRoot(host);
    const onRowActivate = jest.fn();
    act(() =>
      otherRoot.render(
        <DataTable<Person>
          columns={COLUMNS}
          rows={PEOPLE}
          rowKey={(row) => row.name}
          onRowActivate={onRowActivate}
        />,
      ),
    );
    const cell = host.querySelector('tbody td');
    if (cell === null || !('click' in cell)) throw new Error('missing cell');
    act(() => {
      cell.dispatchEvent(
        new (otherDocument.defaultView ?? window).MouseEvent('click', {
          bubbles: true,
        }),
      );
    });
    expect(onRowActivate).toHaveBeenCalledWith(PEOPLE[0]);
    act(() => otherRoot.unmount());
    frame.remove();
  });

  it('keeps a floor under a column that yields its width', () => {
    renderTable({
      columns: [{ ...COLUMNS[0], minWidth: '10rem' }, COLUMNS[1]],
    });
    const header = container.querySelector('thead th');
    expect(header instanceof HTMLElement && header.style.minWidth).toBe(
      '10rem',
    );
  });

  it('inks a cell per row when a column picks its tone from the row', () => {
    renderTable({
      columns: [
        COLUMNS[0] ?? {
          key: 'name',
          header: 'Person',
          render: (): null => null,
        },
        {
          key: 'status',
          header: 'Status',
          tone: (row): 'secondary' | 'success' =>
            row.chats === null ? 'secondary' : 'success',
          render: (row): string => (row.chats === null ? 'Idle' : 'Active'),
        },
      ],
    });
    const statusCells = Array.from(
      container.querySelectorAll('tbody tr td:last-child'),
    );
    expect(
      statusCells.map((cell) => cell.classList.contains('fg-success')),
    ).toEqual([true, false, true]);
  });

  it('marks the selected row as current', () => {
    renderTable({ selectedRowKey: 'Sam', onRowActivate: () => undefined });

    const current = container.querySelectorAll('tbody tr[aria-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain('Sam');
  });

  it('renders a group row above the column labels', () => {
    renderTable({ columnGroups: [{ label: 'Activity', span: 2 }] });

    const group = container.querySelector('th[scope="colgroup"]');
    expect(group?.textContent).toBe('Activity');
    expect(group?.getAttribute('colspan')).toBe('2');
    expect(container.querySelectorAll('thead tr')).toHaveLength(2);
  });
});

describe('DataTable parts', () => {
  function Grouped(): JSX.Element {
    return (
      <DataTableFrame caption="Readiness">
        <DataTableHead>
          <DataTableHeaderCell>Project</DataTableHeaderCell>
          <DataTableHeaderCell>Issue</DataTableHeaderCell>
        </DataTableHead>
        <DataTableBody>
          <DataTableRow>
            <DataTableCell rowHeader rowSpan={2} tone="primary">
              Canopy
            </DataTableCell>
            <DataTableCell>No setup script</DataTableCell>
          </DataTableRow>
          <DataTableRow>
            <DataTableCell>No hooks</DataTableCell>
          </DataTableRow>
        </DataTableBody>
      </DataTableFrame>
    );
  }

  it('compose a table whose row header spans its group', () => {
    act(() => root.render(<Grouped />));

    expect(container.querySelector('caption')?.textContent).toBe('Readiness');
    const header = container.querySelector('tbody th');
    expect(header?.textContent).toBe('Canopy');
    expect(header?.getAttribute('rowspan')).toBe('2');
    // scope="row" would claim only the first of the two rows it heads.
    expect(header?.hasAttribute('scope')).toBe(false);
    // A row with no activate handler is not a tab stop.
    expect(container.querySelector('tbody tr[tabindex]')).toBeNull();
  });
});

describe('DataTableFrame', () => {
  function setScrollGeometry(
    element: Element,
    geometry: { scrollWidth: number; clientWidth: number; scrollLeft: number },
  ): void {
    for (const [key, value] of Object.entries(geometry)) {
      Object.defineProperty(element, key, { configurable: true, value });
    }
    act(() => {
      element.dispatchEvent(new Event('scroll'));
    });
  }

  it('becomes a named, focusable region that fades its hidden side only while it scrolls', () => {
    act(() =>
      root.render(
        <DataTableFrame caption="MCP servers" testId="frame">
          <DataTableHead>
            <DataTableHeaderCell>Name</DataTableHeaderCell>
          </DataTableHead>
        </DataTableFrame>,
      ),
    );
    // The table scrolls inside the card, in the box that holds it.
    const frame = container.querySelector(
      '[data-testid="frame"] table',
    )?.parentElement;
    if (!frame) throw new Error('missing frame');
    // A table that fits adds no focus stop and no fade.
    expect(frame.getAttribute('role')).toBeNull();
    expect(frame.hasAttribute('tabindex')).toBe(false);
    expect(frame.hasAttribute('data-overflow')).toBe(false);

    setScrollGeometry(frame, {
      scrollWidth: 800,
      clientWidth: 400,
      scrollLeft: 0,
    });
    expect(frame.getAttribute('data-overflow')).toBe('end');
    expect(frame.getAttribute('role')).toBe('region');
    expect(frame.getAttribute('aria-label')).toBe('MCP servers');
    expect(frame.getAttribute('tabindex')).toBe('0');

    setScrollGeometry(frame, {
      scrollWidth: 800,
      clientWidth: 400,
      scrollLeft: 200,
    });
    expect(frame.getAttribute('data-overflow')).toBe('both');

    setScrollGeometry(frame, {
      scrollWidth: 800,
      clientWidth: 400,
      scrollLeft: 400,
    });
    expect(frame.getAttribute('data-overflow')).toBe('start');
  });
});
