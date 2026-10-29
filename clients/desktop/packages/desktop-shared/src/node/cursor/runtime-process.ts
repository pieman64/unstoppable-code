import { spawn } from 'node:child_process';
import { terminateProcessTree } from './process-tree';
import type { CursorLaunch } from './runtime-launch';

/** Bounded Cursor setup command; cancellation always drains its owned process group. */
export function runCursorRuntimeCommand(
  launch: CursorLaunch,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onOutput?: (output: string) => void,
): Promise<{ code: number | null; stdout: string }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(
      launch.command,
      [...launch.prefix, '--disable-auto-update', ...args],
      {
        env,
        // Windows has no process groups; its tree is reclaimed with
        // taskkill /T, and detaching there would only risk a console window.
        detached: process.platform !== 'win32',
        // Electron main is a GUI process on Windows, so spawning the
        // console-subsystem node.exe would flash a console window.
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    // Retain only a bounded tail of stdout. `login` may print status text for
    // minutes while it waits on the browser, and every reader (the sign-in URL
    // matcher, the version and status parsers) only needs recent output.
    const MAX_RETAINED_BYTES = 32 * 1024;
    const chunks: Buffer[] = [];
    let retainedBytes = 0;
    let stdout = '';
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      if (!child.pid) return;
      terminateProcessTree(child.pid, 'SIGTERM');
      killTimer ??= setTimeout(() => {
        terminateProcessTree(child.pid, 'SIGKILL');
      }, 1_000);
    };
    const abort = (): void => {
      failure = new Error('Cursor setup stopped.');
      stop();
    };
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      failure = error;
      // A failed spawn has no pid and may never emit 'close'; settle here so
      // callers (including quit-time shutdown) are not left pending.
      if (!child.pid) finish(null);
    });
    child.stdout.on('data', (data: Buffer) => {
      chunks.push(data);
      retainedBytes += data.length;
      while (retainedBytes > MAX_RETAINED_BYTES) {
        const oldest = chunks[0];
        if (!oldest) break;
        const excess = retainedBytes - MAX_RETAINED_BYTES;
        if (oldest.length <= excess) {
          chunks.shift();
          retainedBytes -= oldest.length;
        } else {
          chunks[0] = oldest.subarray(excess);
          retainedBytes -= excess;
        }
      }
      stdout = Buffer.concat(chunks).toString('utf8');
      try {
        onOutput?.(stdout);
      } catch {
        failure = new Error(
          'Cursor sign-in could not open. Try connecting again.',
        );
        stop();
      }
    });
    // Drain stderr but never log credential/login output.
    child.stderr.resume();
    let settled = false;
    // Hoisted so the spawn 'error' handler above never depends on ordering.
    function finish(code: number | null): void {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (killTimer) {
        clearTimeout(killTimer);
        terminateProcessTree(child.pid, 'SIGKILL');
      }
      if (failure || signal.aborted)
        reject(failure ?? new Error('Cursor setup stopped.'));
      else resolve({ code, stdout });
    }
    child.once('close', (code) => finish(code));
    if (signal.aborted) abort();
  });
}

/** Drain an owned detached group, even if its parent exits before its children. */
export async function stopCursorProcessGroup(
  pid: number | undefined,
  closed: Promise<void> | undefined,
): Promise<void> {
  const signalGroup = (signal: NodeJS.Signals): void => {
    terminateProcessTree(pid, signal);
  };
  signalGroup('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed ?? Promise.resolve(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1500);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // Parent closure does not imply group closure: terminate surviving tools
    // before reporting the turn idle or removing its private hook directory.
    signalGroup('SIGKILL');
  }
  await closed;
}

/** Where a desktop user reinstalls the pinned runtime. */
export const DESKTOP_CURSOR_REINSTALL_GUIDANCE =
  'Reconnect Cursor in Settings to reinstall the pinned runtime.';

/** Safe probe metadata. Never includes the environment, paths or CLI output. */
export interface CursorVersionProbeDiagnostic {
  outcome:
    | 'verified'
    | 'cancelled'
    | 'timeout'
    | 'spawn-error'
    | 'process-exit'
    | 'empty-output'
    | 'output-limit'
    | 'version-mismatch';
  attempt: number;
  timeoutMs: number;
  elapsedMs: number;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  errorCode?: string;
}

