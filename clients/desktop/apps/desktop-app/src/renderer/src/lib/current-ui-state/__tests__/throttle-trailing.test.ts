import { throttleTrailing } from '../throttle-trailing';

describe('throttleTrailing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('invokes immediately on the leading call', () => {
    const fn = jest.fn();
    const throttled = throttleTrailing(fn, 100);

    throttled('a');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('coalesces bursts within the window into a single trailing call', () => {
    const fn = jest.fn();
    const throttled = throttleTrailing(fn, 100);

    throttled('a');
    throttled('b');
    throttled('c');
    throttled('d');

    // Leading call fired synchronously; the rest are pending.
    expect(fn).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(100);

    // Trailing call carries the LAST args seen during the window, not the
    // first or every intermediate call.
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('d');
  });

  it('always lands the final call even if calls stop mid-window', () => {
    const fn = jest.fn();
    const throttled = throttleTrailing(fn, 100);

    throttled('first');
    jest.advanceTimersByTime(10);
    throttled('final');

    // No more calls arrive; the trailing timer must still fire with 'final'.
    jest.advanceTimersByTime(200);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('final');
  });

  it('allows a new leading call once the window has fully elapsed', () => {
    const fn = jest.fn();
    const throttled = throttleTrailing(fn, 100);

    throttled('a');
    jest.advanceTimersByTime(150);
    throttled('b');

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, 'a');
    expect(fn).toHaveBeenNthCalledWith(2, 'b');
  });

  it('cancel prevents a pending trailing call from firing', () => {
    const fn = jest.fn();
    const throttled = throttleTrailing(fn, 100);

    throttled('a');
    throttled('b');
    throttled.cancel();

    jest.advanceTimersByTime(200);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith('a');
  });
});
