import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_RTK_TIMEOUT_MS = 2_000;

/**
 * Provider-neutral RTK rewrite runner shared by the Claude PreToolUse hooks
 * and the Cursor preToolUse hook. RTK is best-effort: every failure path
 * (missing binary, non-zero exit, empty output, timeout, abort) resolves to
 * `undefined` so the caller runs the original command unchanged.
 */
export interface RtkRewriteOptions {
  rtkBinaryPath: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

function buildSpawnEnv(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined {
  if (env === undefined) {
    return undefined;
  }

  const spawnEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      spawnEnv[key] = value;
    }
  }
  return spawnEnv;
}

function trimTrailingNewlines(text: string): string {
  return text.replace(/[\r\n]+$/, '');
}

async function ensureRtkManagedDirs(
  env: Record<string, string | undefined> | undefined,
): Promise<void> {
  const dbPath = env?.RTK_DB_PATH;
  if (typeof dbPath === 'string' && dbPath.length > 0) {
    await mkdir(dirname(dbPath), { recursive: true });
  }

  const teeDir = env?.RTK_TEE_DIR;
  if (typeof teeDir === 'string' && teeDir.length > 0) {
    await mkdir(teeDir, { recursive: true });
  }
}

function terminateChild(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    // Ignore kill failures; RTK is best-effort only.
    return;
  }

  const forceKillTimer = setTimeout((): void => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    try {
      child.kill('SIGKILL');
    } catch {
      // Ignore kill failures; RTK is best-effort only.
    }
  }, 250);

  forceKillTimer.unref();
  child.once('close', (): void => {
    clearTimeout(forceKillTimer);
  });
}

/**
 * Run `<rtk> rewrite <command>` and return the rewritten command line, or
 * `undefined` when RTK declines or fails. Exit 3 means RTK would normally
 * prompt before using the rewrite; the app keeps hooks prompt-free, so the
 * rewrite is accepted directly.
 */
export async function runRtkRewrite(
  command: string,
  options: RtkRewriteOptions,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (signal.aborted) {
    return undefined;
  }

  try {
    await ensureRtkManagedDirs(options.env);
  } catch {
    return undefined;
  }

  if (signal.aborted) {
    return undefined;
  }

  const spawnEnv = buildSpawnEnv(options.env);

  return await new Promise<string | undefined>((resolve) => {
    let settled = false;
    const stdoutChunks: Uint8Array[] = [];
    const timeoutMs = options.timeoutMs ?? DEFAULT_RTK_TIMEOUT_MS;
    const child = spawn(options.rtkBinaryPath, ['rewrite', command], {
      ...(spawnEnv ? { env: spawnEnv } : {}),
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: hostOperatingSystem() === 'win32',
    });

    const finish = (value: string | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };

    const onAbort = (): void => {
      terminateChild(child);
      finish(undefined);
    };

    const timeoutId = setTimeout((): void => {
      terminateChild(child);
      finish(undefined);
    }, timeoutMs);

    signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Uint8Array): void => {
      stdoutChunks.push(chunk);
    });

    child.once('error', (): void => {
      finish(undefined);
    });

    child.once('close', (code: number | null): void => {
      const stdout = trimTrailingNewlines(
        Buffer.concat(stdoutChunks).toString(),
      );
      if (!stdout) {
        finish(undefined);
        return;
      }

      if (code === 0 || code === 3) {
        finish(stdout);
        return;
      }

      finish(undefined);
    });
  });
}
