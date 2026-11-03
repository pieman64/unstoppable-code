import { spawn } from 'node:child_process';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import {
  buildScriptShellCommand,
  ScriptExecutionWorker,
  type ActiveScriptRun,
  type ScriptChildProcess,
  type ScriptCommandShell,
  type ScriptExecutionWorkerHost,
  type ScriptRunTracking,
  type ScriptShellCommand,
  type StoppedScriptRun,
} from '@canopy/core-runtime/node/script/execution';
import { findExecutableOnPath } from '@canopy/desktop-shared/node/lib/path-lookup';
import { buildCmdCommandLine } from '@canopy/desktop-shared/node/lib/windows-process';
import type { ScriptRunResponse } from '@canopy/desktop-shared/types';
import { TERMINAL_USER_CLOSE_SIGNAL } from '@canopy/desktop-shared/types';
import { MAX_SCRIPT_TIMEOUT_SECONDS } from '@canopy/desktop-shared/scripts';
import { CANOPY_IN_PROCESS_WORKER_TARGET_ID } from '@canopy/protocol/canopy-core';
import type { ScriptRunLogRef } from './script-log-store';
import {
  lowerSpawnedProcessPriority,
  prepareBackgroundProcessLaunch,
} from './background-process';
import { writeFileAtomically } from './atomic-file';
import { logMainProcessWarn } from './main-process-logging';
import { buildScriptRunFileStem, resolveScriptRunDir } from './paths';
import { drainOwnedProcess, killChildProcessGroup } from './process-kill';
import { resolveWindowsGitBash } from './windows-git-bash';
import { getResourceMonitorService } from '../resource-monitor';
import {
  getExecutionAccounting,
  withExecutionLease,
} from '../execution-accounting';
import { assertWorkspaceTargetRuntimeStartAllowed } from './workspace-target-exclusion';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';

const MAX_OUTPUT_BYTES = 256 * 1024; // 256 KB

/**
 * Electron main's host for the worker's script execution (CAN-4143): process
 * effects, run-log paths and the projection of a script's context onto this
 * machine's checkouts. The runner, registry and run log are worker code in
 * `@canopy/core-runtime/node/script/execution`.
 */
const desktopScriptHost: ScriptExecutionWorkerHost = {
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  platform: () => hostPlatformOperatingSystem(),
  findExecutable: (name) => findExecutableOnPath(name),
  windowsGitBash: () => resolveWindowsGitBash(),
  cmdCommandLine: (scriptPath) => buildCmdCommandLine(scriptPath),
  loginShell: () => process.env.SHELL,
  comSpec: () => process.env.ComSpec,
  prepareLaunch: (command, args, background) =>
    prepareBackgroundProcessLaunch(command, args, background),
  lowerPriority: (pid) => lowerSpawnedProcessPriority(pid),
  spawn: (command, args, options): ScriptChildProcess => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: options.detached,
      windowsHide: true,
    });
    return {
      get pid(): number | undefined {
        return child.pid;
      },
      stdout: child.stdout && {
        onData: (listener) => child.stdout?.on('data', listener),
        destroy: () => child.stdout?.destroy(),
      },
      stderr: child.stderr && {
        onData: (listener) => child.stderr?.on('data', listener),
        destroy: () => child.stderr?.destroy(),
      },
      onError: (listener) => child.on('error', listener),
      onClose: (listener) => child.on('close', listener),
      killGroup: (signal) => killChildProcessGroup(child, signal),
    };
  },
  drainOwnedProcess: (pid, isOwned) => drainOwnedProcess(pid, isOwned),
  assertStartAllowed: (projectId, worktreeId) =>
    assertWorkspaceTargetRuntimeStartAllowed(projectId, worktreeId),
  registerProcess: (pid, tracking) => {
    const script = tracking.script;
    if (!script) return undefined;
    const resourceId = `script:${tracking.projectId}:${tracking.worktreeId}:${tracking.scriptKey}:${pid}`;
    const registration = getResourceMonitorService().registerProcess({
      id: resourceId,
      groupId: 'scripts',
      kind: 'script',
      label: script.label,
      pid,
      processGroupId: pid,
      metadata: {
        type: 'script',
        script: {
          projectId: tracking.projectId,
          worktreeId: tracking.worktreeId,
          scriptKey: tracking.scriptKey,
          scriptName: script.scriptName,
          scriptLabel: script.label,
          target: script.target,
          ...(script.repoId ? { repoId: script.repoId } : {}),
          ...(script.repoName ? { repoName: script.repoName } : {}),
          ...(tracking.invocation ? { invocation: tracking.invocation } : {}),
        },
      },
    });
    return withExecutionLease(
      getExecutionAccounting().track('script', resourceId),
      registration,
    );
  },
  logPaths: {
    runDir: (projectId, worktreeId) =>
      resolveScriptRunDir(projectId, worktreeId),
    fileStem: (scriptKey) => buildScriptRunFileStem(scriptKey),
  },
  logFiles: {
    writeFileAtomically: (path, text) =>
      writeFileAtomically(path, text, { encoding: 'utf8' }),
  },
  resolvePlace: async (scope, context) =>
    (await import('./script-execution-place')).resolveScriptExecutionPlace(
      scope,
      context,
    ),
  warn: (message, details) => logMainProcessWarn(message, details),
};

