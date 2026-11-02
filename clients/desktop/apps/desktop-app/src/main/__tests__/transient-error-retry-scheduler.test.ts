import type { BrowserWindow } from 'electron';
import type {
  ExecutionEvent,
  ExecutionState,
  PipelineStatusReason,
} from '@canopy/desktop-shared/types/pipeline';
import type {
  ResumePipelineExecutionFromMainRequest,
  ResumePipelineExecutionFromMainResult,
} from '../pipelines/pipeline-resume-service';
import {
  cancelPendingTransientRetryTimer,
  initTransientErrorRetryScheduler,
  notePipelineExecutionEvent,
  resetTransientErrorRetrySchedulerForTests,
  withPipelineTransientRetryState,
} from '../pipelines/transient-error-retry-scheduler';

const EXECUTION_ID = 'execution-1';
const REASON_IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
];

interface SchedulerHarness {
  events: ExecutionEvent[];
  resumeRequests: ResumePipelineExecutionFromMainRequest[];
  setPreference: (enabled: boolean) => void;
}

function transientReason(
  id: string,
  jobId = 'job-1',
  stepId = 'step-1',
): PipelineStatusReason {
  return {
    id,
    kind: 'provider_temporarily_unavailable',
    code: 'server_overloaded',
    provider: 'claude',
    account_scope: 'native',
    detected_at: '2026-07-17T00:00:00.000Z',
    source: {
      job_id: jobId,
      step_id: stepId,
      attempt: 1,
      iteration: 1,
    },
  };
}

function executionState(
  status: ExecutionState['status'],
  reasons: PipelineStatusReason[] = [],
  parentExecutionId?: string,
): ExecutionState {
  return {
    version: 6,
    id: EXECUTION_ID,
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: {
      name: 'Retry pipeline',
      scope: ['directory'],
      jobs: {},
    },
    status,
    status_reasons: reasons,
    jobs: {},
    job_definitions: {},
    job_groups: {},
    pending_pauses: [],
    started_at: '2026-07-17T00:00:00.000Z',
    cwd: '/tmp/retry-pipeline',
    env: {},
    inputs: {},
    ...(parentExecutionId ? { parent_execution_id: parentExecutionId } : {}),
  };
}

function executionEvent(
  type: ExecutionEvent['type'],
  status: ExecutionState['status'],
  reasons: PipelineStatusReason[] = [],
  parentExecutionId?: string,
): ExecutionEvent {
  return {
    executionId: EXECUTION_ID,
    type,
    state: executionState(status, reasons, parentExecutionId),
    timestamp: '2026-07-17T00:00:00.000Z',
  };
}

function pausedEvent(
  reasons: PipelineStatusReason[] = [transientReason(REASON_IDS[0] ?? '')],
  parentExecutionId?: string,
): ExecutionEvent {
  return executionEvent(
    'execution.paused',
    'paused',
    reasons,
    parentExecutionId,
  );
}

function createHarness(options?: {
  readPreferences?: () => Promise<{
    autoRetryTransientErrorsPipelines: boolean;
  }>;
  resume?: (
    request: ResumePipelineExecutionFromMainRequest,
  ) => Promise<ResumePipelineExecutionFromMainResult>;
}): SchedulerHarness {
  let preference = true;
  const resumeRequests: ResumePipelineExecutionFromMainRequest[] = [];
  const events: ExecutionEvent[] = [];
  initTransientErrorRetryScheduler({
    emitEvent: (event) => {
      events.push(event);
    },
    readPreferences:
      options?.readPreferences ??
      ((): Promise<{ autoRetryTransientErrorsPipelines: boolean }> =>
        Promise.resolve({
          autoRetryTransientErrorsPipelines: preference,
        })),
    resume:
      options?.resume ??
      ((request): Promise<ResumePipelineExecutionFromMainResult> => {
        resumeRequests.push(request);
        return Promise.resolve({
          status: 'started',
          state: executionState('running'),
        });
      }),
  });
  return {
    events,
    resumeRequests,
    setPreference: (enabled): void => {
      preference = enabled;
    },
  };
}

