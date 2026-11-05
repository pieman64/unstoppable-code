import { parentPort, workerData } from 'node:worker_threads';
import { existsSync, watch } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNodeW5Durability } from '@canopy/core-runtime/node/w5/commit-log/node-durability';
import { runW5CommitLogWorker } from '@canopy/core-runtime/node/w5/commit-log/worker';
import { isW5CommitLogWorkerData } from '@canopy/core-runtime/node/w5/commit-log/worker-contract';
import { worktreeListProcessLock } from '@canopy/core-platform/w5-process-file-lock';

if (!parentPort || !isW5CommitLogWorkerData(workerData) || !workerData.dataRoot)
  throw new Error('Invalid fixture data');
const data = workerData;
const root = workerData.dataRoot;
const durability = createNodeW5Durability(process.platform);
void runW5CommitLogWorker(parentPort, data, {
  os: process.platform,
  processLock: worktreeListProcessLock(root),
  durability: {
    ...durability,
    async writeFileDurably(path, contents) {
      const release = join(root, 'release-apply');
      if (!existsSync(release)) {
        const gate = new Promise<void>((resolve) => {
          const watcher = watch(root, () => {
            if (existsSync(release)) {
              watcher.close();
              resolve();
            }
          });
          if (existsSync(release)) {
            watcher.close();
            resolve();
          }
        });
        await writeFile(join(root, 'applying'), 'ready');
        await gate;
      }
      await durability.writeFileDurably(path, contents);
    },
  },
});
