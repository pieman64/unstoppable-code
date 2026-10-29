/**
 * @jest-environment jsdom
 */
import { act, createElement, createRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CommentsTray,
  type CommentsTrayProps,
} from '@/components/shared/CommentsTray';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface FakeThread {
  id: string;
  body: string;
}

function clamp(value: number): number {
  return Math.min(40, Math.max(12, value));
}

function renderThread(thread: FakeThread): JSX.Element {
  return createElement(
    'div',
    { key: thread.id, 'data-testid': 'fake-thread' },
    thread.body,
  );
}

function trayProps(
  overrides: Partial<CommentsTrayProps<FakeThread>> = {},
): CommentsTrayProps<FakeThread> {
  const containerRef = createRef<HTMLElement>();
  return {
    containerRef,
    heightPercent: 24,
    clampHeightPercent: clamp,
    onHeightCommit: jest.fn(),
    resizeAriaLabel: 'Resize comments panel',
    containerTestId: 'test-comments-tray',
    totalCount: 0,
    activeThreads: [],
    archivedThreads: [],
    renderThread,
    onAddNote: jest.fn(),
    stagedCount: 0,
    onSubmitStaged: jest.fn(),
    emptyStateText: 'Nothing here yet.',
    addNoteTestId: 'tray-add-note',
    noteInputTestId: 'tray-note-input',
    noteSaveTestId: 'tray-note-save',
    submitTestId: 'tray-submit',
    archivedToggleTestId: 'tray-archived-toggle',
    ...overrides,
  };
}