/** This process's local worker script execution; the dispatcher serves it. */
export const desktopScriptWorker = new ScriptExecutionWorker(desktopScriptHost);

export type ScriptTrackingInfo = ScriptRunTracking;
export type StoppedTrackedShellScript = StoppedScriptRun;

export interface RunShellScriptOptions {
  script: string;
  cwd: string;
  shell?: ScriptCommandShell;
  /** Pass null or omit to disable the timeout. Must be positive when set. */
  timeoutSeconds?: number | null;
  onChunk?: (lines: string[]) => void;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  tracking?: ScriptTrackingInfo;
  /**
   * Run the shell and the processes it launches below the app's priority.
   * Intended for automatic background work, not user-started scripts.
   */
  backgroundPriority?: boolean;
  /** Back the script with a persisted worktree PTY so it can accept input. */
  interactive?: boolean;
  /** Visible title for an interactive terminal session. */
  terminalTitle?: string;
  /** Reveal and focus the interactive terminal when it is spawned. */
  focusOnSpawn?: boolean;
  /** Called synchronously after the child/PTY is registered for teardown. */
  onProcessStarted?: () => void;
}

/** A positive timeout in seconds, clamped, as the runner's milliseconds. */
export function scriptTimeoutMs(
  timeoutSeconds: number | null | undefined,
): number | null {
  return typeof timeoutSeconds === 'number' && timeoutSeconds > 0
    ? Math.min(timeoutSeconds, MAX_SCRIPT_TIMEOUT_SECONDS) * 1000
    : null;
}

function stringEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

