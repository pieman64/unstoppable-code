/**
 * Scripted Codex app-server transport for pipeline integration tests.
 *
 * Exports `createScriptedCodex(recorder, { target })`, the concrete
 * `ScriptedCodex` driver type, and `codexSpawnModuleMock(driver)`. Tests mock
 * only `node:child_process.spawn` with that factory; the real
 * `CodexAppServerClient`, `CodexRuntimeService`, provider, and session manager
 * continue to run against the fake app-server's stdio streams.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';
import { PassThrough } from 'node:stream';

import type {
  LifecycleControl,
  LifecycleFixture,
  LifecycleFrame,
  LifecycleFrameObservation,
  LifecycleIds,
  LifecycleReplayDriver,
  PipelineChatTarget,
  PipelineTraceRecorder,
  ProviderFrameIds,
  ProviderTraceEvent,
  ScriptedCodexBackgroundTerminal,
  ScriptedCodexBackgroundTerminalsConfiguration,
  ScriptedCodexResumeConfiguration,
  ScriptedProviderDriver,
  ScriptedProviderTurn,
  ScriptedSteer,
} from './contracts';
import {
  buildCodexReplayParams,
  buildCodexReplayResponseResult,
  collectCodexReplayIds,
  CodexReplayAliases,
  CodexReplayControlMatcher,
  projectCodexReplayEnvelope,
  resolveCodexReplayTemplate,
} from './fixture-replay-codex';

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const MAX_WAIT_TIMEOUT_MS = 60_000;
const STREAM_WRITE_TIMEOUT_MS = 5_000;
const SCRIPTED_CODEX_HOME = '/tmp/scripted-codex-home';

type JsonRecord = Record<string, unknown>;
type JsonRpcId = string | number;
type ReplayFrameWriteObserver = (
  frame: LifecycleFrame,
  envelope: Readonly<Record<string, unknown>>,
) => void;

interface QueueWaiter<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

interface PendingClientRequest {
  id: JsonRpcId;
  method: string;
  params?: JsonRecord;
  turnKey?: string;
  ids?: ProviderFrameIds;
  text?: string;
}

interface PendingReplayResponse {
  readonly frame: LifecycleFrame;
  readonly method: string;
  resolve(): void;
  reject(error: Error): void;
}

interface LiveClientRequest {
  readonly processState: ProcessState;
  readonly id: JsonRpcId;
  readonly request: PendingClientRequest;
}

interface PendingServerRequest {
  requestId: JsonRpcId;
  method: string;
  turnKey?: string;
  threadId?: string;
  ids?: ProviderFrameIds;
  responded: boolean;
  resolved: boolean;
}

interface ProcessState {
  readonly process: ScriptedCodexSpawnProcessLike;
  inputBuffer: string;
  inputTail: Promise<void>;
  readonly clientRequests: Map<string, PendingClientRequest>;
  readonly serverRequests: Map<string, PendingServerRequest>;
  readonly serverRequestHistory: Map<string, PendingServerRequest>;
  rootThreadId?: string;
}

interface ScriptedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly item: JsonRecord;
}

interface ScriptedNativeTask {
  readonly taskId: string;
  readonly toolUseId: string;
  readonly item: JsonRecord;
  readonly kind: 'agent' | 'shell' | 'monitor' | 'workflow';
  readonly childTurnId?: string;
}

interface PendingResumedTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: ScriptedCodexResumeConfiguration['status'];
  readonly startOrder: ScriptedCodexResumeConfiguration['startOrder'];
}

/**
 * The spawn mock deliberately exposes only the child surface used by the
 * Codex runtime. Keeping this shape narrow avoids making a fake process claim
 * Node's full, overload-heavy ChildProcess contract.
 */
export interface ScriptedCodexSpawnProcessLike {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly pid: number;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  on: EventEmitter['on'];
  once: EventEmitter['once'];
  removeListener: EventEmitter['removeListener'];
  kill(signal?: NodeJS.Signals | number): boolean;
  writeProviderFrame(frame: JsonRecord, description: string): Promise<void>;
}

/** Narrow module surface returned for a caller-owned `jest.mock` factory. */
export interface CodexSpawnModuleMock {
  spawn(
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ScriptedCodexSpawnProcessLike;
}

/** Codex's concrete driver additionally guarantees its server-request helpers. */
export interface ScriptedCodex extends ScriptedProviderDriver {
  readonly provider: 'codex';
  sendServerRequest(request: {
    method: string;
    callId: string;
    requestId?: string | number;
    params?: Readonly<Record<string, unknown>>;
  }): Promise<void>;
  resolveServerRequest(callId: string): Promise<void>;
}

export interface CreateScriptedCodexOptions {
  /** Explicit chat identity from the real AgentSessionOptions. */
  target: PipelineChatTarget;
}

const implementationByDriver = new WeakMap<
  ScriptedProviderDriver,
  ScriptedCodexImplementation
>();

/** Explicit owner binding for multi-host compositions; single-target default is unchanged. */
export function bindNextScriptedCodexThreadTarget(
  driver: ScriptedProviderDriver,
  target: PipelineChatTarget,
): void {
  const implementation = implementationByDriver.get(driver);
  if (!implementation) throw new Error('Expected a scripted Codex driver');
  implementation.bindNextThreadTarget(target);
}

/** Configure explicit pages, failures, or replay-only terminal ids in tests. */
export function configureScriptedCodexBackgroundTerminals(
  driver: ScriptedProviderDriver,
  configuration: ScriptedCodexBackgroundTerminalsConfiguration,
): void {
  const implementation = implementationByDriver.get(driver);
  if (!implementation) throw new Error('Expected a scripted Codex driver');
  implementation.configureBackgroundTerminals(configuration);
}

/** Send a server request and its resolution in one stdout batch. */
export function sendAndResolveScriptedCodexServerRequest(
  driver: ScriptedProviderDriver,
  request: {
    method: string;
    callId: string;
    requestId?: string | number;
    params?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  const implementation = implementationByDriver.get(driver);
  if (!implementation) throw new Error('Expected a scripted Codex driver');
  return implementation.sendServerRequestAndResolve(request);
}

/** Send a server request with an explicit JSON-RPC request id. */
export function sendScriptedCodexServerRequest(
  driver: ScriptedProviderDriver,
  request: {
    method: string;
    callId: string;
    requestId?: string | number;
    params?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  const implementation = implementationByDriver.get(driver);
  if (!implementation) throw new Error('Expected a scripted Codex driver');
  return implementation.sendServerRequest(request);
}

/** Send a serverRequest/resolved notification, including stale identities. */
export function resolveScriptedCodexServerRequest(
  driver: ScriptedProviderDriver,
  requestId: string | number,
  options?: { threadId?: string },
): Promise<void> {
  const implementation = implementationByDriver.get(driver);
  if (!implementation) throw new Error('Expected a scripted Codex driver');
  return implementation.notifyServerRequestResolved(requestId, options);
}

/** Read the live root thread id for tests that need an unknown request id. */
export function getScriptedCodexRootThreadId(
  driver: ScriptedProviderDriver,
): string | undefined {
  const implementation = implementationByDriver.get(driver);
  if (!implementation) throw new Error('Expected a scripted Codex driver');
  return implementation.rootThreadId();
}

/** Force the latest live fake app-server to exit without disposing its driver. */
export function exitScriptedCodexUnexpectedly(
  driver: ScriptedProviderDriver,
): Promise<void> {
  const implementation = implementationByDriver.get(driver);
  if (!implementation) throw new Error('Expected a scripted Codex driver');
  return implementation.exitUnexpectedly();
}

type ScriptedCodexFaultMethod =
  | 'thread/start'
  | 'thread/resume'
  | 'turn/interrupt';
type ScriptedCodexFaultKind = 'stall' | 'closing' | 'error';

/**
 * App-server transport faults for the next requests of one method, applied
 * in order: `stall` never answers (a wedged worker, so the client's request
 * deadline fires); `error` answers with a JSON-RPC error; `closing` rejects
 * a `thread/resume` as Codex does while it still closes that thread, then
 * reports `thread/closed`.
 */
export function queueScriptedCodexRequestFault(
  driver: ScriptedProviderDriver,
  fault: {
    method: ScriptedCodexFaultMethod;
    kind: ScriptedCodexFaultKind;
    count?: number;
  },
): void {
  const implementation = implementationByDriver.get(driver);
  if (!implementation) throw new Error('Expected a scripted Codex driver');
  implementation.queueRequestFault(fault.method, fault.kind, fault.count ?? 1);
}

/** Lifecycle composition leaf: a native command streams before its late completion. */
export function emitScriptedCodexCommand(
  driver: ScriptedProviderDriver,
  turnKey: string,
  command: {
    itemId: string;
    output: string;
    completed?: boolean;
    processId?: string | null;
  },
): Promise<void> {
  const implementation = implementationByDriver.get(driver);
  if (!implementation) throw new Error('Expected a scripted Codex driver');
  return implementation.emitCommand(turnKey, command);
}

/** Synthetic replay of a native terminal, including an intentionally stale one. */
export function replayScriptedCodexRootTerminal(
  driver: ScriptedProviderDriver,
  turnKey: string,
): Promise<void> {
  const implementation = implementationByDriver.get(driver);
  if (!implementation) throw new Error('Expected a scripted Codex driver');
  return implementation.replayRootTerminal(turnKey);
}

/** Create a scripted Codex app-server driver for one chat target. */
export function createScriptedCodex(
  recorder: PipelineTraceRecorder,
  options: CreateScriptedCodexOptions,
): ScriptedCodex {
  const implementation = new ScriptedCodexImplementation(
    recorder,
    options.target,
  );
  implementationByDriver.set(implementation, implementation);
  return implementation;
}

/**
 * Return a spawn-only module mock. The test owns the `jest.mock` call and can
 * spread the real child-process module around this mock without replacing any
 * client/runtime boundary.
 */
export function codexSpawnModuleMock(
  driver: ScriptedCodex,
): CodexSpawnModuleMock {
  const implementation = implementationByDriver.get(driver);
  if (!implementation) {
    throw new Error(
      'codexSpawnModuleMock requires a driver from createScriptedCodex',
    );
  }

  return {
    spawn: () => implementation.spawnProcess(),
  };
}

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private waiters: QueueWaiter<T>[] = [];
  private closeError: Error | undefined;

  push(value: T): void {
    if (this.closeError) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(value);
      return;
    }
    this.values.push(value);
  }

  next(timeoutMs: number | undefined, description: string): Promise<T> {
    const timeout = boundedTimeout(timeoutMs, description);
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (this.closeError) return Promise.reject(this.closeError);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(
          new Error(`Timed out after ${timeout}ms waiting for ${description}`),
        );
      }, timeout);
      const waiter: QueueWaiter<T> = {
        resolve: (nextValue): void => {
          clearTimeout(timer);
          resolve(nextValue);
        },
        reject: (error): void => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.waiters.push(waiter);
    });
  }

  close(error: Error): void {
    if (this.closeError) return;
    this.closeError = error;
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters = [];
  }
}

