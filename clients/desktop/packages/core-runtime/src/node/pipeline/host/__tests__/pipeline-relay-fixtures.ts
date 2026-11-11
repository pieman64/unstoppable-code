// CAN-6161 (cloud pipelines CP-03): the two ends of the worker.pipeline relay
// contract, for the conformance suite in pipeline-relay-conformance.test.ts.
//
// - A fake core, the web core's stand-in, that reaches a runner only through
//   a serializing JSON-RPC pair: every frame is validated and serialized, and
//   no request may carry `_execution`, as over the relay.
// - Two runners behind it: the supervisor composition a cloud runner reuses
//   (PipelineHostSupervisor, the owner channel and the worker.pipeline
//   handlers, apps/core-daemon/src/pipelines.ts) over a fake pipeline host,
//   and a reference in-memory runner for the web core's own suite (CP-20).
//
// Both runners record what their host was asked to run, so the suite can
// check the portable start's mapping to runner paths.
import { EventEmitter } from 'node:events';
import {
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_QUERY_DEFINITIONS,
  WORKER_PIPELINE_STREAM_DEFINITIONS,
  WorkerPipelineExecutionGetResultSchema,
  WorkerPipelineExecutionListResultSchema,
  WorkerPipelineExecutionEventsItemSchema,
  WorkerPipelineExecutionResultSchema,
  WorkerPipelineHostRequestsItemSchema,
  isWorkerPipelineHostWithdrawal,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type CanopyStreamCursor,
  type WorkerPipelineExecutionEventsItem,
  type CanopyJsonRpcMessage,
  type WorkerPipelineControlResult,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionStartParams,
  type WorkerPipelineExecutionView,
  type WorkerPipelineHostLaunch,
  type WorkerPipelineHostRequestsItem,
  type WorkerPipelineHostResult,
  type WorkerPipelinePortableLaunch,
  type WorkerPipelineRecoveryCheckpointResult,
  type WorkerPipelineRecoverySweepResult,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../../runtime/dispatcher';
import {
  createInProcessWorkerBinding,
  type InProcessWorkerBinding,
} from '../../../../runtime/in-process-worker-binding';
import { serializingWorkerPair } from '../../../../runtime/__tests__/serializing-worker-pair';
import type { CanopyRuntimeHandlerMaps } from '../../../../runtime/types';
import {
  executionSecretNotGrantedError,
  type ExecutionSecretSource,
  type RedeemedExecutionSecrets,
} from '../../../execution-secrets';
import {
  PipelineEventJournal,
  createPipelineOwnerChannel,
  createWorkerPipelineHandlers,
  withPipelineEventJournal,
  isTerminalPipelineExecution,
  pipelineExecutionNotFoundError,
  pipelineLaunchUnavailableError,
  pipelineOwnerUnavailableError,
  pipelinePortableLaunchRefusedError,
  type PipelineExecutionListPage,
  type PipelineExecutionListQuery,
  type PipelineExecutionObserver,
  type PipelineExecutionWorker,
  type PipelineOwnerChannel,
} from '../../execution';
import {
  PipelineHostSupervisor,
  type PipelineHostLaunch,
  type PipelineHostMessage,
  type PipelineHostProcess,
  type PipelineHostRequestMessage,
} from '..';

/** What a runner serves to its primary over the relay: the daemon's set. */
export const RELAY_DEFINITIONS = {
  queries: {
    'worker.pipeline.execution.get':
      WORKER_PIPELINE_QUERY_DEFINITIONS['worker.pipeline.execution.get'],
    'worker.pipeline.execution.list':
      WORKER_PIPELINE_QUERY_DEFINITIONS['worker.pipeline.execution.list'],
  },
  instructions: {
    'worker.pipeline.execution.start':
      WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
        'worker.pipeline.execution.start'
      ],
    'worker.pipeline.execution.cancel':
      WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
        'worker.pipeline.execution.cancel'
      ],
    'worker.pipeline.hostRequest.respond':
      WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
        'worker.pipeline.hostRequest.respond'
      ],
  },
  streams: {
    'worker.pipeline.execution.events':
      WORKER_PIPELINE_STREAM_DEFINITIONS['worker.pipeline.execution.events'],
    'worker.pipeline.hostRequests':
      WORKER_PIPELINE_STREAM_DEFINITIONS['worker.pipeline.hostRequests'],
  },
};

