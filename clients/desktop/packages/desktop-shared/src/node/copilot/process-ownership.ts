import { execFile, type ChildProcess } from 'node:child_process';

// x64 PowerShell under Windows-on-ARM emulation took up to 4.6 s to query CIM.
const WINDOWS_PROCESS_INSPECTION_TIMEOUT_MS = 5000;
// Longer than the awaited cleanup deadline on purpose: a kill that outlives its
// cleanup step can still finish in the background.
const WINDOWS_PROCESS_KILL_TIMEOUT_MS = 3000;

/**
 * Node defers only EACCES, EAGAIN, EMFILE, ENFILE and ENOENT to an execFile
 * callback and throws any other spawn errno (EBADF, for one) synchronously.
 * Report a throw through the same callback, synchronously inside the caller's
 * Promise executor, so every caller keeps its own failure handling. Callers
 * replace the error with their own message, so any other throw is reported the
 * same way.
 */
function startCommand<T>(
  start: () => T,
  callback: (error: Error, output: string) => void,
): T | undefined {
  try {
    return start();
  } catch (error) {
    callback(
      error instanceof Error ? error : new Error('Command could not start.'),
      '',
    );
    return undefined;
  }
}

/** Keep the OS error behind a friendly message for diagnostics. */
function failure(message: string, cause: Error): Error {
  const error = new Error(message);
  // Non-enumerable like a native cause, so serialized errors omit the command.
  Object.defineProperty(error, 'cause', {
    value: cause,
    configurable: true,
    writable: true,
  });
  return error;
}

const errno = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  if ('code' in value && typeof value.code === 'string')
    return 'syscall' in value && typeof value.syscall === 'string'
      ? `${value.syscall} ${value.code}`
      : value.code;
  // A timed-out or killed command reports its signal instead of an errno.
  return 'signal' in value && typeof value.signal === 'string'
    ? value.signal
    : undefined;
};

/** The OS error behind a Copilot process failure, such as `spawn EBADF`. */
export function describeCopilotProcessFailure(
  error: unknown,
): string | undefined {
  return (
    errno(error) ??
    (error && typeof error === 'object' && 'cause' in error
      ? errno(error.cause)
      : undefined)
  );
}

/** Signal only a live owned child; never fall back from a missing group to a bare PID. */
export async function killCopilotProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const settle = (error: Error | null): void => {
        if (error && child.exitCode === null && child.signalCode === null)
          reject(failure('Copilot process termination failed.', error));
        else resolve();
      };
      startCommand(
        () =>
          execFile(
            'taskkill',
            ['/pid', String(pid), '/t', '/f'],
            { windowsHide: true, timeout: WINDOWS_PROCESS_KILL_TIMEOUT_MS },
            settle,
          ),
        settle,
      );
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'ESRCH'
    )
      throw error;
  }
}

/** A failed OS kill or disconnected SDK must not leave its owner waiting forever. */
export async function withCopilotCleanupDeadline<T>(
  operation: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Copilot process cleanup did not finish.')),
          1500,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ProcessIdentity {
  pid: number;
  parent: number;
  group: number;
  started: string;
}

function processes(): Promise<ProcessIdentity[]> {
  if (process.platform === 'win32') {
    return new Promise((resolve, reject) => {
      const settle = (error: Error | null, output: string): void => {
        if (error) {
          reject(
            failure('Copilot process ownership could not be inspected.', error),
          );
          return;
        }
        resolve(
          output.split('\n').flatMap((line) => {
            const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
            return match
              ? [
                  {
                    pid: Number(match[1]),
                    parent: Number(match[2]),
                    group: 0,
                    started: match[3],
                  },
                ]
              : [];
          }),
        );
      };
      startCommand(
        () =>
          execFile(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff', [Globalization.CultureInfo]::InvariantCulture) } }",
            ],
            {
              windowsHide: true,
              timeout: WINDOWS_PROCESS_INSPECTION_TIMEOUT_MS,
              maxBuffer: 4 * 1024 * 1024,
              encoding: 'utf8',
            },
            settle,
          ),
        settle,
      );
    });
  }
  return new Promise((resolve, reject) => {
    const settle = (error: Error | null, output: string): void => {
      if (error) {
        reject(
          failure('Copilot process ownership could not be inspected.', error),
        );
        return;
      }
      resolve(
        output.split('\n').flatMap((line) => {
          const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
          return match
            ? [
                {
                  pid: Number(match[1]),
                  parent: Number(match[2]),
                  group: Number(match[3]),
                  started: match[4],
                },
              ]
            : [];
        }),
      );
    };
    startCommand(
      () =>
        execFile(
          '/bin/ps',
          ['-axo', 'pid=,ppid=,pgid=,lstart='],
          {
            timeout: 2000,
            maxBuffer: 4 * 1024 * 1024,
            encoding: 'utf8',
            // Receipts must compare across launches with different locale/TZ.
            env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
          },
          settle,
        ),
      settle,
    );
  });
}

