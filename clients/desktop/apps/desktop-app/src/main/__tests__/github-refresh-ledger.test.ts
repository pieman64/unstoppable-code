import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockLedgerDir = mkdtempSync(
  path.join(os.tmpdir(), 'canopy-github-refresh-ledger-'),
);
const mockLedgerPath = path.join(mockLedgerDir, 'github-refresh-ledger.json');

jest.mock('../lib/paths', () => ({
  getGitHubRefreshLedgerFilePath: (): string => mockLedgerPath,
}));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

afterAll(() => {
  rmSync(mockLedgerDir, { recursive: true, force: true });
});

test('recovers from corruption and persists distinct success, update, due, and failure freshness', async () => {
  writeFileSync(mockLedgerPath, '{not-json', 'utf8');
  const ledger = await import('../lib/github-refresh-ledger');

  await expect(
    ledger.readGitHubRefreshLedgerEntry('workspace-a', 'worktree-a'),
  ).resolves.toBeNull();

  await ledger.recordGitHubRefreshAttempt({
    projectId: 'workspace-a',
    worktreeId: 'worktree-a',
    createdAt: '2026-07-31T12:00:00.000Z',
    attemptedAt: 1_000,
  });
  await ledger.recordGitHubRefreshSuccess({
    projectId: 'workspace-a',
    worktreeId: 'worktree-a',
    createdAt: '2026-07-31T12:00:00.000Z',
    succeededAt: 2_000,
    dataChanged: true,
    nextDueAt: 32_000,
  });
  await ledger.recordGitHubRefreshSuccess({
    projectId: 'workspace-a',
    worktreeId: 'worktree-a',
    createdAt: '2026-07-31T12:00:00.000Z',
    succeededAt: 3_000,
    dataChanged: false,
    nextDueAt: 33_000,
  });

  await expect(
    ledger.readGitHubRefreshLedgerEntry(
      'workspace-a',
      'worktree-a',
      '2026-07-31T12:00:00.000Z',
    ),
  ).resolves.toEqual(
    expect.objectContaining({
      lastAttemptAt: '1970-01-01T00:00:01.000Z',
      lastSuccessAt: '1970-01-01T00:00:03.000Z',
      dataUpdatedAt: '1970-01-01T00:00:02.000Z',
      nextDueAt: '1970-01-01T00:00:33.000Z',
      consecutiveFailures: 0,
    }),
  );

  await ledger.recordGitHubRefreshFailure({
    projectId: 'workspace-a',
    worktreeId: 'worktree-a',
    createdAt: '2026-07-31T12:00:00.000Z',
    failedAt: 4_000,
  });
  await expect(
    ledger.readGitHubRefreshLedgerEntry('workspace-a', 'worktree-a'),
  ).resolves.toEqual(
    expect.objectContaining({
      lastSuccessAt: '1970-01-01T00:00:03.000Z',
      lastFailureAt: '1970-01-01T00:00:04.000Z',
      retryAfterAt: '1970-01-01T00:00:06.000Z',
      consecutiveFailures: 1,
    }),
  );

  const persisted: unknown = JSON.parse(readFileSync(mockLedgerPath, 'utf8'));
  expect(isRecord(persisted)).toBe(true);
  if (!isRecord(persisted)) {
    throw new Error('Expected persisted ledger to be an object');
  }
  expect(persisted.version).toBe(1);
  expect(isRecord(persisted.entries)).toBe(true);
  if (!isRecord(persisted.entries)) {
    throw new Error('Expected persisted ledger entries to be an object');
  }
  expect(Object.keys(persisted.entries)).toEqual(['workspace-a/worktree-a']);
});
