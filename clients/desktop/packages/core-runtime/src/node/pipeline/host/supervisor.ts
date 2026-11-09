import {
  isWorkerPipelineOwnerAction,
  WorkerPipelineExecutionSchema,
  WorkerPipelineRecoveryCheckpointResultSchema,
  WorkerPipelineRecoverySweepResultSchema,
  type CanopyHostExecution,
  type WorkerPipelineCancelMode,
  type WorkerPipelineControlResult,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionStartParams,
  type WorkerPipelineHostLaunch,
  type WorkerPipelineHostRequest,
  type WorkerPipelineRecoveryCheckpointResult,
  type WorkerPipelineRecoverySweepParams,
  type WorkerPipelineRecoverySweepResult,
} from '@canopy/protocol/canopy-core';

import type { RedeemedExecutionSecrets } from '../../execution-secrets';
import { PipelineHostUnavailableError } from '../execution/host-requests';
import type { PipelineOwnerChannel } from '../execution/owner-channel';
import {
  PipelineDrainTimeoutError,
  isTerminalPipelineExecution,
  pipelineCheckpointFailedError,
  pipelineExecutionNotFoundError,
  pipelineHostLostError,
  pipelineHostUnavailableError,
  pipelineLaunchRefusedError,
  pipelineLaunchUnavailableError,
  pipelineModelStepsUnsupportedError,
  pipelineOwnerUnavailableError,
  pipelineStartFailedError,
  type PipelineControlRequest,
  type PipelineExecutionNotification,
  type PipelineExecutionObserver,
  type PipelineExecutionWorker,
} from '../execution/worker-pipelines';
import {
  isPipelineHostMessage,
  type PipelineHostErrorCode,
  type PipelineHostLaunch,
  type PipelineHostMessage,
  type PipelineHostRequest,
  type PipelineHostLauncherCommand,
  type PipelineHostRequestMessage,
  type PipelineHostSettlement,
} from './protocol';

/** A launched pipeline host, as the execution host port reports it. */
export interface PipelineHostProcess {
  postMessage(message: PipelineHostRequestMessage): void;
  kill(): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
}

export interface PipelineHostSupervisorOptions {
  /** Starts a new pipeline host process. Throws when it cannot. */
  readonly launch: () => PipelineHostProcess;
  /** Sent as each new host's first request. */
  readonly configure: {
    readonly dataRoot: string;
    /** The daemon's own command, for the host's Codex runtime (CAN-5095 D18). */
    readonly codexMcpLauncher?: PipelineHostLauncherCommand;
  };
  /**
   * Verifies a start's host-local launch and resolves it for the host.
   * Throws {@link pipelineLaunchRefusedError}.
   */
  readonly resolveLaunch: (
    params: WorkerPipelineExecutionStartParams,
    execution: CanopyHostExecution & {
      pipelineLaunch: WorkerPipelineHostLaunch;
    },
  ) => Promise<PipelineHostLaunch>;
  /** Holds the daemon up while `executionId` runs; returns its release. */
  readonly holdExecution?: (executionId: string) => () => void;
  /** Ends a step's process group that outlived its host. */
  readonly killProcessGroup?: (processGroupId: number) => void;
  /** Default 30_000. */
  readonly requestTimeoutMs?: number;
  /** Default 60_000. */
  readonly checkpointTimeoutMs?: number;
  /** Default 5_000. */
  readonly idleStopMs?: number;
  /** Observes each host that ended unexpectedly, with how many executions it ran. */
  readonly onHostLost?: (report: {
    readonly code: number;
    readonly lost: number;
  }) => void;
  /** The daemon's owner channel (CAN-5771). Without it, host requests answer unavailable and owner-bound starts are refused. */
  readonly owner?: Pick<
    PipelineOwnerChannel,
    'broker' | 'ownerSubscribed' | 'onOwnerChange'
  >;
  /** How long a host request waits for an owner subscriber. Default 10_000. */
  readonly ownerWaitMs?: number;
  /** How long the owner may be gone before owner-bound runs pause. Default 10_000. */
  readonly ownerAbsentPauseMs?: number;
}

