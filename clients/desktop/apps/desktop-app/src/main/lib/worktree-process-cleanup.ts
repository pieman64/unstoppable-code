import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TERMINATION_GRACE_MS = 750;
const PROCESS_LIST_TIMEOUT_MS = 5_000;
const POSIX_COMMAND_READ_CONCURRENCY = 16;
const EXIT_CHECK_COUNT = 20;
const EXIT_CHECK_DELAY_MS = 25;

export class WorktreeProcessCleanupError extends Error {
  readonly code = 'WORKTREE_WRITERS_ACTIVE';
}

interface LinuxWriterVerificationOps {
  findWriters(paths: readonly string[]): Promise<number[]>;
  delay(ms: number): Promise<void>;
  procFs: LinuxProcFs;
  additionalPaths: readonly string[];
}

interface LinuxProcFs {
  readFile(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
}

const linuxProcFs: LinuxProcFs = {
  readFile: (path) => readFile(path, 'utf8'),
  readlink,
  readdir,
};

function pathReferencesWorktree(
  path: string,
  worktreePaths: readonly string[],
): boolean {
  const entry = path.replace(/ \(deleted\)$/, '');
  return worktreePaths.some(
    (candidate) => entry === candidate || entry.startsWith(`${candidate}/`),
  );
}

async function readProc<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (
      isErrnoException(error) &&
      ['ENOENT', 'ESRCH'].includes(error.code ?? '')
    )
      return undefined;
    throw error;
  }
}

interface CapturedLinuxOwner {
  identity: string;
  worktreeRelated: boolean;
}

interface LinuxWriterTracking {
  owners: Map<number, CapturedLinuxOwner>;
  paths: Set<string>;
  unresolved: boolean;
  activeAttempts: number;
}

const linuxWriterTracking = new AsyncLocalStorage<LinuxWriterTracking>();
const unresolvedLinuxWorktrees = new Map<string, LinuxWriterTracking>();

function createLinuxWriterTracking(): LinuxWriterTracking {
  return {
    owners: new Map(),
    paths: new Set(),
    unresolved: false,
    activeAttempts: 0,
  };
}

/** Keep birth identities through removal and across retries of a failed worktree. */
export async function withLinuxWorktreeWriterTracking<T>(
  run: () => Promise<T>,
  worktreeKey?: string,
): Promise<T> {
  if (hostOperatingSystem() !== 'linux') return run();
  const retained =
    worktreeKey === undefined
      ? undefined
      : unresolvedLinuxWorktrees.get(worktreeKey);
  // A live-state drain can be nested in this worktree's archive lifecycle.
  if (retained !== undefined && linuxWriterTracking.getStore() === retained)
    return run();
  const tracking = retained ?? createLinuxWriterTracking();
  if (worktreeKey !== undefined)
    unresolvedLinuxWorktrees.set(worktreeKey, tracking);
  // A rejected lifecycle keeps its snapshot, even when cancellation failed before
  // verification. No expiry can prove that an orphan has closed its handles.
  tracking.activeAttempts += 1;
  try {
    const result = await linuxWriterTracking.run(tracking, run);
    if (
      worktreeKey !== undefined &&
      tracking.activeAttempts === 1 &&
      !tracking.unresolved &&
      unresolvedLinuxWorktrees.get(worktreeKey) === tracking
    )
      unresolvedLinuxWorktrees.delete(worktreeKey);
    return result;
  } finally {
    tracking.activeAttempts -= 1;
  }
}

async function inspectLinuxWriters(
  paths: readonly string[],
  tracking: LinuxWriterTracking,
  procFs: LinuxProcFs,
): Promise<number[]> {
  for (const path of paths) tracking.paths.add(path);
  tracking.unresolved = true;
  const writers = await findLinuxOwnedWriters(
    [...tracking.paths],
    tracking.owners,
    procFs,
  );
  tracking.unresolved = writers.length > 0;
  return writers;
}

