import type * as DestructiveRecovery from '../lib/w5-destructive-recovery';
// This suite controls the legacy filesystem. Durable lifecycle evidence is
// exercised with real files and workers in w5-destructive-recovery.test.ts.
jest.mock('../lib/w5-destructive-recovery', () => ({
  ...jest.requireActual<typeof DestructiveRecovery>(
    '../lib/w5-destructive-recovery',
  ),
  readDestructiveRecovery: jest.fn(() => Promise.resolve(null)),
  readWorkspaceDestructiveRecoveries: jest.fn(() => Promise.resolve([])),
  assertNoDestructiveRecovery: jest.fn(() => Promise.resolve()),
  assertNoLegacyArchiveRecovery: jest.fn(() => Promise.resolve()),
  refuseInterruptedArchiveJournal: jest.fn(() => Promise.resolve()),
  findCompletedDestructiveArchive: jest.fn(() => Promise.resolve(null)),
  reportDestructiveRecovery: jest.fn(() => Promise.resolve([])),
  withDestructiveLifecycle: (
    _input: unknown,
    work: () => Promise<unknown>,
  ): Promise<unknown> => work(),
  destructiveStep: (
    _phase: string,
    work: () => Promise<unknown>,
  ): Promise<unknown> => work(),
  destructiveCall: (
    _phase: string,
    work: (...args: unknown[]) => Promise<unknown>,
    ...args: unknown[]
  ): Promise<unknown> => work(...args),
  hasDestructiveLifecycle: (): boolean => false,
  assertDestructiveRowIdentity: (): void => {},
  acknowledgeArchiveCaptureRefusal: (): void => {},
  protectDestructivePath: (): Promise<void> => Promise.resolve(),
  markDestructiveCleanupRequired: (): void => {},
  destructiveCleanup: (
    _phase: string,
    work: () => Promise<unknown>,
  ): Promise<unknown> => work(),
}));
import type * as NodeChildProcess from 'node:child_process';
import type * as NodeFs from 'node:fs';
import type * as NodeFsPromises from 'node:fs/promises';
import type * as NodeUtil from 'node:util';
// Resolve the test Git independently of desktop preferences; this suite tests Git operations.
jest.mock('../lib/git-executable', () => ({
  getResolvedGitExecutableForSpawn: (): Promise<string> =>
    Promise.resolve(process.env.CANOPY_GIT_EXECUTABLE?.trim() || 'git'),
}));
jest.mock('node:child_process', () => {
  const actual =
    jest.requireActual<typeof NodeChildProcess>('node:child_process');
  const { promisify } = jest.requireActual<typeof NodeUtil>('node:util');
  const mockedExecFile = jest.fn(actual.execFile);
  Object.defineProperty(mockedExecFile, promisify.custom, {
    configurable: true,
    value: jest.fn(promisify(actual.execFile)),
  });
  return { ...actual, execFile: mockedExecFile };
});

const mockRunArchiveIoRequest = jest.fn();
jest.mock('../archive/archive-io-runner', () => ({
  runArchiveIoRequest: (...args: unknown[]): unknown =>
    mockRunArchiveIoRequest(...args),
}));

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof NodeFsPromises>('node:fs/promises');
  return {
    ...actual,
    rename: jest.fn(actual.rename),
    readFile: jest.fn(actual.readFile),
    rm: jest.fn(actual.rm),
  };
});
const actualFsPromises =
  jest.requireActual<typeof NodeFsPromises>('node:fs/promises');
const mockedFsPromises =
  jest.requireMock<typeof NodeFsPromises>('node:fs/promises');
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { assertNoDestructiveRecovery } from '../lib/w5-destructive-recovery';
import {
  captureArchivedWorkspaceRootPayload,
  restoreArchivedWorkspaceRootPayload,
} from '../lib/archived-workspace-root-payload';
import {
  prepareArchivedContainerRecovery,
  finishArchivedContainerRecovery,
  isArchivedContainerGitCleanupBlocked,
  isArchivedRecoveryPathWithinRoot,
  isWorktreeArchiveSourceUnavailable,
  removeProjectWorktreeRegistrations,
  restoreArchivedRecoveryFiles,
  restoreArchivedRecoveryWorkspaceRootFiles,
  verifyArchivedContainerRecoveryFinish,
} from '../lib/archived-container-recovery';
import type {
  ArchivedContainerManifestV2,
  ArchivedContainerRecoveryManifest,
  WorkspaceConfigFile,
  WorktreeData,
} from '@canopy/desktop-shared/types';

// These integration-style unit tests create real repositories and worktrees.
// Leave enough headroom when the full Jest suite runs several workers at once.
jest.setTimeout(30_000);

let mockRootDir = '';
let mockReferenceRepoPath = '';
let mockManifest: ArchivedContainerManifestV2 | null = null;

function setPlatform(platform: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
  return () => {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor);
  };
}

jest.mock('../lib/paths', () => {
  return {
    getWorkspaceWorktreeDir: (
      workspaceId: string,
      containerId: string,
    ): string => join(mockRootDir, 'worktrees', workspaceId, containerId),
    getArchivedContainerGitStateStagedPath: (
      workspaceId: string,
      containerId: string,
    ): string =>
      join(
        mockRootDir,
        'archives',
        workspaceId,
        containerId,
        'git-state.staged.json',
      ),
    getArchivedContainersRootDir: (workspaceId: string): string =>
      join(mockRootDir, 'archives', workspaceId),
    getArchivedContainerRecoveryEvidenceDir: (
      workspaceId: string,
      worktreeId: string,
      containerId: string,
    ): string =>
      join(
        mockRootDir,
        'worktree-data',
        workspaceId,
        worktreeId,
        'archive-recovery-evidence',
        containerId,
      ),
    getArchivedContainerManifestPath: (
      workspaceId: string,
      containerId: string,
    ): string =>
      join(mockRootDir, 'archives', workspaceId, containerId, 'container.json'),
    getArchivedContainerWorkspaceRootDir: (
      workspaceId: string,
      containerId: string,
    ): string =>
      join(mockRootDir, 'archives', workspaceId, containerId, 'workspace-root'),
  };
});

jest.mock('../lib/workspace-persistence', () => {
  const readWorkspaceConfig = jest.fn(() =>
    Promise.resolve({
      type: 'single-repo',
      repoPath: mockReferenceRepoPath,
    }),
  );
  return {
    isWorkspaceWorktreeCurrent: jest.fn(() => Promise.resolve(true)),
    readWorkspaceWorktrees: jest.fn(() => Promise.resolve([])),
    readWorkspaceConfig,
    readWorkspaceConfigDetailed: jest.fn(async () => ({
      config: await readWorkspaceConfig(),
      authority: 'ok',
      ownerMalformed: false,
      memoryMalformed: false,
    })),
  };
});

jest.mock('../lib/workspace-source', () => ({
  readEffectiveWorkspaceConfig: jest.fn(),
}));

jest.mock('../lib/project-reference-repo', () => ({
  resolveProjectReferenceRepoPath: jest.fn(() =>
    Promise.resolve(mockReferenceRepoPath),
  ),
}));

jest.mock('../lib/workspace-reference-repo', () => ({
  resolveWorkspaceReferenceRepoPath: jest.fn(),
}));

jest.mock('../lib/worktree-base-branches', () => ({
  resolveEffectiveBaseBranchForRepo: jest.fn(() =>
    Promise.resolve({
      branch: 'main',
    }),
  ),
}));

jest.mock('../lib/github-pr', () => ({
  fetchArchivedPullRequestMetadata: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('../lib/archived-containers', () => ({
  listArchivedContainerManifests: jest.fn(() => Promise.resolve([])),
  readArchivedContainerManifest: jest.fn(() =>
    mockManifest
      ? Promise.resolve(mockManifest)
      : Promise.reject(new Error('No archived manifest fixture')),
  ),
}));

jest.mock('../lib/worktree-service', () => ({
  archiveSingleRepoWorktree: jest.fn(() =>
    Promise.resolve({ success: true, warnings: [] }),
  ),
  archiveMultiRepoWorktree: jest.fn(() =>
    Promise.resolve({ success: true, warnings: [] }),
  ),
}));

jest.unmock('../lib/archived-container-git');
jest.unmock('../lib/git-tree-snapshot');
jest.unmock('../lib/git');

import {
  assertArchivedGitStateMatchesWorkspace,
  assertArchivedGitStatePurgeable,
  assertArchivedGitStateRestorable,
  captureArchivedPullRequestMetadata,
  captureArchivedContainerGitState,
  deleteArchivedContainerSnapshotRef,
  discardIncompleteArchivedGitCapture,
  invalidateArchivedContainerChanges,
  InterruptedArchivedGitTeardownRequiresRecoveryError,
  isArchivedGitCaptureRecoveryRequiredError,
  listArchivedContainerChanges,
  MissingWorktreeIncompleteArchivedGitCaptureError,
  pinArchivedContainerSnapshotRef,
  prepareArchivedContainerTeardown,
  readArchivedContainerChangeDiff,
  readArchivedGitStagedDescriptor,
  recoverArchivedGitTeardownsForWorkspace,
  reconcileArchivedGitRefsForWorkspace,
  releaseArchivedGitState,
  resolveArchivedContainerRestoreBaseBranches,
  restoreArchivedContainerGitState,
  workspaceRootPayloadDigest,
} from '../lib/archived-container-git';
import { fetchArchivedPullRequestMetadata } from '../lib/github-pr';
import {
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
} from '../lib/worktree-service';
import * as git from '../lib/git';
import * as gitTreeSnapshot from '../lib/git-tree-snapshot';
import { isRecord } from '../lib/type-guards';
import {
  readWorkspaceConfig,
  readWorkspaceConfigDetailed,
} from '../lib/workspace-persistence';
import {
  readEffectiveWorkspaceConfig,
  type EffectiveWorkspaceConfig,
} from '../lib/workspace-source';
import { resolveProjectReferenceRepoPath } from '../lib/project-reference-repo';
import { isFilesOnlyRestoreGitless } from '../lib/files-only-restore-git';
import { executeArchiveIoRequest } from '../archive/archive-io-engine';
import { prepareArchiveTeardown } from '../archive/archive-git-operations';
import type { ArchiveIoOperationRequest } from '../archive/archive-io-protocol';

const WORKSPACE_ID = 'workspace-1';
const CONTAINER_ID = 'archive-1';
/** As a registration cleanup interrupted before its delete locks an entry. */
const CRASHED_CLEANUP_LOCK =
  'canopy: removing stale registration 3f1c9a52-8d4e-4b7a-9c21-6e0f5b8d2a47\n';

function withLegacyNullSourceRepoPath(
  config: EffectiveWorkspaceConfig,
  absentFields: Array<
    'manifest' | 'suppressedManifestRepos' | 'unresolvedManifestRepoIds'
  > = [],
): EffectiveWorkspaceConfig {
  Reflect.set(config, 'sourceRepoPath', null);
  Reflect.deleteProperty(config, 'scripts');
  Reflect.deleteProperty(config, 'defaultPluginSelections');
  for (const field of absentFields) Reflect.deleteProperty(config, field);
  return config;
}

function withLegacyMissingRepos(
  config: WorkspaceConfigFile,
): WorkspaceConfigFile {
  Reflect.deleteProperty(config, 'repos');
  return config;
}

function withLegacyMissingWorkspaceConfigFields(
  config: WorkspaceConfigFile,
  absentFields: Array<'version' | 'repos'>,
): WorkspaceConfigFile {
  for (const field of absentFields) Reflect.deleteProperty(config, field);
  return config;
}

function runGit(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
  }).trim();
}

function runGitRaw(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
  });
}

function worktreePath(containerId = CONTAINER_ID): string {
  return join(mockRootDir, 'worktrees', WORKSPACE_ID, containerId);
}

function referenceRepoIdentity(): string {
  return realpathSync.native(join(mockReferenceRepoPath, '.git'));
}

function setupRepository(): void {
  mockReferenceRepoPath = join(mockRootDir, 'reference');
  mkdirSync(mockReferenceRepoPath, { recursive: true });
  runGit(mockReferenceRepoPath, ['init', '-b', 'main']);
  runGit(mockReferenceRepoPath, ['config', 'user.name', 'Archive Test']);
  runGit(mockReferenceRepoPath, [
    'config',
    'user.email',
    'archive@example.com',
  ]);
  runGit(mockReferenceRepoPath, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(mockReferenceRepoPath, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(mockReferenceRepoPath, 'both.txt'), 'base\n');
  writeFileSync(join(mockReferenceRepoPath, 'delete.txt'), 'delete me\n');
  writeFileSync(join(mockReferenceRepoPath, 'rename-me.txt'), 'old name\n');
  writeFileSync(
    join(mockReferenceRepoPath, 'rename-binary.bin'),
    Buffer.from([0, 1, 2, 3]),
  );
  writeFileSync(
    join(mockReferenceRepoPath, 'rename-image.png'),
    Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]),
  );
  writeFileSync(join(mockReferenceRepoPath, 'copy-source.txt'), 'copy me\n');
  writeFileSync(
    join(mockReferenceRepoPath, 'copy-binary-source.bin'),
    Buffer.from([0, 20, 21, 22]),
  );
  writeFileSync(
    join(mockReferenceRepoPath, 'copy-image-source.png'),
    Buffer.from([137, 80, 78, 71, 0, 20, 21, 22]),
  );
  runGit(mockReferenceRepoPath, ['add', '.']);
  runGit(mockReferenceRepoPath, ['commit', '-m', 'base']);

  mkdirSync(join(mockRootDir, 'worktrees', WORKSPACE_ID), {
    recursive: true,
  });
  runGit(mockReferenceRepoPath, [
    'worktree',
    'add',
    '-b',
    'feature/archive',
    worktreePath(),
    'main',
  ]);
}

