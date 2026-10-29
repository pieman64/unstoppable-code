/**
 * CAN-3512: telemetry uploads once stopped with no attempts, errors, or
 * diagnostics, and the stall was visible only in `telemetry-sync/queue.jsonl`.
 * These tests pin the detection that turns a stalled queue into a "Sync
 * paused" status and an app-events diagnostic.
 */
import type { TelemetrySyncStatus } from '@canopy/desktop-shared/types';
import {
  TELEMETRY_SYNC_PAUSE_CHECK_INTERVAL_MS,
  TELEMETRY_SYNC_PAUSE_CONFIRMATION_MS,
  TELEMETRY_SYNC_STALL_THRESHOLD_MS,
  TelemetrySyncPauseMonitor,
  evaluateTelemetrySyncPause,
  oldestQueuedTelemetryItemAt,
  type TelemetrySyncHealthSnapshot,
  type TelemetrySyncPauseDiagnostic,
} from '../telemetry-sync-pause';

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = Date.parse('2026-09-27T18:00:00.000Z');

function isoAgo(ms: number, now = NOW_MS): string {
  return new Date(now - ms).toISOString();
}

function snapshot(
  overrides: Partial<TelemetrySyncHealthSnapshot> = {},
): TelemetrySyncHealthSnapshot {
  return {
    sharingWanted: true,
    pendingCount: 0,
    oldestPendingAt: null,
    lastSyncedAt: null,
    ...overrides,
  };
}

function baseStatus(
  overrides: Partial<TelemetrySyncStatus> = {},
): TelemetrySyncStatus {
  return {
    isSyncing: false,
    pendingCount: 0,
    sharingActive: true,
    lastSyncedAt: null,
    lastErrorAt: null,
    lastError: null,
    ...overrides,
  };
}

describe('evaluateTelemetrySyncPause', () => {
  it('stays quiet when the member turned every scope off', () => {
    expect(
      evaluateTelemetrySyncPause(
        snapshot({
          sharingWanted: false,
          pendingCount: 3,
          oldestPendingAt: isoAgo(2 * TELEMETRY_SYNC_STALL_THRESHOLD_MS),
        }),
        NOW_MS,
      ),
    ).toBeNull();
  });

  it('pauses when the oldest queued item is older than the threshold and nothing uploaded since', () => {
    expect(
      evaluateTelemetrySyncPause(
        snapshot({
          pendingCount: 4,
          oldestPendingAt: isoAgo(7 * HOUR_MS),
          lastSyncedAt: isoAgo(30 * HOUR_MS),
        }),
        NOW_MS,
      ),
    ).toBe('queue-stalled');
  });

  it('pauses a queue that has never uploaded once its oldest item is past the threshold', () => {
    expect(
      evaluateTelemetrySyncPause(
        snapshot({ pendingCount: 1, oldestPendingAt: isoAgo(7 * HOUR_MS) }),
        NOW_MS,
      ),
    ).toBe('queue-stalled');
  });

  it('does not pause a queue younger than the threshold', () => {
    expect(
      evaluateTelemetrySyncPause(
        snapshot({
          pendingCount: 2,
          oldestPendingAt: isoAgo(TELEMETRY_SYNC_STALL_THRESHOLD_MS - 60_000),
          lastSyncedAt: isoAgo(30 * HOUR_MS),
        }),
        NOW_MS,
      ),
    ).toBeNull();
  });

  it('does not pause when an upload succeeded within the threshold', () => {
    // An old item queued behind a recent success (a backfilled turn) is
    // draining, not stalled.
    expect(
      evaluateTelemetrySyncPause(
        snapshot({
          pendingCount: 1,
          oldestPendingAt: isoAgo(3 * TELEMETRY_SYNC_STALL_THRESHOLD_MS),
          lastSyncedAt: isoAgo(10 * 60_000),
        }),
        NOW_MS,
      ),
    ).toBeNull();
  });

  it('uses six hours as the stall threshold', () => {
    expect(TELEMETRY_SYNC_STALL_THRESHOLD_MS).toBe(6 * HOUR_MS);
  });
});

describe('oldestQueuedTelemetryItemAt', () => {
  it('returns the earliest event time across turns, pipeline runs and summary snapshots', () => {
    const oldest = oldestQueuedTelemetryItemAt([
      {
        turns: new Map([
          [
            'a',
            {
              value: {
                startedAt: '2026-09-27T09:00:00.000Z',
                completedAt: '2026-09-27T09:05:00.000Z',
              },
            },
          ],
          ['b', { value: { startedAt: '2026-09-27T10:00:00.000Z' } }],
        ]),
        pipelineRuns: new Map(),
        summarySnapshots: new Map(),
      },
      {
        turns: new Map(),
        pipelineRuns: new Map([
          [
            'run',
            {
              value: {
                startedAt: '2026-09-27T07:00:00.000Z',
                completedAt: '2026-09-27T08:00:00.000Z',
              },
            },
          ],
        ]),
        summarySnapshots: new Map([
          ['snap', { value: { generatedAt: '2026-09-27T08:30:00.000Z' } }],
        ]),
      },
    ]);
    expect(oldest).toBe('2026-09-27T08:00:00.000Z');
  });

  it('returns null for an empty queue and skips unparsable times', () => {
    expect(oldestQueuedTelemetryItemAt([])).toBeNull();
    expect(
      oldestQueuedTelemetryItemAt([
        {
          turns: new Map([['bad', { value: { startedAt: 'not a date' } }]]),
          pipelineRuns: new Map(),
          summarySnapshots: new Map(),
        },
      ]),
    ).toBeNull();
  });
});