/** The web core as the runner's caller: its owner, with the host grant. */
export const RELAY_CALLER: CanopyCallerDescriptor = {
  principalId: 'web-core',
  clientInstanceId: 'web-core:pipeline-runs',
  authorityId: 'web-core-authority',
  interfaceKind: 'worker',
  grants: [
    'worker.pipeline.read',
    'worker.pipeline.write',
    'worker.pipeline.host',
  ],
};

/** Where every runner puts things: never sent, never on the wire. */
export const RUNNER_PATHS = Object.freeze({
  checkout: '/runner/checkout',
  bundledActionsDir: '/runner/actions',
  dataRoot: '/runner/data',
  node: '/runner/node/bin/node',
});

/** The value the fake secret source redeems; it must never reach the wire. */
export const SECRET_CANARY = 'relay-secret-canary-6161';

/**
 * Redeems every binding to the canary once per dispatch, as a staged grant
 * is used up (CAN-5067): a second redemption for the same start fails.
 */
export function canarySecrets(): ExecutionSecretSource {
  const redeemed = new Set<string>();
  return {
    redeem: ({ audience, bindings }) => {
      const key = `${audience.operation}:${audience.key}`;
      if (redeemed.has(key))
        return Promise.reject(executionSecretNotGrantedError());
      redeemed.add(key);
      return Promise.resolve({
        env: Object.fromEntries(
          bindings.map((binding) => [binding.name, SECRET_CANARY]),
        ),
      });
    },
  };
}

export const LEASE_TTL_MS = 5 * 60_000;

export function portableLaunch(
  overrides: Partial<WorkerPipelinePortableLaunch> = {},
): WorkerPipelinePortableLaunch {
  return {
    definition: {
      pin: { contentHash: 'a'.repeat(64), packageDigest: null },
      snapshot: { name: 'relay', on: 'dispatch', jobs: { j: { steps: [] } } },
    },
    inputs: { greeting: 'hello' },
    env: { STEP_VALUE: 'from-start' },
    delegationLease: { leaseTtlMs: LEASE_TTL_MS },
    ...overrides,
  };
}

export function portableStart(
  executionId: string,
  launch: WorkerPipelinePortableLaunch = portableLaunch(),
): WorkerPipelineExecutionStartParams {
  return {
    executionId,
    pipelineId: 'relay-pipeline',
    definitionSource: 'shared',
    runScope: 'worktree',
    workspaceId: 'workspace',
    worktreeId: 'worktree',
    owner: 'personal',
    initiationSource: 'automation',
    portableLaunch: launch,
  };
}

/** The runner's own mapping of a portable start to its paths (CP-07's resolveLaunch). */
export function runnerLaunchOf(
  params: WorkerPipelineExecutionStartParams & {
    portableLaunch: WorkerPipelinePortableLaunch;
  },
  secrets: RedeemedExecutionSecrets,
): PipelineHostLaunch {
  const { portableLaunch: portable, secrets: _bindings, ...rest } = params;
  void _bindings;
  const { definition, delegationLease: _lease, ...members } = portable;
  void _lease;
  const launch: WorkerPipelineHostLaunch = {
    ...members,
    pipeline: definition.snapshot,
    cwd: RUNNER_PATHS.checkout,
    repoPath: RUNNER_PATHS.checkout,
    bundledActionsDir: RUNNER_PATHS.bundledActionsDir,
    nodeProcess: { command: RUNNER_PATHS.node },
    secretEnv: { ...secrets.env },
  };
  return {
    params: rest,
    launch,
    processEnvironment: { PATH: '/usr/bin:/bin' },
  };
}

