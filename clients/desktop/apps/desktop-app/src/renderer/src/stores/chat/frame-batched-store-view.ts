// Frame-rate rendering of streamed chat state (P2 renderer item 7).
//
// `chat:state-changed` arrives once per main-process commit, often several
// times per frame while a reply streams, and each one used to re-run every
// chat-store selector and commit React. This view sits between the chat store
// and React: the store applies every committed event on arrival, exactly as
// before, so every non-React reader and writer (store actions, IPC handlers,
// command continuations, timers, store subscribers) observes the same state in
// the same order. Only React's subscriptions read the view, whose snapshot
// advances
// - immediately for every store update, as before, unless the update ran
//   inside `deferNotifications`;
// - for deferred updates, once per animation frame, or earlier when any
//   non-deferred update lands, on `flush()` (user input, unsubscribe), or
//   when the window is hidden.
// The snapshot is always a state the store actually held, and it only moves
// forward, so React may skip intermediate frames of streamed content but
// never renders updates out of order or drops the latest one.

import type { StoreApi } from 'zustand';

/** Upper bound on how long a deferred update waits for an animation frame. */
export const CHAT_RENDER_FRAME_FALLBACK_MS = 50;

export interface FrameScheduler {
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(handle: number): void;
  /** True while the window is hidden and may not run animation frames. */
  isHidden(): boolean;
}

/** The window's animation-frame scheduler. */
export function windowFrameScheduler(): FrameScheduler {
  return {
    requestFrame: (callback): number =>
      window.requestAnimationFrame(() => callback()),
    cancelFrame: (handle): void => window.cancelAnimationFrame(handle),
    setTimer: (callback, delayMs): number =>
      window.setTimeout(callback, delayMs),
    clearTimer: (handle): void => window.clearTimeout(handle),
    isHidden: (): boolean => document.visibilityState === 'hidden',
  };
}

export interface FrameBatchedStoreView<S> extends Pick<
  StoreApi<S>,
  'getState' | 'getInitialState' | 'subscribe'
> {
  /**
   * Run `apply` (which updates the store) and publish its updates to React
   * subscribers on the next animation frame instead of immediately.
   */
  deferNotifications(scheduler: FrameScheduler, apply: () => void): void;
  /** Publish any deferred update now. */
  flush(): void;
  /** True while a deferred update waits for its frame. */
  hasPendingNotification(): boolean;
}

export function createFrameBatchedStoreView<S>(
  store: StoreApi<S>,
): FrameBatchedStoreView<S> {
  type Listener = (state: S, previousState: S) => void;
  const listeners = new Set<Listener>();
  let snapshot = store.getState();
  let deferring: FrameScheduler | null = null;
  let pending: FrameScheduler | null = null;
  let frame: number | null = null;
  let timer: number | null = null;

  const cancelScheduled = (): void => {
    if (pending) {
      if (frame !== null) pending.cancelFrame(frame);
      if (timer !== null) pending.clearTimer(timer);
    }
    pending = null;
    frame = null;
    timer = null;
  };

  const publish = (): void => {
    cancelScheduled();
    const previous = snapshot;
    snapshot = store.getState();
    if (Object.is(previous, snapshot)) return;
    for (const listener of Array.from(listeners)) listener(snapshot, previous);
  };

  const schedule = (scheduler: FrameScheduler): void => {
    if (pending) return;
    pending = scheduler;
    frame = scheduler.requestFrame(publish);
    timer = scheduler.setTimer(publish, CHAT_RENDER_FRAME_FALLBACK_MS);
  };

  store.subscribe((): void => {
    if (deferring && !deferring.isHidden()) {
      schedule(deferring);
      return;
    }
    publish();
  });

  return {
    getState: (): S => snapshot,
    getInitialState: (): S => store.getInitialState(),
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    deferNotifications(scheduler: FrameScheduler, apply: () => void): void {
      const outer = deferring;
      deferring = scheduler;
      try {
        apply();
      } finally {
        deferring = outer;
      }
    },
    flush(): void {
      if (pending) publish();
    },
    hasPendingNotification: (): boolean => pending !== null,
  };
}
