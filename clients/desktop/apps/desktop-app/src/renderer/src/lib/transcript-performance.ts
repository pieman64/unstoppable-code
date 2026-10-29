export type TranscriptPerformanceStage =
  | 'canonical_apply'
  | 'todo_projection'
  | 'turn_grouping'
  | 'artifact_projection'
  | 'event_receipt'
  | 'store_publication'
  | 'react_commit'
  | 'commit_to_frame'
  | 'page_install'
  | 'sticky_geometry'
  | 'resize_observer'
  | 'virtual_measure'
  | 'virtual_range';

export interface TranscriptPerformanceStageAggregate {
  count: number;
  totalMs: number;
  maxMs: number;
  work: Record<string, number>;
}

export interface TranscriptPerformanceAccumulator {
  schemaVersion: 2;
  startedAt: number;
  stages: Partial<
    Record<TranscriptPerformanceStage, TranscriptPerformanceStageAggregate>
  >;
  counters: Record<string, number>;
  correlations: TranscriptPerformanceCorrelation[];
}

export interface TranscriptPerformanceCorrelation {
  id: string;
  process: 'renderer';
  stage: TranscriptPerformanceStage;
  elapsedMs: number;
  work: Record<string, number>;
}

declare global {
  // Installed only by the desktop performance harness. The build-time E2E
  // guard lets production bundling eliminate every call's recording branch.
  var __CANOPY_TRANSCRIPT_PERF__: TranscriptPerformanceAccumulator | undefined;
}

const NOOP_FINISH = (): void => undefined;
const MAX_PENDING_COMMIT_AGE_MS = 1_000;
const pendingCommitStarts = new Map<
  string,
  {
    correlationId: string;
    startedAt: number;
    work: Readonly<Record<string, number>>;
  }
>();
const mountedCommitTargets = new Map<string, number>();
let observedAccumulator: TranscriptPerformanceAccumulator | undefined;

function currentAccumulator(): TranscriptPerformanceAccumulator | undefined {
  const accumulator = globalThis.__CANOPY_TRANSCRIPT_PERF__;
  if (accumulator !== observedAccumulator) {
    pendingCommitStarts.clear();
    observedAccumulator = accumulator;
  }
  return accumulator;
}

function addWork(
  aggregate: TranscriptPerformanceStageAggregate,
  work: Readonly<Record<string, number>>,
): void {
  for (const [name, value] of Object.entries(work)) {
    if (!Number.isFinite(value)) continue;
    aggregate.work[name] = (aggregate.work[name] ?? 0) + value;
  }
}

function recordTranscriptPerformanceStage(
  accumulator: TranscriptPerformanceAccumulator,
  stage: TranscriptPerformanceStage,
  durationMs: number,
  work: Readonly<Record<string, number>>,
  finalWork: Readonly<Record<string, number>> = {},
): void {
  const aggregate = accumulator.stages[stage] ?? {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    work: {},
  };
  aggregate.count += 1;
  aggregate.totalMs += durationMs;
  aggregate.maxMs = Math.max(aggregate.maxMs, durationMs);
  addWork(aggregate, work);
  addWork(aggregate, finalWork);
  accumulator.stages[stage] = aggregate;
}

/**
 * Time one transcript stage when the E2E performance harness is active.
 * Production builds inline `__CANOPY_E2E__` to false and remove this branch.
 */
export function beginTranscriptPerformanceStage(
  stage: TranscriptPerformanceStage,
  initialWork: Readonly<Record<string, number>> = {},
): (finalWork?: Readonly<Record<string, number>>) => void {
  if (!__CANOPY_E2E__) return NOOP_FINISH;
  const accumulator = currentAccumulator();
  if (!accumulator) return NOOP_FINISH;
  const startedAt = performance.now();
  return (finalWork = {}): void => {
    const durationMs = Math.max(0, performance.now() - startedAt);
    recordTranscriptPerformanceStage(
      accumulator,
      stage,
      durationMs,
      initialWork,
      finalWork,
    );
  };
}

export interface TranscriptPerformanceFrameQueue {
  enqueue: (
    correlationId: string,
    work?: Readonly<Record<string, number>>,
  ) => void;
  dispose: () => void;
}