function projectionOf(
  params: Pick<
    WorkerPipelineExecutionStartParams,
    | 'executionId'
    | 'pipelineId'
    | 'runScope'
    | 'definitionSource'
    | 'owner'
    | 'workspaceId'
    | 'worktreeId'
  >,
): WorkerPipelineExecution {
  return {
    executionId: params.executionId,
    pipelineId: params.pipelineId,
    name: 'relay',
    status: 'running',
    runScope: params.runScope,
    definitionSource: params.definitionSource,
    owner: params.owner,
    workspaceId: params.workspaceId,
    worktreeId: params.worktreeId,
    parentExecutionId: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    pendingPauseCount: 0,
    error: null,
  };
}

function journalOf(options: RelayRunnerOptions): PipelineEventJournal | null {
  if (options.journal === false) return null;
  return new PipelineEventJournal({
    ...(options.journal?.maxEntries !== undefined && {
      maxEntries: options.journal.maxEntries,
    }),
    ...(options.journal?.retainMs !== undefined && {
      retainMs: options.journal.retainMs,
    }),
  });
}

function settled(
  execution: WorkerPipelineExecution,
  status: WorkerPipelineExecution['status'],
): WorkerPipelineExecution {
  return {
    ...execution,
    status,
    completedAt: isTerminalPipelineExecution({ ...execution, status })
      ? new Date().toISOString()
      : null,
  };
}

export interface RelayStreamEnd {
  readonly outcome: string;
  readonly error: CanopyErrorPayload | null;
}

/** One events stream as the fake core follows it. */
export interface RelayEventsStream {
  readonly acceptedCursor: CanopyStreamCursor | null;
  /** Each item, parsed, with the frame cursor at the same index. */
  readonly items: WorkerPipelineExecutionEventsItem[];
  readonly cursors: CanopyStreamCursor[];
  readonly ended: Promise<RelayStreamEnd>;
  close(): void;
}

/** What a runner under test exposes besides its handlers. */
export interface RelayRunner {
  readonly name: string;
  readonly handlers: CanopyRuntimeHandlerMaps<
    (typeof RELAY_DEFINITIONS)['queries'],
    (typeof RELAY_DEFINITIONS)['instructions'],
    (typeof RELAY_DEFINITIONS)['streams']
  >;
  /** What the runner's host was asked to run for this execution, if anything. */
  launched(executionId: string): PipelineHostLaunch | undefined;
  /**
   * The same runner with a fresh handler layer, as after the worker
   * restarted its handlers or lost a start receipt.
   */
  rehandled(): RelayRunner;
  /** A step's output line, as its host would print it. */
  output(executionId: string, text: string): Promise<void>;
  /** A desktop notification a step asked for (CAN-5868). */
  notify(executionId: string, title: string): Promise<void>;
  /** A change to the run that keeps its status, as its host would report it. */
  update(
    executionId: string,
    patch: Partial<WorkerPipelineExecution>,
  ): Promise<void>;
  /** Ends a run as its host would. */
  finish(
    executionId: string,
    status: WorkerPipelineExecution['status'],
  ): Promise<void>;
  stop(): Promise<void>;
}

export interface RelayRunnerOptions {
  /** The runner's owner is remote, with this lease (CAN-6102). */
  readonly remoteOwner?: { readonly leaseTtlMs: number };
  /** Whether the runner maps portable starts; a desktop-like worker doesn't. */
  readonly portable?: boolean;
  /** The runner's event journal (CAN-6161); `false` for none. Default on. */
  readonly journal?:
    | false
    | { readonly maxEntries?: number; readonly retainMs?: number };
}

/** One run as a fake host keeps it. */
interface HostedRun {
  launch: PipelineHostLaunch;
  execution: WorkerPipelineExecution;
}

/** A pipeline host in memory: answers every op the supervisor sends. */
class FakePipelineHost extends EventEmitter implements PipelineHostProcess {
  readonly runs = new Map<string, HostedRun>();

