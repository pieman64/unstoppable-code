export interface BatchableNotice {
  readonly noticeId: string;
  readonly settledAt: number;
}

interface ParentWindow<T extends BatchableNotice> {
  readonly notices: T[];
  readonly firstAddTime: number;
  lastAddTime: number;
  timer: unknown;
  timerToken: object | undefined;
  hasTimer: boolean;
}

function isNativeTimerHandle(
  handle: unknown,
): handle is ReturnType<typeof setTimeout> {
  return (
    typeof handle === 'number' ||
    (typeof handle === 'object' && handle !== null && 'unref' in handle)
  );
}

function setUnreferencedTimer(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms);
  if (
    typeof handle === 'object' &&
    handle !== null &&
    'unref' in handle &&
    typeof handle.unref === 'function'
  ) {
    handle.unref();
  }
  return handle;
}

function clearNativeTimer(handle: unknown): void {
  if (isNativeTimerHandle(handle)) clearTimeout(handle);
}

/**
 * Debounces completion notices independently for each parent delegation.
 * A throwing flush is propagated after its window and timer have been cleared,
 * so a failed delivery is not retried by a stale timer.
 */
export class DelegationNoticeBatcher<T extends BatchableNotice> {
  private readonly windows = new Map<string, ParentWindow<T>>();
  private readonly fits: (batch: readonly T[]) => boolean;
  private readonly hasOtherActive: (parentKey: string) => boolean;
  private readonly flushBatch: (parentKey: string, batch: readonly T[]) => void;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly quietMs: number;
  private readonly maxHoldMs: number;
  private disposed = false;

  constructor(options: {
    flush: (parentKey: string, batch: readonly T[]) => void;
    hasOtherActive: (parentKey: string) => boolean;
    fits?: (batch: readonly T[]) => boolean;
    quietMs?: number;
    maxHoldMs?: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  }) {
    this.flushBatch = options.flush;
    this.hasOtherActive = options.hasOtherActive;
    this.fits = options.fits ?? ((batch): boolean => batch.length <= 16);
    this.quietMs = options.quietMs ?? 750;
    this.maxHoldMs = options.maxHoldMs ?? 2500;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setUnreferencedTimer;
    this.clearTimer = options.clearTimer ?? clearNativeTimer;
  }

  add(parentKey: string, notice: T): void {
    if (this.disposed) return;

    let window = this.windows.get(parentKey);
    if (window?.notices.some(({ noticeId }) => noticeId === notice.noticeId))
      return;

    const addTime = this.now();
    if (window && !this.fits([...window.notices, notice])) {
      this.flushWindow(parentKey, window);
      window = undefined;
    }

    if (!window) {
      window = {
        notices: [notice],
        firstAddTime: addTime,
        lastAddTime: addTime,
        timer: undefined,
        timerToken: undefined,
        hasTimer: false,
      };
      this.windows.set(parentKey, window);
    } else {
      window.notices.push(notice);
      window.lastAddTime = addTime;
    }

    if (!this.hasOtherActive(parentKey)) {
      this.flushWindow(parentKey, window);
      return;
    }

    this.scheduleWindow(parentKey, window, addTime);
  }

  close(parentKey: string): void {
    const window = this.windows.get(parentKey);
    if (!window) return;
    this.dropWindow(parentKey, window);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.windows.forEach((window, parentKey): void => {
      this.dropWindow(parentKey, window);
    });
  }

  private scheduleWindow(
    parentKey: string,
    window: ParentWindow<T>,
    addTime: number,
  ): void {
    this.clearWindowTimer(window);
    const dueAt = Math.min(
      window.lastAddTime + this.quietMs,
      window.firstAddTime + this.maxHoldMs,
    );
    const delay = Math.max(0, dueAt - addTime);
    const timerToken = {};
    window.timerToken = timerToken;
    window.timer = this.setTimer(() => {
      if (
        this.windows.get(parentKey) !== window ||
        window.timerToken !== timerToken
      ) {
        return;
      }
      this.flushWindow(parentKey, window);
    }, delay);
    window.hasTimer = true;
  }

  private flushWindow(parentKey: string, window: ParentWindow<T>): void {
    if (this.windows.get(parentKey) !== window) return;
    this.dropWindow(parentKey, window);

    const sorted = window.notices
      .map((notice, index) => ({ notice, index }))
      .sort(
        (left, right) =>
          left.notice.settledAt - right.notice.settledAt ||
          left.index - right.index,
      )
      .map(({ notice }) => notice);
    this.flushBatch(parentKey, sorted);
  }

  private dropWindow(parentKey: string, window: ParentWindow<T>): void {
    this.windows.delete(parentKey);
    this.clearWindowTimer(window);
  }

  private clearWindowTimer(window: ParentWindow<T>): void {
    window.timerToken = undefined;
    if (!window.hasTimer) return;
    const timer = window.timer;
    window.timer = undefined;
    window.hasTimer = false;
    this.clearTimer(timer);
  }
}
