import type {
  ExecutionEvent,
  ExecutionState,
} from '@canopy/desktop-shared/types/pipeline';
import {
  broadcastPipelineExecutionEvent,
  PipelineExecutionEventBroadcaster,
  PIPELINE_EXECUTION_UPDATE_BROADCAST_INTERVAL_MS,
  resetPipelineExecutionEventBroadcasterForTests,
} from '../pipelines/pipeline-execution-event-broadcaster';
import * as retryScheduler from '../pipelines/transient-error-retry-scheduler';
import { sendToAllWindows } from '../lib/window-send';

jest.mock('../lib/window-send', () => ({ sendToAllWindows: jest.fn() }));

function makeEvent(
  executionId: string,
  type: ExecutionEvent['type'],
  status: ExecutionState['status'],
  marker: string,
): ExecutionEvent {
  return {
    executionId,
    type,
    timestamp: `2026-07-29T00:00:00.${marker}Z`,
    state: {
      version: 7,
      id: executionId,
      pipeline_id: `pipeline-${marker}`,
      pipeline_snapshot: {
        name: 'Renderer event coalescing',
        jobs: {},
      },
      status,
      jobs: {},
      started_at: '2026-07-29T00:00:00.000Z',
      cwd: '/tmp',
      env: {},
      inputs: {},
      status_reasons: [],
    },
  };
}