function getWindow(): BrowserWindow | null {
  return null;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('transient-error-retry-scheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    resetTransientErrorRetrySchedulerForTests();
    jest.useRealTimers();
  });

  it('preserves snapshots when no retry display needs changing', () => {
    const state = executionState('running');
    expect(withPipelineTransientRetryState(state)).toBe(state);
  });

  it('resumes a transient pause after 30 seconds with only transient reasons', async () => {
    const harness = createHarness();
    const authReason: PipelineStatusReason = {
      ...transientReason(REASON_IDS[1] ?? ''),
      kind: 'provider_authentication_required',
      code: 'authentication_failed',
    };
    notePipelineExecutionEvent(
      pausedEvent([transientReason(REASON_IDS[0] ?? ''), authReason]),
      getWindow,
    );
    await flushPromises();

    const expectedDisplay = {
      attempt: 1,
      maxAttempts: 10,
      nextRetryAt: Date.now() + 30_000,
      exhausted: false,
    };
    expect(
      harness.events[harness.events.length - 1]?.state.transient_retry,
    ).toEqual(expectedDisplay);
    expect(
      withPipelineTransientRetryState(executionState('paused')).transient_retry,
    ).toEqual(expectedDisplay);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(
      harness.events[harness.events.length - 1]?.state.transient_retry,
    ).toMatchObject({
      nextRetryAt: null,
      exhausted: false,
    });

    expect(harness.resumeRequests).toHaveLength(1);
    expect(harness.resumeRequests[0]).toMatchObject({
      executionId: EXECUTION_ID,
      statusReasonIds: [REASON_IDS[0]],
      allowStaleNoop: true,
      initiationSource: 'automation',
    });
    expect(typeof harness.resumeRequests[0]?.transientRetryOwnToken).toBe(
      'number',
    );
  });

  it('deduplicates valid transient reason IDs and rejects invalid IDs', async () => {
    const harness = createHarness();
    notePipelineExecutionEvent(
      pausedEvent([
        transientReason(REASON_IDS[0] ?? ''),
        transientReason(REASON_IDS[0] ?? ''),
        transientReason(''),
        transientReason('not-a-uuid'),
      ]),
      getWindow,
    );
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);

    expect(harness.resumeRequests).toHaveLength(1);
    expect(harness.resumeRequests[0]?.statusReasonIds).toEqual([REASON_IDS[0]]);

    resetTransientErrorRetrySchedulerForTests();
    const invalidHarness = createHarness();
    notePipelineExecutionEvent(
      pausedEvent([transientReason(''), transientReason('not-a-uuid')]),
      getWindow,
    );
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(invalidHarness.resumeRequests).toHaveLength(0);
  });

  it('uses all ten schedule slots and does not schedule an eleventh attempt', async () => {
    const harness = createHarness();
    const delays = [
      30_000, 30_000, 60_000, 60_000, 120_000, 120_000, 240_000, 240_000,
      480_000, 480_000,
    ];

    for (const delay of delays) {
      notePipelineExecutionEvent(pausedEvent(), getWindow);
      await flushPromises();
      await jest.advanceTimersByTimeAsync(delay);
    }
    expect(harness.resumeRequests).toHaveLength(10);

    notePipelineExecutionEvent(pausedEvent(), getWindow);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(1_000_000);
    expect(
      harness.events[harness.events.length - 1]?.state.transient_retry,
    ).toEqual({
      attempt: 10,
      maxAttempts: 10,
      nextRetryAt: null,
      exhausted: true,
    });
    cancelPendingTransientRetryTimer(EXECUTION_ID);
    expect(
      harness.events[harness.events.length - 1]?.state.transient_retry,
    ).toBeUndefined();
    expect(
      withPipelineTransientRetryState(executionState('paused')).transient_retry,
    ).toBeUndefined();
    expect(harness.resumeRequests).toHaveLength(10);
  });

  it('invalidates an older resume continuation when an exhausted incident re-pauses', async () => {
    const requests: ResumePipelineExecutionFromMainRequest[] = [];
    let resolveTenthResume: (
      result: ResumePipelineExecutionFromMainResult,
    ) => void = (): void => undefined;
    const tenthResume = new Promise<ResumePipelineExecutionFromMainResult>(
      (resolve) => {
        resolveTenthResume = resolve;
      },
    );
    createHarness({
      resume: (request) => {
        requests.push(request);
        if (requests.length === 10) return tenthResume;
        return Promise.resolve({
          status: 'started',
          state: executionState('running'),
        });
      },
    });
    const delays = [
      30_000, 30_000, 60_000, 60_000, 120_000, 120_000, 240_000, 240_000,
      480_000, 480_000,
    ];

    for (const delay of delays) {
      notePipelineExecutionEvent(pausedEvent(), getWindow);
      await flushPromises();
      await jest.advanceTimersByTimeAsync(delay);
    }
    expect(requests).toHaveLength(10);

    notePipelineExecutionEvent(pausedEvent(), getWindow);
    resolveTenthResume({
      status: 'stale-noop',
      state: executionState('paused'),
    });
    await flushPromises();

    notePipelineExecutionEvent(pausedEvent(), getWindow);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(1_000_000);
    expect(requests).toHaveLength(10);
  });

  it('resets the cadence when a different step fails', async () => {
    const harness = createHarness();
    notePipelineExecutionEvent(pausedEvent(), getWindow);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    notePipelineExecutionEvent(pausedEvent(), getWindow);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.resumeRequests).toHaveLength(2);

    notePipelineExecutionEvent(
      pausedEvent([
        transientReason(REASON_IDS[1] ?? '', 'job-1', 'different-step'),
      ]),
      getWindow,
    );
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.resumeRequests).toHaveLength(3);
  });

  it('treats transient failures in sibling matrix variants independently', async () => {
    const harness = createHarness();
    const firstChildReason = transientReason(
      REASON_IDS[0] ?? '',
      'job-1--matrix-0',
      'step-1',
    );
    notePipelineExecutionEvent(pausedEvent([firstChildReason]), getWindow);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    notePipelineExecutionEvent(pausedEvent([firstChildReason]), getWindow);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.resumeRequests).toHaveLength(2);

    notePipelineExecutionEvent(
      pausedEvent([
        transientReason(REASON_IDS[1] ?? '', 'job-1--matrix-1', 'step-1'),
      ]),
      getWindow,
    );
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.resumeRequests).toHaveLength(3);
  });

  it('keeps already-running incidents, deletes stale/throw incidents, and clears on terminal events', async () => {
    const results: Array<'already-running' | 'stale-noop' | 'throw'> = [
      'already-running',
      'stale-noop',
      'throw',
    ];
    const requests: ResumePipelineExecutionFromMainRequest[] = [];
    createHarness({
      resume: (request) => {
        requests.push(request);
        const result = results.shift();
        if (result === 'throw')
          return Promise.reject(new Error('resume failed'));
        return Promise.resolve({
          status: result ?? 'started',
          state: executionState(
            result === 'already-running' ? 'running' : 'paused',
          ),
        });
      },
    });

    notePipelineExecutionEvent(pausedEvent(), getWindow);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    notePipelineExecutionEvent(pausedEvent(), getWindow);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    notePipelineExecutionEvent(pausedEvent(), getWindow);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(requests).toHaveLength(3);

    notePipelineExecutionEvent(pausedEvent(), getWindow);
    await flushPromises();
    notePipelineExecutionEvent(
      executionEvent('execution.cancelled', 'cancelled'),
      getWindow,
    );
    await jest.advanceTimersByTimeAsync(30_000);
    expect(requests).toHaveLength(3);
  });

  it('ignores child executions and does not schedule when the preference is off', async () => {
    const harness = createHarness();
    notePipelineExecutionEvent(
      pausedEvent(undefined, 'parent-execution'),
      getWindow,
    );
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.resumeRequests).toHaveLength(0);

    const authReason: PipelineStatusReason = {
      ...transientReason(REASON_IDS[1] ?? ''),
      kind: 'provider_authentication_required',
      code: 'authentication_failed',
    };
    notePipelineExecutionEvent(pausedEvent([authReason]), getWindow);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.resumeRequests).toHaveLength(0);

    notePipelineExecutionEvent(pausedEvent(), getWindow);
    harness.setPreference(false);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.resumeRequests).toHaveLength(0);
  });

  it('invalidates pending preference reads on manual resume or terminal events', async () => {
    let resolvePreference: (value: {
      autoRetryTransientErrorsPipelines: boolean;
    }) => void = (): void => undefined;
    let pendingPreference = new Promise<{
      autoRetryTransientErrorsPipelines: boolean;
    }>((resolve) => {
      resolvePreference = resolve;
    });
    const requests: ResumePipelineExecutionFromMainRequest[] = [];
    createHarness({
      readPreferences: () => pendingPreference,
      resume: (request) => {
        requests.push(request);
        return Promise.resolve({
          status: 'started',
          state: executionState('running'),
        });
      },
    });

    notePipelineExecutionEvent(pausedEvent(), getWindow);
    cancelPendingTransientRetryTimer(EXECUTION_ID);
    resolvePreference({ autoRetryTransientErrorsPipelines: true });
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(requests).toHaveLength(0);

    resetTransientErrorRetrySchedulerForTests();
    pendingPreference = new Promise((resolve) => {
      resolvePreference = resolve;
    });
    initTransientErrorRetryScheduler({
      readPreferences: () => pendingPreference,
      resume: (request) => {
        requests.push(request);
        return Promise.resolve({
          status: 'started',
          state: executionState('running'),
        });
      },
    });
    notePipelineExecutionEvent(pausedEvent(), getWindow);
    notePipelineExecutionEvent(
      executionEvent('execution.failed', 'failure'),
      getWindow,
    );
    resolvePreference({ autoRetryTransientErrorsPipelines: true });
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(requests).toHaveLength(0);
  });

  it('rechecks the live token after timer preference reads and resume awaits', async () => {
    let readCount = 0;
    let resolveTimerPreference: (value: {
      autoRetryTransientErrorsPipelines: boolean;
    }) => void = (): void => undefined;
    const timerPreference = new Promise<{
      autoRetryTransientErrorsPipelines: boolean;
    }>((resolve) => {
      resolveTimerPreference = resolve;
    });
    const requests: ResumePipelineExecutionFromMainRequest[] = [];
    createHarness({
      readPreferences: () => {
        readCount += 1;
        return readCount === 1
          ? Promise.resolve({ autoRetryTransientErrorsPipelines: true })
          : timerPreference;
      },
      resume: (request) => {
        requests.push(request);
        return Promise.resolve({
          status: 'started',
          state: executionState('running'),
        });
      },
    });
    notePipelineExecutionEvent(pausedEvent(), getWindow);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    notePipelineExecutionEvent(
      executionEvent('execution.failed', 'failure'),
      getWindow,
    );
    resolveTimerPreference({ autoRetryTransientErrorsPipelines: true });
    await flushPromises();
    expect(requests).toHaveLength(0);

    resetTransientErrorRetrySchedulerForTests();
    let resolveResume: (
      result: ResumePipelineExecutionFromMainResult,
    ) => void = (): void => undefined;
    const pendingResume = new Promise<ResumePipelineExecutionFromMainResult>(
      (resolve) => {
        resolveResume = resolve;
      },
    );
    initTransientErrorRetryScheduler({
      readPreferences: () =>
        Promise.resolve({ autoRetryTransientErrorsPipelines: true }),
      resume: (request) => {
        requests.push(request);
        return pendingResume;
      },
    });
    notePipelineExecutionEvent(pausedEvent(), getWindow);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    notePipelineExecutionEvent(pausedEvent(), getWindow);
    await flushPromises();
    resolveResume({ status: 'stale-noop', state: executionState('paused') });
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(requests).toHaveLength(2);
  });

  it('preserves the scheduler token for its own resume and applies stale-noop', async () => {
    const requests: ResumePipelineExecutionFromMainRequest[] = [];
    createHarness({
      resume: (request) => {
        requests.push(request);
        cancelPendingTransientRetryTimer(
          request.executionId,
          request.transientRetryOwnToken,
        );
        return Promise.resolve({
          status: requests.length === 1 ? 'stale-noop' : 'started',
          state: executionState('paused'),
        });
      },
    });

    notePipelineExecutionEvent(pausedEvent(), getWindow);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    notePipelineExecutionEvent(pausedEvent(), getWindow);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    notePipelineExecutionEvent(pausedEvent(), getWindow);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);

    expect(requests).toHaveLength(3);
  });
});
