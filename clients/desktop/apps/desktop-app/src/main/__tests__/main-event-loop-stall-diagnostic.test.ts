import { buildMainEventLoopStallDiagnostic } from '../lib/main-event-loop-stall-diagnostic';

describe('main event-loop stall diagnostic', () => {
  it('carries utilization, pool-probe latency, commit count and active turns', () => {
    const record = buildMainEventLoopStallDiagnostic(
      {
        windowMs: 30_000,
        maxDelayMs: 1_240,
        p99DelayMs: 180,
        p50DelayMs: 2,
        utilization: { utilization: 0.873, source: 'main-thread-cpu' },
        threadPoolProbe: {
          count: 14,
          p50Ms: 0.21,
          p99Ms: 38.5,
          maxMs: 38.5,
          pendingMs: 4.2,
        },
        chatStorageCommitCount: 211,
      },
      {
        timestamp: '2026-09-29T12:00:00.000Z',
        runningCodeGraphBuildCount: 1,
        queuedCodeGraphBuildCount: 2,
        activeTurnCount: 5,
      },
    );

    expect(record).toEqual({
      version: 1,
      timestamp: '2026-09-29T12:00:00.000Z',
      kind: 'main_event_loop_stall',
      eventLoopWindowMs: 30_000,
      eventLoopDelayMaxMs: 1_240,
      eventLoopDelayP99Ms: 180,
      eventLoopDelayP50Ms: 2,
      runningCodeGraphBuildCount: 1,
      queuedCodeGraphBuildCount: 2,
      eventLoopUtilization: 0.873,
      eventLoopUtilizationSource: 'main-thread-cpu',
      threadPoolProbeCount: 14,
      threadPoolProbeP50Ms: 0.21,
      threadPoolProbeP99Ms: 38.5,
      threadPoolProbeMaxMs: 38.5,
      threadPoolProbePendingMs: 4.2,
      chatStorageCommitCount: 211,
      activeTurnCount: 5,
    });
  });

  it('omits samplers that produced nothing instead of reporting zeros', () => {
    const record = buildMainEventLoopStallDiagnostic(
      { windowMs: 30_000, maxDelayMs: 2_000, p99DelayMs: 40, p50DelayMs: 1 },
      {
        timestamp: '2026-09-29T12:00:00.000Z',
        runningCodeGraphBuildCount: 0,
        queuedCodeGraphBuildCount: 0,
        activeTurnCount: 0,
      },
    );

    expect(record).not.toHaveProperty('eventLoopUtilization');
    expect(record).not.toHaveProperty('eventLoopUtilizationSource');
    expect(record).not.toHaveProperty('threadPoolProbeCount');
    expect(record).not.toHaveProperty('threadPoolProbePendingMs');
    expect(record).not.toHaveProperty('chatStorageCommitCount');
    expect(record.activeTurnCount).toBe(0);
  });
});
