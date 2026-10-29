import type {
  ExecutionHandle,
  ExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor';
import {
  cancelAllActivePipelineExecutions,
  isExecutionReservedBy,
  releaseExecutionReservation,
  reserveExecution,
  trackExecution,
  tryReserveExecution,
} from '../pipelines/pipeline-execution-registry';

function createState(id: string): ExecutionState {
  return {
    version: 3,
    id,
    pipeline_id: id,
    pipeline_snapshot: {
      name: id,
      jobs: {},
    },
    status: 'cancelled',
    jobs: {},
    started_at: '2026-05-25T00:00:00.000Z',
    completed_at: '2026-05-25T00:00:00.000Z',
    cwd: '/tmp/repo',
    env: {},
    inputs: {},
  };
}

describe('pipeline-execution-registry', () => {
  afterEach(async () => {
    await cancelAllActivePipelineExecutions({ timeoutMs: 1 });
  });

  it('waits for active executions to finish cancellation', async () => {
    let resolveCompletion: ((state: ExecutionState) => void) | undefined;
    const completion = new Promise<ExecutionState>((resolve) => {
      resolveCompletion = resolve;
    });
    const cancel = jest.fn(() => completion);
    const handle: ExecutionHandle = {
      id: 'exec-wait',
      cancel,
      getState: () => createState('exec-wait'),
      waitForCompletion: () => completion,
    };

    reserveExecution(handle.id);
    trackExecution(handle);
    const cancellation = cancelAllActivePipelineExecutions({
      timeoutMs: 1_000,
    });
    let settled = false;
    void cancellation.then(() => {
      settled = true;
    });

    await Promise.resolve();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    resolveCompletion?.(createState('exec-wait'));
    await cancellation;

    expect(settled).toBe(true);
  });

  it('claims a reservation atomically without replacing its owner', () => {
    const executionId = 'exec-reserved';
    expect(
      tryReserveExecution(executionId, 'matrix-variant-cancellation'),
    ).toBe(true);
    try {
      expect(tryReserveExecution(executionId)).toBe(false);
      expect(() => reserveExecution(executionId)).toThrow(
        `Execution "${executionId}" is already active`,
      );
      expect(
        isExecutionReservedBy(executionId, 'matrix-variant-cancellation'),
      ).toBe(true);
      expect(isExecutionReservedBy(executionId, 'pipeline-start')).toBe(false);
      releaseExecutionReservation(executionId);
      expect(
        isExecutionReservedBy(executionId, 'matrix-variant-cancellation'),
      ).toBe(true);
    } finally {
      releaseExecutionReservation(executionId, 'matrix-variant-cancellation');
    }
  });

  it('promotes only a pipeline-start reservation to a running execution', () => {
    const state = createState('exec-promoted');
    const handle: ExecutionHandle = {
      id: state.id,
      cancel: jest.fn(() => Promise.resolve(state)),
      getState: () => state,
      waitForCompletion: () => Promise.resolve(state),
    };

    expect(tryReserveExecution(state.id, 'matrix-variant-cancellation')).toBe(
      true,
    );
    expect(() => trackExecution(handle)).toThrow(
      `Execution "${state.id}" does not have a pipeline start reservation`,
    );
    expect(isExecutionReservedBy(state.id, 'matrix-variant-cancellation')).toBe(
      true,
    );

    releaseExecutionReservation(state.id, 'matrix-variant-cancellation');
    reserveExecution(state.id);
    expect(() => trackExecution(handle)).not.toThrow();
  });

  it('returns after the shutdown cancellation timeout', async () => {
    let resolveCompletion: ((state: ExecutionState) => void) | undefined;
    const completion = new Promise<ExecutionState>((resolve) => {
      resolveCompletion = resolve;
    });
    const cancel = jest.fn(() => completion);
    const handle: ExecutionHandle = {
      id: 'exec-timeout',
      cancel,
      getState: () => createState('exec-timeout'),
      waitForCompletion: () => completion,
    };

    reserveExecution(handle.id);
    trackExecution(handle);
    const cancellation = cancelAllActivePipelineExecutions({ timeoutMs: 5 });

    await Promise.resolve();
    await cancellation;

    expect(cancel).toHaveBeenCalledTimes(1);

    resolveCompletion?.(createState('exec-timeout'));
    await Promise.resolve();
  });
});

it('closes admission and drains a start that was reserved before shutdown', async () => {
  await jest.isolateModulesAsync(async () => {
    const registry = await import('../pipelines/pipeline-execution-registry');
    let finish!: (state: ExecutionState) => void;
    const completion = new Promise<ExecutionState>((resolve) => {
      finish = resolve;
    });
    const cancel = jest.fn(() => completion);
    const pauseForShutdown = jest.fn(() => completion);
    const handle: ExecutionHandle = {
      id: 'late-start',
      getState: () => createState('late-start'),
      cancel,
      pauseForShutdown,
      waitForCompletion: () => completion,
    };
    registry.reserveExecution(handle.id);
    let stopped = false;
    const shutdown = registry.pauseAllActivePipelineExecutions().then(() => {
      stopped = true;
    });
    expect(registry.tryReserveExecution('new-start')).toBe(false);
    registry.trackExecution(handle);
    expect(pauseForShutdown).toHaveBeenCalledTimes(1);
    expect(stopped).toBe(false);
    finish(createState(handle.id));
    await shutdown;
    expect(stopped).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
  });
});

it('bounds shutdown when a reserved pipeline start never attaches a handle', async () => {
  await jest.isolateModulesAsync(async () => {
    const registry = await import('../pipelines/pipeline-execution-registry');
    registry.reserveExecution('abandoned-start');

    await registry.pauseAllActivePipelineExecutions({
      reservationDrainTimeoutMs: 5,
    });

    expect(registry.hasActiveExecution('abandoned-start')).toBe(false);
  });
});

it('rejects shutdown when a late-attached execution cannot finish checkpointing', async () => {
  await jest.isolateModulesAsync(async () => {
    const registry = await import('../pipelines/pipeline-execution-registry');
    let finish!: (state: ExecutionState) => void;
    const completion = new Promise<ExecutionState>((resolve) => {
      finish = resolve;
    });
    const pauseForShutdown = jest.fn(() => new Promise<void>(() => undefined));
    const handle: ExecutionHandle = {
      id: 'late-stuck-start',
      getState: () => createState('late-stuck-start'),
      cancel: jest.fn(() => completion),
      pauseForShutdown,
      waitForCompletion: () => completion,
    };
    registry.reserveExecution(handle.id);
    const shutdown = registry.pauseAllActivePipelineExecutions({
      reservationDrainTimeoutMs: 5,
    });

    registry.trackExecution(handle);

    await expect(shutdown).rejects.toThrow(
      'Timed out waiting for active pipeline executions to checkpoint',
    );
    expect(pauseForShutdown).toHaveBeenCalledTimes(1);
    finish(createState(handle.id));
    await Promise.resolve();
  });
});

it('accepts and pauses a start that attaches after its reservation times out', async () => {
  await jest.isolateModulesAsync(async () => {
    const registry = await import('../pipelines/pipeline-execution-registry');
    const completion = Promise.resolve(createState('late-after-timeout'));
    const pauseForShutdown = jest.fn(() => completion);
    const handle: ExecutionHandle = {
      id: 'late-after-timeout',
      getState: () => createState('late-after-timeout'),
      cancel: jest.fn(() => completion),
      pauseForShutdown,
      waitForCompletion: () => completion,
    };
    registry.reserveExecution(handle.id);

    await registry.pauseAllActivePipelineExecutions({
      reservationDrainTimeoutMs: 5,
    });
    expect(() => registry.trackExecution(handle)).not.toThrow();
    expect(pauseForShutdown).toHaveBeenCalledTimes(1);
    await completion;
  });
});
