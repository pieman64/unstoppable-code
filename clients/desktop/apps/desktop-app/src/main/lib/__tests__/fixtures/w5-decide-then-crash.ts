import { writeFileSync } from 'node:fs';
import {
  W5CommitLog,
  type W5CommitRequest,
} from '@canopy/desktop-shared/node/w5-commit-log';

/** Replaces every file the change expects to find, as an out-of-band writer. */
export function overwriteReplacedFiles(
  request: W5CommitRequest,
  bytes: string,
): void {
  for (const { path, previousFingerprint } of request.files)
    if (previousFingerprint !== null) writeFileSync(path, bytes);
}

/**
 * The worker records `request` durably and dies before applying it; `foreign`
 * then changes its files during the downtime, so the next launch finds the
 * conflict and leaves the commit awaiting recovery. A live worker refuses a
 * list already stale at its recheck, which makes this the deterministic route
 * to a list-bearing decision that stays unapplied.
 */
export async function decideThenCrash(
  host: { shutdown(): Promise<void> },
  dbPath: string,
  request: W5CommitRequest,
  foreign: () => void = () => undefined,
): Promise<never> {
  await host.shutdown();
  const cold = W5CommitLog.open(dbPath);
  try {
    cold.commit(request);
  } finally {
    cold.close();
  }
  foreign();
  throw new Error('The worker died after the decision.');
}
