import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { getAppAdvisorHomeDir } from '../lib/paths';
import { getEnhancedEnv } from '../pipelines/config-paths';
import { buildShellScriptCommand } from '../lib/script-runner';
import { killChildProcessGroup } from '../lib/process-kill';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_STDOUT_BYTES = 256 * 1024;
const FORCE_KILL_DELAY_MS = 5_000;

/**
 * Outcome of an automation If Command gate.
 * - `run`: command exited 0; `stdout` is the trimmed captured standard output.
 * - `skip`: command exited non-zero; the action should not run.
 * - `error`: spawn failure or timeout; the run should be recorded as failed.
 */
export type AutomationIfCommandResult =
  | { outcome: 'run'; stdout: string; stderr?: string }
  | { outcome: 'skip'; exitCode: number; stdout?: string; stderr?: string }
  | { outcome: 'error'; message: string; stdout?: string; stderr?: string };

/**
 * Run an automation If Command gate. stdout is captured separately from
 * stderr so the injected variable carries clean command output only. Runs in
 * the App Advisor home directory with the enhanced (login-shell) PATH.
 */
export async function runAutomationIfCommand(args: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<AutomationIfCommandResult> {
  const cwd = args.cwd ?? getAppAdvisorHomeDir();
  await mkdir(cwd, { recursive: true });
  const env = args.env ?? getEnhancedEnv();
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let shell: ReturnType<typeof buildShellScriptCommand>;
  try {
    shell = buildShellScriptCommand(args.command, undefined, {
      interactive: false,
    });
  } catch (error) {
    return { outcome: 'error', message: String(error) };
  }

  return await new Promise<AutomationIfCommandResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdoutCapped = false;
    let totalBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let forceKillTimer: NodeJS.Timeout | undefined;
    const getCapturedStdout = (): string =>
      Buffer.concat(stdoutChunks).toString('utf8').trim();
    const getCapturedStderr = (): string =>
      Buffer.concat(stderrChunks).toString('utf8').trim();

    const finish = (result: AutomationIfCommandResult): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (args.signal && abortListener) {
        args.signal.removeEventListener('abort', abortListener);
      }
      shell.cleanup?.();
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell.command, shell.args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Windows drops piped output for detached children; taskkill /t still
        // lets us terminate the process tree without CREATE_NEW_PROCESS_GROUP.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      shell.cleanup?.();
      resolve({ outcome: 'error', message: String(error) });
      return;
    }

    const killSoon = (): void => {
      killChildProcessGroup(child, 'SIGTERM');
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          killChildProcessGroup(child, 'SIGKILL');
        }, FORCE_KILL_DELAY_MS);
        forceKillTimer.unref?.();
      }
    };
    const releaseChildHandles = (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (totalBytes >= MAX_STDOUT_BYTES) {
        if (!stdoutCapped) {
          stdoutCapped = true;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          killSoon();
          releaseChildHandles();
          finish({
            outcome: 'run',
            stdout: getCapturedStdout(),
            stderr: getCapturedStderr(),
          });
        }
        return;
      }
      const remaining = MAX_STDOUT_BYTES - totalBytes;
      const slice =
        chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stdoutChunks.push(slice);
      totalBytes += slice.length;
      if (totalBytes >= MAX_STDOUT_BYTES) {
        stdoutCapped = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        killSoon();
        releaseChildHandles();
        finish({
          outcome: 'run',
          stdout: getCapturedStdout(),
          stderr: getCapturedStderr(),
        });
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const remaining = MAX_STDOUT_BYTES - stderrBytes;
      if (remaining > 0) {
        const slice = chunk.subarray(0, remaining);
        stderrChunks.push(slice);
        stderrBytes += slice.length;
      }
    });

    const timeoutTimer: NodeJS.Timeout | undefined =
      timeoutMs > 0
        ? setTimeout(() => {
            if (stdoutCapped) return;
            timedOut = true;
            killSoon();
            releaseChildHandles();
            finish({
              outcome: 'error',
              message: `If Command timed out after ${timeoutMs}ms.`,
              stdout: getCapturedStdout(),
              stderr: getCapturedStderr(),
            });
          }, timeoutMs)
        : undefined;

    let abortListener: (() => void) | undefined;
    if (args.signal) {
      abortListener = (): void => {
        if (stdoutCapped) return;
        killSoon();
        releaseChildHandles();
        finish({
          outcome: 'error',
          message: 'If Command aborted.',
          stdout: getCapturedStdout(),
          stderr: getCapturedStderr(),
        });
      };
      if (args.signal.aborted) {
        abortListener();
      } else {
        args.signal.addEventListener('abort', abortListener, { once: true });
      }
    }

    child.on('error', (err) => {
      finish({
        outcome: 'error',
        message: String(err),
        stdout: getCapturedStdout(),
        stderr: getCapturedStderr(),
      });
    });

    child.on('close', (code) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (timedOut || stdoutCapped) return;
      const stdout = getCapturedStdout();
      if (code === 0) {
        finish({ outcome: 'run', stdout, stderr: getCapturedStderr() });
      } else {
        finish({
          outcome: 'skip',
          exitCode: code ?? 1,
          stdout,
          stderr: getCapturedStderr(),
        });
      }
    });
  });
}
