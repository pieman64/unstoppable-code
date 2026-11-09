import { execFile, type ChildProcess } from 'node:child_process';
import { startWindowsProcessTreeKill } from '@canopy/execution-engine/node/lib/process-kill';

function hasErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

/** Only call with a PID owned by a still-tracked process/terminal record. */
export async function drainOwnedProcess(
  pid: number,
  isOwned: () => boolean = () => true,
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error('Invalid owned process id.');
  const assertOwned = (): void => {
    if (!isOwned())
      throw new Error(
        'The tracked process ownership changed before archive cleanup.',
      );
  };
  let ownershipReleased = false;
  const exists = (target: number): boolean => {
    // Once the tracked root reports exit, never probe a potentially reused PID;
    // the root leads its group, so the -pid probe still covers it if alive.
    if (ownershipReleased && target === pid) return false;
    try {
      process.kill(target, 0);
      return true;
    } catch (error) {
      if (hasErrnoCode(error, 'ESRCH')) return false;
      // A group member the signal could not end leaves nothing to wait for;
      // EPERM on the owned root itself is unexpected, so it still throws.
      if (target < 0 && hasErrnoCode(error, 'EPERM')) return false;
      throw error;
    }
  };
  assertOwned();
  if (process.platform === 'win32') {
    // Await taskkill's process-tree operation, not a renderer/PTY exit timer.
    await new Promise<void>((resolve, reject) => {
      execFile(
        'taskkill',
        ['/pid', String(pid), '/t', '/f'],
        {
          windowsHide: true,
          timeout: 5_000,
        },
        (error) => {
          if (!error) resolve();
          else {
            try {
              if (!exists(pid)) resolve();
              else
                reject(
                  error instanceof Error
                    ? error
                    : new Error('Process tree termination failed.'),
                );
            } catch (probeError) {
              reject(
                probeError instanceof Error
                  ? probeError
                  : new Error('Process exit could not be verified.'),
              );
            }
          }
        },
      );
    });
  } else {
    for (const target of [-pid, pid]) {
      assertOwned();
      try {
        process.kill(target, 'SIGKILL');
      } catch (error) {
        if (!hasErrnoCode(error, 'ESRCH')) throw error;
      }
    }
  }
  const deadline = Date.now() + 5_000;
  while (true) {
    // The root can report exit while its SIGKILLed descendants are still
    // exiting, so keep waiting for the process group: its ID stays reserved
    // while any member remains.
    ownershipReleased ||= !isOwned();
    if (!exists(pid) && (process.platform === 'win32' || !exists(-pid))) break;
    if (Date.now() >= deadline) {
      // Only a still-owned root fails the drain; an unreaped zombie can hold
      // the group until the deadline, which then ends the wait as before.
      if (ownershipReleased) return;
      throw new Error(
        'An owned worktree process did not exit; archive cleanup remains pending.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function killChildProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) {
    child.kill(signal);
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
    // Process may already be gone or process groups may not be supported.
    try {
      child.kill(signal);
    } catch {
      return;
    }
  }
}