  postMessage({ id, request }: PipelineHostRequestMessage): void {
    switch (request.op) {
      case 'configure':
      case 'hostSettled':
      case 'pause':
        this.reply(id, null);
        return;
      case 'start': {
        const { params } = request.start;
        const execution = projectionOf(params);
        this.runs.set(params.executionId, { launch: request.start, execution });
        this.reply(id, execution);
        return;
      }
      case 'get': {
        const run = this.runs.get(request.executionId);
        if (!run) this.reply(id, null);
        else
          this.reply(
            id,
            request.detail ? { execution: run.execution } : run.execution,
          );
        return;
      }
      case 'list':
        this.reply(id, {
          executions: [...this.runs.values()].map(({ execution }) => ({
            execution,
          })),
          more: false,
        });
        return;
      case 'cancel': {
        const run = this.runs.get(request.executionId);
        if (!run) {
          this.send({
            kind: 'response',
            id,
            ok: false,
            error: { code: 'not_found', message: 'No such run.' },
          });
          return;
        }
        this.finish(request.executionId, 'cancelled');
        this.reply(id, run.execution);
        return;
      }
      case 'sweep':
        this.reply(id, { failureCount: 0 });
        return;
      case 'checkpoint':
        this.reply(id, { checkpointedCount: 0 });
        return;
      case 'exit':
        this.reply(id, null);
        queueMicrotask(() => this.emit('exit', 0));
        return;
    }
  }

  kill(): boolean {
    queueMicrotask(() => this.emit('exit', 137));
    return true;
  }

  update(executionId: string, patch: Partial<WorkerPipelineExecution>): void {
    const run = this.runs.get(executionId);
    if (!run) throw new Error(`No run ${executionId}.`);
    run.execution = { ...run.execution, ...patch };
    this.send({
      kind: 'execution',
      executionId,
      event: 'execution.updated',
      execution: run.execution,
    });
  }

  notify(executionId: string, title: string): void {
    this.send({
      kind: 'notification',
      executionId,
      stepId: 's',
      title,
      body: '',
    });
  }

  output(executionId: string, text: string): void {
    this.send({
      kind: 'output',
      executionId,
      jobId: 'j',
      stepId: 's',
      stream: 'stdout',
      text,
    });
  }

  finish(executionId: string, status: WorkerPipelineExecution['status']): void {
    const run = this.runs.get(executionId);
    if (!run) throw new Error(`No run ${executionId}.`);
    run.execution = settled(run.execution, status);
    this.send({
      kind: 'execution',
      executionId,
      event: 'execution.completed',
      execution: run.execution,
    });
  }

  private reply(id: number, value: unknown): void {
    this.send({ kind: 'response', id, ok: true, value });
  }

  private send(message: PipelineHostMessage): void {
    queueMicrotask(() => this.emit('message', message));
  }
}

function handlersOf(
  worker: PipelineExecutionWorker,
  owner: PipelineOwnerChannel,
  journal: PipelineEventJournal | null,
): RelayRunner['handlers'] {
  const all = createWorkerPipelineHandlers(
    journal ? withPipelineEventJournal(worker, journal) : worker,
    { secrets: canarySecrets(), ...(journal && { journal }) },
  );
  return {
    queries: {
      'worker.pipeline.execution.get':
        all.queries['worker.pipeline.execution.get'],
      'worker.pipeline.execution.list':
        all.queries['worker.pipeline.execution.list'],
    },
    instructions: {
      'worker.pipeline.execution.start':
        all.instructions['worker.pipeline.execution.start'],
      'worker.pipeline.execution.cancel':
        all.instructions['worker.pipeline.execution.cancel'],
      'worker.pipeline.hostRequest.respond':
        owner.handlers.instructions['worker.pipeline.hostRequest.respond'],
    },
    streams: {
      'worker.pipeline.execution.events':
        all.streams['worker.pipeline.execution.events'],
      'worker.pipeline.hostRequests':
        owner.handlers.streams['worker.pipeline.hostRequests'],
    },
  };
}

