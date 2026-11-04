import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  WORKER_PIPELINE_GRANTS,
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_QUERY_DEFINITIONS,
  WORKER_PIPELINE_STREAM_DEFINITIONS,
  type CanopyCallerDescriptor,
  type WorkerPipelineCancelMode,
  type WorkerPipelineControlOutcome,
  type WorkerPipelineControlResult,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionEventsItem,
  type WorkerPipelineExecutionStartParams,
} from '@canopy/protocol/canopy-core';

import { createCanopyDispatcher } from '../../../../runtime/dispatcher';
import type { CanopyDispatcher } from '../../../../runtime/types';
import { createDirectLocalWorkerTransport } from '../../../../runtime/local-worker-transport';
import { createWorkerExecutorReceipts } from '../../../../runtime/worker-executor-receipts';
import { LocalWorkerExecution, OperationService } from '../../../operations';
import { OperationLedger } from '../../../operations/ledger';
import {
  CORE_PIPELINE_CANCEL_KIND,
  CORE_PIPELINE_CONTROL_KIND,
  CORE_PIPELINE_RECOVERY_KIND,
  CORE_PIPELINE_RUN_KIND,
  CorePipelineRuns,
} from '../core-pipeline-runs';
import {
  PipelineDrainTimeoutError,
  createWorkerPipelineHandlers,
  pipelineExecutionNotFoundError,
  pipelineCheckpointFailedError,
  pipelineControlFailedError,
  pipelineLaunchUnavailableError,
  type PipelineControlRequest,
  type PipelineExecutionObserver,
  type PipelineExecutionWorker,
} from '../worker-pipelines';

const EXECUTION_INSTRUCTIONS = {
  'worker.pipeline.execution.start':
    WORKER_PIPELINE_INSTRUCTION_DEFINITIONS['worker.pipeline.execution.start'],
  'worker.pipeline.execution.cancel':
    WORKER_PIPELINE_INSTRUCTION_DEFINITIONS['worker.pipeline.execution.cancel'],
  'worker.pipeline.execution.resume':
    WORKER_PIPELINE_INSTRUCTION_DEFINITIONS['worker.pipeline.execution.resume'],
  'worker.pipeline.execution.retry':
    WORKER_PIPELINE_INSTRUCTION_DEFINITIONS['worker.pipeline.execution.retry'],
  'worker.pipeline.matrixJob.retry':
    WORKER_PIPELINE_INSTRUCTION_DEFINITIONS['worker.pipeline.matrixJob.retry'],
  'worker.pipeline.matrixVariant.cancel':
    WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
      'worker.pipeline.matrixVariant.cancel'
    ],
  'worker.pipeline.recovery.sweep':
    WORKER_PIPELINE_INSTRUCTION_DEFINITIONS['worker.pipeline.recovery.sweep'],
  'worker.pipeline.recovery.checkpoint':
    WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
      'worker.pipeline.recovery.checkpoint'
    ],
};
const EXECUTION_STREAMS = {
  'worker.pipeline.execution.events':
    WORKER_PIPELINE_STREAM_DEFINITIONS['worker.pipeline.execution.events'],
};

const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'desktop-core',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [WORKER_PIPELINE_GRANTS.read, WORKER_PIPELINE_GRANTS.write],
};

function execution(
  executionId: string,
  status: WorkerPipelineExecution['status'],
): WorkerPipelineExecution {
  return {
    executionId,
    pipelineId: 'review',
    name: 'Review',
    status,
    runScope: 'worktree',
    definitionSource: 'user',
    owner: 'personal',
    workspaceId: 'alpha',
    worktreeId: 'main',
    parentExecutionId: null,
    startedAt: '2026-10-29T00:00:00.000Z',
    completedAt: null,
    pendingPauseCount: 0,
    error: null,
  };
}

/** A worker host whose executions the test drives by hand. */
class FakeWorker implements PipelineExecutionWorker {
  readonly launches = new Set<string>();
  readonly executions = new Map<string, WorkerPipelineExecution>();
  readonly cancelled: string[] = [];
  /** The mode of each cancel, in order. */
  readonly modes: WorkerPipelineCancelMode[] = [];
  /** When set, a drain's bounded wait ends with the run still stopping. */
  drainTimesOut = false;
  /** When set, starts wait for it. */
  startGate: Promise<void> | null = null;
  /** When set, cancels wait for it. */
  cancelGate: Promise<void> | null = null;
  /** Controls core prepared, by request id: the outcome and the status they leave. */
  readonly controls = new Map<
    string,
    {
      outcome: WorkerPipelineControlOutcome;
      status: WorkerPipelineExecution['status'];
    }
  >();
  /** The executions each sweep looked at, in order. */
  readonly swept: string[][] = [];
  /** When set, the shutdown checkpoint fails with it. */
  checkpointFails = false;
  /** The request id of every control the worker ran, in order. */
  readonly controlled: string[] = [];
  /** Runs as a subscription is made, before it is registered. */
  beforeObserve: (() => void) | null = null;
  private readonly observers = new Map<
    string,
    Set<PipelineExecutionObserver>
  >();

  start(
    params: WorkerPipelineExecutionStartParams,
  ): Promise<WorkerPipelineExecution> {
    if (!this.launches.delete(params.executionId))
      return Promise.reject(pipelineLaunchUnavailableError());
    const started = execution(params.executionId, 'running');
    return (this.startGate ?? Promise.resolve()).then(() => {
      this.executions.set(params.executionId, started);
      return started;
    });
  }

