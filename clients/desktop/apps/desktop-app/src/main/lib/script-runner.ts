import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findExecutableOnPath } from '@canopy/desktop-shared/node/lib/path-lookup';
import { buildCmdCommandLine } from '@canopy/desktop-shared/node/lib/windows-process';
import type {
  ScriptDescriptor,
  ScriptRunResponse,
  ScriptStartedEvent,
} from '@canopy/desktop-shared/types';
import {
  IPC_CHANNELS,
  TERMINAL_USER_CLOSE_SIGNAL,
} from '@canopy/desktop-shared/types';
import {
  MAX_SCRIPT_TIMEOUT_SECONDS,
  type CommandShellDefinition,
} from '@canopy/desktop-shared/scripts';
import type { ScriptRunLogRef } from './script-log-store';
import {
  lowerSpawnedProcessPriority,
  prepareBackgroundProcessLaunch,
} from './background-process';
import { drainOwnedProcess, killChildProcessGroup } from './process-kill';
import { resolveWindowsGitBash } from './windows-git-bash';
import {
  getResourceMonitorService,
  type ResourceRegistrationHandle,
} from '../resource-monitor';
import { assertWorkspaceTargetRuntimeStartAllowed } from './workspace-target-exclusion';

const FORCE_KILL_DELAY_MS = 5_000;
const MAX_OUTPUT_BYTES = 256 * 1024; // 256 KB

/**
 * How often (ms) buffered lines are flushed to the onChunk callback.
 * Batching prevents IPC flooding when scripts produce rapid output.
 * 250 ms keeps the UI feeling live while reducing IPC messages to ~4/sec
 * per script — important when multiple repos run setup in parallel.
 */
const EMIT_FLUSH_INTERVAL_MS = 250;

/** Flush immediately once the buffer accumulates this many lines. */
const EMIT_FLUSH_LINE_THRESHOLD = 120;

interface ActiveShellScript {
  stop: () => void;
  drain: () => Promise<void>;
  waitForExit: Promise<ScriptRunResponse>;
  tracking?: ScriptTrackingInfo;
}

const runningShellScripts = new Set<ActiveShellScript>();
const trackedScriptListeners = new Set<() => void>();

function notifyTrackedScriptsChanged(): void {
  trackedScriptListeners.forEach((listener): void => {
    // A throwing subscriber must not disturb script execution or other
    // listeners; this registry is observational only.
    try {
      listener();
    } catch {
      // Ignore listener failures.
    }
  });
}

export function subscribeTrackedScriptsChanged(
  listener: () => void,
): () => void {
  trackedScriptListeners.add(listener);
  return (): void => {
    trackedScriptListeners.delete(listener);
  };
}

export function listTrackedShellScripts(): ScriptTrackingInfo[] {
  return Array.from(runningShellScripts)
    .map((script) => script.tracking)
    .filter(
      (tracking): tracking is ScriptTrackingInfo =>
        tracking !== undefined && tracking.kind !== 'hook',
    );
}

export interface ScriptTrackingInfo {
  projectId: string;
  worktreeId: string;
  scriptKey: string;
  runId?: string;
  /** Registry namespace. Omitted entries are ordinary scripts. */
  kind?: 'script' | 'hook';
  script?: ScriptDescriptor;
  invocation?: ScriptStartedEvent['invocation'];
  logRef?: ScriptRunLogRef;
}

export interface StoppedTrackedShellScript {
  response: ScriptRunResponse;
  tracking?: ScriptTrackingInfo;
}

export interface RunShellScriptOptions {
  script: string;
  cwd: string;
  shell?: CommandShellDefinition;
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
  const { ptyManager } = await import('../terminal/pty-manager');
  let shell: ReturnType<typeof buildShellScriptCommand>;
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
      runningShellScripts.delete(activeScript);
      notifyTrackedScriptsChanged();
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