/** The supervisor composition a cloud runner reuses (ADR 31), over a fake host. */
export function supervisorRunner(
  options: RelayRunnerOptions = {},
): RelayRunner {
  const owner = createPipelineOwnerChannel();
  const hosts: FakePipelineHost[] = [];
  const supervisor = new PipelineHostSupervisor({
    launch: (): PipelineHostProcess => {
      const host = new FakePipelineHost();
      hosts.push(host);
      return host;
    },
    configure: { dataRoot: RUNNER_PATHS.dataRoot },
    // A runner never runs a host-local launch: nothing on its host stages one.
    resolveLaunch: (): Promise<PipelineHostLaunch> =>
      Promise.reject(pipelinePortableLaunchRefusedError()),
    ...(options.portable !== false && {
      resolvePortableLaunch: (params, secrets): Promise<PipelineHostLaunch> =>
        Promise.resolve(runnerLaunchOf(params, secrets)),
    }),
    idleStopMs: 3_600_000,
    owner,
    ...(options.remoteOwner && { remoteOwner: options.remoteOwner }),
  });
  const hostOf = (executionId: string): FakePipelineHost | undefined =>
    hosts.find((host) => host.runs.has(executionId));
  const journal = journalOf(options);
  const runner: RelayRunner = {
    name: 'supervisor runner',
    handlers: handlersOf(supervisor, owner, journal),
    rehandled: () => ({
      ...runner,
      handlers: handlersOf(supervisor, owner, journal),
    }),
    output: async (executionId, text) => {
      const host = hostOf(executionId);
      if (!host) throw new Error(`No run ${executionId}.`);
      host.output(executionId, text);
      await settle();
    },
    notify: async (executionId, title) => {
      const host = hostOf(executionId);
      if (!host) throw new Error(`No run ${executionId}.`);
      host.notify(executionId, title);
      await settle();
    },
    update: async (executionId, patch) => {
      const host = hostOf(executionId);
      if (!host) throw new Error(`No run ${executionId}.`);
      host.update(executionId, patch);
      await settle();
    },
    launched: (executionId) =>
      hostOf(executionId)?.runs.get(executionId)?.launch,
    finish: async (executionId, status) => {
      const host = hostOf(executionId);
      if (!host) throw new Error(`No run ${executionId}.`);
      host.finish(executionId, status);
      await settle();
    },
    stop: async () => {
      journal?.close();
      await supervisor.stop();
    },
  };
  return runner;
}

/**
 * A reference runner in memory: it serves the contract with no pipeline
 * host, for the web core's suite (CP-20). It refuses what the supervisor
 * refuses, with the same errors.
 */
export class FakeRunnerWorker implements PipelineExecutionWorker {
  readonly runs = new Map<string, HostedRun>();

  private readonly observers = new Map<
    string,
    Set<PipelineExecutionObserver>
  >();

  constructor(
    private readonly owner: PipelineOwnerChannel,
    private readonly options: RelayRunnerOptions,
  ) {}

  get portableLaunches(): boolean {
    return this.options.portable !== false;
  }

  admitStart(
    params: WorkerPipelineExecutionStartParams,
  ): Promise<WorkerPipelineExecution | null> {
    const { portableLaunch: portable } = params;
    if (!portable) return Promise.reject(pipelineLaunchUnavailableError());
    const running = this.runs.get(params.executionId);
    if (running) return Promise.resolve(running.execution);
    if (portable.ownerBound === true && !this.owner.ownerSubscribed())
      return Promise.reject(
        pipelineOwnerUnavailableError({
          retryable: this.options.remoteOwner !== undefined,
        }),
      );
    return Promise.resolve(null);
  }

  start(
    params: WorkerPipelineExecutionStartParams,
    _signal: AbortSignal,
    secrets: RedeemedExecutionSecrets,
  ): Promise<WorkerPipelineExecution> {
    void _signal;
    const { portableLaunch: portable } = params;
    if (!portable) return Promise.reject(pipelineLaunchUnavailableError());
    const running = this.runs.get(params.executionId);
    if (running) return Promise.resolve(running.execution);
    const execution = projectionOf(params);
    this.runs.set(params.executionId, {
      launch: runnerLaunchOf({ ...params, portableLaunch: portable }, secrets),
      execution,
    });
    return Promise.resolve(execution);
  }

  control(): Promise<WorkerPipelineControlResult> {
    return Promise.reject(pipelineLaunchUnavailableError());
  }

  sweep(): Promise<WorkerPipelineRecoverySweepResult> {
    return Promise.resolve({ failureCount: 0 });
  }

