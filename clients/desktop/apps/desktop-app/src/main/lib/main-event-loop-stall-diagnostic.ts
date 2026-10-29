import type { AppDiagnosticRecord } from '../observability/service';
import type { MainEventLoopStall } from './main-event-loop-monitor';

/** Process-wide state read when a stall is recorded. Counts only, no ids. */
export interface MainEventLoopStallContext {
  timestamp: string;
  runningCodeGraphBuildCount: number;
  queuedCodeGraphBuildCount: number;
  activeTurnCount: number;
}

/**
 * The `main_event_loop_stall` app diagnostic for one reported window. Beyond
 * the delays, it records what the process was doing: how busy the main thread
 * was, how long a trivial `fs` call waited for libuv's thread pool, how many
 * chat-storage commits landed, and how many agent turns were running. Samplers
 * that produced nothing are omitted rather than reported as zeros.
 *
 * Everything here stays local: the Datadog operation forwards an explicit
 * field list that none of the new fields join.
 */
export function buildMainEventLoopStallDiagnostic(
  stall: MainEventLoopStall,
  context: MainEventLoopStallContext,
): AppDiagnosticRecord {
  const probe = stall.threadPoolProbe;
  return {
    version: 1,
    timestamp: context.timestamp,
    kind: 'main_event_loop_stall',
    eventLoopWindowMs: stall.windowMs,
    eventLoopDelayMaxMs: stall.maxDelayMs,
    eventLoopDelayP99Ms: stall.p99DelayMs,
    eventLoopDelayP50Ms: stall.p50DelayMs,
    runningCodeGraphBuildCount: context.runningCodeGraphBuildCount,
    queuedCodeGraphBuildCount: context.queuedCodeGraphBuildCount,
    ...(stall.utilization === undefined
      ? {}
      : {
          eventLoopUtilization: stall.utilization.utilization,
          eventLoopUtilizationSource: stall.utilization.source,
        }),
    ...(probe === undefined
      ? {}
      : {
          threadPoolProbeCount: probe.count,
          ...(probe.p50Ms === undefined
            ? {}
            : { threadPoolProbeP50Ms: probe.p50Ms }),
          ...(probe.p99Ms === undefined
            ? {}
            : { threadPoolProbeP99Ms: probe.p99Ms }),
          ...(probe.maxMs === undefined
            ? {}
            : { threadPoolProbeMaxMs: probe.maxMs }),
          ...(probe.pendingMs === undefined
            ? {}
            : { threadPoolProbePendingMs: probe.pendingMs }),
        }),
    ...(stall.chatStorageCommitCount === undefined
      ? {}
      : { chatStorageCommitCount: stall.chatStorageCommitCount }),
    activeTurnCount: context.activeTurnCount,
  };
}
