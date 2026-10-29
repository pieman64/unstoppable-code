import {
  beginMainTranscriptPerformanceStage,
  initializeMainTranscriptPerformance,
  mainTranscriptPerformanceEnabled,
  snapshotMainTranscriptPerformance,
} from '../lib/transcript-performance';

describe('main transcript performance instrumentation', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      configurable: true,
      value: true,
    });
    initializeMainTranscriptPerformance();
  });

  afterEach(() => {
    delete globalThis.__CANOPY_MAIN_TRANSCRIPT_PERF__;
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      configurable: true,
      value: false,
    });
    jest.restoreAllMocks();
  });

  it('records main-process stages with correlation and bounded work metadata', () => {
    jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(14);
    beginMainTranscriptPerformanceStage(
      'active_tail_reconstruction',
      'chat-1',
      {
        requestedRows: 20,
      },
    )({ loadedRows: 12, loadedBytes: 4_096 });

    expect(snapshotMainTranscriptPerformance()).toMatchObject({
      schemaVersion: 1,
      process: 'main',
      stages: {
        active_tail_reconstruction: {
          count: 1,
          totalMs: 4,
          maxMs: 4,
          work: { requestedRows: 20, loadedRows: 12, loadedBytes: 4_096 },
        },
      },
      correlations: [
        {
          id: 'chat-1',
          process: 'main',
          stage: 'active_tail_reconstruction',
          elapsedMs: 4,
        },
      ],
    });
  });

  it('does not enable payload measurement when only the runtime accumulator exists', () => {
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      configurable: true,
      value: false,
    });

    expect(globalThis.__CANOPY_MAIN_TRANSCRIPT_PERF__).toBeDefined();
    expect(mainTranscriptPerformanceEnabled()).toBe(false);
  });
});
