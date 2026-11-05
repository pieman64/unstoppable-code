import { dirname } from 'node:path';
import { worktreeListProcessLock } from '@canopy/core-platform/w5-process-file-lock';
import { isW5CommitLogWorkerData } from '@canopy/core-runtime/node/w5/commit-log/worker-contract';
import { parentPort, workerData } from 'node:worker_threads';
import { createNodeW5Durability } from '@canopy/core-runtime/node/w5/commit-log/node-durability';
import { runW5CommitLogWorker } from '@canopy/core-runtime/node/w5/commit-log/worker';

// A test W5 commit log worker entry: the portable body with Node durability.
// It has no win32 confined reader, so capture refuses there.
const port = parentPort;
if (port === null)
  throw new Error('The W5 commit log worker must run in a worker thread');
const data: unknown = workerData;
void runW5CommitLogWorker(port, data, {
  ...(isW5CommitLogWorkerData(data)
    ? {
        processLock: worktreeListProcessLock(
          data.dataRoot ?? dirname(data.root),
        ),
      }
    : {}),
  durability: createNodeW5Durability(process.platform),
  os: process.platform,
});
