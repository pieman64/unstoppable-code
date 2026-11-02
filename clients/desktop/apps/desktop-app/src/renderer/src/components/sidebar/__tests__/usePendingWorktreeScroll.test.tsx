/**
 * @jest-environment jsdom
 */
import { act, createElement, useRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePendingWorktreeScroll } from '../usePendingWorktreeScroll';
import type { PendingWorktreeScroll } from '@/stores/projectsStore';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

// jsdom does not implement the CSS interface; the hook uses `CSS.escape`.
const testGlobal: typeof globalThis & {
  CSS?: { escape: (value: string) => string };
} = globalThis;
if (typeof testGlobal.CSS === 'undefined') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string): string => value },
  });
}

// --- Controllable requestAnimationFrame ---------------------------------------
let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafSeq = 0;
function flushFrame(): void {
  const due = rafQueue;
  rafQueue = [];
  act(() => {
    due.forEach(({ cb }) => cb(performanceNow()));
  });
}
function performanceNow(): number {
  return 0;
}

// --- Controllable timers (settle window) --------------------------------------
let timerQueue: Array<{ id: number; cb: () => void }> = [];
let timerSeq = 0;
function flushTimers(): void {
  const due = timerQueue;
  timerQueue = [];
  act(() => {
    due.forEach(({ cb }) => cb());
  });
}

const scrollIntoView = jest.fn();

let originalRaf: typeof requestAnimationFrame;
let originalCancelRaf: typeof cancelAnimationFrame;
let originalSetTimeout: typeof window.setTimeout;
let originalClearTimeout: typeof window.clearTimeout;
let originalScrollIntoViewDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  rafQueue = [];
  rafSeq = 0;
  timerQueue = [];
  timerSeq = 0;
  scrollIntoView.mockClear();

  originalRaf = global.requestAnimationFrame;
  originalCancelRaf = global.cancelAnimationFrame;
  originalSetTimeout = window.setTimeout;
  originalClearTimeout = window.clearTimeout;
  originalScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'scrollIntoView',
  );

  global.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    rafSeq += 1;
    rafQueue.push({ id: rafSeq, cb });
    return rafSeq;
  };
  global.cancelAnimationFrame = (id: number): void => {
    rafQueue = rafQueue.filter((entry) => entry.id !== id);
  };

  Object.defineProperty(window, 'setTimeout', {
    configurable: true,
    writable: true,
    value: (handler: TimerHandler): number => {
      timerSeq += 1;
      if (typeof handler === 'function') {
        timerQueue.push({
          id: timerSeq,
          cb: () => {
            Reflect.apply(handler, undefined, []);
          },
        });
      }
      return timerSeq;
    },
  });
  Object.defineProperty(window, 'clearTimeout', {
    configurable: true,
    writable: true,
    value: (id: number | undefined): void => {
      timerQueue = timerQueue.filter((entry) => entry.id !== id);
    },
  });

  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  global.requestAnimationFrame = originalRaf;
  global.cancelAnimationFrame = originalCancelRaf;
  window.setTimeout = originalSetTimeout;
  window.clearTimeout = originalClearTimeout;
  if (originalScrollIntoViewDescriptor) {
    Object.defineProperty(
      Element.prototype,
      'scrollIntoView',
      originalScrollIntoViewDescriptor,
    );
  } else {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  }
});

interface HarnessProps {
  enabled: boolean;
  pending: PendingWorktreeScroll | null;
  clearPending: () => void;
  stillExists: (projectId: string, worktreeId: string) => boolean;
  showTarget: boolean;
  targetId?: string;
  targetProjectId?: string;
  duplicateWorktreeProjectId?: string;
  scrollInline?: ScrollLogicalPosition;
}

function Harness(props: HarnessProps): JSX.Element {
  const containerRef = useRef<HTMLElement | null>(null);
  usePendingWorktreeScroll({
    enabled: props.enabled,
    containerRef,
    pending: props.pending,
    clearPending: props.clearPending,
    stillExists: props.stillExists,
    scrollInline: props.scrollInline,
  });
  const setContainerRef = (node: HTMLDivElement | null): void => {
    containerRef.current = node;
  };
  const targetWorktreeId = props.targetId ?? props.pending?.worktreeId ?? 'x';
  const targetProjectId =
    props.targetProjectId ?? props.pending?.projectId ?? 'project-x';
  return createElement(
    'div',
    { ref: setContainerRef },
    props.duplicateWorktreeProjectId
      ? createElement('div', {
          key: 'duplicate',
          'data-project-id': props.duplicateWorktreeProjectId,
          'data-worktree-id': targetWorktreeId,
        })
      : null,
    props.showTarget
      ? createElement('div', {
          key: 'target',
          'data-project-id': targetProjectId,
          'data-worktree-id': targetWorktreeId,
        })
      : null,
  );
}

