import type {
  PlatformKillTreeRequest,
  PlatformKillTreeResult,
  PlatformOperatingSystem,
} from '@canopy/core-runtime';
import { signalProcessGroup } from './process-group';
import {
  processPresent,
  type SupervisionOperations,
  validatePid,
  windowsExecutable,
} from './shared';

/** POSIX signals only the process group; a bare-PID fallback could orphan descendants. */
export async function killProcessTree(
  os: PlatformOperatingSystem,
  request: PlatformKillTreeRequest,
  ops: SupervisionOperations,
): Promise<PlatformKillTreeResult> {
  const { pid, mode, signal } = request;
  validatePid(pid);
  if (pid === ops.selfPid)
    throw new Error('Invalid supervised PID: own process');
  if (mode !== 'graceful' && mode !== 'force')
    throw new Error('Invalid stop mode');
  signal?.throwIfAborted();
  if (os === 'win32') return killWindowsTree(pid, ops, signal);
  const sent = signalProcessGroup(
    pid,
    mode === 'graceful' ? 'SIGTERM' : 'SIGKILL',
    ops,
  );
  if (sent === 'sent') return { kind: 'signaled', mode };
  if (processPresent(pid, ops))
    throw new Error(`PID ${pid} is not a process group leader`);
  return { kind: 'absent' };
}

// taskkill /t without /f fails on hidden-console children, so Windows always forces.
// Exit codes never prove absence; only an independent probe after failure does.
async function killWindowsTree(
  pid: number,
  ops: SupervisionOperations,
  signal: AbortSignal | undefined,
): Promise<PlatformKillTreeResult> {
  const root = ops.systemRoot();
  const taskkill = windowsExecutable(root, 'taskkill.exe');
  const args = ['/pid', String(pid), '/t', '/f'];
  try {
    await ops.run(taskkill, args, signal, { SystemRoot: root });
  } catch (error) {
    signal?.throwIfAborted();
    if (processPresent(pid, ops)) throw error;
    return { kind: 'absent' };
  }
  signal?.throwIfAborted();
  return { kind: 'signaled', mode: 'force' };
}
