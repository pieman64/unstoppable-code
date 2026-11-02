import type { BatchableNotice } from '../notice-batcher';
import { DelegationNoticeBatcher } from '../notice-batcher';

interface Notice extends BatchableNotice {
  readonly value: string;
}

interface ManualTimer {
  readonly dueAt: number;
  readonly fn: () => void;
  cancelled: boolean;
  fired: boolean;
}

class ManualScheduler {
  private time = 0;
  private readonly timers: ManualTimer[] = [];

  readonly now = (): number => this.time;

  readonly setTimer = (fn: () => void, ms: number): unknown => {
    const timer: ManualTimer = {
      dueAt: this.time + ms,
      fn,
      cancelled: false,
      fired: false,
    };
    this.timers.push(timer);
    return timer;
  };

  readonly clearTimer = (handle: unknown): void => {
    if (typeof handle !== 'object' || handle === null) return;
    const timer = this.timers.find((candidate) => candidate === handle);
    if (timer) timer.cancelled = true;
  };

  get pendingCount(): number {
    return this.timers.filter((timer) => !timer.cancelled && !timer.fired)
      .length;
  }

  advanceBy(ms: number): void {
    const target = this.time + ms;
    while (true) {
      let next: ManualTimer | undefined;
      for (const timer of this.timers) {
        if (
          timer.cancelled ||
          timer.fired ||
          timer.dueAt > target ||
          (next && timer.dueAt >= next.dueAt)
        ) {
          continue;
        }
        next = timer;
      }
      if (!next) break;
      this.time = next.dueAt;
      next.fired = true;
      next.fn();
    }
    this.time = target;
  }
}

function notice(noticeId: string, settledAt: number): Notice {
  return { noticeId, settledAt, value: noticeId };
}