let container: HTMLDivElement;
let root: Root;

function render(props: HarnessProps): void {
  act(() => {
    root.render(createElement(Harness, props));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('usePendingWorktreeScroll', () => {
  it('does nothing when disabled', () => {
    render({
      enabled: false,
      pending: {
        projectId: 'project-1',
        worktreeId: 'w1',
        reason: 'selected',
      },
      clearPending: jest.fn(),
      stillExists: () => true,
      showTarget: true,
    });
    flushFrame();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('selected: scrolls once (smooth, nearest) and clears the flag', () => {
    const clearPending = jest.fn();
    render({
      enabled: true,
      pending: {
        projectId: 'project-1',
        worktreeId: 'w1',
        reason: 'selected',
      },
      clearPending,
      stillExists: () => true,
      showTarget: true,
    });
    flushFrame();

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      behavior: 'smooth',
    });
    expect(clearPending).toHaveBeenCalledTimes(1);
    // No settle window for selection.
    expect(rafQueue).toHaveLength(0);
  });

  it('targets the matching project when worktree ids collide', () => {
    render({
      enabled: true,
      pending: {
        projectId: 'burrow',
        worktreeId: 'bluejay',
        reason: 'selected',
      },
      clearPending: jest.fn(),
      stillExists: () => true,
      showTarget: true,
      duplicateWorktreeProjectId: 'canopy',
    });
    flushFrame();

    const burrowBluejay = container.querySelector(
      '[data-project-id="burrow"][data-worktree-id="bluejay"]',
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(burrowBluejay);
  });

  it('created: re-asserts across a settle window, then clears', () => {
    const clearPending = jest.fn();
    render({
      enabled: true,
      pending: {
        projectId: 'project-1',
        worktreeId: 'w1',
        reason: 'created',
      },
      clearPending,
      stillExists: () => true,
      showTarget: true,
    });
    flushFrame();

    // Initial smooth scroll, flag NOT cleared yet, settle window armed.
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenLastCalledWith({
      block: 'nearest',
      behavior: 'smooth',
    });
    expect(clearPending).not.toHaveBeenCalled();
    expect(rafQueue).toHaveLength(1);

    // The settle loop re-asserts the scroll smoothly every frame (never `auto`,
    // which would instantly snap and cancel the in-flight smooth animation).
    flushFrame();
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView).toHaveBeenLastCalledWith({
      block: 'nearest',
      behavior: 'smooth',
    });

    // When the window ends the flag clears and the settle loop is torn down.
    flushTimers();
    expect(clearPending).toHaveBeenCalledTimes(1);
    expect(rafQueue).toHaveLength(0);
  });

  it('created: honors scrollInline for the kanban board', () => {
    render({
      enabled: true,
      pending: {
        projectId: 'project-1',
        worktreeId: 'w1',
        reason: 'created',
      },
      clearPending: jest.fn(),
      stillExists: () => true,
      showTarget: true,
      scrollInline: 'nearest',
    });
    flushFrame();
    expect(scrollIntoView).toHaveBeenLastCalledWith({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'smooth',
    });
  });

  it('retries across frames until the target row mounts', () => {
    const clearPending = jest.fn();
    render({
      enabled: true,
      pending: {
        projectId: 'project-1',
        worktreeId: 'w1',
        reason: 'selected',
      },
      clearPending,
      stillExists: () => true,
      showTarget: false,
    });
    // A couple of frames with no row: no scroll, keeps polling.
    flushFrame();
    flushFrame();
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Row mounts; the existing poll loop finds it on the next frame.
    render({
      enabled: true,
      pending: {
        projectId: 'project-1',
        worktreeId: 'w1',
        reason: 'selected',
      },
      clearPending,
      stillExists: () => true,
      showTarget: true,
    });
    flushFrame();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(clearPending).toHaveBeenCalledTimes(1);
  });

  it('bails and clears when the worktree no longer exists', () => {
    const clearPending = jest.fn();
    render({
      enabled: true,
      pending: {
        projectId: 'project-1',
        worktreeId: 'gone',
        reason: 'created',
      },
      clearPending,
      stillExists: () => false,
      showTarget: false,
    });
    flushFrame();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(clearPending).toHaveBeenCalledTimes(1);
  });

  it('created: stops correcting once the user scrolls', () => {
    const clearPending = jest.fn();
    render({
      enabled: true,
      pending: {
        projectId: 'project-1',
        worktreeId: 'w1',
        reason: 'created',
      },
      clearPending,
      stillExists: () => true,
      showTarget: true,
    });
    flushFrame();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // User takes over: the window ends immediately and further reflows are
    // ignored.
    act(() => {
      window.dispatchEvent(new Event('wheel'));
    });
    expect(clearPending).toHaveBeenCalledTimes(1);
    expect(rafQueue).toHaveLength(0);

    flushFrame();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
