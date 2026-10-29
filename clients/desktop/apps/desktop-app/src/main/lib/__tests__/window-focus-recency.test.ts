import {
  WindowFocusRecency,
  type FocusTrackedWindow,
} from '../window-focus-recency';

class FakeWindow implements FocusTrackedWindow {
  private readonly listeners = new Map<string, Array<() => void>>();

  on(event: 'focus' | 'closed', listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: 'focus' | 'closed'): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

describe('WindowFocusRecency', () => {
  it('has no history for a tracked window that was never focused', () => {
    const recency = new WindowFocusRecency<FakeWindow>();
    const window = new FakeWindow();
    recency.track(window);

    expect(recency.lastFocusedAt(window)).toBeUndefined();
  });

  it('orders windows by their latest focus', () => {
    const recency = new WindowFocusRecency<FakeWindow>();
    const first = new FakeWindow();
    const second = new FakeWindow();
    recency.track(first);
    recency.track(second);

    first.emit('focus');
    second.emit('focus');
    expect(recency.lastFocusedAt(second)).toBeGreaterThan(
      recency.lastFocusedAt(first) ?? Number.POSITIVE_INFINITY,
    );

    first.emit('focus');
    expect(recency.lastFocusedAt(first)).toBeGreaterThan(
      recency.lastFocusedAt(second) ?? Number.POSITIVE_INFINITY,
    );
  });

  it('forgets a window once it is closed', () => {
    const recency = new WindowFocusRecency<FakeWindow>();
    const window = new FakeWindow();
    recency.track(window);
    window.emit('focus');

    window.emit('closed');

    expect(recency.lastFocusedAt(window)).toBeUndefined();
  });
});
