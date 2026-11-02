import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TSX_EXEC_ARGV } from '../../../ledger/__tests__/fixtures/tsx-worker-threads';

/*
 * Crash-kill trials: a child process writes a store through its production
 * writer and is SIGKILLed mid-write or right after a write resolves; the test
 * then classifies what the store left on disk. A process kill leaves the OS
 * page cache intact, so a pass is process-crash evidence only, never
 * evidence of durability across power loss.
 */

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..', '..');
const CHILD = join(__dirname, 'crash-child.fixture.ts');
const GUARD_TIMEOUT_MS = 60_000;

export const CRASH_WORKSPACE_ID = 'ws-crash-kill';

const CRASH_STORES = ['approvals', 'preferences'] as const;
export type CrashStore = (typeof CRASH_STORES)[number];

export function isCrashStore(value: unknown): value is CrashStore {
  return CRASH_STORES.some((store) => store === value);
}

/**
 * Trials per store and mode: small by default so the suite stays fast;
 * `CRASH_KILL_TRIALS` raises it for a qualification run.
 */
export function crashTrialCount(defaultCount: number): number {
  const configured = Number(process.env.CRASH_KILL_TRIALS);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : defaultCount;
}

export interface CrashTrial {
  store: CrashStore;
  /** `loop` kills `killAfterMs` after the first write; `ack` right after one write resolves. */
  mode: 'loop' | 'ack';
  dataDir: string;
  token: string;
  killAfterMs?: number;
}

export interface CrashTrialResult {
  /** The store's file, as the child's production code names it. */
  file: string | undefined;
  /** Whether the child reported READY (`loop`) or ACK (`ack`) before it died. */
  reported: boolean;
  signal: NodeJS.Signals | null;
  code: number | null;
  stderr: string;
}

/** Runs one trial; resolves once the child has exited. */
export function runCrashTrial(trial: CrashTrial): Promise<CrashTrialResult> {
  return new Promise((resolveTrial, reject) => {
    const child = spawn(
      process.execPath,
      [...TSX_EXEC_ARGV, CHILD, trial.mode, trial.store, trial.token],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          CANOPY_DATA_DIR: trial.dataDir,
          CANOPY_SECURE_DATA_DIR: join(trial.dataDir, '..', 'secure'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let file: string | undefined;
    let reported = false;
    let stdout = '';
    let stderr = '';
    const kill = (): void => {
      child.kill('SIGKILL');
    };
    const guard = setTimeout(kill, GUARD_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string): void => {
      stderr = `${stderr}${chunk}`.slice(-400);
    });
    child.stdout.on('data', (chunk: string): void => {
      stdout += chunk;
      if (reported) return;
      // A complete line only: a chunk can end mid-path.
      const line = /^(READY|ACK \S+) (.+)\n/m.exec(stdout);
      if (!line) return;
      reported = true;
      file = line[2];
      if (trial.mode === 'ack') kill();
      else setTimeout(kill, trial.killAfterMs ?? 0);
    });
    child.once('error', (error) => {
      clearTimeout(guard);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(guard);
      resolveTrial({ file, reported, signal, code, stderr });
    });
  });
}

export type StoreFileState =
  | 'missing'
  | `unreadable:${string}`
  | 'empty'
  | 'torn'
  | 'invalid'
  | 'wrong-version'
  | 'valid-token-missing'
  | 'valid';

/**
 * What a JSON store file holds: `valid` is a parsed object at
 * `expectedVersion` (when given) that contains `token` (when given).
 */
export async function classifyStoreFile(
  file: string,
  expected: { version?: number; token?: string } = {},
): Promise<StoreFileState> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : 'unknown';
    return code === 'ENOENT' ? 'missing' : `unreadable:${code}`;
  }
  if (raw.trim() === '') return 'empty';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'torn';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'invalid';
  }
  if (
    expected.version !== undefined &&
    (!('version' in parsed) || parsed.version !== expected.version)
  ) {
    return 'wrong-version';
  }
  if (expected.token !== undefined && !raw.includes(expected.token)) {
    return 'valid-token-missing';
  }
  return 'valid';
}