describe('TelemetrySyncPauseMonitor', () => {
  let nowMs: number;
  let health: TelemetrySyncHealthSnapshot;
  let serviceStatus: TelemetrySyncStatus;
  let serviceListener: ((status: TelemetrySyncStatus) => void) | null;
  let diagnostics: TelemetrySyncPauseDiagnostic[];

  function createMonitor(): TelemetrySyncPauseMonitor {
    return new TelemetrySyncPauseMonitor({
      service: {
        getHealthSnapshot: () => health,
        getStatus: () => serviceStatus,
        subscribeStatus: (listener) => {
          serviceListener = listener;
          listener(serviceStatus);
          return () => {
            serviceListener = null;
          };
        },
      },
      recordDiagnostic: (record): void => {
        diagnostics.push(record);
      },
      now: () => nowMs,
    });
  }

  async function advance(ms: number): Promise<void> {
    nowMs += ms;
    await jest.advanceTimersByTimeAsync(ms);
  }

  beforeEach(() => {
    jest.useFakeTimers();
    nowMs = NOW_MS;
    health = snapshot();
    serviceStatus = baseStatus();
    serviceListener = null;
    diagnostics = [];
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports a stalled queue after the confirmation window', async () => {
    health = snapshot({
      pendingCount: 12,
      oldestPendingAt: isoAgo(8 * HOUR_MS),
      lastSyncedAt: isoAgo(9 * HOUR_MS),
    });
    serviceStatus = baseStatus({ pendingCount: 12 });
    const monitor = createMonitor();
    const seen: TelemetrySyncStatus[] = [];
    monitor.subscribeStatus((status) => seen.push(status));
    monitor.start();

    // The first upload after starting with an old queue must not flash.
    await advance(TELEMETRY_SYNC_PAUSE_CONFIRMATION_MS - 1000);
    expect(monitor.getStatus().pausedReason).toBeNull();
    expect(diagnostics).toEqual([]);

    await advance(1000);
    expect(monitor.getStatus()).toMatchObject({
      pendingCount: 12,
      pausedReason: 'queue-stalled',
    });
    expect(seen[seen.length - 1]?.pausedReason).toBe('queue-stalled');
    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: 'telemetry_sync_paused',
        reason: 'queue_stalled',
        telemetrySyncPendingCount: 12,
        telemetrySyncOldestPendingAgeMs:
          8 * HOUR_MS + TELEMETRY_SYNC_PAUSE_CONFIRMATION_MS,
        telemetrySyncLastSyncedAt: isoAgo(9 * HOUR_MS),
      }),
    ]);

    // Staying paused records nothing more.
    await advance(3 * TELEMETRY_SYNC_PAUSE_CHECK_INTERVAL_MS);
    expect(diagnostics).toHaveLength(1);
    monitor.dispose();
  });

  it('records a resume and clears the status when the queue drains', async () => {
    health = snapshot({
      pendingCount: 1,
      oldestPendingAt: isoAgo(8 * HOUR_MS),
    });
    const monitor = createMonitor();
    monitor.start();
    await advance(TELEMETRY_SYNC_PAUSE_CONFIRMATION_MS);
    expect(monitor.getStatus().pausedReason).toBe('queue-stalled');

    await advance(5 * 60_000);
    health = snapshot({ lastSyncedAt: isoAgo(0, nowMs) });
    serviceListener?.(baseStatus());

    expect(monitor.getStatus().pausedReason).toBeNull();
    expect(diagnostics[1]).toMatchObject({
      kind: 'telemetry_sync_resumed',
      reason: 'queue_stalled',
      telemetrySyncPausedMs: 5 * 60_000,
    });
    monitor.dispose();
  });

  it('ignores a stall that clears within the confirmation window', async () => {
    health = snapshot({
      pendingCount: 1,
      oldestPendingAt: isoAgo(8 * HOUR_MS),
    });
    const monitor = createMonitor();
    monitor.start();
    await advance(60_000);
    health = snapshot();
    serviceListener?.(baseStatus());
    await advance(2 * TELEMETRY_SYNC_PAUSE_CONFIRMATION_MS);

    expect(monitor.getStatus().pausedReason).toBeNull();
    expect(diagnostics).toEqual([]);
    monitor.dispose();
  });

  it('notices a queue aging past the threshold without any status event', async () => {
    health = snapshot({
      pendingCount: 3,
      oldestPendingAt: isoAgo(TELEMETRY_SYNC_STALL_THRESHOLD_MS - 10 * 60_000),
      lastSyncedAt: isoAgo(TELEMETRY_SYNC_STALL_THRESHOLD_MS),
    });
    const monitor = createMonitor();
    monitor.start();
    await advance(TELEMETRY_SYNC_PAUSE_CONFIRMATION_MS);
    expect(monitor.getStatus().pausedReason).toBeNull();

    // Only the periodic check sees the item age; nothing else changes.
    await advance(TELEMETRY_SYNC_PAUSE_CONFIRMATION_MS + 2 * 60_000);
    expect(monitor.getStatus().pausedReason).toBe('queue-stalled');
    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: 'telemetry_sync_paused',
        reason: 'queue_stalled',
        telemetrySyncPendingCount: 3,
      }),
    ]);
    monitor.dispose();
  });

  it('forwards service status with the pause reason attached', () => {
    const monitor = createMonitor();
    const seen: TelemetrySyncStatus[] = [];
    monitor.subscribeStatus((status) => seen.push(status));
    monitor.start();

    serviceListener?.(baseStatus({ isSyncing: true, pendingCount: 2 }));
    expect(seen[seen.length - 1]).toEqual(
      baseStatus({ isSyncing: true, pendingCount: 2, pausedReason: null }),
    );
    monitor.dispose();
  });
});
