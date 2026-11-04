import { randomUUID } from 'node:crypto';
import type { ScriptProcessOutcome } from '@canopy/core-runtime/node/script/execution';
import { CanopyOperationError } from '@canopy/core-runtime';
import type {
  CanopyCallerDescriptor,
  DelegationSecretFingerprint,
  OperationOrigin,
  WorkerScriptContext,
  WorkerScriptExecuteParams,
  WorkerScriptExecutionCancelResult,
  WorkerScriptExecutionGetResult,
  WorkerScriptExecutionListResult,
} from '@canopy/protocol/canopy-core';
import { WORKER_SCRIPT_GRANTS } from '@canopy/protocol/canopy-core';
import type {
  ScriptDescriptor,
  ScriptRunResponse,
  ScriptStartedEvent,
} from '@canopy/desktop-shared/types';
import type { CommandShellDefinition } from '@canopy/desktop-shared/scripts';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import type { ScriptRunLogRef } from './script-log-store';
import { mkdir } from 'node:fs/promises';
import { getEnhancedEnv } from '../pipelines/config-paths';
import { getAppAdvisorHomeDir } from './paths';
import { desktopScriptWorker, scriptTimeoutMs } from './script-runner';
import { assertWorkspaceTargetRuntimeStartAllowed } from './workspace-target-exclusion';

/*
 * Electron main's callers of script execution (CAN-4143). A run is a
 * `core.script.run` operation whose `worker.script.execute` dispatch runs on
 * the local worker; stops and log reads go through `worker.script.*` on the
 * dispatcher. Interactive scripts run the same way, in a terminal the
 * worker owns for the worktree (CAN-5082).
 */

/** The trusted core caller the desktop's script callers act as. */
const SCRIPT_CALLER: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'desktop-core',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [WORKER_SCRIPT_GRANTS.read, WORKER_SCRIPT_GRANTS.execute],
};

export type ScriptInvocation = ScriptStartedEvent['invocation'];

export interface DesktopScriptRun {
  projectId: string;
  worktreeId: string;
  /** Where in the worktree it runs; the worker projects it to a checkout. */
  context: WorkerScriptContext;
  script: ScriptDescriptor;
  invocation: ScriptInvocation;
  command: string;
  shell?: CommandShellDefinition;
  /** Null runs without a timeout. Interactive runs never time out. */
  timeoutSeconds: number | null;
  interactive: boolean;
  backgroundPriority?: boolean;
  /** Names the run; minted when omitted. */
  runId?: string;
  origin?: OperationOrigin;
  /** Fingerprints of the secrets the run's environment holds. */
  secrets?: readonly DelegationSecretFingerprint[];
}

export interface DesktopScriptRunObserver {
  /** The process started; a launch failure finishes without it. */
  onProcessStarted?(): void;
  onLines?(lines: string[]): void;
}

export interface DesktopScriptRunOutcome {
  runId: string;
  /** The run log the worker writes, or null when it could not start one. */
  logRef: ScriptRunLogRef | null;
  response: ScriptRunResponse;
}

function defaultOrigin(invocation: ScriptInvocation): OperationOrigin {
  return invocation === 'manual-run' || invocation === 'manual-lifecycle'
    ? { kind: 'client', sourceId: 'desktop' }
    : { kind: 'system', sourceId: 'worktree-lifecycle' };
}

function toResponse(
  outcome: Pick<
    ScriptProcessOutcome,
    'success' | 'exitCode' | 'output' | 'timedOut' | 'durationMs'
  >,
): ScriptRunResponse {
  return {
    success: outcome.success,
    exitCode: outcome.exitCode,
    output: outcome.output,
    timedOut: outcome.timedOut,
    durationMs: outcome.durationMs,
  };
}

/**
 * Run a script and keep it in the worktree's run log. Resolves once it ends;
 * a stop or cancellation resolves as cancelled. Throws only when the worker
 * could not run it at all, or when the host's worktree fences refuse it.
 */
