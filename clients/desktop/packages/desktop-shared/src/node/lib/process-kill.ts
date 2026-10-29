import { execFile, spawn, type ChildProcess } from 'node:child_process';

/**
 * Starts `taskkill` for a Windows process tree without waiting for it.
 *
 * Callers run on the Electron main thread, which must never wait on another
 * process: a synchronous taskkill stops every window responding until the
 * tree walk returns. Detached, so a kill issued while the app quits still
 * finishes after it exits. `onFailure` runs at most once, when taskkill cannot
 * start or exits unsuccessfully.
 */
export function startWindowsProcessTreeKill(
  pid: number,
  force: boolean,
  onFailure: () => void,
): void {
  const args = ['/pid', String(pid), '/t'];
  if (force) {
    args.push('/f');
  }
  let failed = false;
  const fail = (): void => {
    if (failed) return;
    failed = true;
    try {
      onFailure();
    } catch {
      // The fallback is best effort; the target may already be gone.
    }
  };
  let taskkill: ChildProcess;
  try {
    taskkill = spawn('taskkill', args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    fail();
    return;
  }
  taskkill.once('error', fail);
  taskkill.once('exit', (code) => {
    if (code !== 0) fail();
  });
}

export async function killProcessGroupByPid(
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
  options: { timeoutMs?: number } = {},
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/t'];
    if (signal === 'SIGKILL') {
      args.push('/f');
    }
    const terminated = await new Promise<boolean>((resolve) => {
      try {
        execFile(
          'taskkill',
          args,
          { windowsHide: true, timeout: options.timeoutMs },
          (error) => {
            resolve(error === null);
          },
        );
      } catch {
        resolve(false);
      }
    });
    if (terminated) {
      return;
    }
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
  }
}

export function killChildProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  if (child.pid === undefined) {
    return;
  }

  if (process.platform === 'win32') {
    startWindowsProcessTreeKill(child.pid, signal === 'SIGKILL', () =>
      child.kill(signal),
    );
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      return;
    }
  }
}
