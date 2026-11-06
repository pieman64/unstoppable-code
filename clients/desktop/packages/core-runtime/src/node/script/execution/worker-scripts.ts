import {
  redeemExecutionSecrets,
  type ExecutionSecretSource,
  type RedeemedExecutionSecrets,
} from '../../execution-secrets';
import type {
  CanopyInstructionHandler,
  CanopyQueryHandler,
  WorkerScriptContext,
  WorkerScriptExecuteParams,
  WorkerScriptExecuteResult,
  WorkerScriptExecutionCancelParams,
  WorkerScriptExecutionCancelResult,
  WorkerScriptExecutionGetParams,
  WorkerScriptExecutionGetResult,
  WorkerScriptExecutionListParams,
  WorkerScriptExecutionListResult,
} from '@canopy/protocol/canopy-core';

import { KeyedOutcomes } from '../../operations/keyed-outcomes';

import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyHandlerContext } from '../../../runtime/types';
import type { RunLogFiles } from './run-log-files';
import {
  runScriptProcess,
  type RunScriptProcessOptions,
  type ScriptProcessHost,
  type ScriptProcessOutcome,
} from './process-runner';
import {
  runScriptTerminal,
  type RunScriptTerminalOptions,
  type ScriptTerminalHost,
  type ScriptTerminalPort,
} from './terminal-runner';
import {
  ScriptRunRegistry,
  type ScriptProcessResult,
  type StoppedScriptRun,
} from './run-registry';
import {
  ScriptRunLogStore,
  toWorkerScriptExecution,
  type ScriptRunLogPaths,
  type ScriptRunLogRef,
  type ScriptRunWriterFence,
} from './script-run-log';

/** Where a run executes and the environment it gets, on this worker. */
export interface ScriptExecutionPlace {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * The trusted host side of `worker.script.*`: process effects, the run-log
 * location and durability, and the projection of a portable scope and
 * context onto this worker's checkouts and environment.
 */
export interface ScriptExecutionWorkerHost
  extends ScriptProcessHost, Pick<ScriptTerminalHost, 'revealTerminal'> {
  readonly secrets: ExecutionSecretSource;
  readonly authorityId: string;
  readonly targetId?: string;
  readonly logPaths: ScriptRunLogPaths;
  readonly logFiles: RunLogFiles;
  readonly writerFence?: ScriptRunWriterFence;
  /**
   * The checkout and environment a context names. Throws
   * {@link scriptContextUnavailableError} when it does not exist here.
   */
  resolvePlace(
    scope: WorkerScriptExecuteParams['scope'],
    context: WorkerScriptContext,
    secrets: RedeemedExecutionSecrets,
  ): Promise<ScriptExecutionPlace>;
  /**
   * This worker's `worker.terminal` port, for runs that need a terminal
   * (CAN-5082). Loaded on first use so ordinary runs never load the PTY
   * backend; a host without terminals refuses those runs.
   */
  terminals?(): Promise<ScriptTerminalPort>;
  warn?(message: string, details: Record<string, unknown>): void;
}

/**
 * What an in-process caller sees of a run while it executes. The daemon
 * carries none of this until CAN-5087; its clients read the run log.
 */
export interface ScriptExecutionObserver {
  onProcessStarted?(): void;
  onLines?(lines: string[]): void;
  onData?(chunk: Buffer, stream: 'stdout' | 'stderr'): void;
  onFinished?(result: ScriptProcessOutcome): void;
}

export function scriptContextUnavailableError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.script.contextUnavailable',
    message: 'The checkout this script runs in is unavailable.',
    retry: { kind: 'never' },
  });
}

function executionInProgressError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'conflict',
    code: 'worker.script.executionInProgress',
    message: 'A run with this execution id is already running.',
    retry: { kind: 'never' },
  });
}

function terminalUnavailableError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'capability_unavailable',
    message: 'This worker cannot run scripts in a terminal.',
    retry: { kind: 'never' },
  });
}

function idempotencyKeyReusedError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'conflict',
    code: 'worker.script.idempotencyKeyReused',
    message: 'This idempotency key was used with other parameters.',
    retry: { kind: 'never' },
  });
}

function toExecuteResult(
  executionId: string,
  outcome: ScriptProcessResult &
    Partial<Pick<ScriptProcessOutcome, 'outputBytes' | 'outputTruncated'>>,
  recorded: boolean,
): WorkerScriptExecuteResult {
  return {
    executionId,
    status: outcome.success
      ? 'success'
      : outcome.exitCode === null && !outcome.timedOut
        ? 'cancelled'
        : 'failed',
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    durationMs: Math.max(0, Math.round(outcome.durationMs)),
    outputBytes:
      outcome.outputBytes ?? Buffer.byteLength(outcome.output, 'utf8'),
    outputTruncated: outcome.outputTruncated ?? false,
    recorded,
  };
}