class FakeScriptedCodexSpawnProcess
  extends EventEmitter
  implements ScriptedCodexSpawnProcessLike
{
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;

  private killedValue = false;
  private exitCodeValue: number | null = null;
  private signalCodeValue: NodeJS.Signals | null = null;

  constructor(pid: number, onClientData: (chunk: string) => void) {
    super();
    this.pid = pid;
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: Buffer | string) => {
      onClientData(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
  }

  get killed(): boolean {
    return this.killedValue;
  }

  get exitCode(): number | null {
    return this.exitCodeValue;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.signalCodeValue;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.exitCodeValue !== null || this.signalCodeValue !== null)
      return false;
    this.killedValue = true;
    this.signalCodeValue = typeof signal === 'string' ? signal : 'SIGTERM';
    this.emit('exit', null, this.signalCodeValue);
    this.stdin.destroy();
    this.stdout.end();
    this.stderr.end();
    this.emit('close', null, this.signalCodeValue);
    return true;
  }

  writeProviderFrame(frame: JsonRecord, description: string): Promise<void> {
    const serialized = `${JSON.stringify(frame)}\n`;
    return withTimeout(
      new Promise<void>((resolve, reject) => {
        this.stdout.write(serialized, (error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
      STREAM_WRITE_TIMEOUT_MS,
      `writing scripted Codex ${description}`,
    );
  }
}

class ScriptedCodexImplementation implements ScriptedCodex {
  readonly provider: 'codex';

  private readonly recorder: PipelineTraceRecorder;
  private readonly target: PipelineChatTarget;
  private readonly nextThreadTargets: PipelineChatTarget[] = [];
  private readonly threadTargets = new Map<string, PipelineChatTarget>();
  private readonly turnTargets = new Map<string, PipelineChatTarget>();
  private readonly backgroundTerminalsByThread = new Map<
    string,
    Map<string, ScriptedCodexBackgroundTerminal>
  >();
  private backgroundTerminalsConfiguration:
    | ScriptedCodexBackgroundTerminalsConfiguration
    | undefined;

  bindNextThreadTarget(target: PipelineChatTarget): void {
    this.nextThreadTargets.push({ ...target });
  }

  configureBackgroundTerminals(
    configuration: ScriptedCodexBackgroundTerminalsConfiguration,
  ): void {
    this.throwIfUnavailable();
    this.backgroundTerminalsConfiguration = structuredClone(configuration);
  }

  async exitUnexpectedly(): Promise<void> {
    this.throwIfUnavailable();
    const processState = [...this.processStates]
      .reverse()
      .find(
        (state) =>
          !state.process.killed &&
          state.process.exitCode === null &&
          state.process.signalCode === null,
      );
    if (!processState) {
      throw new Error('No live scripted Codex process is available');
    }

    let onExit: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => {
      onExit = resolve;
      processState.process.once('exit', onExit);
    });
    try {
      if (!processState.process.kill('SIGKILL')) {
        throw new Error('Could not kill the live scripted Codex process');
      }
      await withTimeout(
        exited,
        5_000,
        'waiting for unexpected scripted Codex process exit',
      );
    } finally {
      if (onExit) processState.process.removeListener('exit', onExit);
    }
  }

  async emitCommand(
    turnKey: string,
    command: {
      itemId: string;
      output: string;
      completed?: boolean;
      processId?: string | null;
    },
  ): Promise<void> {
    const turn = this.turns.get(turnKey);
    if (!turn) throw new Error(`Unknown Codex turn ${turnKey}`);
    const item = {
      type: 'commandExecution',
      id: command.itemId,
      pluginId: null,
      scriptPath: null,
      command: 'synthetic lifecycle command',
      cwd: '/tmp/scripted-codex',
      processId: command.processId ?? null,
      source: 'agent',
      status: command.completed ? 'completed' : 'inProgress',
      commandActions: [],
      aggregatedOutput: command.completed ? command.output : null,
      exitCode: command.completed ? 0 : null,
      durationMs: command.completed ? 1 : null,
    };
    await this.sendNotification(
      turn.processState,
      command.completed ? 'item/completed' : 'item/started',
      { threadId: turn.threadId, turnId: turnKey, item },
      turnKey,
    );
    if (!command.completed)
      await this.sendNotification(
        turn.processState,
        'item/commandExecution/outputDelta',
        {
          threadId: turn.threadId,
          turnId: turnKey,
          itemId: command.itemId,
          delta: command.output,
        },
        turnKey,
      );
  }
  async replayRootTerminal(turnKey: string): Promise<void> {
    const turn = this.turns.get(turnKey);
    if (!turn) throw new Error(`Unknown Codex turn ${turnKey}`);
    await this.sendNotification(
      turn.processState,
      'turn/completed',
      {
        threadId: turn.threadId,
        turn: { id: turnKey, items: [], status: 'completed', error: null },
      },
      turnKey,
    );
  }
  private readonly processStates: ProcessState[] = [];
  private readonly launchInputs: unknown[] = [];
  private readonly replayResponses: PendingReplayResponse[] = [];
  private readonly turns = new Map<string, ScriptedCodexTurn>();
  private readonly turnsById = new Map<string, ScriptedCodexTurn>();
  private nextResumeConfiguration: ScriptedCodexResumeConfiguration | undefined;
  private pendingResumedTurn: PendingResumedTurn | undefined;
  private readonly requestFaults = new Map<
    ScriptedCodexFaultMethod,
    ScriptedCodexFaultKind[]
  >();
  private readonly turnQueue = new AsyncQueue<ScriptedCodexTurn>();
  private readonly interruptQueue = new AsyncQueue<null>();
  private activeTurn: ScriptedCodexTurn | undefined;
  // Globally unique: capability leases persist in the Jest worker's data dir across files.
  private readonly driverId = randomUUID();
  private nextThreadNumber = 0;
  private nextTurnNumber = 0;
  private disposed = false;
  private fatalError: Error | undefined;
  private replayFixture: LifecycleFixture | undefined;
  private replayAliases: CodexReplayAliases | undefined;
  private replayControls: CodexReplayControlMatcher | undefined;
  private readonly replayFrameWriteObservers: ReplayFrameWriteObserver[] = [];
  private nextReplayId = 0;
  private readonly replayEnqueuedTurns = new Set<string>();

  constructor(recorder: PipelineTraceRecorder, target: PipelineChatTarget) {
    this.provider = 'codex';
    this.recorder = recorder;
    this.target = {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
    };
  }

  getLaunchInputs(): readonly unknown[] {
    return this.launchInputs.map((input) => structuredClone(input));
  }

  /** Queue transport faults, in order, for the next requests of one method. */
  queueRequestFault(
    method: ScriptedCodexFaultMethod,
    kind: ScriptedCodexFaultKind,
    count: number,
  ): void {
    this.throwIfUnavailable();
    if (kind === 'closing' && method !== 'thread/resume')
      throw new Error('Only thread/resume is rejected while closing');
    const queued = this.requestFaults.get(method) ?? [];
    for (let index = 0; index < count; index += 1) queued.push(kind);
    this.requestFaults.set(method, queued);
  }

  /** Takes the next queued fault for a request; synchronous, so an unfaulted request keeps its frame order. */
  private takeRequestFault(
    method: ScriptedCodexFaultMethod,
  ): ScriptedCodexFaultKind | undefined {
    return this.requestFaults.get(method)?.shift();
  }

  /** Answers a faulted request (a stalled one never is). */
  private async applyRequestFault(
    processState: ProcessState,
    method: ScriptedCodexFaultMethod,
    kind: ScriptedCodexFaultKind,
    id: JsonRpcId,
    params: JsonRecord,
  ): Promise<void> {
    if (kind === 'stall') return;
    if (kind === 'error') {
      await this.respondToClientError(processState, id, {
        code: -32603,
        message: `scripted ${method} failure`,
      });
      return;
    }
    const threadId = readString(params, 'threadId');
    if (!threadId)
      throw new Error('A closing rejection needs the thread/resume threadId');
    await this.respondToClientError(processState, id, {
      code: -32600,
      message: `thread ${threadId} is closing; retry thread/resume after the thread is closed`,
    });
    await this.sendNotification(processState, 'thread/closed', { threadId });
  }

  configureNextResume(configuration: ScriptedCodexResumeConfiguration): void {
    this.throwIfUnavailable();
    if (this.replayFixture) {
      throw new Error(
        'Scripted Codex resume configuration cannot be combined with lifecycle replay',
      );
    }
    if (this.nextResumeConfiguration || this.pendingResumedTurn) {
      throw new Error('A scripted Codex resume is already configured');
    }
    this.nextResumeConfiguration = { ...configuration };
  }

  enableReplay(fixture: LifecycleFixture): LifecycleReplayDriver {
    this.throwIfUnavailable();
    if (fixture.provider !== 'codex') {
      throw new Error('Codex replay requires a Codex lifecycle fixture');
    }
    if (this.replayFixture) {
      throw new Error('Codex lifecycle replay is already enabled');
    }
    if (this.processStates.some((state) => state.clientRequests.size > 0)) {
      throw new Error('Codex replay must be enabled before client requests');
    }
    this.replayFixture = fixture;
    this.replayAliases = new CodexReplayAliases();
    this.replayControls = new CodexReplayControlMatcher(
      fixture,
      this.replayAliases,
    );
    return {
      emit: (frame): Promise<void> => this.emitReplayFrame(frame),
      acceptControl: (control): Promise<void> =>
        this.acceptReplayControl(control),
      liveId: (kind, alias): string | undefined =>
        this.replayAliases?.resolve(kind, alias),
      observeBeforeFrameWrite: (observer): (() => void) => {
        this.replayFrameWriteObservers.push(observer);
        return (): void => {
          const index = this.replayFrameWriteObservers.indexOf(observer);
          if (index >= 0) this.replayFrameWriteObservers.splice(index, 1);
        };
      },
    };
  }

  nextTurn(options?: { timeoutMs?: number }): Promise<ScriptedProviderTurn> {
    this.throwIfUnavailable();
    return this.turnQueue.next(options?.timeoutMs, 'the next Codex turn/start');
  }

  async startTurnByItself(options?: {
    text?: string;
  }): Promise<ScriptedProviderTurn> {
    this.throwIfUnavailable();
    const processState = this.latestProcessState();
    const threadId = processState.rootThreadId;
    if (!threadId) {
      throw new Error(
        'Cannot script an unsolicited Codex turn before the real app-server client has started its root thread',
      );
    }
    const turn = this.createTurn(processState, '', threadId);
    await turn.announceSelfStarted();
    if (options?.text !== undefined) await turn.emitText(options.text);
    return turn;
  }

  nextInterrupt(options?: { timeoutMs?: number }): Promise<void> {
    this.throwIfUnavailable();
    return this.interruptQueue
      .next(options?.timeoutMs, "Codex's turn/interrupt request")
      .then(() => undefined);
  }

  async sendServerRequest(request: {
    method: string;
    callId: string;
    requestId?: string | number;
    params?: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    this.throwIfUnavailable();
    const turn = this.activeTurn;
    const send = (): Promise<void> =>
      this.sendServerRequestNow(
        turn?.processState ?? this.latestProcessState(),
        request,
        turn,
      );
    if (turn) {
      await turn.enqueueFrame(send);
      return;
    }
    await send();
  }

  async sendServerRequestAndResolve(request: {
    method: string;
    callId: string;
    requestId?: string | number;
    params?: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    this.throwIfUnavailable();
    const turn = this.activeTurn;
    const send = (): Promise<void> =>
      this.sendServerRequestAndResolveNow(
        turn?.processState ?? this.latestProcessState(),
        request,
        turn,
      );
    if (turn) {
      await turn.enqueueFrame(send);
      return;
    }
    await send();
  }

  async notifyServerRequestResolved(
    requestId: string | number,
    options?: { threadId?: string },
  ): Promise<void> {
    this.throwIfUnavailable();
    const pending = this.findServerRequest(requestId);
    const processState = pending?.processState ?? this.latestProcessState();
    const threadId =
      options?.threadId ??
      pending?.request.threadId ??
      processState.rootThreadId;
    const params: JsonRecord = {
      requestId,
      ...(threadId ? { threadId } : {}),
    };
    if (pending?.request.turnKey) params.turnId = pending.request.turnKey;
    const ids = mergeIds(pending?.request.ids, {
      requestId: String(requestId),
    });
    await this.sendNotification(
      processState,
      'serverRequest/resolved',
      params,
      pending?.request.turnKey,
      ids,
    );
    if (
      pending &&
      (options?.threadId === undefined ||
        options.threadId === pending.request.threadId)
    ) {
      pending.request.resolved = true;
      processState.serverRequests.delete(idKey(requestId));
    }
  }

  async resolveServerRequest(callId: string): Promise<void> {
    this.throwIfUnavailable();
    const pending = this.findServerRequest(callId);
    if (!pending) {
      throw new Error(`No scripted Codex server request ${callId}`);
    }
    if (pending.request.resolved) {
      throw new Error(
        `Scripted Codex server request ${callId} was already resolved`,
      );
    }
    const send = (): Promise<void> =>
      this.notifyServerRequestResolved(pending.request.requestId);
    if (pending.turn) {
      await pending.turn.enqueueFrame(send);
      return;
    }
    await send();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error('Scripted Codex driver was disposed');
    this.turnQueue.close(error);
    this.interruptQueue.close(error);
    this.replayControls?.close(error);
    for (const waiter of this.replayResponses.splice(0)) waiter.reject(error);
    for (const turn of Array.from(this.turns.values())) turn.dispose(error);
    for (const state of this.processStates) state.process.kill('SIGTERM');
    await Promise.all(
      this.processStates.map((state) =>
        withTimeout(
          state.inputTail,
          DEFAULT_WAIT_TIMEOUT_MS,
          'Codex stdin drain during dispose',
        ),
      ),
    );
  }

  spawnProcess(): ScriptedCodexSpawnProcessLike {
    this.throwIfUnavailable();
    const state: ProcessState = {
      process: new FakeScriptedCodexSpawnProcess(
        Number.MAX_SAFE_INTEGER,
        (chunk) => this.enqueueClientData(state, chunk),
      ),
      inputBuffer: '',
      inputTail: Promise.resolve(),
      clientRequests: new Map<string, PendingClientRequest>(),
      serverRequests: new Map<string, PendingServerRequest>(),
      serverRequestHistory: new Map<string, PendingServerRequest>(),
    };
    this.processStates.push(state);
    return state.process;
  }

  createTurn(
    processState: ProcessState,
    prompt: string,
    threadId = processState.rootThreadId,
    turnKey?: string,
  ): ScriptedCodexTurn {
    if (!threadId) {
      throw new Error(
        'Codex requested turn/start before a root thread was ready',
      );
    }
    const actualTurnKey = turnKey ?? this.nextTurnKey();
    const turn = new ScriptedCodexTurn({
      owner: this,
      turnKey: actualTurnKey,
      prompt,
      threadId,
      processState,
    });
    const previous = this.turnsById.get(actualTurnKey);
    if (previous) {
      previous.dispose(
        new Error(`Codex turn ${actualTurnKey} was replaced by a resumed turn`),
      );
    }
    this.turns.set(actualTurnKey, turn);
    this.turnsById.set(actualTurnKey, turn);
    this.turnTargets.set(
      actualTurnKey,
      this.threadTargets.get(threadId) ?? this.target,
    );
    this.activeTurn = turn;
    return turn;
  }

  private nextTurnKey(): string {
    this.nextTurnNumber += 1;
    return `turn-${this.nextTurnNumber}`;
  }

  enqueueTurn(turn: ScriptedCodexTurn): void {
    this.turnQueue.push(turn);
  }

  enqueueInterrupt(): void {
    this.interruptQueue.push(null);
  }

  turnForParams(params: JsonRecord): ScriptedCodexTurn | undefined {
    const id =
      readString(params, 'expectedTurnId') ?? readString(params, 'turnId');
    if (id) {
      const byId = this.turnsById.get(id);
      if (byId) return byId;
    }
    return this.activeTurn;
  }

  async sendNotification(
    processState: ProcessState,
    method: string,
    params: JsonRecord,
    turnKey?: string,
    ids?: ProviderFrameIds,
  ): Promise<void> {
    const frame: JsonRecord = { jsonrpc: '2.0', method, params };
    await this.writeProviderFrame(
      processState,
      frame,
      'to-canopy',
      `notification:${method}`,
      turnKey,
      mergeIds(ids, idsForParams(params)),
    );
  }

  async sendServerRequestNow(
    processState: ProcessState,
    request: {
      method: string;
      callId: string;
      requestId?: string | number;
      params?: Readonly<Record<string, unknown>>;
    },
    turn?: ScriptedCodexTurn,
  ): Promise<void> {
    const params: JsonRecord = { ...(request.params ?? {}) };
    if (!readString(params, 'threadId')) {
      const threadId = turn?.threadId ?? processState.rootThreadId;
      if (threadId) params.threadId = threadId;
    }
    if (!readString(params, 'turnId') && turn) params.turnId = turn.turnKey;
    if (!readString(params, 'callId')) params.callId = request.callId;
    const requestId = request.requestId ?? request.callId;
    const ids = mergeIds(
      { requestId: String(requestId) },
      idsForParams(params),
      {
        callId: request.callId,
      },
    );
    const frame: JsonRecord = {
      jsonrpc: '2.0',
      id: requestId,
      method: request.method,
      params,
    };
    const pending: PendingServerRequest = {
      requestId,
      method: request.method,
      ...(turn ? { turnKey: turn.turnKey } : {}),
      ...(readString(params, 'threadId')
        ? { threadId: readString(params, 'threadId') }
        : {}),
      ...(ids ? { ids } : {}),
      responded: false,
      resolved: false,
    };
    processState.serverRequests.set(idKey(requestId), pending);
    processState.serverRequestHistory.set(idKey(requestId), pending);
    await this.writeProviderFrame(
      processState,
      frame,
      'to-canopy',
      `request:${request.method}`,
      turn?.turnKey,
      ids,
    );
  }

  async sendServerRequestAndResolveNow(
    processState: ProcessState,
    request: {
      method: string;
      callId: string;
      requestId?: string | number;
      params?: Readonly<Record<string, unknown>>;
    },
    turn?: ScriptedCodexTurn,
  ): Promise<void> {
    const params: JsonRecord = { ...(request.params ?? {}) };
    if (!readString(params, 'threadId')) {
      const threadId = turn?.threadId ?? processState.rootThreadId;
      if (threadId) params.threadId = threadId;
    }
    if (!readString(params, 'turnId') && turn) params.turnId = turn.turnKey;
    if (!readString(params, 'callId')) params.callId = request.callId;
    const requestId = request.requestId ?? request.callId;
    const ids = mergeIds(
      { requestId: String(requestId) },
      idsForParams(params),
      {
        callId: request.callId,
      },
    );
    const requestFrame: JsonRecord = {
      jsonrpc: '2.0',
      id: requestId,
      method: request.method,
      params,
    };
    const resolvedParams: JsonRecord = {
      requestId,
      ...(readString(params, 'threadId')
        ? { threadId: readString(params, 'threadId') }
        : {}),
      ...(turn ? { turnId: turn.turnKey } : {}),
    };
    const resolvedFrame: JsonRecord = {
      jsonrpc: '2.0',
      method: 'serverRequest/resolved',
      params: resolvedParams,
    };
    const pending: PendingServerRequest = {
      requestId,
      method: request.method,
      ...(turn ? { turnKey: turn.turnKey } : {}),
      ...(readString(params, 'threadId')
        ? { threadId: readString(params, 'threadId') }
        : {}),
      ...(ids ? { ids } : {}),
      responded: false,
      resolved: true,
    };
    processState.serverRequests.set(idKey(requestId), pending);
    processState.serverRequestHistory.set(idKey(requestId), pending);
    this.recordFrame(
      'to-canopy',
      `request:${request.method}`,
      turn?.turnKey,
      ids,
    );
    this.recordFrame(
      'to-canopy',
      'notification:serverRequest/resolved',
      turn?.turnKey,
      mergeIds(ids, { requestId: String(requestId) }),
    );
    const serialized = `${JSON.stringify(requestFrame)}\n${JSON.stringify(resolvedFrame)}\n`;
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        processState.process.stdout.write(
          serialized,
          (error?: Error | null) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          },
        );
      }),
      STREAM_WRITE_TIMEOUT_MS,
      `writing scripted Codex request and resolution for ${request.method}`,
    );
  }

  async writeProviderFrame(
    processState: ProcessState,
    frame: JsonRecord,
    direction: 'to-canopy' | 'to-provider',
    type: string,
    turnKey?: string,
    ids?: ProviderFrameIds,
    text?: string,
  ): Promise<void> {
    const replayType = replayTypeFromTrace(type);
    const replayFrame =
      this.replayFixture && replayType
        ? projectCodexReplayEnvelope(
            frame,
            replayType,
            this.replayAliases?.project ?? ((): undefined => undefined),
            processState.rootThreadId,
          )
        : undefined;
    const payload = readRecord(frame, 'params') ?? readRecord(frame, 'result');
    const thread = payload ? readRecord(payload, 'thread') : undefined;
    const threadId = payload
      ? (readString(payload, 'threadId') ??
        (thread ? readString(thread, 'id') : undefined))
      : undefined;
    const item = payload ? readRecord(payload, 'item') : undefined;
    this.updateBackgroundTerminalView(direction, type, threadId, item);
    const itemId = item ? readString(item, 'id') : undefined;
    const aggregateOutput = item
      ? readString(item, 'aggregatedOutput')
      : undefined;
    const nativeTurnId = payload ? readString(payload, 'turnId') : undefined;
    const turn = payload ? readRecord(payload, 'turn') : undefined;
    const turnStatus =
      (turn ? readString(turn, 'status') : undefined) ??
      (payload ? readString(payload, 'status') : undefined);
    const commandCompletion =
      direction === 'to-canopy' &&
      type === 'notification:item/completed' &&
      item?.type === 'commandExecution' &&
      itemId &&
      threadId &&
      nativeTurnId &&
      aggregateOutput !== undefined
        ? { itemId, threadId, turnId: nativeTurnId, aggregateOutput }
        : undefined;
    const activityKind = item ? readString(item, 'kind') : undefined;
    const agentThreadId = item
      ? (readString(item, 'agentThreadId') ??
        readString(item, 'agent_thread_id'))
      : undefined;
    const agentTerminal =
      direction === 'to-canopy' &&
      type === 'notification:turn/completed' &&
      threadId &&
      turnStatus
        ? { threadId, status: turnStatus }
        : direction === 'to-canopy' &&
            type === 'notification:item/completed' &&
            item?.type === 'subAgentActivity' &&
            (activityKind === 'completed' || activityKind === 'interrupted') &&
            agentThreadId
          ? { threadId: agentThreadId, status: activityKind }
          : undefined;
    this.recordFrame(
      direction,
      type,
      turnKey,
      ids,
      text,
      replayFrame,
      threadId ? this.threadTargets.get(threadId) : undefined,
      commandCompletion,
      agentTerminal,
    );
    await processState.process.writeProviderFrame(frame, type);
  }

  private updateBackgroundTerminalView(
    direction: 'to-canopy' | 'to-provider',
    type: string,
    threadId: string | undefined,
    item: JsonRecord | undefined,
  ): void {
    if (
      direction !== 'to-canopy' ||
      (type !== 'notification:item/started' &&
        type !== 'notification:item/completed') ||
      !threadId ||
      !item
    ) {
      return;
    }
    const itemId = readString(item, 'id');
    if (!itemId) return;

    if (type === 'notification:item/completed') {
      const terminals = this.backgroundTerminalsByThread.get(threadId);
      terminals?.delete(itemId);
      if (terminals?.size === 0)
        this.backgroundTerminalsByThread.delete(threadId);
      return;
    }

    const processId = readString(item, 'processId');
    if (
      item.type !== 'commandExecution' ||
      item.status === 'completed' ||
      !processId
    ) {
      return;
    }
    let terminals = this.backgroundTerminalsByThread.get(threadId);
    if (!terminals) {
      terminals = new Map<string, ScriptedCodexBackgroundTerminal>();
      this.backgroundTerminalsByThread.set(threadId, terminals);
    }
    terminals.set(itemId, {
      itemId,
      processId,
      command: readString(item, 'command') ?? '',
      cwd: readString(item, 'cwd') ?? '',
      osPid: readNullableFiniteNumber(item, 'osPid'),
      cpuPercent: readNullableFiniteNumber(item, 'cpuPercent'),
      rssKb: readNullableFiniteNumber(item, 'rssKb'),
    });
  }

  private applyReplaySyntheticProcessId(
    method: string,
    threadId: string | undefined,
    params: JsonRecord,
  ): void {
    if (method !== 'item/started') return;
    const configuration = this.backgroundTerminalsConfigurationFor(threadId);
    const processId = configuration?.syntheticProcessId;
    const item = readRecord(params, 'item');
    if (
      processId !== undefined &&
      item?.type === 'commandExecution' &&
      item.processId == null
    ) {
      item.processId = processId;
    }
  }

  recordFrame(
    direction: 'to-canopy' | 'to-provider',
    type: string,
    turnKey?: string,
    ids?: ProviderFrameIds,
    text?: string,
    replayFrame?: LifecycleFrameObservation,
    frameTarget?: PipelineChatTarget,
    commandCompletion?: ProviderTraceEvent['commandCompletion'],
    agentTerminal?: ProviderTraceEvent['agentTerminal'],
  ): void {
    this.recorder.record({
      kind: 'provider',
      provider: 'codex',
      target:
        frameTarget ??
        (turnKey ? this.turnTargets.get(turnKey) : undefined) ??
        this.target,
      direction,
      type,
      ...(turnKey !== undefined ? { turnKey } : {}),
      ...(ids ? { ids } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(commandCompletion ? { commandCompletion } : {}),
      ...(agentTerminal ? { agentTerminal } : {}),
      ...(replayFrame ? { replayFrame } : {}),
    });
  }

  finishTurn(turn: ScriptedCodexTurn): void {
    if (this.activeTurn === turn) this.activeTurn = undefined;
  }

  private enqueueClientData(processState: ProcessState, chunk: string): void {
    if (this.disposed) return;
    processState.inputTail = processState.inputTail
      .then(() => this.consumeClientData(processState, chunk))
      .catch((error: unknown) => {
        this.fail(error);
      });
  }

  private async consumeClientData(
    processState: ProcessState,
    chunk: string,
  ): Promise<void> {
    processState.inputBuffer += chunk;
    while (true) {
      const end = processState.inputBuffer.indexOf('\n');
      if (end < 0) return;
      const line = processState.inputBuffer.slice(0, end).trim();
      processState.inputBuffer = processState.inputBuffer.slice(end + 1);
      if (!line) continue;
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) {
        throw new Error('Codex client wrote a non-object JSON-RPC frame');
      }
      await this.handleClientFrame(processState, parsed);
    }
  }

  private async handleClientFrame(
    processState: ProcessState,
    frame: JsonRecord,
  ): Promise<void> {
    const method = readString(frame, 'method');
    if (!method) {
      this.handleClientResponse(processState, frame);
      return;
    }

    const id = readJsonRpcId(frame);
    const params = readRecord(frame, 'params') ?? {};
    if (method === 'thread/start') {
      this.launchInputs.push(structuredClone(params));
    }
    const ids = idsForFrame(frame, params);
    const text =
      method === 'turn/start' || method === 'turn/steer'
        ? inputText(params)
        : undefined;
    if (
      this.replayFixture &&
      (method === 'thread/start' || method === 'thread/resume')
    ) {
      this.prepareReplayThread(processState, method, params);
    }
    let turn = this.turnForParams(params);
    let startOrder: ScriptedCodexResumeConfiguration['startOrder'] | undefined;
    let controlMatch:
      | Awaited<ReturnType<CodexReplayControlMatcher['waitForRequest']>>
      | undefined;
    if (method === 'turn/start') {
      if (this.replayControls) {
        controlMatch = await this.replayControls.waitForRequest(method);
      }
      const threadId =
        readString(params, 'threadId') ?? processState.rootThreadId;
      if (!threadId) {
        throw new Error(
          'Codex requested turn/start before thread/start or thread/resume',
        );
      }
      const resumed = this.pendingResumedTurn;
      if (resumed) {
        if (resumed.threadId !== threadId) {
          throw new Error(
            `Scripted Codex expected resumed thread ${resumed.threadId} but turn/start targeted ${threadId}`,
          );
        }
        const existing = this.turnsById.get(resumed.turnId);
        turn =
          resumed.status === 'inProgress' &&
          existing?.isWritableFrom(processState)
            ? existing
            : this.createTurn(
                processState,
                text ?? '',
                threadId,
                resumed.turnId,
              );
        startOrder = resumed.startOrder;
        this.pendingResumedTurn = undefined;
      } else {
        const alias = controlMatch?.control.ids?.turn;
        const existingTurnId = alias
          ? this.replayAliases?.resolve('turn', alias)
          : undefined;
        turn = existingTurnId ? this.turnsById.get(existingTurnId) : undefined;
        if (!turn) {
          turn = this.createTurn(processState, text ?? '', threadId);
        }
        if (alias && turn)
          this.replayAliases?.bind('turn', alias, turn.turnKey);
      }
    } else if (
      this.replayControls &&
      (method === 'turn/steer' || method === 'turn/interrupt')
    ) {
      controlMatch = await this.replayControls.waitForRequest(method);
    }
    const turnKey = turn?.turnKey;
    const replayFrame =
      this.replayFixture && method
        ? projectCodexReplayEnvelope(
            frame,
            `request:${method}`,
            this.replayAliases?.project ?? ((): undefined => undefined),
            processState.rootThreadId,
          )
        : undefined;
    this.recordFrame(
      'to-provider',
      `client:${method}`,
      turnKey,
      ids,
      text,
      replayFrame,
    );

    if (id === undefined) {
      if (method === 'initialized') return;
      return;
    }

    const request: PendingClientRequest = {
      id,
      method,
      params: structuredClone(params),
      ...(turnKey ? { turnKey } : {}),
      ...(ids ? { ids } : {}),
      ...(text !== undefined ? { text } : {}),
    };
    const replayResponseWasPending =
      method === 'thread/backgroundTerminals/list' &&
      this.replayResponses.some((response) => response.method === method);
    processState.clientRequests.set(idKey(id), request);
    this.resolveWaitingReplayResponses();
    if (controlMatch) {
      controlMatch.complete(
        lifecycleIdsForClientRequest(id, method, params, turnKey),
      );
    }

    switch (method) {
      case 'initialize':
        if (this.replayFixture) return;
        await this.respondToClientRequest(processState, id, {
          userAgent: 'scripted-codex',
          codexHome: SCRIPTED_CODEX_HOME,
        });
        return;
      case 'thread/start':
      case 'thread/resume': {
        if (this.replayFixture) return;
        const fault = this.takeRequestFault(method);
        if (fault) {
          await this.applyRequestFault(processState, method, fault, id, params);
          return;
        }
        await this.handleThreadStart(processState, method, id, params);
        return;
      }
      case 'thread/read':
        if (this.replayFixture) return;
        await this.handleThreadRead(processState, id, params);
        return;
      case 'thread/backgroundTerminals/list':
        // A queued fixture response takes precedence; otherwise this newer
        // method is answered locally so fixture replay cannot leave it pending.
        if (replayResponseWasPending) return;
        await this.handleBackgroundTerminalsList(processState, id, params);
        return;
      case 'config/read':
        // Recorded fixtures predate this pre-thread read; answer it with an
        // empty config so replay cannot leave thread startup waiting on it.
        await this.respondToClientRequest(processState, id, { config: {} });
        return;
      case 'turn/start':
        if (!turn)
          throw new Error('Codex turn/start did not allocate a scripted turn');
        if (this.replayFixture) return;
        await this.handleTurnStart(processState, id, params, turn, startOrder);
        return;
      case 'turn/steer':
        if (this.replayFixture) return;
        this.handleTurnSteer(processState, id, params, text ?? '', request);
        return;
      case 'turn/interrupt':
        if (!this.replayFixture) {
          // A wedged worker never acknowledges, and its turn keeps running.
          const fault = this.takeRequestFault(method);
          if (fault) {
            this.enqueueInterrupt();
            await this.applyRequestFault(
              processState,
              method,
              fault,
              id,
              params,
            );
            return;
          }
        }
        if (turn) turn.markInterrupted();
        this.enqueueInterrupt();
        if (this.replayFixture) return;
        // This JSON-RPC acknowledgement is control-plane traffic, not a
        // scripted turn output frame. It intentionally bypasses turn.hold()
        // so an interrupt request cannot deadlock behind the output it stops.
        await this.respondToClientRequest(processState, id, {});
        return;
      default:
        if (this.replayFixture) return;
        await this.respondToClientRequest(processState, id, {});
    }
  }

  private acceptReplayControl(control: LifecycleControl): Promise<void> {
    if (!this.replayControls) {
      return Promise.reject(new Error('Codex lifecycle replay is not enabled'));
    }
    return this.replayControls.acceptControl(control);
  }

  private prepareReplayThread(
    processState: ProcessState,
    method: string,
    params: JsonRecord,
  ): void {
    let threadId = readString(params, 'threadId');
    if (!threadId) {
      this.nextThreadNumber += 1;
      threadId = `thread-${this.driverId}-${this.nextThreadNumber}`;
    }
    if (method === 'thread/start' || !processState.rootThreadId) {
      processState.rootThreadId = threadId;
    }
  }

  private async emitReplayFrame(frame: LifecycleFrame): Promise<void> {
    this.throwIfUnavailable();
    if (!this.replayFixture || !this.replayAliases) {
      throw new Error('Codex lifecycle replay is not enabled');
    }
    const template = resolveCodexReplayTemplate(frame);
    if (template.kind === 'response') {
      return this.emitReplayResponse(frame, template.method);
    }

    const processState = this.latestProcessState();
    if (
      template.kind === 'notification' &&
      template.method === 'turn/started'
    ) {
      const turnAlias = frame.ids?.turn;
      const resolved = turnAlias
        ? this.replayAliases.resolve('turn', turnAlias)
        : undefined;
      if (!resolved) {
        const threadId =
          (frame.ids?.thread
            ? this.replayAliases.resolve('thread', frame.ids.thread)
            : undefined) ?? processState.rootThreadId;
        if (!threadId) {
          throw new Error('Codex turn/started replay requires a live thread');
        }
        const turn = this.createTurn(processState, '', threadId);
        if (turnAlias) this.replayAliases.bind('turn', turnAlias, turn.turnKey);
      }
    }
    const ids = this.resolveReplayIds(processState, frame);
    const threadId = ids.thread ?? processState.rootThreadId;
    const thread = threadId
      ? threadResult(threadId, processState.rootThreadId, '/tmp/scripted-codex')
      : undefined;
    const params = buildCodexReplayParams({
      method: template.method,
      frame,
      ids,
      ...(thread ? { threadResult: thread } : {}),
    });
    if (template.kind === 'notification') {
      this.applyReplaySyntheticProcessId(template.method, threadId, params);
    }
    const turn = ids.turn ? this.turnsById.get(ids.turn) : undefined;

    if (template.kind === 'notification') {
      this.observeReplayFrameWrite(frame, {
        jsonrpc: '2.0',
        method: template.method,
        params,
      });
      await this.sendNotification(
        processState,
        template.method,
        params,
        turn?.turnKey,
        providerIdsFromLifecycleIds(ids),
      );
      if (template.method === 'turn/started' && turn) {
        this.enqueueReplayTurn(turn);
      } else if (template.method === 'turn/completed' && turn) {
        turn.markReplayCompleted();
      }
      return;
    }

    const requestId = ids.request ?? this.nextReplayLiveId('request');
    const callId = ids.call ?? ids.toolUse ?? requestId;
    const actualIds = mergeIds(providerIdsFromLifecycleIds(ids), {
      requestId,
      callId,
    });
    const envelope: JsonRecord = {
      jsonrpc: '2.0',
      id: requestId,
      method: template.method,
      params,
    };
    this.observeReplayFrameWrite(frame, envelope);
    const pending: PendingServerRequest = {
      requestId,
      method: template.method,
      ...(turn ? { turnKey: turn.turnKey } : {}),
      ...(threadId ? { threadId } : {}),
      ...(actualIds ? { ids: actualIds } : {}),
      responded: false,
      resolved: false,
    };
    processState.serverRequests.set(idKey(requestId), pending);
    processState.serverRequestHistory.set(idKey(requestId), pending);
    await this.writeProviderFrame(
      processState,
      envelope,
      'to-canopy',
      `request:${template.method}`,
      turn?.turnKey,
      actualIds,
    );
  }

  private resolveReplayIds(
    processState: ProcessState,
    frame: LifecycleFrame,
  ): LifecycleIds {
    const aliases = this.replayAliases;
    if (!aliases) throw new Error('Codex lifecycle replay is not enabled');
    const expected = frame.ids ?? {};
    const ids: LifecycleIds = {};
    const use = (
      kind: keyof LifecycleIds,
      preferred?: string,
    ): string | undefined => {
      const alias = expected[kind];
      if (alias === undefined) return undefined;
      const existing = aliases.resolve(kind, alias);
      const liveId = existing ?? preferred ?? this.nextReplayLiveId(kind);
      aliases.bind(kind, alias, liveId);
      return liveId;
    };
    // Once an alias owns the root thread, a new thread alias is a child thread
    // (a group may replay a child's frames before the root item that names it).
    const rootThreadId = processState.rootThreadId;
    const threadId = use(
      'thread',
      rootThreadId !== undefined &&
        aliases.aliasFor('thread', rootThreadId) === undefined
        ? rootThreadId
        : undefined,
    );
    const agentThreadId = use('agentThread');
    const turnId = use('turn', this.activeTurn?.turnKey);
    const itemId = use('item');
    const messageId = use('message');
    const taskId = use('task');
    const callId = use('call');
    const toolUseId = use('toolUse', callId);
    const requestId = use('request');
    if (threadId) ids.thread = threadId;
    if (agentThreadId) ids.agentThread = agentThreadId;
    if (turnId) ids.turn = turnId;
    if (itemId) ids.item = itemId;
    if (messageId) ids.message = messageId;
    if (taskId) ids.task = taskId;
    if (callId) ids.call = callId;
    if (toolUseId) ids.toolUse = toolUseId;
    if (requestId) ids.request = requestId;
    return ids;
  }

  private nextReplayLiveId(kind: string): string {
    this.nextReplayId += 1;
    return `codex-replay-${kind}-${this.nextReplayId}`;
  }

  private observeReplayFrameWrite(
    frame: LifecycleFrame,
    envelope: Readonly<Record<string, unknown>>,
  ): void {
    for (const observer of this.replayFrameWriteObservers) {
      observer(structuredClone(frame), structuredClone(envelope));
    }
  }

  private async emitReplayResponse(
    frame: LifecycleFrame,
    method: string,
  ): Promise<void> {
    const request = this.findLiveClientRequest(method);
    if (request) return this.respondToReplayFrame(frame, request);
    return new Promise<void>((resolve, reject) => {
      this.replayResponses.push({ frame, method, resolve, reject });
    });
  }

  private resolveWaitingReplayResponses(): void {
    if (!this.replayFixture) return;
    for (let index = 0; index < this.replayResponses.length; ) {
      const waiter = this.replayResponses[index];
      if (!waiter) {
        index += 1;
        continue;
      }
      const request = this.findLiveClientRequest(waiter.method);
      if (!request) {
        index += 1;
        continue;
      }
      this.replayResponses.splice(index, 1);
      void this.respondToReplayFrame(waiter.frame, request).then(
        () => waiter.resolve(),
        (error: unknown) => {
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          waiter.reject(normalized);
          this.fail(normalized);
        },
      );
    }
  }

  private findLiveClientRequest(method: string): LiveClientRequest | undefined {
    for (const processState of Array.from(this.processStates)) {
      for (const request of Array.from(processState.clientRequests.values())) {
        if (request.method !== method) continue;
        return { processState, id: request.id, request };
      }
    }
    return undefined;
  }

  private async respondToReplayFrame(
    frame: LifecycleFrame,
    live: LiveClientRequest,
  ): Promise<void> {
    const { processState, id, request } = live;
    const threadId =
      readString(request.params ?? {}, 'threadId') ?? processState.rootThreadId;
    const thread = threadId
      ? threadResult(threadId, processState.rootThreadId, '/tmp/scripted-codex')
      : undefined;
    const result = buildCodexReplayResponseResult({
      method: request.method,
      frame,
      ...(thread ? { threadResult: thread } : {}),
      ...(request.turnKey ? { turnId: request.turnKey } : {}),
    });
    const envelope: JsonRecord = { jsonrpc: '2.0', id, result };
    if (frame.fields?.serverRequestResolution === 'error') {
      delete envelope.result;
      envelope.error = { code: -32603, message: 'Synthetic lifecycle error' };
    }
    this.observeReplayFrameWrite(frame, envelope);
    const liveIds = collectCodexReplayIds(envelope);
    this.replayAliases?.bindIds(frame.ids, liveIds);
    const pending = processState.clientRequests.get(idKey(id));
    const turn = pending?.turnKey ? this.turns.get(pending.turnKey) : undefined;
    await this.respondWithEnvelope(
      processState,
      id,
      envelope,
      turn?.turnKey,
      providerIdsFromLifecycleIds(liveIds),
    );
    if (request.method === 'turn/start' && turn) this.enqueueReplayTurn(turn);
  }

  private enqueueReplayTurn(turn: ScriptedCodexTurn): void {
    if (this.replayEnqueuedTurns.has(turn.turnKey)) return;
    this.replayEnqueuedTurns.add(turn.turnKey);
    this.enqueueTurn(turn);
  }

  private async respondWithEnvelope(
    processState: ProcessState,
    id: JsonRpcId,
    envelope: JsonRecord,
    turnKey?: string,
    additionalIds?: ProviderFrameIds,
  ): Promise<void> {
    const pending = processState.clientRequests.get(idKey(id));
    if (!pending) {
      throw new Error(
        `Scripted Codex has no pending client request ${String(id)}`,
      );
    }
    const ids = mergeIds(pending.ids, additionalIds, {
      requestId: String(id),
    });
    await this.writeProviderFrame(
      processState,
      envelope,
      'to-canopy',
      `response:${pending.method}`,
      turnKey ?? pending.turnKey,
      ids,
    );
    processState.clientRequests.delete(idKey(id));
  }

  private async handleThreadStart(
    processState: ProcessState,
    method: string,
    id: JsonRpcId,
    params: JsonRecord,
  ): Promise<void> {
    let threadId = readString(params, 'threadId');
    if (!threadId) {
      this.nextThreadNumber += 1;
      threadId = `thread-${this.driverId}-${this.nextThreadNumber}`;
    }
    processState.rootThreadId = threadId;
    if (!this.threadTargets.has(threadId))
      this.threadTargets.set(
        threadId,
        this.nextThreadTargets.shift() ?? this.target,
      );
    const result = threadResult(
      threadId,
      processState.rootThreadId,
      '/tmp/scripted-codex',
    );
    if (method === 'thread/resume' && this.nextResumeConfiguration) {
      const configuration = this.nextResumeConfiguration;
      this.nextResumeConfiguration = undefined;
      const turnId =
        configuration.turnId ?? this.activeTurn?.turnKey ?? this.nextTurnKey();
      const thread = readRecord(result, 'thread');
      if (!thread) throw new Error('Scripted Codex thread result was missing');
      thread.turns = [
        {
          id: turnId,
          items: [],
          status: configuration.status,
          error: null,
        },
      ];
      thread.status =
        configuration.status === 'inProgress'
          ? { type: 'active', activeFlags: [] }
          : { type: 'idle' };
      this.pendingResumedTurn = {
        threadId,
        turnId,
        status: configuration.status,
        startOrder: configuration.startOrder,
      };
    }
    await this.respondToClientRequest(processState, id, result);
    const thread = readRecord(result, 'thread');
    if (thread) {
      await this.sendNotification(processState, 'thread/started', { thread });
    }
    if (method === 'thread/resume') return;
  }

  private async handleThreadRead(
    processState: ProcessState,
    id: JsonRpcId,
    params: JsonRecord,
  ): Promise<void> {
    const threadId =
      readString(params, 'threadId') ?? processState.rootThreadId;
    if (!threadId) {
      throw new Error(
        'Codex requested thread/read before a root thread was ready',
      );
    }
    await this.respondToClientRequest(
      processState,
      id,
      threadResult(threadId, processState.rootThreadId, '/tmp/scripted-codex'),
    );
  }

  private async handleBackgroundTerminalsList(
    processState: ProcessState,
    id: JsonRpcId,
    params: JsonRecord,
  ): Promise<void> {
    const threadId =
      readString(params, 'threadId') ?? processState.rootThreadId;
    const configuration = this.backgroundTerminalsConfigurationFor(threadId);
    if (configuration?.listFailure) {
      await this.respondToClientError(
        processState,
        id,
        configuration.listFailure,
      );
      return;
    }

    if (configuration?.listPages) {
      const cursor = readString(params, 'cursor') ?? null;
      const page = configuration.listPages.find(
        (candidate) => candidate.cursor === cursor,
      );
      if (!page) {
        await this.respondToClientError(processState, id, {
          code: -32602,
          message: `No scripted background terminal page for cursor ${cursor ?? '<initial>'}`,
        });
        return;
      }
      await this.respondToClientRequest(processState, id, {
        data: page.data.map(toJsonSafeBackgroundTerminal),
        nextCursor: page.nextCursor,
      });
      return;
    }

    const data = threadId
      ? Array.from(
          this.backgroundTerminalsByThread.get(threadId)?.values() ?? [],
        )
      : [];
    await this.respondToClientRequest(processState, id, {
      data: data.map(toJsonSafeBackgroundTerminal),
      nextCursor: null,
    });
  }

  private backgroundTerminalsConfigurationFor(
    threadId: string | undefined,
  ): ScriptedCodexBackgroundTerminalsConfiguration | undefined {
    const configuration = this.backgroundTerminalsConfiguration;
    if (
      configuration?.threadId !== undefined &&
      configuration.threadId !== threadId
    ) {
      return undefined;
    }
    return configuration;
  }

  private async handleTurnStart(
    processState: ProcessState,
    id: JsonRpcId,
    params: JsonRecord,
    turn: ScriptedCodexTurn,
    startOrder: ScriptedCodexResumeConfiguration['startOrder'] | undefined,
  ): Promise<void> {
    const threadId =
      readString(params, 'threadId') ?? processState.rootThreadId;
    if (!threadId) {
      throw new Error(
        'Codex requested turn/start before thread/start or thread/resume',
      );
    }
    const pending = processState.clientRequests.get(idKey(id));
    if (pending) {
      pending.turnKey = turn.turnKey;
      pending.ids = mergeIds(pending.ids, { requestId: String(id) });
    }
    const responseIds = mergeIds(pending?.ids, { requestId: String(id) });
    const respond = (): Promise<void> =>
      this.respondToClientRequest(
        processState,
        id,
        {
          turn: {
            id: turn.turnKey,
            items: [],
            status: 'inProgress',
            error: null,
          },
        },
        turn.turnKey,
        responseIds,
      );
    const announceStarted = (): Promise<void> =>
      this.sendNotification(
        processState,
        'turn/started',
        {
          threadId,
          turn: {
            id: turn.turnKey,
            items: [],
            status: 'inProgress',
            error: null,
          },
        },
        turn.turnKey,
        { requestId: String(id) },
      );
    if (startOrder === 'started-first') {
      await announceStarted();
      await respond();
    } else {
      await respond();
      await announceStarted();
    }
    this.enqueueTurn(turn);
  }

  private handleTurnSteer(
    processState: ProcessState,
    id: JsonRpcId,
    params: JsonRecord,
    text: string,
    request: PendingClientRequest,
  ): void {
    const turn = this.turnForParams(params);
    if (!turn) {
      const error = new Error(
        'Codex sent turn/steer without an active scripted turn',
      );
      this.fail(error);
      return;
    }
    request.turnKey = turn.turnKey;
    const ids = mergeIds(request.ids, idsForParams(params));
    request.ids = ids;
    const steer = new ScriptedCodexSteer(
      turn,
      processState,
      id,
      text,
      ids ?? {},
      this,
      readString(params, 'clientUserMessageId'),
    );
    turn.enqueueSteer(steer);
  }

  private handleClientResponse(
    processState: ProcessState,
    frame: JsonRecord,
  ): void {
    const id = readJsonRpcId(frame);
    if (id === undefined) {
      throw new Error('Codex client wrote a JSON-RPC response without an id');
    }
    const pending = processState.serverRequestHistory.get(idKey(id));
    const method = pending?.method ?? 'unknown';
    const ids = mergeIds(
      pending?.ids,
      idsForFrame(frame, readRecord(frame, 'result')),
    );
    this.recordFrame(
      'to-provider',
      `client-response:${method}`,
      pending?.turnKey,
      mergeIds(ids, { requestId: String(id) }),
      undefined,
      this.replayFixture
        ? projectCodexReplayEnvelope(
            frame,
            `response:${method}`,
            this.replayAliases?.project ?? ((): undefined => undefined),
            processState.rootThreadId,
          )
        : undefined,
    );
    if (pending) {
      pending.responded = true;
      processState.serverRequests.delete(idKey(id));
    }
  }

  private async respondToClientRequest(
    processState: ProcessState,
    id: JsonRpcId,
    result: JsonRecord,
    turnKey?: string,
    additionalIds?: ProviderFrameIds,
  ): Promise<void> {
    const pending = processState.clientRequests.get(idKey(id));
    if (!pending) {
      throw new Error(
        `Scripted Codex has no pending client request ${String(id)}`,
      );
    }
    const responseIds = mergeIds(pending.ids, additionalIds, {
      requestId: String(id),
    });
    const frame: JsonRecord = { jsonrpc: '2.0', id, result };
    await this.writeProviderFrame(
      processState,
      frame,
      'to-canopy',
      `response:${pending.method}`,
      turnKey ?? pending.turnKey,
      responseIds,
    );
    processState.clientRequests.delete(idKey(id));
  }

  private async respondToClientError(
    processState: ProcessState,
    id: JsonRpcId,
    error: { code: number; message: string },
  ): Promise<void> {
    const pending = processState.clientRequests.get(idKey(id));
    if (!pending) {
      throw new Error(
        `Scripted Codex has no pending client request ${String(id)}`,
      );
    }
    await this.respondWithEnvelope(processState, id, {
      jsonrpc: '2.0',
      id,
      error: { code: error.code, message: error.message },
    });
  }

  async respondToSteer(
    processState: ProcessState,
    id: JsonRpcId,
    turnKey: string,
    ids: ProviderFrameIds,
    accepted: boolean,
  ): Promise<void> {
    const pending = processState.clientRequests.get(idKey(id));
    if (!pending || pending.method !== 'turn/steer') {
      throw new Error(
        `Scripted Codex steer ${String(id)} is no longer pending`,
      );
    }
    if (accepted) {
      await this.respondToClientRequest(
        processState,
        id,
        {},
        turnKey,
        mergeIds(ids, pending.ids),
      );
      return;
    }
    const frame: JsonRecord = {
      jsonrpc: '2.0',
      id,
      error: { code: -32600, message: 'no active turn to steer' },
    };
    await this.writeProviderFrame(
      processState,
      frame,
      'to-canopy',
      `response:${pending.method}`,
      turnKey,
      mergeIds(ids, pending.ids, { requestId: String(id) }),
    );
    processState.clientRequests.delete(idKey(id));
  }

  private latestProcessState(): ProcessState {
    const state = this.processStates[this.processStates.length - 1];
    if (!state) throw new Error('Codex app-server has not been spawned yet');
    return state;
  }

  rootThreadId(): string | undefined {
    return this.latestProcessState().rootThreadId;
  }

  private findServerRequest(requestId: JsonRpcId):
    | {
        processState: ProcessState;
        request: PendingServerRequest;
        turn?: ScriptedCodexTurn;
      }
    | undefined {
    for (let index = this.processStates.length - 1; index >= 0; index -= 1) {
      const processState = this.processStates[index];
      if (!processState) continue;
      const request = processState.serverRequestHistory.get(idKey(requestId));
      if (!request) continue;
      return {
        processState,
        request,
        ...(request.turnKey && this.turns.get(request.turnKey)
          ? { turn: this.turns.get(request.turnKey) }
          : {}),
      };
    }
    return undefined;
  }

  private throwIfUnavailable(): void {
    if (this.fatalError) throw this.fatalError;
    if (this.disposed)
      throw new Error('Scripted Codex driver has been disposed');
  }

  private fail(error: unknown): void {
    if (this.fatalError) return;
    this.fatalError =
      error instanceof Error
        ? error
        : new Error(`Scripted Codex failed: ${String(error)}`);
    this.turnQueue.close(this.fatalError);
    this.interruptQueue.close(this.fatalError);
    for (const turn of Array.from(this.turns.values()))
      turn.dispose(this.fatalError);
  }
}

class ScriptedCodexTurn implements ScriptedProviderTurn {
  readonly turnKey: string;
  readonly prompt: string;

  private readonly owner: ScriptedCodexImplementation;
  readonly threadId: string;
  readonly processState: ProcessState;
  private readonly steerQueue = new AsyncQueue<ScriptedSteer>();
  private readonly items: JsonRecord[] = [];
  private readonly allSteers = new Set<ScriptedCodexSteer>();
  private readonly toolCalls = new Map<string, ScriptedToolCall>();
  private readonly nativeTasks = new Map<string, ScriptedNativeTask>();
  private lastChildThreadId: string | undefined;
  private frameTail: Promise<void> = Promise.resolve();
  private heldFrames: Promise<void> | undefined;
  private releaseHeldFrames: (() => void) | undefined;
  private messageItem: JsonRecord | undefined;
  private selfStarted = false;
  private completed = false;
  private disposedError: Error | undefined;
  private interrupted = false;

  constructor(options: {
    owner: ScriptedCodexImplementation;
    turnKey: string;
    prompt: string;
    threadId: string;
    processState: ProcessState;
  }) {
    this.owner = options.owner;
    this.turnKey = options.turnKey;
    this.prompt = options.prompt;
    this.threadId = options.threadId;
    this.processState = options.processState;
  }

  emitText(text: string): Promise<void> {
    return this.enqueueFrame(async () => {
      this.assertTurnOpen();
      if (this.selfStarted) {
        if (!this.messageItem) {
          this.messageItem = {
            type: 'agentMessage',
            id: `${this.turnKey}-message-1`,
            text: '',
            phase: 'final_answer',
          };
          this.items.push(this.messageItem);
        }
        const accumulated = readString(this.messageItem, 'text') ?? '';
        this.messageItem.text = `${accumulated}${text}`;
        await this.owner.sendNotification(
          this.processState,
          'item/completed',
          {
            threadId: this.threadId,
            turnId: this.turnKey,
            item: this.messageItem,
          },
          this.turnKey,
          { messageUuid: String(this.messageItem.id) },
        );
        return;
      }
      if (!this.messageItem) {
        this.messageItem = {
          type: 'agentMessage',
          id: `${this.turnKey}-message-1`,
          text: '',
          phase: 'final_answer',
        };
        this.items.push(this.messageItem);
        await this.owner.sendNotification(
          this.processState,
          'item/started',
          {
            threadId: this.threadId,
            turnId: this.turnKey,
            item: this.messageItem,
          },
          this.turnKey,
          { messageUuid: String(this.messageItem.id) },
        );
      }
      const accumulated = readString(this.messageItem, 'text') ?? '';
      this.messageItem.text = `${accumulated}${text}`;
      await this.owner.sendNotification(
        this.processState,
        'item/agentMessage/delta',
        {
          threadId: this.threadId,
          turnId: this.turnKey,
          itemId: this.messageItem.id,
          delta: text,
        },
        this.turnKey,
        { messageUuid: String(this.messageItem.id) },
      );
    });
  }

  emitToolCall(call: {
    callId: string;
    name: string;
    input?: Readonly<Record<string, unknown>>;
    parentCallId?: string;
  }): Promise<void> {
    return this.enqueueFrame(async () => {
      this.assertTurnOpen();
      if (this.toolCalls.has(call.callId)) {
        throw new Error(`Codex tool call ${call.callId} was already scripted`);
      }
      const input = call.input ?? {};
      const item: JsonRecord = {
        type: 'dynamicToolCall',
        id: call.callId,
        namespace: null,
        tool: call.name,
        arguments: input,
        status: 'inProgress',
        contentItems: null,
        success: null,
      };
      this.items.push(item);
      this.toolCalls.set(call.callId, {
        callId: call.callId,
        name: call.name,
        input,
        item,
      });
      const ids: ProviderFrameIds = {
        callId: call.callId,
        toolUseId: call.callId,
      };
      await this.owner.sendNotification(
        this.processState,
        'item/started',
        {
          threadId: this.threadId,
          turnId: this.turnKey,
          item,
        },
        this.turnKey,
        ids,
      );
      const params: JsonRecord = {
        threadId: this.threadId,
        turnId: this.turnKey,
        callId: call.callId,
        namespace: null,
        tool: call.name,
        arguments: input,
        ...(call.parentCallId ? { parentCallId: call.parentCallId } : {}),
      };
      await this.owner.sendServerRequestNow(
        this.processState,
        { method: 'item/tool/call', callId: call.callId, params },
        this,
      );
    });
  }

  emitToolResult(callId: string, output?: string): Promise<void> {
    return this.enqueueFrame(async () => {
      this.assertTurnOpen();
      const call = this.toolCalls.get(callId);
      if (!call) throw new Error(`No scripted Codex tool call ${callId}`);
      call.item.status = 'completed';
      call.item.contentItems =
        output === undefined ? [] : [{ type: 'inputText', text: output }];
      call.item.success = true;
      await this.owner.sendNotification(
        this.processState,
        'item/completed',
        {
          threadId: this.threadId,
          turnId: this.turnKey,
          item: call.item,
        },
        this.turnKey,
        { callId, toolUseId: callId },
      );
    });
  }

  startNativeTask(task: {
    taskId: string;
    toolUseId: string;
    kind: 'agent' | 'shell' | 'monitor' | 'workflow';
  }): Promise<void> {
    return this.enqueueFrame(async () => {
      this.assertTurnOpen();
      if (this.nativeTasks.has(task.taskId)) {
        throw new Error(`Codex native task ${task.taskId} was already started`);
      }
      const item: JsonRecord = {
        type: 'collabAgentToolCall',
        id: task.toolUseId,
        tool: 'spawnAgent',
        status: 'inProgress',
        senderThreadId: this.threadId,
        receiverThreadIds: [task.taskId],
        prompt: `Scripted ${task.kind} task`,
        model: null,
        reasoningEffort: null,
        agentsStates: {
          [task.taskId]: { status: 'running', message: null },
        },
      };
      const childTurnId =
        task.kind === 'agent' ? `${task.taskId}-turn` : undefined;
      this.items.push(item);
      this.nativeTasks.set(task.taskId, {
        taskId: task.taskId,
        toolUseId: task.toolUseId,
        item,
        kind: task.kind,
        ...(childTurnId ? { childTurnId } : {}),
      });
      this.lastChildThreadId = task.taskId;
      await this.owner.sendNotification(
        this.processState,
        'item/started',
        {
          threadId: this.threadId,
          turnId: this.turnKey,
          item,
        },
        this.turnKey,
        { taskId: task.taskId, toolUseId: task.toolUseId },
      );
      if (task.kind === 'agent' && childTurnId) {
        await this.owner.sendNotification(
          this.processState,
          'thread/status/changed',
          {
            threadId: task.taskId,
            status: { type: 'active', activeFlags: [] },
          },
          childTurnId,
          { taskId: task.taskId },
        );
        await this.owner.sendNotification(
          this.processState,
          'turn/started',
          {
            threadId: task.taskId,
            turn: {
              id: childTurnId,
              items: [],
              status: 'inProgress',
              error: null,
            },
          },
          childTurnId,
        );
        const activity = this.makeSubAgentActivityItem(
          task.taskId,
          'started',
          `${task.taskId}-activity-started`,
        );
        this.items.push(activity);
        await this.owner.sendNotification(
          this.processState,
          'item/started',
          {
            threadId: this.threadId,
            turnId: this.turnKey,
            item: activity,
          },
          this.turnKey,
        );
        await this.owner.sendNotification(
          this.processState,
          'item/completed',
          {
            threadId: this.threadId,
            turnId: this.turnKey,
            item: activity,
          },
          this.turnKey,
        );
      }
      // Codex identifies native background work through collab-agent items;
      // the prompt field carries the scripted task kind for protocol clarity.
    });
  }

  endNativeTask(
    taskId: string,
    status: 'completed' | 'stopped' | 'failed' = 'completed',
  ): Promise<void> {
    return this.enqueueFrame(
      async () => {
        this.assertNotDisposed();
        const task = this.nativeTasks.get(taskId);
        if (!task) throw new Error(`No scripted Codex native task ${taskId}`);
        const itemStatus =
          status === 'stopped'
            ? 'interrupted'
            : status === 'failed'
              ? 'failed'
              : 'completed';
        const agentStatus =
          status === 'stopped'
            ? 'interrupted'
            : status === 'failed'
              ? 'errored'
              : 'completed';
        task.item.status = itemStatus;
        task.item.agentsStates = {
          [task.taskId]: { status: agentStatus, message: null },
        };
        if (task.kind === 'agent' && task.childTurnId) {
          await this.owner.sendNotification(
            this.processState,
            'thread/status/changed',
            { threadId: task.taskId, status: { type: 'idle' } },
            task.childTurnId,
            { taskId: task.taskId },
          );
          const childTurnStatus =
            status === 'stopped'
              ? 'interrupted'
              : status === 'failed'
                ? 'failed'
                : 'completed';
          await this.owner.sendNotification(
            this.processState,
            'turn/completed',
            {
              threadId: task.taskId,
              turn: {
                id: task.childTurnId,
                items: [],
                status: childTurnStatus,
                error:
                  childTurnStatus === 'failed'
                    ? { message: 'Scripted Codex child turn failed' }
                    : null,
              },
            },
            task.childTurnId,
          );
          const activity = this.makeSubAgentActivityItem(
            task.taskId,
            'completed',
            `${task.taskId}-activity-completed`,
          );
          this.items.push(activity);
          await this.owner.sendNotification(
            this.processState,
            'item/started',
            {
              threadId: this.threadId,
              turnId: this.turnKey,
              item: activity,
            },
            this.turnKey,
          );
          await this.owner.sendNotification(
            this.processState,
            'item/completed',
            {
              threadId: this.threadId,
              turnId: this.turnKey,
              item: activity,
            },
            this.turnKey,
          );
        }
        await this.owner.sendNotification(
          this.processState,
          'item/completed',
          {
            threadId: this.threadId,
            turnId: this.turnKey,
            item: task.item,
          },
          this.turnKey,
          { taskId, toolUseId: task.toolUseId },
        );
        this.nativeTasks.delete(taskId);
      },
      { allowCompleted: true },
    );
  }

  private makeSubAgentActivityItem(
    agentThreadId: string,
    kind: 'started' | 'completed',
    id: string,
  ): JsonRecord {
    return {
      type: 'subAgentActivity',
      id,
      kind,
      agentThreadId,
      agentPath: '/tmp/scripted-codex/subagent',
    };
  }

  emitError(error: { message: string; willRetry: boolean }): Promise<void> {
    return this.enqueueFrame(async () => {
      this.assertTurnOpen();
      await this.owner.sendNotification(
        this.processState,
        'error',
        {
          error: {
            message: error.message,
            codexErrorInfo: null,
            additionalDetails: null,
            misalignment: null,
          },
          willRetry: error.willRetry,
          threadId: this.threadId,
          turnId: this.turnKey,
        },
        this.turnKey,
      );
    });
  }

  emitThreadStatus(options: {
    status: 'active' | 'waitingOnApproval' | 'idle';
    child?: boolean;
  }): Promise<void> {
    return this.enqueueFrame(async () => {
      this.assertTurnOpen();
      const threadId = options.child ? this.lastChildThreadId : this.threadId;
      if (!threadId) {
        throw new Error(
          'Codex child thread status requires a native task to have been started',
        );
      }
      const status =
        options.status === 'idle'
          ? { type: 'idle' }
          : {
              type: 'active',
              activeFlags:
                options.status === 'waitingOnApproval'
                  ? ['waitingOnApproval']
                  : [],
            };
      await this.owner.sendNotification(
        this.processState,
        'thread/status/changed',
        { threadId, status },
        this.turnKey,
        options.child ? { taskId: threadId } : undefined,
      );
    });
  }

  nextSteer(options?: { timeoutMs?: number }): Promise<ScriptedSteer> {
    if (this.completed) {
      return Promise.reject(
        new Error(
          `Codex turn ${this.turnKey} completed before another steer arrived`,
        ),
      );
    }
    return this.steerQueue.next(
      options?.timeoutMs,
      `a steer for Codex turn ${this.turnKey}`,
    );
  }

  hold(): void {
    if (this.heldFrames) return;
    this.heldFrames = new Promise<void>((resolve) => {
      this.releaseHeldFrames = resolve;
    });
  }

  async release(): Promise<void> {
    const release = this.releaseHeldFrames;
    if (release) {
      this.releaseHeldFrames = undefined;
      this.heldFrames = undefined;
      release();
    }
    await withTimeout(
      this.frameTail,
      DEFAULT_WAIT_TIMEOUT_MS,
      `Codex turn ${this.turnKey} frame release`,
    );
  }

  async complete(result?: { isError?: boolean }): Promise<void> {
    await this.enqueueFrame(async () => {
      this.assertTurnOpen();
      const status = this.interrupted
        ? 'interrupted'
        : result?.isError
          ? 'failed'
          : 'completed';
      const error =
        status === 'failed' ? { message: 'Scripted Codex turn failed' } : null;
      await this.owner.sendNotification(
        this.processState,
        'turn/completed',
        {
          threadId: this.threadId,
          turn: {
            id: this.turnKey,
            items: this.items,
            status,
            error,
          },
        },
        this.turnKey,
      );
      this.completed = true;
      this.steerQueue.close(
        new Error(
          `Codex turn ${this.turnKey} completed before another steer arrived`,
        ),
      );
      this.owner.finishTurn(this);
    });
  }

  async announceSelfStarted(): Promise<void> {
    await this.enqueueFrame(async () => {
      this.assertTurnOpen();
      this.selfStarted = true;
      await this.owner.sendNotification(
        this.processState,
        'turn/started',
        {
          threadId: this.threadId,
          turn: {
            id: this.turnKey,
            items: [],
            status: 'inProgress',
            error: null,
          },
        },
        this.turnKey,
      );
    });
  }

  enqueueSteer(steer: ScriptedCodexSteer): void {
    this.steerQueue.push(steer);
    this.allSteers.add(steer);
  }

  markInterrupted(): void {
    this.interrupted = true;
  }

  markReplayCompleted(): void {
    if (this.completed) return;
    this.completed = true;
    this.steerQueue.close(
      new Error(
        `Codex turn ${this.turnKey} completed before another steer arrived`,
      ),
    );
    this.owner.finishTurn(this);
  }

  isWritableFrom(processState: ProcessState): boolean {
    return (
      this.processState === processState &&
      !this.completed &&
      !this.disposedError &&
      !processState.process.killed &&
      processState.process.exitCode === null
    );
  }

  dispose(error: Error): void {
    this.disposedError = error;
    for (const steer of Array.from(this.allSteers)) steer.cancelLate(error);
    this.steerQueue.close(error);
    const release = this.releaseHeldFrames;
    this.releaseHeldFrames = undefined;
    this.heldFrames = undefined;
    release?.();
  }

  async enqueueFrame(
    operation: () => Promise<void>,
    options: { allowCompleted?: boolean } = {},
  ): Promise<void> {
    const run = this.frameTail.then(async () => {
      this.assertWritable(options.allowCompleted === true);
      const heldFrames = this.heldFrames;
      if (heldFrames) {
        await withTimeout(
          heldFrames,
          MAX_WAIT_TIMEOUT_MS,
          `release of held Codex turn ${this.turnKey} frames`,
        );
      }
      this.assertWritable(options.allowCompleted === true);
      await operation();
    });
    this.frameTail = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private assertTurnOpen(): void {
    this.assertNotDisposed();
    if (this.completed)
      throw new Error(`Codex turn ${this.turnKey} is already complete`);
  }

  private assertNotDisposed(): void {
    if (this.disposedError) throw this.disposedError;
  }

  private assertWritable(allowCompleted: boolean): void {
    this.assertNotDisposed();
    if (!allowCompleted && this.completed) {
      throw new Error(`Codex turn ${this.turnKey} is already complete`);
    }
  }
}

class ScriptedCodexSteer implements ScriptedSteer {
  readonly text: string;
  readonly ids: ProviderFrameIds;

  private readonly turn: ScriptedCodexTurn;
  private readonly processState: ProcessState;
  private readonly requestId: JsonRpcId;
  private readonly owner: ScriptedCodexImplementation;
  private readonly clientUserMessageId: string | undefined;
  private settled = false;
  private lateTimer: ReturnType<typeof setTimeout> | undefined;
  private rejectLate: ((error: Error) => void) | undefined;

  constructor(
    turn: ScriptedCodexTurn,
    processState: ProcessState,
    requestId: JsonRpcId,
    text: string,
    ids: ProviderFrameIds,
    owner: ScriptedCodexImplementation,
    clientUserMessageId: string | undefined,
  ) {
    this.turn = turn;
    this.processState = processState;
    this.requestId = requestId;
    this.text = text;
    this.ids = ids;
    this.owner = owner;
    this.clientUserMessageId = clientUserMessageId;
  }

  acknowledge(): Promise<void> {
    return this.settle(true);
  }

  pickUp(): Promise<void> {
    const clientId = this.clientUserMessageId;
    if (!clientId)
      throw new Error(
        `Codex steer ${String(this.requestId)} carried no clientUserMessageId`,
      );
    return this.turn.enqueueFrame(() =>
      this.owner.sendNotification(
        this.processState,
        'item/completed',
        {
          threadId: this.turn.threadId,
          turnId: this.turn.turnKey,
          item: {
            type: 'userMessage',
            id: `${this.turn.turnKey}-steer-${String(this.requestId)}`,
            clientId,
            content: [{ type: 'text', text: this.text, text_elements: [] }],
          },
        },
        this.turn.turnKey,
        this.ids,
      ),
    );
  }

  refuse(): Promise<void> {
    return this.settle(false);
  }

  async acknowledgeLate(delayMs: number): Promise<void> {
    if (
      !Number.isInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > MAX_WAIT_TIMEOUT_MS
    )
      throw new Error(
        `Late Codex steer delay must be between 0 and ${MAX_WAIT_TIMEOUT_MS}ms`,
      );
    if (this.settled || this.lateTimer !== undefined)
      throw new Error(
        `Codex steer ${String(this.requestId)} is already scheduled or settled`,
      );
    await new Promise<void>((resolve, reject) => {
      this.rejectLate = reject;
      this.lateTimer = setTimeout(() => {
        this.lateTimer = undefined;
        this.rejectLate = undefined;
        resolve();
      }, delayMs);
    });
    await this.acknowledge();
  }

  cancelLate(error: Error): void {
    if (this.lateTimer === undefined) return;
    clearTimeout(this.lateTimer);
    this.lateTimer = undefined;
    this.rejectLate?.(error);
    this.rejectLate = undefined;
  }

  private async settle(accepted: boolean): Promise<void> {
    if (this.settled) {
      throw new Error(
        `Codex steer ${String(this.requestId)} was already settled`,
      );
    }
    this.cancelLate(
      new Error(`Codex steer ${String(this.requestId)} settled directly`),
    );
    await this.turn.enqueueFrame(
      async () => {
        if (this.settled) {
          throw new Error(
            `Codex steer ${String(this.requestId)} was already settled`,
          );
        }
        await this.owner.respondToSteer(
          this.processState,
          this.requestId,
          this.turn.turnKey,
          this.ids,
          accepted,
        );
        this.settled = true;
      },
      { allowCompleted: true },
    );
  }
}

function boundedTimeout(
  timeoutMs: number | undefined,
  description: string,
): number {
  const timeout = timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  if (
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    timeout > MAX_WAIT_TIMEOUT_MS
  ) {
    throw new Error(
      `${description} timeout must be between 1 and ${MAX_WAIT_TIMEOUT_MS}ms; received ${String(timeout)}`,
    );
  }
  return Math.ceil(timeout);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  const timeout = boundedTimeout(timeoutMs, description);
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(`Timed out after ${timeout}ms waiting for ${description}`),
      );
    }, timeout);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNullableFiniteNumber(
  record: JsonRecord,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toJsonSafeBackgroundTerminal(
  terminal: ScriptedCodexBackgroundTerminal,
): ScriptedCodexBackgroundTerminal {
  return {
    itemId: terminal.itemId,
    processId: terminal.processId,
    command: terminal.command,
    cwd: terminal.cwd,
    osPid: jsonSafeNullableNumber(terminal.osPid),
    cpuPercent: jsonSafeNullableNumber(terminal.cpuPercent),
    rssKb: jsonSafeNullableNumber(terminal.rssKb),
  };
}

function jsonSafeNullableNumber(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function readJsonRpcId(frame: JsonRecord): JsonRpcId | undefined {
  const value = frame.id;
  return typeof value === 'string' || typeof value === 'number'
    ? value
    : undefined;
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function readArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function inputText(params: JsonRecord): string {
  const input = readArray(params.input);
  if (!input) return '';
  const text: string[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const nextText = readString(item, 'text');
    if (nextText !== undefined) text.push(nextText);
  }
  return text.join('');
}

function idsForFrame(
  frame: JsonRecord,
  params?: JsonRecord,
): ProviderFrameIds | undefined {
  const id = readJsonRpcId(frame);
  const ids: ProviderFrameIds = {};
  if (id !== undefined) ids.requestId = String(id);
  const fromParams = params ? idsForParams(params) : undefined;
  return mergeIds(ids, fromParams);
}

function idsForParams(params: JsonRecord): ProviderFrameIds | undefined {
  const ids: ProviderFrameIds = {};
  const messageUuid =
    readString(params, 'clientUserMessageId') ??
    readString(params, 'messageUuid') ??
    readString(params, 'itemId');
  const callId = readString(params, 'callId');
  const taskId =
    readString(params, 'taskId') ??
    readString(params, 'agentThreadId') ??
    firstString(readArray(params.receiverThreadIds));
  const toolUseId = readString(params, 'toolUseId');
  if (messageUuid !== undefined) ids.messageUuid = messageUuid;
  if (callId !== undefined) ids.callId = callId;
  if (taskId !== undefined) ids.taskId = taskId;
  if (toolUseId !== undefined) ids.toolUseId = toolUseId;

  const item = readRecord(params, 'item');
  if (item) {
    const itemId = readString(item, 'id');
    const itemType = readString(item, 'type');
    if (
      itemId &&
      (itemType === 'agentMessage' || itemType === 'agent_message')
    ) {
      ids.messageUuid = itemId;
    } else if (
      itemId &&
      (itemType === 'commandExecution' ||
        itemType === 'command_execution' ||
        itemType === 'collabAgentToolCall' ||
        itemType === 'collab_agent_tool_call')
    ) {
      ids.toolUseId = itemId;
    } else if (
      itemId &&
      (itemType === 'dynamicToolCall' || itemType === 'dynamic_tool_call')
    ) {
      ids.callId = itemId;
      ids.toolUseId = itemId;
    }
    const agentThreadId =
      readString(item, 'agentThreadId') ?? readString(item, 'agent_thread_id');
    if (agentThreadId) ids.taskId = agentThreadId;
    const receiverThreadIds =
      readArray(item.receiverThreadIds) ?? readArray(item.receiver_thread_ids);
    const receiverThreadId = firstString(receiverThreadIds);
    if (receiverThreadId) ids.taskId = receiverThreadId;
  }

  return Object.keys(ids).length > 0 ? ids : undefined;
}

function mergeIds(
  ...sources: Array<ProviderFrameIds | undefined>
): ProviderFrameIds | undefined {
  const merged: ProviderFrameIds = {};
  for (const source of sources) {
    if (!source) continue;
    if (source.messageUuid !== undefined)
      merged.messageUuid = source.messageUuid;
    if (source.callId !== undefined) merged.callId = source.callId;
    if (source.requestId !== undefined) merged.requestId = source.requestId;
    if (source.taskId !== undefined) merged.taskId = source.taskId;
    if (source.toolUseId !== undefined) merged.toolUseId = source.toolUseId;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function replayTypeFromTrace(type: string): string | undefined {
  if (/^(notification|request|response):.+$/.test(type)) return type;
  const clientRequest = /^client:(.+)$/.exec(type);
  if (clientRequest?.[1]) return `request:${clientRequest[1]}`;
  const clientResponse = /^client-response:(.+)$/.exec(type);
  if (clientResponse?.[1]) return `response:${clientResponse[1]}`;
  return undefined;
}

function lifecycleIdsForClientRequest(
  id: JsonRpcId,
  method: string,
  params: JsonRecord,
  turnKey?: string,
): LifecycleIds {
  const ids: LifecycleIds = { request: String(id) };
  const threadId = readString(params, 'threadId');
  const turnId = turnKey ?? readString(params, 'turnId');
  const messageId = readString(params, 'clientUserMessageId');
  const item = readRecord(params, 'item');
  const itemId = item ? readString(item, 'id') : readString(params, 'itemId');
  const taskId = readString(params, 'taskId');
  const callId = readString(params, 'callId');
  const toolUseId = readString(params, 'toolUseId');
  if (threadId) ids.thread = threadId;
  if (turnId) ids.turn = turnId;
  if (messageId) ids.message = messageId;
  if (itemId) ids.item = itemId;
  if (taskId) ids.task = taskId;
  if (callId) ids.call = callId;
  if (toolUseId) ids.toolUse = toolUseId;
  if (method === 'thread/start' && threadId) ids.thread = threadId;
  return ids;
}

function providerIdsFromLifecycleIds(
  ids: LifecycleIds,
): ProviderFrameIds | undefined {
  const providerIds: ProviderFrameIds = {};
  if (ids.message) providerIds.messageUuid = ids.message;
  if (ids.call) providerIds.callId = ids.call;
  if (ids.request) providerIds.requestId = ids.request;
  if (ids.task) providerIds.taskId = ids.task;
  if (ids.toolUse) providerIds.toolUseId = ids.toolUse;
  return Object.keys(providerIds).length > 0 ? providerIds : undefined;
}

function firstString(
  values: readonly unknown[] | undefined,
): string | undefined {
  if (!values) return undefined;
  for (const value of values) {
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function threadResult(
  threadId: string,
  rootThreadId: string | undefined,
  cwd: string,
): JsonRecord {
  const isSubagent = rootThreadId !== undefined && rootThreadId !== threadId;
  const source = isSubagent
    ? {
        subagent: {
          thread_spawn: {
            parent_thread_id: rootThreadId,
            depth: 1,
            agent_path: null,
            agent_nickname: 'Scripted agent',
            agent_role: 'test worker',
          },
        },
      }
    : 'vscode';
  return {
    thread: {
      id: threadId,
      preview: '',
      ephemeral: false,
      modelProvider: 'openai',
      model: 'gpt-6-sol',
      reasoningEffort: 'high',
      createdAt: 1,
      updatedAt: 1,
      status: { type: 'idle' },
      path: null,
      cwd,
      cliVersion: 'scripted',
      source,
      parentThreadId: isSubagent ? rootThreadId : null,
      agentNickname: isSubagent ? 'Scripted agent' : null,
      agentRole: isSubagent ? 'test worker' : null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: 'gpt-6-sol',
    modelProvider: 'openai',
    serviceTier: null,
  };
}
