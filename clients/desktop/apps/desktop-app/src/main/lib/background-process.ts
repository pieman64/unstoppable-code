import { execFile } from 'node:child_process';
import { constants as osConstants, setPriority } from 'node:os';

export interface BackgroundProcessLaunch {
  command: string;
  args: string[];
  lowerPriorityAfterSpawn: boolean;
}

/**
 * Build a launch that places automatic background work below the app before
 * it can spawn descendants. On macOS, utility QoS keeps interactive renderer
 * work ahead of long-running Git/install activity without applying Darwin's
 * background disk throttle, which can stretch a large package install by
 * minutes. Other platforms adjust the spawned process best-effort.
 */
export function prepareBackgroundProcessLaunch(
  command: string,
  args: readonly string[],
  backgroundPriority: boolean,
): BackgroundProcessLaunch {
  if (!backgroundPriority) {
    return { command, args: [...args], lowerPriorityAfterSpawn: false };
  }
  if (process.platform === 'darwin') {
    return {
      command: '/usr/sbin/taskpolicy',
      args: ['-c', 'utility', command, ...args],
      lowerPriorityAfterSpawn: false,
    };
  }
  return { command, args: [...args], lowerPriorityAfterSpawn: true };
}

export interface SpawnedProcessPriorityOptions {
  /**
   * Opportunistic work nobody is waiting on. On macOS this applies Darwin's
   * background policy (`taskpolicy -b`): the lowest scheduling band and
   * throttled disk I/O, so it yields the SSD to interactive I/O. Everywhere
   * else, and for work with a waiting caller, only CPU priority is lowered.
   */
  background?: boolean;
}

const DARWIN_TASKPOLICY_PATH = '/usr/sbin/taskpolicy';
const DARWIN_TASKPOLICY_TIMEOUT_MS = 5_000;

function lowerCpuPriority(pid: number): void {
  try {
    setPriority(pid, osConstants.priority.PRIORITY_LOW);
  } catch {
    // Priority adjustment is best-effort. Background work must still run when
    // the host rejects the request or does not support process priorities.
  }
}

/**
 * The last Darwin policy transition queued for each pid. Each `taskpolicy`
 * run is its own process, so two launched back to back can finish in either
 * order; a `-B` that finished before an earlier `-b` would leave a worker
 * disk-throttled while a caller waits on it. Transitions for one pid
 * therefore start only after the previous one has exited.
 */
const darwinPolicyTransitions = new Map<number, Promise<void>>();

function runDarwinTaskpolicy(pid: number, flag: '-b' | '-B'): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(
        DARWIN_TASKPOLICY_PATH,
        [flag, '-p', String(pid)],
        { timeout: DARWIN_TASKPOLICY_TIMEOUT_MS },
        (error) => resolve(error === null),
      ).unref();
    } catch {
      resolve(false);
    }
  });
}

function queueDarwinPolicyTransition(
  pid: number,
  transition: () => Promise<void>,
): void {
  const previous = darwinPolicyTransitions.get(pid) ?? Promise.resolve();
  const next = previous.then(transition);
  darwinPolicyTransitions.set(pid, next);
  void next.finally(() => {
    if (darwinPolicyTransitions.get(pid) === next) {
      darwinPolicyTransitions.delete(pid);
    }
  });
}

/**
 * Moves a process that {@link lowerSpawnedProcessPriority} put into Darwin's
 * background band back out of it once someone starts waiting on its result.
 * A lowered `nice` value cannot be raised again without privileges, so other
 * platforms keep their CPU priority.
 */
export function leaveBackgroundProcessPolicy(pid: number): void {
  if (process.platform !== 'darwin') return;
  queueDarwinPolicyTransition(pid, async () => {
    // Best effort: the process may already have exited.
    await runDarwinTaskpolicy(pid, '-B');
  });
}

export function lowerSpawnedProcessPriority(
  pid: number,
  options: SpawnedProcessPriorityOptions = {},
): void {
  if (options.background !== true || process.platform !== 'darwin') {
    lowerCpuPriority(pid);
    return;
  }
  queueDarwinPolicyTransition(pid, async () => {
    if (!(await runDarwinTaskpolicy(pid, '-b'))) lowerCpuPriority(pid);
  });
}