  checkpoint(): Promise<WorkerPipelineRecoveryCheckpointResult> {
    return Promise.resolve({ checkpointedCount: 0 });
  }

  get(executionId: string): Promise<WorkerPipelineExecution | null> {
    return Promise.resolve(this.runs.get(executionId)?.execution ?? null);
  }

  inspect(executionId: string): Promise<WorkerPipelineExecutionView | null> {
    const run = this.runs.get(executionId);
    return Promise.resolve(run ? { execution: run.execution } : null);
  }

  list(_query: PipelineExecutionListQuery): Promise<PipelineExecutionListPage> {
    void _query;
    return Promise.resolve({
      executions: [...this.runs.values()].map(({ execution }) => ({
        execution,
      })),
      more: false,
    });
  }

  cancel(executionId: string): Promise<WorkerPipelineExecution> {
    if (!this.runs.has(executionId))
      return Promise.reject(pipelineExecutionNotFoundError());
    return Promise.resolve(this.finish(executionId, 'cancelled'));
  }

  observe(
    executionId: string,
    observer: PipelineExecutionObserver,
  ): (() => void) | null {
    const run = this.runs.get(executionId);
    if (!run || isTerminalPipelineExecution(run.execution)) return null;
    const set = this.observers.get(executionId) ?? new Set();
    set.add(observer);
    this.observers.set(executionId, set);
    return () => {
      set.delete(observer);
    };
  }

  output(executionId: string, text: string): void {
    for (const observer of [...(this.observers.get(executionId) ?? [])])
      observer.onOutput({ jobId: 'j', stepId: 's', stream: 'stdout', text });
  }

  notify(executionId: string, title: string): void {
    for (const observer of [...(this.observers.get(executionId) ?? [])])
      observer.onNotification?.({ stepId: 's', title, body: '' });
  }

  update(executionId: string, patch: Partial<WorkerPipelineExecution>): void {
    const run = this.runs.get(executionId);
    if (!run) throw new Error(`No run ${executionId}.`);
    run.execution = { ...run.execution, ...patch };
    for (const observer of [...(this.observers.get(executionId) ?? [])])
      observer.onExecution('execution.updated', run.execution);
  }

  finish(
    executionId: string,
    status: WorkerPipelineExecution['status'],
  ): WorkerPipelineExecution {
    const run = this.runs.get(executionId);
    if (!run) throw new Error(`No run ${executionId}.`);
    run.execution = settled(run.execution, status);
    for (const observer of [...(this.observers.get(executionId) ?? [])])
      observer.onExecution('execution.completed', run.execution);
    return run.execution;
  }
}

export function fakeRunner(options: RelayRunnerOptions = {}): RelayRunner {
  const owner = createPipelineOwnerChannel();
  const worker = new FakeRunnerWorker(owner, options);
  const journal = journalOf(options);
  const runner: RelayRunner = {
    name: 'fake runner',
    handlers: handlersOf(worker, owner, journal),
    rehandled: () => ({
      ...runner,
      handlers: handlersOf(worker, owner, journal),
    }),
    output: async (executionId, text) => {
      worker.output(executionId, text);
      await settle();
    },
    notify: async (executionId, title) => {
      worker.notify(executionId, title);
      await settle();
    },
    update: async (executionId, patch) => {
      worker.update(executionId, patch);
      await settle();
    },
    launched: (executionId) => worker.runs.get(executionId)?.launch,
    finish: async (executionId, status) => {
      worker.finish(executionId, status);
      await settle();
    },
    stop: () => {
      journal?.close();
      return Promise.resolve();
    },
  };
  return runner;
}

export async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

/** Every key, at any depth, of a JSON value. */
function keysOf(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const entry of value) keysOf(entry, into);
  else if (typeof value === 'object' && value !== null)
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      keysOf(entry, into);
    }
  return into;
}

/**
 * The fake web core: it reaches its runner only over a serializing JSON-RPC
 * pair and records every frame both ways, as the relay would carry them.
 */
export class FakePipelineCore {
  private readonly pair = serializingWorkerPair();

  private readonly binding: InProcessWorkerBinding;

