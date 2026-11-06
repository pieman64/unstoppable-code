import type { W5CommitLog } from '../w5/commit-log/commit-log';
import { RelocationRefusedError } from './transition';

/** Call at the original root after normal recovery, before copying. Never settle uncertainty here. */
export function assertRelocationW5Settled(
  log: Pick<
    W5CommitLog,
    'listPendingCommits' | 'listRecoveryRequiredCommitIds' | 'listReservations'
  >,
): void {
  if (
    log.listPendingCommits().length ||
    log.listRecoveryRequiredCommitIds().length ||
    log.listReservations().length
  )
    throw new RelocationRefusedError('w5-recovery-required');
}
