/**
 * Default-branch base publication must never open SQLite on the Electron main
 * thread. Installed build `.374` ran `PRAGMA quick_check` over the new and the
 * previous 1.6 GB generation synchronously on main during every shadow
 * publication; one such check measured 52 s of wall time on the reporting
 * machine. Main now only renames the finalized staging directory and swaps the
 * manifest; the build worker performs the metadata write, checkpoint, and
 * integrity validation. `node:sqlite` is replaced here with a constructor that
 * records and rejects every call, so any main-thread SQLite access fails.
 */
import type * as CodeGraphBuildRunnerModule from '../code-graph/build-runner';
import type { SingleRepoSidebarItem } from '@canopy/desktop-shared/types';
import type * as NodeCrypto from 'node:crypto';
import type * as NodePath from 'node:path';
import type * as NodeOs from 'node:os';
import {
  mkdir,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import {
  CODE_GRAPH_EXTRACTOR_VERSION,
  CODE_GRAPH_SCHEMA_VERSION,
} from '@canopy/desktop-shared/types/code-graph';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';

const mockSqliteConstructions: string[] = [];
jest.mock('node:sqlite', () => ({
  DatabaseSync: class {
    public constructor(location: string) {
      mockSqliteConstructions.push(location);
      throw new Error('Synchronous SQLite was opened on the calling thread.');
    }
  },
  backup: (): Promise<void> =>
    Promise.reject(
      new Error('Synchronous SQLite backup on the calling thread.'),
    ),
}));

function mockTestRoot(): string {
  const nodePath = jest.requireActual<typeof NodePath>('node:path');
  const nodeOs = jest.requireActual<typeof NodeOs>('node:os');
  return nodePath.join(
    nodeOs.tmpdir(),
    `canopy-base-publication-offmain-${process.pid}`,
  );
}

jest.mock('../lib/paths', () => ({
  getDataDir: (): string => `${mockTestRoot()}/data`,
  getRepoShadowsRootDir: (): string => `${mockTestRoot()}/repo-shadows`,
}));
jest.mock('../lib/repo-shadow', () => {
  const { createHash } = jest.requireActual<typeof NodeCrypto>('node:crypto');
  return {
    RepoShadowEnsureCanceledError: class RepoShadowEnsureCanceledError extends Error {},
    getRepoShadowDir: (repoRoot: string): string =>
      `${mockTestRoot()}/repo-shadows/${createHash('sha256')
        .update(repoRoot)
        .digest('hex')
        .slice(0, 16)}`,
    setRepoShadowRetirementHandler: jest.fn(),
    withEnsuredRepoShadow: jest.fn(
      (
        repoPath: string,
        _options: unknown,
        callback: (shadow: {
          repoPath: string;
          shadowPath: string;
        }) => Promise<unknown>,
      ): Promise<unknown> =>
        callback({
          repoPath,
          shadowPath: `${mockTestRoot()}/shadow-checkout`,
        }),
    ),
  };
});
jest.mock('../lib/git', () => ({
  getHeadCommitSha: jest.fn((): Promise<string> => Promise.resolve('head-2')),
}));
jest.mock('../lib/code-graph-availability', () => ({
  CODE_GRAPH_UNAVAILABLE_MESSAGE:
    'Code graph tools are not available for this project.',
  isCodeGraphAvailableForWorkspace: (): boolean => true,
}));
jest.mock('../lib/workspace-reference-repo', () => ({
  resolveWorkspaceReferenceRepoPath: (repoPath: string): Promise<string> =>
    Promise.resolve(repoPath),
}));
jest.mock('../lib/realistic-startup-performance', () => ({
  recordRealisticStartupPerformanceEvent: jest.fn(),
}));
jest.mock('../lib/code-graph-telemetry', () => ({
  codeGraphGenerationFailureReason: (): string => 'unknown',
  completeCodeGraphGenerationTelemetry: jest.fn(),
  failCodeGraphGenerationTelemetry: jest.fn(),
  flushCodeGraphRefreshTelemetry: jest.fn(),
  startCodeGraphGenerationTelemetry: (): unknown => ({
    operationKey: 'operation',
    startedAtMs: 0,
    context: {},
  }),
}));

const mockRunCodeGraphWorkerBuild = jest.fn<
  ReturnType<typeof CodeGraphBuildRunnerModule.runCodeGraphWorkerBuild>,
  Parameters<typeof CodeGraphBuildRunnerModule.runCodeGraphWorkerBuild>
>();
jest.mock('../code-graph/build-runner', () => ({
  cancelBuild: jest.fn().mockResolvedValue(undefined),
  CodeGraphWorkerBuildError: class CodeGraphWorkerBuildError extends Error {
    public constructor(
      public readonly reason: string,
      message: string,
    ) {
      super(message);
    }
  },
  runCodeGraphWorkerBuild: (
    ...args: Parameters<
      typeof CodeGraphBuildRunnerModule.runCodeGraphWorkerBuild
    >
  ): ReturnType<typeof CodeGraphBuildRunnerModule.runCodeGraphWorkerBuild> =>
    mockRunCodeGraphWorkerBuild(...args),
  beginCodeGraphWorkerBuild: (
    ...args: Parameters<
      typeof CodeGraphBuildRunnerModule.beginCodeGraphWorkerBuild
    >
  ): CodeGraphBuildRunnerModule.CodeGraphWorkerBuildHandle => ({
    attemptId: 'admitted-base-fixture',
    promise: mockRunCodeGraphWorkerBuild(...args),
  }),
  updateCodeGraphBuildOwners: jest.fn(),
}));
const mockRunCodeGraphWorkerRead = jest.fn<Promise<unknown>, [unknown]>();
jest.mock('../code-graph/read-runner', () => ({
  runCodeGraphWorkerRead: (request: unknown): Promise<unknown> =>
    mockRunCodeGraphWorkerRead(request),
}));

import {
  codeGraphBaseManagerTestExports,
  shutdownCodeGraphBaseManager,
  startCodeGraphBaseManager,
  syncCodeGraphBaseRepositories,
} from '../lib/code-graph-base-manager';
import { codeGraphBaseVariantDir } from '../lib/code-graph-base-store';
import { recordRealisticStartupPerformanceEvent } from '../lib/realistic-startup-performance';
import { withEnsuredRepoShadow } from '../lib/repo-shadow';

const REPO_PATH = '/repos/single';
const FINGERPRINT = 'f'.repeat(64);
const workspace: SingleRepoSidebarItem = {
  type: 'single-repo',
  id: 'single',
  name: 'Single',
  color: '#000000',
  collapsed: false,
  order: 0,
  repoPath: REPO_PATH,
  worktrees: [],
};
const identity = {
  repoId: WORKSPACE_ROOT_REPO_ID,
  canonicalRepoRoot: REPO_PATH,
  customLanguagesFingerprint: FINGERPRINT,
};
const buildResult = {
  filesScanned: 1,
  filesParsed: 1,
  filesUnchanged: 0,
  filesSkipped: 0,
  filesRemoved: 0,
  parseFailures: 0,
  symbolCount: 1,
  edgeCount: 0,
  durationMs: 1,
  derived: [],
  customLanguages: null,
};

async function writeGeneration(
  variantDir: string,
  generationId: string,
  modifiedAtSeconds: number,
): Promise<void> {
  const generationDir = path.join(variantDir, 'generations', generationId);
  await mkdir(generationDir, { recursive: true });
  await writeFile(path.join(generationDir, 'graph.db'), `db:${generationId}`);
  await utimes(generationDir, modifiedAtSeconds, modifiedAtSeconds);
}

describe('code graph base publication off the main thread', () => {
  const variantDir = codeGraphBaseVariantDir(REPO_PATH, identity);

  beforeEach(async () => {
    mockSqliteConstructions.length = 0;
    mockRunCodeGraphWorkerBuild.mockReset();
    mockRunCodeGraphWorkerRead.mockReset();
    mockRunCodeGraphWorkerRead.mockResolvedValue({
      ok: true,
      result: {
        kind: 'base-identity',
        value: {
          state: 'readable',
          matches: {
            schema: true,
            extractor: true,
            canonicalRoot: true,
            customLanguagesFingerprint: true,
            repoId: true,
            gitHead: true,
            completed: true,
          },
          observed: {
            schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
            extractorVersion: CODE_GRAPH_EXTRACTOR_VERSION,
            lastBuildAt: 2_000_000,
            completedBuildAt: 2_000_000,
          },
          repository: { repoId: identity.repoId, gitHead: 'head-1' },
        },
      },
    });
    jest.mocked(recordRealisticStartupPerformanceEvent).mockClear();
    await rm(mockTestRoot(), { recursive: true, force: true });
    await writeGeneration(variantDir, 'generation-older', 1_000);
    await writeGeneration(variantDir, 'generation-old', 2_000);
    await writeFile(
      path.join(variantDir, 'current.json'),
      JSON.stringify({
        manifestVersion: 1,
        repoId: identity.repoId,
        canonicalRepoRoot: identity.canonicalRepoRoot,
        gitHead: 'head-1',
        schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
        extractorVersion: CODE_GRAPH_EXTRACTOR_VERSION,
        customLanguagesFingerprint: FINGERPRINT,
        generationId: 'generation-old',
        graphRelativePath: 'generations/generation-old/graph.db',
        publishedAt: new Date(2_000_000).toISOString(),
      }),
    );
    syncCodeGraphBaseRepositories([workspace]);
  });

  afterAll(async () => {
    await rm(mockTestRoot(), { recursive: true, force: true });
  });

  it('builds, finalizes in the worker, and publishes without main-thread SQLite', async () => {
    mockRunCodeGraphWorkerBuild.mockImplementation(
      async (
        _key: string,
        request: CodeGraphBuildRunnerModule.CodeGraphWorkerBuildRequest,
      ): Promise<CodeGraphBuildRunnerModule.CodeGraphWorkerBuildResponse> => {
        await writeFile(request.dbPath, 'db:rebuilt');
        return { ok: true, result: buildResult, baseFinalized: true };
      },
    );

    const outcome = await codeGraphBaseManagerTestExports.maintainBase(
      { repoId: WORKSPACE_ROOT_REPO_ID, repoPath: REPO_PATH },
      { fingerprint: FINGERPRINT, snapshotPath: `${mockTestRoot()}/snapshot` },
      { ownerWorkspaceIds: ['single'] },
    );

    expect(mockSqliteConstructions).toEqual([]);
    expect(outcome).toEqual({ repoId: WORKSPACE_ROOT_REPO_ID, ok: true });
    expect(mockRunCodeGraphWorkerBuild).toHaveBeenCalledTimes(1);
    expect(mockRunCodeGraphWorkerBuild).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        baseFinalization: { identity, gitHead: 'head-2' },
      }),
      expect.anything(),
    );

    const manifest: unknown = JSON.parse(
      await readFile(path.join(variantDir, 'current.json'), 'utf8'),
    );
    expect(manifest).toMatchObject({
      gitHead: 'head-2',
      repoId: identity.repoId,
    });
    const generations = (
      await readdir(path.join(variantDir, 'generations'))
    ).sort();
    expect(generations).toHaveLength(2);
    expect(generations).toContain('generation-old');
    expect(generations).not.toContain('generation-older');
  });

  it('does not publish a staging database the worker did not finalize', async () => {
    mockRunCodeGraphWorkerBuild.mockImplementation(
      async (
        _key: string,
        request: CodeGraphBuildRunnerModule.CodeGraphWorkerBuildRequest,
      ): Promise<CodeGraphBuildRunnerModule.CodeGraphWorkerBuildResponse> => {
        await writeFile(request.dbPath, 'db:unfinalized');
        return { ok: true, result: buildResult };
      },
    );

    const outcome = await codeGraphBaseManagerTestExports.maintainBase(
      { repoId: WORKSPACE_ROOT_REPO_ID, repoPath: REPO_PATH },
      { fingerprint: FINGERPRINT, snapshotPath: `${mockTestRoot()}/snapshot` },
      { ownerWorkspaceIds: ['single'] },
    );

    expect(mockSqliteConstructions).toEqual([]);
    expect(outcome.ok).toBe(false);
    const manifest: unknown = JSON.parse(
      await readFile(path.join(variantDir, 'current.json'), 'utf8'),
    );
    expect(manifest).toMatchObject({ generationId: 'generation-old' });
    await expect(readdir(path.join(variantDir, 'staging'))).resolves.toEqual(
      [],
    );
  });

  it('skips an up-to-date base the read worker validated without opening it on main', async () => {
    const { getHeadCommitSha } = jest.requireMock<{
      getHeadCommitSha: jest.Mock;
    }>('../lib/git');
    getHeadCommitSha.mockResolvedValueOnce('head-1');

    const outcome = await codeGraphBaseManagerTestExports.maintainBase(
      { repoId: WORKSPACE_ROOT_REPO_ID, repoPath: REPO_PATH },
      { fingerprint: FINGERPRINT, snapshotPath: `${mockTestRoot()}/snapshot` },
      { ownerWorkspaceIds: ['single'] },
    );

    expect(outcome).toEqual({ repoId: WORKSPACE_ROOT_REPO_ID, ok: true });
    expect(mockRunCodeGraphWorkerBuild).not.toHaveBeenCalled();
    expect(mockRunCodeGraphWorkerRead).toHaveBeenCalledTimes(1);
    expect(mockRunCodeGraphWorkerRead.mock.calls[0]?.[0]).toMatchObject({
      kind: 'base-validation',
      request: {
        dbPath: path.join(variantDir, 'generations/generation-old/graph.db'),
        task: { kind: 'base-identity', identity, gitHead: 'head-1' },
      },
    });
    expect(mockSqliteConstructions).toEqual([]);
  });

  it('rebuilds from scratch when the read worker rejects the published generation', async () => {
    // A generation whose manifest matches the current head but whose database
    // no longer carries that identity must not be reported as up to date, nor
    // copied into staging where finalization would reject every rebuild.
    const { getHeadCommitSha } = jest.requireMock<{
      getHeadCommitSha: jest.Mock;
    }>('../lib/git');
    getHeadCommitSha.mockResolvedValueOnce('head-1');
    mockRunCodeGraphWorkerRead.mockResolvedValue({
      ok: true,
      result: { kind: 'base-identity', value: { state: 'missing' } },
    });
    const seededStaging: string[] = [];
    mockRunCodeGraphWorkerBuild.mockImplementation(
      async (
        _key: string,
        request: CodeGraphBuildRunnerModule.CodeGraphWorkerBuildRequest,
      ): Promise<CodeGraphBuildRunnerModule.CodeGraphWorkerBuildResponse> => {
        seededStaging.push(
          await readFile(request.dbPath, 'utf8').catch(() => '<cold>'),
        );
        await writeFile(request.dbPath, 'db:rebuilt');
        return { ok: true, result: buildResult, baseFinalized: true };
      },
    );

    const outcome = await codeGraphBaseManagerTestExports.maintainBase(
      { repoId: WORKSPACE_ROOT_REPO_ID, repoPath: REPO_PATH },
      { fingerprint: FINGERPRINT, snapshotPath: `${mockTestRoot()}/snapshot` },
      { ownerWorkspaceIds: ['single'] },
    );

    expect(outcome).toEqual({ repoId: WORKSPACE_ROOT_REPO_ID, ok: true });
    expect(seededStaging).toEqual(['<cold>']);
    expect(recordRealisticStartupPerformanceEvent).toHaveBeenCalledWith(
      'startup:code-graph-base:worker-started',
      { mode: 'cold' },
    );
    expect(mockSqliteConstructions).toEqual([]);
  });

  it('fails the cycle without rebuilding when the read worker cannot validate', async () => {
    const { getHeadCommitSha } = jest.requireMock<{
      getHeadCommitSha: jest.Mock;
    }>('../lib/git');
    getHeadCommitSha.mockResolvedValueOnce('head-1');
    mockRunCodeGraphWorkerRead.mockResolvedValue({
      ok: false,
      message: 'read worker unavailable',
    });

    const outcome = await codeGraphBaseManagerTestExports.maintainBase(
      { repoId: WORKSPACE_ROOT_REPO_ID, repoPath: REPO_PATH },
      { fingerprint: FINGERPRINT, snapshotPath: `${mockTestRoot()}/snapshot` },
      { ownerWorkspaceIds: ['single'] },
    );

    expect(outcome.ok).toBe(false);
    expect(mockRunCodeGraphWorkerBuild).not.toHaveBeenCalled();
    const manifest: unknown = JSON.parse(
      await readFile(path.join(variantDir, 'current.json'), 'utf8'),
    );
    expect(manifest).toMatchObject({ generationId: 'generation-old' });
  });
});