    const unsubscribeEvents = ptyManager.addEventListener(
      (channel, payload): void => {
        if (
          terminalId === null ||
          !('terminalId' in payload) ||
          payload.terminalId !== terminalId
        ) {
          return;
        }
        if (channel === IPC_CHANNELS.terminalOutput) {
          if ('data' in payload) {
            emitChunk(Buffer.from(payload.data));
          }
        } else if (
          channel === IPC_CHANNELS.terminalExit &&
          'exitCode' in payload &&
          'signal' in payload
        ) {
          finish(payload.exitCode, payload.signal);
        }
      },
    );

    const stop = (reason: 'manual' | 'abort' | 'timeout' = 'manual'): void => {
      if (settled || terminalId === null) return;
      if (reason === 'manual') stoppedManually = true;
      if (reason === 'abort') aborted = true;
      if (reason === 'timeout') timedOut = true;
      ptyManager.kill(terminalId);
    };
    const activeScript: ActiveShellScript = {
      stop,
      drain: async () => {
        stoppedManually = true;
        if (terminalId !== null) await ptyManager.drainTerminal(terminalId);
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
        ? ptyManager.spawnWithEnvironment(
            options.env,
            tracking.projectId,
            tracking.worktreeId,
            80,
            24,
            undefined,
            managedCommand,
            options.cwd,
          )
        : ptyManager.spawn(
            tracking.projectId,
            tracking.worktreeId,
            80,
            24,
            undefined,
            managedCommand,
            options.cwd,
          );
      terminalId = session.id;
      if (launch.lowerPriorityAfterSpawn) {
        ptyManager.lowerPriority(session.id);
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

    runningShellScripts.add(activeScript);
    notifyTrackedScriptsChanged();
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

function buildPowerShellScript(script: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    script,
    '$canopyLastSuccess = $?',
    '$canopyLastExitCode = $LASTEXITCODE',
    'if (-not $canopyLastSuccess) {',
    '  if ($canopyLastExitCode -is [int] -and $canopyLastExitCode -ne 0) { exit $canopyLastExitCode }',
    '  exit 1',
    '}',
    'exit 0',
    '',
  ].join('\n');
}

export function buildShellScriptCommand(
  script: string,
  shell?: CommandShellDefinition,
  options?: { interactive?: boolean },
): {
  command: string;
  args: string[];
  cleanup?: () => void;
} {
  if (process.platform === 'win32') {
    const requestedShell = shell?.windows;
    if (requestedShell === 'bash') {
      const bash = resolveWindowsGitBash();
      if (bash === null) {
        throw new Error('Git Bash is not available on this Windows machine.');
      }
      return { command: bash, args: ['-lc', script] };
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'canopy-script-'));
    const cleanup = (): void => {
      rmSync(tempDir, { recursive: true, force: true });
    };
    const defaultPowerShell =
      requestedShell === undefined
        ? (findExecutableOnPath('pwsh.exe') ??
          findExecutableOnPath('powershell.exe'))
        : null;
    if (requestedShell === 'powershell' || defaultPowerShell) {
      const pwsh =
        requestedShell === 'powershell'
          ? (findExecutableOnPath('pwsh.exe') ??
            findExecutableOnPath('powershell.exe') ??
            'powershell.exe')
          : defaultPowerShell;
      const scriptPath = join(tempDir, 'canopy-script.ps1');
      writeFileSync(scriptPath, buildPowerShellScript(script), 'utf8');
      return {
        command: pwsh ?? 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
        ],
        cleanup,
      };
    }
    const scriptPath = join(tempDir, 'canopy-script.cmd');
    writeFileSync(scriptPath, script, 'utf8');
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', buildCmdCommandLine(scriptPath)],
      cleanup,
    };
  }

  const requestedShell = process.platform === 'darwin' ? shell?.mac : undefined;
  const command = requestedShell
    ? (findExecutableOnPath(requestedShell) ?? `/bin/${requestedShell}`)
    : process.env.SHELL || '/bin/bash';
  return {
    command,
    args: [options?.interactive === false ? '-l' : '-li', '-c', script],
  };
}

export function stopAllRunningShellScripts(): void {
  runningShellScripts.forEach((script) => {
    script.stop();
  });
}