  constructor(readonly runner: RelayRunner) {
    const dispatcher = createCanopyDispatcher({
      profile: 'worker',
      definitions: RELAY_DEFINITIONS,
      handlers: runner.handlers,
    });
    this.binding = createInProcessWorkerBinding({
      dispatcher,
      definitions: RELAY_DEFINITIONS,
      caller: RELAY_CALLER,
      pair: this.pair,
    });
  }

  /** Every frame either end sent, as JSON. */
  wire(): CanopyJsonRpcMessage[] {
    return [
      ...this.pair.client.send.mock.calls,
      ...this.pair.server.send.mock.calls,
    ].map(([message]) => message);
  }

  /** The wire as one string, to look for values that must never cross. */
  wireText(): string {
    return JSON.stringify(this.wire());
  }

  /** Every member name any frame carried. */
  wireKeys(): Set<string> {
    return keysOf(this.wire());
  }

  // Every answer is parsed as the web core would parse it.
  async start(
    params: WorkerPipelineExecutionStartParams,
    idempotencyKey = params.executionId,
  ): Promise<{ execution: WorkerPipelineExecution }> {
    return WorkerPipelineExecutionResultSchema.parse(
      await this.binding.instruction(
        'worker.pipeline.execution.start',
        params,
        {
          metadata: { idempotencyKey },
        },
      ),
    );
  }

  async get(executionId: string): Promise<WorkerPipelineExecutionView> {
    return WorkerPipelineExecutionGetResultSchema.parse(
      await this.binding.query('worker.pipeline.execution.get', {
        executionId,
      }),
    );
  }

  async list(): Promise<{ executions: WorkerPipelineExecutionView[] }> {
    return WorkerPipelineExecutionListResultSchema.parse(
      await this.binding.query('worker.pipeline.execution.list', {}),
    );
  }

  async cancel(
    executionId: string,
  ): Promise<{ execution: WorkerPipelineExecution }> {
    return WorkerPipelineExecutionResultSchema.parse(
      await this.binding.instruction(
        'worker.pipeline.execution.cancel',
        { executionId },
        { metadata: { idempotencyKey: `cancel:${executionId}` } },
      ),
    );
  }

  /**
   * Follows one run's events, from just after `cursor` when given, until the
   * stream ends or `close` drops it as a relay outage would.
   */
  async events(
    executionId: string,
    cursor?: CanopyStreamCursor,
  ): Promise<RelayEventsStream> {
    const handle = await this.binding.openStream(
      'worker.pipeline.execution.events',
      { executionId, ...(cursor && { cursor }) },
    );
    const items: WorkerPipelineExecutionEventsItem[] = [];
    const cursors: CanopyStreamCursor[] = [];
    const ended = new Promise<RelayStreamEnd>((resolve) => {
      handle.onFrame((frame) => {
        if (frame.kind === 'item') {
          items.push(WorkerPipelineExecutionEventsItemSchema.parse(frame.item));
          cursors.push(frame.cursor);
        } else resolve({ outcome: frame.outcome, error: frame.error });
      });
    });
    await settle();
    return {
      acceptedCursor: handle.openResult.acceptedCursor,
      items,
      cursors,
      ended,
      close: () => handle.close(),
    };
  }

  /**
   * Holds the owner subscription and answers each host request with
   * `answer`; returns its stop, which ends the subscription as a relay
   * outage would.
   */
  async own(
    answer: (
      item: Exclude<WorkerPipelineHostRequestsItem, { withdrawn: true }>,
    ) => WorkerPipelineHostResult,
  ): Promise<() => void> {
    const handle = await this.binding.openStream(
      'worker.pipeline.hostRequests',
      {},
    );
    handle.onFrame((frame) => {
      if (frame.kind !== 'item') return;
      const request = WorkerPipelineHostRequestsItemSchema.parse(frame.item);
      if (isWorkerPipelineHostWithdrawal(request)) return;
      void this.binding.instruction('worker.pipeline.hostRequest.respond', {
        executionId: request.executionId,
        requestId: request.requestId,
        result: answer(request),
      });
    });
    await settle();
    return () => handle.close();
  }

  close(): void {
    this.binding.close();
  }
}