  control(
    request: PipelineControlRequest,
  ): Promise<WorkerPipelineControlResult> {
    const { requestId } = request.params;
    const prepared = this.controls.get(requestId);
    if (!prepared) return Promise.reject(pipelineLaunchUnavailableError());
    this.controls.delete(requestId);
    this.controlled.push(requestId);
    if (prepared.status === 'failure' && prepared.outcome === 'stale_noop')
      return Promise.reject(pipelineControlFailedError(new Error('refused')));
    const executionId =
      request.operation === 'worker.pipeline.execution.retry' &&
      request.params.newExecutionId !== undefined
        ? request.params.newExecutionId
        : request.params.executionId;
    const next = execution(executionId, prepared.status);
    if (
      prepared.outcome !== 'stale_noop' &&
      prepared.outcome !== 'already_running'
    )
      this.executions.set(executionId, next);
    return Promise.resolve({ outcome: prepared.outcome, execution: next });
  }

  sweep(params: { executionIds: string[] }): Promise<{ failureCount: number }> {
    this.swept.push(params.executionIds);
    return Promise.resolve({
      failureCount: params.executionIds.filter((id) => id.startsWith('bad'))
        .length,
    });
  }

  checkpoint(): Promise<{ checkpointedCount: number }> {
    if (this.checkpointFails)
      return Promise.reject(pipelineCheckpointFailedError(new Error('stuck')));
    return Promise.resolve({ checkpointedCount: this.executions.size });
  }

  get(executionId: string): Promise<WorkerPipelineExecution | null> {
    return Promise.resolve(this.executions.get(executionId) ?? null);
  }

  cancel(
    executionId: string,
    mode: WorkerPipelineCancelMode,
  ): Promise<WorkerPipelineExecution> {
    const current = this.executions.get(executionId);
    if (!current) return Promise.reject(pipelineExecutionNotFoundError());
    // As the executor does, a finished execution keeps its state.
    if (['success', 'failure', 'cancelled'].includes(current.status))
      return Promise.resolve(current);
    this.modes.push(mode);
    if (mode === 'drain' && this.drainTimesOut)
      return Promise.reject(new PipelineDrainTimeoutError());
    return (this.cancelGate ?? Promise.resolve()).then(() => {
      this.cancelled.push(executionId);
      const cancelled = { ...current, status: 'cancelled' as const };
      this.emit(executionId, 'execution.cancelled', 'cancelled');
      return cancelled;
    });
  }

  observe(
    executionId: string,
    observer: PipelineExecutionObserver,
  ): (() => void) | null {
    this.beforeObserve?.();
    const current = this.executions.get(executionId);
    if (
      !current ||
      ['success', 'failure', 'cancelled'].includes(current.status)
    )
      return null;
    const set = this.observers.get(executionId) ?? new Set();
    set.add(observer);
    this.observers.set(executionId, set);
    return () => set.delete(observer);
  }

  emit(
    executionId: string,
    event: string,
    status: WorkerPipelineExecution['status'],
  ): void {
    const next = execution(executionId, status);
    this.executions.set(executionId, next);
    for (const observer of Array.from(this.observers.get(executionId) ?? []))
      observer.onExecution(event, next);
  }

  /** The handle settled: nothing reports this execution any more. */
  detach(executionId: string): void {
    this.observers.delete(executionId);
  }

  output(executionId: string, text: string): void {
    for (const observer of Array.from(this.observers.get(executionId) ?? []))
      observer.onOutput({
        jobId: 'build',
        stepId: 'run',
        stream: 'stdout',
        text,
      });
  }
}

let dir: string;
let cleanup: Array<() => void>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pipeline-execution-'));
  cleanup = [];
});

afterEach(() => {
  for (const step of cleanup.reverse()) step();
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  worker: FakeWorker;
  dispatcher: CanopyDispatcher<
    typeof WORKER_PIPELINE_QUERY_DEFINITIONS,
    typeof EXECUTION_INSTRUCTIONS,
    typeof EXECUTION_STREAMS
  >;
  operations: OperationService;
  localWorker: LocalWorkerExecution;
  runs: CorePipelineRuns;
  receipts: ReturnType<typeof createWorkerExecutorReceipts>;
}

function harness(options: { now?: () => number } = {}): Harness {
  const worker = new FakeWorker();
  const handlers = createWorkerPipelineHandlers(worker, {
    budget: { items: 2, windowMs: 1_000, backlog: 8 },
    ...(options.now ? { now: options.now } : {}),
  });
  const instructions = EXECUTION_INSTRUCTIONS;
  const receipts = createWorkerExecutorReceipts(instructions);
  const dispatcher = createCanopyDispatcher({
    profile: 'core+worker',
    definitions: {
      queries: WORKER_PIPELINE_QUERY_DEFINITIONS,
      instructions,
      streams: EXECUTION_STREAMS,
    },
    handlers: {
      queries: handlers.queries,
      instructions: receipts.wrap(handlers.instructions),
      streams: handlers.streams,
    },
  });
  const operations = new OperationService({
    openLedger: (): OperationLedger =>
      OperationLedger.open(join(dir, 'operation-ledger.sqlite')),
  });
  const localWorker = new LocalWorkerExecution({
    operations,
    transport: createDirectLocalWorkerTransport({
      dispatcher,
      instructions,
      caller,
      receipts,
    }),
  });
  const runs = new CorePipelineRuns({ operations, localWorker, worker });
  cleanup.push(() => {
    void dispatcher.shutdown();
    operations.close();
  });
  return { worker, dispatcher, operations, localWorker, runs, receipts };
}

const params = (executionId: string): WorkerPipelineExecutionStartParams => ({
  executionId,
  pipelineId: 'review',
  definitionSource: 'user',
  runScope: 'worktree',
  workspaceId: 'alpha',
  worktreeId: 'main',
  owner: 'personal',
  initiationSource: 'user',
});

const start = (
  h: Harness,
  executionId: string,
): ReturnType<CorePipelineRuns['start']> =>
  h.runs.start({
    params: params(executionId),
    origin: { kind: 'client', sourceId: 'local-desktop-user' },
    owner: { kind: 'principal', id: 'local-desktop-user' },
  });

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 20));

