import { randomUUID } from 'node:crypto';
import { toWorkerScriptExecution } from '@canopy/core-runtime/node/script/execution';
import type * as ScriptExecution from '../../lib/script-execution';
import { resolveScriptExecutionPlace } from '../../lib/script-execution-place';
import {
  appendScriptRunLogLines,
  completeScriptRunLog,
  listScriptRunLogTails,
  readScriptRunLogTail,
  startScriptRunLog,
} from '../../lib/script-log-store';
import {
  runShellScript,
  stopTrackedShellScript,
} from '../../lib/script-runner';
import { assertWorkspaceTargetRuntimeStartAllowed } from '../../lib/workspace-target-exclusion';

/*
 * `lib/script-execution` for suites that test a script caller (the scripts
 * service, the setup runtimes, the agent tools) without composing the
 * desktop runtime. A run does what the worker's `worker.script.execute`
 * does, over the suite's runner and run-log modules, with the real context
 * projection; the worker itself is covered in core-runtime and the desktop
 * composition tests.
 */

export const runDesktopScript: typeof ScriptExecution.runDesktopScript = async (
  run,
  options = {},
) => {
  const runId = run.runId ?? randomUUID();
  assertWorkspaceTargetRuntimeStartAllowed(run.projectId, run.worktreeId);
  const place = await resolveScriptExecutionPlace(
    { workspaceId: run.projectId, worktreeId: run.worktreeId },
    run.context,
  );
  const logRef = await startScriptRunLog({
    projectId: run.projectId,
    worktreeId: run.worktreeId,
    script: run.script,
    invocation: run.invocation,
    runId,
  }).catch(() => null);
  const response = await runShellScript({
    script: run.command,
    cwd: place.cwd,
    env: place.env,
    ...(run.shell ? { shell: run.shell } : {}),
    timeoutSeconds: run.interactive ? null : run.timeoutSeconds,
    interactive: run.interactive,
    backgroundPriority: run.backgroundPriority === true,
    ...(options.signal ? { signal: options.signal } : {}),
    onChunk: (lines) => {
      if (logRef)
        void appendScriptRunLogLines({ ref: logRef, lines }).catch(() => {});
      options.observer?.onLines?.(lines);
    },
    tracking: {
      projectId: run.projectId,
      worktreeId: run.worktreeId,
      scriptKey: run.script.scriptKey,
      runId,
      script: run.script,
      invocation: run.invocation,
      logRef: logRef ?? undefined,
    },
    onProcessStarted: () => options.observer?.onProcessStarted?.(),
  });
  if (logRef)
    await completeScriptRunLog({ ref: logRef, response }).catch(() => {});
  return { runId, logRef, response };
};

export const readScriptRun: typeof ScriptExecution.readScriptRun = async (
  request,
) => {
  const { meta, lines } = await readScriptRunLogTail({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    scriptKey: request.scriptKey,
    maxLines: request.tailLines,
  });
  return {
    run: meta ? { execution: toWorkerScriptExecution(meta), lines } : null,
  };
};

export const listScriptRuns: typeof ScriptExecution.listScriptRuns = async (
  request,
) => {
  const runs = await listScriptRunLogTails({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    maxLines: request.tailLines,
  });
  return {
    runs: runs.map(({ meta, lines }) => ({
      execution: toWorkerScriptExecution(meta),
      lines,
    })),
  };
};

export const cancelScriptRuns: typeof ScriptExecution.cancelScriptRuns = async (
  request,
) => {
  const stopped = await stopTrackedShellScript({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    scriptKey: request.scriptKey,
  });
  const executionId =
    stopped?.tracking?.runId ?? stopped?.tracking?.logRef?.runId;
  if (!stopped || executionId === undefined) return { stopped: [] };
  const { response } = stopped;
  return {
    stopped: [
      {
        executionId,
        status: response.success
          ? 'success'
          : response.exitCode === null && !response.timedOut
            ? 'cancelled'
            : 'failed',
        exitCode: response.exitCode,
        timedOut: response.timedOut,
        durationMs: response.durationMs,
        outputBytes: Buffer.byteLength(response.output, 'utf8'),
        outputTruncated: false,
        recorded: stopped.tracking?.logRef !== undefined,
      },
    ],
  };
};

export const runCommandGate: typeof ScriptExecution.runCommandGate = (args) =>
  jest
    .requireActual<typeof ScriptExecution>('../../lib/script-execution')
    .runCommandGate(args);