function isTrackedScriptMatch(
  tracking: ScriptTrackingInfo | undefined,
  target: ScriptTrackingInfo,
): boolean {
  if (!tracking) return false;
  return (
    tracking.projectId === target.projectId &&
    tracking.worktreeId === target.worktreeId &&
    tracking.scriptKey === target.scriptKey &&
    (tracking.kind ?? 'script') === (target.kind ?? 'script')
  );
}

export async function stopTrackedShellScript(
  target: ScriptTrackingInfo,
): Promise<StoppedTrackedShellScript | null> {
  const activeScripts = Array.from(runningShellScripts).filter((script) =>
    isTrackedScriptMatch(script.tracking, target),
  );

  if (activeScripts.length === 0) {
    return null;
  }

  activeScripts.forEach((script) => {
    script.stop();
  });

  const results = await Promise.allSettled(
    activeScripts.map(async (script) => ({
      response: await script.waitForExit,
      tracking: script.tracking,
    })),
  );
  for (const result of results) {
    if (result.status === 'fulfilled') {
      return result.value;
    }
  }
  return null;
}

/** Stop one concrete run without affecting concurrent instances of its script. */
export async function stopTrackedShellScriptRun(
  target: ScriptTrackingInfo & { logRef: ScriptRunLogRef },
): Promise<StoppedTrackedShellScript | null> {
  const script = Array.from(runningShellScripts).find(
    (candidate): boolean =>
      isTrackedScriptMatch(candidate.tracking, target) &&
      candidate.tracking?.logRef?.runId === target.logRef.runId,
  );
  if (script === undefined) return null;
  script.stop();
  try {
    return { response: await script.waitForExit, tracking: script.tracking };
  } catch {
    return null;
  }
}

/**
 * Drain the worktree's runs that match, each judged as its own concrete run:
 * a run is not hidden behind another with the same script key, as it is in
 * listTrackedShellScriptsForWorktree. Draining rather than stopping ends the
 * whole process group: a shell that exits on the stop signal would drop its
 * tracking while a child that ignores the signal kept running, out of reach
 * of drainWorktreeShellScripts.
 */
export async function drainTrackedShellScriptRunsForWorktree(
  target: { projectId: string; worktreeId: string },
  shouldDrain: (tracking: ScriptTrackingInfo) => boolean,
): Promise<StoppedTrackedShellScript[]> {
  const scripts = Array.from(runningShellScripts).filter(
    ({ tracking }) =>
      tracking !== undefined &&
      tracking.kind !== 'hook' &&
      tracking.projectId === target.projectId &&
      tracking.worktreeId === target.worktreeId &&
      shouldDrain(tracking),
  );
  const results = await Promise.allSettled(
    scripts.map(async (script) => {
      await script.drain();
      return { response: await script.waitForExit, tracking: script.tracking };
    }),
  );
  return results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
}

