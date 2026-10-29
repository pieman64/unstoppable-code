import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TERMINATION_GRACE_MS = 750;
const PROCESS_LIST_TIMEOUT_MS = 5_000;
const POSIX_COMMAND_READ_CONCURRENCY = 16;

export interface ProcessRow {
  pid: number;
  parentPid: number;
  command: string;
}

interface WorktreeProcessCleanupOps {
  listProcesses(): Promise<ProcessRow[]>;
  protectedPids(rows: readonly ProcessRow[]): Set<number>;
  kill(pid: number, signal: NodeJS.Signals): void;
  isAlive(pid: number): boolean;
  delay(ms: number): Promise<void>;
  resolveRealPath(path: string): Promise<string>;
}

export async function readPosixProcessRows(
  pidOutput: string,
  readProcess: (pid: number) => Promise<string>,
): Promise<ProcessRow[]> {
  const pids = pidOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number);
  const rows: Array<ProcessRow | undefined> = pids.map(() => undefined);
  let nextIndex = 0;
  const readNext = async (): Promise<void> => {
    while (nextIndex < pids.length) {
      const index = nextIndex;
      nextIndex += 1;
      const expectedPid = pids[index];
      try {
        const output = await readProcess(expectedPid);
        const lineEnd = output.search(/[\r\n]/);
        const firstLine = lineEnd >= 0 ? output.slice(0, lineEnd) : output;
        const continuation =
          lineEnd >= 0 ? output.slice(lineEnd).replace(/^[\r\n]+/, '') : '';
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(firstLine);
        if (!match || Number(match[1]) !== expectedPid) continue;
        const command = `${match[3]} ${continuation}`
          .replace(/[\r\n\t]+/g, ' ')
          .trim();
        rows[index] = {
          pid: expectedPid,
          parentPid: Number(match[2]),
          command,
        };
      } catch {
        // The process may exit between the PID snapshot and its detail read.
      }
    }
  };
  const workerCount = Math.min(POSIX_COMMAND_READ_CONCURRENCY, pids.length);
  await Promise.all(Array.from({ length: workerCount }, () => readNext()));
  return rows.filter((row): row is ProcessRow => row !== undefined);
}

async function listProcesses(): Promise<ProcessRow[]> {
  if (process.platform === 'win32') {
    const script = buildWindowsProcessListScript();
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        encoding: 'utf8',
        timeout: PROCESS_LIST_TIMEOUT_MS,
      },
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const [pid, parentPid, ...command] = line.split('\t');
        return /^\d+$/.test(pid) && /^\d+$/.test(parentPid)
          ? [
              {
                pid: Number(pid),
                parentPid: Number(parentPid),
                command: command.join('\t'),
              },
            ]
          : [];
      });
  }
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid='], {
    encoding: 'utf8',
    timeout: PROCESS_LIST_TIMEOUT_MS,
  });
  return readPosixProcessRows(stdout, async (pid) => {
    const result = await execFileAsync(
      'ps',
      ['-ww', '-p', String(pid), '-o', 'pid=,ppid=,command='],
      { encoding: 'utf8', timeout: PROCESS_LIST_TIMEOUT_MS },
    );
    return result.stdout;
  });
}

export function buildWindowsProcessListScript(): string {
  return [
    'Get-CimInstance Win32_Process | ForEach-Object {',
    '  $command = [string]$_.CommandLine -replace "`r|`n|`t", " "',
    '  Write-Output ("{0}`t{1}`t{2}" -f $_.ProcessId, $_.ParentProcessId, $command)',
    '}',
  ].join('\n');
}

export function protectedPidsForCurrentProcess(
  rows: readonly ProcessRow[],
  currentPid = process.pid,
): Set<number> {
  const protectedPids = new Set<number>([currentPid]);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const descendants = new Set<number>([currentPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.parentPid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        protectedPids.add(row.pid);
        changed = true;
      }
    }
  }

  let cursor = byPid.get(currentPid);
  while (
    cursor &&
    cursor.parentPid > 0 &&
    !protectedPids.has(cursor.parentPid)
  ) {
    protectedPids.add(cursor.parentPid);
    cursor = byPid.get(cursor.parentPid);
  }
  return protectedPids;
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Best effort: processes can exit between enumeration and signaling.
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === 'EPERM';
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && 'code' in error && typeof error.code === 'string'
  );
}

