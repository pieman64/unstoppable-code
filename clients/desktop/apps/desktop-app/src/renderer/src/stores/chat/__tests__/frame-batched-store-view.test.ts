// Phase 12: React's view of the chat store. The store itself always applies
// updates immediately; the view publishes deferred updates once per frame and
// everything else at once, never out of order and never skipping the latest.
import { createStore, type StoreApi } from 'zustand';
import {
  CHAT_RENDER_FRAME_FALLBACK_MS,
  createFrameBatchedStoreView,
  type FrameScheduler,
} from '../frame-batched-store-view';

interface CounterState {
  value: number;
  label: string;
}

interface ManualScheduler extends FrameScheduler {
  hidden: boolean;
  runFrame(): void;
  runTimer(): void;
  frames(): number;
  timers(): number;
}

function manualScheduler(): ManualScheduler {
  let next = 1;
  const frameCallbacks = new Map<number, () => void>();
  const timerCallbacks = new Map<number, () => void>();
  const scheduler: ManualScheduler = {
    hidden: false,
    requestFrame(callback): number {
      const handle = next++;
      frameCallbacks.set(handle, callback);
      return handle;
    },
    cancelFrame(handle): void {
      frameCallbacks.delete(handle);
    },
    setTimer(callback, delay): number {
      expect(delay).toBe(CHAT_RENDER_FRAME_FALLBACK_MS);
      const handle = next++;
      timerCallbacks.set(handle, callback);
      return handle;
    },
    clearTimer(handle): void {
      timerCallbacks.delete(handle);
    },
    isHidden(): boolean {
      return scheduler.hidden;
    },
    runFrame(): void {
      const callbacks = Array.from(frameCallbacks.values());
      frameCallbacks.clear();
      for (const callback of callbacks) callback();
    },
    runTimer(): void {
      const callbacks = Array.from(timerCallbacks.values());
      timerCallbacks.clear();
      for (const callback of callbacks) callback();
    },
    frames(): number {
      return frameCallbacks.size;
    },
    timers(): number {
      return timerCallbacks.size;
    },
  };
  return scheduler;
}

function setup(): {
  store: StoreApi<CounterState>;
  view: ReturnType<typeof createFrameBatchedStoreView<CounterState>>;
  published: number[];
  scheduler: ManualScheduler;
  bump: () => void;
  deferredBump: () => void;
} {
  const store = createStore<CounterState>()(() => ({ value: 0, label: 'a' }));
  const view = createFrameBatchedStoreView(store);
  const published: number[] = [];
  view.subscribe((state, previous) => {
    expect(state.value).toBeGreaterThan(previous.value);
    published.push(state.value);
  });
  const scheduler = manualScheduler();
  const bump = (): void =>
    store.setState((state) => ({ value: state.value + 1 }));
  const deferredBump = (): void => view.deferNotifications(scheduler, bump);
  return { store, view, published, scheduler, bump, deferredBump };
}

describe('createFrameBatchedStoreView', () => {
  it('publishes ordinary updates immediately', () => {
    const { store, view, published, bump } = setup();

    bump();
    bump();

    expect(published).toEqual([1, 2]);
    expect(view.getState()).toBe(store.getState());
  });

  it('applies deferred updates to the store at once and to the view once per frame', () => {
    const { store, view, published, scheduler, deferredBump } = setup();
    const before = view.getState();

    deferredBump();
    deferredBump();
    deferredBump();

    expect(store.getState().value).toBe(3);
    expect(view.getState()).toBe(before);
    expect(published).toEqual([]);
    expect(view.hasPendingNotification()).toBe(true);
    expect(scheduler.frames()).toBe(1);

    scheduler.runFrame();

    expect(published).toEqual([3]);
    expect(view.getState()).toBe(store.getState());
    expect(scheduler.timers()).toBe(0);
    expect(view.hasPendingNotification()).toBe(false);
  });

  it('publishes pending content with the next ordinary update, in order', () => {
    const { store, view, published, scheduler, bump, deferredBump } = setup();

    deferredBump();
    deferredBump();
    bump();

    expect(published).toEqual([3]);
    expect(view.getState()).toBe(store.getState());
    expect(scheduler.frames()).toBe(0);
    expect(scheduler.timers()).toBe(0);

    deferredBump();
    scheduler.runFrame();
    expect(published).toEqual([3, 4]);
  });

  it('falls back to a bounded timer when no frame runs', () => {
    const { published, scheduler, deferredBump } = setup();

    deferredBump();
    scheduler.runTimer();

    expect(published).toEqual([1]);
    expect(scheduler.frames()).toBe(0);
  });

  it('publishes immediately while the window is hidden', () => {
    const { published, scheduler, deferredBump } = setup();
    scheduler.hidden = true;

    deferredBump();
    deferredBump();

    expect(published).toEqual([1, 2]);
    expect(scheduler.frames()).toBe(0);
  });

  it('flushes on demand and ignores a flush with nothing pending', () => {
    const { store, view, published, deferredBump } = setup();

    view.flush();
    expect(published).toEqual([]);

    deferredBump();
    view.flush();

    expect(published).toEqual([1]);
    expect(view.getState()).toBe(store.getState());
  });

  it('only defers updates made inside deferNotifications', () => {
    const { published, scheduler, view, bump } = setup();

    view.deferNotifications(scheduler, () => {
      view.deferNotifications(scheduler, bump);
      bump();
    });
    bump();

    // The two deferred updates published with the third, ordinary one.
    expect(published).toEqual([3]);
  });

  it('only publishes states the store held, in the order it held them', () => {
    const { store, published, scheduler, bump, deferredBump } = setup();
    const held: number[] = [];
    store.subscribe((state) => held.push(state.value));

    const script = [true, true, false, true, true, true, false, true];
    script.forEach((deferred, index) => {
      if (deferred) deferredBump();
      else bump();
      if (index === 4) scheduler.runFrame();
    });
    scheduler.runFrame();

    expect(held).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(published.every((value) => held.includes(value))).toBe(true);
    expect(published).toEqual([...published].sort((a, b) => a - b));
    expect(published[published.length - 1]).toBe(8);
  });
});