export async function runDesktopScript(
  run: DesktopScriptRun,
  options: { signal?: AbortSignal; observer?: DesktopScriptRunObserver } = {},
): Promise<DesktopScriptRunOutcome> {
  const runId = run.runId ?? randomUUID();
  // The host's worktree fences refuse a start before anything is recorded.
  assertWorkspaceTargetRuntimeStartAllowed(run.projectId, run.worktreeId);
  const capture: { finished: ScriptProcessOutcome | null } = {
    finished: null,
  };
  const params: WorkerScriptExecuteParams = {
    scope: { workspaceId: run.projectId, worktreeId: run.worktreeId },
    executionId: runId,
    context: run.context,
    command: run.command,
    ...(run.shell ? { shell: run.shell } : {}),
    shellStartup: 'interactive',
    timeoutMs: run.interactive ? null : scriptTimeoutMs(run.timeoutSeconds),
    priority: run.backgroundPriority === true ? 'background' : 'normal',
    ...(run.interactive ? { terminal: {} } : {}),
    record: { script: run.script, invocation: run.invocation },
  };
  const outcome = await getActiveDesktopRuntime().scriptRuns.run(
    {
      params,
      origin: run.origin ?? defaultOrigin(run.invocation),
      owner: { kind: 'system', id: LOCAL_DESKTOP_AUTHORITY_ID },
      ...(run.secrets ? { secrets: run.secrets } : {}),
    },
    {
      ...(options.signal ? { signal: options.signal } : {}),
      observer: {
        onProcessStarted: () => options.observer?.onProcessStarted?.(),
        onLines: (lines) => options.observer?.onLines?.(lines),
        onFinished: (result) => {
          capture.finished = result;
        },
      },
    },
  );
  const finished = capture.finished;
  const logRef: ScriptRunLogRef = {
    projectId: run.projectId,
    worktreeId: run.worktreeId,
    script: run.script,
    runId,
  };
  if (outcome.status === 'failed')
    throw new CanopyOperationError(
      outcome.error ?? {
        kind: 'internal',
        message: 'The script could not run.',
        retry: { kind: 'never' },
      },
    );
  const recorded = outcome.status === 'completed' && outcome.result.recorded;
  const response: ScriptRunResponse = finished
    ? toResponse(finished)
    : {
        success: false,
        exitCode: null,
        output: '',
        timedOut: false,
        durationMs:
          outcome.status === 'completed' ? outcome.result.durationMs : 0,
      };
  return {
    runId,
    logRef: recorded || outcome.status === 'cancelled' ? logRef : null,
    response,
  };
}

const scope = (
  projectId: string,
  worktreeId: string,
): { workspaceId: string; worktreeId: string } => ({
  workspaceId: projectId,
  worktreeId,
});

/** A script key's latest run in the worktree's log, with its last lines. */
export function readScriptRun(request: {
  projectId: string;
  worktreeId: string;
  scriptKey: string;
  tailLines: number;
}): Promise<WorkerScriptExecutionGetResult> {
  return getActiveDesktopRuntime().query(
    'worker.script.execution.get',
    {
      scope: scope(request.projectId, request.worktreeId),
      scriptKey: request.scriptKey,
      tailLines: request.tailLines,
    },
    { caller: SCRIPT_CALLER },
  );
}

/** Each script key's latest run in the worktree's log. */
export function listScriptRuns(request: {
  projectId: string;
  worktreeId: string;
  tailLines: number;
}): Promise<WorkerScriptExecutionListResult> {
  return getActiveDesktopRuntime().query(
    'worker.script.execution.list',
    {
      scope: scope(request.projectId, request.worktreeId),
      tailLines: request.tailLines,
    },
    { caller: SCRIPT_CALLER },
  );
}

/**
 * Stop a script key's runs, or one of them, and wait for each to end. Runs
 * still waiting for admission or dispatch stop through core before they
 * reach the worker; the rest stop on the worker.
 */