/**
 * Refuse any runtime whose `--version` is not the pinned string.
 *
 * `recovery` says where the caller's user fixes it: desktop Settings for the
 * app, the desktop app itself for the CLI, which reuses that installation.
 */
export async function verifyCursorRuntimeVersion(
  launch: CursorLaunch,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  expectedVersion: string,
  recovery: string = DESKTOP_CURSOR_REINSTALL_GUIDANCE,
  onDiagnostic?: (diagnostic: CursorVersionProbeDiagnostic) => void,
): Promise<void> {
  // A cold CLI launch may exceed ten seconds during worktree setup. Retry only
  // the read-only version probe, after its process closes, with more time.
  for (let index = 0; index < 2; index++) {
    const timeoutMs = index === 0 ? 10_000 : 30_000;
    const startedAt = Date.now();
    const probe = await new Promise<CursorVersionProbeDiagnostic>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let failure: CursorVersionProbeDiagnostic['outcome'] | undefined;
      let errorCode: string | undefined;
      const finish = (
        outcome: CursorVersionProbeDiagnostic['outcome'],
        exitCode?: number | null,
        exitSignal?: NodeJS.Signals | null,
      ): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        timeout = undefined;
        signal.removeEventListener('abort', abort);
        resolve({
          outcome: signal.aborted ? 'cancelled' : outcome,
          attempt: index + 1,
          timeoutMs,
          elapsedMs: Date.now() - startedAt,
          exitCode,
          exitSignal,
          errorCode,
        });
      };
      // Function declarations allow the pre-spawn cancellation path to settle
      // without registering an abort listener or starting any process.
      function abort(): void {
        failure = 'cancelled';
        terminateProcessTree(child.pid, 'SIGKILL');
      }
      if (signal.aborted) {
        finish('cancelled');
        return;
      }
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(
          launch.command,
          [...launch.prefix, '--disable-auto-update', '--version'],
          {
            env,
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        );
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'string'
        )
          errorCode = error.code;
        finish('spawn-error');
        return;
      }
      let stdout = '';
      const stop = (outcome: 'timeout' | 'output-limit'): void => {
        failure ??= outcome;
        terminateProcessTree(child.pid, 'SIGKILL');
      };
      timeout = setTimeout(() => stop('timeout'), timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      child.stdout?.on('data', (chunk: Buffer): void => {
        if (failure) return;
        if (Buffer.byteLength(stdout) + chunk.length > 16_384) {
          stop('output-limit');
          return;
        }
        stdout += chunk.toString();
      });
      child.once('error', (error): void => {
        failure ??= 'spawn-error';
        if ('code' in error && typeof error.code === 'string')
          errorCode = error.code;
        if (!child.pid) finish(failure);
      });
      child.once('close', (code, exitSignal): void => {
        const version = stdout.trim();
        finish(
          failure ??
            (code !== 0
              ? 'process-exit'
              : !version
                ? 'empty-output'
                : version !== expectedVersion
                  ? 'version-mismatch'
                  : 'verified'),
          code,
          exitSignal,
        );
      });
      if (signal.aborted) abort();
    });
    if (probe.outcome !== 'verified' || index > 0) {
      try {
        onDiagnostic?.(probe);
      } catch {
        // Diagnostics must not change verification or cancellation behavior.
      }
    }
    if (signal.aborted || probe.outcome === 'cancelled')
      throw new Error('Cursor version check cancelled.');
    if (probe.outcome === 'timeout' && index === 0) continue;
    switch (probe.outcome) {
      case 'verified':
        return;
      case 'timeout':
        throw new Error(
          'The Cursor version check timed out. Try again when workspace setup has finished.',
        );
      case 'spawn-error':
        throw new Error("Couldn't start the Cursor version check. Try again.");
      case 'process-exit':
        throw new Error(
          'The Cursor version check exited before it completed. Try again.',
        );
      case 'empty-output':
        throw new Error("Couldn't read the Cursor version. Try again.");
      case 'output-limit':
        throw new Error(
          'The Cursor version check returned too much output. Try again.',
        );
      case 'version-mismatch':
        throw new Error(
          `Cursor CLI ${expectedVersion} is required. ${recovery}`,
        );
    }
  }
}
