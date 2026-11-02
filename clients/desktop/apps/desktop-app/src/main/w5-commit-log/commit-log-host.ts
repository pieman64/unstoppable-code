import { dirname, join } from 'node:path';
// The host module alone: main imports this at startup, and the commit log's
// index would load node:sqlite there, which only the worker needs.
import { W5CommitLogHost } from '@canopy/core-runtime/node/w5/commit-log-host';
import { getW5CommitLogPath, getWorkspacesRootDir } from '../lib/paths';
import { desktopW5HostAdmission } from '../lib/w5-host-admission';
import { hostW5ConfinementAddon } from './confinement-addon';

export {
  W5CommitLogHost,
  W5CommitLogHostError,
  type W5CommitLogHostFailure,
  type W5CommitLogHostOptions,
} from '@canopy/core-runtime/node/w5/commit-log-host';

/** The worker bundle emitted beside the main bundle. */
const WORKER_FILENAME = 'w5-commit-log-worker.js';

let defaultHost: W5CommitLogHost | undefined;
let defaultHostShutDown = false;

/**
 * The app's W5 commit log host. Getting it starts nothing: the worker starts,
 * creates the log and recovers it on the first call, once this process is
 * admitted to the data root's host cohort.
 */
export function getW5CommitLogHost(): W5CommitLogHost {
  if (defaultHost === undefined) {
    const root = getWorkspacesRootDir();
    const dataRoot = dirname(root);
    defaultHost = new W5CommitLogHost({
      dbPath: getW5CommitLogPath(),
      root,
      dataRoot,
      workerEntry: join(__dirname, WORKER_FILENAME),
      confinementAddon: hostW5ConfinementAddon(),
      // TRANSITIONAL (CAN-3797): remove when the W5 rows move to `daemon`.
      admission: (): Promise<void> => desktopW5HostAdmission(dataRoot),
    });
    // A host first requested after quit refuses calls instead of starting a
    // worker.
    if (defaultHostShutDown) void defaultHost.shutdown();
  }
  return defaultHost;
}

/**
 * Stops the app's W5 commit log worker at quit, once every W5 writer has
 * drained, and releases the log's lock. Quitting before the log was used
 * touches nothing. Later calls fail instead of starting another worker.
 */
export function shutdownW5CommitLogHost(): Promise<void> {
  defaultHostShutDown = true;
  return defaultHost === undefined ? Promise.resolve() : defaultHost.shutdown();
}