/** Inspect only this app's process tree; unreadable unrelated terminals are not owners. */
async function findLinuxOwnedWriters(
  worktreePaths: readonly string[],
  owners: Map<number, CapturedLinuxOwner>,
  procFs: LinuxProcFs,
): Promise<number[]> {
  const pending: Array<{
    pid: number;
    worktreeRelated: boolean;
    identity?: string;
  }> = [{ pid: process.pid, worktreeRelated: false }];
  const deadline = Date.now() + 2_000;
  // Retain birth identities across reparenting without adopting reused PIDs.
  for (const [pid, owner] of owners) {
    if (Date.now() >= deadline)
      throw new WorktreeProcessCleanupError(
        'App-owned writer inspection exceeded its deadline; cleanup is incomplete.',
      );
    try {
      if ((await readLinuxProcessIdentity(pid, procFs)) === owner.identity)
        pending.push({
          pid,
          worktreeRelated: owner.worktreeRelated,
          identity: owner.identity,
        });
      else owners.delete(pid);
    } catch (error) {
      if (owner.worktreeRelated || !isProcPermissionError(error)) throw error;
    }
  }
  const seen = new Map<number, boolean>();
  const writers = new Set<number>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === undefined) continue;
    const previous = seen.get(candidate.pid);
    if (previous === true || (previous === false && !candidate.worktreeRelated))
      continue;
    const { pid } = candidate;
    if (Date.now() >= deadline)
      throw new WorktreeProcessCleanupError(
        'App-owned writer inspection exceeded its deadline; cleanup is incomplete.',
      );
    const root = `/proc/${pid}`;
    let inspectionFailure: Error | undefined;
    // A denied cwd must not hide readable argv, handles, or terminal ancestry.
    const readEvidence = async <T>(
      read: () => Promise<T>,
    ): Promise<T | undefined> => {
      try {
        return await readProc(read);
      } catch (error) {
        if (!isProcPermissionError(error)) throw error;
        inspectionFailure ??= error;
        return undefined;
      }
    };
    const identity = await readEvidence(() =>
      readLinuxProcessIdentity(pid, procFs),
    );
    if (identity === undefined && inspectionFailure === undefined) continue;
    // A captured PID may be reused between the seed read and this inspection.
    if (candidate.identity !== undefined && identity !== candidate.identity) {
      if (
        inspectionFailure &&
        (candidate.worktreeRelated || pid === process.pid)
      )
        throw inspectionFailure;
      continue;
    }
    const cwd = await readEvidence(() => procFs.readlink(`${root}/cwd`));
    const command = await readEvidence(() =>
      procFs.readFile(`${root}/cmdline`),
    );
    const commandReferencesWorktree =
      command
        ?.split('\0')
        .some((arg) =>
          pathReferencesWorktree(
            arg.slice(arg.indexOf('=') + 1),
            worktreePaths,
          ),
        ) ?? false;
    let worktreeRelated =
      candidate.worktreeRelated || commandReferencesWorktree;
    let writing =
      cwd !== undefined && pathReferencesWorktree(cwd, worktreePaths);
    worktreeRelated ||= writing;
    const handles = await readEvidence(() => procFs.readdir(`${root}/fd`));
    for (const handle of handles ?? []) {
      if (Date.now() >= deadline)
        throw new WorktreeProcessCleanupError(
          'App-owned writer inspection exceeded its deadline; cleanup is incomplete.',
        );
      const target = await readEvidence(() =>
        procFs.readlink(`${root}/fd/${handle}`),
      );
      if (
        target === undefined ||
        !pathReferencesWorktree(target, worktreePaths)
      )
        continue;
      worktreeRelated = true;
      const info = await readEvidence(() =>
        procFs.readFile(`${root}/fdinfo/${handle}`),
      );
      const flags =
        info === undefined ? undefined : /^flags:\s+([0-7]+)/m.exec(info);
      if (flags && (Number.parseInt(flags[1], 8) & 3) !== 0) writing = true;
    }
    const childrenToInspect: number[] = [];
    const tasks = await readEvidence(() => procFs.readdir(`${root}/task`));
    for (const task of tasks ?? []) {
      const children = await readEvidence(() =>
        procFs.readFile(`${root}/task/${task}/children`),
      );
      if (
        children === undefined &&
        !inspectionFailure &&
        (await readEvidence(() =>
          procFs.readFile(`${root}/task/${task}/stat`),
        )) !== undefined
      ) {
        throw new WorktreeProcessCleanupError(
          'Linux process-child inspection is unavailable; cleanup is incomplete.',
        );
      }
      for (const child of children?.trim().split(/\s+/) ?? []) {
        if (/^\d+$/.test(child)) childrenToInspect.push(Number(child));
      }
    }
    let finalIdentity: string | undefined;
    try {
      finalIdentity = await readLinuxProcessIdentity(pid, procFs);
    } catch (error) {
      if (
        !isProcPermissionError(error) ||
        worktreeRelated ||
        pid === process.pid
      )
        throw error;
      continue;
    }
    // Do not retain descriptors or child PIDs read from a recycled process.
    if (
      finalIdentity === undefined ||
      (identity !== undefined && finalIdentity !== identity)
    )
      continue;
    seen.set(pid, worktreeRelated);
    if (identity !== undefined) owners.set(pid, { identity, worktreeRelated });
    for (const child of childrenToInspect)
      pending.push({
        pid: child,
        // Main owns many worktrees. Its open files never implicate every PTY.
        worktreeRelated: pid !== process.pid && worktreeRelated,
      });
    if (writing) {
      writers.add(pid);
    } else if (inspectionFailure && (worktreeRelated || pid === process.pid)) {
      throw inspectionFailure;
    }
  }
  return [...writers];
}

