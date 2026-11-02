import type { W5CommitLogHost } from '../../../w5-commit-log/commit-log-host';
import { startedWorkers } from '../../../ledger/__tests__/fixtures/tsx-worker-threads';

export async function shutdownW5BoundaryHost(
  host: W5CommitLogHost,
  dbPath: string,
): Promise<void> {
  const workers = startedWorkers.filter(
    ({ workerData }) =>
      typeof workerData === 'object' &&
      workerData !== null &&
      'dbPath' in workerData &&
      workerData.dbPath === dbPath,
  );
  await host.shutdown();
  // Host shutdown is bounded; fixture deletion and replacement need real exit.
  await Promise.all(workers.map((worker) => worker.exited));
  expect(host.runningWorkerCount).toBe(0);
}