describe('PipelineExecutionEventBroadcaster', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    resetPipelineExecutionEventBroadcasterForTests();
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('reads live retry state only when the latest coalesced update is sent', () => {
    let nextRetryAt = 30_000;
    const decorate = jest
      .spyOn(retryScheduler, 'withPipelineTransientRetryState')
      .mockImplementation((state) => ({
        ...state,
        transient_retry: {
          attempt: 1,
          maxAttempts: 10,
          nextRetryAt,
          exhausted: false,
        },
      }));
    broadcastPipelineExecutionEvent(
      makeEvent('execution-1', 'execution.updated', 'running', '001'),
    );
    const latest = makeEvent(
      'execution-1',
      'execution.updated',
      'running',
      '002',
    );
    broadcastPipelineExecutionEvent(latest);
    nextRetryAt = 60_000;
    jest.advanceTimersByTime(PIPELINE_EXECUTION_UPDATE_BROADCAST_INTERVAL_MS);

    expect(sendToAllWindows).toHaveBeenCalledWith(expect.any(String), {
      ...latest,
      state: {
        ...latest.state,
        transient_retry: {
          attempt: 1,
          maxAttempts: 10,
          nextRetryAt: 60_000,
          exhausted: false,
        },
      },
    });
    expect(decorate).toHaveBeenCalledTimes(1);
  });

  it('broadcasts only the latest full running snapshot in each interval', () => {
    const send = jest.fn<void, [ExecutionEvent]>();
    const broadcaster = new PipelineExecutionEventBroadcaster(send);
    const first = makeEvent(
      'execution-1',
      'execution.updated',
      'running',
      '001',
    );
    const latest = makeEvent(
      'execution-1',
      'execution.updated',
      'running',
      '002',
    );

    broadcaster.publish(first);
    broadcaster.publish(latest);

    expect(send).not.toHaveBeenCalled();
    jest.advanceTimersByTime(
      PIPELINE_EXECUTION_UPDATE_BROADCAST_INTERVAL_MS - 1,
    );
    expect(send).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(latest);

    broadcaster.dispose();
  });

  it('coalesces a sparse legacy update with no status reasons', () => {
    const send = jest.fn<void, [ExecutionEvent]>();
    const broadcaster = new PipelineExecutionEventBroadcaster(send);
    const event = makeEvent(
      'execution-1',
      'execution.updated',
      'running',
      '001',
    );
    Reflect.deleteProperty(event.state, 'status_reasons');

    expect(() => broadcaster.publish(event)).not.toThrow();
    expect(send).not.toHaveBeenCalled();
    jest.advanceTimersByTime(PIPELINE_EXECUTION_UPDATE_BROADCAST_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(event);

    broadcaster.dispose();
  });

  it('coalesces executions independently', () => {
    const send = jest.fn<void, [ExecutionEvent]>();
    const broadcaster = new PipelineExecutionEventBroadcaster(send);
    const firstExecutionLatest = makeEvent(
      'execution-1',
      'execution.updated',
      'running',
      '002',
    );
    const secondExecution = makeEvent(
      'execution-2',
      'execution.updated',
      'running',
      '003',
    );

    broadcaster.publish(
      makeEvent('execution-1', 'execution.updated', 'running', '001'),
    );
    broadcaster.publish(secondExecution);
    broadcaster.publish(firstExecutionLatest);
    jest.advanceTimersByTime(PIPELINE_EXECUTION_UPDATE_BROADCAST_INTERVAL_MS);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, firstExecutionLatest);
    expect(send).toHaveBeenNthCalledWith(2, secondExecution);

    broadcaster.dispose();
  });

  it.each([
    ['execution.started', 'running'],
    ['execution.paused', 'paused'],
    ['execution.cancelled', 'cancelled'],
    ['execution.completed', 'success'],
    ['execution.failed', 'failure'],
    ['execution.updated', 'paused'],
  ] satisfies Array<[ExecutionEvent['type'], ExecutionState['status']]>)(
    'broadcasts %s with %s state immediately',
    (type, status) => {
      const send = jest.fn<void, [ExecutionEvent]>();
      const broadcaster = new PipelineExecutionEventBroadcaster(send);
      const event = makeEvent('execution-1', type, status, '001');

      broadcaster.publish(event);

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(event);
      broadcaster.dispose();
    },
  );

  it('broadcasts an input blocker immediately while sibling work is running', () => {
    const send = jest.fn<void, [ExecutionEvent]>();
    const broadcaster = new PipelineExecutionEventBroadcaster(send);
    const event = makeEvent(
      'execution-1',
      'execution.updated',
      'running',
      '001',
    );
    event.state.status_reasons = [
      {
        id: '00000000-0000-4000-8000-000000000001',
        kind: 'input_required',
        code: 'input_requested',
        message: 'Decision required',
        detected_at: '2026-07-29T00:00:00.001Z',
        source: {
          job_id: 'process',
          step_id: 'approval',
        },
      },
    ];

    broadcaster.publish(event);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(event);
    broadcaster.dispose();
  });

  it('broadcasts pending pause checkpoints immediately while sibling work is running', () => {
    const send = jest.fn<void, [ExecutionEvent]>();
    const broadcaster = new PipelineExecutionEventBroadcaster(send);
    const event = makeEvent(
      'execution-1',
      'execution.updated',
      'running',
      '001',
    );
    event.state.pending_pauses = [
      {
        id: '00000000-0000-4000-8000-000000000001',
        kind: 'action',
        job_id: 'process',
        logical_job_id: 'process',
        step_id: 'approval',
        attempt: 0,
        iteration: 0,
        detected_at: '2026-07-29T00:00:00.001Z',
      },
    ];

    broadcaster.publish(event);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(event);
    broadcaster.dispose();
  });

  it('lets an immediate lifecycle event supersede a queued stale update', () => {
    const send = jest.fn<void, [ExecutionEvent]>();
    const broadcaster = new PipelineExecutionEventBroadcaster(send);
    const completed = makeEvent(
      'execution-1',
      'execution.completed',
      'success',
      '002',
    );

    broadcaster.publish(
      makeEvent('execution-1', 'execution.updated', 'running', '001'),
    );
    broadcaster.publish(completed);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(completed);
    jest.advanceTimersByTime(PIPELINE_EXECUTION_UPDATE_BROADCAST_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);

    broadcaster.dispose();
  });

  it('can flush one execution without releasing another', () => {
    const send = jest.fn<void, [ExecutionEvent]>();
    const broadcaster = new PipelineExecutionEventBroadcaster(send);
    const first = makeEvent(
      'execution-1',
      'execution.updated',
      'running',
      '001',
    );
    const second = makeEvent(
      'execution-2',
      'execution.updated',
      'running',
      '002',
    );

    broadcaster.publish(first);
    broadcaster.publish(second);
    broadcaster.flush(first.executionId);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(first);
    jest.advanceTimersByTime(PIPELINE_EXECUTION_UPDATE_BROADCAST_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(second);

    broadcaster.dispose();
  });
});