/** Capture while the owned CLI still exists, before shutdown can orphan a PTY group. */
export async function snapshotCopilotDescendants(
  pid: number,
  includeRoot = false,
): Promise<readonly ProcessIdentity[]> {
  const rows = await processes();
  const root = rows.find((row) => row.pid === pid);
  if (!root) return [];
  const children = new Map<number, ProcessIdentity[]>();
  for (const row of rows)
    children.set(row.parent, [...(children.get(row.parent) ?? []), row]);
  const found: ProcessIdentity[] = includeRoot ? [root] : [];
  const queue = [pid];
  const seen = new Set(queue);
  const parentStarts = new Map([[pid, root.started]]);
  for (let index = 0; index < queue.length; index++) {
    for (const child of children.get(queue[index]) ?? []) {
      if (seen.has(child.pid)) continue;
      // Windows preserves dead parents' PIDs on orphans. Reject a stale
      // link before trusting this process or walking any of its descendants.
      const parentStarted = parentStarts.get(queue[index]);
      if (
        process.platform === 'win32' &&
        (!parentStarted || child.started < parentStarted)
      )
        continue;
      seen.add(child.pid);
      parentStarts.set(child.pid, child.started);
      queue.push(child.pid);
      found.push(child);
    }
  }
  return found;
}

/** Never signal a reused PID: require the observed creation time to still match. */
export async function terminateCopilotDescendants(
  owned: readonly ProcessIdentity[],
): Promise<void> {
  if (!owned.length) return;
  if (process.platform === 'win32') {
    // One bounded query, retaining Process handles from identity verification
    // through Kill. Never taskkill an old PID after its parent has exited.
    const identities = [...owned].reverse().map((row) => {
      if (
        !Number.isSafeInteger(row.pid) ||
        row.pid <= 0 ||
        !/^\d+$/.test(row.started)
      )
        throw new Error('Copilot process ownership is invalid.');
      return `@{Id=${row.pid};Started='${row.started}'}`;
    });
    // With -Command, Windows PowerShell exits 1 whenever its last statement
    // failed, and a silenced Get-Process on a PID that taskkill already reaped
    // counts. Only a terminating error may report the kill as failed. A process
    // whose handle or start time cannot be read is skipped deliberately: it is
    // either a reused PID or an owned descendant this user could not kill
    // anyway. A kill that races the process's own exit counts as success.
    const script = `$ErrorActionPreference = 'Stop'; foreach ($identity in @(${identities.join(',')})) { $p = Get-Process -Id $identity.Id -ErrorAction SilentlyContinue; if ($p) { try { try { $null = $p.Handle; $started = $p.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssffffff', [Globalization.CultureInfo]::InvariantCulture) } catch { $started = $null }; if ($started -eq $identity.Started -and !$p.HasExited) { try { $p.Kill() } catch { if (!$p.WaitForExit(500)) { throw } } } } finally { $p.Dispose() } } }; exit 0\n`;
    await new Promise<void>((resolve, reject) => {
      const settle = (error: Error | null): void =>
        error
          ? reject(failure('Copilot process termination failed.', error))
          : resolve();
      const command = startCommand(
        () =>
          execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', '-'],
            { windowsHide: true, timeout: WINDOWS_PROCESS_KILL_TIMEOUT_MS },
            settle,
          ),
        settle,
      );
      command?.stdin?.on('error', () => undefined);
      command?.stdin?.end(script);
    });
    return;
  }
  const current = new Map((await processes()).map((row) => [row.pid, row]));
  for (const ownedProcess of [...owned].reverse()) {
    const actual = current.get(ownedProcess.pid);
    if (!actual || actual.started !== ownedProcess.started) continue;
    try {
      // A separate group led by our descendant is owned too; an inherited
      // group may include the parent host, so only signal that child itself.
      process.kill(
        actual.group === actual.pid ? -actual.pid : actual.pid,
        'SIGKILL',
      );
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'ESRCH'
      )
        throw error;
    }
  }
}

/** Re-read identities after a kill; mismatches are gone, not ours to signal. */
export async function remainingCopilotProcesses(
  owned: readonly ProcessIdentity[],
): Promise<readonly ProcessIdentity[]> {
  if (!owned.length) return [];
  const rows = new Map(
    (await processes()).map((row) => [row.pid, row.started]),
  );
  return owned.filter((row) => rows.get(row.pid) === row.started);
}
