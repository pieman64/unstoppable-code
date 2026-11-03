import { runCommandGate } from '../lib/script-execution';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_STDOUT_BYTES = 256 * 1024;

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
 * Run an automation If Command gate through the local worker's script
 * execution (CAN-4143). stdout is captured separately from stderr so the
 * injected variable carries clean command output only. Runs in the App
 * Advisor home directory with the enhanced (login-shell) PATH; an explicit
 * `cwd` or `env` runs it in this process's worker with exactly those.
 */
export async function runAutomationIfCommand(args: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<AutomationIfCommandResult> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stop = new AbortController();
  let stdoutCapped = false;
  let totalBytes = 0;
  let stderrBytes = 0;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const getCapturedStdout = (): string =>
    Buffer.concat(stdoutChunks).toString('utf8').trim();
  const getCapturedStderr = (): string =>
    Buffer.concat(stderrChunks).toString('utf8').trim();

  return await new Promise<AutomationIfCommandResult>((resolve) => {
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const finish = (result: AutomationIfCommandResult): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (args.signal && abortListener) {
        args.signal.removeEventListener('abort', abortListener);
      }
      resolve(result);
    };
    // The gate settles at once; the worker ends the process behind it.
    const finishEarly = (result: AutomationIfCommandResult): void => {
      finish(result);
      stop.abort();
    };

    const onData = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      if (settled) return;
      if (stream === 'stderr') {
        const remaining = MAX_STDOUT_BYTES - stderrBytes;
        if (remaining > 0) {
          const slice = chunk.subarray(0, remaining);
          stderrChunks.push(slice);
          stderrBytes += slice.length;
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
        finishEarly({
          outcome: 'run',
          stdout: getCapturedStdout(),
          stderr: getCapturedStderr(),
        });
      }
    };

    if (timeoutMs > 0)
      timeoutTimer = setTimeout(() => {
        if (stdoutCapped) return;
        finishEarly({
          outcome: 'error',
          message: `If Command timed out after ${timeoutMs}ms.`,
          stdout: getCapturedStdout(),
          stderr: getCapturedStderr(),
        });
      }, timeoutMs);

    if (args.signal) {
      abortListener = (): void => {
        if (stdoutCapped) return;
        finishEarly({
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

    runCommandGate({
      command: args.command,
      ...(args.cwd !== undefined || args.env !== undefined
        ? { place: { cwd: args.cwd, env: args.env } }
        : {}),
      signal: stop.signal,
      onData,
    }).then(
      (ended) => {
        if (ended.failure !== null) {
          finish({
            outcome: 'error',
            message: ended.output,
            stdout: getCapturedStdout(),
            stderr: getCapturedStderr(),
          });
          return;
        }
        const stdout = getCapturedStdout();
        if (ended.exitCode === 0) {
          finish({ outcome: 'run', stdout, stderr: getCapturedStderr() });
        } else {
          finish({
            outcome: 'skip',
            exitCode: ended.exitCode ?? 1,
            stdout,
            stderr: getCapturedStderr(),
          });
        }
      },
      (error: unknown) => {
        finish({
          outcome: 'error',
          message: String(error),
          stdout: getCapturedStdout(),
          stderr: getCapturedStderr(),
        });
      },
    );
  });
}