function isProcPermissionError(error: unknown): error is NodeJS.ErrnoException {
  return (
    isErrnoException(error) && ['EACCES', 'EPERM'].includes(error.code ?? '')
  );
}

async function readLinuxProcessIdentity(
  pid: number,
  procFs: LinuxProcFs = linuxProcFs,
): Promise<string | undefined> {
  const stat = await readProc(() => procFs.readFile(`/proc/${pid}/stat`));
  if (stat === undefined) return undefined;
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  // A process can become a zombie between reading stat and opening fd. Linux
  // may deny fd inspection then, but an exited process has no writable handles.
  if (fields[0] === 'Z' || fields[0] === 'X') return undefined;
  return fields[19];
}

/** Capture live owners before cancellation, including writers later reparented. */
export async function captureLinuxWorktreeWriterVerification(
  worktreePath: string,
  procFs: LinuxProcFs = linuxProcFs,
): Promise<() => Promise<void>> {
  if (hostOperatingSystem() !== 'linux') return async (): Promise<void> => {};
  const paths = await resolveCleanupWorktreePaths(worktreePath);
  const tracking =
    linuxWriterTracking.getStore() ?? createLinuxWriterTracking();
  await inspectLinuxWriters(paths, tracking, procFs);
  return async (): Promise<void> => {
    await withLinuxWorktreeRemovalVerification(worktreePath, async () => {}, {
      findWriters: () => inspectLinuxWriters(paths, tracking, procFs),
    });
  };
}

/** A successful unlink on Linux says nothing about an old writable descriptor. */
export async function withLinuxWorktreeRemovalVerification<T>(
  worktreePath: string,
  remove: () => Promise<T>,
  overrides: Partial<LinuxWriterVerificationOps> = {},
): Promise<T> {
  if (hostOperatingSystem() !== 'linux') return remove();
  const paths = (
    await Promise.all(
      [worktreePath, ...(overrides.additionalPaths ?? [])].map((path) =>
        resolveCleanupWorktreePaths(path),
      ),
    )
  )
    .flat()
    .map((path) => resolve(path));
  const tracking =
    linuxWriterTracking.getStore() ?? createLinuxWriterTracking();
  const findWriters =
    overrides.findWriters ??
    ((candidates: readonly string[]): Promise<number[]> =>
      inspectLinuxWriters(
        candidates,
        tracking,
        overrides.procFs ?? linuxProcFs,
      ));
  const delay =
    overrides.delay ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms)));
  const verify = async (removed: boolean): Promise<void> => {
    const deadline = Date.now() + 2_000;
    for (let check = 0; ; check += 1) {
      const writers = await findWriters(paths);
      if (writers.length === 0) return;
      if (check >= EXIT_CHECK_COUNT || Date.now() >= deadline) {
        throw new WorktreeProcessCleanupError(
          removed
            ? `The directory was removed at ${worktreePath}, but app-owned writers are still active (${writers.join(', ')}); cleanup is incomplete.`
            : `The directory was retained at ${worktreePath} because app-owned writers are still active (${writers.join(', ')}).`,
        );
      }
      await delay(EXIT_CHECK_DELAY_MS);
    }
  };
  await verify(false);
  const result = await remove();
  await verify(true);
  return result;
}