describe('code graph base maintenance cadence', () => {
  function cycleStarts(): number {
    return jest
      .mocked(recordRealisticStartupPerformanceEvent)
      .mock.calls.filter(
        ([event]) => event === 'startup:code-graph-base:cycle-started',
      ).length;
  }

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.mocked(recordRealisticStartupPerformanceEvent).mockClear();
    // Offline shadows keep each cycle short; cadence is what is under test.
    jest
      .mocked(withEnsuredRepoShadow)
      .mockImplementation(() => Promise.reject(new Error('offline')));
    await shutdownCodeGraphBaseManager();
  });

  afterEach(async () => {
    await shutdownCodeGraphBaseManager();
    jest.useRealTimers();
  });

  it('does not re-arm maintenance when a projects reload keeps the same repositories', async () => {
    startCodeGraphBaseManager();
    syncCodeGraphBaseRepositories([workspace]);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(cycleStarts()).toBe(1);

    // A projects reload with unchanged repositories must keep the periodic
    // cadence instead of scheduling another cycle ten seconds later.
    syncCodeGraphBaseRepositories([workspace]);
    syncCodeGraphBaseRepositories([workspace]);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(cycleStarts()).toBe(1);

    syncCodeGraphBaseRepositories([
      workspace,
      { ...workspace, id: 'second', repoPath: '/repos/second' },
    ]);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(cycleStarts()).toBe(2);
  });
});