const REQUEST_TIMEOUT_MS = 30_000;
const CHECKPOINT_TIMEOUT_MS = 60_000;
const IDLE_STOP_MS = 5_000;
const EXIT_GRACE_MS = 5_000;
// A drain waits up to 10 s for the run to stop inside the host.
const CANCEL_EXTRA_MS = 10_000;
const OWNER_WAIT_MS = 10_000;
/** Notifications kept for a run no stream follows yet (CAN-5868). */
const UNDELIVERED_NOTIFICATIONS_MAX = 32;
/** How long they are kept once the run pauses or ends. */
const UNDELIVERED_NOTIFICATIONS_TTL_MS = 60_000;
const OWNER_ABSENT_PAUSE_MS = 10_000;

/** Why a host request failed; the host's own message is never kept. */
class HostRequestFailure extends Error {
  public constructor(
    public readonly reason: 'refused' | 'timeout' | 'exited' | 'unavailable',
    public readonly code?: PipelineHostErrorCode,
  ) {
    super('The pipeline host request failed.');
    this.name = 'HostRequestFailure';
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface LiveHost {
  readonly process: PipelineHostProcess;
  readonly pending: Map<number, Pending>;
  /** Executions this host runs that have not paused or ended. */
  readonly executions: Set<string>;
  /** Each step process the host reported, by registration id. */
  readonly processGroups: Map<string, number>;
  readonly observers: Map<string, Set<PipelineExecutionObserver>>;
  /** Executions whose start request this host has not answered yet. */
  readonly pendingStarts: Set<string>;
  /** Executions that paused or ended while their start was still pending. */
  readonly settledEarly: Set<string>;
  readonly exitWaiters: Array<() => void>;
  /** Host requests this host raised that wait on the owner, by request id (CAN-5771). */
  readonly hostCalls: Map<
    string,
    { readonly executionId: string; readonly abort: AbortController }
  >;
  expectedExit: boolean;
  exited: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

function isSettled(execution: WorkerPipelineExecution): boolean {
  return (
    execution.status === 'paused' || isTerminalPipelineExecution(execution)
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Runs host-local pipeline launches in a supervised pipeline host
 * (CAN-5086): starts the host on first use, routes requests and execution
 * events, and starts a new host on the next request after one ends. A host
 * that ends unexpectedly takes its executions with it: their step process
 * groups are killed and their event streams end with
 * `worker.pipeline.hostLost`. Recovery controls are not served (D10).
 */
export class PipelineHostSupervisor implements PipelineExecutionWorker {
  private host: LiveHost | null = null;

  private starting: Promise<LiveHost> | null = null;

  private stopped = false;

  private nextId = 1;

  private readonly releases = new Map<string, () => void>();

  /** Notifications no observer received, until a stream takes them (CAN-5868). */
  private readonly undelivered = new Map<
    string,
    {
      readonly items: PipelineExecutionNotification[];
      expiry?: ReturnType<typeof setTimeout>;
    }
  >();

  private readonly starts = new Map<string, Promise<WorkerPipelineExecution>>();

  /** Executions started with `ownerBound` that have not paused or ended (CAN-5771). */
  private readonly ownerBound = new Set<string>();

  private ownerAbsentTimer: ReturnType<typeof setTimeout> | undefined;

  /** The owner has been gone past the pause deadline and has not returned. */
  private ownerGone = false;

  private readonly offOwnerChange: (() => void) | undefined;

  public constructor(private readonly options: PipelineHostSupervisorOptions) {
    this.offOwnerChange = options.owner?.onOwnerChange((subscribed) =>
      this.ownerChanged(subscribed),
    );
  }

  /** Starts the host if none runs. Throws {@link pipelineHostUnavailableError}. */
  public async ready(): Promise<void> {
    await this.liveHost();
  }

  public async start(
    params: WorkerPipelineExecutionStartParams,
    signal: AbortSignal,
    _secrets: RedeemedExecutionSecrets,
    execution?: CanopyHostExecution,
  ): Promise<WorkerPipelineExecution> {
    void _secrets;
    const pipelineLaunch = execution?.pipelineLaunch;
    if (!execution || !pipelineLaunch) throw pipelineLaunchUnavailableError();
    const { executionId } = params;
    const joined = this.starts.get(executionId);
    if (joined) return joined;
    if (this.host?.executions.has(executionId)) {
      // A resent keyed start joins the run its host is running.
      const current = await this.get(executionId);
      if (current) return current;
    }
    const run = this.runStart(params, signal, { ...execution, pipelineLaunch });
    this.starts.set(executionId, run);
    try {
      return await run;
    } finally {
      if (this.starts.get(executionId) === run) this.starts.delete(executionId);
    }
  }

  private async runStart(
    params: WorkerPipelineExecutionStartParams,
    signal: AbortSignal,
    execution: CanopyHostExecution & {
      pipelineLaunch: WorkerPipelineHostLaunch;
    },
  ): Promise<WorkerPipelineExecution> {
    const ownerBound = execution.pipelineLaunch.ownerBound === true;
    if (ownerBound && this.options.owner?.ownerSubscribed() !== true)
      throw pipelineOwnerUnavailableError();
    const start = await this.options.resolveLaunch(params, execution);
    const host = await this.liveHost();
    if (signal.aborted)
      throw pipelineStartFailedError(
        new Error('The workflow start was cancelled.'),
      );
    // From here on the signal is ignored: a dropped connection never
    // cancels a started run.
    const { executionId } = params;
    // Another client may follow the run before its start answers.
    host.pendingStarts.add(executionId);
    let projection: WorkerPipelineExecution;
    let settledEarly: boolean;
    try {
      projection = await this.sendStart(host, start);
    } catch (error) {
      this.endObservers(host, executionId);
      throw error;
    } finally {
      host.pendingStarts.delete(executionId);
      settledEarly = host.settledEarly.delete(executionId);
    }
    // A run can settle in the same tick its start answers.
    if (!host.exited && !settledEarly && !isSettled(projection)) {
      host.executions.add(executionId);
      if (ownerBound) {
        this.ownerBound.add(executionId);
        // The owner went past the deadline while this start was pending.
        if (this.ownerGone) void this.pauseOwnerBound();
      }
      const release = this.options.holdExecution?.(executionId);
      if (release) this.releases.set(executionId, release);
    }
    return projection;
  }

  private async sendStart(
    host: LiveHost,
    start: PipelineHostLaunch,
  ): Promise<WorkerPipelineExecution> {
    let value: unknown;
    try {
      value = await this.send(
        host,
        { op: 'start', start },
        this.requestTimeoutMs,
      );
    } catch (error) {
      if (error instanceof HostRequestFailure) {
        if (error.code === 'model_steps')
          throw pipelineModelStepsUnsupportedError();
        if (error.code === 'host_steps') throw pipelineLaunchRefusedError();
        if (error.reason === 'exited') throw pipelineHostLostError();
        if (error.reason === 'timeout') {
          // A host that stops answering is faulted; its exit runs the loss path.
          host.process.kill();
          throw pipelineStartFailedError(
            new Error('The pipeline host did not answer.'),
          );
        }
      }
      throw pipelineStartFailedError(
        new Error('The pipeline host refused the start.'),
      );
    }
    const parsed = WorkerPipelineExecutionSchema.safeParse(value);
    if (!parsed.success)
      throw pipelineStartFailedError(
        new Error('The pipeline host refused the start.'),
      );
    return parsed.data;
  }

  /** Ends the streams that followed a start that never ran. */
  private endObservers(host: LiveHost, executionId: string): void {
    const observers = host.observers.get(executionId);
    if (!observers) return;
    host.observers.delete(executionId);
    const notFound = pipelineExecutionNotFoundError().payload;
    for (const observer of [...observers]) observer.onEnd?.(notFound);
    this.scheduleIdleStop(host);
  }

  public control(
    _request: PipelineControlRequest,
    _signal: AbortSignal,
    _secrets: RedeemedExecutionSecrets,
  ): Promise<WorkerPipelineControlResult> {
    void _request;
    void _signal;
    void _secrets;
    return Promise.reject(pipelineLaunchUnavailableError());
  }

  public async get(
    executionId: string,
  ): Promise<WorkerPipelineExecution | null> {
    const host = await this.liveHost();
    let value: unknown;
    try {
      value = await this.send(
        host,
        { op: 'get', executionId },
        this.requestTimeoutMs,
      );
    } catch (error) {
      // A host that exits under the request is lost, as during a start.
      if (error instanceof HostRequestFailure && error.reason === 'exited')
        throw pipelineHostLostError();
      throw pipelineHostUnavailableError();
    }
    if (value === null) return null;
    const parsed = WorkerPipelineExecutionSchema.safeParse(value);
    if (!parsed.success) throw pipelineHostUnavailableError();
    return parsed.data;
  }

  public async cancel(
    executionId: string,
    mode: WorkerPipelineCancelMode,
  ): Promise<WorkerPipelineExecution> {
    const host = await this.liveHost();
    let value: unknown;
    try {
      value = await this.send(
        host,
        { op: 'cancel', executionId, mode },
        this.requestTimeoutMs + CANCEL_EXTRA_MS,
      );
    } catch (error) {
      if (error instanceof HostRequestFailure) {
        if (error.code === 'not_found') throw pipelineExecutionNotFoundError();
        if (error.code === 'drain_timed_out')
          throw new PipelineDrainTimeoutError();
        if (error.reason === 'exited') throw pipelineHostUnavailableError();
      }
      throw new Error('The workflow run could not be cancelled.');
    }
    const parsed = WorkerPipelineExecutionSchema.safeParse(value);
    if (!parsed.success)
      throw new Error('The workflow run could not be cancelled.');
    return parsed.data;
  }

  public async sweep(
    params: WorkerPipelineRecoverySweepParams,
  ): Promise<WorkerPipelineRecoverySweepResult> {
    const host = await this.liveHost();
    let value: unknown;
    try {
      value = await this.send(
        host,
        { op: 'sweep', executionIds: [...params.executionIds] },
        this.requestTimeoutMs,
      );
    } catch {
      throw pipelineHostUnavailableError();
    }
    const parsed = WorkerPipelineRecoverySweepResultSchema.safeParse(value);
    if (!parsed.success) throw pipelineHostUnavailableError();
    return parsed.data;
  }

  public async checkpoint(_params?: {
    requestId: string;
  }): Promise<WorkerPipelineRecoveryCheckpointResult> {
    void _params;
    const host = this.host;
    if (!host || host.exited) return { checkpointedCount: 0 };
    let value: unknown;
    try {
      value = await this.send(
        host,
        { op: 'checkpoint' },
        this.options.checkpointTimeoutMs ?? CHECKPOINT_TIMEOUT_MS,
      );
    } catch {
      throw pipelineCheckpointFailedError(
        new Error('The pipeline host could not checkpoint.'),
      );
    }
    const parsed =
      WorkerPipelineRecoveryCheckpointResultSchema.safeParse(value);
    if (!parsed.success)
      throw pipelineCheckpointFailedError(
        new Error('The pipeline host could not checkpoint.'),
      );
    return parsed.data;
  }

  public observe(
    executionId: string,
    observer: PipelineExecutionObserver,
  ): (() => void) | null {
    const host = this.host;
    if (
      !host ||
      host.exited ||
      !(host.executions.has(executionId) || host.pendingStarts.has(executionId))
    )
      return null;
    let set = host.observers.get(executionId);
    if (!set) {
      set = new Set();
      host.observers.set(executionId, set);
    }
    set.add(observer);
    this.clearIdle(host);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const current = host.observers.get(executionId);
      current?.delete(observer);
      if (current?.size === 0) host.observers.delete(executionId);
      this.scheduleIdleStop(host);
    };
  }

  /** Phase 5: checkpoint every live execution, then stop the host. */
  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.offOwnerChange?.();
    if (this.ownerAbsentTimer !== undefined)
      clearTimeout(this.ownerAbsentTimer);
    this.ownerAbsentTimer = undefined;
    const host = this.host;
    if (host) this.abortHostCalls(host);
    if (host && !host.exited) {
      this.clearIdle(host);
      try {
        await this.checkpoint();
      } catch {
        // The host is stopped below whatever it answered.
      }
      host.expectedExit = true;
      this.send(host, { op: 'exit' }, this.requestTimeoutMs).catch(
        () => undefined,
      );
      await Promise.race([this.waitForExit(host), delay(EXIT_GRACE_MS)]);
      if (!host.exited) host.process.kill();
    }
    this.host = null;
    for (const release of this.releases.values()) release();
    this.releases.clear();
    for (const kept of this.undelivered.values())
      if (kept.expiry !== undefined) clearTimeout(kept.expiry);
    this.undelivered.clear();
  }

  private get requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private liveHost(): Promise<LiveHost> {
    if (this.stopped) return Promise.reject(pipelineHostUnavailableError());
    if (this.host && !this.host.exited) return Promise.resolve(this.host);
    this.starting ??= this.launchHost().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launchHost(): Promise<LiveHost> {
    let process: PipelineHostProcess;
    try {
      process = this.options.launch();
    } catch {
      throw pipelineHostUnavailableError();
    }
    const host: LiveHost = {
      process,
      pending: new Map(),
      executions: new Set(),
      processGroups: new Map(),
      observers: new Map(),
      pendingStarts: new Set(),
      settledEarly: new Set(),
      exitWaiters: [],
      hostCalls: new Map(),
      expectedExit: false,
      exited: false,
    };
    process.on('message', (message) => this.receive(host, message));
    process.on('exit', (code) => this.ended(host, code));
    try {
      await this.send(
        host,
        {
          op: 'configure',
          dataRoot: this.options.configure.dataRoot,
          ...(this.options.configure.codexMcpLauncher && {
            codexMcpLauncher: this.options.configure.codexMcpLauncher,
          }),
        },
        this.requestTimeoutMs,
      );
    } catch {
      host.expectedExit = true;
      process.kill();
      throw pipelineHostUnavailableError();
    }
    if (this.stopped || host.exited) {
      host.expectedExit = true;
      process.kill();
      throw pipelineHostUnavailableError();
    }
    this.host = host;
    this.scheduleIdleStop(host);
    return host;
  }

  private send(
    host: LiveHost,
    request: PipelineHostRequest,
    timeoutMs: number,
  ): Promise<unknown> {
    if (host.exited) return Promise.reject(new HostRequestFailure('exited'));
    this.clearIdle(host);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        host.pending.delete(id);
        reject(new HostRequestFailure('timeout'));
        this.scheduleIdleStop(host);
      }, timeoutMs);
      host.pending.set(id, { resolve, reject, timer });
      try {
        host.process.postMessage({ id, request });
      } catch {
        clearTimeout(timer);
        host.pending.delete(id);
        reject(new HostRequestFailure('unavailable'));
      }
    });
  }