/**
 * The worker side of script execution (CAN-4143): the process runner, the
 * registry of running scripts, and the durable run log, behind
 * `worker.script.*`. Interactive runs execute in the worker's own terminals
 * (CAN-5082); hook commands (CAN-4146) run here without a dispatch record
 * and join the same registry.
 */
export class ScriptExecutionWorker {
  readonly registry = new ScriptRunRegistry();
  readonly logs: ScriptRunLogStore;
  private readonly observers = new Map<string, Set<ScriptExecutionObserver>>();
  private readonly executing = new Set<string>();
  /**
   * Logged runs between their dispatch and their process's start, so a stop
   * in that window cancels them before anything is spawned.
   */
  private readonly starting = new Map<
    string,
    {
      projectId: string;
      worktreeId: string;
      scriptKey: string;
      stop: AbortController;
      settled: Promise<WorkerScriptExecuteResult | null>;
    }
  >();

  constructor(private readonly host: ScriptExecutionWorkerHost) {
    this.logs = new ScriptRunLogStore({
      paths: host.logPaths,
      files: host.logFiles,
      ...(host.warn ? { warn: host.warn.bind(host) } : {}),
      ...(host.writerFence ? { writerFence: host.writerFence } : {}),
    });
  }

  /** Observe a run by its execution id; register before executing it. */
  observe(executionId: string, observer: ScriptExecutionObserver): () => void {
    let set = this.observers.get(executionId);
    if (!set) {
      set = new Set();
      this.observers.set(executionId, set);
    }
    set.add(observer);
    return (): void => {
      const current = this.observers.get(executionId);
      current?.delete(observer);
      if (current?.size === 0) this.observers.delete(executionId);
    };
  }

  private observesLines(executionId: string): boolean {
    return Array.from(this.observers.get(executionId) ?? []).some(
      (observer) => observer.onLines !== undefined,
    );
  }

  private notify(
    executionId: string,
    each: (observer: ScriptExecutionObserver) => void,
  ): void {
    for (const observer of Array.from(this.observers.get(executionId) ?? []))
      try {
        each(observer);
      } catch (error) {
        this.host.warn?.('[worker-scripts] A run observer failed', {
          error: error instanceof Error ? error.name : 'unknown error',
        });
      }
  }

  /**
   * Run a process on this worker without a run log or dispatch record: the
   * hook runner's commands until CAN-4146 moves them.
   */
  runProcess(options: RunScriptProcessOptions): Promise<ScriptProcessOutcome> {
    return runScriptProcess(this.host, this.registry, options);
  }

  /**
   * Run a command in one of this worker's terminals without a run log or
   * dispatch record: the hook runner's interactive commands until CAN-4146
   * moves them. Refuses when the host has no terminals.
   */
  runTerminal(
    options: RunScriptTerminalOptions,
  ): Promise<ScriptProcessOutcome> {
    const host = this.host;
    if (!host.terminals) return Promise.reject(terminalUnavailableError());
    return runScriptTerminal(
      host,
      () => host.terminals?.() ?? Promise.reject(terminalUnavailableError()),
      this.registry,
      options,
    );
  }

  private assertServed(scope: {
    readonly authorityId?: string;
    readonly targetId?: string;
  }): void {
    if (
      (scope.authorityId !== undefined &&
        scope.authorityId !== this.host.authorityId) ||
      (scope.targetId !== undefined && scope.targetId !== this.host.targetId)
    )
      throw new CanopyOperationError({
        kind: 'capability_unavailable',
        message: 'The selected script authority or target is unavailable.',
        retry: { kind: 'never' },
      });
  }

  async execute(
    params: WorkerScriptExecuteParams,
    signal?: AbortSignal,
  ): Promise<WorkerScriptExecuteResult> {
    this.assertServed(params.scope);
    if (params.terminal && !this.host.terminals)
      throw terminalUnavailableError();
    const { executionId, scope, record } = params;
    if (this.executing.has(executionId)) throw executionInProgressError();
    this.executing.add(executionId);
    const stop = new AbortController();
    const forward = (): void => stop.abort();
    if (signal?.aborted) stop.abort();
    else signal?.addEventListener('abort', forward, { once: true });
    const settle: { done: (result: WorkerScriptExecuteResult | null) => void } =
      { done: (): void => undefined };
    if (
      record !== undefined &&
      scope.workspaceId !== undefined &&
      scope.worktreeId !== undefined
    )
      this.starting.set(executionId, {
        projectId: scope.workspaceId,
        worktreeId: scope.worktreeId,
        scriptKey: record.script.scriptKey,
        stop,
        settled: new Promise((resolve) => {
          settle.done = resolve;
        }),
      });
    let result: WorkerScriptExecuteResult | null = null;
    try {
      result = await this.start(params, stop.signal);
      return result;
    } finally {
      signal?.removeEventListener('abort', forward);
      this.starting.delete(executionId);
      this.executing.delete(executionId);
      settle.done(result);
    }
  }

