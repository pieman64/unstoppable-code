/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SharedContainerPastSharesList,
  type SharedContainerPastSharesListProps,
} from '../SharedContainerPastSharesList';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TEST_ID = 'shared-container-past-shares';

let container: HTMLDivElement;
let root: Root;

function query(suffix = ''): HTMLElement | null {
  return container.querySelector(`[data-testid="${TEST_ID}${suffix}"]`);
}

function rowIds(group: 'removed' | 'accepted'): string[] {
  return Array.from(
    query(`-${group}`)?.querySelectorAll(
      `[data-testid^="${TEST_ID}-${group}-row-"]`,
    ) ?? [],
  ).map((row) =>
    (row.getAttribute('data-testid') ?? '').replace(
      `${TEST_ID}-${group}-row-`,
      '',
    ),
  );
}

const REMOVED = [
  {
    id: 'r-old',
    title: 'Old plan',
    ownerName: 'Dana',
    dismissedAt: '2026-09-01T00:00:00.000Z',
  },
  {
    id: 'r-new',
    title: 'New plan',
    ownerName: 'Sam',
    dismissedAt: '2026-10-01T00:00:00.000Z',
  },
];
const ACCEPTED = [
  { id: 'a-undated', title: 'Legacy share', ownerName: 'Dana' },
  {
    id: 'a-old',
    title: 'Billing',
    ownerName: 'Dana',
    acceptedAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 'a-new',
    title: 'Checkout',
    ownerName: 'Sam',
    acceptedAt: '2026-10-02T00:00:00.000Z',
  },
];

function render(overrides: Partial<SharedContainerPastSharesListProps> = {}): {
  onRestore: jest.Mock;
  onOpenAccepted: jest.Mock;
  onRetryRemoved: jest.Mock;
} {
  const handlers = {
    onRestore: jest.fn(),
    onOpenAccepted: jest.fn(),
    onRetryRemoved: jest.fn(),
  };
  act(() => {
    root.render(
      <SharedContainerPastSharesList
        removed={REMOVED}
        accepted={ACCEPTED}
        removedStatus="success"
        restoringIds={[]}
        {...handlers}
        {...overrides}
      />,
    );
  });
  return handlers;
}

function search(value: string): void {
  const input = query('-search');
  if (!(input instanceof HTMLInputElement)) throw new Error('Missing search');
  act(() => {
    // The prototype's setter, so React's value tracker sees the change.
    Reflect.set(HTMLInputElement.prototype, 'value', value, input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SharedContainerPastSharesList', () => {
  it('groups Removed above Accepted', () => {
    render();

    const removed = query('-removed');
    const accepted = query('-accepted');
    expect(removed?.querySelector('h3')?.textContent).toBe('Removed');
    expect(accepted?.querySelector('h3')?.textContent).toBe('Accepted');
    expect(
      removed !== null &&
        accepted !== null &&
        (removed.compareDocumentPosition(accepted) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
          0,
    ).toBe(true);
  });

  it('sorts each group newest first, with undated accepted shares last', () => {
    render();

    expect(rowIds('removed')).toEqual(['r-new', 'r-old']);
    expect(rowIds('accepted')).toEqual(['a-new', 'a-old', 'a-undated']);
  });

  it('restores a removed share and opens an accepted one', () => {
    const handlers = render();

    act(() => query('-restore-r-new')?.click());
    act(() => query('-accepted-open-a-new')?.click());

    expect(handlers.onRestore).toHaveBeenCalledWith('r-new');
    expect(handlers.onOpenAccepted).toHaveBeenCalledWith('a-new');
    expect(query('-restore-r-new')?.textContent).toBe('Restore');
  });

  it('disables and relabels a restore in flight', () => {
    const handlers = render({ restoringIds: ['r-new'] });

    const restore = query('-restore-r-new');
    expect(restore?.textContent).toBe('Restoring…');
    expect(restore?.hasAttribute('disabled')).toBe(true);
    act(() => restore?.click());
    expect(handlers.onRestore).not.toHaveBeenCalled();
    expect(query('-restore-r-old')?.hasAttribute('disabled')).toBe(false);
  });

  it('filters both groups by title and owner', () => {
    render();
    expect(query('-search')?.getAttribute('aria-label')).toBe(
      'Search past shares',
    );

    search('sam');
    expect(rowIds('removed')).toEqual(['r-new']);
    expect(rowIds('accepted')).toEqual(['a-new']);

    search('billing');
    expect(query('-removed')).toBeNull();
    expect(rowIds('accepted')).toEqual(['a-old']);

    search('nothing like this');
    expect(query('-no-matches')).not.toBeNull();
    expect(query('-empty')).toBeNull();
  });

  it('explains an empty list', () => {
    render({ removed: [], accepted: [] });

    expect(query('-empty')?.textContent).toBe(
      'Shares you accept or remove appear here.',
    );
  });

  it('reports a failed removed listing with Try again and keeps Accepted', () => {
    const handlers = render({ removed: [], removedStatus: 'error' });

    expect(query('-removed-error')?.textContent).toContain(
      'Couldn’t load removed shares.',
    );
    expect(query('-removed-error')?.getAttribute('role')).toBe('alert');
    expect(query('-removed-retry')?.textContent).toBe('Try again');
    act(() => query('-removed-retry')?.click());
    expect(handlers.onRetryRemoved).toHaveBeenCalledTimes(1);
    expect(rowIds('accepted')).toHaveLength(3);
    expect(query('-empty')).toBeNull();
  });

  it('renders only Accepted against a server that cannot restore', () => {
    render({ removedStatus: 'unsupported' });

    expect(query('-removed')).toBeNull();
    expect(rowIds('accepted')).toHaveLength(3);
  });

  it('renders the host’s actions on accepted rows', () => {
    render({
      renderAcceptedActions: (id) => <button data-testid={`menu-${id}`} />,
    });

    expect(
      container.querySelector('[data-testid="menu-a-new"]'),
    ).not.toBeNull();
  });
});
