import { dirname } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { runW5CommitLogWorker } from '@canopy/core-runtime/node/w5/commit-log/worker';
import { isDesktopW5CommitLogWorkerData } from './commit-log-worker-contract';
import { desktopW5CommitLogWorkerHost } from './commit-log-worker-requests';

/*
 * The app's W5 commit log worker entry, a thread inside the main process
 * (CAN-3805). The portable worker body runs here with the desktop's
 * durability, its trusted host OS and, on win32, the owned-child addon's
 * confined reads (CAN-5202).
 */

const port = parentPort;
if (port === null) {
  throw new Error('The W5 commit log worker must run in a worker thread');
}
const data: unknown = workerData;
const valid = isDesktopW5CommitLogWorkerData(data);
// Worker data with a malformed addon reaches the body as no data at all, so
// it refuses its configuration rather than read unconfined.
void runW5CommitLogWorker(
  port,
  valid ? data : undefined,
  desktopW5CommitLogWorkerHost(
    valid ? data.confinementAddon : undefined,
    valid ? (data.dataRoot ?? dirname(data.root)) : undefined,
  ),
);
