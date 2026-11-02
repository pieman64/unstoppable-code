/** @jest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  QUEUED_MESSAGE_REORDER_ERROR,
  QueuedMessageStack,
} from '../QueuedMessageStack';

interface Drop {
  active: { id: string };
  over: { id: string };
}
let mockDrop: ((event: Drop) => void) | undefined;
jest.mock('@dnd-kit/core', () => ({
  DndContext: ({
    onDragEnd,
    children,
  }: {
    onDragEnd: (event: Drop) => void;
    children: ReactNode;
  }): ReactNode => {
    mockDrop = onDragEnd;
    return children;
  },
  PointerSensor: jest.fn(),
  KeyboardSensor: jest.fn(),
  useSensor: jest.fn(),
  useSensors: jest.fn(),
  closestCenter: jest.fn(),
  DragOverlay: ({ children }: { children: ReactNode }): ReactNode => children,
  defaultDropAnimationSideEffects: jest.fn(),
}));
jest.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: ReactNode }): ReactNode =>
    children,
  useSortable: (): Record<string, unknown> => ({
    attributes: { role: 'button', tabIndex: 0 },
    listeners: { onPointerDown: jest.fn(), onKeyDown: jest.fn() },
    setNodeRef: jest.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  defaultAnimateLayoutChanges: jest.fn(),
  verticalListSortingStrategy: jest.fn(),
  sortableKeyboardCoordinates: jest.fn(),
  arrayMove: (ids: string[], from: number, to: number): string[] => {
    const next = [...ids];
    next.splice(to, 0, ...next.splice(from, 1));
    return next;
  },
}));
jest.mock('@dnd-kit/utilities', () => ({
  CSS: { Translate: { toString: (): undefined => undefined } },
}));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

describe('QueuedMessageStack', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    mockDrop = undefined;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  function render(
    ids: string[],
    move?: (id: string, beforeId: string | null) => Promise<void>,
  ): void {
    act(() =>
      root.render(
        <QueuedMessageStack
          ids={ids}
          onMove={move}
          renderRow={(id, reorder) => (
            <span data-row data-handle={reorder ? 'yes' : 'no'}>
              {id}
            </span>
          )}
        />,
      ),
    );
  }
  function drop(active: string, over: string): void {
    act(() => mockDrop?.({ active: { id: active }, over: { id: over } }));
  }
  function order(): string[] {
    return Array.from(
      container.querySelectorAll('[data-row]'),
      (row) => row.textContent ?? '',
    );
  }
  function handles(): string[] {
    return Array.from(
      container.querySelectorAll('[data-row]'),
      (row) => row.getAttribute('data-handle') ?? '',
    );
  }

  it('lets rows reorder only while the host can reorder more than one row', () => {
    render(['a', 'b']);
    expect(handles()).toEqual(['no', 'no']);
    render(['a'], () => Promise.resolve());
    expect(handles()).toEqual(['no']);
    render(['a', 'b'], () => Promise.resolve());
    expect(handles()).toEqual(['yes', 'yes']);
    expect(
      container.querySelector('[role="list"]')?.getAttribute('aria-label'),
    ).toBe('Queued messages');
  });

  it('moves a row before its drop target, or to the end', async () => {
    const move = jest.fn(() => Promise.resolve());
    render(['a', 'b', 'c'], move);
    drop('c', 'a');
    expect(move).toHaveBeenLastCalledWith('c', 'a');
    // One move at a time: the next drop waits for this one to settle.
    await act(async () => {
      await Promise.resolve();
    });
    render(['c', 'a', 'b'], move);
    drop('c', 'b');
    expect(move).toHaveBeenLastCalledWith('c', null);
  });

  it('keeps every handle while a row is not queued yet, and never anchors on it', async () => {
    const move = jest.fn(() => Promise.resolve());
    const reasons: Record<string, string> = { c: 'Available once queued' };
    act(() =>
      root.render(
        <QueuedMessageStack
          ids={['a', 'b', 'c']}
          onMove={move}
          moveUnavailableReason={(id) => reasons[id]}
          renderRow={(id, reorder) => (
            <span
              data-row
              data-handle={reorder ? 'yes' : 'no'}
              data-reason={reorder?.unavailableReason ?? ''}
            >
              {id}
            </span>
          )}
        />,
      ),
    );
    expect(handles()).toEqual(['yes', 'yes', 'yes']);
    expect(
      Array.from(container.querySelectorAll('[data-row]'), (row) =>
        row.getAttribute('data-reason'),
      ),
    ).toEqual(['', '', 'Available once queued']);
    // The other rows still move; dropping before the waiting row moves to
    // the end of what the host has queued.
    drop('a', 'b');
    expect(move).toHaveBeenLastCalledWith('a', null);
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('shows the new order at once, then follows the host order', async () => {
    let resolve: (() => void) | undefined;
    const move = jest.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    render(['a', 'b'], move);
    drop('b', 'a');
    expect(order()).toEqual(['b', 'a']);
    render(['b', 'a'], move);
    await act(async () => {
      resolve?.();
      await Promise.resolve();
    });
    expect(order()).toEqual(['b', 'a']);
    render(['a', 'b'], move);
    expect(order()).toEqual(['a', 'b']);
  });

  it('restores the host order and says so when the move fails', async () => {
    let reject: ((error: Error) => void) | undefined;
    render(
      ['a', 'b'],
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    drop('b', 'a');
    await act(async () => {
      reject?.(new Error('refused'));
      await Promise.resolve();
    });
    expect(order()).toEqual(['a', 'b']);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      QUEUED_MESSAGE_REORDER_ERROR,
    );
  });

  it('never brings back a row the host removed while a move was pending', async () => {
    let reject: ((error: Error) => void) | undefined;
    const move = (): Promise<void> =>
      new Promise<void>((_, fail) => {
        reject = fail;
      });
    render(['a', 'b'], move);
    drop('b', 'a');
    render(['a'], move);
    await act(async () => {
      reject?.(new Error('queue changed'));
      await Promise.resolve();
    });
    expect(order()).toEqual(['a']);
  });

  it('gives the handle the sortable pointer and keyboard listeners', () => {
    let handle: Record<string, unknown> | undefined;
    act(() =>
      root.render(
        <QueuedMessageStack
          ids={['a', 'b']}
          onMove={(): Promise<void> => Promise.resolve()}
          renderRow={(id, reorder) => {
            if (id === 'a') handle = { ...reorder?.handleProps };
            return <span data-row>{id}</span>;
          }}
        />,
      ),
    );
    expect(typeof handle?.onPointerDown).toBe('function');
    expect(typeof handle?.onKeyDown).toBe('function');
  });

  it('renders nothing above the composer when the queue is empty', () => {
    render([]);
    expect(container.querySelector('[role="list"]')).toBeNull();
  });
});
