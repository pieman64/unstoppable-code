import type { CodeGraphRepositoryInput } from '@canopy/desktop-shared/types/code-graph';
import type { CodeGraphFingerprintWorkerResponse } from '../code-graph/fingerprint-runner';
import type { CodeGraphRefreshSource } from '../lib/code-graph-telemetry';
import type { PersistedCodeGraphWorktreeFingerprintRead } from '../lib/code-graph-worktree-fingerprint';

const mockCancelBuild = jest.fn<void, [string]>();
const mockCancelFingerprint = jest.fn<void, [string]>();
const mockClearFingerprintCache = jest.fn<void, [string]>();
const mockE2eBuild = jest.fn<boolean, []>();
const mockExistsSync = jest.fn<boolean, [string]>();
const mockIsAvailable = jest.fn<boolean, [string]>();
const mockIsBuildPending = jest.fn<boolean, [string]>();
const mockIsCoworkWorkspace = jest.fn<boolean, [string]>();
const mockReadSnapshot = jest.fn<
  Promise<PersistedCodeGraphWorktreeFingerprintRead>,
  [string, string]
>();
const mockRecordRefresh = jest.fn<
  void,
  [{ source: CodeGraphRefreshSource; outcome: string }]
>();
const mockResolveRepositories = jest.fn<
  Promise<CodeGraphRepositoryInput[]>,
  [string, string]
>();
const mockResolveWorktree = jest.fn<string, [string, string]>();
const mockRunBuild = jest.fn<Promise<unknown>, [unknown]>();
const mockRunFingerprint = jest.fn<
  Promise<CodeGraphFingerprintWorkerResponse>,
  [string, readonly CodeGraphRepositoryInput[]]
>();

jest.mock('node:fs', () => ({
  existsSync: (path: string): boolean => mockExistsSync(path),
}));
jest.mock('@canopy/desktop-shared/node/code-graph/worktree-paths', () => ({
  getWorktreeCodeGraphDbPath: (projectId: string, worktreeId: string): string =>
    `/mock/${projectId}/${worktreeId}/graph.db`,
}));
jest.mock('../code-graph/build-runner', () => ({
  cancelBuild: (key: string): void => mockCancelBuild(key),
  isCodeGraphBuildPending: (key: string): boolean => mockIsBuildPending(key),
}));
jest.mock('../code-graph/fingerprint-runner', () => ({
  cancelCodeGraphFingerprint: (key: string): void => mockCancelFingerprint(key),
  runCodeGraphWorkerFingerprint: (
    key: string,
    repositories: readonly CodeGraphRepositoryInput[],
  ): Promise<CodeGraphFingerprintWorkerResponse> =>
    mockRunFingerprint(key, repositories),
}));
jest.mock('../lib/code-graph-availability', () => ({
  isCodeGraphAvailableForWorkspace: (projectId: string): boolean =>
    mockIsAvailable(projectId),
}));
jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => mockE2eBuild(),
}));
jest.mock('../lib/workspace-registry', () => ({
  isCoworkWorkspace: (projectId: string): boolean =>
    mockIsCoworkWorkspace(projectId),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (projectId: string, worktreeId: string): string =>
    mockResolveWorktree(projectId, worktreeId),
}));
jest.mock('../lib/worktree-repo-entries', () => ({
  resolveWorktreeCodeGraphRepositories: (
    projectId: string,
    worktreePath: string,
  ): Promise<CodeGraphRepositoryInput[]> =>
    mockResolveRepositories(projectId, worktreePath),
}));
jest.mock('../lib/code-graph-worktree-fingerprint', () => ({
  clearCodeGraphWorktreeFingerprintCache: (dbPath: string): void =>
    mockClearFingerprintCache(dbPath),
  readPersistedCodeGraphWorktreeFingerprintSnapshot: (
    dbPath: string,
    key: string,
  ): Promise<PersistedCodeGraphWorktreeFingerprintRead> =>
    mockReadSnapshot(dbPath, key),
}));
jest.mock('../lib/code-graph-build-service', () => ({
  runWorktreeCodeGraphBuild: (input: unknown): Promise<unknown> =>
    mockRunBuild(input),
}));
jest.mock('../lib/code-graph-telemetry', () => ({
  recordCodeGraphRefreshTelemetry: (event: {
    source: CodeGraphRefreshSource;
    outcome: string;
  }): void => mockRecordRefresh(event),
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
}));

import {
  codeGraphFirstRequestedAt,
  resetCodeGraphBuildDiagnosticsForTests,
} from '../lib/code-graph-build-diagnostics';
import { scheduleCodeGraphBuild } from '../lib/code-graph-scheduler';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('Code Graph scheduler saturation handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    resetCodeGraphBuildDiagnosticsForTests();
    mockE2eBuild.mockReturnValue(false);
    mockIsAvailable.mockReturnValue(true);
    mockIsCoworkWorkspace.mockReturnValue(false);
    mockResolveWorktree.mockReturnValue('/private/worktree');
    mockResolveRepositories.mockResolvedValue([
      { repoId: 'repo-safe', rootPath: '/private/worktree' },
    ]);
    mockRunFingerprint.mockResolvedValue({
      ok: true,
      fingerprint: 'fingerprint-current',
    });
    mockReadSnapshot.mockResolvedValue({
      fingerprint: null,
      schemaVersion: null,
      extractorVersion: null,
      completed: false,
      cacheHit: false,
      readFailed: true,
      readFailure: 'busy',
      durationMs: 5,
    });
    mockIsBuildPending.mockReturnValue(false);
    mockRunBuild.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    resetCodeGraphBuildDiagnosticsForTests();
  });

  it('does not mark the graph missing or start seed/build work when metadata admission is busy', async () => {
    scheduleCodeGraphBuild({
      projectId: 'project-safe',
      worktreeId: 'worktree-safe',
      reason: 'worktree-created',
      debounceMs: 0,
      source: 'worktree-created',
    });

    await jest.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(mockReadSnapshot).toHaveBeenCalledTimes(1);
    expect(mockReadSnapshot.mock.calls[0]?.[1]).toBe(
      'project-safe/worktree-safe',
    );
    expect(mockRunBuild).not.toHaveBeenCalled();
    expect(
      codeGraphFirstRequestedAt('project-safe/worktree-safe'),
    ).toBeUndefined();
    expect(mockRecordRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'worktree-created',
        outcome: 'fingerprint-error',
      }),
    );
  });
});
