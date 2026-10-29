import { createIdleOutputBuffer } from '@/stores/idleOutputBuffer';

interface Item {
  wk: string;
  n: number;
}

function makeBuffer(minFlushIntervalMs: number): {
  buffer: ReturnType<typeof createIdleOutputBuffer<Item>>;
  flushBatch: jest.Mock;
} {
  const flushBatch = jest.fn();
  const buffer = createIdleOutputBuffer<Item>({
    getWorktreeKey: (item) => item.wk,
    flushBatch,
    minFlushIntervalMs,
  });
  return { buffer, flushBatch };
}

describe('createIdleOutputBuffer throttle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('coalesces rapid pushes into a single flush per interval', () => {
    const { buffer, flushBatch } = makeBuffer(250);

    buffer.push({ wk: 'a', n: 1 }); // schedules drain at t=250
    jest.advanceTimersByTime(100);
    buffer.push({ wk: 'a', n: 2 }); // coalesced into the pending flush
    buffer.push({ wk: 'a', n: 3 });
    expect(flushBatch).not.toHaveBeenCalled();

    jest.advanceTimersByTime(150); // t=250 → drain
    expect(flushBatch).toHaveBeenCalledTimes(1);
    expect(flushBatch).toHaveBeenCalledWith([
      { wk: 'a', n: 1 },
      { wk: 'a', n: 2 },
      { wk: 'a', n: 3 },
    ]);
  });

  it('enforces the minimum gap between consecutive flushes', () => {
    const { buffer, flushBatch } = makeBuffer(250);

    buffer.push({ wk: 'a', n: 1 });
    jest.advanceTimersByTime(250); // first drain at t=250
    expect(flushBatch).toHaveBeenCalledTimes(1);

    // A push right after a drain must wait a full interval, not flush eagerly.
    buffer.push({ wk: 'a', n: 2 });
    jest.advanceTimersByTime(249);
    expect(flushBatch).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1); // t=500
    expect(flushBatch).toHaveBeenCalledTimes(2);
    expect(flushBatch).toHaveBeenLastCalledWith([{ wk: 'a', n: 2 }]);
  });

  it('flush() drains immediately and cancels the pending throttle timer', () => {
    const { buffer, flushBatch } = makeBuffer(250);

    buffer.push({ wk: 'a', n: 1 });
    buffer.flush();
    expect(flushBatch).toHaveBeenCalledTimes(1);

    // The cancelled timer must not fire a second, empty flush.
    jest.advanceTimersByTime(1000);
    expect(flushBatch).toHaveBeenCalledTimes(1);
  });

  it('removeWorktree drops a worktree without leaving a stale timer', () => {
    const { buffer, flushBatch } = makeBuffer(250);

    buffer.push({ wk: 'a', n: 1 });
    buffer.push({ wk: 'b', n: 2 });
    buffer.removeWorktree('a');

    jest.advanceTimersByTime(250);
    expect(flushBatch).toHaveBeenCalledTimes(1);
    expect(flushBatch).toHaveBeenCalledWith([{ wk: 'b', n: 2 }]);
  });

  it('with no interval, flushes on the next timer tick (legacy behavior)', () => {
    const { buffer, flushBatch } = makeBuffer(0);

    buffer.push({ wk: 'a', n: 1 });
    buffer.push({ wk: 'a', n: 2 });
    expect(flushBatch).not.toHaveBeenCalled();

    jest.advanceTimersByTime(0);
    expect(flushBatch).toHaveBeenCalledTimes(1);
    expect(flushBatch).toHaveBeenCalledWith([
      { wk: 'a', n: 1 },
      { wk: 'a', n: 2 },
    ]);
  });
});