async function runInteractiveShellScript(
  options: RunShellScriptOptions,
): Promise<ScriptRunResponse> {
  const startTime = Date.now();
  const tracking = options.tracking;
  if (!tracking?.projectId || !tracking.worktreeId) {
    const output =
      'Interactive scripts require projectId and worktreeId tracking ownership.';
    options.onChunk?.([output]);
    return {
      success: false,
      exitCode: 1,
      output,
      timedOut: false,
      durationMs: Date.now() - startTime,
    };
  }
  // Keep the PTY backend off the ordinary readonly runner's import path. This
  // avoids loading terminal/native dependencies for hooks and non-interactive
  // scripts while still sharing the tracking registry below.
  const { workerTerminal } = await import('../terminal/worker-terminal');
  let shell: ScriptShellCommand;
  try {
    shell = buildShellScriptCommand(options.script, options.shell);
  } catch (error) {
    const output = String(error);
    options.onChunk?.(output.split('\n'));
    return Promise.resolve({
      success: false,
      exitCode: 1,
      output,
      timedOut: false,
      durationMs: Date.now() - startTime,
    });
  }
  const launch = prepareBackgroundProcessLaunch(
    shell.command,
    shell.args,
    options.backgroundPriority === true,
  );

  return new Promise((resolve) => {
    let terminalId: string | null = null;
    let settled = false;
    let stoppedManually = false;
    let aborted = false;
    let timedOut = false;
    let output = '';
    let lineBuffer = '';
    let timeoutTimer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const exitResolver: {
      resolve: (response: ScriptRunResponse) => void;
    } = { resolve: (): void => undefined };
    const waitForExit = new Promise<ScriptRunResponse>((done) => {
      exitResolver.resolve = done;
    });

    const emitChunk = (chunk: Buffer): void => {
      if (Buffer.byteLength(output, 'utf8') < MAX_OUTPUT_BYTES) {
        output = `${output}${chunk.toString('utf8')}`;
        if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) {
          output = Buffer.from(output, 'utf8')
            .subarray(0, MAX_OUTPUT_BYTES)
            .toString('utf8');
        }
      }
      lineBuffer += chunk.toString('utf8');
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? '';
      if (Buffer.byteLength(lineBuffer, 'utf8') > MAX_OUTPUT_BYTES) {
        lineBuffer = Buffer.from(lineBuffer, 'utf8')
          .subarray(0, MAX_OUTPUT_BYTES)
          .toString('utf8');
      }
      if (lines.length > 0) options.onChunk?.(lines);
    };

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (lineBuffer.length > 0) options.onChunk?.([lineBuffer]);
      unsubscribeEvents();
      shell.cleanup?.();
      if (options.signal && abortListener) {
        options.signal.removeEventListener('abort', abortListener);
      }
      desktopScriptWorker.registry.delete(activeScript);
      const cancelled =
        stoppedManually || aborted || signal === TERMINAL_USER_CLOSE_SIGNAL;
      const response: ScriptRunResponse = {
        success:
          !timedOut &&
          !aborted &&
          !stoppedManually &&
          exitCode === 0 &&
          signal === null,
        exitCode: cancelled ? null : exitCode,
        output,
        timedOut,
        durationMs: Date.now() - startTime,
      };
      exitResolver.resolve(response);
      resolve(response);
    };

    const unsubscribeEvents = workerTerminal.addEventListener((event): void => {
      if (terminalId === null) return;
      if (event.type === 'output') {
        if (event.payload.terminalId === terminalId) {
          emitChunk(Buffer.from(event.payload.data));
        }
      } else if (
        event.type === 'exit' &&
        event.payload.terminalId === terminalId
      ) {
        finish(event.payload.exitCode, event.payload.signal);
      }
    });

    const stop = (reason: 'manual' | 'abort' | 'timeout' = 'manual'): void => {
      if (settled || terminalId === null) return;
      if (reason === 'manual') stoppedManually = true;
      if (reason === 'abort') aborted = true;
      if (reason === 'timeout') timedOut = true;
      workerTerminal.kill(terminalId);
    };
    const activeScript: ActiveScriptRun = {
      stop,
      drain: async () => {
        stoppedManually = true;
        if (terminalId !== null) await workerTerminal.release(terminalId);
        await waitForExit;
      },
      waitForExit,
      tracking: options.tracking,
    };

    try {
      const managedCommand = {
        executable: launch.command,
        args: launch.args,
        env: stringEnv(options.env),
        title:
          options.terminalTitle ??
          options.tracking?.script?.label ??
          'Interactive command',
        kind: 'script' as const,
        focusOnSpawn:
          options.focusOnSpawn ??
          options.tracking?.invocation?.startsWith('manual') === true,
      };
      // An explicit environment is an exact process boundary, not an overlay
      // on the ordinary worktree environment. Shared-container runs depend on
      // this to keep Canopy-held and user-assigned secrets out of the PTY that
      // backs an interactive published command.
      const session = options.env
        ? workerTerminal.create({
            projectId: tracking.projectId,
            worktreeId: tracking.worktreeId,
            cols: 80,
            rows: 24,
            managedCommand,
            cwd: options.cwd,
            environment: options.env,
          })
        : workerTerminal.create({
            projectId: tracking.projectId,
            worktreeId: tracking.worktreeId,
            cols: 80,
            rows: 24,
            managedCommand,
            cwd: options.cwd,
          });
      terminalId = session.id;
      if (launch.lowerPriorityAfterSpawn) {
        workerTerminal.lowerPriority(session.id);
      }
    } catch (error) {
      unsubscribeEvents();
      shell.cleanup?.();
      const message = String(error);
      options.onChunk?.(message.split('\n'));
      const response: ScriptRunResponse = {
        success: false,
        exitCode: 1,
        output: message,
        timedOut: false,
        durationMs: Date.now() - startTime,
      };
      exitResolver.resolve(response);
      resolve(response);
      return;
    }

    desktopScriptWorker.registry.add(activeScript);
    options.onProcessStarted?.();
    if (options.signal) {
      abortListener = (): void => stop('abort');
      if (options.signal.aborted) abortListener();
      else
        options.signal.addEventListener('abort', abortListener, { once: true });
    }
    if (
      typeof options.timeoutSeconds === 'number' &&
      options.timeoutSeconds > 0
    ) {
      timeoutTimer = setTimeout(
        () => stop('timeout'),
        Math.min(options.timeoutSeconds, MAX_SCRIPT_TIMEOUT_SECONDS) * 1000,
      );
    }
  });
}