const defaultOps: WorktreeProcessCleanupOps = {
  listProcesses,
  protectedPids: protectedPidsForCurrentProcess,
  kill: defaultKill,
  isAlive: defaultIsAlive,
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  resolveRealPath: realpath,
};

export async function resolveCleanupWorktreePaths(
  worktreePath: string,
  resolveRealPath: (path: string) => Promise<string> = realpath,
): Promise<string[]> {
  const absolutePath = resolve(worktreePath);
  try {
    const [resolvedPath, resolvedParent] = await Promise.all([
      resolveRealPath(absolutePath),
      resolveRealPath(dirname(absolutePath)),
    ]);
    const expectedPath = resolve(resolvedParent, basename(absolutePath));
    const normalize = (value: string): string =>
      process.platform === 'win32' ? value.toLowerCase() : value;
    return normalize(resolvedPath) === normalize(expectedPath)
      ? Array.from(new Set([worktreePath, resolvedPath]))
      : [worktreePath];
  } catch {
    return [worktreePath];
  }
}

export function selectProcessesReferencingPath(
  rows: readonly ProcessRow[],
  worktreePaths: string | readonly string[],
  protectedPids: ReadonlySet<number>,
): number[] {
  const paths: readonly string[] =
    typeof worktreePaths === 'string' ? [worktreePaths] : worktreePaths;
  const normalize = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  const normalizedPaths = paths.map(normalize);
  const referencesWorktree = (rawCommand: string): boolean => {
    const command = normalize(rawCommand);
    return normalizedPaths.some((candidate) => {
      let offset = command.indexOf(candidate);
      while (offset >= 0) {
        const previous = command[offset - 1];
        const next = command[offset + candidate.length];
        const hasLeadingBoundary =
          previous === undefined || /[\s=\\"']/.test(previous);
        const hasTrailingBoundary =
          next === undefined || /[\s/\\"']/.test(next);
        if (hasLeadingBoundary && hasTrailingBoundary) return true;
        offset = command.indexOf(candidate, offset + 1);
      }
      return false;
    });
  };
  const selected = new Set(
    rows
      .filter(
        (row) => !protectedPids.has(row.pid) && referencesWorktree(row.command),
      )
      .map((row) => row.pid),
  );
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const depth = (pid: number): number => {
    let value = 0;
    let cursor = byPid.get(pid);
    const seen = new Set<number>();
    while (cursor && selected.has(cursor.parentPid) && !seen.has(cursor.pid)) {
      seen.add(cursor.pid);
      value += 1;
      cursor = byPid.get(cursor.parentPid);
    }
    return value;
  };
  return Array.from(selected).sort((left, right) => depth(right) - depth(left));
}

export async function terminateProcessesReferencingPath(
  worktreePath: string,
  overrides: Partial<WorktreeProcessCleanupOps> = {},
): Promise<number> {
  const ops = { ...defaultOps, ...overrides };
  const rows = await ops.listProcesses();
  const worktreePaths = await resolveCleanupWorktreePaths(
    worktreePath,
    ops.resolveRealPath,
  );
  const pids = selectProcessesReferencingPath(
    rows,
    worktreePaths,
    ops.protectedPids(rows),
  );
  const initialRows = new Map(rows.map((row) => [row.pid, row]));
  for (const pid of pids) ops.kill(pid, 'SIGTERM');
  if (pids.length === 0) return 0;
  await ops.delay(TERMINATION_GRACE_MS);
  const remainingRows = new Map(
    (await ops.listProcesses()).map((row) => [row.pid, row]),
  );
  for (const pid of pids) {
    const initial = initialRows.get(pid);
    const remaining = remainingRows.get(pid);
    if (
      initial &&
      remaining &&
      initial.command === remaining.command &&
      ops.isAlive(pid)
    ) {
      ops.kill(pid, 'SIGKILL');
    }
  }
  return pids.length;
}
