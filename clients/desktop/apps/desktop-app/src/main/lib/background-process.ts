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

export {
  leaveBackgroundProcessPolicy,
  lowerSpawnedProcessPriority,
  type SpawnedProcessPriorityOptions,
} from '@canopy/core-platform/execution-host/process-priority';
