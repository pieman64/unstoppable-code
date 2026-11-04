import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { TSX_EXEC_ARGV } from '../../../ledger/__tests__/fixtures/tsx-worker-threads';

/*
 * Runs `scope-child.fixture.ts` as a separate Node process, so a test can
 * write one memory scope from two processes, or kill a writer part way.
 */

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..', '..');
const CHILD = join(__dirname, 'scope-child.fixture.ts');
const GUARD_TIMEOUT_MS = 60_000;

export interface ScopeChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface ScopeChild {
  process: ChildProcess;
  /** Resolves once the child printed `line` (or exited without it). */
  printed(line: string): Promise<boolean>;
  exited: Promise<ScopeChildExit>;
}

export function startScopeChild(args: readonly string[]): ScopeChild {
  const child = spawn(process.execPath, [...TSX_EXEC_ARGV, CHILD, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const waiters: Array<{ line: string; resolve: (seen: boolean) => void }> = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string): void => {
    stdout += chunk;
    for (const waiter of waiters.splice(0)) {
      if (stdout.split('\n').includes(waiter.line)) waiter.resolve(true);
      else waiters.push(waiter);
    }
  });
  child.stderr.on('data', (chunk: string): void => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });
  const guard = setTimeout(() => child.kill('SIGKILL'), GUARD_TIMEOUT_MS);
  const exited = new Promise<ScopeChildExit>((resolveExit, reject) => {
    child.once('error', (error) => {
      clearTimeout(guard);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(guard);
      for (const waiter of waiters.splice(0)) waiter.resolve(false);
      resolveExit({ code, signal, stdout, stderr });
    });
  });
  return {
    process: child,
    exited,
    printed: (line: string): Promise<boolean> =>
      stdout.split('\n').includes(line)
        ? Promise.resolve(true)
        : new Promise((resolveSeen) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolveSeen(false);
              return;
            }
            waiters.push({ line, resolve: resolveSeen });
          }),
  };
}

/** Runs a child to completion; rejects with its output unless it succeeds. */
export async function runScopeChild(args: readonly string[]): Promise<void> {
  const exit = await startScopeChild(args).exited;
  if (exit.code !== 0 || !exit.stdout.includes('DONE')) {
    throw new Error(
      `scope child ${args.join(' ')} failed (${exit.code ?? exit.signal}): ${exit.stderr}`,
    );
  }
}
