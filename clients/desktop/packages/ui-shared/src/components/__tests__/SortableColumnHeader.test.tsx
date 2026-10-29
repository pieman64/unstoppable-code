/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SortableColumnHeader,
  type SortDirection,
} from '../SortableColumnHeader';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

type Column = 'name' | 'status';

interface HarnessProps {
  activeColumn: Column | null;
  direction: SortDirection | null;
  onToggle: (column: Column) => void;
}

// Headers must sit inside a real table row, otherwise React warns about
// invalid DOM nesting and jsdom reparents the `<th>`.
function Harness({
  activeColumn,
  direction,
  onToggle,
}: HarnessProps): JSX.Element {
  return (
    <table>
      <thead>
        <tr>
          <SortableColumnHeader
            label="Name"
            column="name"
            activeColumn={activeColumn}
            direction={direction}
            onToggle={onToggle}
            className="w-35"
            testId="sort-name"
          />
          <SortableColumnHeader
            label="Status"
            column="status"
            activeColumn={activeColumn}
            direction={direction}
            onToggle={onToggle}
            testId="sort-status"
          />
        </tr>
      </thead>
    </table>
  );
}

describe('SortableColumnHeader', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(props: HarnessProps): void {
    act(() => {
      root.render(<Harness {...props} />);
    });
  }

  function button(testId: string): HTMLButtonElement {
    const element = container.querySelector(`[data-testid="${testId}"]`);
    if (!(element instanceof HTMLButtonElement)) {
      throw new Error(`Expected a button with testid ${testId}`);
    }
    return element;
  }

  function header(testId: string): HTMLTableCellElement {
    const element = button(testId).closest('th');
    if (element === null) {
      throw new Error(`Expected ${testId} to sit inside a th`);
    }
    return element;
  }

  it('reports no sort on every header while unsorted', () => {
    render({ activeColumn: null, direction: null, onToggle: jest.fn() });

    expect(header('sort-name').getAttribute('aria-sort')).toBe('none');
    expect(button('sort-name').getAttribute('data-sort-direction')).toBe(
      'none',
    );
    expect(header('sort-status').getAttribute('aria-sort')).toBe('none');
    expect(button('sort-status').getAttribute('data-sort-direction')).toBe(
      'none',
    );
  });

  it('reports ascending on the active column only', () => {
    render({ activeColumn: 'name', direction: 'asc', onToggle: jest.fn() });

    expect(header('sort-name').getAttribute('aria-sort')).toBe('ascending');
    expect(button('sort-name').getAttribute('data-sort-direction')).toBe('asc');
    // A set direction belongs to the active column; other headers stay `none`.
    expect(header('sort-status').getAttribute('aria-sort')).toBe('none');
    expect(button('sort-status').getAttribute('data-sort-direction')).toBe(
      'none',
    );
  });

  it('reports descending on the active column', () => {
    render({ activeColumn: 'status', direction: 'desc', onToggle: jest.fn() });

    expect(header('sort-status').getAttribute('aria-sort')).toBe('descending');
    expect(button('sort-status').getAttribute('data-sort-direction')).toBe(
      'desc',
    );
    expect(header('sort-name').getAttribute('aria-sort')).toBe('none');
  });

  it('treats an active column without a direction as unsorted', () => {
    render({ activeColumn: 'name', direction: null, onToggle: jest.fn() });

    expect(header('sort-name').getAttribute('aria-sort')).toBe('none');
    expect(button('sort-name').getAttribute('data-sort-direction')).toBe(
      'none',
    );
  });

  it('puts className on the th and the test id on a type="button" control', () => {
    render({ activeColumn: null, direction: null, onToggle: jest.fn() });

    const th = header('sort-name');
    expect(th.getAttribute('scope')).toBe('col');
    expect(th.className).toBe('px-3 py-2 w-35');
    expect(header('sort-status').className).toBe('px-3 py-2');
    expect(th.hasAttribute('data-testid')).toBe(false);
    expect(button('sort-name').type).toBe('button');
    expect(button('sort-name').textContent).toBe('Name');
  });

  it('keeps the direction hint mounted but hidden while inactive', () => {
    render({ activeColumn: 'name', direction: 'desc', onToggle: jest.fn() });

    const activeIcon = button('sort-name').querySelector('svg');
    const inactiveIcon = button('sort-status').querySelector('svg');
    expect(activeIcon?.getAttribute('class')).toContain('rotate-180');
    expect(activeIcon?.getAttribute('class')).not.toContain('opacity-0');
    // The slot is reserved so revealing the hint never shifts the header.
    expect(inactiveIcon).not.toBeNull();
    expect(inactiveIcon?.getAttribute('class')).toContain('opacity-0');
    expect(inactiveIcon?.getAttribute('class')).not.toContain('rotate-180');
  });

  it('calls onToggle once with its column when clicked', () => {
    const onToggle = jest.fn<void, [Column]>();
    render({ activeColumn: null, direction: null, onToggle });

    act(() => {
      button('sort-status').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('status');
  });
});