export function buildShellScriptCommand(
  script: string,
  shell?: ScriptCommandShell,
  options?: { interactive?: boolean },
): ScriptShellCommand {
  return buildScriptShellCommand(desktopScriptHost, script, shell, options);
}

export function subscribeTrackedScriptsChanged(
  listener: () => void,
): () => void {
  return desktopScriptWorker.registry.subscribe(listener);
}

export function listTrackedShellScripts(): ScriptTrackingInfo[] {
  return desktopScriptWorker.registry.list();
}

export function stopAllRunningShellScripts(): void {
  desktopScriptWorker.registry.stopAll();
}

export function stopTrackedShellScript(
  target: ScriptTrackingInfo,
): Promise<StoppedTrackedShellScript | null> {
  return desktopScriptWorker.registry.stop(target);
}

/** Stop one concrete run without affecting concurrent instances of its script. */
export function stopTrackedShellScriptRun(
  target: ScriptTrackingInfo & { logRef: ScriptRunLogRef },
): Promise<StoppedTrackedShellScript | null> {
  return desktopScriptWorker.registry.stopRun({
    ...target,
    runId: target.logRef.runId,
  });
}

/** See {@link ScriptRunRegistry.drainMatching}. */
export function drainTrackedShellScriptRunsForWorktree(
  target: { projectId: string; worktreeId: string },
  shouldDrain: (tracking: ScriptTrackingInfo) => boolean,
): Promise<StoppedTrackedShellScript[]> {
  return desktopScriptWorker.registry.drainMatching(target, shouldDrain);
}

/** Includes hooks, automatic setup, and duplicate keys absent from renderer state. */
export function drainWorktreeShellScripts(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  return desktopScriptWorker.registry.drainWorktree(projectId, worktreeId);
}

export function isTrackedShellScriptRunning(
  target: ScriptTrackingInfo,
): boolean {
  return desktopScriptWorker.registry.isRunning(target);
}

/**
 * List the tracking info for every currently-running tracked shell script that
 * belongs to a given worktree. Used by the Split PR start handler to enumerate
 * (and then stop) running scripts for the worktree before acquiring the lock.
 */
export function listTrackedShellScriptsForWorktree(target: {
  projectId: string;
  worktreeId: string;
}): ScriptTrackingInfo[] {
  return desktopScriptWorker.registry.listForWorktree(target);
}

/**
 * Run a command on this process's worker without a run log or dispatch
 * record, or in an interactive worktree PTY. Scripts run through
 * `lib/script-execution`; this remains for hook commands (CAN-4146) and
 * interactive runs (CAN-5082).
 */
export function runShellScript(
  options: RunShellScriptOptions,
): Promise<ScriptRunResponse> {
  if (options.interactive === true) {
    if (options.tracking) {
      assertWorkspaceTargetRuntimeStartAllowed(
        options.tracking.projectId,
        options.tracking.worktreeId,
      );
    }
    return runInteractiveShellScript(options);
  }
  return desktopScriptWorker
    .runProcess({
      script: options.script,
      cwd: options.cwd,
      ...(options.shell ? { shell: options.shell } : {}),
      timeoutMs: scriptTimeoutMs(options.timeoutSeconds),
      ...(options.onChunk ? { onChunk: options.onChunk } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.tracking ? { tracking: options.tracking } : {}),
      backgroundPriority: options.backgroundPriority === true,
      ...(options.onProcessStarted
        ? { onProcessStarted: options.onProcessStarted }
        : {}),
    })
    .then(({ success, exitCode, output, timedOut, durationMs }) => ({
      success,
      exitCode,
      output,
      timedOut,
      durationMs,
    }));
}
