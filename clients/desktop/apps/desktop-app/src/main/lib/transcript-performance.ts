export type MainTranscriptPerformanceStage =
  | 'turn_index'
  | 'active_tail_reconstruction'
  | 'range_read'
  | 'payload_bytes_estimate';

interface MainTranscriptPerformanceAggregate {
  count: number;
  totalMs: number;
  maxMs: number;
  work: Record<string, number>;
}

interface MainTranscriptPerformanceCorrelation {
  id: string;
  process: 'main';
  stage: MainTranscriptPerformanceStage;
  elapsedMs: number;
  work: Record<string, number>;
}

export interface MainTranscriptPerformanceAccumulator {
  schemaVersion: 1;
  process: 'main';
  startedAt: number;
  stages: Partial<
    Record<MainTranscriptPerformanceStage, MainTranscriptPerformanceAggregate>
  >;
  correlations: MainTranscriptPerformanceCorrelation[];
}

declare global {
  // Installed by the desktop performance harness in Electron main only.
  var __CANOPY_MAIN_TRANSCRIPT_PERF__:
    | MainTranscriptPerformanceAccumulator
    | undefined;
}

const NOOP_FINISH = (): void => undefined;

export function mainTranscriptPerformanceEnabled(): boolean {
  return (
    typeof __CANOPY_E2E__ !== 'undefined' &&
    __CANOPY_E2E__ &&
    globalThis.__CANOPY_MAIN_TRANSCRIPT_PERF__ !== undefined
  );
}

export function initializeMainTranscriptPerformance(): void {
  if (typeof __CANOPY_E2E__ === 'undefined' || !__CANOPY_E2E__) return;
  globalThis.__CANOPY_MAIN_TRANSCRIPT_PERF__ = {
    schemaVersion: 1,
    process: 'main',
    startedAt: performance.now(),
    stages: {},
    correlations: [],
  };
}

export function snapshotMainTranscriptPerformance():
  | MainTranscriptPerformanceAccumulator
  | undefined {
  return globalThis.__CANOPY_MAIN_TRANSCRIPT_PERF__;
}

export function beginMainTranscriptPerformanceStage(
  stage: MainTranscriptPerformanceStage,
  correlationId: string,
  initialWork: Readonly<Record<string, number>> = {},
): (finalWork?: Readonly<Record<string, number>>) => void {
  if (!mainTranscriptPerformanceEnabled()) return NOOP_FINISH;
  const accumulator = globalThis.__CANOPY_MAIN_TRANSCRIPT_PERF__;
  if (!accumulator) return NOOP_FINISH;
  const startedAt = performance.now();
  return (finalWork = {}): void => {
    const elapsedMs = Math.max(0, performance.now() - startedAt);
    const aggregate = accumulator.stages[stage] ?? {
      count: 0,
      totalMs: 0,
      maxMs: 0,
      work: {},
    };
    aggregate.count += 1;
    aggregate.totalMs += elapsedMs;
    aggregate.maxMs = Math.max(aggregate.maxMs, elapsedMs);
    const work = { ...initialWork, ...finalWork };
    for (const [name, value] of Object.entries(work)) {
      if (!Number.isFinite(value)) continue;
      aggregate.work[name] = (aggregate.work[name] ?? 0) + value;
    }
    accumulator.stages[stage] = aggregate;
    accumulator.correlations.push({
      id: correlationId,
      process: 'main',
      stage,
      elapsedMs,
      work: Object.fromEntries(
        Object.entries(work).filter(([, value]) => Number.isFinite(value)),
      ),
    });
  };
}
