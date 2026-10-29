import {
  beginTranscriptPerformanceStage,
  createTranscriptPerformanceFrameQueue,
  finishTranscriptPerformanceCommit,
  markTranscriptPerformanceCommitStart,
  registerTranscriptPerformanceCommitTarget,
  recordTranscriptPerformanceCorrelation,
  recordTranscriptPerformanceCounter,
  scheduleTranscriptPerformanceSnapshot,
  setTranscriptPerformanceCounter,
  type TranscriptPerformanceAccumulator,
} from '../transcript-performance';

describe('transcript performance instrumentation', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      configurable: true,
      value: true,
    });
    globalThis.__CANOPY_TRANSCRIPT_PERF__ = {
      schemaVersion: 2,
      startedAt: performance.now(),
      stages: {},
      counters: {},
      correlations: [],
    } satisfies TranscriptPerformanceAccumulator;
  });

  afterEach(() => {
    delete globalThis.__CANOPY_TRANSCRIPT_PERF__;
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      configurable: true,
      value: false,
    });
    jest.restoreAllMocks();
  });

  it('aggregates stage duration and work without retaining transcript data', () => {
    jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(13.5)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(22);

    beginTranscriptPerformanceStage('turn_grouping', { messages: 40 })({
      groups: 4,
    });
    beginTranscriptPerformanceStage('turn_grouping', { messages: 10 })({
      groups: 1,
    });

    expect(globalThis.__CANOPY_TRANSCRIPT_PERF__?.stages.turn_grouping).toEqual(
      {
        count: 2,
        totalMs: 5.5,
        maxMs: 3.5,
        work: { messages: 50, groups: 5 },
      },
    );
  });

  it('records numeric counters and ignores invalid values', () => {
    recordTranscriptPerformanceCounter('canonical_changes', 3);
    recordTranscriptPerformanceCounter('canonical_changes', 2);
    recordTranscriptPerformanceCounter('canonical_changes', Number.NaN);

    expect(globalThis.__CANOPY_TRANSCRIPT_PERF__?.counters).toEqual({
      canonical_changes: 5,
    });
  });

  it('records gauges and bounded correlation metadata without transcript content', () => {
    setTranscriptPerformanceCounter('loaded_message_rows', 40);
    setTranscriptPerformanceCounter('loaded_bytes', 8_000);
    recordTranscriptPerformanceCorrelation(
      'revision-7',
      'store_publication',
      3,
      {
        changes: 4,
      },
    );

    expect(globalThis.__CANOPY_TRANSCRIPT_PERF__?.counters).toEqual({
      loaded_message_rows: 40,
      loaded_bytes: 8_000,
    });
    expect(globalThis.__CANOPY_TRANSCRIPT_PERF__?.correlations).toEqual([
      {
        id: 'revision-7',
        process: 'renderer',
        stage: 'store_publication',
        elapsedMs: 3,
        work: { changes: 4 },
      },
    ]);
  });

  it('measures store publication through the next layout commit boundary', () => {
    const unregister = registerTranscriptPerformanceCommitTarget('chat-1');
    jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(14);

    markTranscriptPerformanceCommitStart('chat-1', 'scope-1:revision-7', {
      changes: 2,
    });
    const correlationId = finishTranscriptPerformanceCommit('chat-1', {
      loadedRows: 40,
    });

    expect(correlationId).toBe('scope-1:revision-7');

    expect(globalThis.__CANOPY_TRANSCRIPT_PERF__?.stages.react_commit).toEqual({
      count: 1,
      totalMs: 4,
      maxMs: 4,
      work: { changes: 2, loadedRows: 40 },
    });
    expect(globalThis.__CANOPY_TRANSCRIPT_PERF__?.correlations).toContainEqual({
      id: 'scope-1:revision-7',
      process: 'renderer',
      stage: 'react_commit',
      elapsedMs: 4,
      work: { changes: 2, loadedRows: 40 },
    });
    unregister();
  });

  it('retains every commit correlation until the shared next frame runs', () => {
    const callbacks: FrameRequestCallback[] = [];
    const requestFrame = jest.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const cancelFrame = jest.fn();
    const now = jest
      .fn()
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(11)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(21)
      .mockReturnValueOnce(22)
      .mockReturnValueOnce(23);
    const queue = createTranscriptPerformanceFrameQueue({
      requestFrame,
      cancelFrame,
      now,
    });

    queue.enqueue('revision-1', { loadedRows: 10 });
    queue.enqueue('revision-2', { loadedRows: 11 });

    expect(requestFrame).toHaveBeenCalledTimes(1);
    callbacks[0]?.(20);
    expect(
      globalThis.__CANOPY_TRANSCRIPT_PERF__?.correlations.filter(
        (entry) => entry.stage === 'commit_to_frame',
      ),
    ).toEqual([
      expect.objectContaining({ id: 'revision-1' }),
      expect.objectContaining({ id: 'revision-2' }),
    ]);
    expect(
      globalThis.__CANOPY_TRANSCRIPT_PERF__?.stages.commit_to_frame?.count,
    ).toBe(2);
    expect(cancelFrame).not.toHaveBeenCalled();

    queue.dispose();
  });

  it('does not publish an old frame sample into a replacement collector', () => {
    let callback: FrameRequestCallback | undefined;
    const queue = createTranscriptPerformanceFrameQueue({
      requestFrame: (next) => {
        callback = next;
        return 1;
      },
      cancelFrame: jest.fn(),
      now: () => 10,
    });
    queue.enqueue('old-collector');
    globalThis.__CANOPY_TRANSCRIPT_PERF__ = {
      schemaVersion: 2,
      startedAt: 11,
      stages: {},
      counters: {},
      correlations: [],
    };
    callback?.(12);
    expect(globalThis.__CANOPY_TRANSCRIPT_PERF__.correlations).toEqual([]);
    queue.dispose();
  });

  it('does not retain commit starts for chats without a mounted target', () => {
    markTranscriptPerformanceCommitStart('background-chat', 'revision-8');
    finishTranscriptPerformanceCommit('background-chat');

    expect(globalThis.__CANOPY_TRANSCRIPT_PERF__?.stages.react_commit).toBe(
      undefined,
    );
  });

  it('drops stale commit starts instead of reporting time spent unmounted', () => {
    const unregister = registerTranscriptPerformanceCommitTarget('chat-1');
    jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(2_011);

    markTranscriptPerformanceCommitStart('chat-1', 'revision-9');
    finishTranscriptPerformanceCommit('chat-1');

    expect(globalThis.__CANOPY_TRANSCRIPT_PERF__?.stages.react_commit).toBe(
      undefined,
    );
    unregister();
  });

  it('clears pending commit starts when the collector is replaced', () => {
    const unregister = registerTranscriptPerformanceCommitTarget('chat-1');
    jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(14);
    markTranscriptPerformanceCommitStart('chat-1', 'old-collector');
    globalThis.__CANOPY_TRANSCRIPT_PERF__ = {
      schemaVersion: 2,
      startedAt: 11,
      stages: {},
      counters: {},
      correlations: [],
    };

    finishTranscriptPerformanceCommit('chat-1');

    expect(globalThis.__CANOPY_TRANSCRIPT_PERF__.stages.react_commit).toBe(
      undefined,
    );
    unregister();
  });

  it('defers snapshot work and skips it without an active collector', () => {
    jest.useFakeTimers();
    const capture = jest.fn();
    const cancel = scheduleTranscriptPerformanceSnapshot(capture);

    expect(capture).not.toHaveBeenCalled();
    jest.runAllTimers();
    expect(capture).toHaveBeenCalledTimes(1);

    cancel();
    delete globalThis.__CANOPY_TRANSCRIPT_PERF__;
    scheduleTranscriptPerformanceSnapshot(capture);
    jest.runAllTimers();
    expect(capture).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('does nothing when the build-time E2E gate is disabled', () => {
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      configurable: true,
      value: false,
    });
    const accumulator = globalThis.__CANOPY_TRANSCRIPT_PERF__;

    beginTranscriptPerformanceStage('page_install', { pageRows: 20 })();
    recordTranscriptPerformanceCounter('page_installs');

    expect(accumulator?.stages).toEqual({});
    expect(accumulator?.counters).toEqual({});
  });
});