export function createTranscriptPerformanceFrameQueue(
  options: {
    requestFrame?: (callback: FrameRequestCallback) => number;
    cancelFrame?: (handle: number) => void;
    now?: () => number;
  } = {},
): TranscriptPerformanceFrameQueue {
  const requestFrame = options.requestFrame ?? requestAnimationFrame;
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
  const now = options.now ?? ((): number => performance.now());
  const pending: Array<{
    accumulator: TranscriptPerformanceAccumulator;
    correlationId: string;
    startedAt: number;
    work: Readonly<Record<string, number>>;
  }> = [];
  let frameHandle: number | undefined;
  const flush = (): void => {
    frameHandle = undefined;
    const accumulator = currentAccumulator();
    const samples = pending.splice(0);
    if (!accumulator) return;
    for (const sample of samples) {
      if (sample.accumulator !== accumulator) continue;
      const elapsedMs = Math.max(0, now() - sample.startedAt);
      recordTranscriptPerformanceStage(
        accumulator,
        'commit_to_frame',
        elapsedMs,
        sample.work,
      );
      recordTranscriptPerformanceCorrelation(
        sample.correlationId,
        'commit_to_frame',
        elapsedMs,
        sample.work,
      );
    }
  };
  return {
    enqueue(correlationId, work = {}): void {
      if (!__CANOPY_E2E__) return;
      const accumulator = currentAccumulator();
      if (!accumulator) return;
      pending.push({ accumulator, correlationId, startedAt: now(), work });
      if (frameHandle === undefined) frameHandle = requestFrame(flush);
    },
    dispose(): void {
      if (frameHandle !== undefined) cancelFrame(frameHandle);
      frameHandle = undefined;
      pending.length = 0;
    },
  };
}

export function recordTranscriptPerformanceCounter(
  name: string,
  amount = 1,
): void {
  if (!__CANOPY_E2E__) return;
  const accumulator = currentAccumulator();
  if (!accumulator || !Number.isFinite(amount)) return;
  accumulator.counters[name] = (accumulator.counters[name] ?? 0) + amount;
}

export function setTranscriptPerformanceCounter(
  name: string,
  value: number,
): void {
  if (!__CANOPY_E2E__ || !Number.isFinite(value)) return;
  const accumulator = currentAccumulator();
  if (!accumulator) return;
  accumulator.counters[name] = value;
}

export function recordTranscriptPerformanceCorrelation(
  id: string,
  stage: TranscriptPerformanceStage,
  elapsedMs: number,
  work: Readonly<Record<string, number>> = {},
): void {
  if (!__CANOPY_E2E__ || !Number.isFinite(elapsedMs)) return;
  const accumulator = currentAccumulator();
  if (!accumulator) return;
  accumulator.correlations.push({
    id,
    process: 'renderer',
    stage,
    elapsedMs: Math.max(0, elapsedMs),
    work: Object.fromEntries(
      Object.entries(work).filter(([, value]) => Number.isFinite(value)),
    ),
  });
}

export function markTranscriptPerformanceCommitStart(
  chatId: string,
  correlationId: string,
  work: Readonly<Record<string, number>> = {},
): void {
  if (
    !__CANOPY_E2E__ ||
    !currentAccumulator() ||
    !mountedCommitTargets.has(chatId)
  ) {
    return;
  }
  pendingCommitStarts.set(chatId, {
    correlationId,
    startedAt: performance.now(),
    work,
  });
}

export function finishTranscriptPerformanceCommit(
  chatId: string,
  finalWork: Readonly<Record<string, number>> = {},
): string | undefined {
  if (!__CANOPY_E2E__) return undefined;
  const accumulator = currentAccumulator();
  const pending = pendingCommitStarts.get(chatId);
  if (!accumulator || !pending) return undefined;
  pendingCommitStarts.delete(chatId);
  const elapsedMs = Math.max(0, performance.now() - pending.startedAt);
  if (elapsedMs > MAX_PENDING_COMMIT_AGE_MS) return undefined;
  const work = { ...pending.work, ...finalWork };
  const aggregate = accumulator.stages.react_commit ?? {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    work: {},
  };
  aggregate.count += 1;
  aggregate.totalMs += elapsedMs;
  aggregate.maxMs = Math.max(aggregate.maxMs, elapsedMs);
  addWork(aggregate, work);
  accumulator.stages.react_commit = aggregate;
  recordTranscriptPerformanceCorrelation(
    pending.correlationId,
    'react_commit',
    elapsedMs,
    work,
  );
  return pending.correlationId;
}

export function registerTranscriptPerformanceCommitTarget(
  chatId: string,
): () => void {
  if (!__CANOPY_E2E__) return NOOP_FINISH;
  mountedCommitTargets.set(chatId, (mountedCommitTargets.get(chatId) ?? 0) + 1);
  return (): void => {
    const remaining = (mountedCommitTargets.get(chatId) ?? 1) - 1;
    if (remaining > 0) {
      mountedCommitTargets.set(chatId, remaining);
      return;
    }
    mountedCommitTargets.delete(chatId);
    pendingCommitStarts.delete(chatId);
  };
}

export function scheduleTranscriptPerformanceSnapshot(
  capture: () => void,
  delayMs = 100,
): () => void {
  if (!__CANOPY_E2E__) return NOOP_FINISH;
  const accumulator = currentAccumulator();
  if (!accumulator) return NOOP_FINISH;
  const timeout = setTimeout(() => {
    if (currentAccumulator() !== accumulator) return;
    capture();
  }, delayMs);
  return (): void => clearTimeout(timeout);
}
