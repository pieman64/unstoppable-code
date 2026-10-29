import {
  formatElapsed,
  formatTimingTimestamp,
  getElapsedMs,
  isActiveTiming,
  parseIsoToEpoch,
  TIMING_NOT_AVAILABLE,
} from '../lib/pipelineTiming';

describe('pipelineTiming', () => {
  it('parses valid ISO timestamps and safely rejects missing or invalid ones', () => {
    expect(parseIsoToEpoch('2026-03-23T12:00:00.000Z')).toBe(1774267200000);
    expect(parseIsoToEpoch(undefined)).toBeNull();
    expect(parseIsoToEpoch('not-a-date')).toBeNull();
  });

  it('calculates deterministic elapsed time for running and completed entities', () => {
    expect(
      getElapsedMs({
        startedAt: '2026-03-23T12:00:00.000Z',
        nowMs: Date.parse('2026-03-23T12:00:05.750Z'),
      }),
    ).toBe(5750);

    expect(
      getElapsedMs({
        startedAt: '2026-03-23T12:00:00.000Z',
        completedAt: '2026-03-23T12:00:07.250Z',
        nowMs: Date.parse('2026-03-23T12:01:00.000Z'),
      }),
    ).toBe(7250);
  });

  it('can disable now-based fallback for frozen or incomplete timing', () => {
    expect(
      getElapsedMs({
        startedAt: '2026-03-23T12:00:00.000Z',
        nowMs: Date.parse('2026-03-23T12:00:30.000Z'),
        fallbackToNow: false,
      }),
    ).toBeNull();
  });

  it('freezes the run clock while an execution is paused', () => {
    // A run that started at 12:00:00 and paused at 12:00:10 has done ten
    // seconds of work, no matter how long it sits paused.
    expect(
      getElapsedMs({
        startedAt: '2026-03-23T12:00:00.000Z',
        pausedAt: '2026-03-23T12:00:10.000Z',
        nowMs: Date.parse('2026-03-23T12:45:00.000Z'),
      }),
    ).toBe(10_000);
  });

  it('excludes completed pause windows from running and finished durations', () => {
    // Resumed at 12:05:00 after a five-minute pause: the clock picks up where
    // it stopped rather than jumping to wall-clock elapsed.
    expect(
      getElapsedMs({
        startedAt: '2026-03-23T12:00:00.000Z',
        pausedMs: 290_000,
        nowMs: Date.parse('2026-03-23T12:05:04.000Z'),
      }),
    ).toBe(14_000);

    expect(
      getElapsedMs({
        startedAt: '2026-03-23T12:00:00.000Z',
        completedAt: '2026-03-23T12:05:20.000Z',
        pausedMs: 290_000,
        nowMs: Date.parse('2026-03-23T12:45:00.000Z'),
      }),
    ).toBe(30_000);
  });

  it('never reports a negative duration when pause accounting overshoots', () => {
    expect(
      getElapsedMs({
        startedAt: '2026-03-23T12:00:00.000Z',
        completedAt: '2026-03-23T12:00:05.000Z',
        pausedMs: 9_000,
        nowMs: Date.parse('2026-03-23T12:00:05.000Z'),
      }),
    ).toBe(0);
  });

  it('stops the clock at the pause even when a terminal timestamp was written without closing it', () => {
    // Cancelling a paused run stamps `completed_at`; the pause window between
    // `paused_at` and that stamp is not run time.
    expect(
      getElapsedMs({
        startedAt: '2026-03-23T12:00:00.000Z',
        pausedAt: '2026-03-23T12:00:08.000Z',
        completedAt: '2026-03-23T12:30:00.000Z',
        nowMs: Date.parse('2026-03-23T12:30:00.000Z'),
      }),
    ).toBe(8_000);
  });

  it('uses floor-based elapsed formatting rather than rounding', () => {
    expect(formatElapsed(1999)).toBe('1s');
    expect(formatElapsed(60_999)).toBe('1m');
    expect(formatElapsed(65_000)).toBe('1m 5s');
    expect(formatElapsed(null)).toBe(TIMING_NOT_AVAILABLE);
  });

  it('formats retry-attempt durations and timestamp fallbacks safely', () => {
    expect(formatElapsed(3_661_000)).toBe('1h 1m 1s');
    expect(formatTimingTimestamp('not-a-date')).toBe(TIMING_NOT_AVAILABLE);
    expect(formatTimingTimestamp(undefined)).toBe(TIMING_NOT_AVAILABLE);
    expect(formatTimingTimestamp('2026-03-23T12:00:00.000Z')).not.toBe(
      TIMING_NOT_AVAILABLE,
    );
  });

  it('only ticks active execution, job, and step states', () => {
    expect(
      isActiveTiming({
        kind: 'execution',
        status: 'running',
        startedAt: '2026-03-23T12:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      isActiveTiming({
        kind: 'execution',
        status: 'paused',
        startedAt: '2026-03-23T12:00:00.000Z',
      }),
    ).toBe(false);
    expect(
      isActiveTiming({
        kind: 'job',
        status: 'restarting',
        startedAt: '2026-03-23T12:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      isActiveTiming({
        kind: 'job',
        status: 'queued',
        startedAt: '2026-03-23T12:00:00.000Z',
      }),
    ).toBe(false);
    expect(
      isActiveTiming({
        kind: 'step',
        status: 'running',
        startedAt: '2026-03-23T12:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      isActiveTiming({
        kind: 'step',
        status: 'skipped',
        startedAt: '2026-03-23T12:00:00.000Z',
      }),
    ).toBe(false);
    expect(
      isActiveTiming({
        kind: 'job',
        status: 'failure',
        source: 'retry',
        startedAt: '2026-03-23T12:00:00.000Z',
        completedAt: '2026-03-23T12:00:02.000Z',
      }),
    ).toBe(false);
    expect(
      isActiveTiming({
        kind: 'job',
        status: 'running',
        source: 'iteration',
        startedAt: '2026-03-23T12:00:00.000Z',
      }),
    ).toBe(false);
  });
});
