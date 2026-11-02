import { errorCode, type SupervisionOperations } from './shared';

/**
 * Sends `signal` to the POSIX process group led by `pgid`: `absent` once no
 * member remains. Any other refusal throws, so callers decide what EPERM
 * means. The one group-signal path for tree kills and execution children.
 */
export function signalProcessGroup(
  pgid: number,
  signal: 'SIGTERM' | 'SIGKILL' | 0,
  ops: SupervisionOperations,
): 'sent' | 'absent' {
  try {
    ops.kill(-pgid, signal);
    return 'sent';
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return 'absent';
    throw error;
  }
}
