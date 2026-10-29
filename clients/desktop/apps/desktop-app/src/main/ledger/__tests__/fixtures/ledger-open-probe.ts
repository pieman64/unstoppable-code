import {
  LedgerRepository,
  isLedgerStoreError,
} from '@canopy/desktop-shared/node/ledger';

/*
 * Opens a Ledger database from a separate process, as a second app instance on
 * the same data directory would, without waiting for its lock, and prints the
 * outcome as one JSON line. The storage client tests run it through tsx;
 * tests must not import this module.
 */

interface LedgerOpenProbeResult {
  opened: boolean;
  authorityId?: string;
  reason?: string;
}

function probe(databasePath: string): LedgerOpenProbeResult {
  try {
    const repository = LedgerRepository.open({
      databasePath,
      openBusyTimeoutMs: 0,
    });
    const authorityId = repository.authorityId;
    repository.close();
    return { opened: true, authorityId };
  } catch (error) {
    return {
      opened: false,
      reason: isLedgerStoreError(error) ? error.reason : 'unexpected',
    };
  }
}

const [databasePath] = process.argv.slice(2);
if (databasePath === undefined) {
  throw new Error('The Ledger open probe needs a database path');
}
process.stdout.write(`${JSON.stringify(probe(databasePath))}\n`);