describe('core pipeline runs', () => {
  it('records the run and its placed start before the worker runs it', async () => {
    const h = harness();
    h.worker.launches.add('run-1');
    const started = await start(h, 'run-1');
    expect(started).toMatchObject({
      status: 'completed',
      execution: { executionId: 'run-1', status: 'running' },
    });
    const run = await h.operations.get(started.operationId);
    expect(run).toMatchObject({
      kind: CORE_PIPELINE_RUN_KIND,
      status: 'running',
      scope: { workspaceId: 'alpha', worktreeId: 'main', executionId: 'run-1' },
    });
    const [dispatch] = await h.localWorker.listDelegations(started.operationId);
    expect(dispatch).toMatchObject({
      targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
      operation: { name: 'worker.pipeline.execution.start' },
      idempotencyKey: 'run-1',
    });

    h.worker.emit('run-1', 'execution.paused', 'paused');
    await settle();
    expect((await h.operations.get(started.operationId))?.status).toBe(
      'paused',
    );
    h.worker.emit('run-1', 'execution.updated', 'running');
    h.worker.emit('run-1', 'execution.completed', 'success');
    await settle();
    expect((await h.operations.get(started.operationId))?.status).toBe(
      'completed',
    );
  });

  it('keeps a live pause over the older read that follows the subscription', async () => {
    const h = harness();
    h.worker.launches.add('run-12');
    h.worker.beforeObserve = (): void => {
      h.worker.beforeObserve = null;
      // The read after subscribing still sees the start's state.
      const startedState = execution('run-12', 'running');
      const realGet = h.worker.get.bind(h.worker);
      h.worker.get = (): Promise<WorkerPipelineExecution | null> => {
        h.worker.get = realGet;
        return new Promise((resolve) =>
          setTimeout(() => resolve(startedState), 10),
        );
      };
    };
    const started = await start(h, 'run-12');
    h.worker.emit('run-12', 'execution.paused', 'paused');
    await settle();
    await settle();
    expect((await h.operations.get(started.operationId))?.status).toBe(
      'paused',
    );
  });

  it('refuses a start core did not prepare, and fails the run', async () => {
    const h = harness();
    const refused = await start(h, 'run-2');
    expect(refused).toMatchObject({
      status: 'failed',
      error: { code: 'worker.pipeline.launchUnavailable' },
    });
    expect((await h.operations.get(refused.operationId))?.status).toBe(
      'failed',
    );
  });

  it('cancels a run through its operation with a worker cancel under it', async () => {
    const h = harness();
    h.worker.launches.add('run-3');
    const started = await start(h, 'run-3');
    const cancelled = await h.runs.cancel('run-3', 'local-desktop-user');
    expect(cancelled).toMatchObject({
      status: 'completed',
      operationId: started.operationId,
      execution: { status: 'cancelled' },
    });
    expect(h.worker.cancelled).toEqual(['run-3']);
    const names = (
      await h.localWorker.listDelegations(started.operationId)
    ).map((delegation) => delegation.operation.name);
    expect(names).toEqual([
      'worker.pipeline.execution.start',
      'worker.pipeline.execution.cancel',
    ]);
    await settle();
    expect((await h.operations.get(started.operationId))?.status).toBe(
      'cancelled',
    );
  });

  it('stops the execution when any client cancels the run operation', async () => {
    const h = harness();
    h.worker.launches.add('run-6');
    const started = await start(h, 'run-6');
    await h.operations.cancel(started.operationId, {
      reason: 'Another window cancelled it.',
      requestedBy: 'window-b',
    });
    await settle();
    expect(h.worker.cancelled).toEqual(['run-6']);
    expect((await h.operations.get(started.operationId))?.status).toBe(
      'cancelled',
    );
  });

  it('cancels a run whose cancel arrived while it was starting', async () => {
    const h = harness();
    h.worker.launches.add('run-7');
    let open = (): void => undefined;
    h.worker.startGate = new Promise((resolve) => {
      open = resolve;
    });
    const starting = start(h, 'run-7');
    await settle();
    const cancelling = h.runs.cancel('run-7', 'local-desktop-user');
    open();
    const started = await starting;
    await expect(cancelling).resolves.toMatchObject({
      status: 'completed',
      operationId: started.operationId,
      execution: { status: 'cancelled' },
    });
    expect(h.worker.cancelled).toEqual(['run-7']);
  });

  it('finishes a paused run from its cancel reply when no handle reports it', async () => {
    const h = harness();
    h.worker.launches.add('run-8');
    const started = await start(h, 'run-8');
    h.worker.emit('run-8', 'execution.paused', 'paused');
    h.worker.detach('run-8');
    await settle();
    await h.runs.cancel('run-8', 'local-desktop-user');
    await settle();
    expect((await h.operations.get(started.operationId))?.status).toBe(
      'cancelled',
    );
  });

  it('returns the finished state when a run ends just before its cancel is admitted', async () => {
    const h = harness();
    h.worker.launches.add('run-15');
    const started = await start(h, 'run-15');
    const get = h.operations.get.bind(h.operations);
    jest.spyOn(h.operations, 'get').mockImplementationOnce(async (id) => {
      const before = await get(id);
      h.worker.emit('run-15', 'execution.completed', 'success');
      await settle();
      return before;
    });
    await expect(
      h.runs.cancel('run-15', 'local-desktop-user'),
    ).resolves.toMatchObject({
      status: 'completed',
      execution: { status: 'success' },
    });
    expect((await h.operations.get(started.operationId))?.status).toBe(
      'completed',
    );
  });

  it('cancels an execution this process did not start under its own operation', async () => {
    const h = harness();
    h.worker.executions.set('resumed', execution('resumed', 'running'));
    const cancelled = await h.runs.cancel('resumed', 'local-desktop-user');
    expect(cancelled.status).toBe('completed');
    const operation = await h.operations.get(cancelled.operationId);
    expect(operation).toMatchObject({
      kind: CORE_PIPELINE_CANCEL_KIND,
      status: 'completed',
    });
  });

  it('drains a run without settling it while it is still stopping', async () => {
    const h = harness();
    h.worker.launches.add('run-13');
    const started = await start(h, 'run-13');
    h.worker.drainTimesOut = true;
    await expect(
      h.runs.cancel('run-13', 'local-desktop-user', 'drain'),
    ).resolves.toMatchObject({
      status: 'failed',
      error: {
        kind: 'deadline_exceeded',
        code: 'worker.pipeline.drainTimedOut',
      },
    });
    await settle();
    expect((await h.operations.get(started.operationId))?.status).toBe(
      'running',
    );
    h.worker.drainTimesOut = false;
    await expect(
      h.runs.cancel('run-13', 'local-desktop-user', 'drain'),
    ).resolves.toMatchObject({
      status: 'completed',
      execution: { status: 'cancelled' },
    });
    expect(h.worker.modes).toEqual(['drain', 'drain']);
    await settle();
    expect((await h.operations.get(started.operationId))?.status).toBe(
      'cancelled',
    );
  });

  it('reports a cancel of an unknown execution as not found', async () => {
    const h = harness();
    await expect(
      h.runs.cancel('missing', 'local-desktop-user'),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'worker.pipeline.executionNotFound' },
    });
  });
});

