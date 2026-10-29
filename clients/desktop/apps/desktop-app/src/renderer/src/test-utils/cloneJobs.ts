import type { CloneJobSnapshot } from '@canopy/desktop-shared/types';

/** A running, backgrounded clone job for renderer tests. */
export function makeCloneJob(
  overrides: Partial<CloneJobSnapshot> = {},
): CloneJobSnapshot {
  return {
    id: 'job-1',
    repoName: 'big-repo',
    remoteUrl: 'https://github.com/org/big-repo.git',
    destinationPath: '/Users/me/repos/big-repo',
    status: 'running',
    phase: 'receiving',
    phasePercent: 37,
    percent: 42,
    processedCount: 1234,
    totalCount: 5678,
    received: '12.34 MiB',
    throughput: '3.21 MiB/s',
    startedAt: Date.now(),
    background: true,
    cancellable: true,
    workspaceId: null,
    workspaceName: null,
    error: null,
    ...overrides,
  };
}