function createMixedChanges(): void {
  writeFileSync(join(worktreePath(), 'local-commit.txt'), 'reachable\n');
  runGit(worktreePath(), ['add', 'local-commit.txt']);
  runGit(worktreePath(), ['commit', '-m', 'local only']);

  writeFileSync(join(worktreePath(), 'both.txt'), 'staged\n');
  writeFileSync(join(worktreePath(), 'staged.txt'), 'staged add\n');
  runGit(worktreePath(), ['add', 'both.txt', 'staged.txt']);
  writeFileSync(join(worktreePath(), 'both.txt'), 'working\n');
  rmSync(join(worktreePath(), 'delete.txt'));
  writeFileSync(join(worktreePath(), 'untracked.txt'), 'untracked\n');
  writeFileSync(join(worktreePath(), 'ignored.txt'), 'ignored\n');
  runGit(worktreePath(), ['mv', 'rename-me.txt', 'renamed.txt']);
  runGit(worktreePath(), ['mv', 'rename-binary.bin', 'renamed-binary.bin']);
  runGit(worktreePath(), ['mv', 'rename-image.png', 'renamed-image.png']);
  copyFileSync(
    join(worktreePath(), 'copy-source.txt'),
    join(worktreePath(), 'copied.txt'),
  );
  copyFileSync(
    join(worktreePath(), 'copy-binary-source.bin'),
    join(worktreePath(), 'copied-binary.bin'),
  );
  copyFileSync(
    join(worktreePath(), 'copy-image-source.png'),
    join(worktreePath(), 'copied-image.png'),
  );
  writeFileSync(
    join(worktreePath(), 'copy-source.txt'),
    'copy source changed\n',
  );
  writeFileSync(
    join(worktreePath(), 'copy-binary-source.bin'),
    Buffer.from([0, 30, 31, 32]),
  );
  writeFileSync(
    join(worktreePath(), 'copy-image-source.png'),
    Buffer.from([137, 80, 78, 71, 0, 30, 31, 32]),
  );
  runGit(worktreePath(), [
    'add',
    'renamed-binary.bin',
    'renamed-image.png',
    'copied.txt',
    'copied-binary.bin',
    'copied-image.png',
    'copy-source.txt',
    'copy-binary-source.bin',
    'copy-image-source.png',
  ]);
  writeFileSync(join(worktreePath(), 'executable.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(worktreePath(), 'executable.sh'), 0o755);
  symlinkSync('both.txt', join(worktreePath(), 'both-link'));
  runGit(worktreePath(), ['add', 'executable.sh', 'both-link']);
  // Windows does not derive executable bits from chmod; seed the Git mode.
  runGit(worktreePath(), ['update-index', '--chmod=+x', 'executable.sh']);
}

function persistedWorktree(): WorktreeData {
  return {
    id: CONTAINER_ID,
    branchName: 'feature/archive',
    trackedBaseBranch: 'main',
    createdAt: '2026-07-20T00:00:00.000Z',
  };
}

function setupPartialMultiRepoFixture(
  options: {
    includeRepoB?: boolean;
  } = {},
): {
  referenceRepoPath: string;
  includedRepoPath: string;
  secondIncludedRepoPath?: string;
} {
  const referenceRepoPath = join(mockRootDir, 'multi-reference');
  mkdirSync(referenceRepoPath, { recursive: true });
  runGit(referenceRepoPath, ['init', '-b', 'main']);
  runGit(referenceRepoPath, ['config', 'user.name', 'Archive Test']);
  runGit(referenceRepoPath, ['config', 'user.email', 'archive@example.com']);
  runGit(referenceRepoPath, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(referenceRepoPath, 'README.md'), 'included repository\n');
  runGit(referenceRepoPath, ['add', 'README.md']);
  runGit(referenceRepoPath, ['commit', '-m', 'base']);
  const includedRepoPath = join(worktreePath(), 'repos', 'repo-a');
  mkdirSync(join(worktreePath(), 'repos'), { recursive: true });
  runGit(referenceRepoPath, [
    'worktree',
    'add',
    '-b',
    'feature/repo-a',
    includedRepoPath,
    'main',
  ]);
  const secondIncludedRepoPath = options.includeRepoB
    ? join(worktreePath(), 'repos', 'repo-b')
    : undefined;
  if (secondIncludedRepoPath) {
    runGit(referenceRepoPath, [
      'worktree',
      'add',
      '-b',
      'feature/repo-b',
      secondIncludedRepoPath,
      'main',
    ]);
  }
  jest.mocked(readWorkspaceConfig).mockResolvedValue({
    version: 1,
    type: 'multi-repo',
    repos: [],
  });
  jest.mocked(readEffectiveWorkspaceConfig).mockResolvedValue(
    withLegacyNullSourceRepoPath({
      localConfig: { version: 1, type: 'multi-repo', repos: [] },
      manifest: null,
      sourceRepoPath: undefined,
      repos: [
        { id: 'repo-a', name: 'A', repoPath: referenceRepoPath },
        { id: 'repo-b', name: 'B', repoPath: referenceRepoPath },
      ],
      scripts: undefined,
      defaultPluginSelections: undefined,
      suppressedManifestRepos: [],
      unresolvedManifestRepoIds: [],
    }),
  );
  return {
    referenceRepoPath,
    includedRepoPath,
    ...(secondIncludedRepoPath ? { secondIncludedRepoPath } : {}),
  };
}

function pullRequestRepository(
  repoId: string,
  options: { branchName?: string; repoName?: string } = {},
): ArchivedContainerManifestV2['gitState']['repositories'][number] {
  const commit = 'a'.repeat(40);
  return {
    repoId,
    repoName: options.repoName ?? repoId,
    relativePath: `repos/${repoId}`,
    referenceRepoPath: join(mockRootDir, repoId),
    ...(options.branchName !== undefined
      ? { branchName: options.branchName }
      : {}),
    comparisonBaseCommit: commit,
    headCommit: commit,
    indexSnapshotCommit: commit,
    worktreeSnapshotCommit: commit,
    snapshotRef: `refs/app/archived-containers/${WORKSPACE_ID}/${CONTAINER_ID}/${repoId}`,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value): void => {
      if (resolvePromise === undefined) {
        throw new Error('Deferred resolve was not initialized');
      }
      resolvePromise(value);
    },
    reject: (error): void => {
      if (rejectPromise === undefined) {
        throw new Error('Deferred reject was not initialized');
      }
      rejectPromise(error);
    },
  };
}

function makeManifest(
  capture: Awaited<ReturnType<typeof captureArchivedContainerGitState>>,
): ArchivedContainerManifestV2 {
  return {
    version: 2,
    kind: 'worktree',
    id: CONTAINER_ID,
    projectId: WORKSPACE_ID,
    name: 'Archived feature',
    createdAt: '2026-07-20T00:00:00.000Z',
    archivedAt: '2026-07-22T00:00:00.000Z',
    retentionDays: 7,
    expiresAt: '2026-07-29T00:00:00.000Z',
    chatCount: 0,
    archivedChatCount: 0,
    executionCount: 0,
    branchName: 'feature/archive',
    workspaceType: 'single-repo',
    originalWorktree: persistedWorktree(),
    gitState: capture.gitState,
    gitChanges: capture.gitChanges,
    pullRequestMetadata: capture.pullRequestMetadata,
  };
}

describe('archived container Git state', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockRunArchiveIoRequest.mockImplementation(
      (request: ArchiveIoOperationRequest, signal?: AbortSignal) =>
        executeArchiveIoRequest(
          request,
          signal ?? new AbortController().signal,
          {
            progress: jest.fn(),
            child: { started: jest.fn(), exited: jest.fn() },
          },
        ),
    );
    jest
      .mocked(mockedFsPromises.rename)
      .mockImplementation(actualFsPromises.rename);
    mockRootDir = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'archived-container-git-')),
    );
    mockReferenceRepoPath = '';
    mockManifest = null;
    setupRepository();
    jest.mocked(readWorkspaceConfig).mockResolvedValue(
      withLegacyMissingRepos({
        version: 1,
        type: 'single-repo',
        repoPath: mockReferenceRepoPath,
        repos: [],
      }),
    );
    jest.mocked(fetchArchivedPullRequestMetadata).mockResolvedValue(null);
    await invalidateArchivedContainerChanges(WORKSPACE_ID, CONTAINER_ID);
  });

  afterEach(async () => {
    await invalidateArchivedContainerChanges(WORKSPACE_ID, CONTAINER_ID);
    rmSync(mockRootDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  async function recoveryManifest(): Promise<ArchivedContainerRecoveryManifest> {
    const original = persistedWorktree();
    return {
      version: 3,
      kind: 'worktree',
      id: CONTAINER_ID,
      projectId: WORKSPACE_ID,
      name: 'Recovery',
      createdAt: original.createdAt,
      archivedAt: '2026-07-22T00:00:00.000Z',
      retentionDays: 7,
      expiresAt: '2026-07-29T00:00:00.000Z',
      chatCount: 0,
      archivedChatCount: 0,
      executionCount: 0,
      workspaceType: 'single-repo',
      originalWorktree: original,
      recovery: await prepareArchivedContainerRecovery({
        projectId: WORKSPACE_ID,
        worktreeId: CONTAINER_ID,
        worktree: original,
      }),
    };
  }

  it('hashes payloads with one bounded read buffer while retaining the existing digest format', async () => {
    const root = join(mockRootDir, 'digest-fixture');
    mkdirSync(root);
    const contents: Buffer[] = [
      Buffer.from([0, 255, 13, 10]),
      Buffer.alloc(256 * 1024 + 17, 73),
      Buffer.alloc(0),
    ];
    const expected = createHash('sha256');
    contents.forEach((bytes, index) => {
      const name = `${index}.bin`;
      const path = join(root, name);
      writeFileSync(path, bytes);
      const mode = lstatSync(path).mode & 0o777;
      expected.update(`${name}\0${mode}\0file\0${bytes.length}\0`);
      expected.update(bytes);
      expected.update('\0');
    });
    // The spies are process-wide, and other work in the same Jest worker,
    // such as an earlier test's background reads, allocates large buffers
    // too. So the digest's own read buffer is identified by its caller, and
    // a whole-file read is caught by size: nothing may allocate a buffer as
    // large as the 256 KiB fixture.
    const largeFile = contents[1].length;
    const readBuffers: number[] = [];
    const wholeFile: number[] = [];
    const record = (size: number): void => {
      if (size >= largeFile) wholeFile.push(size);
      const caller = new Error().stack
        ?.split('\n')
        .find(
          (frame) =>
            !frame.includes('node_modules') &&
            !frame.includes('__tests__') &&
            frame.includes('/'),
        );
      if (size >= 64 * 1024 && caller?.includes('lib/archived-container-git'))
        readBuffers.push(size);
    };
    const originalUnsafe = Buffer.allocUnsafe.bind(Buffer);
    const originalSlow = Buffer.allocUnsafeSlow.bind(Buffer);
    const unsafe = jest
      .spyOn(Buffer, 'allocUnsafe')
      .mockImplementation((size) => {
        record(size);
        return originalUnsafe(size);
      });
    const slow = jest
      .spyOn(Buffer, 'allocUnsafeSlow')
      .mockImplementation((size) => {
        record(size);
        return originalSlow(size);
      });
    try {
      expect(await workspaceRootPayloadDigest({ rootPath: root })).toBe(
        expected.digest('hex'),
      );
      expect(readBuffers).toEqual([64 * 1024]);
      expect(wholeFile).toEqual([]);
    } finally {
      unsafe.mockRestore();
      slow.mockRestore();
    }
  });

  it('closes a payload read handle when verification fails', async () => {
    const root = join(mockRootDir, 'unreadable-payload');
    mkdirSync(root);
    const file = join(root, 'retained.txt');
    writeFileSync(file, 'preserve this file');
    const originalOpen = actualFsPromises.open;
    const failure = new Error('injected read failure');
    let closed = false;
    const spy = jest
      .spyOn(mockedFsPromises, 'open')
      .mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (String(args[0]) === file) {
          jest.spyOn(handle, 'read').mockRejectedValue(failure);
          const originalClose = handle.close.bind(handle);
          jest.spyOn(handle, 'close').mockImplementation(async () => {
            await originalClose();
            closed = true;
          });
        }
        return handle;
      });
    try {
      await expect(workspaceRootPayloadDigest({ rootPath: root })).rejects.toBe(
        failure,
      );
      expect(closed).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe('preserve this file');
    } finally {
      spy.mockRestore();
    }
  });

  it.each([false, true])(
    'bounds concurrent recovery syncs and drains them before publishing or failing (failure=%s)',
    async (failSync) => {
      mkdirSync(join(worktreePath(), 'sync-nested'));
      for (let index = 0; index < 24; index += 1) {
        writeFileSync(
          join(worktreePath(), `sync-${index}.txt`),
          'retained bytes',
        );
        writeFileSync(
          join(worktreePath(), 'sync-nested', `${index}.txt`),
          'nested bytes',
        );
      }
      const originalOpen = actualFsPromises.open;
      const gate = deferred<void>();
      const firstStarted = deferred<void>();
      const secondStarted = deferred<boolean>();
      let started = 0;
      let active = 0;
      let maximum = 0;
      let closed = 0;
      const failure = new Error('injected durability failure');
      const spy = jest
        .spyOn(mockedFsPromises, 'open')
        .mockImplementation(async (...args) => {
          const handle = await originalOpen(...args);
          if (!String(args[0]).includes('recovery-files') || args[1] !== 'r')
            return handle;
          const originalSync = handle.sync.bind(handle);
          if ((await handle.stat()).isDirectory()) {
            jest.spyOn(handle, 'sync').mockImplementation(async () => {
              expect(active).toBe(0);
              await originalSync();
            });
            return handle;
          }
          const originalClose = handle.close.bind(handle);
          let synced = false;
          jest.spyOn(handle, 'close').mockImplementation(async () => {
            await originalClose();
            if (synced) closed += 1;
          });
          jest.spyOn(handle, 'sync').mockImplementation(async () => {
            synced = true;
            const sequence = ++started;
            active += 1;
            maximum = Math.max(maximum, active);
            firstStarted.resolve();
            if (started === 2) secondStarted.resolve(true);
            try {
              await gate.promise;
              if (failSync && sequence === 1) throw failure;
              await originalSync();
            } finally {
              active -= 1;
            }
          });
          return handle;
        });
      const capture = recoveryManifest().then(
        () => null,
        (error: unknown) => error,
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const journal = join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'recovery.staged.json',
      );
      try {
        await firstStarted.promise;
        const overlapped = await Promise.race([
          secondStarted.promise,
          new Promise<boolean>((resolve) => {
            timeout = setTimeout(() => resolve(false), 2_000);
          }),
        ]);
        expect(overlapped).toBe(true);
        expect(existsSync(journal)).toBe(false);
        gate.resolve();
        expect(await capture).toBe(failSync ? failure : null);
        expect(active).toBe(0);
        expect(closed).toBe(started);
        expect(maximum).toBeGreaterThan(1);
        expect(maximum).toBeLessThanOrEqual(8);
        expect(existsSync(journal)).toBe(!failSync);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        gate.resolve();
        await capture;
        spy.mockRestore();
      }
    },
  );

  it('syncs the recovery-files directory before publishing its receipt', async () => {
    const originalOpen = actualFsPromises.open;
    const recoveryFiles = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'recovery-files',
    );
    const journal = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'recovery.staged.json',
    );
    let parentSynced = false;
    let syncCount = 0;
    const spy = jest
      .spyOn(mockedFsPromises, 'open')
      .mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (String(args[0]) === recoveryFiles && args[1] === 'r') {
          const originalSync = handle.sync.bind(handle);
          jest.spyOn(handle, 'sync').mockImplementation(async () => {
            if (syncCount === 0) expect(existsSync(journal)).toBe(false);
            syncCount += 1;
            await originalSync();
            parentSynced = true;
          });
        }
        return handle;
      });
    try {
      await recoveryManifest();
      expect(parentSynced).toBe(true);
      expect(existsSync(journal)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('retains ignored files and inert Git evidence when metadata is irreparable, then removes its exact registration', async () => {
    writeFileSync(join(worktreePath(), '.gitignore'), 'ignored.bin\n');
    writeFileSync(
      join(worktreePath(), 'ignored.bin'),
      Buffer.from([0, 255, 0, 1]),
    );
    const pointer = readFileSync(join(worktreePath(), '.git'), 'utf8');
    const manifest = await recoveryManifest();
    await finishArchivedContainerRecovery(manifest);
    expect(existsSync(worktreePath())).toBe(false);
    expect(
      runGit(mockReferenceRepoPath, ['worktree', 'list', '--porcelain']),
    ).not.toContain(worktreePath());
    expect(
      runGit(mockReferenceRepoPath, [
        'show-ref',
        '--verify',
        'refs/heads/feature/archive',
      ]),
    ).toBeTruthy();
    const destination = join(mockRootDir, 'recovered');
    await restoreArchivedRecoveryFiles(manifest, destination);
    expect(readFileSync(join(destination, 'ignored.bin'))).toEqual(
      Buffer.from([0, 255, 0, 1]),
    );
    expect(existsSync(join(destination, '.git'))).toBe(false);
    const { readdirSync } = jest.requireActual<typeof NodeFs>('node:fs');
    expect(
      readdirSync(destination).some((name) =>
        name.startsWith('.archive-git-evidence-'),
      ),
    ).toBe(false);
    rmSync(join(mockRootDir, 'archives', WORKSPACE_ID, CONTAINER_ID), {
      recursive: true,
    });
    const evidenceRoot = join(
      mockRootDir,
      'worktree-data',
      WORKSPACE_ID,
      'recovered',
      'archive-recovery-evidence',
      CONTAINER_ID,
      'restored-git-evidence',
    );
    expect(readdirSync(evidenceRoot)).toEqual(['.git']);
    expect(readFileSync(join(evidenceRoot, '.git'), 'utf8')).toBe(pointer);
    rmSync(join(mockRootDir, 'worktree-data', WORKSPACE_ID, 'recovered'), {
      recursive: true,
    });
    expect(existsSync(evidenceRoot)).toBe(false);
  });

  it('accounts for an already absent checkout without claiming that its files were captured', async () => {
    rmSync(worktreePath(), { recursive: true });
    const manifest = await recoveryManifest();
    expect(manifest.recovery.source).toBe('absent');
    await finishArchivedContainerRecovery(manifest);
    expect(manifest.recovery.gitCleanupPending).toBe(false);
  });

  it('preserves the live checkout when recovery payload verification fails', async () => {
    const manifest = await recoveryManifest();
    writeFileSync(
      join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'recovery-files',
        manifest.recovery.payloadId,
        'tampered',
      ),
      'changed',
    );
    await expect(finishArchivedContainerRecovery(manifest)).rejects.toThrow(
      'failed verification',
    );
    expect(existsSync(worktreePath())).toBe(true);
  });

  it('keeps a pending cleanup receipt when the source repository is unavailable', async () => {
    const manifest = await recoveryManifest();
    renameSync(mockReferenceRepoPath, `${mockReferenceRepoPath}-away`);
    await finishArchivedContainerRecovery(manifest);
    expect(manifest.recovery.gitCleanupPending).toBe(true);
    expect(existsSync(worktreePath())).toBe(false);
    renameSync(`${mockReferenceRepoPath}-away`, mockReferenceRepoPath);
    await finishArchivedContainerRecovery(manifest);
    expect(manifest.recovery.gitCleanupPending).toBe(false);
  });

  it('completes Git cleanup when recovery captured no repositories', async () => {
    const manifest = await recoveryManifest();
    const journalPath = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'recovery.staged.json',
    );
    const journal: unknown = JSON.parse(readFileSync(journalPath, 'utf8'));
    if (typeof journal !== 'object' || journal === null) {
      throw new Error('Expected a recovery journal object');
    }
    Reflect.set(journal, 'repositories', null);
    writeFileSync(journalPath, JSON.stringify(journal));

    await finishArchivedContainerRecovery(manifest);

    expect(manifest.recovery.gitCleanupPending).toBe(false);
  });

  it('reacquires a repository identity that was unavailable during capture', async () => {
    const unavailablePath = `${mockReferenceRepoPath}-away`;
    renameSync(mockReferenceRepoPath, unavailablePath);
    const manifest = await recoveryManifest();

    await finishArchivedContainerRecovery(manifest);
    expect(manifest.recovery.gitCleanupPending).toBe(true);

    renameSync(unavailablePath, mockReferenceRepoPath);
    await finishArchivedContainerRecovery(manifest);

    expect(manifest.recovery.gitCleanupPending).toBe(false);
    expect(
      runGit(mockReferenceRepoPath, ['worktree', 'list', '--porcelain']),
    ).not.toContain(worktreePath());
  });

  it('keeps cleanup pending when the captured repository path is replaced', async () => {
    const manifest = await recoveryManifest();
    renameSync(mockReferenceRepoPath, `${mockReferenceRepoPath}-captured`);
    mkdirSync(mockReferenceRepoPath, { recursive: true });
    runGit(mockReferenceRepoPath, ['init']);

    await finishArchivedContainerRecovery(manifest);

    expect(manifest.recovery.gitCleanupPending).toBe(true);
    expect(
      runGit(mockReferenceRepoPath, ['rev-parse', '--git-common-dir']),
    ).toBe('.git');
  });

  describe('read-only Git cleanup prediction (CAN-4963)', () => {
    const journalPath = (): string =>
      join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'recovery.staged.json',
      );
    const registrations = (): string =>
      runGit(mockReferenceRepoPath, ['worktree', 'list', '--porcelain']);

    /** Asserts the prediction, then that it changed nothing on disk or in Git. */
    async function expectPrediction(
      manifest: ArchivedContainerRecoveryManifest,
      blocked: boolean,
    ): Promise<void> {
      const journal = readFileSync(journalPath(), 'utf8');
      const checkout = existsSync(worktreePath());
      const recovery = { ...manifest.recovery };
      const registered = existsSync(mockReferenceRepoPath)
        ? registrations()
        : null;

      await expect(
        isArchivedContainerGitCleanupBlocked(manifest),
      ).resolves.toBe(blocked);

      expect(readFileSync(journalPath(), 'utf8')).toBe(journal);
      expect(existsSync(worktreePath())).toBe(checkout);
      expect(manifest.recovery).toEqual(recovery);
      if (registered !== null) expect(registrations()).toBe(registered);
    }

    it('predicts success for a captured checkout the finish step moves away first', async () => {
      const manifest = await recoveryManifest();
      expect(registrations()).toContain(worktreePath());

      await expectPrediction(manifest, false);

      await finishArchivedContainerRecovery(manifest);
      expect(manifest.recovery.gitCleanupPending).toBe(false);
    });

    it('predicts a pending cleanup while the source repository is unavailable, and success once it returns', async () => {
      const manifest = await recoveryManifest();
      renameSync(mockReferenceRepoPath, `${mockReferenceRepoPath}-away`);

      await expectPrediction(manifest, true);
      await finishArchivedContainerRecovery(manifest);
      expect(manifest.recovery.gitCleanupPending).toBe(true);

      renameSync(`${mockReferenceRepoPath}-away`, mockReferenceRepoPath);
      await expectPrediction(manifest, false);
      await finishArchivedContainerRecovery(manifest);
      expect(manifest.recovery.gitCleanupPending).toBe(false);
    });

    it('never records an identity it reacquires', async () => {
      const unavailablePath = `${mockReferenceRepoPath}-away`;
      renameSync(mockReferenceRepoPath, unavailablePath);
      const manifest = await recoveryManifest();
      await expectPrediction(manifest, true);

      renameSync(unavailablePath, mockReferenceRepoPath);
      await expectPrediction(manifest, false);
      expect(JSON.parse(readFileSync(journalPath(), 'utf8'))).toMatchObject({
        repositories: [{ repositoryIdentity: null }],
      });
    });

    it('predicts a pending cleanup when the captured repository path is replaced', async () => {
      const manifest = await recoveryManifest();
      renameSync(mockReferenceRepoPath, `${mockReferenceRepoPath}-captured`);
      mkdirSync(mockReferenceRepoPath, { recursive: true });
      runGit(mockReferenceRepoPath, ['init']);

      await expectPrediction(manifest, true);
      await finishArchivedContainerRecovery(manifest);
      expect(manifest.recovery.gitCleanupPending).toBe(true);
    });

    it('predicts a pending cleanup when a registered canonical path is occupied again after removal', async () => {
      const manifest = await recoveryManifest();
      renameSync(mockReferenceRepoPath, `${mockReferenceRepoPath}-away`);
      await finishArchivedContainerRecovery(manifest);
      renameSync(`${mockReferenceRepoPath}-away`, mockReferenceRepoPath);
      mkdirSync(worktreePath());
      expect(registrations()).toContain(worktreePath());

      await expectPrediction(manifest, true);
      await finishArchivedContainerRecovery(manifest);
      expect(manifest.recovery.gitCleanupPending).toBe(true);
    });

    function setJournalPhase(phase: 'verified' | 'removed'): void {
      writeFileSync(
        journalPath(),
        JSON.stringify({
          ...JSON.parse(readFileSync(journalPath(), 'utf8')),
          phase,
        }),
      );
    }
    const quarantinePath = (): string =>
      join(dirname(worktreePath()), `.${CONTAINER_ID}.archive-quarantine`);
    /** Moves the checkout and its registration, keeping the checkout identity. */
    function moveCheckoutToRegisteredQuarantine(): void {
      runGit(mockReferenceRepoPath, [
        'worktree',
        'move',
        worktreePath(),
        quarantinePath(),
      ]);
      expect(registrations()).toContain(quarantinePath());
    }

    it('predicts success for a verified journal whose registered quarantine the finish step removes first', async () => {
      const manifest = await recoveryManifest();
      moveCheckoutToRegisteredQuarantine();
      setJournalPhase('verified');

      await expectPrediction(manifest, false);
      await finishArchivedContainerRecovery(manifest);
      expect(manifest.recovery.gitCleanupPending).toBe(false);
      expect(existsSync(quarantinePath())).toBe(false);
    });

    it('predicts a pending cleanup for a registered quarantine that a removed journal keeps', async () => {
      const manifest = await recoveryManifest();
      moveCheckoutToRegisteredQuarantine();
      setJournalPhase('removed');

      await expectPrediction(manifest, true);
      await finishArchivedContainerRecovery(manifest);
      expect(manifest.recovery.gitCleanupPending).toBe(true);
      expect(existsSync(quarantinePath())).toBe(true);
    });

    it('predicts a pending cleanup when a verified journal finds the canonical path occupied again', async () => {
      const manifest = await recoveryManifest();
      renameSync(mockReferenceRepoPath, `${mockReferenceRepoPath}-away`);
      await finishArchivedContainerRecovery(manifest);
      renameSync(`${mockReferenceRepoPath}-away`, mockReferenceRepoPath);
      mkdirSync(worktreePath());
      setJournalPhase('verified');

      await expectPrediction(manifest, true);
      await finishArchivedContainerRecovery(manifest);
      expect(manifest.recovery.gitCleanupPending).toBe(true);
    });

    it.each(['first', 'last'] as const)(
      'predicts a pending cleanup when the %s of several repositories is unavailable',
      async (position) => {
        const manifest = await recoveryManifest();
        const journal: unknown = JSON.parse(
          readFileSync(journalPath(), 'utf8'),
        );
        if (!isRecord(journal) || !Array.isArray(journal.repositories))
          throw new Error('Expected a recovery journal with repositories');
        const repositories: unknown[] = journal.repositories;
        const unavailable = {
          referenceRepoPath: join(mockRootDir, 'unavailable-source'),
          repositoryIdentity: null,
          relativePath: '.',
          worktreePaths: [],
        };
        writeFileSync(
          journalPath(),
          JSON.stringify({
            ...journal,
            repositories:
              position === 'first'
                ? [unavailable, ...repositories]
                : [...repositories, unavailable],
          }),
        );
        expect(registrations()).toContain(worktreePath());

        await expectPrediction(manifest, true);
        await finishArchivedContainerRecovery(manifest);
        expect(manifest.recovery.gitCleanupPending).toBe(true);
        // The finish step still cleans up the available repository.
        expect(registrations()).not.toContain(worktreePath());
      },
    );

    it.each([
      [
        'fails',
        Object.assign(new Error('git worktree list failed'), { code: 128 }),
      ],
      [
        'times out',
        Object.assign(new Error('git worktree list timed out'), {
          killed: true,
          signal: 'SIGTERM',
        }),
      ],
    ])(
      'predicts a pending cleanup when git worktree list %s, as the finish step reports',
      async (_label, failure) => {
        const manifest = await recoveryManifest();
        const actualAsync = promisify(
          jest.requireActual<typeof NodeChildProcess>('node:child_process')
            .execFile,
        );
        const asyncMock: unknown = Reflect.get(execFile, promisify.custom);
        if (!jest.isMockFunction(asyncMock))
          throw new Error('Expected promisified execFile to be mocked');
        let listings = 0;
        asyncMock.mockImplementation(
          async (file: string, args: readonly string[], options: object) => {
            if (args[0] === 'worktree' && args[1] === 'list') {
              listings += 1;
              throw failure;
            }
            return actualAsync(file, args, options);
          },
        );
        try {
          await expectPrediction(manifest, true);
          expect(listings).toBe(1);
          // The finish step's walk meets the same failure and stays pending.
          await finishArchivedContainerRecovery(manifest);
          expect(manifest.recovery.gitCleanupPending).toBe(true);
          expect(listings).toBe(2);
        } finally {
          asyncMock.mockImplementation(actualAsync);
        }
        expect(registrations()).toContain(worktreePath());
        await expectPrediction(manifest, false);
        await finishArchivedContainerRecovery(manifest);
        expect(manifest.recovery.gitCleanupPending).toBe(false);
      },
    );

    it('cannot tell without a matching journal', async () => {
      const manifest = await recoveryManifest();
      await expect(
        isArchivedContainerGitCleanupBlocked({
          ...manifest,
          createdAt: '2000-01-01T00:00:00.000Z',
        }),
      ).resolves.toBe(false);
      writeFileSync(journalPath(), '{truncated');
      await expect(
        isArchivedContainerGitCleanupBlocked(manifest),
      ).resolves.toBe(false);
    });
  });

  describe('read-only recovery finish verification (CAN-4994)', () => {
    const journalPath = (): string =>
      join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'recovery.staged.json',
      );
    const quarantinePath = (): string =>
      join(dirname(worktreePath()), `.${CONTAINER_ID}.archive-quarantine`);
    const registrations = (): string =>
      runGit(mockReferenceRepoPath, ['worktree', 'list', '--porcelain']);
    const fileImage = (path: string): string | null =>
      existsSync(path) ? readFileSync(path, 'utf8') : null;
    const directoryIdentity = (path: string): number | null =>
      existsSync(path) ? lstatSync(path).ino : null;
    function setJournal(update: Record<string, unknown>): void {
      const journal: unknown = JSON.parse(readFileSync(journalPath(), 'utf8'));
      if (!isRecord(journal)) throw new Error('Expected a recovery journal');
      writeFileSync(journalPath(), JSON.stringify({ ...journal, ...update }));
    }
    function errorOf(error: unknown): { name: string; message: string } {
      if (!(error instanceof Error)) throw new Error('Expected an error');
      return { name: error.name, message: error.message };
    }

    /**
     * Asserts the verification throws the finish step's own error and changes
     * nothing, then that the finish step throws it too before any effect.
     */
    async function expectFinishRefusal(
      manifest: ArchivedContainerRecoveryManifest,
      expected: { name?: string; message?: string },
    ): Promise<void> {
      const journal = fileImage(journalPath());
      const checkout = directoryIdentity(worktreePath());
      const quarantine = directoryIdentity(quarantinePath());
      const recovery = { ...manifest.recovery };
      const registered = registrations();

      const verification = errorOf(
        await verifyArchivedContainerRecoveryFinish(manifest).then(
          () => null,
          (error: unknown) => error,
        ),
      );

      expect(verification).toMatchObject(expected);
      expect(fileImage(journalPath())).toBe(journal);
      expect(directoryIdentity(worktreePath())).toBe(checkout);
      expect(directoryIdentity(quarantinePath())).toBe(quarantine);
      expect(manifest.recovery).toEqual(recovery);
      expect(registrations()).toBe(registered);
      const finish = errorOf(
        await finishArchivedContainerRecovery(manifest).then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect(finish).toEqual(verification);
      expect(fileImage(journalPath())).toBe(journal);
      expect(directoryIdentity(worktreePath())).toBe(checkout);
    }

    it('passes a captured checkout without moving it, and the finish step completes', async () => {
      const manifest = await recoveryManifest();
      const journal = readFileSync(journalPath(), 'utf8');
      const checkout = lstatSync(worktreePath()).ino;

      await expect(
        verifyArchivedContainerRecoveryFinish(manifest),
      ).resolves.toBeUndefined();

      expect(readFileSync(journalPath(), 'utf8')).toBe(journal);
      expect(lstatSync(worktreePath()).ino).toBe(checkout);
      expect(registrations()).toContain(worktreePath());
      await finishArchivedContainerRecovery(manifest);
      expect(manifest.recovery.gitCleanupPending).toBe(false);
    });

    it('passes a removed journal whose Git cleanup is pending', async () => {
      const manifest = await recoveryManifest();
      renameSync(mockReferenceRepoPath, `${mockReferenceRepoPath}-away`);
      await finishArchivedContainerRecovery(manifest);
      expect(manifest.recovery.gitCleanupPending).toBe(true);

      await expect(
        verifyArchivedContainerRecoveryFinish(manifest),
      ).resolves.toBeUndefined();
    });

    it('passes a verified journal whose quarantine it owns', async () => {
      const manifest = await recoveryManifest();
      runGit(mockReferenceRepoPath, [
        'worktree',
        'move',
        worktreePath(),
        quarantinePath(),
      ]);
      setJournal({ phase: 'verified' });

      await expect(
        verifyArchivedContainerRecoveryFinish(manifest),
      ).resolves.toBeUndefined();

      expect(existsSync(quarantinePath())).toBe(true);
      await finishArchivedContainerRecovery(manifest);
      expect(existsSync(quarantinePath())).toBe(false);
    });

    it('throws for an unparsable journal', async () => {
      const manifest = await recoveryManifest();
      writeFileSync(journalPath(), '{truncated');

      await expectFinishRefusal(manifest, { name: 'SyntaxError' });
    });

    it('throws for a journal of an unknown shape', async () => {
      const manifest = await recoveryManifest();
      setJournal({ version: 2 });

      await expectFinishRefusal(manifest, {
        message:
          'Invalid archive recovery journal; retained files were preserved.',
      });
    });

    it.each([
      ['a missing journal', (): void => rmSync(journalPath())],
      [
        'a journal of another archive generation',
        (): void => setJournal({ createdAt: '2000-01-01T00:00:00.000Z' }),
      ],
    ])('throws for %s', async (_label, plant) => {
      const manifest = await recoveryManifest();
      plant();

      await expectFinishRefusal(manifest, {
        message: 'Archive recovery identity changed.',
      });
    });

    it('throws for a manifest of another payload', async () => {
      const manifest = await recoveryManifest();

      await expectFinishRefusal(
        {
          ...manifest,
          recovery: {
            ...manifest.recovery,
            payloadId: '00000000-0000-4000-8000-000000000009',
          },
        },
        { message: 'Archive recovery identity changed.' },
      );
    });

    it('throws for retained files that fail verification', async () => {
      const manifest = await recoveryManifest();
      writeFileSync(
        join(
          mockRootDir,
          'archives',
          WORKSPACE_ID,
          CONTAINER_ID,
          'recovery-files',
          manifest.recovery.payloadId,
          'tampered',
        ),
        'changed',
      );

      await expectFinishRefusal(manifest, {
        message:
          'The retained recovery files failed verification; cleanup was stopped.',
      });
      expect(existsSync(worktreePath())).toBe(true);
    });

    describe('for an archive being discarded (CAN-5011)', () => {
      const DISCARDING = { discardingArchive: true };
      const payloadDir = (
        manifest: ArchivedContainerRecoveryManifest,
      ): string =>
        join(
          mockRootDir,
          'archives',
          WORKSPACE_ID,
          CONTAINER_ID,
          'recovery-files',
          manifest.recovery.payloadId,
        );

      it.each([
        [
          'changed',
          (path: string): void => writeFileSync(join(path, 'tampered'), 'x'),
        ],
        ['deleted', (path: string): void => rmSync(path, { recursive: true })],
      ])(
        'skips retained files that were %s once no checkout remains, and the finish step completes',
        async (_label, damage) => {
          const manifest = await recoveryManifest();
          renameSync(mockReferenceRepoPath, `${mockReferenceRepoPath}-away`);
          await finishArchivedContainerRecovery(manifest);
          expect(manifest.recovery.gitCleanupPending).toBe(true);
          renameSync(`${mockReferenceRepoPath}-away`, mockReferenceRepoPath);
          damage(payloadDir(manifest));

          await expect(
            verifyArchivedContainerRecoveryFinish(manifest),
          ).rejects.toThrow();
          await expect(
            verifyArchivedContainerRecoveryFinish(manifest, DISCARDING),
          ).resolves.toBeUndefined();
          await finishArchivedContainerRecovery(manifest, DISCARDING);
          expect(manifest.recovery.gitCleanupPending).toBe(false);
          expect(registrations()).not.toContain(worktreePath());
        },
      );

      it('still verifies them while a captured checkout remains', async () => {
        const manifest = await recoveryManifest();
        writeFileSync(join(payloadDir(manifest), 'tampered'), 'changed');

        await expect(
          finishArchivedContainerRecovery(manifest, DISCARDING),
        ).rejects.toThrow(
          'The retained recovery files failed verification; cleanup was stopped.',
        );
        expect(existsSync(worktreePath())).toBe(true);
      });

      it('still verifies them while a verified quarantine remains', async () => {
        const manifest = await recoveryManifest();
        runGit(mockReferenceRepoPath, [
          'worktree',
          'move',
          worktreePath(),
          quarantinePath(),
        ]);
        setJournal({ phase: 'verified' });
        writeFileSync(join(payloadDir(manifest), 'tampered'), 'changed');

        await expect(
          verifyArchivedContainerRecoveryFinish(manifest, DISCARDING),
        ).rejects.toThrow(
          'The retained recovery files failed verification; cleanup was stopped.',
        );
        expect(existsSync(quarantinePath())).toBe(true);
      });
    });

    it('throws for a captured checkout that changed identity', async () => {
      const manifest = await recoveryManifest();
      renameSync(worktreePath(), `${worktreePath()}-captured`);
      mkdirSync(worktreePath());

      await expectFinishRefusal(manifest, {
        message: 'The worktree changed identity during recovery.',
      });
    });

    it('throws for a captured checkout whose files changed', async () => {
      const manifest = await recoveryManifest();
      writeFileSync(join(worktreePath(), 'added-after-capture.txt'), 'new');

      await expectFinishRefusal(manifest, {
        message:
          'The worktree changed after recovery capture; its files were preserved.',
      });
    });

    it('throws for a captured checkout whose quarantine is occupied', async () => {
      const manifest = await recoveryManifest();
      mkdirSync(quarantinePath());

      await expectFinishRefusal(manifest, {
        message: 'Archive recovery quarantine is occupied.',
      });
    });

    it('throws for an occupant that appeared after an absent-worktree capture', async () => {
      rmSync(worktreePath(), { recursive: true });
      const manifest = await recoveryManifest();
      mkdirSync(worktreePath());

      await expectFinishRefusal(manifest, {
        message: 'A new occupant appeared after the absent-worktree capture.',
      });
    });

    it('throws for a verified journal whose quarantine changed identity', async () => {
      const manifest = await recoveryManifest();
      renameSync(worktreePath(), `${worktreePath()}-captured`);
      mkdirSync(quarantinePath());
      setJournal({ phase: 'verified' });

      await expectFinishRefusal(manifest, {
        message:
          'Archive recovery quarantine changed identity; cleanup was stopped.',
      });
    });
  });

  describe('stale registration cleanup and a replacement checkout (CAN-5011)', () => {
    const journalPath = (): string =>
      join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'recovery.staged.json',
      );
    const registrations = (): string =>
      runGit(mockReferenceRepoPath, ['worktree', 'list', '--porcelain']);
    const keepPath = (): string => join(worktreePath(), 'keep');

    /**
     * Adds a replacement checkout at the stale path once the cleanup's absence
     * check has passed: when it first reads Git's registration entries, or
     * first calls Git to unregister.
     */
    async function withReplacementRace(work: () => Promise<void>): Promise<{
      raced: boolean;
    }> {
      const actualAsync = promisify(
        jest.requireActual<typeof NodeChildProcess>('node:child_process')
          .execFile,
      );
      const asyncMock: unknown = Reflect.get(execFile, promisify.custom);
      if (!jest.isMockFunction(asyncMock))
        throw new Error('Expected promisified execFile to be mocked');
      const readFileMock = jest.mocked(mockedFsPromises.readFile);
      const registrationEntries = join(referenceRepoIdentity(), 'worktrees');
      const state = { raced: false };
      const race = (): void => {
        if (state.raced) return;
        state.raced = true;
        runGit(mockReferenceRepoPath, [
          'worktree',
          'add',
          '-f',
          '-b',
          'replacement',
          worktreePath(),
          'main',
        ]);
        writeFileSync(keepPath(), 'replacement work\n');
      };
      asyncMock.mockImplementation(
        async (file: string, args: readonly string[], options: object) => {
          if (
            args[0] === 'worktree' &&
            (args[1] === 'remove' || args[1] === 'prune')
          )
            race();
          return actualAsync(file, args, options);
        },
      );
      readFileMock.mockImplementation((path, options) => {
        if (
          typeof path === 'string' &&
          dirname(dirname(path)) === registrationEntries
        )
          race();
        return actualFsPromises.readFile(path, options);
      });
      try {
        await work();
      } finally {
        asyncMock.mockImplementation(actualAsync);
        readFileMock.mockImplementation(actualFsPromises.readFile);
      }
      return state;
    }

    function expectReplacementKept(): void {
      expect(readFileSync(keepPath(), 'utf8')).toBe('replacement work\n');
      expect(registrations()).toContain(worktreePath());
      expect(
        runGit(worktreePath(), ['rev-parse', '--abbrev-ref', 'HEAD']),
      ).toBe('replacement');
    }

    it("a project deletion's cleanup keeps a checkout added after its absence check", async () => {
      rmSync(worktreePath(), { recursive: true });
      expect(registrations()).toContain(worktreePath());

      await expect(
        withReplacementRace(() =>
          removeProjectWorktreeRegistrations({
            projectId: WORKSPACE_ID,
            repositories: [
              {
                referenceRepoPath: mockReferenceRepoPath,
                registrationPaths: [worktreePath()],
              },
            ],
          }),
        ),
      ).resolves.toEqual({ raced: true });

      expectReplacementKept();
    });

    it("a project deletion's cleanup holds Git's lock on the entry until it removes it (CAN-5034)", async () => {
      rmSync(worktreePath(), { recursive: true });
      const registrationEntries = join(referenceRepoIdentity(), 'worktrees');
      const rmMock = jest.mocked(mockedFsPromises.rm);
      let refusal = '';
      rmMock.mockImplementation((path, rmOptions) => {
        if (
          !refusal &&
          typeof path === 'string' &&
          dirname(path) === registrationEntries
        ) {
          try {
            runGit(mockReferenceRepoPath, [
              'worktree',
              'add',
              '-f',
              '-b',
              'refused',
              worktreePath(),
              'main',
            ]);
            refusal = 'added';
          } catch (error) {
            refusal = error instanceof Error ? error.message : String(error);
          }
        }
        return actualFsPromises.rm(path, rmOptions);
      });
      try {
        await removeProjectWorktreeRegistrations({
          projectId: WORKSPACE_ID,
          repositories: [
            {
              referenceRepoPath: mockReferenceRepoPath,
              registrationPaths: [worktreePath()],
            },
          ],
        });
      } finally {
        rmMock.mockImplementation(actualFsPromises.rm);
      }

      expect(refusal).toMatch(/missing but locked worktree/);
      expect(registrations()).not.toContain(worktreePath());
      runGit(mockReferenceRepoPath, [
        'worktree',
        'add',
        '-b',
        'replacement',
        worktreePath(),
        'main',
      ]);
      writeFileSync(keepPath(), 'replacement work\n');
      expectReplacementKept();
    });

    it("a discarding finish's cleanup keeps a checkout added after its absence check", async () => {
      const manifest = await recoveryManifest();
      rmSync(worktreePath(), { recursive: true });
      writeFileSync(journalPath(), '{truncated');

      await expect(
        withReplacementRace(async () => {
          await finishArchivedContainerRecovery(manifest, {
            discardingArchive: true,
          });
        }),
      ).resolves.toEqual({ raced: true });

      expectReplacementKept();
    });

    it("a journal-driven finish's cleanup keeps a checkout added after its absence check, and stays pending", async () => {
      const manifest = await recoveryManifest();
      renameSync(mockReferenceRepoPath, `${mockReferenceRepoPath}-away`);
      await finishArchivedContainerRecovery(manifest);
      expect(manifest.recovery.gitCleanupPending).toBe(true);
      renameSync(`${mockReferenceRepoPath}-away`, mockReferenceRepoPath);
      expect(existsSync(worktreePath())).toBe(false);
      expect(registrations()).toContain(worktreePath());

      await expect(
        withReplacementRace(async () => {
          await finishArchivedContainerRecovery(manifest);
        }),
      ).resolves.toEqual({ raced: true });

      expectReplacementKept();
      expect(manifest.recovery.gitCleanupPending).toBe(true);
    });

    it('still clears a locked stale registration, as predicted', async () => {
      const manifest = await recoveryManifest();
      runGit(mockReferenceRepoPath, ['worktree', 'lock', worktreePath()]);
      expect(registrations()).toMatch(/^locked$/m);
      const journal = readFileSync(journalPath(), 'utf8');

      await expect(
        isArchivedContainerGitCleanupBlocked(manifest),
      ).resolves.toBe(false);
      expect(readFileSync(journalPath(), 'utf8')).toBe(journal);
      expect(registrations()).toMatch(/^locked$/m);

      await finishArchivedContainerRecovery(manifest);
      expect(manifest.recovery.gitCleanupPending).toBe(false);
      expect(registrations()).not.toContain(worktreePath());
    });
  });

  describe("stale registration cleanup and another archive's moved checkout (CAN-5011)", () => {
    const OTHER_ID = 'archive-2';
    const otherWorktree: WorktreeData = {
      id: OTHER_ID,
      branchName: 'feature/other',
      trackedBaseBranch: 'main',
      createdAt: '2026-07-21T00:00:00.000Z',
    };
    const registrations = (): string =>
      runGit(mockReferenceRepoPath, ['worktree', 'list', '--porcelain']);
    const quarantinePath = (
      projectId = WORKSPACE_ID,
      containerId = CONTAINER_ID,
    ): string =>
      join(
        mockRootDir,
        'worktrees',
        projectId,
        `.${containerId}.archive-quarantine`,
      );

    /**
     * Leaves this archive (or `archive`) as a crash after its teardown moved
     * the checkout into the quarantine and before `git worktree repair`
     * followed it, so Git still registers the now-empty checkout path.
     */
    async function interruptTeardownBeforeRepair(
      archive: { projectId: string; worktree: WorktreeData } = {
        projectId: WORKSPACE_ID,
        worktree: persistedWorktree(),
      },
    ): Promise<
      Awaited<ReturnType<typeof captureArchivedContainerGitState>>['gitState']
    > {
      const { projectId, worktree } = archive;
      const checkout = join(mockRootDir, 'worktrees', projectId, worktree.id);
      const capture = await captureArchivedContainerGitState({
        workspaceId: projectId,
        containerId: worktree.id,
        workspaceType: 'single-repo',
        worktreePath: checkout,
        persistedWorktree: worktree,
      });
      const descriptor = await readArchivedGitStagedDescriptor(
        projectId,
        worktree.id,
      );
      if (!descriptor) throw new Error('Expected staged descriptor');
      writeFileSync(
        join(
          mockRootDir,
          'archives',
          projectId,
          worktree.id,
          'git-state.staged.json',
        ),
        JSON.stringify({
          ...descriptor,
          teardown: {
            phase: 'quarantine-pending',
            canonicalPath: checkout,
            quarantinePath: quarantinePath(projectId, worktree.id),
            enteredAt: '2026-07-22T00:00:00.000Z',
          },
        }),
      );
      renameSync(checkout, quarantinePath(projectId, worktree.id));
      return capture.gitState;
    }

    const resumes: Array<
      [
        string,
        (
          gitState: Awaited<
            ReturnType<typeof captureArchivedContainerGitState>
          >['gitState'],
        ) => Promise<void>,
      ]
    > = [
      [
        'startup recovery',
        async (): Promise<void> => {
          await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);
          expect(archiveSingleRepoWorktree).toHaveBeenCalledWith({
            workspaceId: WORKSPACE_ID,
            worktreeId: CONTAINER_ID,
            retainAsArchivedContainer: true,
          });
          expect(existsSync(quarantinePath())).toBe(false);
        },
      ],
      [
        'a retried teardown',
        async (gitState): Promise<void> => {
          await prepareArchivedContainerTeardown({
            workspaceId: WORKSPACE_ID,
            containerId: CONTAINER_ID,
            workspaceType: 'single-repo',
            gitState,
          });
        },
      ],
    ];

    const cleanups: Array<[string, () => Promise<unknown>]> = [
      [
        "a project deletion's cleanup",
        (): Promise<void> => {
          rmSync(worktreePath(OTHER_ID), { recursive: true });
          return removeProjectWorktreeRegistrations({
            projectId: WORKSPACE_ID,
            repositories: [
              {
                referenceRepoPath: mockReferenceRepoPath,
                registrationPaths: [worktreePath(OTHER_ID)],
              },
            ],
          });
        },
      ],
      [
        'a discarding finish without a journal',
        (): Promise<string[]> => {
          rmSync(worktreePath(OTHER_ID), { recursive: true });
          return finishArchivedContainerRecovery(
            {
              version: 3,
              kind: 'worktree',
              id: OTHER_ID,
              projectId: WORKSPACE_ID,
              name: 'Other',
              createdAt: otherWorktree.createdAt,
              archivedAt: '2026-07-22T00:00:00.000Z',
              retentionDays: 7,
              expiresAt: '2026-07-29T00:00:00.000Z',
              chatCount: 0,
              archivedChatCount: 0,
              executionCount: 0,
              workspaceType: 'single-repo',
              originalWorktree: otherWorktree,
              recovery: {
                kind: 'files-only',
                source: 'absent',
                digest: '0'.repeat(64),
                payloadId: '00000000-0000-0000-0000-000000000000',
              },
            },
            { discardingArchive: true },
          );
        },
      ],
      [
        "a journal-driven finish's cleanup",
        async (): Promise<string[]> =>
          finishArchivedContainerRecovery({
            version: 3,
            kind: 'worktree',
            id: OTHER_ID,
            projectId: WORKSPACE_ID,
            name: 'Other',
            createdAt: otherWorktree.createdAt,
            archivedAt: '2026-07-22T00:00:00.000Z',
            retentionDays: 7,
            expiresAt: '2026-07-29T00:00:00.000Z',
            chatCount: 0,
            archivedChatCount: 0,
            executionCount: 0,
            workspaceType: 'single-repo',
            originalWorktree: otherWorktree,
            recovery: await prepareArchivedContainerRecovery({
              projectId: WORKSPACE_ID,
              worktreeId: OTHER_ID,
              worktree: otherWorktree,
            }),
          }),
      ],
    ];

    it.each(
      cleanups.flatMap(([cleanupName, cleanup]) =>
        resumes.map(
          ([resumeName, resume]) =>
            [cleanupName, resumeName, cleanup, resume] as const,
        ),
      ),
    )(
      '%s leaves its registration, so %s still repairs it',
      async (_cleanupName, _resumeName, cleanup, resume) => {
        runGit(mockReferenceRepoPath, [
          'worktree',
          'add',
          '-b',
          'feature/other',
          worktreePath(OTHER_ID),
          'main',
        ]);
        const gitState = await interruptTeardownBeforeRepair();

        await cleanup();

        expect(registrations()).not.toContain(worktreePath(OTHER_ID));
        expect(registrations()).toContain(worktreePath());
        await resume(gitState);
        await expect(
          readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID),
        ).resolves.toMatchObject({ teardown: { phase: 'verified' } });
        expect(registrations()).not.toContain(worktreePath());
      },
    );

    describe('archive teardown cleanup (CAN-5034)', () => {
      const OTHER_PROJECT_ID = 'workspace-2';
      const otherProjectCheckout = (): string =>
        join(mockRootDir, 'worktrees', OTHER_PROJECT_ID, OTHER_ID);

      const addOtherCheckout = (): void => {
        runGit(mockReferenceRepoPath, [
          'worktree',
          'add',
          '-b',
          'feature/other',
          worktreePath(OTHER_ID),
          'main',
        ]);
      };
      const removeWithArchiveWorker = (
        checkout = worktreePath(OTHER_ID),
        preMoveWorktreePath?: string,
      ): Promise<unknown> =>
        executeArchiveIoRequest(
          {
            version: 1,
            type: 'remove-worktree',
            requestId: 'remove-other-worktree',
            operationId: `archive:${WORKSPACE_ID}:${OTHER_ID}:remove-worktree:main`,
            projectId: WORKSPACE_ID,
            containerId: OTHER_ID,
            expectedCreatedAt: otherWorktree.createdAt,
            input: {
              git: {
                executable: 'git',
                env: Object.fromEntries(
                  Object.entries(process.env).filter(
                    (entry): entry is [string, string] =>
                      typeof entry[1] === 'string',
                  ),
                ),
              },
              referenceRepoPath: mockReferenceRepoPath,
              expectedRepositoryIdentity: referenceRepoIdentity(),
              worktreePath: checkout,
              ...(preMoveWorktreePath ? { preMoveWorktreePath } : {}),
            },
          },
          new AbortController().signal,
          {
            progress: jest.fn(),
            child: { started: jest.fn(), exited: jest.fn() },
          },
        );

      const teardownCleanups: Array<[string, () => Promise<unknown>]> = [
        [
          "the archive worker's worktree removal",
          (): Promise<unknown> => {
            addOtherCheckout();
            return removeWithArchiveWorker();
          },
        ],
        [
          "another project's verified teardown",
          async (): Promise<void> => {
            // Its own interrupted teardown, which startup recovery repairs
            // and finishes; this archive is in another project's directory.
            mkdirSync(dirname(otherProjectCheckout()), { recursive: true });
            runGit(mockReferenceRepoPath, [
              'worktree',
              'add',
              '-b',
              'feature/other-project',
              otherProjectCheckout(),
              'main',
            ]);
            await interruptTeardownBeforeRepair({
              projectId: OTHER_PROJECT_ID,
              worktree: {
                ...otherWorktree,
                branchName: 'feature/other-project',
              },
            });
            jest.mocked(archiveSingleRepoWorktree).mockClear();
            await recoverArchivedGitTeardownsForWorkspace(OTHER_PROJECT_ID);
            expect(archiveSingleRepoWorktree).toHaveBeenCalledWith({
              workspaceId: OTHER_PROJECT_ID,
              worktreeId: OTHER_ID,
              retainAsArchivedContainer: true,
            });
            expect(existsSync(quarantinePath(OTHER_PROJECT_ID, OTHER_ID))).toBe(
              false,
            );
            expect(registrations()).not.toContain(
              quarantinePath(OTHER_PROJECT_ID, OTHER_ID),
            );
            expect(registrations()).not.toContain(otherProjectCheckout());
          },
        ],
      ];

      it.each(
        teardownCleanups.flatMap(([cleanupName, cleanup]) =>
          resumes.map(
            ([resumeName, resume]) =>
              [cleanupName, resumeName, cleanup, resume] as const,
          ),
        ),
      )(
        '%s leaves its registration, so %s still repairs it',
        async (_cleanupName, _resumeName, cleanup, resume) => {
          const gitState = await interruptTeardownBeforeRepair();

          await cleanup();

          expect(registrations()).not.toContain(worktreePath(OTHER_ID));
          expect(registrations()).toContain(worktreePath());
          jest.mocked(archiveSingleRepoWorktree).mockClear();
          await resume(gitState);
          await expect(
            readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID),
          ).resolves.toMatchObject({ teardown: { phase: 'verified' } });
          expect(registrations()).not.toContain(worktreePath());
        },
      );

      it("the archive worker's worktree removal still clears its own stale registration", async () => {
        addOtherCheckout();
        rmSync(worktreePath(OTHER_ID), { recursive: true });
        expect(registrations()).toContain(worktreePath(OTHER_ID));

        await removeWithArchiveWorker();

        expect(registrations()).not.toContain(worktreePath(OTHER_ID));
      });

      const otherEntry = (): string =>
        join(referenceRepoIdentity(), 'worktrees', OTHER_ID);

      it("the archive worker's worktree removal clears its stale registration a crashed cleanup left locked", async () => {
        addOtherCheckout();
        rmSync(worktreePath(OTHER_ID), { recursive: true });
        writeFileSync(join(otherEntry(), 'locked'), CRASHED_CLEANUP_LOCK);

        await removeWithArchiveWorker();

        expect(registrations()).not.toContain(worktreePath(OTHER_ID));
      });

      it("the archive worker's worktree removal still refuses a user-locked registration", async () => {
        addOtherCheckout();
        rmSync(worktreePath(OTHER_ID), { recursive: true });
        runGit(mockReferenceRepoPath, [
          'worktree',
          'lock',
          worktreePath(OTHER_ID),
        ]);

        await expect(removeWithArchiveWorker()).rejects.toThrow(
          'Archive removal cannot target a locked worktree.',
        );
        expect(registrations()).toContain(worktreePath(OTHER_ID));
      });

      /** An unmanaged linked worktree, which teardown moves but never repairs. */
      const moveOtherIntoQuarantine = (): string => {
        const moved = join(quarantinePath(), 'repos', OTHER_ID);
        mkdirSync(dirname(moved), { recursive: true });
        renameSync(worktreePath(OTHER_ID), moved);
        return moved;
      };

      it.each([
        ['', false],
        [', also after a crashed cleanup left it locked', true],
      ])(
        "the archive worker's worktree removal clears the named pre-move registration of a checkout moved without repair%s",
        async (_case, crashedCleanup) => {
          await interruptTeardownBeforeRepair();
          addOtherCheckout();
          const moved = moveOtherIntoQuarantine();
          if (crashedCleanup)
            writeFileSync(join(otherEntry(), 'locked'), CRASHED_CLEANUP_LOCK);
          expect(registrations()).toContain(worktreePath(OTHER_ID));

          await removeWithArchiveWorker(moved, worktreePath(OTHER_ID));

          expect(registrations()).not.toContain(worktreePath(OTHER_ID));
          expect(registrations()).toContain(worktreePath());
        },
      );

      it("the archive worker's retried removal keeps another quarantined checkout's registration that reused its entry id (CAN-5034)", async () => {
        addOtherCheckout();
        const moved = moveOtherIntoQuarantine();
        // A cleanup removed the moved checkout's entry, then crashed before
        // the quarantine was removed; Git then reused the id.
        rmSync(otherEntry(), { recursive: true });
        mkdirSync(dirname(otherProjectCheckout()), { recursive: true });
        runGit(mockReferenceRepoPath, [
          'worktree',
          'add',
          '-b',
          'feature/reuser',
          otherProjectCheckout(),
          'main',
        ]);
        expect(readFileSync(join(otherEntry(), 'gitdir'), 'utf8')).toContain(
          otherProjectCheckout(),
        );
        // Moved into its own quarantine, awaiting repair.
        renameSync(
          otherProjectCheckout(),
          quarantinePath(OTHER_PROJECT_ID, OTHER_ID),
        );

        await removeWithArchiveWorker(moved, worktreePath(OTHER_ID));

        expect(registrations()).toContain(otherProjectCheckout());
        runGit(mockReferenceRepoPath, [
          'worktree',
          'repair',
          quarantinePath(OTHER_PROJECT_ID, OTHER_ID),
        ]);
        expect(registrations()).toContain(
          quarantinePath(OTHER_PROJECT_ID, OTHER_ID),
        );
      });
    });
  });

  describe('live worktree source admission (CAN-4985)', () => {
    const unavailable = (
      worktree: WorktreeData = persistedWorktree(),
      kind: 'single-repo' | 'multi-repo' = 'single-repo',
    ): Promise<boolean> =>
      isWorktreeArchiveSourceUnavailable(WORKSPACE_ID, worktree, kind);
    function hideReferenceRepo(): void {
      renameSync(mockReferenceRepoPath, `${mockReferenceRepoPath}-hidden`);
    }
    function initRepository(path: string): void {
      mkdirSync(path, { recursive: true });
      runGit(path, ['init', '-q', '-b', 'main']);
    }
    function configureMultiRepo(
      repos: { id: string; repoPath: string }[],
      sourceRepoPath: string | null = null,
    ): void {
      jest.mocked(readWorkspaceConfig).mockResolvedValue({
        version: 1,
        type: 'multi-repo',
        repos: [],
      });
      const effectiveConfig: EffectiveWorkspaceConfig = {
        localConfig: { version: 1, type: 'multi-repo', repos: [] },
        manifest: null,
        sourceRepoPath: sourceRepoPath ?? undefined,
        repos: repos.map((repo) => ({ ...repo, name: repo.id })),
        scripts: undefined,
        defaultPluginSelections: undefined,
        suppressedManifestRepos: [],
        unresolvedManifestRepoIds: [],
      };
      jest
        .mocked(readEffectiveWorkspaceConfig)
        .mockResolvedValue(
          sourceRepoPath === null
            ? withLegacyNullSourceRepoPath(effectiveConfig)
            : effectiveConfig,
        );
    }
    /** repo-a has a checkout under `repos/`; repo-b, whose source is missing, has none. */
    function configurePartialCheckout(): string {
      const present = join(mockRootDir, 'repo-present');
      initRepository(present);
      configureMultiRepo([
        { id: 'repo-a', repoPath: present },
        { id: 'repo-b', repoPath: join(mockRootDir, 'repo-missing') },
      ]);
      mkdirSync(join(worktreePath(), 'repos', 'repo-a'), { recursive: true });
      return present;
    }

    it('admits an available single-repo source and refuses a missing one', async () => {
      await expect(unavailable()).resolves.toBe(false);
      hideReferenceRepo();
      await expect(unavailable()).resolves.toBe(true);
    });

    it('checks a repository once per admission', async () => {
      const commonDir = jest.spyOn(git, 'getGitCommonDir');
      const available = new Set<string>();
      for (const worktreeId of ['first', 'second'])
        await expect(
          isWorktreeArchiveSourceUnavailable(
            WORKSPACE_ID,
            { ...persistedWorktree(), id: worktreeId },
            'single-repo',
            available,
          ),
        ).resolves.toBe(false);
      expect(commonDir).toHaveBeenCalledTimes(1);
      expect(available).toEqual(new Set([mockReferenceRepoPath]));
      commonDir.mockRestore();
    });

    it('refuses a source directory that Git cannot open', async () => {
      rmSync(join(mockReferenceRepoPath, '.git'), {
        recursive: true,
        force: true,
      });
      await expect(unavailable()).resolves.toBe(true);
    });

    it('checks only the repositories a multi-repo worktree includes', async () => {
      configurePartialCheckout();
      await expect(
        unavailable(
          { ...persistedWorktree(), includedRepoIds: ['repo-a'] },
          'multi-repo',
        ),
      ).resolves.toBe(false);
      await expect(
        unavailable(
          { ...persistedWorktree(), includedRepoIds: ['repo-a', 'repo-b'] },
          'multi-repo',
        ),
      ).resolves.toBe(true);
    });

    it('without an inclusion list, checks the repositories a live checkout holds, as its Git capture does', async () => {
      configurePartialCheckout();
      await expect(
        unavailable(persistedWorktree(), 'multi-repo'),
      ).resolves.toBe(false);
      mkdirSync(join(worktreePath(), 'repos', 'repo-b'));
      await expect(
        unavailable(persistedWorktree(), 'multi-repo'),
      ).resolves.toBe(true);
    });

    it('without a checkout, checks every configured repository, as its files-only recovery does', async () => {
      configurePartialCheckout();
      runGit(mockReferenceRepoPath, [
        'worktree',
        'remove',
        '--force',
        worktreePath(),
      ]);
      await expect(
        unavailable(persistedWorktree(), 'multi-repo'),
      ).resolves.toBe(true);
      await expect(
        unavailable(
          { ...persistedWorktree(), includedRepoIds: ['repo-a'] },
          'multi-repo',
        ),
      ).resolves.toBe(false);
    });

    it('follows the archive for a worktree restored from a files-only archive: Git capture once it has Git again, otherwise every configured repository', async () => {
      configurePartialCheckout();
      const restored = {
        ...persistedWorktree(),
        restoredFromFilesOnlyArchiveId: 'files-only-archive',
      };
      // The checkout root holds a .git pointer, so the archive captures Git.
      await expect(
        isFilesOnlyRestoreGitless(worktreePath(), 'multi-repo'),
      ).resolves.toBe(false);
      await expect(unavailable(restored, 'multi-repo')).resolves.toBe(false);
      // Still Git-less: the files-only recovery walks repo-b too.
      rmSync(join(worktreePath(), '.git'), { force: true });
      await expect(
        isFilesOnlyRestoreGitless(worktreePath(), 'multi-repo'),
      ).resolves.toBe(true);
      await expect(unavailable(restored, 'multi-repo')).resolves.toBe(true);
    });

    it('checks the multi-repo workspace root source', async () => {
      const present = join(mockRootDir, 'repo-present');
      initRepository(present);
      configureMultiRepo(
        [{ id: 'repo-a', repoPath: present }],
        join(mockRootDir, 'root-missing'),
      );
      await expect(
        unavailable(
          { ...persistedWorktree(), includedRepoIds: ['repo-a'] },
          'multi-repo',
        ),
      ).resolves.toBe(true);
    });

    it('checks the repositories an earlier capture staged', async () => {
      const staged = join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'git-state.staged.json',
      );
      mkdirSync(dirname(staged), { recursive: true });
      writeFileSync(
        staged,
        JSON.stringify({
          version: 1,
          status: 'capturing',
          repositories: [pullRequestRepository('repo-staged')],
        }),
      );
      await expect(
        readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID),
      ).resolves.toMatchObject({ status: 'capturing' });
      await expect(unavailable()).resolves.toBe(true);
    });

    it('leaves a legacy ready descriptor with teardown metadata unwritten', async () => {
      const capture = await captureArchivedContainerGitState({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'single-repo',
        worktreePath: worktreePath(),
        persistedWorktree: persistedWorktree(),
      });
      await prepareArchivedContainerTeardown({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'single-repo',
        gitState: capture.gitState,
      });
      const stagedPath = join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'git-state.staged.json',
      );
      const staged: unknown = JSON.parse(readFileSync(stagedPath, 'utf8'));
      if (!isRecord(staged)) throw new Error('Expected staged descriptor');
      delete staged.pullRequestMetadata;
      const legacy = JSON.stringify(staged);
      writeFileSync(stagedPath, legacy);

      await expect(unavailable()).resolves.toBe(false);
      expect(readFileSync(stagedPath, 'utf8')).toBe(legacy);
      // One admission: this worktree admits, then a later one's staged capture
      // names a missing repository and refuses the deletion.
      const later = { ...persistedWorktree(), id: 'later' };
      const laterStagedPath = join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        later.id,
        'git-state.staged.json',
      );
      mkdirSync(dirname(laterStagedPath), { recursive: true });
      writeFileSync(
        laterStagedPath,
        JSON.stringify({
          version: 1,
          status: 'capturing',
          repositories: [pullRequestRepository('repo-staged')],
        }),
      );
      const available = new Set<string>();
      await expect(
        isWorktreeArchiveSourceUnavailable(
          WORKSPACE_ID,
          persistedWorktree(),
          'single-repo',
          available,
        ),
      ).resolves.toBe(false);
      await expect(
        isWorktreeArchiveSourceUnavailable(
          WORKSPACE_ID,
          later,
          'single-repo',
          available,
        ),
      ).resolves.toBe(true);
      expect(readFileSync(stagedPath, 'utf8')).toBe(legacy);
      hideReferenceRepo();
      await expect(unavailable()).resolves.toBe(true);
      expect(readFileSync(stagedPath, 'utf8')).toBe(legacy);
    });

    describe('a staged capture', () => {
      const multiRepoCapture = (): ReturnType<
        typeof captureArchivedContainerGitState
      > =>
        captureArchivedContainerGitState({
          workspaceId: WORKSPACE_ID,
          containerId: CONTAINER_ID,
          workspaceType: 'multi-repo',
          worktreePath: worktreePath(),
          persistedWorktree: persistedWorktree(),
        });
      function configurationUnreadable(): void {
        jest.mocked(readWorkspaceConfigDetailed).mockResolvedValueOnce({
          config: { version: 1, type: 'multi-repo', repos: [] },
          authority: 'unreadable',
          ownerMalformed: false,
          memoryMalformed: false,
        });
        jest
          .mocked(readEffectiveWorkspaceConfig)
          .mockRejectedValue(new Error('manifest unreadable'));
      }

      it('checks only the repositories a ready capture holds, as its Git capture reuses them', async () => {
        const { referenceRepoPath } = setupPartialMultiRepoFixture();
        await multiRepoCapture();
        // repo-b has no checkout, and its source is gone.
        configureMultiRepo([
          { id: 'repo-a', repoPath: referenceRepoPath },
          { id: 'repo-b', repoPath: join(mockRootDir, 'repo-missing') },
        ]);

        await expect(
          unavailable(persistedWorktree(), 'multi-repo'),
        ).resolves.toBe(false);
        // The archive reuses the ready capture without opening repo-b.
        await expect(multiRepoCapture()).resolves.toMatchObject({
          gitState: {
            repositories: [expect.objectContaining({ repoId: 'repo-a' })],
          },
        });
        renameSync(referenceRepoPath, `${referenceRepoPath}-hidden`);
        await expect(
          unavailable(persistedWorktree(), 'multi-repo'),
        ).resolves.toBe(true);
      });

      it('refuses a ready capture whose configuration cannot be read, as its Git capture cannot resolve it', async () => {
        setupPartialMultiRepoFixture();
        await multiRepoCapture();
        configurationUnreadable();

        await expect(
          unavailable(persistedWorktree(), 'multi-repo'),
        ).resolves.toBe(true);
        await expect(multiRepoCapture()).rejects.toThrow('manifest unreadable');
      });

      it('refuses an earlier partial capture of a live checkout whose configuration cannot be read', async () => {
        const { referenceRepoPath } = setupPartialMultiRepoFixture();
        const staged = join(
          mockRootDir,
          'archives',
          WORKSPACE_ID,
          CONTAINER_ID,
          'git-state.staged.json',
        );
        mkdirSync(dirname(staged), { recursive: true });
        writeFileSync(
          staged,
          JSON.stringify({
            version: 1,
            status: 'capturing',
            repositories: [
              { ...pullRequestRepository('repo-a'), referenceRepoPath },
            ],
          }),
        );
        configurationUnreadable();

        await expect(
          unavailable(persistedWorktree(), 'multi-repo'),
        ).resolves.toBe(true);
        await expect(multiRepoCapture()).rejects.toThrow('manifest unreadable');
      });

      it('refuses a ready capture whose repositories no longer match the configuration, as its Git capture rejects it', async () => {
        const { referenceRepoPath } = setupPartialMultiRepoFixture();
        await multiRepoCapture();
        const other = join(mockRootDir, 'other-reference');
        initRepository(other);
        // Same repository id, another valid source.
        configureMultiRepo([
          { id: 'repo-a', repoPath: other },
          { id: 'repo-b', repoPath: referenceRepoPath },
        ]);
        await expect(
          unavailable(persistedWorktree(), 'multi-repo'),
        ).resolves.toBe(true);
        await expect(multiRepoCapture()).rejects.toThrow(
          'Archived repository repo-a failed integrity validation.',
        );
        // Another repository id, so the capture keeps no repository.
        configureMultiRepo([{ id: 'repo-c', repoPath: referenceRepoPath }]);
        await expect(
          unavailable(persistedWorktree(), 'multi-repo'),
        ).resolves.toBe(true);
        await expect(multiRepoCapture()).rejects.toThrow(
          'The worktree has no configured repositories to archive.',
        );
      });

      it('refuses a single-repo ready capture of another repository', async () => {
        await captureArchivedContainerGitState({
          workspaceId: WORKSPACE_ID,
          containerId: CONTAINER_ID,
          workspaceType: 'single-repo',
          worktreePath: worktreePath(),
          persistedWorktree: persistedWorktree(),
        });
        const other = join(mockRootDir, 'other-reference');
        initRepository(other);
        jest.mocked(readWorkspaceConfig).mockResolvedValue(
          withLegacyMissingRepos({
            version: 1,
            type: 'single-repo',
            repoPath: other,
            repos: [],
          }),
        );
        // Once for admission, once for the archive's capture.
        jest
          .mocked(resolveProjectReferenceRepoPath)
          .mockResolvedValueOnce(other)
          .mockResolvedValueOnce(other);

        await expect(unavailable()).resolves.toBe(true);
        await expect(
          captureArchivedContainerGitState({
            workspaceId: WORKSPACE_ID,
            containerId: CONTAINER_ID,
            workspaceType: 'single-repo',
            worktreePath: worktreePath(),
            persistedWorktree: persistedWorktree(),
          }),
        ).rejects.toThrow('failed integrity validation');
      });
    });

    it('refuses a single-repo project whose configuration names no repository, as its archive fails after the teardown', async () => {
      jest.mocked(readWorkspaceConfig).mockResolvedValue({
        version: 1,
        type: 'single-repo',
        repos: [],
      });
      await expect(unavailable()).resolves.toBe(true);
      jest.mocked(readWorkspaceConfigDetailed).mockResolvedValueOnce({
        config: { version: 1, type: 'multi-repo', repos: [] },
        authority: 'unreadable',
        ownerMalformed: false,
        memoryMalformed: false,
      });
      await expect(unavailable()).resolves.toBe(true);
    });

    it('admits a multi-repo worktree without a checkout whose configuration cannot be read, as its files-only recovery needs no repository', async () => {
      runGit(mockReferenceRepoPath, [
        'worktree',
        'remove',
        '--force',
        worktreePath(),
      ]);
      jest.mocked(readWorkspaceConfigDetailed).mockResolvedValueOnce({
        config: { version: 1, type: 'multi-repo', repos: [] },
        authority: 'unreadable',
        ownerMalformed: false,
        memoryMalformed: false,
      });
      jest
        .mocked(readEffectiveWorkspaceConfig)
        .mockRejectedValue(new Error('manifest unreadable'));
      await expect(
        unavailable(persistedWorktree(), 'multi-repo'),
      ).resolves.toBe(false);
    });

    it('refuses a live multi-repo checkout whose effective configuration cannot be read, as its Git capture fails the same way', async () => {
      configureMultiRepo([]);
      jest
        .mocked(readEffectiveWorkspaceConfig)
        .mockRejectedValue(new Error('manifest unreadable'));
      await expect(
        unavailable(persistedWorktree(), 'multi-repo'),
      ).resolves.toBe(true);
    });

    it('refuses a live multi-repo checkout with no repository to capture, as its Git capture throws after the teardown', async () => {
      configurePartialCheckout();
      rmSync(join(worktreePath(), 'repos'), { recursive: true, force: true });
      await expect(
        unavailable(persistedWorktree(), 'multi-repo'),
      ).resolves.toBe(true);
      // An unreadable manifest reads as an empty default configuration.
      configurePartialCheckout();
      jest.mocked(readWorkspaceConfigDetailed).mockResolvedValueOnce({
        config: { version: 1, type: 'single-repo', repos: [] },
        authority: 'unreadable',
        ownerMalformed: false,
        memoryMalformed: false,
      });
      await expect(
        unavailable(persistedWorktree(), 'multi-repo'),
      ).resolves.toBe(true);
    });

    it('admits a project of another kind, whose archive refuses before any effect', async () => {
      hideReferenceRepo();
      configureMultiRepo([]);
      await expect(unavailable()).resolves.toBe(false);
    });

    it('refuses when the configuration read fails', async () => {
      jest
        .mocked(readWorkspaceConfigDetailed)
        .mockRejectedValueOnce(new Error('config read failed'));
      await expect(unavailable()).resolves.toBe(true);
    });
  });

  it('does not replace a quarantine directory created during the move', async () => {
    const canonical = worktreePath();
    const quarantine = join(
      mockRootDir,
      'worktrees',
      WORKSPACE_ID,
      `.${CONTAINER_ID}.archive-quarantine-race`,
    );
    const realLstat = actualFsPromises.lstat;
    let canonicalReads = 0;
    let occupantInode: number | undefined;
    const lstatSpy = jest
      .spyOn(mockedFsPromises, 'lstat')
      .mockImplementation(async (path, options) => {
        if (String(path) === canonical) {
          canonicalReads += 1;
          if (canonicalReads === 2) {
            mkdirSync(quarantine);
            occupantInode = lstatSync(quarantine).ino;
          }
        }
        return realLstat(path, options);
      });
    try {
      await expect(
        prepareArchiveTeardown({
          canonicalPath: canonical,
          quarantinePath: quarantine,
          signal: new AbortController().signal,
          child: { started: jest.fn(), exited: jest.fn() },
        }),
      ).rejects.toThrow('quarantine');
      const current = lstatSync(quarantine);
      expect(current.ino).toBe(occupantInode);
      expect(existsSync(canonical)).toBe(true);
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it('retains an interrupted physical copy even when the checkout has since disappeared', async () => {
    const orphanId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const orphan = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'recovery-files',
      orphanId,
    );
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, 'only-surviving-copy.txt'), 'keep me');
    rmSync(worktreePath(), { recursive: true });
    const manifest = await recoveryManifest();
    expect(manifest.recovery.source).toBe('partial');
    await finishArchivedContainerRecovery(manifest);
    const destination = join(mockRootDir, 'partial-recovered');
    await restoreArchivedRecoveryFiles(manifest, destination);
    const { readdirSync } = jest.requireActual<typeof NodeFs>('node:fs');
    expect(
      readdirSync(destination).some((name) =>
        /^\.archive-recovery-previous-[a-f0-9-]{36}$/.test(name),
      ),
    ).toBe(false);
    const evidenceRoot = join(
      mockRootDir,
      'worktree-data',
      WORKSPACE_ID,
      'partial-recovered',
      'archive-recovery-evidence',
      CONTAINER_ID,
      'restored-recovery-evidence',
    );
    const evidence = readdirSync(evidenceRoot).find((name) =>
      name.startsWith('.archive-recovery-previous-'),
    );
    if (!evidence) throw new Error('Expected previous copy evidence');
    expect(
      readFileSync(
        join(evidenceRoot, evidence, orphanId, 'only-surviving-copy.txt'),
        'utf8',
      ),
    ).toBe('keep me');
  });

  it('recaptures changes after a failed move while preserving the previous recovery payload', async () => {
    mkdirSync(join(worktreePath(), '.archive-recovery-previous-user-notes'));
    writeFileSync(
      join(
        worktreePath(),
        '.archive-recovery-previous-user-notes',
        'notes.txt',
      ),
      'user-owned prefix match',
    );
    writeFileSync(join(worktreePath(), 'earlier.txt'), 'first attempt');
    const first = await recoveryManifest();
    rmSync(join(worktreePath(), 'earlier.txt'));
    writeFileSync(join(worktreePath(), 'later.txt'), 'second attempt');
    const second = await recoveryManifest();
    expect(second.recovery.payloadId).not.toBe(first.recovery.payloadId);
    await finishArchivedContainerRecovery(second);
    const destination = join(mockRootDir, 'changed-recovered');
    await restoreArchivedRecoveryFiles(second, destination);
    expect(readFileSync(join(destination, 'later.txt'), 'utf8')).toBe(
      'second attempt',
    );
    expect(
      readFileSync(
        join(destination, '.archive-recovery-previous-user-notes', 'notes.txt'),
        'utf8',
      ),
    ).toBe('user-owned prefix match');
    const { readdirSync } = jest.requireActual<typeof NodeFs>('node:fs');
    expect(
      readdirSync(destination).some((name) =>
        /^\.archive-recovery-previous-[a-f0-9-]{36}$/.test(name),
      ),
    ).toBe(false);
    const evidenceRoot = join(
      mockRootDir,
      'worktree-data',
      WORKSPACE_ID,
      'changed-recovered',
      'archive-recovery-evidence',
      CONTAINER_ID,
      'restored-recovery-evidence',
    );
    const evidence = readdirSync(evidenceRoot).find((name) =>
      name.startsWith('.archive-recovery-previous-'),
    );
    if (!evidence) throw new Error('Expected previous copy evidence');
    expect(
      readFileSync(
        join(evidenceRoot, evidence, first.recovery.payloadId, 'earlier.txt'),
        'utf8',
      ),
    ).toBe('first attempt');
  });

  it('keeps repeated recovery recaptures linear without duplicate root payloads', async () => {
    const recoveryFiles = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'recovery-files',
    );
    const markers = ['first', 'second', 'third', 'fourth'];
    let latestPayload = '';
    for (const marker of markers) {
      for (const previous of markers) {
        rmSync(join(worktreePath(), `${previous}.txt`), { force: true });
      }
      writeFileSync(join(worktreePath(), `${marker}.txt`), marker);
      const captured = await recoveryManifest();
      latestPayload = join(recoveryFiles, captured.recovery.payloadId);
      expect(
        jest
          .requireActual<typeof NodeFs>('node:fs')
          .readdirSync(recoveryFiles, { withFileTypes: true })
          .filter((entry) => entry.isDirectory()).length,
      ).toBe(1);
    }

    const occurrences = new Map(markers.map((marker) => [marker, 0]));
    const visit = (directory: string): void => {
      for (const entry of jest
        .requireActual<typeof NodeFs>('node:fs')
        .readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && entry.name.endsWith('.txt')) {
          const marker = readFileSync(path, 'utf8');
          if (occurrences.has(marker)) {
            occurrences.set(marker, (occurrences.get(marker) ?? 0) + 1);
          }
        }
      }
    };
    visit(latestPayload);
    expect(Object.fromEntries(occurrences)).toEqual({
      first: 1,
      second: 1,
      third: 1,
      fourth: 1,
    });
  });

  it('never deletes a replacement quarantine directory while resuming verified physical cleanup', async () => {
    const manifest = await recoveryManifest();
    const quarantine = join(
      mockRootDir,
      'worktrees',
      WORKSPACE_ID,
      `.${CONTAINER_ID}.archive-quarantine`,
    );
    renameSync(worktreePath(), quarantine);
    const journalPath = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'recovery.staged.json',
    );
    const journal: unknown = JSON.parse(readFileSync(journalPath, 'utf8'));
    if (!isRecord(journal)) throw new Error('Expected recovery journal');
    journal.phase = 'verified';
    writeFileSync(journalPath, JSON.stringify(journal));
    renameSync(quarantine, `${quarantine}-original`);
    mkdirSync(quarantine);
    writeFileSync(join(quarantine, 'replacement.txt'), 'leave this alone');
    await expect(finishArchivedContainerRecovery(manifest)).rejects.toThrow(
      'changed identity',
    );
    expect(readFileSync(join(quarantine, 'replacement.txt'), 'utf8')).toBe(
      'leave this alone',
    );
  });

  it('refuses to adopt a replacement quarantine directory during recovery capture', async () => {
    const original = persistedWorktree();
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: original,
    });
    const teardown = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });
    renameSync(teardown.quarantinePath, `${teardown.quarantinePath}-owned`);
    mkdirSync(teardown.quarantinePath);
    writeFileSync(
      join(teardown.quarantinePath, 'replacement.txt'),
      'preserve replacement',
    );

    await expect(
      prepareArchivedContainerRecovery({
        projectId: WORKSPACE_ID,
        worktreeId: CONTAINER_ID,
        worktree: original,
      }),
    ).rejects.toThrow('quarantine changed identity');
    expect(
      readFileSync(join(teardown.quarantinePath, 'replacement.txt'), 'utf8'),
    ).toBe('preserve replacement');
  });

  it('keeps cleanup pending instead of deleting a replacement single-repo quarantine occupant', async () => {
    const manifest = await recoveryManifest();
    const quarantine = join(
      mockRootDir,
      'worktrees',
      WORKSPACE_ID,
      `.${CONTAINER_ID}.archive-quarantine`,
    );
    renameSync(worktreePath(), quarantine);
    runGit(mockReferenceRepoPath, ['worktree', 'repair', quarantine]);
    const journalPath = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'recovery.staged.json',
    );
    const journal: unknown = JSON.parse(readFileSync(journalPath, 'utf8'));
    if (!isRecord(journal)) throw new Error('Expected recovery journal');
    journal.phase = 'removed';
    writeFileSync(journalPath, JSON.stringify(journal));
    rmSync(quarantine, { recursive: true });
    mkdirSync(quarantine);
    writeFileSync(join(quarantine, 'replacement.txt'), 'keep replacement');

    await finishArchivedContainerRecovery(manifest);

    expect(manifest.recovery.gitCleanupPending).toBe(true);
    expect(readFileSync(join(quarantine, 'replacement.txt'), 'utf8')).toBe(
      'keep replacement',
    );
  });

  it('keeps cleanup pending instead of removing an out-of-root registered worktree from a tampered journal', async () => {
    const unrelated = join(mockRootDir, 'unrelated-worktree');
    runGit(mockReferenceRepoPath, [
      'worktree',
      'add',
      '-b',
      'feature/unrelated',
      unrelated,
      'HEAD',
    ]);
    writeFileSync(join(unrelated, 'unrelated.txt'), 'keep unrelated work');
    const manifest = await recoveryManifest();
    const journalPath = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'recovery.staged.json',
    );
    const journal: unknown = JSON.parse(readFileSync(journalPath, 'utf8'));
    if (
      !isRecord(journal) ||
      !Array.isArray(journal.repositories) ||
      !isRecord(journal.repositories[0])
    ) {
      throw new Error('Expected recovery repository journal');
    }
    journal.repositories[0].worktreePaths = [unrelated];
    writeFileSync(journalPath, JSON.stringify(journal));

    await finishArchivedContainerRecovery(manifest);

    expect(manifest.recovery.gitCleanupPending).toBe(true);
    expect(readFileSync(join(unrelated, 'unrelated.txt'), 'utf8')).toBe(
      'keep unrelated work',
    );
    expect(
      runGit(mockReferenceRepoPath, ['worktree', 'list', '--porcelain']),
    ).toContain(unrelated);
  });

  it('restores only the exact journaled workspace-root payload marker', async () => {
    const decoy = '.archive-workspace-files-user-notes';
    const retainedRoot = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'workspace-root',
    );
    mkdirSync(retainedRoot, { recursive: true });
    writeFileSync(join(retainedRoot, 'workspace.txt'), 'restore to root');
    mkdirSync(join(retainedRoot, decoy));
    writeFileSync(join(retainedRoot, decoy, 'notes.txt'), 'keep nested');
    rmSync(worktreePath(), { recursive: true });
    const manifest = await recoveryManifest();
    await finishArchivedContainerRecovery(manifest);
    const destination = join(mockRootDir, 'marker-recovered');
    await restoreArchivedRecoveryFiles(manifest, destination);

    await restoreArchivedRecoveryWorkspaceRootFiles(manifest, destination);

    expect(readFileSync(join(destination, 'workspace.txt'), 'utf8')).toBe(
      'restore to root',
    );
    expect(readFileSync(join(destination, decoy, 'notes.txt'), 'utf8')).toBe(
      'keep nested',
    );
  });

  it('retains an older workspace-root payload as evidence when the complete source is captured', async () => {
    writeFileSync(join(worktreePath(), 'workspace.txt'), 'newer source');
    mkdirSync(join(worktreePath(), 'repos', 'repo-a'), { recursive: true });
    writeFileSync(
      join(worktreePath(), 'repos', 'repo-a', 'source.txt'),
      'newer repository',
    );
    const retainedRoot = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'workspace-root',
    );
    mkdirSync(join(retainedRoot, 'repos', 'repo-a'), { recursive: true });
    writeFileSync(join(retainedRoot, 'workspace.txt'), 'older retained root');
    writeFileSync(
      join(retainedRoot, 'repos', 'repo-a', 'source.txt'),
      'older repository',
    );

    const manifest = await recoveryManifest();
    await finishArchivedContainerRecovery(manifest);
    const destination = join(mockRootDir, 'complete-recovered');
    await restoreArchivedRecoveryFiles(manifest, destination);
    await expect(
      restoreArchivedRecoveryWorkspaceRootFiles(manifest, destination),
    ).resolves.toEqual([]);

    expect(readFileSync(join(destination, 'workspace.txt'), 'utf8')).toBe(
      'newer source',
    );
    expect(
      readFileSync(join(destination, 'repos', 'repo-a', 'source.txt'), 'utf8'),
    ).toBe('newer repository');
    expect(existsSync(join(destination, 'repos', 'repo-a-archived'))).toBe(
      false,
    );
    const evidenceRoot = join(
      mockRootDir,
      'worktree-data',
      WORKSPACE_ID,
      'complete-recovered',
      'archive-recovery-evidence',
      CONTAINER_ID,
      'restored-recovery-evidence',
    );
    const { readdirSync } = jest.requireActual<typeof NodeFs>('node:fs');
    const evidence = readdirSync(evidenceRoot).find((name) =>
      name.startsWith('.archive-workspace-files-'),
    );
    if (!evidence) throw new Error('Expected retained workspace evidence');
    expect(
      readFileSync(join(evidenceRoot, evidence, 'workspace.txt'), 'utf8'),
    ).toBe('older retained root');
  });

  it('classifies Windows quarantine roots and descendants without POSIX separators', () => {
    const restorePlatform = setPlatform('win32');
    try {
      const quarantine = 'C:\\worktrees\\.archive-quarantine';
      expect(isArchivedRecoveryPathWithinRoot(quarantine, quarantine)).toBe(
        true,
      );
      expect(
        isArchivedRecoveryPathWithinRoot(
          quarantine,
          'C:\\worktrees\\.archive-quarantine\\repos\\repo-a',
        ),
      ).toBe(true);
      expect(
        isArchivedRecoveryPathWithinRoot(
          quarantine,
          'C:\\worktrees\\.archive-quarantine-replacement',
        ),
      ).toBe(false);
    } finally {
      restorePlatform();
    }
  });

  it('salvages an incomplete quarantined Git capture with portable retained snapshots before cleanup', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const teardown = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });
    const stagedPath = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'git-state.staged.json',
    );
    const staged: unknown = JSON.parse(readFileSync(stagedPath, 'utf8'));
    if (!isRecord(staged)) throw new Error('Expected staged descriptor');
    staged.status = 'capturing';
    delete staged.gitChanges;
    delete staged.pullRequestMetadata;
    writeFileSync(stagedPath, JSON.stringify(staged));
    const manifest = await recoveryManifest();
    expect(manifest.recovery.source).toBe('partial');
    await finishArchivedContainerRecovery(manifest);
    expect(existsSync(teardown.quarantinePath)).toBe(false);
    const destination = join(mockRootDir, 'quarantine-recovered');
    await restoreArchivedRecoveryFiles(manifest, destination);
    const { readdirSync } = jest.requireActual<typeof NodeFs>('node:fs');
    expect(
      readdirSync(destination).some((name) =>
        /^\.archive-git-snapshots-[a-f0-9-]{36}$/.test(name),
      ),
    ).toBe(false);
    const evidenceRoot = join(
      mockRootDir,
      'worktree-data',
      WORKSPACE_ID,
      'quarantine-recovered',
      'archive-recovery-evidence',
      CONTAINER_ID,
      'restored-recovery-evidence',
    );
    const evidence = readdirSync(evidenceRoot).find((name) =>
      name.startsWith('.archive-git-snapshots-'),
    );
    if (!evidence) throw new Error('Expected retained Git bundles');
    const bundle = readdirSync(join(evidenceRoot, evidence)).find((name) =>
      name.endsWith('.bundle'),
    );
    if (!bundle) throw new Error('Expected portable snapshot bundle');
    const snapshots: unknown = JSON.parse(
      readFileSync(join(evidenceRoot, evidence, 'snapshots.json'), 'utf8'),
    );
    expect(snapshots).toMatchObject({ version: 1 });
    expect(
      runGit(mockReferenceRepoPath, [
        'bundle',
        'list-heads',
        join(evidenceRoot, evidence, bundle),
      ]),
    ).toContain(capture.gitState.repositories[0].worktreeSnapshotCommit);
  });

  it('uses a legacy ready teardown for files-only recovery when its reference repository is unavailable', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });
    const stagedPath = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'git-state.staged.json',
    );
    const staged: unknown = JSON.parse(readFileSync(stagedPath, 'utf8'));
    if (!isRecord(staged)) throw new Error('Expected staged descriptor');
    delete staged.pullRequestMetadata;
    writeFileSync(stagedPath, JSON.stringify(staged));
    renameSync(mockReferenceRepoPath, `${mockReferenceRepoPath}-away`);

    const manifest = await recoveryManifest();

    expect(manifest.recovery.source).toBe('partial');
    const payload = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'recovery-files',
      manifest.recovery.payloadId,
    );
    expect(existsSync(join(payload, 'both.txt'))).toBe(true);
  });

  it('publishes files-only recovery when a staged snapshot repository is unavailable', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });
    renameSync(mockReferenceRepoPath, `${mockReferenceRepoPath}-unavailable`);

    const recovered = await recoveryManifest();

    expect(recovered.recovery.source).toBe('partial');
    const destination = join(mockRootDir, 'unavailable-repo-recovered');
    await restoreArchivedRecoveryFiles(recovered, destination);
    expect(readFileSync(join(destination, 'both.txt'), 'utf8')).toBe('base\n');
  });

  it('keeps every included repository in recovery cleanup after a partial staged capture', async () => {
    const fixture = setupPartialMultiRepoFixture({ includeRepoB: true });
    if (!fixture.secondIncludedRepoPath)
      throw new Error('Expected second included repository');
    const original = {
      ...persistedWorktree(),
      includedRepoIds: ['repo-a', 'repo-b'],
    };
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      worktreePath: worktreePath(),
      persistedWorktree: original,
    });
    await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      gitState: capture.gitState,
    });
    const stagedPath = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'git-state.staged.json',
    );
    const staged: unknown = JSON.parse(readFileSync(stagedPath, 'utf8'));
    if (!isRecord(staged) || !Array.isArray(staged.repositories))
      throw new Error('Expected staged descriptor');
    staged.status = 'capturing';
    staged.repositories = staged.repositories.slice(0, 1);
    delete staged.gitChanges;
    delete staged.pullRequestMetadata;
    writeFileSync(stagedPath, JSON.stringify(staged));
    const recovery = await prepareArchivedContainerRecovery({
      projectId: WORKSPACE_ID,
      worktreeId: CONTAINER_ID,
      worktree: original,
    });
    const manifest: ArchivedContainerRecoveryManifest = {
      version: 3,
      kind: 'worktree',
      id: CONTAINER_ID,
      projectId: WORKSPACE_ID,
      name: 'Recovery',
      createdAt: original.createdAt,
      archivedAt: '2026-07-22T00:00:00.000Z',
      retentionDays: 7,
      expiresAt: '2026-07-29T00:00:00.000Z',
      chatCount: 0,
      archivedChatCount: 0,
      executionCount: 0,
      workspaceType: 'multi-repo',
      originalWorktree: original,
      recovery,
    };

    await finishArchivedContainerRecovery(manifest);

    const registrations = runGit(fixture.referenceRepoPath, [
      'worktree',
      'list',
      '--porcelain',
    ]);
    expect(registrations).not.toContain(fixture.includedRepoPath);
    expect(registrations).not.toContain(fixture.secondIncludedRepoPath);
    expect(manifest.recovery.gitCleanupPending).toBe(false);
  });

  it.each(['missing', 'broken'])(
    'repairs a %s linked Git pointer without losing the private index before capture',
    async (damage) => {
      const index = runGit(worktreePath(), ['write-tree']);
      if (damage === 'missing') rmSync(join(worktreePath(), '.git'));
      else
        writeFileSync(
          join(worktreePath(), '.git'),
          'gitdir: missing-metadata\n',
        );
      const capture = await captureArchivedContainerGitState({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'single-repo',
        worktreePath: worktreePath(),
        persistedWorktree: persistedWorktree(),
      });
      expect(capture.gitState.repositories).toHaveLength(1);
      expect(runGit(worktreePath(), ['write-tree'])).toBe(index);
      expect(capture.gitState.repositories[0].headCommit).toBe(
        runGit(worktreePath(), ['rev-parse', 'HEAD']),
      );
    },
  );

  it('falls back to file recovery when a linked worktree has lost its private Git directory', async () => {
    writeFileSync(join(worktreePath(), 'uncommitted-work.txt'), 'keep me\n');
    const privateGitDir = runGit(worktreePath(), [
      'rev-parse',
      '--absolute-git-dir',
    ]);
    rmSync(privateGitDir, { recursive: true });

    const captureError = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    }).catch((error: unknown) => error);
    expect(isArchivedGitCaptureRecoveryRequiredError(captureError)).toBe(true);

    const recovery = await prepareArchivedContainerRecovery({
      projectId: WORKSPACE_ID,
      worktreeId: CONTAINER_ID,
      worktree: persistedWorktree(),
    });
    expect(
      readFileSync(
        join(
          mockRootDir,
          'archives',
          WORKSPACE_ID,
          CONTAINER_ID,
          'recovery-files',
          recovery.payloadId,
          'uncommitted-work.txt',
        ),
        'utf8',
      ),
    ).toBe('keep me\n');
  });

  it('does not authorize file recovery for a broken Git pointer outside the source repository', async () => {
    const privateGitDir = runGit(worktreePath(), [
      'rev-parse',
      '--absolute-git-dir',
    ]);
    rmSync(privateGitDir, { recursive: true });
    writeFileSync(
      join(worktreePath(), '.git'),
      `gitdir: ${join(mockRootDir, 'unrelated-missing-gitdir')}\n`,
    );
    const captureError = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    }).catch((error: unknown) => error);
    expect(captureError).toBeInstanceOf(Error);
    expect(isArchivedGitCaptureRecoveryRequiredError(captureError)).toBe(false);
    expect(existsSync(worktreePath())).toBe(true);
  });

  it('does not authorize file recovery without a Git pointer or registration', async () => {
    const privateGitDir = runGit(worktreePath(), [
      'rev-parse',
      '--absolute-git-dir',
    ]);
    rmSync(privateGitDir, { recursive: true });
    rmSync(join(worktreePath(), '.git'));

    const captureError = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    }).catch((error: unknown) => error);
    expect(captureError).toBeInstanceOf(Error);
    expect(isArchivedGitCaptureRecoveryRequiredError(captureError)).toBe(false);
    expect(existsSync(worktreePath())).toBe(true);
  });

  it('does not authorize file recovery through a source-owned symlink escaping the repository', async () => {
    const privateGitDir = runGit(worktreePath(), [
      'rev-parse',
      '--absolute-git-dir',
    ]);
    rmSync(privateGitDir, { recursive: true });
    const outside = join(mockRootDir, 'foreign-gitdirs');
    mkdirSync(outside);
    const linked = join(privateGitDir, '..', 'escape');
    symlinkSync(
      outside,
      linked,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    writeFileSync(
      join(worktreePath(), '.git'),
      `gitdir: ${join(linked, 'missing-gitdir')}\n`,
    );

    const captureError = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    }).catch((error: unknown) => error);
    expect(captureError).toBeInstanceOf(Error);
    expect(isArchivedGitCaptureRecoveryRequiredError(captureError)).toBe(false);
    expect(existsSync(worktreePath())).toBe(true);
  });

  it('does not authorize file recovery when another included repository has a foreign Git pointer', async () => {
    const fixture = setupPartialMultiRepoFixture({ includeRepoB: true });
    if (!fixture.secondIncludedRepoPath)
      throw new Error('Expected second included repository');
    const firstPrivateDir = runGit(fixture.includedRepoPath, [
      'rev-parse',
      '--absolute-git-dir',
    ]);
    const secondPrivateDir = runGit(fixture.secondIncludedRepoPath, [
      'rev-parse',
      '--absolute-git-dir',
    ]);
    rmSync(firstPrivateDir, { recursive: true });
    rmSync(secondPrivateDir, { recursive: true });
    writeFileSync(
      join(fixture.secondIncludedRepoPath, '.git'),
      `gitdir: ${join(mockRootDir, 'foreign-missing-gitdir')}\n`,
    );

    const captureError = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      worktreePath: worktreePath(),
      persistedWorktree: {
        ...persistedWorktree(),
        includedRepoIds: ['repo-a', 'repo-b'],
      },
    }).catch((error: unknown) => error);
    expect(captureError).toBeInstanceOf(Error);
    expect(isArchivedGitCaptureRecoveryRequiredError(captureError)).toBe(false);
    expect(existsSync(fixture.includedRepoPath)).toBe(true);
    expect(existsSync(fixture.secondIncludedRepoPath)).toBe(true);
  });

  it('preserves restored files without recapturing when no Git pointer remains', async () => {
    writeFileSync(join(worktreePath(), 'retained-work.txt'), 'retained\n');
    const privateGitDir = runGit(worktreePath(), [
      'rev-parse',
      '--absolute-git-dir',
    ]);
    rmSync(privateGitDir, { recursive: true });
    const first = await recoveryManifest();
    const restoredId = 'restored-recovery';
    const restoredPath = join(
      mockRootDir,
      'worktrees',
      WORKSPACE_ID,
      restoredId,
    );
    await restoreArchivedRecoveryFiles(first, restoredPath);
    const restoredWorktree = {
      ...persistedWorktree(),
      id: restoredId,
      createdAt: '2026-09-23T00:00:00.000Z',
    };

    const recaptureError = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: restoredId,
      workspaceType: 'single-repo',
      worktreePath: restoredPath,
      persistedWorktree: restoredWorktree,
    }).catch((error: unknown) => error);
    expect(recaptureError).toBeInstanceOf(Error);
    expect(isArchivedGitCaptureRecoveryRequiredError(recaptureError)).toBe(
      false,
    );
    expect(readFileSync(join(restoredPath, 'retained-work.txt'), 'utf8')).toBe(
      'retained\n',
    );
  });

  it('never repairs a readable pointer belonging to another linked worktree', async () => {
    const other = join(mockRootDir, 'another-worktree');
    runGit(mockReferenceRepoPath, [
      'worktree',
      'add',
      '-b',
      'another',
      other,
      'main',
    ]);
    const index = runGit(other, ['write-tree']);
    copyFileSync(join(other, '.git'), join(worktreePath(), '.git'));
    await expect(
      captureArchivedContainerGitState({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'single-repo',
        worktreePath: worktreePath(),
        persistedWorktree: persistedWorktree(),
      }),
    ).rejects.toThrow('another worktree');
    expect(runGit(other, ['write-tree'])).toBe(index);
    expect(runGit(other, ['symbolic-ref', '--short', 'HEAD'])).toBe('another');
  });

  it.each(['quarantine-pending', 'verified'])(
    'recovers legacy ready metadata with a %s journal without network lookups',
    async (phase) => {
      const capture = await captureArchivedContainerGitState({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'single-repo',
        worktreePath: worktreePath(),
        persistedWorktree: persistedWorktree(),
      });
      const teardown = await prepareArchivedContainerTeardown({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'single-repo',
        gitState: capture.gitState,
      });
      const stagedPath = join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'git-state.staged.json',
      );
      const staged: unknown = JSON.parse(readFileSync(stagedPath, 'utf8'));
      if (!isRecord(staged) || !isRecord(staged.teardown))
        throw new Error('Expected teardown descriptor');
      delete staged.pullRequestMetadata;
      staged.teardown.phase = phase;
      writeFileSync(stagedPath, JSON.stringify(staged));
      jest.mocked(fetchArchivedPullRequestMetadata).mockClear();
      await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);
      expect(existsSync(teardown.quarantinePath)).toBe(false);
      expect(archiveSingleRepoWorktree).toHaveBeenCalled();
      expect(fetchArchivedPullRequestMetadata).not.toHaveBeenCalled();
      const recovered = await readArchivedGitStagedDescriptor(
        WORKSPACE_ID,
        CONTAINER_ID,
      );
      expect(recovered).toMatchObject({
        status: 'ready',
        gitChanges: capture.gitChanges,
        pullRequestMetadata: { repositories: [{ status: 'unavailable' }] },
      });
    },
  );

  it('does not overwrite an occupied quarantine while retrying a locked rename', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const originalRename = actualFsPromises.rename;
    const quarantine = join(
      mockRootDir,
      'worktrees',
      WORKSPACE_ID,
      `.${CONTAINER_ID}.archive-quarantine`,
    );
    let attempts = 0;
    const spy = jest
      .spyOn(mockedFsPromises, 'rename')
      .mockImplementation(async (from, to) => {
        if (String(from) === worktreePath()) {
          attempts += 1;
          if (attempts === 1) {
            mkdirSync(quarantine);
            writeFileSync(join(quarantine, 'survivor.txt'), 'keep');
            throw Object.assign(new Error('busy'), { code: 'EBUSY' });
          }
        }
        return originalRename(from, to);
      });
    const restorePlatform = setPlatform('win32');
    try {
      await expect(
        prepareArchivedContainerTeardown({
          workspaceId: WORKSPACE_ID,
          containerId: CONTAINER_ID,
          workspaceType: 'single-repo',
          gitState: capture.gitState,
        }),
      ).rejects.toThrow(/quarantine/i);
      expect(attempts).toBe(1);
      expect(readFileSync(join(quarantine, 'survivor.txt'), 'utf8')).toBe(
        'keep',
      );
      expect(existsSync(worktreePath())).toBe(true);
    } finally {
      restorePlatform();
      spy.mockRestore();
    }
  });

  it.each(['EBUSY', 'EPERM'])(
    'retries a transient %s quarantine rename within the same archive operation',
    async (code) => {
      const capture = await captureArchivedContainerGitState({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'single-repo',
        worktreePath: worktreePath(),
        persistedWorktree: persistedWorktree(),
      });
      const originalRename = actualFsPromises.rename;
      let attempts = 0;
      const spy = jest
        .spyOn(mockedFsPromises, 'rename')
        .mockImplementation(async (from, to) => {
          if (String(from) === worktreePath() && ++attempts === 1)
            throw Object.assign(new Error('resource busy'), { code });
          return originalRename(from, to);
        });
      const restorePlatform = setPlatform('win32');
      try {
        const teardown = await prepareArchivedContainerTeardown({
          workspaceId: WORKSPACE_ID,
          containerId: CONTAINER_ID,
          workspaceType: 'single-repo',
          gitState: capture.gitState,
        });
        expect(attempts).toBe(2);
        expect(existsSync(teardown.quarantinePath)).toBe(true);
        expect(existsSync(worktreePath())).toBe(false);
      } finally {
        restorePlatform();
        spy.mockRestore();
      }
    },
  );

  it('retries a transient POSIX mv resource-busy failure', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const actual =
      jest.requireActual<typeof NodeChildProcess>('node:child_process');
    const actualAsync = promisify(actual.execFile);
    const asyncMock: unknown = Reflect.get(execFile, promisify.custom);
    if (!jest.isMockFunction(asyncMock)) {
      throw new Error('Expected promisified execFile to be mocked');
    }
    let attempts = 0;
    asyncMock.mockImplementation(
      async (file: string, args: readonly string[], options: object) => {
        if (file === '/bin/mv' && ++attempts === 1) {
          throw Object.assign(new Error('mv failed'), {
            code: 1,
            stderr: 'mv: rename failed: Resource busy',
          });
        }
        return actualAsync(file, args, options);
      },
    );
    const restorePlatform = setPlatform('darwin');
    try {
      const teardown = await prepareArchivedContainerTeardown({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'single-repo',
        gitState: capture.gitState,
      });
      expect(attempts).toBe(2);
      expect(existsSync(teardown.quarantinePath)).toBe(true);
      expect(existsSync(worktreePath())).toBe(false);
    } finally {
      restorePlatform();
      asyncMock.mockImplementation(actualAsync);
    }
  });

  it('captures deterministic mixed PR, confirmed-none, and unavailable results', async () => {
    jest
      .mocked(fetchArchivedPullRequestMetadata)
      .mockImplementation((repoPath) => {
        if (repoPath.endsWith('repo-a')) {
          return Promise.resolve({
            number: 12,
            url: 'https://github.com/acme/repo-a/pull/12',
            title: 'Archive repo A',
            state: 'open',
            baseRefName: 'main',
            updatedAt: '2026-08-01T00:00:00.000Z',
          });
        }
        if (repoPath.endsWith('repo-b')) return Promise.resolve(null);
        return Promise.reject(new Error('API unavailable'));
      });

    const result = await captureArchivedPullRequestMetadata([
      pullRequestRepository('repo-d'),
      pullRequestRepository('repo-c', { branchName: 'feature/c' }),
      pullRequestRepository('repo-a', { branchName: 'feature/a' }),
      pullRequestRepository('repo-b', { branchName: 'feature/b' }),
    ]);

    expect(result.capturedAt).toBe(new Date(result.capturedAt).toISOString());
    expect(result.repositories).toEqual([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        status: 'complete',
        pullRequest: {
          number: 12,
          url: 'https://github.com/acme/repo-a/pull/12',
          title: 'Archive repo A',
          state: 'open',
          baseRefName: 'main',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      },
      {
        repoId: 'repo-b',
        repoName: 'repo-b',
        status: 'complete',
        pullRequest: null,
      },
      { repoId: 'repo-c', repoName: 'repo-c', status: 'unavailable' },
      { repoId: 'repo-d', repoName: 'repo-d', status: 'unavailable' },
    ]);
    expect(fetchArchivedPullRequestMetadata).toHaveBeenCalledTimes(3);
    expect(fetchArchivedPullRequestMetadata).not.toHaveBeenCalledWith(
      expect.stringContaining('repo-d'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('limits PR capture to two concurrent repository lookups', async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<(value: null) => void> = [];
    jest.mocked(fetchArchivedPullRequestMetadata).mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          releases.push((value) => {
            active -= 1;
            resolve(value);
          });
        }),
    );

    const capture = captureArchivedPullRequestMetadata([
      pullRequestRepository('repo-c', { branchName: 'feature/c' }),
      pullRequestRepository('repo-a', { branchName: 'feature/a' }),
      pullRequestRepository('repo-b', { branchName: 'feature/b' }),
    ]);
    await Promise.resolve();
    expect(fetchArchivedPullRequestMetadata).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(2);
    releases[0]?.(null);
    while (
      jest.mocked(fetchArchivedPullRequestMetadata).mock.calls.length < 3
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(fetchArchivedPullRequestMetadata).toHaveBeenCalledTimes(3);
    releases[1]?.(null);
    releases[2]?.(null);

    await expect(capture).resolves.toMatchObject({
      repositories: [
        { repoId: 'repo-a' },
        { repoId: 'repo-b' },
        { repoId: 'repo-c' },
      ],
    });
  });

  it('bounds each PR repository lookup to five seconds', async () => {
    jest.useFakeTimers();
    jest
      .mocked(fetchArchivedPullRequestMetadata)
      .mockImplementation(() => new Promise(() => undefined));
    try {
      const capture = captureArchivedPullRequestMetadata([
        pullRequestRepository('repo-a', { branchName: 'feature/a' }),
      ]);
      await jest.advanceTimersByTimeAsync(5_000);
      await expect(capture).resolves.toMatchObject({
        repositories: [
          { repoId: 'repo-a', repoName: 'repo-a', status: 'unavailable' },
        ],
      });
      const options = jest.mocked(fetchArchivedPullRequestMetadata).mock
        .calls[0]?.[2];
      expect(options?.timeoutMs).toBe(5_000);
      expect(options?.signal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reuses a ready PR capture verbatim without another GitHub lookup', async () => {
    jest.mocked(fetchArchivedPullRequestMetadata).mockResolvedValue({
      number: 31,
      url: 'https://github.com/acme/reference/pull/31',
      title: 'Immutable archive metadata',
      state: 'merged',
      baseRefName: 'main',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    const first = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const descriptor = await readArchivedGitStagedDescriptor(
      WORKSPACE_ID,
      CONTAINER_ID,
    );
    expect(descriptor).toMatchObject({
      status: 'ready',
      pullRequestMetadata: first.pullRequestMetadata,
    });

    jest.mocked(fetchArchivedPullRequestMetadata).mockClear();
    const retry = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });

    expect(retry).toEqual(first);
    expect(fetchArchivedPullRequestMetadata).not.toHaveBeenCalled();
  });

  it('captures only the repositories included in a partial multi-repo worktree', async () => {
    const repoAPath = join(worktreePath(), 'repos', 'repo-a');
    mkdirSync(repoAPath, { recursive: true });
    runGit(repoAPath, ['init', '-b', 'main']);
    runGit(repoAPath, ['config', 'user.name', 'Archive Test']);
    runGit(repoAPath, ['config', 'user.email', 'archive@example.com']);
    runGit(repoAPath, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(repoAPath, 'README.md'), 'included repository\n');
    runGit(repoAPath, ['add', 'README.md']);
    runGit(repoAPath, ['commit', '-m', 'base']);
    const effectiveConfig = withLegacyNullSourceRepoPath({
      localConfig: {
        version: 1 as const,
        type: 'multi-repo' as const,
        repos: [],
      },
      manifest: null,
      sourceRepoPath: undefined,
      repos: [
        { id: 'repo-a', name: 'A', repoPath: repoAPath },
        { id: 'repo-b', name: 'B', repoPath: repoAPath },
      ],
      scripts: undefined,
      defaultPluginSelections: undefined,
      suppressedManifestRepos: [],
      unresolvedManifestRepoIds: [],
    });
    jest
      .mocked(readEffectiveWorkspaceConfig)
      .mockResolvedValue(effectiveConfig);

    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      worktreePath: worktreePath(),
      persistedWorktree: {
        ...persistedWorktree(),
        includedRepoIds: ['repo-a'],
      },
    });

    expect(capture.gitState.repositories).toEqual([
      expect.objectContaining({ repoId: 'repo-a' }),
    ]);
    await expect(
      assertArchivedGitStateMatchesWorkspace({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'multi-repo',
        gitState: capture.gitState,
      }),
    ).resolves.toBeUndefined();
  });

  it('tears down a partial multi-repo capture without repairing omitted repositories', async () => {
    setupPartialMultiRepoFixture();
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      worktreePath: worktreePath(),
      persistedWorktree: {
        ...persistedWorktree(),
        includedRepoIds: ['repo-a'],
      },
    });

    const teardown = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      gitState: capture.gitState,
    });

    expect(teardown.targets).toHaveLength(1);
    expect(teardown.targets[0]).toEqual(
      expect.objectContaining({ repoId: 'repo-a' }),
    );
    expect(existsSync(teardown.quarantinePath)).toBe(true);
  });

  it('quarantines a captured checkout after a transient sharing violation', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const originalRename = actualFsPromises.rename;
    let rejected = false;
    const rename = jest
      .mocked(mockedFsPromises.rename)
      .mockImplementation(async (source, target) => {
        if (String(source) === worktreePath() && !rejected) {
          rejected = true;
          throw Object.assign(new Error('Checkout is briefly open'), {
            code: 'EBUSY',
          });
        }
        return originalRename(source, target);
      });
    const restorePlatform = setPlatform('win32');
    try {
      const teardown = await prepareArchivedContainerTeardown({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'single-repo',
        gitState: capture.gitState,
        deleteBranches: false,
      });
      expect(rejected).toBe(true);
      expect(existsSync(worktreePath())).toBe(false);
      expect(existsSync(teardown.quarantinePath)).toBe(true);
      expect(runGit(teardown.quarantinePath, ['rev-parse', 'HEAD'])).toBe(
        capture.gitState.repositories[0].headCommit,
      );
      expect(
        (await readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID))
          ?.teardown?.phase,
      ).toBe('verified');
    } finally {
      restorePlatform();
      rename.mockImplementation(originalRename);
    }
  });

  it('preserves a persistently locked checkout and allows a later quarantine retry', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const originalRename = actualFsPromises.rename;
    const locked = Object.assign(new Error('Checkout remains open'), {
      code: 'EBUSY',
    });
    const rename = jest
      .mocked(mockedFsPromises.rename)
      .mockImplementation(async (source, target) => {
        if (String(source) === worktreePath()) throw locked;
        return originalRename(source, target);
      });
    const args = {
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo' as const,
      gitState: capture.gitState,
      deleteBranches: false,
    };
    const restorePlatform = setPlatform('win32');
    try {
      await expect(prepareArchivedContainerTeardown(args)).rejects.toBe(locked);
      expect(existsSync(worktreePath())).toBe(true);
      expect(runGit(worktreePath(), ['rev-parse', 'HEAD'])).toBe(
        capture.gitState.repositories[0].headCommit,
      );
      expect(
        (await readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID))
          ?.teardown?.phase,
      ).toBe('quarantine-pending');
    } finally {
      restorePlatform();
      rename.mockImplementation(originalRename);
    }
    const teardown = await prepareArchivedContainerTeardown(args);
    expect(existsSync(teardown.quarantinePath)).toBe(true);
    expect(
      (await readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID))
        ?.teardown?.phase,
    ).toBe('verified');
  });

  it('keeps an interrupted teardown on the recovery path when the canonical worktree is absent', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });
    const descriptor = await readArchivedGitStagedDescriptor(
      WORKSPACE_ID,
      CONTAINER_ID,
    );
    if (!descriptor?.teardown) throw new Error('Expected teardown journal');
    writeFileSync(
      join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'git-state.staged.json',
      ),
      JSON.stringify({
        version: 1,
        status: 'capturing',
        repositories: descriptor.repositories,
        teardown: descriptor.teardown,
      }),
    );

    let error: unknown;
    try {
      await captureArchivedContainerGitState({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'single-repo',
        worktreePath: worktreePath(),
        persistedWorktree: persistedWorktree(),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'An incomplete archived Git capture requires recovery.',
    );
    expect(error).toBeInstanceOf(
      InterruptedArchivedGitTeardownRequiresRecoveryError,
    );
    expect(error).not.toBeInstanceOf(
      MissingWorktreeIncompleteArchivedGitCaptureError,
    );
  });

  it.each([false, true])(
    'keeps a temporary standalone clone out of linked-worktree teardown targets (bare=%s)',
    async (bare) => {
      const fixture = setupPartialMultiRepoFixture();
      const clonePath = join(worktreePath(), 'repos', 'temporary');
      runGit(worktreePath(), [
        'clone',
        ...(bare ? ['--bare'] : []),
        '--no-hardlinks',
        fixture.referenceRepoPath,
        clonePath,
      ]);
      const capture = await captureArchivedContainerGitState({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'multi-repo',
        worktreePath: worktreePath(),
        persistedWorktree: {
          ...persistedWorktree(),
          includedRepoIds: ['repo-a'],
        },
      });
      const teardown = await prepareArchivedContainerTeardown({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'multi-repo',
        gitState: capture.gitState,
      });
      expect(teardown.targets.map((target) => target.repoId)).toEqual([
        'repo-a',
      ]);
      expect(
        runGit(join(teardown.quarantinePath, 'repos', 'temporary'), [
          'rev-parse',
          'HEAD',
        ]),
      ).toBe(runGit(fixture.referenceRepoPath, ['rev-parse', 'HEAD']));
      const retainedClone = join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'workspace-root',
        'repos',
        'temporary',
      );
      expect(existsSync(join(retainedClone, bare ? 'HEAD' : '.git'))).toBe(
        true,
      );
      rmSync(join(teardown.quarantinePath, 'repos', 'temporary'), {
        recursive: true,
        force: true,
      });
      expect(runGit(retainedClone, ['rev-parse', 'HEAD'])).toBe(
        runGit(fixture.referenceRepoPath, ['rev-parse', 'HEAD']),
      );
      const receipt = (
        await readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID)
      )?.teardown?.workspaceRootPayload;
      expect(receipt?.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(receipt?.standaloneRepoIds).toEqual(['temporary']);
      const restoredRoot = join(mockRootDir, 'restored-root');
      await restoreArchivedWorkspaceRootPayload({
        source: join(
          mockRootDir,
          'archives',
          WORKSPACE_ID,
          CONTAINER_ID,
          'workspace-root',
        ),
        destination: restoredRoot,
      });
      const restoredClone = join(restoredRoot, 'repos', 'temporary');
      expect(runGit(restoredClone, ['rev-parse', 'HEAD'])).toBe(
        runGit(fixture.referenceRepoPath, ['rev-parse', 'HEAD']),
      );
      expect(runGit(restoredClone, ['rev-parse', '--is-bare-repository'])).toBe(
        String(bare),
      );
      expect(runGit(restoredClone, ['show', 'HEAD:README.md'])).toBe(
        runGit(fixture.referenceRepoPath, ['show', 'HEAD:README.md']),
      );
    },
  );

  it('routes unmanaged clone payload copy and cleanup through the archive worker', async () => {
    const fixture = setupPartialMultiRepoFixture();
    runGit(worktreePath(), [
      'clone',
      '--no-hardlinks',
      fixture.referenceRepoPath,
      join(worktreePath(), 'repos', 'temporary'),
    ]);
    const persisted = {
      ...persistedWorktree(),
      includedRepoIds: ['repo-a'],
    };
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persisted,
    });
    mockRunArchiveIoRequest.mockImplementation(
      (request: ArchiveIoOperationRequest, signal?: AbortSignal) => {
        if (request.type === 'copy-payload') {
          return Promise.reject(new Error('worker copy failed'));
        }
        return executeArchiveIoRequest(
          request,
          signal ?? new AbortController().signal,
          {
            progress: jest.fn(),
            child: { started: jest.fn(), exited: jest.fn() },
          },
        );
      },
    );

    await expect(
      prepareArchivedContainerTeardown({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'multi-repo',
        gitState: capture.gitState,
        expectedCreatedAt: persisted.createdAt,
      }),
    ).rejects.toThrow('worker copy failed');

    expect(mockRunArchiveIoRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'copy-payload',
        projectId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        expectedCreatedAt: persisted.createdAt,
      }),
    );
    expect(mockRunArchiveIoRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'remove-directory',
        projectId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        expectedCreatedAt: persisted.createdAt,
      }),
    );
  });

  it('retains an old verified quarantine clone after configuration drift without touching a recreated worktree', async () => {
    const fixture = setupPartialMultiRepoFixture();
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      worktreePath: worktreePath(),
      persistedWorktree: {
        ...persistedWorktree(),
        includedRepoIds: ['repo-a'],
      },
    });
    const teardown = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      gitState: capture.gitState,
    });
    const clone = join(teardown.quarantinePath, 'repos', 'temporary');
    runGit(teardown.quarantinePath, [
      'clone',
      '--no-hardlinks',
      fixture.referenceRepoPath,
      clone,
    ]);
    writeFileSync(join(clone, 'local.txt'), 'local commit\n');
    runGit(clone, ['add', 'local.txt']);
    runGit(clone, [
      '-c',
      'user.name=Archive Test',
      '-c',
      'user.email=archive@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'local only',
    ]);
    const localHead = runGit(clone, ['rev-parse', 'HEAD']);
    writeFileSync(join(clone, 'README.md'), 'uncommitted\n');
    writeFileSync(join(clone, '.git', 'info', 'exclude'), 'ignored.log\n');
    writeFileSync(join(clone, 'ignored.log'), 'ignored bytes\n');
    runGit(fixture.referenceRepoPath, [
      'worktree',
      'remove',
      '--force',
      join(teardown.quarantinePath, 'repos', 'repo-a'),
    ]);
    mkdirSync(worktreePath());
    writeFileSync(
      join(worktreePath(), 'new-occupant.txt'),
      'preserve new root\n',
    );
    const effective = await readEffectiveWorkspaceConfig(WORKSPACE_ID);
    jest.mocked(readEffectiveWorkspaceConfig).mockResolvedValue({
      ...effective,
      repos: [
        ...effective.repos,
        {
          id: 'temporary',
          name: 'Temporary',
          repoPath: fixture.referenceRepoPath,
        },
      ],
    });

    const retry = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      gitState: capture.gitState,
    });
    const retainedClone = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'workspace-root',
      'repos',
      'temporary',
    );
    expect(existsSync(join(retainedClone, '.git'))).toBe(true);
    expect(runGit(retainedClone, ['rev-parse', 'HEAD'])).toBe(localHead);
    expect(readFileSync(join(retainedClone, 'README.md'), 'utf8')).toBe(
      'uncommitted\n',
    );
    expect(readFileSync(join(retainedClone, 'ignored.log'), 'utf8')).toBe(
      'ignored bytes\n',
    );
    expect(retry.targets.map((target) => target.repoId)).toEqual(['repo-a']);
    expect(readFileSync(join(worktreePath(), 'new-occupant.txt'), 'utf8')).toBe(
      'preserve new root\n',
    );

    await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);
    expect(existsSync(teardown.quarantinePath)).toBe(false);
    expect(readFileSync(join(worktreePath(), 'new-occupant.txt'), 'utf8')).toBe(
      'preserve new root\n',
    );
    expect(runGit(retainedClone, ['rev-parse', 'HEAD'])).toBe(localHead);
    expect(archiveMultiRepoWorktree).toHaveBeenCalled();
  });

  it.each([
    'linked-checkout',
    'git-symlink',
    'shared-objects',
    'owned-worktree',
    'commondir',
    'nested-refs',
    'bare-owned-worktree',
    'bare-replacement',
  ])(
    'preserves a receipted clone when retry discovers new %s metadata',
    async (replacement) => {
      const fixture = setupPartialMultiRepoFixture();
      const clone = join(worktreePath(), 'repos', 'temporary');
      runGit(worktreePath(), [
        'clone',
        ...(replacement === 'bare-owned-worktree' ? ['--bare'] : []),
        '--no-hardlinks',
        fixture.referenceRepoPath,
        clone,
      ]);
      const capture = await captureArchivedContainerGitState({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'multi-repo',
        worktreePath: worktreePath(),
        persistedWorktree: {
          ...persistedWorktree(),
          includedRepoIds: ['repo-a'],
        },
      });
      const teardown = await prepareArchivedContainerTeardown({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'multi-repo',
        gitState: capture.gitState,
      });
      const quarantinedClone = join(
        teardown.quarantinePath,
        'repos',
        'temporary',
      );
      const external = join(mockRootDir, 'external-checkout');
      if (replacement === 'bare-replacement') {
        rmSync(quarantinedClone, { recursive: true, force: true });
        runGit(teardown.quarantinePath, [
          'clone',
          '--bare',
          '--no-hardlinks',
          fixture.referenceRepoPath,
          quarantinedClone,
        ]);
        runGit(quarantinedClone, [
          'worktree',
          'add',
          '-b',
          'external',
          external,
        ]);
      } else if (replacement === 'linked-checkout') {
        rmSync(quarantinedClone, { recursive: true, force: true });
        runGit(fixture.referenceRepoPath, [
          'worktree',
          'add',
          '-b',
          'replacement',
          quarantinedClone,
        ]);
      } else if (replacement === 'git-symlink') {
        const metadata = join(mockRootDir, 'external-metadata');
        renameSync(join(quarantinedClone, '.git'), metadata);
        symlinkSync(metadata, join(quarantinedClone, '.git'), 'junction');
      } else if (replacement === 'shared-objects') {
        writeFileSync(
          join(quarantinedClone, '.git', 'objects', 'info', 'alternates'),
          join(fixture.referenceRepoPath, '.git', 'objects') + '\n',
        );
      } else if (replacement === 'nested-refs') {
        const refs = join(quarantinedClone, '.git', 'refs');
        const externalRefs = join(mockRootDir, 'external-refs');
        renameSync(refs, externalRefs);
        symlinkSync(externalRefs, refs, 'junction');
      } else if (
        replacement === 'owned-worktree' ||
        replacement === 'bare-owned-worktree'
      ) {
        runGit(quarantinedClone, [
          'worktree',
          'add',
          '-b',
          'external',
          external,
        ]);
      } else {
        writeFileSync(
          join(quarantinedClone, '.git', 'commondir'),
          join(fixture.referenceRepoPath, '.git') + '\n',
        );
      }
      const currentHead = runGit(quarantinedClone, ['rev-parse', 'HEAD']);
      await expect(
        prepareArchivedContainerTeardown({
          workspaceId: WORKSPACE_ID,
          containerId: CONTAINER_ID,
          workspaceType: 'multi-repo',
          gitState: capture.gitState,
        }),
      ).rejects.toThrow('Git dependencies changed');
      const cleanupReparsePoints = jest.spyOn(
        git,
        'removeWindowsWorktreeReparsePoints',
      );
      if (replacement === 'git-symlink') {
        cleanupReparsePoints.mockImplementationOnce(() => {
          rmSync(join(quarantinedClone, '.git'), {
            recursive: true,
            force: true,
          });
          return Promise.resolve();
        });
      } else if (replacement === 'nested-refs') {
        cleanupReparsePoints.mockImplementationOnce(() => {
          rmSync(join(quarantinedClone, '.git', 'refs'), {
            recursive: true,
            force: true,
          });
          return Promise.resolve();
        });
      }
      try {
        await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);
      } finally {
        cleanupReparsePoints.mockRestore();
      }
      expect(existsSync(quarantinedClone)).toBe(true);
      expect(runGit(quarantinedClone, ['rev-parse', 'HEAD'])).toBe(currentHead);
      if (replacement === 'linked-checkout') {
        expect(
          runGit(fixture.referenceRepoPath, [
            'worktree',
            'list',
            '--porcelain',
          ]),
        ).toContain(quarantinedClone.replaceAll('\\', '/'));
      }
      if (
        replacement === 'owned-worktree' ||
        replacement === 'bare-owned-worktree' ||
        replacement === 'bare-replacement'
      ) {
        expect(runGit(external, ['rev-parse', 'HEAD'])).toBe(currentHead);
      }
    },
  );

  it.each([false, true])(
    'finishes a partially deleted clone using its verified retained payload (bare=%s)',
    async (bare) => {
      const fixture = setupPartialMultiRepoFixture();
      const clone = join(worktreePath(), 'repos', 'temporary');
      runGit(worktreePath(), [
        'clone',
        ...(bare ? ['--bare'] : []),
        '--no-hardlinks',
        fixture.referenceRepoPath,
        clone,
      ]);
      const capture = await captureArchivedContainerGitState({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'multi-repo',
        worktreePath: worktreePath(),
        persistedWorktree: {
          ...persistedWorktree(),
          includedRepoIds: ['repo-a'],
        },
      });
      const teardown = await prepareArchivedContainerTeardown({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'multi-repo',
        gitState: capture.gitState,
      });
      const retainedClone = join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'workspace-root',
        'repos',
        'temporary',
      );
      expect(existsSync(join(retainedClone, bare ? 'HEAD' : '.git'))).toBe(
        true,
      );
      rmSync(
        join(
          teardown.quarantinePath,
          'repos',
          'temporary',
          ...(bare ? [] : ['.git']),
          'objects',
        ),
        { recursive: true, force: true },
      );
      if (!bare)
        rmSync(
          join(teardown.quarantinePath, 'repos', 'temporary', 'README.md'),
        );
      await expect(
        prepareArchivedContainerTeardown({
          workspaceId: WORKSPACE_ID,
          containerId: CONTAINER_ID,
          workspaceType: 'multi-repo',
          gitState: capture.gitState,
        }),
      ).resolves.toMatchObject({ alreadyRemoved: false });
      await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);
      expect(existsSync(teardown.quarantinePath)).toBe(false);
      expect(runGit(retainedClone, ['rev-parse', 'HEAD'])).toBe(
        runGit(fixture.referenceRepoPath, ['rev-parse', 'HEAD']),
      );
      expect(archiveMultiRepoWorktree).toHaveBeenCalled();
    },
  );

  it.each(['repos/temporary/README.md', '.git'])(
    'preserves the quarantine when the verified clone payload changes at %s',
    async (changedPath) => {
      const fixture = setupPartialMultiRepoFixture();
      const clone = join(worktreePath(), 'repos', 'temporary');
      runGit(worktreePath(), [
        'clone',
        '--no-hardlinks',
        fixture.referenceRepoPath,
        clone,
      ]);
      const capture = await captureArchivedContainerGitState({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'multi-repo',
        worktreePath: worktreePath(),
        persistedWorktree: {
          ...persistedWorktree(),
          includedRepoIds: ['repo-a'],
        },
      });
      const teardown = await prepareArchivedContainerTeardown({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'multi-repo',
        gitState: capture.gitState,
      });
      const payload = join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'workspace-root',
      );
      expect(existsSync(payload)).toBe(true);
      writeFileSync(join(payload, changedPath), 'changed payload\n');
      await expect(
        prepareArchivedContainerTeardown({
          workspaceId: WORKSPACE_ID,
          containerId: CONTAINER_ID,
          workspaceType: 'multi-repo',
          gitState: capture.gitState,
        }),
      ).rejects.toThrow('payload');
      await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);
      expect(existsSync(teardown.quarantinePath)).toBe(true);
      expect(archiveMultiRepoWorktree).not.toHaveBeenCalled();
    },
  );

  it.each([
    { digest: 'invalid', standaloneRepoIds: ['temporary'] },
    { digest: 'a'.repeat(64), standaloneRepoIds: ['../external'] },
    { digest: 'a'.repeat(64), standaloneRepoIds: ['temporary', 'temporary'] },
  ])('rejects malformed repository payload receipts %j', async (receipt) => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });
    const descriptor = await readArchivedGitStagedDescriptor(
      WORKSPACE_ID,
      CONTAINER_ID,
    );
    if (!descriptor?.teardown) throw new Error('Expected teardown journal');
    writeFileSync(
      join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'git-state.staged.json',
      ),
      JSON.stringify({
        ...descriptor,
        teardown: { ...descriptor.teardown, workspaceRootPayload: receipt },
      }),
    );
    await expect(
      readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID),
    ).rejects.toThrow('Invalid archived Git staged descriptor');
  });

  it('preserves a quarantine containing both unmanaged clones and linked worktrees', async () => {
    const fixture = setupPartialMultiRepoFixture();
    runGit(worktreePath(), [
      'clone',
      '--no-hardlinks',
      fixture.referenceRepoPath,
      join(worktreePath(), 'repos', 'temporary'),
    ]);
    runGit(fixture.referenceRepoPath, [
      'worktree',
      'add',
      '-b',
      'extra-linked',
      join(worktreePath(), 'repos', 'extra-linked'),
    ]);
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      worktreePath: worktreePath(),
      persistedWorktree: {
        ...persistedWorktree(),
        includedRepoIds: ['repo-a'],
      },
    });
    await expect(
      prepareArchivedContainerTeardown({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'multi-repo',
        gitState: capture.gitState,
      }),
    ).rejects.toThrow('linked worktrees');
    const quarantine = join(
      mockRootDir,
      'worktrees',
      WORKSPACE_ID,
      `.${CONTAINER_ID}.archive-quarantine`,
    );
    expect(existsSync(join(quarantine, 'repos', 'temporary', '.git'))).toBe(
      true,
    );
    expect(existsSync(join(quarantine, 'repos', 'extra-linked', '.git'))).toBe(
      true,
    );
    expect(
      runGit(fixture.referenceRepoPath, [
        'show-ref',
        '--verify',
        'refs/heads/extra-linked',
      ]),
    ).toBeTruthy();
  });

  it('recovers a pending partial multi-repo quarantine without repairing omitted repositories', async () => {
    setupPartialMultiRepoFixture();
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      worktreePath: worktreePath(),
      persistedWorktree: {
        ...persistedWorktree(),
        includedRepoIds: ['repo-a'],
      },
    });
    const descriptor = await readArchivedGitStagedDescriptor(
      WORKSPACE_ID,
      CONTAINER_ID,
    );
    if (!descriptor) throw new Error('Expected staged descriptor');
    const quarantinePath = join(
      mockRootDir,
      'worktrees',
      WORKSPACE_ID,
      `.${CONTAINER_ID}.archive-quarantine`,
    );
    const stagedPath = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'git-state.staged.json',
    );
    writeFileSync(
      stagedPath,
      JSON.stringify({
        ...descriptor,
        teardown: {
          phase: 'quarantine-pending',
          canonicalPath: worktreePath(),
          quarantinePath,
          enteredAt: '2026-08-10T00:00:00.000Z',
        },
      }),
    );
    renameSync(worktreePath(), quarantinePath);

    await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);

    expect(existsSync(quarantinePath)).toBe(false);
    expect(archiveMultiRepoWorktree).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      worktreeId: CONTAINER_ID,
      retainAsArchivedContainer: true,
    });
    expect(capture.gitState.repositories).toEqual([
      expect.objectContaining({ repoId: 'repo-a' }),
    ]);
  });

  it('finishes verified multi-repo teardown when one captured child is already gone', async () => {
    const { referenceRepoPath } = setupPartialMultiRepoFixture({
      includeRepoB: true,
    });
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      worktreePath: worktreePath(),
      persistedWorktree: {
        ...persistedWorktree(),
        includedRepoIds: ['repo-a', 'repo-b'],
      },
    });
    const teardown = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      gitState: capture.gitState,
    });
    const removedChild = join(teardown.quarantinePath, 'repos', 'repo-a');
    const remainingChild = join(teardown.quarantinePath, 'repos', 'repo-b');
    runGit(referenceRepoPath, ['worktree', 'remove', '--force', removedChild]);

    await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);

    expect(existsSync(teardown.quarantinePath)).toBe(false);
    expect(
      runGit(referenceRepoPath, ['worktree', 'list', '--porcelain']),
    ).not.toContain(remainingChild);
    expect(archiveMultiRepoWorktree).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      worktreeId: CONTAINER_ID,
      retainAsArchivedContainer: true,
    });
  });

  it.each([
    ['', false],
    [', also when retried after a crashed cleanup left its entry locked', true],
  ])(
    "finishes verified multi-repo teardown without leaving an unmanaged linked worktree's registration (CAN-5034)%s",
    async (_case, crashedCleanup) => {
      const { referenceRepoPath } = setupPartialMultiRepoFixture();
      const unmanagedPath = join(worktreePath(), 'repos', 'extra-linked');
      runGit(referenceRepoPath, [
        'worktree',
        'add',
        '-b',
        'extra-linked',
        unmanagedPath,
        'main',
      ]);
      const capture = await captureArchivedContainerGitState({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'multi-repo',
        worktreePath: worktreePath(),
        persistedWorktree: {
          ...persistedWorktree(),
          includedRepoIds: ['repo-a'],
        },
      });
      const teardown = await prepareArchivedContainerTeardown({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'multi-repo',
        gitState: capture.gitState,
      });
      const registrationEntries = join(referenceRepoPath, '.git', 'worktrees');
      if (crashedCleanup)
        writeFileSync(
          join(registrationEntries, 'extra-linked', 'locked'),
          CRASHED_CLEANUP_LOCK,
        );
      // Teardown repairs only captured repositories, so Git still registers the
      // unmanaged checkout at its path before the quarantine move.
      expect(
        runGit(referenceRepoPath, ['worktree', 'list', '--porcelain']),
      ).toContain(unmanagedPath);

      await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);

      expect(existsSync(teardown.quarantinePath)).toBe(false);
      const registered = runGit(referenceRepoPath, [
        'worktree',
        'list',
        '--porcelain',
      ]);
      expect(registered).not.toContain(unmanagedPath);
      expect(registered).not.toContain(teardown.quarantinePath);
      expect(readdirSync(registrationEntries)).not.toContain('extra-linked');
    },
  );

  it('reuses a ready multi-repo capture after every checkout has been removed', async () => {
    const { referenceRepoPath } = setupPartialMultiRepoFixture({
      includeRepoB: true,
    });
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const teardown = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      gitState: capture.gitState,
    });
    for (const target of teardown.targets) {
      runGit(referenceRepoPath, [
        'worktree',
        'remove',
        '--force',
        target.quarantineRepoPath,
      ]);
    }
    rmSync(teardown.quarantinePath, { recursive: true, force: true });

    await expect(
      captureArchivedContainerGitState({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'multi-repo',
        worktreePath: worktreePath(),
        persistedWorktree: persistedWorktree(),
      }),
    ).resolves.toEqual(capture);
  });

  it('recaptures a pre-release ready descriptor missing PR metadata only while the worktree exists', async () => {
    await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const stagedPath = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'git-state.staged.json',
    );
    const staged: unknown = JSON.parse(readFileSync(stagedPath, 'utf8'));
    if (!isRecord(staged)) throw new Error('Expected staged descriptor object');
    delete staged.pullRequestMetadata;
    writeFileSync(stagedPath, JSON.stringify(staged), 'utf8');
    jest.mocked(fetchArchivedPullRequestMetadata).mockClear();

    const recaptured = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });

    expect(fetchArchivedPullRequestMetadata).toHaveBeenCalledTimes(1);
    expect(recaptured.pullRequestMetadata.repositories).toEqual([
      {
        repoId: '__single_repo__',
        repoName: 'reference',
        status: 'complete',
        pullRequest: null,
      },
    ]);
    const readyDescriptor = await readArchivedGitStagedDescriptor(
      WORKSPACE_ID,
      CONTAINER_ID,
    );
    expect(readyDescriptor?.status).toBe('ready');
    if (readyDescriptor?.status !== 'ready') {
      throw new Error('Expected ready staged descriptor.');
    }
    expect(readyDescriptor.pullRequestMetadata).toEqual(
      recaptured.pullRequestMetadata,
    );
  });

  it('awaits cancelled Git stream settlement and prevents cache repopulation', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    mockManifest = makeManifest(capture);
    const started = deferred<void>();
    const closed = deferred<void>();
    let generationSignal: AbortSignal | undefined;
    const stream = jest
      .spyOn(gitTreeSnapshot, 'streamArchiveTreeDiff')
      .mockImplementation(
        async (_repoPath, _start, _end, _maxRecords, signal) => {
          generationSignal = signal;
          started.resolve();
          if (!signal) throw new Error('Expected generation signal');
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                void closed.promise.then(() =>
                  reject(new Error('Archived Git diff was cancelled.')),
                );
              },
              { once: true },
            );
          });
          throw new Error('unreachable');
        },
      );
    try {
      const generation = listArchivedContainerChanges({
        projectId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
      });
      await started.promise;
      const invalidation = invalidateArchivedContainerChanges(
        WORKSPACE_ID,
        CONTAINER_ID,
      );
      let invalidationSettled = false;
      void invalidation.then(() => {
        invalidationSettled = true;
      });
      expect(generationSignal?.aborted).toBe(true);
      await Promise.resolve();
      expect(invalidationSettled).toBe(false);
      closed.resolve();
      await invalidation;
      await expect(generation).rejects.toThrow('cancelled');

      stream.mockResolvedValue({ files: [], totalCount: 0, truncated: false });
      await expect(
        listArchivedContainerChanges({
          projectId: WORKSPACE_ID,
          containerId: CONTAINER_ID,
        }),
      ).resolves.toMatchObject({ files: [], totalCount: 0 });
      expect(stream).toHaveBeenCalledTimes(2);
    } finally {
      stream.mockRestore();
    }
  });

  it('blocks replacement generations while purge invalidation is held', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    mockManifest = makeManifest(capture);
    const oldStarted = deferred<void>();
    const oldClosed = deferred<void>();
    let callCount = 0;
    const stream = jest
      .spyOn(gitTreeSnapshot, 'streamArchiveTreeDiff')
      .mockImplementation(
        async (_repoPath, _start, _end, _maxRecords, signal) => {
          callCount += 1;
          if (callCount === 1) {
            oldStarted.resolve();
            if (!signal) throw new Error('Expected generation signal');
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  void oldClosed.promise.then(() =>
                    reject(new Error('Archived Git diff was cancelled.')),
                  );
                },
                { once: true },
              );
            });
            throw new Error('unreachable');
          }
          return { files: [], totalCount: 0, truncated: false };
        },
      );
    try {
      const olderGeneration = listArchivedContainerChanges({
        projectId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
      });
      await oldStarted.promise;
      const invalidation = invalidateArchivedContainerChanges(
        WORKSPACE_ID,
        CONTAINER_ID,
        { hold: true },
      );
      const newerGeneration = listArchivedContainerChanges({
        projectId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
      });
      const newerRejection =
        expect(newerGeneration).rejects.toThrow('being purged');

      oldClosed.resolve();
      const resume = await invalidation;
      await expect(olderGeneration).rejects.toThrow('cancelled');
      await newerRejection;
      await expect(
        listArchivedContainerChanges({
          projectId: WORKSPACE_ID,
          containerId: CONTAINER_ID,
        }),
      ).rejects.toThrow('being purged');
      expect(stream).toHaveBeenCalledTimes(1);

      resume();
      await expect(
        listArchivedContainerChanges({
          projectId: WORKSPACE_ID,
          containerId: CONTAINER_ID,
        }),
      ).resolves.toMatchObject({ totalCount: 0 });
      expect(stream).toHaveBeenCalledTimes(2);
    } finally {
      stream.mockRestore();
    }
  });

  it('waits for requests admitted before validation and drops their cache writes', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    mockManifest = makeManifest(capture);
    const validationStarted = deferred<void>();
    const validationRelease = deferred<void>();
    jest.mocked(readWorkspaceConfig).mockImplementationOnce(async () => {
      validationStarted.resolve();
      await validationRelease.promise;
      return withLegacyMissingWorkspaceConfigFields(
        {
          version: 1,
          type: 'single-repo',
          repoPath: mockReferenceRepoPath,
          repos: [],
        },
        ['version', 'repos'],
      );
    });
    const stream = jest
      .spyOn(gitTreeSnapshot, 'streamArchiveTreeDiff')
      .mockResolvedValue({ files: [], totalCount: 0, truncated: false });
    try {
      const listing = listArchivedContainerChanges({
        projectId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
      });
      await validationStarted.promise;
      const invalidation = invalidateArchivedContainerChanges(
        WORKSPACE_ID,
        CONTAINER_ID,
      );
      let invalidationSettled = false;
      void invalidation.then(() => {
        invalidationSettled = true;
      });
      await Promise.resolve();
      expect(invalidationSettled).toBe(false);

      validationRelease.resolve();
      await expect(listing).resolves.toMatchObject({
        files: [],
        totalCount: 0,
      });
      await invalidation;

      await expect(
        listArchivedContainerChanges({
          projectId: WORKSPACE_ID,
          containerId: CONTAINER_ID,
        }),
      ).resolves.toMatchObject({ files: [], totalCount: 0 });
      expect(stream).toHaveBeenCalledTimes(2);
    } finally {
      validationRelease.resolve();
      stream.mockRestore();
    }
  });

  it('waits for active per-file Git reads before invalidation completes', async () => {
    createMixedChanges();
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    mockManifest = makeManifest(capture);
    await listArchivedContainerChanges({
      projectId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
    });
    const readStarted = deferred<void>();
    const readRelease = deferred<void>();
    const originalReadDiff = git.getFileDiffBetweenTreesWithPaths;
    const readDiff = jest
      .spyOn(git, 'getFileDiffBetweenTreesWithPaths')
      .mockImplementation(async (...args) => {
        readStarted.resolve();
        await readRelease.promise;
        return originalReadDiff(...args);
      });
    try {
      const reading = readArchivedContainerChangeDiff({
        projectId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        repoId: '__single_repo__',
        filePath: 'renamed.txt',
      });
      await readStarted.promise;
      const invalidation = invalidateArchivedContainerChanges(
        WORKSPACE_ID,
        CONTAINER_ID,
      );
      let invalidationSettled = false;
      void invalidation.then(() => {
        invalidationSettled = true;
      });
      await Promise.resolve();
      expect(invalidationSettled).toBe(false);

      readRelease.resolve();
      await expect(reading).resolves.toMatchObject({
        filePath: 'renamed.txt',
        source: 'combined',
      });
      await invalidation;
    } finally {
      readRelease.resolve();
      readDiff.mockRestore();
    }
  });

  it('pins immutable snapshots through branch deletion and Git GC, then releases the ref idempotently', async () => {
    createMixedChanges();
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const repository = capture.gitState.repositories[0];

    await pinArchivedContainerSnapshotRef({
      repoPath: mockReferenceRepoPath,
      refName: repository.snapshotRef,
      commit: repository.worktreeSnapshotCommit,
    });
    runGit(mockReferenceRepoPath, [
      'worktree',
      'remove',
      '--force',
      worktreePath(),
    ]);
    runGit(mockReferenceRepoPath, ['branch', '-D', 'feature/archive']);
    runGit(mockReferenceRepoPath, [
      'reflog',
      'expire',
      '--expire=now',
      '--all',
    ]);
    runGit(mockReferenceRepoPath, ['gc', '--prune=now']);

    for (const commit of [
      repository.headCommit,
      repository.indexSnapshotCommit,
      repository.worktreeSnapshotCommit,
    ]) {
      expect(runGit(mockReferenceRepoPath, ['cat-file', '-t', commit])).toBe(
        'commit',
      );
    }
    expect(
      runGit(mockReferenceRepoPath, ['rev-parse', repository.snapshotRef]),
    ).toBe(repository.worktreeSnapshotCommit);

    await deleteArchivedContainerSnapshotRef({
      repoPath: mockReferenceRepoPath,
      refName: repository.snapshotRef,
      expectedCommit: repository.worktreeSnapshotCommit,
    });
    await deleteArchivedContainerSnapshotRef({
      repoPath: mockReferenceRepoPath,
      refName: repository.snapshotRef,
      expectedCommit: repository.worktreeSnapshotCommit,
    });
    expect(
      runGit(mockReferenceRepoPath, [
        'for-each-ref',
        '--format=%(refname)',
        repository.snapshotRef,
      ]),
    ).toBe('');
  });

  it('collapses clean HEAD, index, and working snapshots to one commit', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const repository = capture.gitState.repositories[0];

    expect(repository.indexSnapshotCommit).toBe(repository.headCommit);
    expect(repository.worktreeSnapshotCommit).toBe(repository.headCommit);
    expect(capture.gitChanges).toMatchObject({
      status: 'complete',
      fileCount: 0,
      insertions: 0,
      deletions: 0,
    });
  });

  it('computes archived change totals without invoking textconv drivers', async () => {
    const markerPath = join(mockRootDir, 'textconv-called');
    const textconvPath = join(mockRootDir, 'textconv.mjs');
    writeFileSync(
      textconvPath,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(markerPath)}, 'called\\n');`,
        "process.stdout.write('normalized\\n');",
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(mockReferenceRepoPath, '.git', 'info', 'attributes'),
      'rename-binary.bin diff=archive-test\n',
    );
    runGit(mockReferenceRepoPath, [
      'config',
      'diff.archive-test.textconv',
      `${JSON.stringify(process.execPath)} ${JSON.stringify(textconvPath)}`,
    ]);
    writeFileSync(
      join(worktreePath(), 'rename-binary.bin'),
      Buffer.from([0, 1, 2, 3, 4]),
    );

    const argsLog = join(mockRootDir, 'git-args.log');
    const previousGitTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = argsLog;
    let capture;
    try {
      capture = await captureArchivedContainerGitState({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'single-repo',
        worktreePath: worktreePath(),
        persistedWorktree: persistedWorktree(),
      });
    } finally {
      if (previousGitTrace === undefined) {
        delete process.env.GIT_TRACE;
      } else {
        process.env.GIT_TRACE = previousGitTrace;
      }
    }

    expect(existsSync(markerPath)).toBe(false);
    const shortstatInvocation = readFileSync(argsLog, 'utf8')
      .split('\n')
      .find((line) => line.includes('git diff --shortstat '));
    expect(shortstatInvocation).toContain('--no-textconv');
    expect(capture.gitChanges).toMatchObject({
      status: 'complete',
      fileCount: 1,
      insertions: 0,
      deletions: 0,
    });
  });

  it('detects archived binary diffs without invoking textconv drivers', async () => {
    const markerPath = join(mockRootDir, 'per-file-textconv-called');
    const textconvPath = join(mockRootDir, 'per-file-textconv.mjs');
    writeFileSync(
      textconvPath,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(markerPath)}, 'called\\n');`,
        "process.stdout.write('normalized\\n');",
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(mockReferenceRepoPath, '.git', 'info', 'attributes'),
      'rename-binary.bin diff=archive-test\n',
    );
    runGit(mockReferenceRepoPath, [
      'config',
      'diff.archive-test.textconv',
      `${JSON.stringify(process.execPath)} ${JSON.stringify(textconvPath)}`,
    ]);
    writeFileSync(
      join(worktreePath(), 'rename-binary.bin'),
      Buffer.from([0, 1, 2, 3, 4]),
    );
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    mockManifest = makeManifest(capture);
    await listArchivedContainerChanges({
      projectId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
    });
    rmSync(join(mockReferenceRepoPath, 'rename-binary.bin'));

    const argsLog = join(mockRootDir, 'per-file-git-args.log');
    const previousGitTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = argsLog;
    let diff;
    try {
      diff = await readArchivedContainerChangeDiff({
        projectId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        repoId: '__single_repo__',
        filePath: 'rename-binary.bin',
      });
    } finally {
      if (previousGitTrace === undefined) {
        delete process.env.GIT_TRACE;
      } else {
        process.env.GIT_TRACE = previousGitTrace;
      }
    }

    expect(existsSync(markerPath)).toBe(false);
    expect(diff).toMatchObject({ binary: true });
    const numstatInvocation = readFileSync(argsLog, 'utf8')
      .split('\n')
      .find((line) => line.includes('--numstat'));
    expect(numstatInvocation).toContain('--no-textconv');
  });

  it('treats an already released canonical ref as a purgeable retry', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const repository = capture.gitState.repositories[0];
    await deleteArchivedContainerSnapshotRef({
      repoPath: repository.referenceRepoPath,
      refName: repository.snapshotRef,
      expectedCommit: repository.worktreeSnapshotCommit,
    });

    await expect(
      assertArchivedGitStatePurgeable(makeManifest(capture)),
    ).resolves.toBeUndefined();
  });

  it('propagates repository lookup failures instead of treating refs as missing', async () => {
    await expect(
      deleteArchivedContainerSnapshotRef({
        repoPath: join(mockRootDir, 'missing-repository'),
        refName:
          'refs/app/archived-containers/workspace-1/archive-1/repository',
        expectedCommit: 'a'.repeat(40),
      }),
    ).rejects.toThrow();
  });

  it('discards a partial multi-repository capturing descriptor', async () => {
    const secondRepoPath = join(mockRootDir, 'second-reference');
    mkdirSync(secondRepoPath);
    runGit(secondRepoPath, ['init', '-b', 'main']);
    const commit = runGit(mockReferenceRepoPath, ['rev-parse', 'main']);
    const snapshotRef =
      'refs/app/archived-containers/workspace-1/archive-1/repo-a';
    runGit(mockReferenceRepoPath, ['update-ref', snapshotRef, commit]);
    jest.mocked(readWorkspaceConfig).mockResolvedValueOnce({
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
    jest.mocked(readEffectiveWorkspaceConfig).mockResolvedValueOnce(
      withLegacyNullSourceRepoPath(
        {
          localConfig: { version: 1, type: 'multi-repo', repos: [] },
          manifest: null,
          sourceRepoPath: undefined,
          repos: [
            { id: 'repo-a', name: 'A', repoPath: mockReferenceRepoPath },
            { id: 'repo-b', name: 'B', repoPath: secondRepoPath },
          ],
          scripts: undefined,
          defaultPluginSelections: undefined,
          suppressedManifestRepos: [],
          unresolvedManifestRepoIds: [],
        },
        ['manifest', 'suppressedManifestRepos', 'unresolvedManifestRepoIds'],
      ),
    );
    const stagedPath = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'git-state.staged.json',
    );
    mkdirSync(join(mockRootDir, 'archives', WORKSPACE_ID, CONTAINER_ID), {
      recursive: true,
    });
    writeFileSync(
      stagedPath,
      JSON.stringify({
        version: 1,
        status: 'capturing',
        repositories: [
          {
            repoId: 'repo-a',
            repoName: 'A',
            relativePath: 'repos/repo-a',
            referenceRepoPath: mockReferenceRepoPath,
            comparisonBaseCommit: commit,
            headCommit: commit,
            indexSnapshotCommit: commit,
            worktreeSnapshotCommit: commit,
            snapshotRef,
          },
        ],
      }),
    );

    await expect(
      discardIncompleteArchivedGitCapture(WORKSPACE_ID, CONTAINER_ID),
    ).resolves.toBe(true);

    expect(existsSync(stagedPath)).toBe(false);
    expect(
      runGit(mockReferenceRepoPath, [
        'for-each-ref',
        '--format=%(refname)',
        snapshotRef,
      ]),
    ).toBe('');
  });

  // CAN-3039: the reported repro is the second archive attempt, which finds a
  // staged capture. The first attempt has no staged descriptor at all, and it
  // must degrade the same way so the sidebar Archive action succeeds outright
  // instead of failing once with a raw per-repository capture error.
  it('reports a missing worktree before staging a capture', async () => {
    const stagedPath = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'git-state.staged.json',
    );
    rmSync(worktreePath(), { recursive: true, force: true });

    await expect(
      captureArchivedContainerGitState({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'single-repo',
        worktreePath: worktreePath(),
        persistedWorktree: persistedWorktree(),
      }),
    ).rejects.toBeInstanceOf(MissingWorktreeIncompleteArchivedGitCaptureError);

    // Nothing was staged, so no orphaned descriptor is left behind either.
    expect(existsSync(stagedPath)).toBe(false);
  });

  it('preserves worker-published capture recovery state when its response is lost', async () => {
    const stagedPath = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'git-state.staged.json',
    );
    mockRunArchiveIoRequest.mockImplementationOnce(
      async (request: ArchiveIoOperationRequest, signal?: AbortSignal) => {
        await executeArchiveIoRequest(
          request,
          signal ?? new AbortController().signal,
          {
            progress: jest.fn(),
            child: { started: jest.fn(), exited: jest.fn() },
          },
        );
        throw new Error('archive worker response was lost');
      },
    );

    await expect(
      captureArchivedContainerGitState({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'single-repo',
        worktreePath: worktreePath(),
        persistedWorktree: persistedWorktree(),
      }),
    ).rejects.toThrow('archive worker response was lost');

    expect(existsSync(stagedPath)).toBe(true);
    const descriptor = await readArchivedGitStagedDescriptor(
      WORKSPACE_ID,
      CONTAINER_ID,
    );
    expect(descriptor).toMatchObject({
      status: 'capturing',
      repositories: [expect.objectContaining({ repoId: '__single_repo__' })],
    });
  });

  it('discards a partial capture after the worktree was deleted when explicitly authorized', async () => {
    const commit = runGit(mockReferenceRepoPath, ['rev-parse', 'main']);
    const snapshotRef =
      'refs/app/archived-containers/workspace-1/archive-1/__single_repo__';
    runGit(mockReferenceRepoPath, ['update-ref', snapshotRef, commit]);
    const stagedPath = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'git-state.staged.json',
    );
    mkdirSync(join(mockRootDir, 'archives', WORKSPACE_ID, CONTAINER_ID), {
      recursive: true,
    });
    writeFileSync(
      stagedPath,
      JSON.stringify({
        version: 1,
        status: 'capturing',
        repositories: [
          {
            repoId: '__single_repo__',
            repoName: 'reference',
            relativePath: '.',
            referenceRepoPath: mockReferenceRepoPath,
            comparisonBaseCommit: commit,
            headCommit: commit,
            indexSnapshotCommit: commit,
            worktreeSnapshotCommit: commit,
            snapshotRef,
          },
        ],
      }),
    );
    rmSync(worktreePath(), { recursive: true, force: true });

    await expect(
      captureArchivedContainerGitState({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'single-repo',
        worktreePath: worktreePath(),
        persistedWorktree: persistedWorktree(),
      }),
    ).rejects.toBeInstanceOf(MissingWorktreeIncompleteArchivedGitCaptureError);
    await expect(
      discardIncompleteArchivedGitCapture(WORKSPACE_ID, CONTAINER_ID),
    ).resolves.toBe(false);
    expect(existsSync(stagedPath)).toBe(true);

    await expect(
      discardIncompleteArchivedGitCapture(WORKSPACE_ID, CONTAINER_ID, {
        allowMissingWorktree: true,
      }),
    ).resolves.toBe(true);

    expect(existsSync(stagedPath)).toBe(false);
    expect(
      runGit(mockReferenceRepoPath, [
        'for-each-ref',
        '--format=%(refname)',
        snapshotRef,
      ]),
    ).toBe('');
  });

  it('reports repository-specific restore preflight failures and preserves the archive', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const repository = capture.gitState.repositories[0];
    await deleteArchivedContainerSnapshotRef({
      repoPath: repository.referenceRepoPath,
      refName: repository.snapshotRef,
      expectedCommit: repository.worktreeSnapshotCommit,
    });

    await expect(
      assertArchivedGitStateRestorable(makeManifest(capture)),
    ).rejects.toThrow(
      'Archived Git state for repository reference is unavailable; the archive was preserved.',
    );
    expect(existsSync(worktreePath())).toBe(true);
  });

  it('allows restore and purge validation when the project only adds repositories', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const repository = capture.gitState.repositories[0];
    const repoId = 'repo-a';
    const snapshotRef = `refs/app/archived-containers/${WORKSPACE_ID}/${CONTAINER_ID}/${repoId}`;
    runGit(mockReferenceRepoPath, [
      'update-ref',
      snapshotRef,
      repository.worktreeSnapshotCommit,
    ]);
    const manifest = makeManifest(capture);
    manifest.workspaceType = 'multi-repo';
    manifest.gitState.repositories = [
      {
        ...repository,
        repoId,
        repoName: 'A',
        relativePath: `repos/${repoId}`,
        snapshotRef,
      },
    ];
    jest.mocked(readEffectiveWorkspaceConfig).mockResolvedValueOnce(
      withLegacyNullSourceRepoPath({
        localConfig: { version: 1, type: 'multi-repo', repos: [] },
        manifest: null,
        sourceRepoPath: undefined,
        repos: [
          { id: repoId, name: 'A', repoPath: mockReferenceRepoPath },
          {
            id: 'repo-added',
            name: 'Added',
            repoPath: join(mockRootDir, 'added-reference'),
          },
        ],
        scripts: undefined,
        defaultPluginSelections: undefined,
        suppressedManifestRepos: [],
        unresolvedManifestRepoIds: [],
      }),
    );

    await expect(
      assertArchivedGitStateRestorable(manifest),
    ).resolves.toBeUndefined();
    jest.mocked(readEffectiveWorkspaceConfig).mockResolvedValueOnce(
      withLegacyNullSourceRepoPath({
        localConfig: { version: 1, type: 'multi-repo', repos: [] },
        manifest: null,
        sourceRepoPath: undefined,
        repos: [
          { id: repoId, name: 'A', repoPath: mockReferenceRepoPath },
          {
            id: 'repo-added',
            name: 'Added',
            repoPath: join(mockRootDir, 'added-reference'),
          },
        ],
        scripts: undefined,
        defaultPluginSelections: undefined,
        suppressedManifestRepos: [],
        unresolvedManifestRepoIds: [],
      }),
    );
    await expect(
      assertArchivedGitStatePurgeable(manifest),
    ).resolves.toBeUndefined();
  });

  it('reports a missing source repository before restore and preserves the archive', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const movedReference = `${mockReferenceRepoPath}-missing`;
    renameSync(mockReferenceRepoPath, movedReference);
    try {
      await expect(
        assertArchivedGitStateRestorable(makeManifest(capture)),
      ).rejects.toThrow(
        'Archived Git state for repository reference is unavailable; the archive was preserved.',
      );
      expect(
        existsSync(
          join(
            mockRootDir,
            'archives',
            WORKSPACE_ID,
            CONTAINER_ID,
            'git-state.staged.json',
          ),
        ),
      ).toBe(true);
    } finally {
      renameSync(movedReference, mockReferenceRepoPath);
    }
  });

  it('reports a missing archived object before restore and preserves the archive', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const manifest = makeManifest(capture);
    manifest.gitState.repositories[0].headCommit =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    await expect(assertArchivedGitStateRestorable(manifest)).rejects.toThrow(
      'Archived Git state for repository reference is unavailable; the archive was preserved.',
    );
    expect(
      await readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID),
    ).not.toBeNull();
  });

  it('reconciles only orphan refs inside the requested project namespace', async () => {
    const commit = runGit(mockReferenceRepoPath, ['rev-parse', 'main']);
    const localRef =
      'refs/app/archived-containers/workspace-1/orphan/__single_repo__';
    const foreignRef =
      'refs/app/archived-containers/workspace-2/orphan/__single_repo__';
    runGit(mockReferenceRepoPath, ['update-ref', localRef, commit]);
    runGit(mockReferenceRepoPath, ['update-ref', foreignRef, commit]);
    mkdirSync(join(mockRootDir, 'archives', WORKSPACE_ID), {
      recursive: true,
    });

    await reconcileArchivedGitRefsForWorkspace(WORKSPACE_ID);

    expect(
      runGit(mockReferenceRepoPath, [
        'for-each-ref',
        '--format=%(refname)',
        localRef,
      ]),
    ).toBe('');
    expect(runGit(mockReferenceRepoPath, ['rev-parse', foreignRef])).toBe(
      commit,
    );
  });

  it('protects refs for a flagged staged-only container while pruning sibling orphans', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const protectedRef = capture.gitState.repositories[0]?.snapshotRef;
    if (!protectedRef) throw new Error('Missing staged snapshot ref');
    const commit = runGit(mockReferenceRepoPath, ['rev-parse', 'main']);
    runGit(mockReferenceRepoPath, ['update-ref', protectedRef, commit]);
    const orphanRef =
      'refs/app/archived-containers/workspace-1/orphaned/__single_repo__';
    runGit(mockReferenceRepoPath, ['update-ref', orphanRef, commit]);
    // The container's destructive journal is unresolved.
    jest
      .mocked(assertNoDestructiveRecovery)
      .mockImplementation((_workspaceId, worktreeId) =>
        worktreeId === CONTAINER_ID
          ? Promise.reject(new Error('recovery required'))
          : Promise.resolve(),
      );

    try {
      await reconcileArchivedGitRefsForWorkspace(WORKSPACE_ID);
    } finally {
      jest
        .mocked(assertNoDestructiveRecovery)
        .mockImplementation(() => Promise.resolve());
    }

    expect(runGit(mockReferenceRepoPath, ['rev-parse', protectedRef])).toBe(
      commit,
    );
    expect(
      runGit(mockReferenceRepoPath, [
        'for-each-ref',
        '--format=%(refname)',
        orphanRef,
      ]),
    ).toBe('');
  });

  it('re-pins every repository ref when a later multi-repository release fails', async () => {
    const expectedCommit = runGit(mockReferenceRepoPath, ['rev-parse', 'main']);
    const firstRef =
      'refs/app/archived-containers/workspace-1/archive-1/repo-a';
    const secondRef =
      'refs/app/archived-containers/workspace-1/archive-1/repo-b';
    runGit(mockReferenceRepoPath, ['update-ref', firstRef, expectedCommit]);
    runGit(mockReferenceRepoPath, ['update-ref', secondRef, expectedCommit]);
    let deletionCount = 0;

    await expect(
      releaseArchivedGitState(
        {
          version: 1,
          diffFormatVersion: 1,
          repositories: [
            {
              repoId: 'repo-a',
              repoName: 'A',
              relativePath: 'repos/repo-a',
              referenceRepoPath: mockReferenceRepoPath,
              comparisonBaseCommit: expectedCommit,
              headCommit: expectedCommit,
              indexSnapshotCommit: expectedCommit,
              worktreeSnapshotCommit: expectedCommit,
              snapshotRef: firstRef,
            },
            {
              repoId: 'repo-b',
              repoName: 'B',
              relativePath: 'repos/repo-b',
              referenceRepoPath: mockReferenceRepoPath,
              comparisonBaseCommit: expectedCommit,
              headCommit: expectedCommit,
              indexSnapshotCommit: expectedCommit,
              worktreeSnapshotCommit: expectedCommit,
              snapshotRef: secondRef,
            },
          ],
        },
        {
          deleteRef: async (args) => {
            deletionCount += 1;
            if (deletionCount === 2) throw new Error('simulated ref failure');
            await deleteArchivedContainerSnapshotRef(args);
          },
        },
      ),
    ).rejects.toThrow('simulated ref failure');

    expect(runGit(mockReferenceRepoPath, ['rev-parse', firstRef])).toBe(
      expectedCommit,
    );
    expect(runGit(mockReferenceRepoPath, ['rev-parse', secondRef])).toBe(
      expectedCommit,
    );
  });

  it('captures compact commits and restores HEAD, index, worktree, untracked files, modes, and symlinks exactly', async () => {
    createMixedChanges();
    const expectedBaseTip = runGit(mockReferenceRepoPath, [
      'rev-parse',
      'main',
    ]);
    const expectedHead = runGit(worktreePath(), ['rev-parse', 'HEAD']);
    const expectedStatus = runGitRaw(worktreePath(), [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
    const expectedIndexBoth = runGitRaw(worktreePath(), ['show', ':both.txt']);

    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const repository = capture.gitState.repositories[0];
    expect(repository.comparisonBaseBranch).toBe('main');
    expect(repository.baseBranchCommit).toBe(expectedBaseTip);
    expect(repository.headCommit).toBe(expectedHead);
    expect(repository.indexSnapshotCommit).not.toBe(repository.headCommit);
    expect(repository.worktreeSnapshotCommit).not.toBe(
      repository.indexSnapshotCommit,
    );
    expect(
      await readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID),
    ).toMatchObject({ status: 'ready', repositories: [repository] });

    const destinationId = 'restored-1';
    mkdirSync(join(mockRootDir, 'worktrees', WORKSPACE_ID), {
      recursive: true,
    });
    runGit(mockReferenceRepoPath, [
      'worktree',
      'add',
      '-b',
      'restored-branch',
      worktreePath(destinationId),
      repository.headCommit,
    ]);
    mockManifest = makeManifest(capture);
    await restoreArchivedContainerGitState({
      manifest: mockManifest,
      destinationId,
      destinationRootPath: worktreePath(destinationId),
    });

    expect(runGit(worktreePath(destinationId), ['rev-parse', 'HEAD'])).toBe(
      expectedHead,
    );
    expect(
      runGitRaw(worktreePath(destinationId), [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ]),
    ).toBe(expectedStatus);
    expect(runGitRaw(worktreePath(destinationId), ['show', ':both.txt'])).toBe(
      expectedIndexBoth,
    );
    expect(
      readFileSync(join(worktreePath(destinationId), 'both.txt'), 'utf8'),
    ).toBe('working\n');
    expect(
      readFileSync(join(worktreePath(destinationId), 'untracked.txt'), 'utf8'),
    ).toBe('untracked\n');
    expect(existsSync(join(worktreePath(destinationId), 'ignored.txt'))).toBe(
      false,
    );
    expect(
      runGit(worktreePath(destinationId), ['ls-files', '-s', 'both-link']),
    ).toMatch(/^120000 /);
    expect(
      runGit(worktreePath(destinationId), ['ls-files', '-s', 'executable.sh']),
    ).toMatch(/^100755 /);
  });

  it('prefers the remote-tracking base when local and remote branch tips differ', async () => {
    const commonTip = runGit(mockReferenceRepoPath, ['rev-parse', 'main']);
    const tree = runGit(mockReferenceRepoPath, ['rev-parse', 'main^{tree}']);
    const remoteTip = runGit(mockReferenceRepoPath, [
      'commit-tree',
      tree,
      '-p',
      commonTip,
      '-m',
      'remote tip',
    ]);
    runGit(mockReferenceRepoPath, [
      'update-ref',
      'refs/remotes/origin/main',
      remoteTip,
    ]);
    writeFileSync(join(mockReferenceRepoPath, 'local-main.txt'), 'local\n');
    runGit(mockReferenceRepoPath, ['add', 'local-main.txt']);
    runGit(mockReferenceRepoPath, ['commit', '-m', 'local main tip']);

    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });

    expect(capture.gitState.repositories[0]).toMatchObject({
      comparisonBaseBranch: 'main',
      baseBranchCommit: remoteTip,
      comparisonBaseCommit: commonTip,
    });
  });

  it.each(['--assume-unchanged', '--skip-worktree'])(
    'preserves %s edits through quarantine verification',
    async (flag) => {
      runGit(worktreePath(), ['update-index', flag, 'both.txt']);
      writeFileSync(join(worktreePath(), 'both.txt'), 'hidden edit\n');
      const capture = await captureArchivedContainerGitState({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'single-repo',
        worktreePath: worktreePath(),
        persistedWorktree: persistedWorktree(),
      });

      const teardown = await prepareArchivedContainerTeardown({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'single-repo',
        gitState: capture.gitState,
      });

      expect(
        runGit(mockReferenceRepoPath, [
          'show',
          `${capture.gitState.repositories[0].worktreeSnapshotCommit}:both.txt`,
        ]),
      ).toBe('hidden edit');
      expect(teardown.alreadyRemoved).toBe(false);
      expect(existsSync(teardown.quarantinePath)).toBe(true);
      expect(
        await readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID),
      ).toMatchObject({ teardown: { phase: 'verified' } });
    },
  );

  it('persists explicit branch deletion targets after quarantine removal', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const first = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
      deleteBranches: true,
    });
    const expectedDeletion = {
      repoId: '__single_repo__',
      referenceRepoPath: mockReferenceRepoPath,
      repositoryIdentity: referenceRepoIdentity(),
      branchName: capture.gitState.repositories[0].branchName,
      expectedTip: capture.gitState.repositories[0].headCommit,
    };

    expect(first.pendingBranchDeletions).toEqual([expectedDeletion]);
    expect(
      await readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID),
    ).toMatchObject({
      teardown: {
        branchDeletionTargets: [expectedDeletion],
        pendingBranchDeletions: [expectedDeletion],
      },
    });

    rmSync(first.quarantinePath, { recursive: true, force: true });
    const retry = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });

    expect(retry).toMatchObject({
      alreadyRemoved: true,
      pendingBranchDeletions: [expectedDeletion],
    });

    const preserveRetry = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
      deleteBranches: false,
    });
    expect(preserveRetry.pendingBranchDeletions).toEqual([]);
    expect(
      await readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID),
    ).toMatchObject({ teardown: { pendingBranchDeletions: [] } });

    const deleteAfterPreserve = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
      deleteBranches: true,
    });
    expect(deleteAfterPreserve.pendingBranchDeletions).toEqual([
      expectedDeletion,
    ]);
    expect(
      await readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID),
    ).toMatchObject({
      teardown: { pendingBranchDeletions: [expectedDeletion] },
    });
  });

  it('persists merged-only branch deletion policy before quarantine removal', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });

    const teardownOptions: Parameters<
      typeof prepareArchivedContainerTeardown
    >[0] = {
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
      deleteBranches: true,
      branchDeletionMode: 'merged-only',
    };
    const teardown = await prepareArchivedContainerTeardown(teardownOptions);

    expect(teardown).toMatchObject({ branchDeletionMode: 'merged-only' });
    await expect(
      readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID),
    ).resolves.toMatchObject({
      teardown: { branchDeletionMode: 'merged-only' },
    });
  });

  it('retains deletion intent when resuming a pending quarantine without request options', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const descriptor = await readArchivedGitStagedDescriptor(
      WORKSPACE_ID,
      CONTAINER_ID,
    );
    if (!descriptor) throw new Error('Expected staged descriptor');
    const expectedDeletion = {
      repoId: '__single_repo__',
      referenceRepoPath: mockReferenceRepoPath,
      repositoryIdentity: referenceRepoIdentity(),
      branchName: capture.gitState.repositories[0].branchName,
      expectedTip: capture.gitState.repositories[0].headCommit,
    };
    const quarantinePath = join(
      mockRootDir,
      'worktrees',
      WORKSPACE_ID,
      `.${CONTAINER_ID}.archive-quarantine`,
    );
    writeFileSync(
      join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'git-state.staged.json',
      ),
      JSON.stringify({
        ...descriptor,
        teardown: {
          phase: 'quarantine-pending',
          canonicalPath: worktreePath(),
          quarantinePath,
          enteredAt: '2026-08-07T00:00:00.000Z',
          branchDeletionTargets: [expectedDeletion],
          pendingBranchDeletions: [expectedDeletion],
        },
      }),
    );
    renameSync(worktreePath(), quarantinePath);

    const retry = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });

    expect(retry.pendingBranchDeletions).toEqual([expectedDeletion]);
    expect(
      await readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID),
    ).toMatchObject({
      teardown: {
        phase: 'verified',
        branchDeletionTargets: [expectedDeletion],
        pendingBranchDeletions: [expectedDeletion],
      },
    });
  });

  it('rebuilds persisted deletion targets from captured repositories on retry', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const descriptor = await readArchivedGitStagedDescriptor(
      WORKSPACE_ID,
      CONTAINER_ID,
    );
    if (!descriptor) throw new Error('Expected staged descriptor');
    const quarantinePath = join(
      mockRootDir,
      'worktrees',
      WORKSPACE_ID,
      `.${CONTAINER_ID}.archive-quarantine`,
    );
    const unrelatedDeletion = {
      repoId: 'unrelated',
      referenceRepoPath: join(mockRootDir, 'unrelated-repository'),
      repositoryIdentity: join(mockRootDir, 'unrelated-repository', '.git'),
      branchName: 'unrelated-branch',
      expectedTip: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    writeFileSync(
      join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'git-state.staged.json',
      ),
      JSON.stringify({
        ...descriptor,
        teardown: {
          phase: 'quarantine-pending',
          canonicalPath: worktreePath(),
          quarantinePath,
          enteredAt: '2026-08-07T00:00:00.000Z',
          branchDeletionTargets: [unrelatedDeletion],
          pendingBranchDeletions: [unrelatedDeletion],
        },
      }),
    );
    renameSync(worktreePath(), quarantinePath);

    const retry = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });

    expect(retry.pendingBranchDeletions).toEqual([
      {
        repoId: '__single_repo__',
        referenceRepoPath: mockReferenceRepoPath,
        repositoryIdentity: referenceRepoIdentity(),
        branchName: capture.gitState.repositories[0].branchName,
        expectedTip: capture.gitState.repositories[0].headCommit,
      },
    ]);
    expect(retry.pendingBranchDeletions).not.toContainEqual(unrelatedDeletion);
  });

  it('preserves stale repository branches across delete and preserve retries', async () => {
    const auxiliaryRepoPath = join(mockRootDir, 'stale-reference');
    mkdirSync(auxiliaryRepoPath);
    runGit(auxiliaryRepoPath, ['init', '-b', 'main']);
    runGit(auxiliaryRepoPath, ['config', 'user.name', 'Archive Test']);
    runGit(auxiliaryRepoPath, ['config', 'user.email', 'archive@example.com']);
    runGit(auxiliaryRepoPath, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(auxiliaryRepoPath, 'stale.txt'), 'stale\n');
    runGit(auxiliaryRepoPath, ['add', 'stale.txt']);
    runGit(auxiliaryRepoPath, ['commit', '-m', 'stale base']);
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const teardown = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });
    const stalePath = join(teardown.quarantinePath, 'repos', 'stale-repo');
    mkdirSync(join(teardown.quarantinePath, 'repos'), { recursive: true });
    runGit(auxiliaryRepoPath, [
      'worktree',
      'add',
      '-b',
      'stale-branch',
      stalePath,
    ]);
    const deletePlan = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
      deleteBranches: true,
    });
    expect(deletePlan.targets).toContainEqual(
      expect.objectContaining({
        repoId: 'stale-repo',
        referenceRepoPath: realpathSync.native(auxiliaryRepoPath),
        branchName: 'stale-branch',
      }),
    );
    expect(deletePlan.pendingBranchDeletions).not.toContainEqual(
      expect.objectContaining({ repoId: 'stale-repo' }),
    );

    rmSync(teardown.quarantinePath, { recursive: true, force: true });
    const preservePlan = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
      deleteBranches: false,
    });
    expect(preservePlan.pendingBranchDeletions).toEqual([]);

    const deleteAfterPreserve = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
      deleteBranches: true,
    });
    expect(deleteAfterPreserve.pendingBranchDeletions).not.toContainEqual(
      expect.objectContaining({ repoId: 'stale-repo' }),
    );
    expect(
      runGit(auxiliaryRepoPath, ['rev-parse', 'refs/heads/stale-branch']),
    ).toBeTruthy();
  }, 15_000);

  it('ignores a stale quarantined repository whose branch ref no longer resolves', async () => {
    const auxiliaryRepoPath = join(mockRootDir, 'missing-ref-reference');
    mkdirSync(auxiliaryRepoPath);
    runGit(auxiliaryRepoPath, ['init', '-b', 'main']);
    runGit(auxiliaryRepoPath, ['config', 'user.name', 'Archive Test']);
    runGit(auxiliaryRepoPath, ['config', 'user.email', 'archive@example.com']);
    runGit(auxiliaryRepoPath, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(auxiliaryRepoPath, 'stale.txt'), 'stale\n');
    runGit(auxiliaryRepoPath, ['add', 'stale.txt']);
    runGit(auxiliaryRepoPath, ['commit', '-m', 'stale base']);
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const teardown = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });
    const stalePath = join(teardown.quarantinePath, 'repos', 'missing-ref');
    mkdirSync(join(teardown.quarantinePath, 'repos'), { recursive: true });
    runGit(auxiliaryRepoPath, [
      'worktree',
      'add',
      '-b',
      'missing-ref-branch',
      stalePath,
    ]);
    runGit(auxiliaryRepoPath, [
      'update-ref',
      '-d',
      'refs/heads/missing-ref-branch',
    ]);

    const deletePlan = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
      deleteBranches: true,
    });

    expect(deletePlan.pendingBranchDeletions).not.toContainEqual(
      expect.objectContaining({ repoId: 'missing-ref' }),
    );
  });

  it('accepts a locally advanced base branch that still contains the archived tip', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    writeFileSync(join(mockReferenceRepoPath, 'base-ahead.txt'), 'ahead\n');
    runGit(mockReferenceRepoPath, ['add', 'base-ahead.txt']);
    runGit(mockReferenceRepoPath, ['commit', '-m', 'advance base']);

    await expect(
      resolveArchivedContainerRestoreBaseBranches(makeManifest(capture)),
    ).resolves.toEqual({
      baseBranchesByRepo: { __single_repo__: 'main' },
      warnings: [],
    });
  });

  it('rejects a rewritten base branch and returns a restore warning', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const archivedBase = capture.gitState.repositories[0]?.baseBranchCommit;
    if (!archivedBase) throw new Error('Expected an archived base tip');
    runGit(mockReferenceRepoPath, ['checkout', '--orphan', 'replacement-base']);
    runGit(mockReferenceRepoPath, ['rm', '-rf', '.']);
    writeFileSync(join(mockReferenceRepoPath, 'replacement.txt'), 'new root\n');
    runGit(mockReferenceRepoPath, ['add', 'replacement.txt']);
    runGit(mockReferenceRepoPath, ['commit', '-m', 'replace base history']);
    runGit(mockReferenceRepoPath, ['branch', '-f', 'main', 'HEAD']);

    await expect(
      resolveArchivedContainerRestoreBaseBranches(makeManifest(capture)),
    ).resolves.toEqual({
      baseBranchesByRepo: {},
      warnings: [
        `Base branch "main" for reference no longer contains archived commit ${archivedBase.slice(0, 8)}. Restored that repository using the current project default; review its base branch.`,
      ],
    });
  });

  it('renames to quarantine, detects a post-capture change, and rolls back without deleting the checkout', async () => {
    createMixedChanges();
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    writeFileSync(join(worktreePath(), 'late-write.txt'), 'too late\n');

    await expect(
      prepareArchivedContainerTeardown({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'single-repo',
        gitState: capture.gitState,
      }),
    ).rejects.toThrow(
      'The worktree changed while it was being archived. Try again.',
    );

    expect(existsSync(worktreePath())).toBe(true);
    expect(
      existsSync(
        join(
          mockRootDir,
          'worktrees',
          WORKSPACE_ID,
          `.${CONTAINER_ID}.archive-quarantine`,
        ),
      ),
    ).toBe(false);
    expect(
      await readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID),
    ).toBeNull();
    const repository = capture.gitState.repositories[0];
    expect(() =>
      runGit(mockReferenceRepoPath, [
        'rev-parse',
        '--verify',
        repository.snapshotRef,
      ]),
    ).toThrow();

    const retry = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    expect(
      runGit(mockReferenceRepoPath, [
        'ls-tree',
        '--name-only',
        retry.gitState.repositories[0].worktreeSnapshotCommit,
        'late-write.txt',
      ]),
    ).toBe('late-write.txt');
  });

  it('rolls back a root-only archive when project payload changes after capture', async () => {
    jest.mocked(readWorkspaceConfig).mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
    jest.mocked(readEffectiveWorkspaceConfig).mockResolvedValue(
      withLegacyNullSourceRepoPath({
        localConfig: { version: 1, type: 'multi-repo', repos: [] },
        manifest: null,
        sourceRepoPath: undefined,
        repos: [],
        scripts: undefined,
        defaultPluginSelections: undefined,
        suppressedManifestRepos: [],
        unresolvedManifestRepoIds: [],
      }),
    );
    rmSync(worktreePath(), { recursive: true, force: true });
    mkdirSync(worktreePath(), { recursive: true });
    writeFileSync(join(worktreePath(), 'captured.txt'), 'captured\n');
    const archivedRoot = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'workspace-root',
    );
    mkdirSync(archivedRoot, { recursive: true });
    writeFileSync(join(archivedRoot, 'captured.txt'), 'captured\n');
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      worktreePath: worktreePath(),
      persistedWorktree: {
        ...persistedWorktree(),
        includedRepoIds: [],
      },
      allowEmptyRepositories: true,
    });
    writeFileSync(join(worktreePath(), 'late-write.txt'), 'too late\n');

    await expect(
      prepareArchivedContainerTeardown({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'multi-repo',
        gitState: capture.gitState,
        workspaceRootCapture: { managedRepoIds: [] },
      }),
    ).rejects.toThrow(
      'The worktree changed while it was being archived. Try again.',
    );

    expect(existsSync(worktreePath())).toBe(true);
    expect(readFileSync(join(worktreePath(), 'late-write.txt'), 'utf8')).toBe(
      'too late\n',
    );
  });

  it('accepts matching root payloads when the synthetic repos directory modes differ', async () => {
    jest.mocked(readWorkspaceConfig).mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
    jest.mocked(readEffectiveWorkspaceConfig).mockResolvedValue(
      withLegacyNullSourceRepoPath({
        localConfig: { version: 1, type: 'multi-repo', repos: [] },
        manifest: null,
        sourceRepoPath: undefined,
        repos: [],
        scripts: undefined,
        defaultPluginSelections: undefined,
        suppressedManifestRepos: [],
        unresolvedManifestRepoIds: [],
      }),
    );
    rmSync(worktreePath(), { recursive: true, force: true });
    mkdirSync(join(worktreePath(), 'repos', 'personal'), { recursive: true });
    writeFileSync(
      join(worktreePath(), 'repos', 'personal', 'note.txt'),
      'preserved\n',
    );
    chmodSync(join(worktreePath(), 'repos'), 0o700);
    const archivedRoot = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'workspace-root',
    );
    mkdirSync(join(archivedRoot, 'repos', 'personal'), { recursive: true });
    writeFileSync(
      join(archivedRoot, 'repos', 'personal', 'note.txt'),
      'preserved\n',
    );
    chmodSync(join(archivedRoot, 'repos'), 0o755);
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      worktreePath: worktreePath(),
      persistedWorktree: {
        ...persistedWorktree(),
        includedRepoIds: [],
      },
      allowEmptyRepositories: true,
    });

    await expect(
      prepareArchivedContainerTeardown({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'multi-repo',
        gitState: capture.gitState,
        workspaceRootCapture: { managedRepoIds: [] },
      }),
    ).resolves.toBeDefined();
    expect(existsSync(worktreePath())).toBe(false);
  });

  it('accepts a captured workspace root whose repos are all managed', async () => {
    setupPartialMultiRepoFixture();
    const persisted = {
      ...persistedWorktree(),
      includedRepoIds: ['repo-a'],
    };
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persisted,
    });
    const archivedRoot = join(
      mockRootDir,
      'archives',
      WORKSPACE_ID,
      CONTAINER_ID,
      'workspace-root',
    );
    await captureArchivedWorkspaceRootPayload({
      source: worktreePath(),
      destination: archivedRoot,
      managedRepoIds: ['repo-a'],
      copyExecutor: async (input) => {
        await executeArchiveIoRequest(
          {
            version: 1,
            type: 'copy-payload',
            requestId: 'capture-workspace-root',
            operationId: 'capture-workspace-root',
            projectId: WORKSPACE_ID,
            containerId: CONTAINER_ID,
            expectedCreatedAt: persisted.createdAt,
            input,
          },
          new AbortController().signal,
          {
            progress: jest.fn(),
            child: { started: jest.fn(), exited: jest.fn() },
          },
        );
      },
    });

    expect(existsSync(join(archivedRoot, 'repos'))).toBe(false);
    await expect(
      prepareArchivedContainerTeardown({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        workspaceType: 'multi-repo',
        gitState: capture.gitState,
        workspaceRootCapture: { managedRepoIds: ['repo-a'] },
      }),
    ).resolves.toBeDefined();
  });

  it('startup recovery verifies a pending quarantine and finishes its teardown', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const descriptor = await readArchivedGitStagedDescriptor(
      WORKSPACE_ID,
      CONTAINER_ID,
    );
    if (!descriptor) throw new Error('Expected staged descriptor');
    const quarantinePath = join(
      mockRootDir,
      'worktrees',
      WORKSPACE_ID,
      `.${CONTAINER_ID}.archive-quarantine`,
    );
    writeFileSync(
      join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'git-state.staged.json',
      ),
      JSON.stringify({
        ...descriptor,
        teardown: {
          phase: 'quarantine-pending',
          canonicalPath: worktreePath(),
          quarantinePath,
          enteredAt: '2026-07-22T00:00:00.000Z',
        },
      }),
    );
    renameSync(worktreePath(), quarantinePath);

    await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);

    expect(existsSync(quarantinePath)).toBe(false);
    expect(existsSync(worktreePath())).toBe(false);
    expect(
      runGit(mockReferenceRepoPath, [
        'rev-parse',
        capture.gitState.repositories[0].snapshotRef,
      ]),
    ).toBe(capture.gitState.repositories[0].worktreeSnapshotCommit);
    expect(
      await readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID),
    ).toMatchObject({ teardown: { phase: 'verified' } });
    expect(archiveSingleRepoWorktree).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      worktreeId: CONTAINER_ID,
      retainAsArchivedContainer: true,
    });
  });

  it('startup recovery finishes verified teardown without touching a recreated canonical path', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const teardown = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });
    mkdirSync(worktreePath(), { recursive: true });
    writeFileSync(join(worktreePath(), 'new-occupant.txt'), 'preserve me\n');

    await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);

    expect(existsSync(teardown.quarantinePath)).toBe(false);
    expect(readFileSync(join(worktreePath(), 'new-occupant.txt'), 'utf8')).toBe(
      'preserve me\n',
    );
    expect(archiveSingleRepoWorktree).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      worktreeId: CONTAINER_ID,
      retainAsArchivedContainer: true,
    });
  });

  it('resumes a partially cleared checkout through archive I/O on startup', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const teardown = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });
    rmSync(join(teardown.quarantinePath, 'both.txt'));
    const dependencies = join(teardown.quarantinePath, 'node_modules');
    mkdirSync(dependencies);
    writeFileSync(join(dependencies, 'dependency.js'), 'dependency');
    mockRunArchiveIoRequest.mockClear();

    await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);

    const removalRequest = mockRunArchiveIoRequest.mock.calls
      .map((call: unknown[]) => call[0] as ArchiveIoOperationRequest)
      .find((request) => request.type === 'remove-worktree');
    expect(removalRequest?.type).toBe('remove-worktree');
    if (removalRequest?.type === 'remove-worktree') {
      expect(removalRequest.input.worktreePath).toBe(teardown.quarantinePath);
    }
    expect(existsSync(teardown.quarantinePath)).toBe(false);
  });

  it('startup recovery continues a verified archive after quarantine removal', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const teardown = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });
    runGit(mockReferenceRepoPath, [
      'worktree',
      'remove',
      '--force',
      teardown.quarantinePath,
    ]);

    await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);

    expect(existsSync(teardown.quarantinePath)).toBe(false);
    expect(archiveSingleRepoWorktree).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      worktreeId: CONTAINER_ID,
      retainAsArchivedContainer: true,
    });
  });

  it('startup recovery preserves an explicit branch-preservation decision', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const teardown = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
      deleteBranches: false,
    });
    runGit(mockReferenceRepoPath, [
      'worktree',
      'remove',
      '--force',
      teardown.quarantinePath,
    ]);

    await expect(
      readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID),
    ).resolves.toMatchObject({ teardown: { preserveBranches: true } });

    await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);

    expect(archiveSingleRepoWorktree).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      worktreeId: CONTAINER_ID,
      retainAsArchivedContainer: true,
      deleteBranch: false,
    });
  });

  it('startup recovery preserves quarantine when reparse-point cleanup fails', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const teardown = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });
    const cleanupReparsePoints = jest
      .spyOn(git, 'removeWindowsWorktreeReparsePoints')
      .mockRejectedValueOnce(new Error('reparse scan failed'));
    try {
      await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);
    } finally {
      cleanupReparsePoints.mockRestore();
    }

    expect(existsSync(teardown.quarantinePath)).toBe(true);
    expect(archiveSingleRepoWorktree).not.toHaveBeenCalled();
  });

  it('startup recovery removes quarantine residue after Git already unregistered it', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const teardown = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });
    runGit(mockReferenceRepoPath, [
      'worktree',
      'remove',
      '--force',
      teardown.quarantinePath,
    ]);
    mkdirSync(teardown.quarantinePath, { recursive: true });
    writeFileSync(join(teardown.quarantinePath, 'residue.txt'), 'remove me\n');

    await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);

    expect(existsSync(teardown.quarantinePath)).toBe(false);
    expect(archiveSingleRepoWorktree).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      worktreeId: CONTAINER_ID,
      retainAsArchivedContainer: true,
    });
  });

  it('startup recovery preserves a verified quarantine for an incomplete descriptor', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const teardown = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });
    const descriptor = await readArchivedGitStagedDescriptor(
      WORKSPACE_ID,
      CONTAINER_ID,
    );
    if (!descriptor?.teardown) throw new Error('Expected teardown journal');
    writeFileSync(
      join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'git-state.staged.json',
      ),
      JSON.stringify({
        version: 1,
        status: 'capturing',
        repositories: descriptor.repositories,
        teardown: descriptor.teardown,
      }),
    );

    await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);

    expect(existsSync(teardown.quarantinePath)).toBe(true);
    expect(existsSync(worktreePath())).toBe(false);
    expect(
      await readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID),
    ).toMatchObject({
      status: 'capturing',
      teardown: { phase: 'verified' },
    });
    expect(archiveSingleRepoWorktree).not.toHaveBeenCalled();
  });

  it('startup recovery preserves a pending quarantine for an incomplete descriptor', async () => {
    await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const descriptor = await readArchivedGitStagedDescriptor(
      WORKSPACE_ID,
      CONTAINER_ID,
    );
    if (!descriptor) throw new Error('Expected staged descriptor');
    const quarantinePath = join(
      mockRootDir,
      'worktrees',
      WORKSPACE_ID,
      `.${CONTAINER_ID}.archive-quarantine`,
    );
    const teardown = {
      phase: 'quarantine-pending' as const,
      canonicalPath: worktreePath(),
      quarantinePath,
      enteredAt: '2026-07-22T00:00:00.000Z',
    };
    writeFileSync(
      join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'git-state.staged.json',
      ),
      JSON.stringify({
        version: 1,
        status: 'capturing',
        repositories: descriptor.repositories,
        teardown,
      }),
    );
    renameSync(worktreePath(), quarantinePath);

    await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);

    expect(existsSync(quarantinePath)).toBe(true);
    expect(existsSync(worktreePath())).toBe(false);
    expect(
      await readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID),
    ).toMatchObject({ status: 'capturing', teardown });
    expect(archiveSingleRepoWorktree).not.toHaveBeenCalled();
  });

  it('startup recovery unregisters stale child worktrees before deleting quarantine', async () => {
    const auxiliaryRepoPath = join(mockRootDir, 'stale-reference');
    mkdirSync(auxiliaryRepoPath);
    runGit(auxiliaryRepoPath, ['init', '-b', 'main']);
    runGit(auxiliaryRepoPath, ['config', 'user.name', 'Archive Test']);
    runGit(auxiliaryRepoPath, ['config', 'user.email', 'archive@example.com']);
    runGit(auxiliaryRepoPath, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(auxiliaryRepoPath, 'stale.txt'), 'stale\n');
    runGit(auxiliaryRepoPath, ['add', 'stale.txt']);
    runGit(auxiliaryRepoPath, ['commit', '-m', 'stale base']);
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const teardown = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });
    const stalePath = join(teardown.quarantinePath, 'repos', 'stale-repo');
    mkdirSync(join(teardown.quarantinePath, 'repos'), { recursive: true });
    runGit(auxiliaryRepoPath, [
      'worktree',
      'add',
      '-b',
      'stale-branch',
      stalePath,
    ]);

    await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);

    expect(existsSync(teardown.quarantinePath)).toBe(false);
    expect(
      runGitRaw(auxiliaryRepoPath, ['worktree', 'list', '--porcelain']),
    ).not.toContain(stalePath);
    expect(archiveSingleRepoWorktree).toHaveBeenCalled();
  });

  it('startup recovery rejects a repos symlink that escapes quarantine', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const teardown = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      gitState: capture.gitState,
    });
    const externalPath = join(mockRootDir, 'external-worktree');
    mkdirSync(externalPath);
    writeFileSync(join(externalPath, 'keep.txt'), 'keep\n');
    symlinkSync(mockRootDir, join(teardown.quarantinePath, 'repos'), 'dir');
    let recoveryError: unknown;
    const warning = jest
      .spyOn(console, 'warn')
      .mockImplementation((_message: unknown, details: unknown) => {
        if (isRecord(details)) recoveryError = details.error;
      });

    await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);

    expect(warning).toHaveBeenCalledWith(
      'Archived Git teardown recovery requires attention.',
      expect.anything(),
    );
    expect(recoveryError).toBeInstanceOf(Error);
    if (!(recoveryError instanceof Error)) {
      throw new Error('Expected recovery to report an error.');
    }
    expect(recoveryError.message).toContain(
      'Repository directory points outside the worktree:',
    );
    expect(readFileSync(join(externalPath, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(existsSync(teardown.quarantinePath)).toBe(true);
    expect(archiveSingleRepoWorktree).not.toHaveBeenCalled();
  }, 30_000);

  it('startup recovery rejects a configured child symlink that escapes quarantine', async () => {
    const { referenceRepoPath } = setupPartialMultiRepoFixture();
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      worktreePath: worktreePath(),
      persistedWorktree: {
        ...persistedWorktree(),
        includedRepoIds: ['repo-a'],
      },
    });
    const teardown = await prepareArchivedContainerTeardown({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'multi-repo',
      gitState: capture.gitState,
    });
    const configuredChildPath = join(
      teardown.quarantinePath,
      'repos',
      'repo-a',
    );
    const externalPath = join(mockRootDir, 'external-registered-worktree');
    runGit(referenceRepoPath, [
      'worktree',
      'add',
      '-b',
      'external-registered',
      externalPath,
      'main',
    ]);
    rmSync(configuredChildPath, { recursive: true, force: true });
    symlinkSync(externalPath, configuredChildPath, 'dir');
    let recoveryError: unknown;
    const warning = jest
      .spyOn(console, 'warn')
      .mockImplementation((_message: unknown, details: unknown) => {
        if (isRecord(details)) recoveryError = details.error;
      });

    await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);

    expect(warning).toHaveBeenCalledWith(
      'Archived Git teardown recovery requires attention.',
      expect.anything(),
    );
    expect(recoveryError).toBeInstanceOf(Error);
    if (!(recoveryError instanceof Error)) {
      throw new Error('Expected recovery to report an error.');
    }
    expect(recoveryError.message).toBe(
      'Archived Git teardown target escaped its quarantine root.',
    );
    expect(existsSync(externalPath)).toBe(true);
    expect(
      runGitRaw(referenceRepoPath, ['worktree', 'list', '--porcelain']),
    ).toContain(externalPath.replaceAll('\\', '/'));
    expect(existsSync(teardown.quarantinePath)).toBe(true);
    expect(archiveMultiRepoWorktree).not.toHaveBeenCalled();
  }, 30_000);

  it('startup recovery rejects tampered persisted teardown paths', async () => {
    await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const descriptor = await readArchivedGitStagedDescriptor(
      WORKSPACE_ID,
      CONTAINER_ID,
    );
    if (!descriptor) throw new Error('Expected staged descriptor');
    writeFileSync(
      join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'git-state.staged.json',
      ),
      JSON.stringify({
        ...descriptor,
        teardown: {
          phase: 'verified',
          canonicalPath: join(mockRootDir, 'unrelated-live'),
          quarantinePath: join(mockRootDir, 'unrelated-quarantine'),
          enteredAt: '2026-07-22T00:00:00.000Z',
        },
      }),
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);

    expect(existsSync(worktreePath())).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      'Archived Git teardown recovery requires attention.',
      expect.objectContaining({ containerId: CONTAINER_ID }),
    );
    warn.mockRestore();
  });

  it('startup recovery preserves refs when an unverified quarantine disappeared', async () => {
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const descriptor = await readArchivedGitStagedDescriptor(
      WORKSPACE_ID,
      CONTAINER_ID,
    );
    if (!descriptor) throw new Error('Expected staged descriptor');
    const quarantinePath = join(
      mockRootDir,
      'worktrees',
      WORKSPACE_ID,
      `.${CONTAINER_ID}.archive-quarantine`,
    );
    writeFileSync(
      join(
        mockRootDir,
        'archives',
        WORKSPACE_ID,
        CONTAINER_ID,
        'git-state.staged.json',
      ),
      JSON.stringify({
        ...descriptor,
        teardown: {
          phase: 'quarantine-pending',
          canonicalPath: worktreePath(),
          quarantinePath,
          enteredAt: '2026-07-22T00:00:00.000Z',
        },
      }),
    );
    rmSync(worktreePath(), { recursive: true, force: true });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await recoverArchivedGitTeardownsForWorkspace(WORKSPACE_ID);

    expect(
      await readArchivedGitStagedDescriptor(WORKSPACE_ID, CONTAINER_ID),
    ).toMatchObject({ teardown: { phase: 'quarantine-pending' } });
    expect(
      runGit(mockReferenceRepoPath, [
        'rev-parse',
        capture.gitState.repositories[0].snapshotRef,
      ]),
    ).toBe(capture.gitState.repositories[0].worktreeSnapshotCommit);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('recaptures a stale ready descriptor left before teardown', async () => {
    const first = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    writeFileSync(join(worktreePath(), 'late-write.txt'), 'too late\n');

    const retry = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });

    expect(retry.gitState.repositories[0].worktreeSnapshotCommit).not.toBe(
      first.gitState.repositories[0].worktreeSnapshotCommit,
    );
    expect(
      runGit(mockReferenceRepoPath, [
        'ls-tree',
        '--name-only',
        retry.gitState.repositories[0].worktreeSnapshotCommit,
        'late-write.txt',
      ]),
    ).toBe('late-write.txt');
  });

  it('pages a deterministic immutable change set and reads rename diffs from the trusted old path', async () => {
    createMixedChanges();
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    const capturedManifest = makeManifest(capture);
    if (capturedManifest.gitChanges.status !== 'complete') {
      throw new Error('Expected complete Git changes in the fixture');
    }
    mockManifest = {
      ...capturedManifest,
      gitChanges: {
        ...capturedManifest.gitChanges,
        fileCount: capturedManifest.gitChanges.fileCount + 1,
        repositories: capturedManifest.gitChanges.repositories.map(
          (repository) => ({
            ...repository,
            fileCount: repository.fileCount + 1,
          }),
        ),
      },
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const [first, concurrent] = await Promise.all([
      listArchivedContainerChanges({
        projectId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        limit: 2,
      }),
      listArchivedContainerChanges({
        projectId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        limit: 2,
      }),
    ]);
    expect(concurrent).toEqual(first);
    expect(warn).toHaveBeenCalledWith(
      'Archived Git changed-file count differs from captured summary.',
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
      }),
    );
    expect(first.files).toHaveLength(2);
    expect(first.totalCount).toBeGreaterThan(first.files.length);
    expect(first.nextCursor).not.toBeNull();
    const second = await listArchivedContainerChanges({
      projectId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      cursor: first.nextCursor ?? undefined,
      limit: 500,
    });
    const allFiles = [...first.files, ...second.files];
    expect(allFiles).toEqual(
      [...allFiles].sort(
        (left, right) =>
          (left.repoName ?? '').localeCompare(right.repoName ?? '') ||
          (left.repoId ?? '').localeCompare(right.repoId ?? '') ||
          left.path.localeCompare(right.path),
      ),
    );
    expect(allFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'renamed.txt',
          previousPath: 'rename-me.txt',
          status: 'renamed',
        }),
        expect.objectContaining({
          path: 'copied-binary.bin',
          previousPath: 'copy-binary-source.bin',
          status: 'copied',
        }),
        expect.objectContaining({
          path: 'copied-image.png',
          previousPath: 'copy-image-source.png',
          status: 'copied',
        }),
      ]),
    );

    const diff = await readArchivedContainerChangeDiff({
      projectId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      repoId: '__single_repo__',
      filePath: 'renamed.txt',
    });
    expect(diff).toMatchObject({
      source: 'combined',
      filePath: 'renamed.txt',
      oldValue: 'old name\n',
      newValue: 'old name\n',
      binary: false,
    });
    const copiedDiff = await readArchivedContainerChangeDiff({
      projectId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      repoId: '__single_repo__',
      filePath: 'copied.txt',
    });
    expect(copiedDiff).toMatchObject({
      oldValue: 'copy me\n',
      newValue: 'copy me\n',
      binary: false,
      source: 'combined',
    });
    const binaryDiff = await readArchivedContainerChangeDiff({
      projectId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      repoId: '__single_repo__',
      filePath: 'renamed-binary.bin',
    });
    expect(binaryDiff).toMatchObject({
      oldValue: '',
      newValue: '',
      binary: true,
      source: 'combined',
    });
    const imageDiff = await readArchivedContainerChangeDiff({
      projectId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      repoId: '__single_repo__',
      filePath: 'renamed-image.png',
    });
    expect(imageDiff).toMatchObject({ binary: true, source: 'combined' });
    expect(imageDiff.imagePreview?.oldDataUrl).toContain(
      'data:image/png;base64,',
    );
    expect(imageDiff.imagePreview?.newDataUrl).toContain(
      'data:image/png;base64,',
    );
    const copiedBinaryDiff = await readArchivedContainerChangeDiff({
      projectId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      repoId: '__single_repo__',
      filePath: 'copied-binary.bin',
    });
    expect(copiedBinaryDiff).toMatchObject({
      oldValue: '',
      newValue: '',
      binary: true,
      source: 'combined',
    });
    const copiedImageDiff = await readArchivedContainerChangeDiff({
      projectId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      repoId: '__single_repo__',
      filePath: 'copied-image.png',
    });
    expect(copiedImageDiff).toMatchObject({
      binary: true,
      source: 'combined',
    });
    expect(copiedImageDiff.imagePreview?.oldDataUrl).toContain(
      'data:image/png;base64,',
    );
    expect(copiedImageDiff.imagePreview?.newDataUrl).toContain(
      'data:image/png;base64,',
    );
    await expect(
      listArchivedContainerChanges({
        projectId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        cursor: 'not-a-cursor',
      }),
    ).rejects.toThrow('Invalid or stale archived changes cursor.');
    await expect(
      readArchivedContainerChangeDiff({
        projectId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
        repoId: '__single_repo__',
        filePath: '../outside.txt',
      }),
    ).rejects.toThrow('Invalid archived file path.');
    warn.mockRestore();
  });

  it('reads archived changes from pinned objects even when replacement refs exist', async () => {
    createMixedChanges();
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    mockManifest = makeManifest(capture);
    const repository = capture.gitState.repositories[0];
    runGit(mockReferenceRepoPath, [
      'replace',
      repository.worktreeSnapshotCommit,
      repository.comparisonBaseCommit,
    ]);
    await invalidateArchivedContainerChanges(WORKSPACE_ID, CONTAINER_ID);

    const changes = await listArchivedContainerChanges({
      projectId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      limit: 500,
    });

    expect(changes.files).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'both.txt' })]),
    );

    const destinationId = 'replacement-restore';
    runGit(mockReferenceRepoPath, [
      'worktree',
      'add',
      '-b',
      'replacement-restore',
      worktreePath(destinationId),
      repository.headCommit,
    ]);
    await restoreArchivedContainerGitState({
      manifest: mockManifest,
      destinationId,
      destinationRootPath: worktreePath(destinationId),
    });
    expect(
      readFileSync(join(worktreePath(destinationId), 'both.txt'), 'utf8'),
    ).toBe('working\n');
  });

  it('revalidates archived Git state before serving cached changes', async () => {
    createMixedChanges();
    const capture = await captureArchivedContainerGitState({
      workspaceId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
      workspaceType: 'single-repo',
      worktreePath: worktreePath(),
      persistedWorktree: persistedWorktree(),
    });
    mockManifest = makeManifest(capture);
    await listArchivedContainerChanges({
      projectId: WORKSPACE_ID,
      containerId: CONTAINER_ID,
    });
    const repository = capture.gitState.repositories[0];
    await deleteArchivedContainerSnapshotRef({
      repoPath: repository.referenceRepoPath,
      refName: repository.snapshotRef,
      expectedCommit: repository.worktreeSnapshotCommit,
    });

    await expect(
      listArchivedContainerChanges({
        projectId: WORKSPACE_ID,
        containerId: CONTAINER_ID,
      }),
    ).rejects.toThrow(
      'Archived Git state for repository reference is unavailable; the archive was preserved.',
    );
  });
});