/** Includes hooks, automatic setup, and duplicate keys absent from renderer state. */
export async function drainWorktreeShellScripts(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const scripts = Array.from(runningShellScripts).filter(
    ({ tracking }) =>
      tracking?.projectId === projectId && tracking.worktreeId === worktreeId,
  );
  const results = await Promise.allSettled(
    scripts.map((script) => script.drain()),
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

export function isTrackedShellScriptRunning(
  target: ScriptTrackingInfo,
): boolean {
  return Array.from(runningShellScripts).some((script) =>
    isTrackedScriptMatch(script.tracking, target),
  );
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
  const seen = new Set<string>();
  const result: ScriptTrackingInfo[] = [];
  for (const script of Array.from(runningShellScripts)) {
    const tracking = script.tracking;
    if (
      !tracking ||
      tracking.kind === 'hook' ||
      tracking.projectId !== target.projectId ||
      tracking.worktreeId !== target.worktreeId
    ) {
      continue;
    }
    if (seen.has(tracking.scriptKey)) {
      continue;
    }
    seen.add(tracking.scriptKey);
    result.push(tracking);
  }
  return result;
}

export function runShellScript(
  options: RunShellScriptOptions,
): Promise<ScriptRunResponse> {
  if (options.tracking) {
    assertWorkspaceTargetRuntimeStartAllowed(
      options.tracking.projectId,
      options.tracking.worktreeId,
    );
  }
  if (options.interactive === true) {
    return runInteractiveShellScript(options);
  }
  const startTime = Date.now();

  return new Promise((resolve) => {
    let resolveExit!: (result: ScriptRunResponse) => void;
    const waitForExit = new Promise<ScriptRunResponse>((resolveDone) => {
      resolveExit = resolveDone;
    });
    let settled = false;
    let stoppedManually = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    let lineBuf = '';
    let pendingLines: string[] = [];
    let flushTimer: NodeJS.Timeout | undefined;

    const flushPendingLines = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      if (pendingLines.length > 0 && options.onChunk) {
        options.onChunk(pendingLines);
        pendingLines = [];
      }
    };

    const flushBufferedOutput = (): void => {
      if (options.onChunk && lineBuf.length > 0) {
        pendingLines.push(lineBuf);
        lineBuf = '';
      }
      flushPendingLines();
    };

    const failBeforeProcessStart = (error: unknown): void => {
      const output = String(error);
      options.onChunk?.(output.split('\n'));
      const response = {
        success: false,
        exitCode: 1,
        output,
        timedOut: false,
        durationMs: Date.now() - startTime,
      };
      resolveExit(response);
      resolve(response);
    };

    let shell: ReturnType<typeof buildShellScriptCommand>;
    try {
      shell = buildShellScriptCommand(options.script, options.shell);
    } catch (error) {
      failBeforeProcessStart(error);
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      const launch = prepareBackgroundProcessLaunch(
        shell.command,
        shell.args,
        options.backgroundPriority === true,
      );
      child = spawn(launch.command, launch.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Windows drops piped output for detached children; taskkill /t still
        // lets us terminate the process tree without CREATE_NEW_PROCESS_GROUP.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      shell.cleanup?.();
      failBeforeProcessStart(error);
      return;
    }
    if (
      options.backgroundPriority &&
      process.platform !== 'darwin' &&
      typeof child.pid === 'number'
    ) {
      lowerSpawnedProcessPriority(child.pid);
    }
    let resourceHandle: ResourceRegistrationHandle | undefined;
    const tracking = options.tracking;
    const trackedScript = tracking?.script;
    if (tracking && trackedScript && typeof child.pid === 'number') {
      resourceHandle = getResourceMonitorService().registerProcess({
        id: `script:${tracking.projectId}:${tracking.worktreeId}:${tracking.scriptKey}:${child.pid}`,
        groupId: 'scripts',
        kind: 'script',
        label: trackedScript.label,
        pid: child.pid,
        processGroupId: child.pid,
        metadata: {
          type: 'script',
          script: {
            projectId: tracking.projectId,
            worktreeId: tracking.worktreeId,
            scriptKey: tracking.scriptKey,
            scriptName: trackedScript.scriptName,
            scriptLabel: trackedScript.label,
            target: trackedScript.target,
            ...(trackedScript.repoId ? { repoId: trackedScript.repoId } : {}),
            ...(trackedScript.repoName
              ? { repoName: trackedScript.repoName }
              : {}),
            ...(tracking.invocation ? { invocation: tracking.invocation } : {}),
          },
        },
      });
    }
    const collectChunk = (chunk: Buffer): void => {
      if (totalBytes >= MAX_OUTPUT_BYTES) return;
      const remaining = MAX_OUTPUT_BYTES - totalBytes;
      const slice =
        chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(slice);
      totalBytes += slice.length;
    };

    const emitLines = (chunk: Buffer): void => {
      if (!options.onChunk) return;
      lineBuf += chunk.toString('utf8');
      const parts = lineBuf.split(/\r?\n/);
      // Last element is the incomplete line (or empty string if chunk ended with a recognized newline)
      lineBuf = parts.pop() ?? '';
      if (parts.length === 0) return;

      pendingLines.push(...parts);

      // Flush immediately when the buffer is large enough
      if (pendingLines.length >= EMIT_FLUSH_LINE_THRESHOLD) {
        flushPendingLines();
        return;
      }

      // Schedule a deferred flush. The timer fires after the interval, then
      // `setImmediate` pushes the actual IPC send into the check phase of the
      // Node event loop — after the poll phase where IPC invoke handlers
      // (user-initiated actions) run.  This ensures script output never
      // starves interactive requests.
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          setImmediate(flushPendingLines);
        }, EMIT_FLUSH_INTERVAL_MS);
      }
    };

    const handleData = (chunk: Buffer): void => {
      collectChunk(chunk);
      emitLines(chunk);
    };

    let aborted = false;
    let abortListener: (() => void) | undefined;
    const finalize = (exitCode: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (flushTimer) clearTimeout(flushTimer);
      runningShellScripts.delete(activeScript);
      notifyTrackedScriptsChanged();
      resourceHandle?.unregister();
      resourceHandle = undefined;
      shell.cleanup?.();
      if (options.signal && abortListener) {
        options.signal.removeEventListener('abort', abortListener);
      }
      child.stdout?.destroy();
      child.stderr?.destroy();

      flushBufferedOutput();

      let output = Buffer.concat(chunks).toString('utf8');
      const finalLines: string[] = [];
      if (totalBytes >= MAX_OUTPUT_BYTES) {
        output += '\n[output truncated]';
        finalLines.push('[output truncated]');
      }
      if (error) {
        output += (output ? '\n' : '') + error;
        finalLines.push(...error.split('\n'));
      }
      if (finalLines.length > 0 && options.onChunk) {
        options.onChunk(finalLines);
      }

      const response = {
        success:
          !timedOut && !aborted && !stoppedManually && exitCode === 0 && !error,
        exitCode: stoppedManually || aborted ? null : exitCode,
        output,
        timedOut,
        durationMs: Date.now() - startTime,
      };

      resolveExit(response);
      resolve(response);
    };

    const stop = (reason: 'manual' | 'abort' | 'timeout' = 'manual'): void => {
      if (settled) return;
      if (reason !== 'timeout') {
        stoppedManually = true;
      }
      killChildProcessGroup(child, 'SIGTERM');
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          killChildProcessGroup(child, 'SIGKILL');
          // Detached descendants can inherit stdout/stderr and keep Node's
          // child "close" event from firing. Once we've escalated to SIGKILL,
          // complete the tracked run so the UI is not stuck in "Stopping...".
          finalize(null);
        }, FORCE_KILL_DELAY_MS);
      }
    };
    const activeScript: ActiveShellScript = {
      stop,
      drain: async () => {
        stoppedManually = true;
        if (child.pid !== undefined) {
          const ownedPid = child.pid;
          await drainOwnedProcess(
            ownedPid,
            () =>
              runningShellScripts.has(activeScript) && child.pid === ownedPid,
          );
        }
        finalize(null);
        await waitForExit;
      },
      waitForExit,
      tracking: options.tracking,
    };
    runningShellScripts.add(activeScript);
    notifyTrackedScriptsChanged();
    options.onProcessStarted?.();

    if (options.signal) {
      abortListener = (): void => {
        aborted = true;
        stop('abort');
      };
      if (options.signal.aborted) {
        abortListener();
      } else {
        options.signal.addEventListener('abort', abortListener, { once: true });
      }
    }

    const timeoutTimer =
      typeof options.timeoutSeconds === 'number' && options.timeoutSeconds > 0
        ? setTimeout(
            () => {
              timedOut = true;
              stop('timeout');
            },
            Math.min(options.timeoutSeconds, MAX_SCRIPT_TIMEOUT_SECONDS) * 1000,
          )
        : undefined;

    child.stdout?.on('data', handleData);
    child.stderr?.on('data', handleData);

    child.on('error', (err) => {
      finalize(1, String(err));
    });

    child.on('close', (code) => {
      finalize(code);
    });
  });
}
