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
  CORE_PIPELINE_RUN_KIND,
  CorePipelineRuns,
} from '../core-pipeline-runs';
import {
  PipelineDrainTimeoutError,
  createWorkerPipelineHandlers,
  pipelineExecutionNotFoundError,
  pipelineLaunchUnavailableError,
  type PipelineExecutionObserver,
  type PipelineExecutionWorker,
} from '../worker-pipelines';

const EXECUTION_INSTRUCTIONS = {
  'worker.pipeline.execution.start':
    WORKER_PIPELINE_INSTRUCTION_DEFINITIONS['worker.pipeline.execution.start'],
  'worker.pipeline.execution.cancel':
    WORKER_PIPELINE_INSTRUCTION_DEFINITIONS['worker.pipeline.execution.cancel'],
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
    this.cancelled.push(executionId);
    const cancelled = { ...current, status: 'cancelled' as const };
    this.emit(executionId, 'execution.cancelled', 'cancelled');
    return Promise.resolve(cancelled);
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
  return { worker, dispatcher, operations, localWorker, runs };
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