describe('core pipeline recovery controls', () => {
  const origin = { kind: 'client' as const, sourceId: 'local-desktop-user' };
  const owner = { kind: 'principal' as const, id: 'local-desktop-user' };
  const resume = (
    h: Harness,
    executionId: string,
    requestId: string,
  ): ReturnType<CorePipelineRuns['control']> =>
    h.runs.control({
      control: {
        operation: 'worker.pipeline.execution.resume',
        params: {
          requestId,
          executionId,
          pauseResponses: [
            {
              checkpointId: 'checkpoint-1',
              jobId: 'review',
              stepId: 'approve',
              answers: { approved: true },
            },
          ],
          initiationSource: 'user',
        },
      },
      origin,
      owner,
    });
  const controlsOf = async (
    h: Harness,
    runId: string,
  ): Promise<Awaited<ReturnType<OperationService['get']>>[]> =>
    (
      await h.operations.list({
        kinds: [CORE_PIPELINE_CONTROL_KIND],
        parentOperationId: runId,
        limit: 10,
      })
    ).items;
  const runsOf = async (h: Harness, executionId: string): Promise<string[]> =>
    (
      await h.operations.list({
        kinds: [CORE_PIPELINE_RUN_KIND],
        scope: { executionId },
        limit: 10,
      })
    ).items.map((run) => run.operationId);

  it('resumes a paused run under its own run record', async () => {
    const h = harness();
    h.worker.launches.add('run-20');
    const started = await start(h, 'run-20');
    h.worker.emit('run-20', 'execution.paused', 'paused');
    await settle();
    h.worker.controls.set('answer-1', {
      outcome: 'started',
      status: 'running',
    });
    await expect(resume(h, 'run-20', 'answer-1')).resolves.toMatchObject({
      status: 'completed',
      operationId: started.operationId,
      outcome: 'started',
      execution: { executionId: 'run-20', status: 'running' },
    });
    expect(
      (await h.localWorker.listDelegations(started.operationId)).map(
        (delegation) => delegation.operation.name,
      ),
    ).toEqual(['worker.pipeline.execution.start']);
    const controls = await controlsOf(h, started.operationId);
    expect(controls).toEqual([
      expect.objectContaining({
        kind: CORE_PIPELINE_CONTROL_KIND,
        status: 'completed',
        outcome: { outcome: 'started' },
      }),
    ]);
    expect(
      (await h.localWorker.listDelegations(controls[0]?.operationId ?? '')).map(
        (delegation) => [delegation.operation.name, delegation.idempotencyKey],
      ),
    ).toEqual([['worker.pipeline.execution.resume', 'answer-1']]);
    expect(await runsOf(h, 'run-20')).toEqual([started.operationId]);
    h.worker.emit('run-20', 'execution.completed', 'success');
    await settle();
    expect((await h.operations.get(started.operationId))?.status).toBe(
      'completed',
    );
  });

  it('carries a long pasted pause answer, as the executor always took', async () => {
    const h = harness();
    h.worker.executions.set('paused-2', execution('paused-2', 'paused'));
    h.worker.controls.set('long-1', { outcome: 'started', status: 'running' });
    await expect(
      h.runs.control({
        control: {
          operation: 'worker.pipeline.execution.resume',
          params: {
            requestId: 'long-1',
            executionId: 'paused-2',
            pauseResponses: [
              {
                checkpointId: 'checkpoint-1',
                jobId: 'review',
                stepId: 'notes',
                answers: { notes: 'x'.repeat(200_000) },
              },
            ],
            initiationSource: 'user',
          },
        },
        origin,
        owner,
      }),
    ).resolves.toMatchObject({ status: 'completed', outcome: 'started' });
  });

  it('never runs a control twice for one request id', async () => {
    const h = harness();
    h.worker.launches.add('run-21');
    const started = await start(h, 'run-21');
    h.worker.emit('run-21', 'execution.paused', 'paused');
    await settle();
    h.worker.controls.set('answer-2', {
      outcome: 'started',
      status: 'running',
    });
    const first = await resume(h, 'run-21', 'answer-2');
    h.worker.controls.set('answer-2', {
      outcome: 'started',
      status: 'running',
    });
    const again = await resume(h, 'run-21', 'answer-2');
    expect(again).toEqual(first);
    expect(h.worker.controlled).toEqual(['answer-2']);
    expect(await controlsOf(h, started.operationId)).toHaveLength(1);
  });

  it('replays a repeated request id after its run finished', async () => {
    const h = harness();
    h.worker.executions.set('failed-2', execution('failed-2', 'failure'));
    h.worker.controls.set('retry-2', { outcome: 'started', status: 'running' });
    const retry = (): ReturnType<CorePipelineRuns['control']> =>
      h.runs.control({
        control: {
          operation: 'worker.pipeline.execution.retry',
          params: {
            requestId: 'retry-2',
            executionId: 'failed-2',
            mode: 'failed_only',
          },
        },
        origin,
        owner,
      });
    const first = await retry();
    h.worker.emit('failed-2', 'execution.failed', 'failure');
    await settle();
    expect((await h.operations.get(first.operationId))?.status).toBe('failed');
    h.worker.controls.set('retry-2', { outcome: 'started', status: 'running' });
    const again = await retry();
    expect(again).toMatchObject({
      status: 'completed',
      operationId: first.operationId,
    });
    expect(h.worker.controlled).toEqual(['retry-2']);
    expect(await runsOf(h, 'failed-2')).toEqual([first.operationId]);
  });

  it('never settles a newer run from a replayed control', async () => {
    const h = harness();
    h.worker.executions.set('failed-3', execution('failed-3', 'failure'));
    const retry = (
      requestId: string,
    ): ReturnType<CorePipelineRuns['control']> =>
      h.runs.control({
        control: {
          operation: 'worker.pipeline.execution.retry',
          params: { requestId, executionId: 'failed-3', mode: 'failed_only' },
        },
        origin,
        owner,
      });
    // The first retry failed at once.
    h.worker.controls.set('retry-3', { outcome: 'started', status: 'failure' });
    const first = await retry('retry-3');
    await settle();
    expect((await h.operations.get(first.operationId))?.status).toBe('failed');
    h.worker.controls.set('retry-4', { outcome: 'started', status: 'running' });
    const second = await retry('retry-4');
    expect(second.operationId).not.toBe(first.operationId);
    await expect(retry('retry-3')).resolves.toMatchObject({
      operationId: first.operationId,
      execution: { status: 'failure' },
    });
    await settle();
    expect((await h.operations.get(second.operationId))?.status).toBe(
      'running',
    );
  });

  it('replays a control redelivered after a restart', async () => {
    const h = harness();
    h.worker.executions.set('failed-5', execution('failed-5', 'failure'));
    h.worker.controls.set('retry-5', { outcome: 'started', status: 'running' });
    const retry = (
      runs: CorePipelineRuns,
    ): ReturnType<CorePipelineRuns['control']> =>
      runs.control({
        control: {
          operation: 'worker.pipeline.execution.retry',
          params: {
            requestId: 'retry-5',
            executionId: 'failed-5',
            mode: 'failed_only',
          },
        },
        origin,
        owner,
      });
    const first = await retry(h.runs);
    // A relaunched core holds no runs in memory; the ledger keeps receipts.
    h.operations.close();
    const operations = new OperationService({
      openLedger: (): OperationLedger =>
        OperationLedger.open(join(dir, 'operation-ledger.sqlite')),
    });
    cleanup.push(() => operations.close());
    const relaunched = new CorePipelineRuns({
      operations,
      localWorker: new LocalWorkerExecution({
        operations,
        transport: createDirectLocalWorkerTransport({
          dispatcher: h.dispatcher,
          instructions: EXECUTION_INSTRUCTIONS,
          caller,
          receipts: h.receipts,
        }),
      }),
      worker: h.worker,
    });
    h.worker.controls.set('retry-5', { outcome: 'started', status: 'running' });
    await expect(retry(relaunched)).resolves.toMatchObject({
      status: 'completed',
      operationId: first.operationId,
    });
    expect(h.worker.controlled).toEqual(['retry-5']);
  });

  it('finishes a run being cancelled that a new control replaces', async () => {
    const h = harness();
    h.worker.launches.add('run-30');
    const started = await start(h, 'run-30');
    h.worker.emit('run-30', 'execution.paused', 'paused');
    await settle();
    let open = (): void => undefined;
    h.worker.cancelGate = new Promise((resolve) => {
      open = resolve;
    });
    await h.operations.cancel(started.operationId, {
      reason: 'Another window cancelled it.',
      requestedBy: 'window-b',
    });
    h.worker.controls.set('answer-30', {
      outcome: 'started',
      status: 'running',
    });
    const resumed = await resume(h, 'run-30', 'answer-30');
    expect(resumed.operationId).not.toBe(started.operationId);
    open();
    await settle();
    expect((await h.operations.get(started.operationId))?.status).toBe(
      'cancelled',
    );
    expect((await h.operations.get(resumed.operationId))?.status).toBe(
      'cancelled',
    );
  });

  it('finishes a run whose control ended its execution without running it', async () => {
    const h = harness();
    h.worker.launches.add('run-31');
    const started = await start(h, 'run-31');
    h.worker.emit('run-31', 'execution.paused', 'paused');
    h.worker.detach('run-31');
    await settle();
    h.worker.controls.set('variant-31', {
      outcome: 'updated',
      status: 'cancelled',
    });
    await expect(
      h.runs.control({
        control: {
          operation: 'worker.pipeline.matrixVariant.cancel',
          params: {
            requestId: 'variant-31',
            executionId: 'run-31',
            jobId: 'build',
            variantJobId: 'build-1',
          },
        },
        origin,
        owner,
      }),
    ).resolves.toMatchObject({
      operationId: started.operationId,
      outcome: 'updated',
    });
    await settle();
    expect((await h.operations.get(started.operationId))?.status).toBe(
      'cancelled',
    );
  });

  it('follows a run a concurrent control started after their shared run ended', async () => {
    const h = harness();
    h.worker.executions.set('failed-6', execution('failed-6', 'failure'));
    h.worker.controls.set('retry-6a', {
      outcome: 'started',
      status: 'failure',
    });
    h.worker.controls.set('retry-6b', {
      outcome: 'started',
      status: 'running',
    });
    const retry = (
      requestId: string,
    ): ReturnType<CorePipelineRuns['control']> =>
      h.runs.control({
        control: {
          operation: 'worker.pipeline.execution.retry',
          params: { requestId, executionId: 'failed-6', mode: 'failed_only' },
        },
        origin,
        owner,
      });
    await Promise.all([retry('retry-6a'), retry('retry-6b')]);
    await settle();
    const statuses = await Promise.all(
      (await runsOf(h, 'failed-6')).map(
        async (id) => (await h.operations.get(id))?.status,
      ),
    );
    expect(statuses).toContain('running');
    h.worker.emit('failed-6', 'execution.completed', 'success');
    await settle();
    const after = await Promise.all(
      (await runsOf(h, 'failed-6')).map(
        async (id) => (await h.operations.get(id))?.status,
      ),
    );
    expect(after).not.toContain('running');
  });

  it('records no second run for an execution that ended before its control replied', async () => {
    const h = harness();
    h.worker.executions.set('failed-7', execution('failed-7', 'failure'));
    h.worker.controls.set('retry-7', { outcome: 'started', status: 'running' });
    // The control's own run follows the execution and sees it end before
    // the reply, whose snapshot still says running, reaches core.
    const realControl = h.worker.control.bind(h.worker);
    h.worker.control = async (
      request,
    ): Promise<WorkerPipelineControlResult> => {
      const reply = await realControl(request);
      h.runs.reattach('failed-7');
      await settle();
      h.worker.emit('failed-7', 'execution.completed', 'success');
      await settle();
      return reply;
    };
    await h.runs.control({
      control: {
        operation: 'worker.pipeline.execution.retry',
        params: {
          requestId: 'retry-7',
          executionId: 'failed-7',
          mode: 'failed_only',
        },
      },
      origin,
      owner,
    });
    await settle();
    expect(await runsOf(h, 'failed-7')).toHaveLength(1);
  });

  it('records one run for concurrent controls of an execution', async () => {
    const h = harness();
    h.worker.executions.set('paused-3', execution('paused-3', 'paused'));
    h.worker.controls.set('answer-a', {
      outcome: 'started',
      status: 'running',
    });
    h.worker.controls.set('answer-b', {
      outcome: 'stale_noop',
      status: 'running',
    });
    const [a, b] = await Promise.all([
      resume(h, 'paused-3', 'answer-a'),
      resume(h, 'paused-3', 'answer-b'),
    ]);
    expect(a.operationId).toBe(b.operationId);
    expect(await runsOf(h, 'paused-3')).toEqual([a.operationId]);
    await settle();
    expect((await h.operations.get(a.operationId))?.status).toBe('running');
    h.worker.emit('paused-3', 'execution.completed', 'success');
    await settle();
    expect((await h.operations.get(a.operationId))?.status).toBe('completed');
  });

  it('records a run for a control of an execution this process holds no run for', async () => {
    const h = harness();
    h.worker.executions.set('failed-1', execution('failed-1', 'failure'));
    h.worker.controls.set('retry-1', { outcome: 'started', status: 'running' });
    const retried = await h.runs.control({
      control: {
        operation: 'worker.pipeline.execution.retry',
        params: {
          requestId: 'retry-1',
          executionId: 'failed-1',
          mode: 'failed_only',
        },
      },
      origin,
      owner,
    });
    expect(retried).toMatchObject({ status: 'completed', outcome: 'started' });
    expect(await h.operations.get(retried.operationId)).toMatchObject({
      kind: CORE_PIPELINE_RUN_KIND,
      status: 'running',
      scope: { executionId: 'failed-1' },
    });
    h.worker.emit('failed-1', 'execution.paused', 'paused');
    await settle();
    expect((await h.operations.get(retried.operationId))?.status).toBe(
      'paused',
    );
    h.worker.emit('failed-1', 'execution.failed', 'failure');
    await settle();
    expect(await h.operations.get(retried.operationId)).toMatchObject({
      status: 'failed',
    });
  });

  it('records a start over as the run of its new execution', async () => {
    const h = harness();
    h.worker.executions.set('old-1', execution('old-1', 'failure'));
    h.worker.controls.set('over-1', { outcome: 'started', status: 'running' });
    const restarted = await h.runs.control({
      control: {
        operation: 'worker.pipeline.execution.retry',
        params: {
          requestId: 'over-1',
          executionId: 'old-1',
          mode: 'from_start',
          newExecutionId: 'new-1',
        },
      },
      origin,
      owner,
    });
    expect(restarted).toMatchObject({
      status: 'completed',
      execution: { executionId: 'new-1' },
    });
    expect(await runsOf(h, 'new-1')).toEqual([restarted.operationId]);
    expect(await runsOf(h, 'old-1')).toEqual([]);
  });

  it('finishes a control run that started nothing with its outcome', async () => {
    const h = harness();
    h.worker.executions.set('done-1', execution('done-1', 'success'));
    h.worker.controls.set('stale-1', {
      outcome: 'stale_noop',
      status: 'success',
    });
    const stale = await resume(h, 'done-1', 'stale-1');
    expect(stale).toMatchObject({ status: 'completed', outcome: 'stale_noop' });
    await settle();
    expect(await h.operations.get(stale.operationId)).toMatchObject({
      status: 'completed',
      outcome: { outcome: 'stale_noop' },
    });
    // A later control records a run of its own.
    h.worker.controls.set('variant-1', {
      outcome: 'updated',
      status: 'paused',
    });
    const updated = await h.runs.control({
      control: {
        operation: 'worker.pipeline.matrixVariant.cancel',
        params: {
          requestId: 'variant-1',
          executionId: 'done-1',
          jobId: 'build',
          variantJobId: 'build-1',
        },
      },
      origin,
      owner,
    });
    expect(updated.operationId).not.toBe(stale.operationId);
    await settle();
    expect(await h.operations.get(updated.operationId)).toMatchObject({
      status: 'completed',
      outcome: { outcome: 'updated' },
    });
  });

  it('fails the run of a control the worker refused or had no launch for', async () => {
    const h = harness();
    h.worker.executions.set('paused-1', execution('paused-1', 'paused'));
    h.worker.controls.set('refused-1', {
      outcome: 'stale_noop',
      status: 'failure',
    });
    const refused = await resume(h, 'paused-1', 'refused-1');
    expect(refused).toMatchObject({
      status: 'failed',
      error: { code: 'worker.pipeline.controlFailed' },
    });
    const unprepared = await resume(h, 'paused-1', 'unprepared-1');
    expect(unprepared).toMatchObject({
      status: 'failed',
      error: { code: 'worker.pipeline.launchUnavailable' },
    });
    await settle();
    for (const { operationId } of [refused, unprepared])
      expect((await h.operations.get(operationId))?.status).toBe('failed');
  });
});