describe('DelegationNoticeBatcher', () => {
  it('flushes once after a quiet window following the second add', () => {
    const scheduler = new ManualScheduler();
    const flushed: Array<{ parentKey: string; notices: readonly Notice[] }> =
      [];
    const batcher = new DelegationNoticeBatcher<Notice>({
      flush: (parentKey, notices): void => {
        flushed.push({ parentKey, notices });
      },
      hasOtherActive: (): boolean => true,
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
    });

    batcher.add('parent', notice('first', 10));
    scheduler.advanceBy(500);
    batcher.add('parent', notice('second', 20));

    scheduler.advanceBy(749);
    expect(flushed).toHaveLength(0);
    scheduler.advanceBy(1);

    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.parentKey).toBe('parent');
    expect(flushed[0]?.notices.map(({ noticeId }) => noticeId)).toEqual([
      'first',
      'second',
    ]);
  });

  it('caps repeated quiet-window extensions at the maximum hold time', () => {
    const scheduler = new ManualScheduler();
    const flushed: Array<readonly Notice[]> = [];
    const batcher = new DelegationNoticeBatcher<Notice>({
      flush: (_parentKey, notices): void => {
        flushed.push(notices);
      },
      hasOtherActive: (): boolean => true,
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
    });

    batcher.add('parent', notice('0', 0));
    for (let index = 1; index <= 4; index += 1) {
      scheduler.advanceBy(600);
      batcher.add('parent', notice(String(index), index));
    }

    scheduler.advanceBy(99);
    expect(flushed).toHaveLength(0);
    scheduler.advanceBy(1);

    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.map(({ noticeId }) => noticeId)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  it('flushes synchronously when no other delegate is active', () => {
    const scheduler = new ManualScheduler();
    const flushed: Array<readonly Notice[]> = [];
    const batcher = new DelegationNoticeBatcher<Notice>({
      flush: (_parentKey, notices): void => {
        flushed.push(notices);
      },
      hasOtherActive: (): boolean => false,
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
    });

    batcher.add('parent', notice('done', 1));

    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.map(({ noticeId }) => noticeId)).toEqual(['done']);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('keeps timing windows independent for each parent', () => {
    const scheduler = new ManualScheduler();
    const flushed: Array<{ parentKey: string; notices: readonly Notice[] }> =
      [];
    const batcher = new DelegationNoticeBatcher<Notice>({
      flush: (parentKey, notices): void => {
        flushed.push({ parentKey, notices });
      },
      hasOtherActive: (): boolean => true,
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
    });

    batcher.add('one', notice('one-first', 1));
    scheduler.advanceBy(250);
    batcher.add('two', notice('two-first', 2));
    scheduler.advanceBy(500);

    expect(flushed.map(({ parentKey }) => parentKey)).toEqual(['one']);
    scheduler.advanceBy(250);
    expect(flushed.map(({ parentKey }) => parentKey)).toEqual(['one', 'two']);
  });

  it('deduplicates within a parent and orders by settledAt stably', () => {
    const scheduler = new ManualScheduler();
    const flushed: Array<readonly Notice[]> = [];
    const batcher = new DelegationNoticeBatcher<Notice>({
      flush: (_parentKey, notices): void => {
        flushed.push(notices);
      },
      hasOtherActive: (): boolean => true,
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
    });

    batcher.add('parent', notice('later-first', 20));
    batcher.add('parent', notice('earlier', 10));
    batcher.add('parent', notice('later-second', 20));
    batcher.add('parent', notice('later-first', 1));
    scheduler.advanceBy(750);

    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.map(({ noticeId }) => noticeId)).toEqual([
      'earlier',
      'later-first',
      'later-second',
    ]);
  });

  it('flushes before adding a notice that exceeds the current batch fit', () => {
    const scheduler = new ManualScheduler();
    const flushed: Array<readonly Notice[]> = [];
    const batcher = new DelegationNoticeBatcher<Notice>({
      flush: (_parentKey, notices): void => {
        flushed.push(notices);
      },
      hasOtherActive: (): boolean => true,
      fits: (notices): boolean => notices.length <= 2,
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
    });

    batcher.add('parent', notice('first', 1));
    batcher.add('parent', notice('second', 2));
    batcher.add('parent', notice('third', 3));

    expect(
      flushed.map((batch) => batch.map(({ noticeId }) => noticeId)),
    ).toEqual([['first', 'second']]);
    scheduler.advanceBy(750);
    expect(
      flushed.map((batch) => batch.map(({ noticeId }) => noticeId)),
    ).toEqual([['first', 'second'], ['third']]);
  });

  it('flushes a single notice even when it does not fit by itself', () => {
    const scheduler = new ManualScheduler();
    const flushed: Array<readonly Notice[]> = [];
    const batcher = new DelegationNoticeBatcher<Notice>({
      flush: (_parentKey, notices): void => {
        flushed.push(notices);
      },
      hasOtherActive: (): boolean => true,
      fits: (notices): boolean =>
        notices.every(({ noticeId }) => noticeId !== 'large'),
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
    });

    batcher.add('parent', notice('large', 1));
    scheduler.advanceBy(750);

    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.map(({ noticeId }) => noticeId)).toEqual(['large']);
  });

  it('closes one parent and disposes all remaining windows and timers', () => {
    const scheduler = new ManualScheduler();
    const flushed: Array<{ parentKey: string; notices: readonly Notice[] }> =
      [];
    const batcher = new DelegationNoticeBatcher<Notice>({
      flush: (parentKey, notices): void => {
        flushed.push({ parentKey, notices });
      },
      hasOtherActive: (): boolean => true,
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
    });

    batcher.add('closed', notice('closed-notice', 1));
    batcher.add('kept', notice('kept-notice', 2));
    batcher.close('closed');
    expect(scheduler.pendingCount).toBe(1);
    scheduler.advanceBy(750);
    expect(flushed.map(({ parentKey }) => parentKey)).toEqual(['kept']);

    batcher.add('disposed-one', notice('one', 3));
    batcher.add('disposed-two', notice('two', 4));
    expect(scheduler.pendingCount).toBe(2);
    batcher.dispose();
    expect(scheduler.pendingCount).toBe(0);
    scheduler.advanceBy(5000);
    batcher.add('after-dispose', notice('late', 5));

    expect(flushed.map(({ parentKey }) => parentKey)).toEqual(['kept']);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('unrefs the default Node timer when its handle supports it', () => {
    const batcher = new DelegationNoticeBatcher<Notice>({
      flush: (): void => undefined,
      hasOtherActive: (): boolean => true,
    });
    const timer = setTimeout((): void => undefined, 10000);
    const unrefSpy = jest.spyOn(timer, 'unref');
    const timeoutSpy = jest
      .spyOn(globalThis, 'setTimeout')
      .mockReturnValue(timer);

    try {
      batcher.add('parent', notice('pending', 1));
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 750);
      expect(unrefSpy).toHaveBeenCalledTimes(1);
    } finally {
      batcher.dispose();
      timeoutSpy.mockRestore();
      unrefSpy.mockRestore();
    }
  });
});