export async function cancelScriptRuns(request: {
  projectId: string;
  worktreeId: string;
  scriptKey: string;
  runId?: string;
}): Promise<WorkerScriptExecutionCancelResult> {
  const runtime = getActiveDesktopRuntime();
  const [inFlight, onWorker] = await Promise.all([
    runtime.scriptRuns.cancelInFlight({
      workspaceId: request.projectId,
      worktreeId: request.worktreeId,
      scriptKey: request.scriptKey,
      ...(request.runId !== undefined ? { executionId: request.runId } : {}),
    }),
    runtime.instruction(
      'worker.script.execution.cancel',
      {
        scope: scope(request.projectId, request.worktreeId),
        scriptKey: request.scriptKey,
        ...(request.runId !== undefined ? { executionId: request.runId } : {}),
      },
      { caller: SCRIPT_CALLER, metadata: { idempotencyKey: randomUUID() } },
    ),
  ]);
  const stopped = [...onWorker.stopped];
  const seen = new Set(stopped.map((run) => run.executionId));
  for (const run of inFlight) {
    if (seen.has(run.executionId)) continue;
    stopped.push(
      run.status === 'completed'
        ? run.result
        : {
            executionId: run.executionId,
            status: 'cancelled',
            exitCode: null,
            timedOut: false,
            durationMs: 0,
            outputBytes: 0,
            outputTruncated: false,
            recorded: false,
          },
    );
  }
  return { stopped };
}

/** How an automation If Command gate's process ended. */
export interface CommandGateEnd {
  exitCode: number | null;
  /** Combined output, ending with the failure text when it could not start. */
  output: string;
  failure: ScriptProcessOutcome['failure'];
}

/**
 * Run an automation If Command gate on the local worker: a `core.script.run`
 * in the automation home with the login-shell environment and no run log.
 * The gate applies its own timeout and output cap and stops the run through
 * `signal`. An explicit `place` runs it in this process's worker with
 * exactly that directory and environment, without a dispatch record.
 */
export async function runCommandGate(args: {
  command: string;
  place?: { cwd?: string; env?: NodeJS.ProcessEnv };
  signal: AbortSignal;
  onData: (chunk: Buffer, stream: 'stdout' | 'stderr') => void;
}): Promise<CommandGateEnd> {
  if (args.place) {
    const cwd = args.place.cwd ?? getAppAdvisorHomeDir();
    await mkdir(cwd, { recursive: true });
    const ended = await desktopScriptWorker.runProcess({
      script: args.command,
      cwd,
      env: args.place.env ?? getEnhancedEnv(),
      shellStartup: 'login',
      timeoutMs: null,
      signal: args.signal,
      onData: args.onData,
    });
    return {
      exitCode: ended.exitCode,
      output: ended.output,
      failure: ended.failure,
    };
  }
  const capture: { finished: ScriptProcessOutcome | null } = {
    finished: null,
  };
  const outcome = await getActiveDesktopRuntime().scriptRuns.run(
    {
      params: {
        scope: {},
        context: { kind: 'automation-home' },
        command: args.command,
        shellStartup: 'login',
        timeoutMs: null,
        priority: 'normal',
      },
      origin: { kind: 'automation', sourceId: 'if-command' },
      owner: { kind: 'system', id: LOCAL_DESKTOP_AUTHORITY_ID },
    },
    {
      signal: args.signal,
      observer: {
        onData: args.onData,
        onFinished: (result) => {
          capture.finished = result;
        },
      },
    },
  );
  if (outcome.status === 'failed')
    throw new CanopyOperationError(
      outcome.error ?? {
        kind: 'internal',
        message: 'The If Command could not run.',
        retry: { kind: 'never' },
      },
    );
  const ended = capture.finished;
  return ended
    ? {
        exitCode: ended.exitCode,
        output: ended.output,
        failure: ended.failure,
      }
    : { exitCode: null, output: '', failure: null };
}