describe('CommentsTray', () => {
  let container: HTMLDivElement;
  let root: Root;
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // Queue rAF callbacks so tests control exactly when a drag frame paints.
    rafCallbacks = [];
    jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback): number => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.restoreAllMocks();
  });

  function flushRaf(): void {
    act(() => {
      const callbacks = rafCallbacks;
      rafCallbacks = [];
      for (const callback of callbacks) {
        callback(0);
      }
    });
  }

  function query(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  function click(el: Element | null): void {
    act(() => {
      el?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
  }

  it('renders header count, empty state, and seeds flex-basis from heightPercent', () => {
    act(() => {
      root.render(createElement(CommentsTray<FakeThread>, trayProps()));
    });

    const tray = query('test-comments-tray');
    expect(tray).not.toBeNull();
    expect(tray?.style.flexBasis).toBe('24%');
    expect(tray?.textContent).toContain('Comments (0)');
    expect(tray?.textContent).toContain('Nothing here yet.');
  });

  it.each([false, true])(
    'blocks the tray body from session replay, keeping its header recorded (collapsed: %s)',
    (collapsed) => {
      act(() => {
        root.render(
          createElement(
            CommentsTray<FakeThread>,
            trayProps({
              collapsed,
              onToggleCollapsed: jest.fn(),
              activeThreads: [{ id: 'a1', body: 'private comment' }],
              totalCount: 1,
            }),
          ),
        );
      });

      const tray = query('test-comments-tray');
      expect(tray?.parentElement).toBe(container);
      expect(tray?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
      const body = query('test-comments-tray-body');
      expect(body?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(true);
      expect(body?.textContent).toContain('private comment');
      const blocks = tray?.querySelectorAll(`.${POSTHOG_REPLAY_BLOCK_CLASS}`);
      expect(blocks).toHaveLength(1);
      expect(tray?.textContent).toContain('Comments (1)');
    },
  );

  it('splits threads into an active group and a collapsed archived group', () => {
    const active: FakeThread[] = [
      { id: 'a1', body: 'active one' },
      { id: 'a2', body: 'active two' },
    ];
    const archived: FakeThread[] = [{ id: 'r1', body: 'resolved one' }];
    act(() => {
      root.render(
        createElement(
          CommentsTray<FakeThread>,
          trayProps({
            totalCount: 3,
            activeThreads: active,
            archivedThreads: archived,
          }),
        ),
      );
    });

    expect(query('test-comments-tray')?.textContent).toContain('Comments (3)');
    expect(
      container.querySelectorAll('[data-testid="fake-thread"]'),
    ).toHaveLength(2);

    const toggle = query('tray-archived-toggle');
    expect(toggle?.textContent).toContain('Show resolved & outdated (1)');
    click(toggle);
    expect(
      container.querySelectorAll('[data-testid="fake-thread"]'),
    ).toHaveLength(3);
    expect(query('tray-archived-toggle')?.textContent).toContain(
      'Hide resolved & outdated (1)',
    );
  });

  it('stages a general note through onAddNote and resets the composer', () => {
    const onAddNote = jest.fn();
    act(() => {
      root.render(
        createElement(CommentsTray<FakeThread>, trayProps({ onAddNote })),
      );
    });

    click(query('tray-add-note'));
    const input = query('tray-note-input');
    if (!(input instanceof HTMLTextAreaElement)) {
      throw new Error('Expected note textarea');
    }
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set?.call(input, '  A general note  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click(query('tray-note-save'));

    expect(onAddNote).toHaveBeenCalledWith('A general note');
    expect(query('tray-note-input')).toBeNull();
  });

  it('shows the submit button only when staged comments exist and forwards clicks', () => {
    const onSubmitStaged = jest.fn();
    act(() => {
      root.render(
        createElement(
          CommentsTray<FakeThread>,
          trayProps({ stagedCount: 0, onSubmitStaged }),
        ),
      );
    });
    expect(query('tray-submit')).toBeNull();

    act(() => {
      root.render(
        createElement(
          CommentsTray<FakeThread>,
          trayProps({ stagedCount: 2, onSubmitStaged }),
        ),
      );
    });
    const submit = query('tray-submit');
    expect(submit?.textContent).toContain('Submit 2 comments');
    click(submit);
    expect(onSubmitStaged).toHaveBeenCalledTimes(1);
  });

  it('offers no submit action without a submit handler', () => {
    act(() => {
      root.render(
        createElement(
          CommentsTray<FakeThread>,
          trayProps({ stagedCount: 2, onSubmitStaged: undefined }),
        ),
      );
    });
    expect(query('tray-submit')).toBeNull();
    // Staging stays available.
    expect(query('tray-add-note')).not.toBeNull();
  });

  it('hides the add-note affordance when readOnly but keeps staged submits', () => {
    act(() => {
      root.render(
        createElement(
          CommentsTray<FakeThread>,
          trayProps({ readOnly: true, stagedCount: 1 }),
        ),
      );
    });
    expect(query('tray-add-note')).toBeNull();
    expect(query('tray-submit')).not.toBeNull();
  });

  it('paints drag heights directly to the DOM and commits the final clamped value', () => {
    const onHeightCommit = jest.fn();
    const containerRef = createRef<HTMLElement>();
    const props = trayProps({ containerRef, onHeightCommit });
    act(() => {
      root.render(createElement(CommentsTray<FakeThread>, props));
    });

    // Point the container ref at a fake 1000px-tall panel spanning 0..1000.
    const panel = document.createElement('div');
    jest.spyOn(panel, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 1000,
      height: 1000,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: (): Record<string, never> => ({}),
    });
    containerRef.current = panel;

    const handle = container.querySelector('[role="separator"]');
    expect(handle).not.toBeNull();

    // Mousedown at 800px → tray = (1000-800)/1000 = 20%.
    act(() => {
      handle?.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          clientY: 800,
        }),
      );
    });
    flushRaf();
    const tray = query('test-comments-tray');
    expect(tray?.style.flexBasis).toBe('20%');

    // Two window mousemoves inside one frame coalesce into a single paint of
    // the LAST value: 500px (50% → clamped 40%) then 300px (70% → 40%).
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientY: 500 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientY: 300 }));
    });
    expect(rafCallbacks).toHaveLength(1);
    flushRaf();
    expect(tray?.style.flexBasis).toBe('40%');
    // No state-driven commit yet — only direct DOM writes.
    expect(onHeightCommit).not.toHaveBeenCalled();

    // Mouseup commits exactly the last painted value (no snap-back).
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', {}));
    });
    expect(onHeightCommit).toHaveBeenCalledTimes(1);
    expect(onHeightCommit).toHaveBeenCalledWith(40);
    expect(tray?.style.flexBasis).toBe('40%');
  });

  it('omits the collapse toggle when no onToggleCollapsed is provided', () => {
    act(() => {
      root.render(createElement(CommentsTray<FakeThread>, trayProps()));
    });
    expect(query('tray-collapse-toggle')).toBeNull();
    // Resize handle and body still render in the always-expanded default.
    expect(container.querySelector('[role="separator"]')).not.toBeNull();
    expect(query('test-comments-tray')?.textContent).toContain(
      'Nothing here yet.',
    );
  });

  it('ignores collapsed when no toggle callback is provided', () => {
    act(() => {
      root.render(
        createElement(
          CommentsTray<FakeThread>,
          trayProps({
            collapsed: true,
            totalCount: 1,
            activeThreads: [{ id: 'a1', body: 'still accessible' }],
          }),
        ),
      );
    });

    expect(query('tray-collapse-toggle')).toBeNull();
    expect(container.querySelector('[role="separator"]')).not.toBeNull();
    expect(query('test-comments-tray')?.style.flexBasis).toBe('24%');
    expect(query('test-comments-tray')?.textContent).toContain(
      'still accessible',
    );
  });

  it('renders the collapse toggle and forwards clicks', () => {
    const onToggleCollapsed = jest.fn();
    act(() => {
      root.render(
        createElement(
          CommentsTray<FakeThread>,
          trayProps({
            onToggleCollapsed,
            collapseToggleTestId: 'tray-collapse-toggle',
          }),
        ),
      );
    });
    const toggle = query('tray-collapse-toggle');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    click(toggle);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it('collapses to the header only, hiding the body and resize handle', () => {
    act(() => {
      root.render(
        createElement(
          CommentsTray<FakeThread>,
          trayProps({
            collapsed: true,
            onToggleCollapsed: jest.fn(),
            collapseToggleTestId: 'tray-collapse-toggle',
            totalCount: 2,
            activeThreads: [
              { id: 'a1', body: 'active one' },
              { id: 'a2', body: 'active two' },
            ],
          }),
        ),
      );
    });

    const tray = query('test-comments-tray');
    // Header still shows the count and the toggle reports collapsed.
    expect(tray?.textContent).toContain('Comments (2)');
    expect(query('tray-collapse-toggle')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    // Body threads stay mounted so caller-owned reply/edit state survives,
    // but the body and add-note affordance are hidden from the collapsed UI.
    expect(
      container.querySelectorAll('[data-testid="fake-thread"]'),
    ).toHaveLength(2);
    expect(query('test-comments-tray-body')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(query('tray-add-note')).toBeNull();
    expect(container.querySelector('[role="separator"]')).toBeNull();
    expect(tray?.style.flexBasis).toBe('');
  });

  it('preserves an in-progress draft while collapsed', () => {
    const onToggleCollapsed = jest.fn();
    const props = trayProps({
      onToggleCollapsed,
      collapseToggleTestId: 'tray-collapse-toggle',
    });
    act(() => {
      root.render(createElement(CommentsTray<FakeThread>, props));
    });

    click(query('tray-add-note'));
    const input = query('tray-note-input');
    if (!(input instanceof HTMLTextAreaElement)) {
      throw new Error('Expected note textarea');
    }
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set?.call(input, 'Draft survives collapse');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    act(() => {
      root.render(
        createElement(CommentsTray<FakeThread>, {
          ...props,
          collapsed: true,
        }),
      );
    });
    expect(query('test-comments-tray-body')?.getAttribute('aria-hidden')).toBe(
      'true',
    );

    act(() => {
      root.render(
        createElement(CommentsTray<FakeThread>, {
          ...props,
          collapsed: false,
        }),
      );
    });
    const restoredInput = query('tray-note-input');
    expect(restoredInput).toBe(input);
    if (!(restoredInput instanceof HTMLTextAreaElement)) {
      throw new Error('Expected restored note textarea');
    }
    expect(restoredInput.value).toBe('Draft survives collapse');
  });
});