  private async start(
    params: WorkerScriptExecuteParams,
    signal: AbortSignal,
  ): Promise<WorkerScriptExecuteResult> {
    const { executionId, scope, record } = params;
    const secrets = await redeemExecutionSecrets(
      this.host.secrets,
      { operation: 'worker.script.execute', key: executionId },
      params.secrets,
      signal,
    );
    const place = await this.host.resolvePlace(scope, params.context, secrets);
    const projectId = scope.workspaceId;
    const worktreeId = scope.worktreeId;
    const logged =
      record !== undefined &&
      projectId !== undefined &&
      worktreeId !== undefined;
    // The host's fences refuse a start before its log is written.
    if (logged) this.host.assertStartAllowed?.(projectId, worktreeId);
    let ref: ScriptRunLogRef | null = null;
    if (logged)
      ref = await this.logs
        .start({
          projectId,
          worktreeId,
          script: record.script,
          invocation: record.invocation,
          runId: executionId,
        })
        .catch(() => null);
    let appending: Promise<void> = Promise.resolve();
    let outcome: ScriptProcessOutcome;
    if (signal.aborted) {
      // Stopped while it was starting: nothing is spawned.
      outcome = {
        success: false,
        exitCode: null,
        output: '',
        timedOut: false,
        durationMs: 0,
        outputBytes: 0,
        outputTruncated: false,
        failure: null,
      };
      const recorded =
        ref !== null &&
        (await this.logs.complete({ ref, response: outcome }).then(
          () => true,
          () => false,
        ));
      this.notify(executionId, (observer) => observer.onFinished?.(outcome));
      return toExecuteResult(executionId, outcome, recorded);
    }
    // Lines are buffered only for a run log or a line observer: an If
    // Command gate reads raw output and keeps its own cap.
    const onChunk =
      ref !== null || this.observesLines(executionId)
        ? (lines: string[]): void => {
            const logRef = ref;
            if (logRef)
              appending = appending
                .then(() => this.logs.append({ ref: logRef, lines }))
                .catch(() => undefined);
            this.notify(executionId, (observer) => observer.onLines?.(lines));
          }
        : undefined;
    const onProcessStarted = (): void => {
      // The registry reaches it from here on.
      this.starting.delete(executionId);
      this.notify(executionId, (observer) => observer.onProcessStarted?.());
    };
    const tracking = logged
      ? {
          projectId,
          worktreeId,
          scriptKey: record.script.scriptKey,
          runId: executionId,
          script: record.script,
          invocation: record.invocation,
          ...(ref ? { logRef: ref } : {}),
        }
      : undefined;
    try {
      outcome = params.terminal
        ? await this.runTerminal({
            script: params.command,
            cwd: place.cwd,
            env: place.env,
            ...(params.shell ? { shell: params.shell } : {}),
            shellStartup: params.shellStartup,
            timeoutMs: params.timeoutMs,
            backgroundPriority: params.priority === 'background',
            signal,
            ...(params.terminal.title !== undefined
              ? { title: params.terminal.title }
              : {}),
            ...(onChunk ? { onChunk } : {}),
            onProcessStarted,
            ...(tracking ? { tracking } : {}),
          })
        : await this.runProcess({
            script: params.command,
            cwd: place.cwd,
            env: place.env,
            ...(params.shell ? { shell: params.shell } : {}),
            shellStartup: params.shellStartup,
            timeoutMs: params.timeoutMs,
            backgroundPriority: params.priority === 'background',
            signal,
            ...(onChunk ? { onChunk } : {}),
            onData: (chunk, stream): void => {
              this.notify(executionId, (observer) =>
                observer.onData?.(chunk, stream),
              );
            },
            onProcessStarted,
            ...(tracking ? { tracking } : {}),
          });
    } catch (error) {
      // A start refused after the log began still closes the log.
      const logRef = ref;
      if (logRef) {
        await appending;
        const message = error instanceof Error ? error.message : String(error);
        await this.logs
          .append({ ref: logRef, lines: message.split('\n') })
          .catch(() => undefined);
        await this.logs
          .complete({
            ref: logRef,
            response: {
              success: false,
              exitCode: 1,
              timedOut: false,
              durationMs: 0,
            },
          })
          .catch(() => undefined);
      }
      throw error;
    }
    let recorded = ref !== null;
    if (ref) {
      await appending;
      recorded = await this.logs.complete({ ref, response: outcome }).then(
        () => true,
        () => false,
      );
    }
    this.notify(executionId, (observer) => observer.onFinished?.(outcome));
    return toExecuteResult(executionId, outcome, recorded);
  }