// CAN-4141: the startup orphan sweep and the shutdown checkpoint.
describe('core pipeline recovery', () => {
  it('records the startup sweep with its worker dispatch under it', async () => {
    const h = harness();
    const swept = await h.runs.sweep(['orphan-1', 'bad-2'], 'sweep-1');
    expect(swept).toMatchObject({
      status: 'completed',
      result: { failureCount: 1 },
    });
    expect(h.worker.swept).toEqual([['orphan-1', 'bad-2']]);
    expect(await h.operations.get(swept.operationId)).toMatchObject({
      kind: CORE_PIPELINE_RECOVERY_KIND,
      status: 'completed',
      origin: { kind: 'system', sourceId: 'startup-sweep' },
    });
    expect(
      (await h.localWorker.listDelegations(swept.operationId)).map(
        (delegation) => [delegation.operation.name, delegation.idempotencyKey],
      ),
    ).toEqual([['worker.pipeline.recovery.sweep', 'sweep-1']]);
    // A repeat of the same request replays the recorded sweep.
    await expect(
      h.runs.sweep(['orphan-1', 'bad-2'], 'sweep-1'),
    ).resolves.toEqual(swept);
    expect(h.worker.swept).toHaveLength(1);
  });

  it('records a shutdown checkpoint that left a run unpaused as failed', async () => {
    const h = harness();
    h.worker.executions.set('live-1', execution('live-1', 'running'));
    await expect(h.runs.checkpoint()).resolves.toMatchObject({
      status: 'completed',
      result: { checkpointedCount: 1 },
    });
    h.worker.checkpointFails = true;
    const failed = await h.runs.checkpoint();
    expect(failed).toMatchObject({
      status: 'failed',
      error: { code: 'worker.pipeline.checkpointFailed' },
    });
    expect((await h.operations.get(failed.operationId))?.status).toBe('failed');
  });
});