export interface ProcessRow {
  pid: number;
  parentPid: number;
  command: string;
}

interface WorktreeProcessCleanupOps {
  currentPid: number;
  listProcesses(): Promise<ProcessRow[]>;
  protectedPids(rows: readonly ProcessRow[]): Set<number>;
  kill(pid: number, signal: NodeJS.Signals): void;
  isAlive(pid: number): boolean | Promise<boolean>;
  processIdentity(pid: number): Promise<string | undefined>;
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
  // Linux removal targets app-owned descendants; only our own process and
  // ancestors must be protected there. Other platforms retain their policy.
  const protectedPids =
    hostOperatingSystem() === 'linux'
      ? new Set([currentPid])
      : descendantPids(rows, currentPid);
  const byPid = new Map(rows.map((row) => [row.pid, row]));

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

function descendantPids(
  rows: readonly ProcessRow[],
  currentPid: number,
): Set<number> {
  const descendants = new Set<number>([currentPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.parentPid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }

  return descendants;
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Best effort: processes can exit between enumeration and signaling.
  }
}

async function defaultIsAlive(pid: number): Promise<boolean> {
  if (hostOperatingSystem() === 'linux') {
    const stat = await readProc(() =>
      linuxProcFs.readFile(`/proc/${pid}/stat`),
    );
    if (stat === undefined) return false;
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[0];
    // A zombie holds no writable descriptors and cannot write again.
    if (state === 'Z' || state === 'X') return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === 'EPERM';
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  );
}

const defaultOps: WorktreeProcessCleanupOps = {
  currentPid: process.pid,
  listProcesses,
  protectedPids: protectedPidsForCurrentProcess,
  kill: defaultKill,
  isAlive: defaultIsAlive,
  processIdentity: (pid) =>
    hostOperatingSystem() === 'linux'
      ? readLinuxProcessIdentity(pid)
      : Promise.resolve(undefined),
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
  const owned = descendantPids(rows, ops.currentPid);
  const pids = selectProcessesReferencingPath(
    rows,
    worktreePaths,
    ops.protectedPids(rows),
  ).filter((pid) => hostOperatingSystem() !== 'linux' || owned.has(pid));
  const initialRows = new Map(rows.map((row) => [row.pid, row]));
  const initialIdentities = new Map(
    await Promise.all(
      pids.map(
        async (pid): Promise<[number, string | undefined]> => [
          pid,
          await ops.processIdentity(pid),
        ],
      ),
    ),
  );
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
      (await ops.isAlive(pid)) &&
      (initialIdentities.get(pid) === undefined ||
        initialIdentities.get(pid) === (await ops.processIdentity(pid)))
    ) {
      ops.kill(pid, 'SIGKILL');
    }
  }
  if (hostOperatingSystem() === 'linux') {
    const deadline = Date.now() + 2_000;
    for (let check = 0; ; check += 1) {
      const alive: number[] = [];
      for (const pid of pids) {
        const initial = initialRows.get(pid);
        const remaining = remainingRows.get(pid);
        if (
          initial &&
          remaining &&
          initial.command === remaining.command &&
          (await ops.isAlive(pid)) &&
          (initialIdentities.get(pid) === undefined ||
            initialIdentities.get(pid) === (await ops.processIdentity(pid)))
        )
          alive.push(pid);
      }
      if (alive.length === 0) break;
      if (check >= EXIT_CHECK_COUNT || Date.now() >= deadline) {
        throw new WorktreeProcessCleanupError(
          `Worktree processes are still alive after termination (${alive.join(', ')}).`,
        );
      }
      await ops.delay(EXIT_CHECK_DELAY_MS);
    }
  }
  return pids.length;
}