  async cancel(
    params: WorkerScriptExecutionCancelParams,
  ): Promise<WorkerScriptExecutionCancelResult> {
    this.assertServed(params.scope);
    const target = {
      projectId: params.scope.workspaceId,
      worktreeId: params.scope.worktreeId,
      scriptKey: params.scriptKey,
    };
    const starting = Array.from(this.starting.entries()).filter(
      ([executionId, run]) =>
        run.projectId === target.projectId &&
        run.worktreeId === target.worktreeId &&
        run.scriptKey === target.scriptKey &&
        (params.executionId === undefined ||
          params.executionId === executionId),
    );
    starting.forEach(([, run]) => run.stop.abort());
    const [stopped, started] = await Promise.all([
      params.executionId === undefined
        ? this.registry.stopEach(target)
        : this.registry
            .stopRun({ ...target, runId: params.executionId })
            .then((run): StoppedScriptRun[] => (run ? [run] : [])),
      Promise.all(starting.map(([, run]) => run.settled)),
    ]);
    const reported = new Set<string>();
    return {
      stopped: [
        ...stopped.flatMap(({ response, tracking }) => {
          const executionId = tracking?.runId ?? tracking?.logRef?.runId;
          return executionId === undefined
            ? []
            : [
                toExecuteResult(
                  executionId,
                  response,
                  tracking?.logRef !== undefined,
                ),
              ];
        }),
        ...started.flatMap((result) => (result ? [result] : [])),
      ].filter((result) => {
        if (reported.has(result.executionId)) return false;
        reported.add(result.executionId);
        return true;
      }),
    };
  }

  async get(
    params: WorkerScriptExecutionGetParams,
  ): Promise<WorkerScriptExecutionGetResult> {
    this.assertServed(params.scope);
    const { meta, lines } = await this.logs.readTail({
      projectId: params.scope.workspaceId,
      worktreeId: params.scope.worktreeId,
      scriptKey: params.scriptKey,
      maxLines: params.tailLines ?? 0,
    });
    return {
      run: meta ? { execution: toWorkerScriptExecution(meta), lines } : null,
    };
  }

  async list(
    params: WorkerScriptExecutionListParams,
  ): Promise<WorkerScriptExecutionListResult> {
    this.assertServed(params.scope);
    const runs = await this.logs.listTails({
      projectId: params.scope.workspaceId,
      worktreeId: params.scope.worktreeId,
      maxLines: params.tailLines ?? 0,
    });
    return {
      runs: runs.map(({ meta, lines }) => ({
        execution: toWorkerScriptExecution(meta),
        lines,
      })),
    };
  }
}

export interface WorkerScriptHandlers {
  queries: {
    'worker.script.execution.get': CanopyQueryHandler<
      'worker.script.execution.get',
      CanopyHandlerContext
    >;
    'worker.script.execution.list': CanopyQueryHandler<
      'worker.script.execution.list',
      CanopyHandlerContext
    >;
  };
  instructions: {
    'worker.script.execute': CanopyInstructionHandler<
      'worker.script.execute',
      CanopyHandlerContext
    >;
    'worker.script.execution.cancel': CanopyInstructionHandler<
      'worker.script.execution.cancel',
      CanopyHandlerContext
    >;
  };
}

/** The `worker.script.*` handlers over one worker's script execution. */
export function createWorkerScriptHandlers(
  worker: ScriptExecutionWorker,
): WorkerScriptHandlers {
  const executions = new KeyedOutcomes<WorkerScriptExecuteResult>({
    reusedError: idempotencyKeyReusedError,
  });
  const cancellations = new KeyedOutcomes<WorkerScriptExecutionCancelResult>({
    reusedError: idempotencyKeyReusedError,
  });
  return {
    queries: {
      'worker.script.execution.get': (params) => worker.get(params),
      'worker.script.execution.list': (params) => worker.list(params),
    },
    instructions: {
      // The run belongs to the request that started it: its abort (a
      // cancelled dispatch, or the caller's cancellation) stops the process.
      'worker.script.execute': (params, context) =>
        executions.run(context, params, () =>
          worker.execute(params, context.signal),
        ),
      'worker.script.execution.cancel': (params, context) =>
        cancellations.run(context, params, () => worker.cancel(params)),
    },
  };
}