describe('worker pipeline execution events', () => {
  async function open(
    h: Harness,
    executionId: string,
  ): Promise<{ items: WorkerPipelineExecutionEventsItem[]; ends: string[] }> {
    const items: WorkerPipelineExecutionEventsItem[] = [];
    const ends: string[] = [];
    await h.dispatcher.openStream(
      'worker.pipeline.execution.events',
      { executionId },
      {
        caller,
        onFrame: (frame) => {
          if (frame.kind === 'item') items.push(frame.item);
          else ends.push(frame.outcome);
        },
      },
    );
    return { items, ends };
  }

  it('drops output past its budget but never a lifecycle or terminal item', async () => {
    let clock = 0;
    const h = harness({ now: () => clock });
    h.worker.executions.set('run-4', execution('run-4', 'running'));
    const { items, ends } = await open(h, 'run-4');
    for (let index = 0; index < 5; index += 1)
      h.worker.output('run-4', `${index}`);
    h.worker.emit('run-4', 'execution.updated', 'running');
    clock = 1_000;
    h.worker.output('run-4', 'later');
    h.worker.emit('run-4', 'execution.completed', 'success');
    await settle();
    expect(items.map((item) => item.kind)).toEqual([
      'execution',
      'output',
      'output',
      'gap',
      'execution',
      'output',
      'execution',
    ]);
    expect(items[3]).toEqual({ kind: 'gap', droppedOutputItems: 3 });
    expect(items[6]).toMatchObject({
      kind: 'execution',
      event: 'execution.completed',
      execution: { status: 'success' },
    });
    expect(ends).toEqual(['completed']);
  });

  it('keeps the terminal item for a consumer that falls behind across windows', async () => {
    let clock = 0;
    const h = harness({ now: () => clock });
    h.worker.executions.set('run-9', execution('run-9', 'running'));
    const stream = await h.dispatcher.openStream(
      'worker.pipeline.execution.events',
      { executionId: 'run-9' },
      { caller },
    );
    await settle();
    for (let index = 0; index < 2_000; index += 1) {
      clock += 1_000;
      h.worker.output('run-9', `${index}`);
    }
    h.worker.emit('run-9', 'execution.completed', 'success');
    const kinds: string[] = [];
    let end: string | undefined;
    for await (const frame of stream.frames) {
      if (frame.kind === 'item') kinds.push(frame.item.kind);
      else end = frame.outcome;
    }
    expect(end).toBe('completed');
    expect(kinds.at(-1)).toBe('execution');
    expect(kinds).toContain('gap');
    expect(kinds.length).toBeLessThan(20);
  });

  it('keeps the terminal item when updates and output outrun a slow consumer', async () => {
    let clock = 0;
    const h = harness({ now: () => clock });
    h.worker.executions.set('run-10', execution('run-10', 'running'));
    const stream = await h.dispatcher.openStream(
      'worker.pipeline.execution.events',
      { executionId: 'run-10' },
      { caller },
    );
    await settle();
    for (let index = 0; index < 2_000; index += 1) {
      clock += 1_000;
      h.worker.output('run-10', `${index}`);
      h.worker.emit('run-10', 'execution.updated', 'running');
    }
    h.worker.emit('run-10', 'execution.completed', 'success');
    let end: string | undefined;
    let last: WorkerPipelineExecutionEventsItem | undefined;
    for await (const frame of stream.frames) {
      if (frame.kind === 'item') last = frame.item;
      else end = frame.outcome;
    }
    expect(end).toBe('completed');
    expect(last).toMatchObject({
      kind: 'execution',
      execution: { status: 'success' },
    });
  });

  it('delivers a held update once a slow consumer catches up, without more output', async () => {
    let clock = 0;
    const h = harness({ now: () => clock });
    h.worker.executions.set('run-14', execution('run-14', 'running'));
    const stream = await h.dispatcher.openStream(
      'worker.pipeline.execution.events',
      { executionId: 'run-14' },
      { caller },
    );
    await settle();
    for (let index = 0; index < 300; index += 1) {
      clock += 1_000;
      h.worker.output('run-14', `${index}`);
    }
    h.worker.emit('run-14', 'execution.updated', 'paused');
    let delivered = false;
    for await (const frame of stream.frames) {
      if (
        frame.kind === 'item' &&
        frame.item.kind === 'execution' &&
        frame.item.execution.status === 'paused'
      ) {
        delivered = true;
        break;
      }
    }
    stream.close();
    expect(delivered).toBe(true);
  });

  it('delivers a pause that happened while the subscription was made', async () => {
    const h = harness();
    h.worker.executions.set('run-11', execution('run-11', 'running'));
    h.worker.beforeObserve = (): void => {
      h.worker.executions.set('run-11', execution('run-11', 'paused'));
    };
    const { items } = await open(h, 'run-11');
    await settle();
    expect(
      items.map((item) =>
        item.kind === 'execution' ? item.execution.status : item.kind,
      ),
    ).toEqual(['running', 'paused']);
  });

  it('ends after the snapshot of a finished execution', async () => {
    const h = harness();
    h.worker.executions.set('done', execution('done', 'failure'));
    const { items, ends } = await open(h, 'done');
    await settle();
    expect(items).toEqual([
      {
        kind: 'execution',
        event: 'snapshot',
        execution: execution('done', 'failure'),
      },
    ]);
    expect(ends).toEqual(['completed']);
  });

  it('cuts output text past its item limit', async () => {
    const h = harness();
    h.worker.executions.set('run-5', execution('run-5', 'running'));
    const { items } = await open(h, 'run-5');
    h.worker.output('run-5', 'x'.repeat(20_000));
    await settle();
    expect(items[1]).toMatchObject({ kind: 'output', truncated: true });
    expect(items[1]?.kind === 'output' ? items[1].text.length : 0).toBe(16_384);
  });
});