  private receive(host: LiveHost, message: unknown): void {
    if (host.exited || !isPipelineHostMessage(message)) return;
    this.handle(host, message);
    this.scheduleIdleStop(host);
  }

  private handle(host: LiveHost, message: PipelineHostMessage): void {
    switch (message.kind) {
      case 'response': {
        const pending = host.pending.get(message.id);
        if (!pending) return;
        host.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value);
        else
          pending.reject(new HostRequestFailure('refused', message.error.code));
        return;
      }
      case 'execution': {
        const { executionId, event, execution } = message;
        for (const observer of [...(host.observers.get(executionId) ?? [])])
          observer.onExecution(event, execution);
        if (!isSettled(execution)) return;
        this.expireUndelivered(executionId);
        if (host.executions.delete(executionId))
          this.releaseExecution(executionId);
        else if (host.pendingStarts.has(executionId))
          host.settledEarly.add(executionId);
        return;
      }
      case 'output': {
        const { executionId, ...output } = message;
        for (const observer of [...(host.observers.get(executionId) ?? [])])
          observer.onOutput(output);
        return;
      }
      case 'notification': {
        const { executionId, stepId, title, body } = message;
        let delivered = false;
        for (const observer of [...(host.observers.get(executionId) ?? [])])
          if (observer.onNotification?.({ stepId, title, body }) === true)
            delivered = true;
        // A run can notify before a stream can take it; keep it for the next one.
        if (!delivered)
          this.keepUndelivered(executionId, { stepId, title, body });
        return;
      }
      case 'process':
        if (message.state === 'started')
          host.processGroups.set(message.id, message.processGroupId);
        else host.processGroups.delete(message.id);
        return;
      case 'hostRequest':
        void this.relayHostRequest(host, message.request);
        return;
      case 'hostRequestWithdrawn': {
        const call = host.hostCalls.get(message.requestId);
        if (call?.executionId === message.executionId) call.abort.abort();
        return;
      }
    }
  }

  /**
   * Raises one host step on the owner channel and answers the host with its
   * settlement (CAN-5771). Nothing here logs or keeps the request.
   */
  private async relayHostRequest(
    host: LiveHost,
    request: WorkerPipelineHostRequest,
  ): Promise<void> {
    const { requestId, executionId } = request;
    // A request can arrive in the same read as its start's answer.
    if (
      !(
        host.executions.has(executionId) || host.pendingStarts.has(executionId)
      ) ||
      host.hostCalls.has(requestId)
    )
      return;
    const abort = new AbortController();
    host.hostCalls.set(requestId, { executionId, abort });
    try {
      const settlement = await this.settleHostRequest(request, abort.signal);
      if (settlement && !abort.signal.aborted)
        await this.send(
          host,
          { op: 'hostSettled', requestId, settlement },
          this.requestTimeoutMs,
        ).catch(() => undefined);
    } finally {
      if (host.hostCalls.get(requestId)?.abort === abort)
        host.hostCalls.delete(requestId);
    }
  }

  /** The owner's settlement, `unavailable` without one, or null when withdrawn. */
  private async settleHostRequest(
    request: WorkerPipelineHostRequest,
    signal: AbortSignal,
  ): Promise<PipelineHostSettlement | null> {
    const owner = this.options.owner;
    if (!owner) return { kind: 'unavailable' };
    const present = await this.waitForOwner(owner, signal);
    if (signal.aborted) return null;
    if (!present) return { kind: 'unavailable' };
    try {
      // A model step's owner request (CAN-5095) takes the owner's answer and values as they are.
      if (isWorkerPipelineOwnerAction(request.request.action))
        return {
          kind: 'owner',
          settlement: await owner.broker.raiseOwner(request, signal),
        };
      const answer = await owner.broker.raiseHostStep(request, signal);
      return {
        kind: 'settled',
        result: answer.result,
        values: answer.values ?? null,
      };
    } catch (error) {
      if (error instanceof PipelineHostUnavailableError)
        return { kind: 'unavailable' };
      return null;
    }
  }

  /** Whether an owner subscribed within the wait; false on timeout or abort. */
  private waitForOwner(
    owner: Pick<PipelineOwnerChannel, 'ownerSubscribed' | 'onOwnerChange'>,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (owner.ownerSubscribed()) return Promise.resolve(true);
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (present: boolean): void => {
        clearTimeout(timer);
        off();
        signal.removeEventListener('abort', aborted);
        resolve(present);
      };
      const aborted = (): void => done(false);
      const timer = setTimeout(
        () => done(false),
        this.options.ownerWaitMs ?? OWNER_WAIT_MS,
      );
      const off = owner.onOwnerChange((subscribed) => {
        if (subscribed) done(true);
      });
      signal.addEventListener('abort', aborted, { once: true });
    });
  }

  /** Every waiting host call ends; the broker withdraws each from the owner. */
  private abortHostCalls(host: LiveHost): void {
    for (const call of host.hostCalls.values()) call.abort.abort();
    host.hostCalls.clear();
  }

  /** Owner-bound runs pause once the owner has been gone a while (CAN-5771). */
  private ownerChanged(subscribed: boolean): void {
    if (subscribed) {
      this.ownerGone = false;
      if (this.ownerAbsentTimer !== undefined)
        clearTimeout(this.ownerAbsentTimer);
      this.ownerAbsentTimer = undefined;
      return;
    }
    if (this.stopped || this.ownerAbsentTimer !== undefined) return;
    const timer = setTimeout(() => {
      this.ownerAbsentTimer = undefined;
      this.ownerGone = true;
      void this.pauseOwnerBound();
    }, this.options.ownerAbsentPauseMs ?? OWNER_ABSENT_PAUSE_MS);
    timer.unref?.();
    this.ownerAbsentTimer = timer;
  }

  private async pauseOwnerBound(): Promise<void> {
    const host = this.host;
    if (!host || host.exited || this.ownerBound.size === 0) return;
    await this.send(
      host,
      { op: 'pause', executionIds: [...this.ownerBound] },
      this.options.checkpointTimeoutMs ?? CHECKPOINT_TIMEOUT_MS,
    ).catch(() => undefined);
  }

  /** Takes the notifications no stream has received yet for `executionId`. */
  public takeNotifications(
    executionId: string,
  ): readonly PipelineExecutionNotification[] {
    const kept = this.undelivered.get(executionId);
    if (!kept) return [];
    this.undelivered.delete(executionId);
    if (kept.expiry !== undefined) clearTimeout(kept.expiry);
    return kept.items;
  }

  private keepUndelivered(
    executionId: string,
    notification: PipelineExecutionNotification,
  ): void {
    let kept = this.undelivered.get(executionId);
    if (!kept) {
      kept = { items: [] };
      this.undelivered.set(executionId, kept);
    }
    if (kept.items.length < UNDELIVERED_NOTIFICATIONS_MAX)
      kept.items.push(notification);
  }

  private expireUndelivered(executionId: string): void {
    const kept = this.undelivered.get(executionId);
    if (!kept || kept.expiry !== undefined) return;
    const expiry = setTimeout(() => {
      if (this.undelivered.get(executionId) === kept)
        this.undelivered.delete(executionId);
    }, UNDELIVERED_NOTIFICATIONS_TTL_MS);
    expiry.unref?.();
    kept.expiry = expiry;
  }

  private releaseExecution(executionId: string): void {
    this.ownerBound.delete(executionId);
    const release = this.releases.get(executionId);
    this.releases.delete(executionId);
    release?.();
  }

  private clearIdle(host: LiveHost): void {
    if (host.idleTimer === undefined) return;
    clearTimeout(host.idleTimer);
    host.idleTimer = undefined;
  }

  private busy(host: LiveHost): boolean {
    return (
      host.executions.size > 0 ||
      host.observers.size > 0 ||
      host.pending.size > 0
    );
  }

  /**
   * Stops a host that holds nothing: no execution, observer or request. It
   * leaves the current slot first, so a request meanwhile starts another.
   */
  private scheduleIdleStop(host: LiveHost): void {
    if (
      host.exited ||
      host.idleTimer !== undefined ||
      this.host !== host ||
      this.busy(host)
    )
      return;
    const timer = setTimeout(() => {
      host.idleTimer = undefined;
      if (this.host !== host || this.busy(host)) return;
      this.host = null;
      host.expectedExit = true;
      this.send(host, { op: 'exit' }, this.requestTimeoutMs).catch(
        () => undefined,
      );
      const kill = setTimeout(() => {
        if (!host.exited) host.process.kill();
      }, EXIT_GRACE_MS);
      kill.unref?.();
    }, this.options.idleStopMs ?? IDLE_STOP_MS);
    timer.unref?.();
    host.idleTimer = timer;
  }

  private waitForExit(host: LiveHost): Promise<void> {
    if (host.exited) return Promise.resolve();
    return new Promise((resolve) => {
      host.exitWaiters.push(resolve);
    });
  }

  private ended(host: LiveHost, code: number): void {
    if (host.exited) return;
    host.exited = true;
    this.abortHostCalls(host);
    this.clearIdle(host);
    if (this.host === host) this.host = null;
    for (const pending of host.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new HostRequestFailure('exited'));
    }
    host.pending.clear();
    // Step process groups outlive their host's tree, however it ended.
    for (const group of host.processGroups.values())
      if (group > 0) this.options.killProcessGroup?.(group);
    if (!host.expectedExit) {
      const lost = pipelineHostLostError().payload;
      for (const observers of host.observers.values())
        for (const observer of [...observers]) observer.onEnd?.(lost);
      this.options.onHostLost?.({ code, lost: host.executions.size });
    }
    host.processGroups.clear();
    host.observers.clear();
    for (const executionId of host.executions) {
      this.releaseExecution(executionId);
      this.expireUndelivered(executionId);
    }
    host.executions.clear();
    for (const resolve of host.exitWaiters.splice(0)) resolve();
  }
}
