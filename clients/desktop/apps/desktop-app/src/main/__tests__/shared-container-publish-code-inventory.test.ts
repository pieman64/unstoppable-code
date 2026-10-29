import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import type {
  PersistedChatTab,
  TrackedPlanData,
  WorkspaceNoteItem,
} from '@canopy/desktop-shared/types';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import type * as ScriptResolverModule from '../lib/script-resolver';

jest.mock('../lib/script-resolver', () => ({
  ...jest.requireActual<typeof ScriptResolverModule>('../lib/script-resolver'),
  resolveProjectScripts: jest.fn(),
  resolveWorkspaceRepoScripts: jest.fn(),
  resolveWorkspaceRootScripts: jest.fn(),
}));
jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: jest.fn(),
}));
import {
  isSharedContainerRevisionLayout,
  isSharedContainerPublishedPlan,
  MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
  MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION,
  MAX_SHARED_CONTAINER_MATERIALIZED_FILES,
  MAX_SHARED_CONTAINER_REVISION_BYTES,
} from '@canopy/protocol/shared-containers';
import {
  getCommittedFilesBetween,
  getHeadCommitShaStrict,
  getMergeBaseForBranch,
  inspectRepositoryTreeEntryKinds,
  listUntrackedFilesStrict,
  listWorkingTreeDiffAgainstCommit,
  listWorkingTreeDiffAgainstHead,
  materializeGitCommitRaw,
  repositoryUsesGitLfs,
  type RawDiffEntry,
} from '../lib/git';
import {
  resolveWorkspaceRepoScripts,
  resolveWorkspaceRootScripts,
} from '../lib/script-resolver';
import { getWorktreeShareFileScopePath } from '../lib/paths';
import { getWorkspaceType } from '../lib/workspace-registry';
import { writeSharedContainerFileScope } from '../shared-containers/file-scope-store';
import {
  assertCodePublishInventoryHeadsStable,
  buildCodePublishInventory,
  defaultResolveRunScripts,
  defaultReadRunEnvSample,
  deriveSharedContainerRunConfig,
  listSharedContainerRunScriptCandidates,
  measureCodeRevisionBaseBytes,
  readCodeWorkspaceItemForPublication,
  type CodePublishInventoryDependencies,
} from '../shared-containers/publish/code-inventory';
import { buildCodeRevisionArtifacts } from '../shared-containers/publish/code';
import { isSharedContainerRunPublishingEnabled } from '../shared-containers/run/availability';
import {
  buildSharedContainerCodeSnapshot,
  type SharedContainerCodeSnapshot,
  type SharedContainerSnapshotChunk,
} from '../shared-containers/publish/code-snapshot';
import type { SharedContainerPublishRefusalError } from '../shared-containers/publish/errors';
import { SharedContainerPublishInventoryChangedError } from '../shared-containers/publish/source-files';
import { createStableFileSource } from '../shared-containers/publish/source-files';
import { SharedContainerReplicaManager } from '../shared-containers/replica/manager';
import {
  materializeCodeRevision,
  type MaterializeCodeDependencies,
} from '../shared-containers/materialize/code';
import {
  buildSharedContainerDirtyFileFixture,
  buildSharedContainerReplicaFixture,
  fetchForSharedContainerFixture,
  transportForSharedContainerFixture,
} from './fixtures/shared-container-replica-fixture';

const execFileAsync = promisify(execFile);
const mockedGetWorkspaceType = jest.mocked(getWorkspaceType);
const mockedResolveWorkspaceRepoScripts = jest.mocked(
  resolveWorkspaceRepoScripts,
);
const mockedResolveWorkspaceRootScripts = jest.mocked(
  resolveWorkspaceRootScripts,
);

function snapshotChunk(bytes: Buffer): SharedContainerSnapshotChunk {
  const digest = createHash('sha256').update(bytes).digest('hex');
  return {
    hash: digest,
    sizeBytes: bytes.byteLength,
    source: {
      sizeBytes: bytes.byteLength,
      hash: `sha256:${digest}`,
      createReadStream: () => Readable.from(bytes),
    },
  };
}

async function disposeSnapshot(
  snapshot: SharedContainerCodeSnapshot,
): Promise<void> {
  await Promise.all(
    snapshot.chunks.map((chunk) => {
      if (!chunk.source?.dispose) return Promise.resolve();
      return chunk.source.dispose();
    }),
  );
}

function emptyTabs(): Promise<{
  version: 1;
  tabs: [];
  activeTabId: string;
}> {
  return Promise.resolve({ version: 1 as const, tabs: [], activeTabId: '' });
}

function dependencies(
  repoPath: string,
  overrides: Partial<CodePublishInventoryDependencies> = {},
): CodePublishInventoryDependencies {
  return {
    listRepositories: () =>
      Promise.resolve([
        {
          repoId: 'repo-1',
          repoName: 'repo',
          repoPath,
          relativePrefix: '',
        },
      ]),
    readChatTabs: emptyTabs,
    listAttachmentFiles: () => Promise.resolve([]),
    openAttachmentFile: () =>
      Promise.reject(new Error('unexpected attachment open')),
    listPlans: () => Promise.resolve([]),
    listNotes: () => Promise.resolve([]),
    listPrompts: () => Promise.resolve([]),
    readWorkspaceItem: () =>
      Promise.reject(new Error('unexpected workspace-item read')),
    resolvePushedBase: async (
      input,
    ): ReturnType<CodePublishInventoryDependencies['resolvePushedBase']> => {
      const headSha = await getHeadCommitShaStrict(input.repoPath, {
        timeoutMs: 30_000,
        signal: new AbortController().signal,
      }).catch(() => 'a'.repeat(40));
      return headSha
        ? { baseSha: headSha, headSha, unpushedCommitCount: 0 }
        : null;
    },
    getRemoteUrl: () =>
      Promise.resolve('https://github.com/example/repository.git'),
    listDiff: (path, _sha, options) =>
      listWorkingTreeDiffAgainstHead(path, options),
    listUntracked: listUntrackedFilesStrict,
    getHead: async (path, options): Promise<string | null> => {
      const { getHeadCommitShaStrict } = await import('../lib/git');
      return getHeadCommitShaStrict(path, options);
    },
    resolveBaseBranch: () =>
      Promise.resolve({
        branch: 'main',
        existsLocally: true,
        existsInRemote: false,
      }),
    getMergeBase: getMergeBaseForBranch,
    listCommittedFiles: getCommittedFilesBetween,
    usesLfs: repositoryUsesGitLfs,
    inspectTreeEntries: inspectRepositoryTreeEntryKinds,
    createFileSource: createStableFileSource,
    resolveRunScripts: () => Promise.resolve({}),
    readRunEnvSample: () => Promise.resolve(null),
    buildSnapshot: () =>
      Promise.reject(new Error('unexpected shared-container snapshot build')),
    ...overrides,
  };
}

async function initializeRepository(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'shared-code-inventory-'));
  await execFileAsync('git', ['init'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 'test@example.test'], {
    cwd: repo,
  });
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'tracked.ts'), 'before\n');
  await execFileAsync('git', ['add', '.'], { cwd: repo });
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repo });
  return repo;
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(30_000);

describe('code shared-container publish inventory', () => {
  it('publishes run metadata only when the feature is enabled on macOS', () => {
    expect(isSharedContainerRunPublishingEnabled(true, 'darwin')).toBe(true);
    expect(isSharedContainerRunPublishingEnabled(false, 'darwin')).toBe(false);
    expect(isSharedContainerRunPublishingEnabled(true, 'win32')).toBe(false);
  });

  it('builds deterministic snapshots while withholding credential-shaped files', async () => {
    const repoPath = await initializeRepository();
    await writeFile(join(repoPath, '.env.production'), 'TOKEN=secret\n');
    await execFileAsync('git', ['add', '.env.production'], { cwd: repoPath });
    await execFileAsync('git', ['commit', '-m', 'credential fixture'], {
      cwd: repoPath,
    });
    const headSha = await getHeadCommitShaStrict(repoPath, {
      timeoutMs: 30_000,
      signal: new AbortController().signal,
    });

    const first = await buildSharedContainerCodeSnapshot({
      repoPath,
      headSha,
    });
    const second = await buildSharedContainerCodeSnapshot({
      repoPath,
      headSha,
    });

    expect(first.withheldPaths).toEqual(['.env.production']);
    expect(first.treeFileCount).toBe(1);
    expect(second.baseCommitSha).toBe(first.baseCommitSha);
    expect(
      second.chunks.map(({ hash, sizeBytes }) => ({ hash, sizeBytes })),
    ).toEqual(first.chunks.map(({ hash, sizeBytes }) => ({ hash, sizeBytes })));
    await Promise.all([disposeSnapshot(first), disposeSnapshot(second)]);
  });

  it('keeps snapshot bundle bodies out of memory-backed chunk descriptors', async () => {
    const repoPath = await initializeRepository();
    const headSha = await getHeadCommitShaStrict(repoPath, {
      timeoutMs: 30_000,
      signal: new AbortController().signal,
    });

    const snapshot = await buildSharedContainerCodeSnapshot({
      repoPath,
      headSha,
    });
    const metadataOnly = await buildSharedContainerCodeSnapshot({
      repoPath,
      headSha,
      includeChunkSources: false,
    } as Parameters<typeof buildSharedContainerCodeSnapshot>[0] & {
      includeChunkSources: false;
    });

    expect(snapshot.chunks.length).toBeGreaterThan(0);
    expect(
      snapshot.chunks.every(
        (chunk) => !('bytes' in chunk) && 'source' in chunk,
      ),
    ).toBe(true);
    expect(
      metadataOnly.chunks.every(
        (chunk) => !('bytes' in chunk) && !('source' in chunk),
      ),
    ).toBe(true);
    await disposeSnapshot(snapshot);
  });

  it('builds a no-HEAD working-tree snapshot and withholds credentials', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'snapshot-no-head-'));
    await execFileAsync('git', ['init'], { cwd: repoPath });
    await writeFile(join(repoPath, 'hello.txt'), 'hello\n');
    await writeFile(join(repoPath, '.env.local'), 'TOKEN=secret\n');

    const snapshot = await buildSharedContainerCodeSnapshot({
      repoPath,
      headSha: null,
    });

    expect(snapshot.withheldPaths).toEqual(['.env.local']);
    expect(snapshot.treeFileCount).toBe(1);
    expect(snapshot.treeBytes).toBe(BigInt(6));
    expect(snapshot.chunks.length).toBeGreaterThan(0);
    await disposeSnapshot(snapshot);
  });

  it('withholds committed paths whose working-tree files are hard links', async () => {
    const repoPath = await initializeRepository();
    await writeFile(join(repoPath, 'hardlink-source.txt'), 'shared inode\n');
    await link(
      join(repoPath, 'hardlink-source.txt'),
      join(repoPath, 'hardlink-copy.txt'),
    );
    await execFileAsync(
      'git',
      ['add', 'hardlink-source.txt', 'hardlink-copy.txt'],
      {
        cwd: repoPath,
      },
    );
    await execFileAsync('git', ['commit', '-m', 'hardlink fixture'], {
      cwd: repoPath,
    });
    const headSha = await getHeadCommitShaStrict(repoPath, {
      timeoutMs: 30_000,
      signal: new AbortController().signal,
    });

    const snapshot = await buildSharedContainerCodeSnapshot({
      repoPath,
      headSha,
    });

    expect(snapshot.withheldPaths).toEqual([
      'hardlink-copy.txt',
      'hardlink-source.txt',
    ]);
    await disposeSnapshot(snapshot);
  });

  it('materializes a snapshot bundle without a GitHub probe', async () => {
    const sourceRepo = await initializeRepository();
    const headSha = await getHeadCommitShaStrict(sourceRepo, {
      timeoutMs: 30_000,
      signal: new AbortController().signal,
    });
    const snapshot: SharedContainerCodeSnapshot =
      await buildSharedContainerCodeSnapshot({
        repoPath: sourceRepo,
        headSha,
      });
    const root = await mkdtemp(join(tmpdir(), 'snapshot-recipient-'));
    const artifactsDir = join(root, 'artifacts');
    const artifactPathsById = new Map<string, string>();
    const bundleArtifactIds: string[] = [];
    const snapshotChunks = snapshot.chunks;
    for (let index = 0; index < snapshotChunks.length; index += 1) {
      const chunk = snapshotChunks[index];
      if (!chunk) throw new Error('Snapshot chunk is missing');
      const artifactId = `snapshot-${index}`;
      const artifactPath = `repos/repo-1/snapshot/${chunk.hash}`;
      await mkdir(join(artifactsDir, 'repos', 'repo-1', 'snapshot'), {
        recursive: true,
      });
      if (!chunk.source) throw new Error('Snapshot chunk source is missing');
      const buffers: Buffer[] = [];
      for await (const bytes of chunk.source.createReadStream()) {
        if (!Buffer.isBuffer(bytes)) {
          throw new Error('Snapshot chunk source returned text');
        }
        buffers.push(bytes);
      }
      await writeFile(join(artifactsDir, artifactPath), Buffer.concat(buffers));
      artifactPathsById.set(artifactId, artifactPath);
      bundleArtifactIds.push(artifactId);
    }
    await disposeSnapshot(snapshot);
    const resolveGitHubToken = jest.fn(() => Promise.resolve('unexpected'));
    const result = await materializeCodeRevision(
      {
        layout: {
          schemaVersion: 2,
          containerType: 'CODE_WORKTREE',
          title: 'Snapshot',
          repositories: [
            {
              repoId: 'repo-1',
              repoName: 'Repo',
              source: 'snapshot',
              baseCommitSha: snapshot.baseCommitSha,
              snapshot: {
                bundleArtifactIds,
                treeFileCount: snapshot.treeFileCount,
                treeBytes: snapshot.treeBytes.toString(),
              },
              files: [],
            },
          ],
          files: [],
          notes: [],
          prompts: [],
          attachmentPaths: {},
        },
        artifactsDir,
        reposDir: join(root, 'repos'),
        committedRangesDir: join(root, 'committed-ranges'),
        artifactPathsById,
      },
      {
        resolveGitHubToken,
        probeRepository: () => Promise.reject(new Error('unexpected probe')),
        probeCommit: () => Promise.reject(new Error('unexpected probe')),
        inspectRepositoryTree: () =>
          Promise.reject(new Error('unexpected probe')),
        cloneRepo: () => Promise.reject(new Error('unexpected clone')),
        fetchOrigin: () => Promise.reject(new Error('unexpected fetch')),
        prepareCommittedRange: () =>
          Promise.reject(new Error('unexpected committed range')),
        readOriginUrl: () => Promise.resolve(null),
        materializeRawCommit: (repoPath, sha, options) =>
          materializeGitCommitRaw(repoPath, sha, {
            ...options,
            resolveDestination: (relativePath) => join(repoPath, relativePath),
          }),
      },
    );

    expect(result).toEqual({ ok: true });
    expect(resolveGitHubToken).not.toHaveBeenCalled();
    await expect(
      readFile(join(root, 'repos', 'repo-1', 'src', 'tracked.ts'), 'utf8'),
    ).resolves.toBe('before\n');
  });

  it('resolves workspace-root scripts from the root manifest', async () => {
    mockedGetWorkspaceType.mockReturnValue('multi-repo');
    mockedResolveWorkspaceRepoScripts.mockResolvedValue({});
    mockedResolveWorkspaceRootScripts.mockResolvedValue({
      setup: {
        source: 'workspace-root',
        definition: { command: 'npm install' },
      },
    });

    const scripts = await defaultResolveRunScripts('workspace-1', {
      repoId: WORKSPACE_ROOT_REPO_ID,
      repoName: 'workspace root',
      repoPath: '/workspaces/workspace-1',
      relativePrefix: '',
    });

    expect(mockedResolveWorkspaceRootScripts).toHaveBeenCalledWith(
      'workspace-1',
      { workspaceRootPath: '/workspaces/workspace-1' },
    );
    expect(mockedResolveWorkspaceRepoScripts).not.toHaveBeenCalled();
    expect(scripts).toEqual({
      setup: {
        source: 'workspace-root',
        definition: { command: 'npm install' },
      },
    });
  });

  it('does not derive environment names through a repository-root symlink', async () => {
    const repoPath = await initializeRepository();
    const outsidePath = join(
      await mkdtemp(join(tmpdir(), 'shared-code-env-outside-')),
      'outside.env',
    );
    await writeFile(outsidePath, 'OUTSIDE_SECRET_NAME=must-not-read\n');
    await symlink(outsidePath, join(repoPath, '.env.example'));

    await expect(
      defaultReadRunEnvSample(repoPath, '.env.example'),
    ).resolves.toBeNull();
  });

  it('publishes every default-selected script, not just the lifecycle pair', async () => {
    const scripts = {
      setup: {
        source: 'repo-canopy',
        definition: { command: 'npm run prepare:dev' },
      },
      'Launch UD Mobile (Simulator)': {
        source: 'repo-canopy',
        definition: { command: 'bash apps/mobile/tool/run.sh ios simulator' },
      },
      'update-binaries': {
        source: 'repo-canopy',
        definition: { command: 'npm run update:binaries' },
      },
    };

    const run = await deriveSharedContainerRunConfig(
      'project-1',
      [
        {
          repoId: 'repo-1',
          repoName: 'repo',
          repoPath: '/repo',
          relativePrefix: '',
        },
      ],
      {
        includedPaths: [],
        runSharingEnabled: true,
        includedRunScripts: ['update-binaries', 'Launch UD Mobile (Simulator)'],
      },
      {
        resolveRunScripts: () => Promise.resolve(scripts),
        readRunEnvSample: () => Promise.resolve(null),
      },
    );

    // Legacy includedRunScripts is ignored. Defaults are lifecycle-first and
    // then alphabetical.
    expect(run?.commands.map((command) => command.name)).toEqual([
      'setup',
      'Launch UD Mobile (Simulator)',
      'update-binaries',
    ]);
  });

  it('shares the first eight ordered scripts by default and promotes exclusions', async () => {
    const scripts = Object.fromEntries(
      [
        'z-last',
        'setup',
        'launch',
        'teardown',
        'alpha',
        'bravo',
        'charlie',
        'delta',
        'echo',
      ].map((name) => [
        name,
        { source: 'repo-canopy', definition: { command: `npm run ${name}` } },
      ]),
    );

    const repositories = [
      {
        repoId: 'repo-1',
        repoName: 'repo',
        repoPath: '/repo',
        relativePrefix: '',
      },
    ];
    const deps = {
      resolveRunScripts: (): Promise<typeof scripts> =>
        Promise.resolve(scripts),
      readRunEnvSample: (): Promise<null> => Promise.resolve(null),
    };

    await expect(
      deriveSharedContainerRunConfig(
        'project-1',
        repositories,
        { includedPaths: [], excludedRunScripts: ['alpha'] },
        deps,
      ),
    ).resolves.toMatchObject({
      commands: [
        { name: 'setup' },
        { name: 'launch' },
        { name: 'teardown' },
        { name: 'bravo' },
        { name: 'charlie' },
        { name: 'delta' },
        { name: 'echo' },
        { name: 'z-last' },
      ],
    });

    await expect(
      deriveSharedContainerRunConfig(
        'project-1',
        repositories,
        { includedPaths: [], runSharingDisabled: true },
        deps,
      ),
    ).resolves.toBeUndefined();
  });

  it('lists every resolvable script as a publishable candidate', async () => {
    await expect(
      listSharedContainerRunScriptCandidates(
        'project-1',
        [
          {
            repoId: 'repo-1',
            repoName: 'repo',
            repoPath: '/repo',
            relativePrefix: '',
          },
        ],
        {
          resolveRunScripts: () =>
            Promise.resolve({
              'update-binaries': {
                source: 'repo-canopy',
                definition: { command: 'npm run update:binaries' },
              },
              launch: {
                source: 'repo-canopy',
                definition: { command: 'npm run dev' },
              },
              setup: {
                source: 'repo-canopy',
                definition: { command: 'npm run prepare:dev' },
              },
              // Cannot survive revision validation, so offering it would only
              // defer the failure to publish time.
              'bad\nname': {
                source: 'repo-canopy',
                definition: { command: 'echo hi' },
              },
            }),
        },
      ),
    ).resolves.toEqual(['setup', 'launch', 'update-binaries']);
  });

  it('derives env names without publishing sample values or managed names', async () => {
    const run = await deriveSharedContainerRunConfig(
      'project-1',
      [
        {
          repoId: 'repo-1',
          repoName: 'repo',
          repoPath: '/repo',
          relativePrefix: '',
        },
      ],
      {
        includedPaths: [],
        runSharingEnabled: true,
        includedRunScripts: ['setup'],
      },
      {
        resolveRunScripts: () =>
          Promise.resolve({
            setup: {
              source: 'repo-canopy',
              definition: {
                command: 'make setup API=$API_URL HOME=${HOME}',
              },
            },
          }),
        readRunEnvSample: (_repoPath, name) =>
          Promise.resolve(
            name === '.env.example'
              ? 'DATABASE_URL=postgres://real-secret\nACME_TOKEN=real-token\n'
              : null,
          ),
      },
    );

    expect(run).toEqual({
      commands: [
        {
          name: 'setup',
          command: 'make setup API=$API_URL HOME=${HOME}',
          repoId: 'repo-1',
        },
      ],
      requiredEnv: ['ACME_TOKEN', 'API_URL', 'DATABASE_URL'],
    });
    expect(JSON.stringify(run)).not.toContain('real-secret');
    expect(JSON.stringify(run)).not.toContain('real-token');
  });

  it('degrades to an empty env list for non-dotenv config samples', async () => {
    const repoPath = await initializeRepository();
    await writeFile(
      join(repoPath, 'config.example.yaml'),
      'database_url: postgres://must-not-be-inferred\n',
      'utf8',
    );
    const run = await deriveSharedContainerRunConfig(
      'project-1',
      [
        {
          repoId: 'repo-1',
          repoName: 'repo',
          repoPath,
          relativePrefix: '',
        },
      ],
      {
        includedPaths: [],
        runSharingEnabled: true,
        includedRunScripts: ['launch'],
      },
      {
        resolveRunScripts: () =>
          Promise.resolve({
            launch: {
              source: 'repo-canopy',
              definition: { command: 'go run ./cmd/api' },
            },
          }),
        readRunEnvSample: async (root, name) => {
          try {
            return await readFile(join(root, name), 'utf8');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
          }
        },
      },
    );

    expect(run?.requiredEnv).toEqual([]);
    expect(JSON.stringify(run)).not.toContain('must-not-be-inferred');
  });
  it('round-trips publisher output through the recipient using the canonical dirty-file fixture', async () => {
    const expected = buildSharedContainerDirtyFileFixture();
    const expectedRepo = expected.layout.repositories[0];
    const blobsById = new Map(
      expected.blobs.map((blob) => [blob.artifactId, blob]),
    );
    const inventory = {
      chats: [],
      attachments: [],
      notes: [],
      prompts: [],
      plans: [],
      repositories: [
        {
          repoId: expectedRepo.repoId,
          repoName: expectedRepo.repoName,
          repoPath: '/owner/path/must-not-publish',
          remoteUrl: expectedRepo.remoteUrl,
          owner: expectedRepo.owner,
          repository: expectedRepo.repository,
          baseCommitSha: expectedRepo.baseCommitSha,
          fingerprint: 'snapshot',
          approvedUntrackedPaths: [],
          files: [
            ...expectedRepo.files.map((file) => {
              const blob = file.artifactId
                ? blobsById.get(file.artifactId)
                : undefined;
              return {
                path: file.path,
                status: file.status,
                mode: file.mode,
                untracked: file.status === 'added',
                ...(blob
                  ? {
                      source: {
                        sizeBytes: blob.bytes.byteLength,
                        hash: `sha256:${createHash('sha256')
                          .update(blob.bytes)
                          .digest('hex')}`,
                        createReadStream: (): Readable =>
                          Readable.from(blob.bytes),
                      },
                    }
                  : {}),
              };
            }),
            {
              path: 'src/dangling-link',
              status: 'added' as const,
              mode: '120000',
              untracked: false,
              source: {
                sizeBytes: Buffer.byteLength('missing.ts'),
                hash: `sha256:${createHash('sha256')
                  .update('missing.ts')
                  .digest('hex')}`,
                createReadStream: (): Readable => Readable.from('missing.ts'),
              },
            },
          ],
        },
      ],
      withheldFileCount: 0,
      withheldFileReasons: [],
    } satisfies Awaited<ReturnType<typeof buildCodePublishInventory>>;
    const artifacts = buildCodeRevisionArtifacts(inventory, 'round-trip');
    const layoutArtifact = artifacts[artifacts.length - 1];
    expect(layoutArtifact?.path).toBe('container.json');
    const layoutValue: unknown = JSON.parse(
      layoutArtifact?.bytes?.toString('utf8') ?? '{}',
    );
    expect(isSharedContainerRevisionLayout(layoutValue)).toBe(true);
    if (!isSharedContainerRevisionLayout(layoutValue)) {
      throw new Error('Publisher emitted an invalid revision layout');
    }
    const layout = layoutValue;
    expect(layout.repositories[0].files).toEqual([
      ...expectedRepo.files.map((file) => ({
        path: file.path,
        status: file.status,
        mode: file.mode,
        ...(file.artifactId
          ? { artifactId: expect.any(String) as unknown as string }
          : {}),
      })),
      {
        path: 'src/dangling-link',
        status: 'added',
        mode: '120000',
        artifactId: expect.any(String) as unknown as string,
      },
    ]);
    const plaintextArtifacts = await Promise.all(
      artifacts.slice(0, -1).map(async (artifact) => {
        if (artifact.bytes) return { ...artifact, bytes: artifact.bytes };
        if (!artifact.source) throw new Error('Missing publisher source');
        const chunks: Buffer[] = [];
        for await (const candidate of artifact.source.createReadStream()) {
          const chunk: unknown = candidate;
          if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') {
            throw new Error('Publisher source emitted a non-byte chunk');
          }
          chunks.push(Buffer.from(chunk));
        }
        return { ...artifact, bytes: Buffer.concat(chunks) };
      }),
    );
    const fixture = await buildSharedContainerReplicaFixture({
      layout,
      plaintextArtifacts,
    });
    const root = await mkdtemp(join(tmpdir(), 'code-publish-roundtrip-'));
    const baseUsage = {
      fileCount: 2,
      allocationEntryCount: 3,
      totalBytes: BigInt(16),
    };
    const dependencies: MaterializeCodeDependencies = {
      resolveGitHubToken: () => Promise.resolve('recipient-token'),
      probeRepository: () => Promise.resolve(),
      probeCommit: () => Promise.resolve('b'.repeat(40)),
      inspectRepositoryTree: () => Promise.resolve(baseUsage),
      cloneRepo: async (_remoteUrl, destination) => {
        await mkdir(join(destination, '.git'), { recursive: true });
      },
      fetchOrigin: () => Promise.resolve(),
      materializeRawCommit: async (repoPath) => {
        await mkdir(join(repoPath, 'src'), { recursive: true });
        await writeFile(join(repoPath, 'src', 'modified.ts'), 'before\n');
        await writeFile(join(repoPath, 'src', 'deleted.ts'), 'delete me\n');
        return baseUsage;
      },
    };
    const manager = new SharedContainerReplicaManager({
      rootDir: root,
      transport: transportForSharedContainerFixture(fixture),
      fetchImpl: fetchForSharedContainerFixture(fixture),
      materializeCodeRevision: (
        options,
      ): ReturnType<typeof materializeCodeRevision> =>
        materializeCodeRevision(options, dependencies),
    });

    await manager.sync('container-1', 'org-1');

    const repoDir = join(
      root,
      'container-1',
      'revisions',
      'revision-1',
      'repos',
      'repo-1',
      'src',
    );
    await expect(readFile(join(repoDir, 'modified.ts'), 'utf8')).resolves.toBe(
      expected.blobs[0].bytes.toString('utf8'),
    );
    await expect(readFile(join(repoDir, 'added.ts'), 'utf8')).resolves.toBe(
      expected.blobs[1].bytes.toString('utf8'),
    );
    await expect(readlink(join(repoDir, 'dangling-link'))).resolves.toBe(
      'missing.ts',
    );
    await expect(
      readFile(join(repoDir, 'dangling-link'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(join(repoDir, 'deleted.ts'), 'utf8'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('publishes tracked changes and approved untracked bytes while withholding credentials', async () => {
    const repo = await initializeRepository();
    await writeFile(join(repo, 'src', 'tracked.ts'), 'after\n');
    await writeFile(join(repo, 'approved.txt'), 'approved\n');
    await writeFile(join(repo, '.env.local'), 'TOKEN=secret\n');
    const plan = {
      id: 'plan-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      source: 'agent',
      title: 'Plan',
      content: 'Read `/Users/owner/private.txt` then continue',
      reviewStatus: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      latestRevisionNumber: 3,
      revisions: [{ revisionNumber: 1 }],
      linkedExecutionIds: ['execution-1'],
      share: { serverId: 'server-secret' },
      commentThreads: [
        {
          id: 'thread-1',
          status: 'open',
          createdAt: '2026-01-01T00:00:00.000Z',
          anchor: { quote: 'Do not leak' },
          anchorState: 'matched',
          comments: [
            {
              id: 'comment-1',
              author: 'user',
              body: 'Keep this on the wire',
              createdAt: '2026-01-01T00:01:00.000Z',
              staged: true,
              submittedToChat: true,
            },
          ],
        },
      ],
    } as unknown as TrackedPlanData;
    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: ['approved.txt', '.env.local'] },
      },
      dependencies(repo, { listPlans: () => Promise.resolve([plan]) }),
    );

    expect(inventory.repositories[0].files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/tracked.ts', status: 'modified' }),
        expect.objectContaining({ path: 'approved.txt', status: 'added' }),
      ]),
    );
    expect(inventory.withheldFileCount).toBe(1);
    expect(inventory.withheldFileReasons).toEqual(['credential-shaped']);
    expect(inventory.plans[0]).not.toHaveProperty('projectId');
    expect(inventory.plans[0]).not.toHaveProperty('worktreeId');
    expect(inventory.plans[0]).not.toHaveProperty('revisions');
    expect(inventory.plans[0]).not.toHaveProperty('linkedExecutionIds');
    expect(inventory.plans[0]).not.toHaveProperty('share');
    expect(inventory.plans[0].content).toBe(
      'Read `[local path]` then continue',
    );
    expect(inventory.plans[0].content).not.toContain('/Users/owner');
    expect(inventory.plans[0].commentThreads[0]?.comments[0]).toEqual({
      id: 'comment-1',
      author: 'user',
      body: 'Keep this on the wire',
      createdAt: '2026-01-01T00:01:00.000Z',
    });
    expect(isSharedContainerPublishedPlan(inventory.plans[0])).toBe(true);

    const artifacts = buildCodeRevisionArtifacts(inventory, 'seed');
    expect(artifacts[artifacts.length - 1]?.path).toBe('container.json');
    const plaintext = artifacts
      .flatMap((artifact) =>
        artifact.bytes ? [artifact.bytes.toString()] : [],
      )
      .join('\n');
    expect(plaintext).not.toContain('.env.local');
    expect(plaintext).not.toContain('/Users/owner');
    const layout = JSON.parse(
      artifacts[artifacts.length - 1].bytes?.toString('utf8') ?? '{}',
    ) as { withheldFileCount?: number };
    expect(layout.withheldFileCount).toBe(1);
  });

  it('publishes untracked files by default and honors exclusions', async () => {
    const repo = await initializeRepository();
    await writeFile(join(repo, 'included.txt'), 'included\n');
    await writeFile(join(repo, 'excluded.txt'), 'excluded\n');

    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: {
          includedPaths: [],
          excludedPaths: ['excluded.txt'],
        },
      },
      dependencies(repo),
    );

    expect(inventory.repositories[0].files).toContainEqual(
      expect.objectContaining({ path: 'included.txt', untracked: true }),
    );
    expect(inventory.repositories[0].files).not.toContainEqual(
      expect.objectContaining({ path: 'excluded.txt' }),
    );
  });

  it('publishes only start pages present in the final code inventory', async () => {
    const repo = await initializeRepository();
    await writeFile(join(repo, 'excluded.txt'), 'excluded\n');

    const included = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: [], excludedPaths: ['excluded.txt'] },
      },
      dependencies(repo, {
        resolveStartPage: () =>
          Promise.resolve({
            startPage: {
              kind: 'file',
              repoId: 'repo-1',
              path: 'src/tracked.ts',
            },
            source: 'source',
          }),
      }),
    );
    expect(included.startPage).toEqual({
      kind: 'file',
      repoId: 'repo-1',
      relativePath: 'src/tracked.ts',
    });

    const withheld = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: [], excludedPaths: ['excluded.txt'] },
      },
      dependencies(repo, {
        resolveStartPage: () =>
          Promise.resolve({
            startPage: { kind: 'file', repoId: 'repo-1', path: 'excluded.txt' },
            source: 'local',
          }),
      }),
    );
    expect(withheld.startPage).toBeUndefined();

    const url = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: [] },
      },
      dependencies(repo, {
        resolveStartPage: () =>
          Promise.resolve({
            startPage: { kind: 'url', url: 'https://example.test/docs' },
            source: 'local',
          }),
      }),
    );
    expect(url.startPage).toEqual({
      kind: 'url',
      url: 'https://example.test/docs',
    });
  });

  it('reserves serialized chat bytes before admitting optional files', async () => {
    const chat: PersistedChatTab = {
      id: 'chat-1',
      title: 'Large chat',
      kind: 'chat',
      createdAt: '2026-09-27T00:00:00.000Z',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          timestamp: '2026-09-27T00:00:00.000Z',
          blocks: [{ type: 'text', text: 'x'.repeat(4_096) }],
        },
      ],
    };

    const measuredBytes = await measureCodeRevisionBaseBytes(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: [] },
      },
      {
        readChatTabs: () =>
          Promise.resolve({
            version: 1,
            activeTabId: chat.id,
            tabs: [chat],
          }),
        listAttachmentFiles: () => Promise.resolve([]),
        listPlans: () => Promise.resolve([]),
        listNotes: () => Promise.resolve([]),
        listPrompts: () => Promise.resolve([]),
        readWorkspaceItem: () =>
          Promise.reject(new Error('unexpected workspace-item read')),
      },
    );

    expect(measuredBytes).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify(chat)),
    );
  });

  it('caps default untracked publication after non-droppable content', async () => {
    const repo = await initializeRepository();
    await writeFile(join(repo, 'a.txt'), 'a\n');
    await writeFile(join(repo, 'b.txt'), 'b\n');

    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: [] },
      },
      dependencies(repo, {
        readChatTabs: () =>
          Promise.resolve({
            version: 1,
            activeTabId: 'chat-0',
            tabs: Array.from({ length: 198 }, (_unused, index) => ({
              id: `chat-${index}`,
              title: `Chat ${index}`,
              createdAt: '2026-01-01T00:00:00.000Z',
              messages: [],
            })),
          }),
      }),
    );

    expect(
      inventory.repositories[0].files.filter((file) => file.untracked),
    ).toHaveLength(1);
    expect(inventory.repositories[0].approvedUntrackedPaths).toHaveLength(1);
  });

  it('caps default untracked publication after selected workspace-item bytes', async () => {
    const repo = await initializeRepository();
    await writeFile(join(repo, 'optional.txt'), 'ok');
    const note = {
      id: 'note-1',
      title: 'Large note',
      absolutePath: join(repo, 'note-1.md'),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      origin: {
        worktreeId: 'worktree-1',
        branchName: 'main',
        worktreeExists: true,
      },
    } as WorkspaceNoteItem;

    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: [] },
      },
      dependencies(repo, {
        listNotes: () => Promise.resolve([note]),
        readWorkspaceItem: (item, _kind, reserveInspectionBytes) => {
          reserveInspectionBytes(
            BigInt(MAX_SHARED_CONTAINER_REVISION_BYTES - 1),
          );
          return Promise.resolve({
            meta: item,
            content: 'note',
            sourceSizeBytes: BigInt(MAX_SHARED_CONTAINER_REVISION_BYTES - 1),
          });
        },
      }),
    );

    expect(inventory.notes).toHaveLength(1);
    expect(
      inventory.repositories[0].files.filter((file) => file.untracked),
    ).toEqual([]);
    expect(inventory.repositories[0].approvedUntrackedPaths).toEqual([]);
  });

  it('publishes conflict-marker bytes from an unmerged working-tree file', async () => {
    const repo = await initializeRepository();
    const originalBranch = (
      await execFileAsync('git', ['branch', '--show-current'], { cwd: repo })
    ).stdout.trim();
    await execFileAsync('git', ['switch', '-c', 'conflicting-change'], {
      cwd: repo,
    });
    await writeFile(join(repo, 'src', 'tracked.ts'), 'from side\n');
    await execFileAsync('git', ['commit', '-am', 'side change'], { cwd: repo });
    await execFileAsync('git', ['switch', originalBranch], { cwd: repo });
    await writeFile(join(repo, 'src', 'tracked.ts'), 'from owner\n');
    await execFileAsync('git', ['commit', '-am', 'owner change'], {
      cwd: repo,
    });
    await expect(
      execFileAsync('git', ['merge', 'conflicting-change'], { cwd: repo }),
    ).rejects.toBeDefined();

    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: [] },
      },
      dependencies(repo),
    );

    const conflict = inventory.repositories[0].files.find(
      (file) => file.path === 'src/tracked.ts',
    );
    expect(conflict).toMatchObject({ status: 'modified', mode: '100644' });
    if (!conflict?.source) throw new Error('Missing conflicted file source');
    const chunks: Buffer[] = [];
    for await (const candidate of conflict.source.createReadStream()) {
      const chunk: unknown = candidate;
      if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') {
        throw new Error('Publisher source emitted a non-byte chunk');
      }
      chunks.push(Buffer.from(chunk));
    }
    const content = Buffer.concat(chunks).toString('utf8');
    expect(content).toContain('<<<<<<<');
    expect(content).toContain('from owner');
    expect(content).toContain('from side');
  });

  it('publishes notes and prompts by default and honors owner exclusions', async () => {
    const repo = await initializeRepository();
    const timestamp = '2026-01-01T00:00:00.000Z';
    const selectedNote = {
      id: 'selected-note',
      title: 'Selected note',
      absolutePath: '/owner/notes/selected-note.md',
      createdAt: timestamp,
      updatedAt: timestamp,
      origin: {
        worktreeId: 'worktree-1',
        branchName: 'main',
        worktreeExists: true,
      },
    };
    const otherNote = {
      ...selectedNote,
      id: 'other-note',
      title: 'Other note',
      absolutePath: '/owner/notes/other-note.md',
    };
    const selectedPrompt = {
      ...selectedNote,
      id: 'selected-prompt',
      title: 'Selected prompt',
      absolutePath: '/owner/prompts/selected-prompt.md',
    };

    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: {
          includedPaths: [],
          excludedNoteIds: [otherNote.id],
        },
      },
      dependencies(repo, {
        listNotes: () => Promise.resolve([selectedNote, otherNote]),
        listPrompts: () => Promise.resolve([selectedPrompt]),
        readWorkspaceItem: (item, kind) =>
          Promise.resolve({
            meta: item,
            content: `${kind}:${item.id}`,
            sourceSizeBytes: BigInt(`${kind}:${item.id}`.length),
          }),
      }),
    );

    expect(inventory.notes).toEqual([
      expect.objectContaining({ content: 'note:selected-note' }),
    ]);
    expect(inventory.prompts).toEqual([
      expect.objectContaining({ content: 'prompt:selected-prompt' }),
    ]);
    const artifactPaths = buildCodeRevisionArtifacts(inventory, 'scope').map(
      (artifact) => artifact.path,
    );
    expect(artifactPaths).toContain('notes/selected-note.md');
    expect(artifactPaths).toContain('prompts/selected-prompt.md');
    expect(artifactPaths).not.toContain('notes/other-note.md');
  });

  it('rejects an oversized selected project item before reading its content', async () => {
    const repo = await initializeRepository();
    const notePath = join(repo, 'oversized-note.md');
    await writeFile(notePath, '');
    await truncate(notePath, MAX_SHARED_CONTAINER_ARTIFACT_BYTES + 1);
    const note = {
      id: 'oversized-note',
      title: 'Oversized note',
      absolutePath: notePath,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      origin: {
        worktreeId: 'worktree-1',
        branchName: 'main',
        worktreeExists: true,
      },
    };
    await expect(
      buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [], includedNoteIds: [note.id] },
        },
        dependencies(repo, {
          listNotes: () => Promise.resolve([note]),
          readWorkspaceItem: readCodeWorkspaceItemForPublication,
        }),
      ),
    ).rejects.toMatchObject<SharedContainerPublishRefusalError>({
      reason: 'artifact-budget',
    });
  });

  it('rejects a project item whose redacted content exceeds the artifact budget', async () => {
    const repo = await initializeRepository();
    const notePath = join(repo, 'expanding-note.md');
    const expandingContent = '/\n'.repeat(
      Math.floor(MAX_SHARED_CONTAINER_ARTIFACT_BYTES / 13) + 1,
    );
    await writeFile(notePath, expandingContent);
    const note: WorkspaceNoteItem = {
      id: 'expanding-note',
      title: 'Expanding note',
      absolutePath: notePath,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      origin: {
        worktreeId: 'worktree-1',
        branchName: 'main',
        worktreeExists: true,
      },
    };

    await expect(
      buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [], includedNoteIds: [note.id] },
        },
        dependencies(repo, {
          listNotes: () => Promise.resolve([note]),
          readWorkspaceItem: readCodeWorkspaceItemForPublication,
        }),
      ),
    ).rejects.toMatchObject<SharedContainerPublishRefusalError>({
      reason: 'artifact-budget',
    });
  });

  it('shares one pre-read byte budget across notes, prompts, and repository files', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-code-item-budget-'));
    await writeFile(join(repo, 'changed.bin'), 'x');
    const row: RawDiffEntry = {
      path: 'changed.bin',
      status: 'A',
      srcMode: '000000',
      dstMode: '100644',
    };
    const itemsPerKind = Math.floor(
      MAX_SHARED_CONTAINER_REVISION_BYTES /
        MAX_SHARED_CONTAINER_ARTIFACT_BYTES /
        2,
    );
    const item = (
      kind: 'note' | 'prompt',
      index: number,
    ): WorkspaceNoteItem => ({
      id: `${kind}-${index}`,
      title: `${kind} ${index}`,
      absolutePath: `/${kind}s/${index}.md`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      origin: {
        worktreeId: 'worktree-1',
        branchName: 'main',
        worktreeExists: true,
      },
    });
    const notes = Array.from({ length: itemsPerKind }, (_, index) =>
      item('note', index),
    );
    const prompts = Array.from({ length: itemsPerKind }, (_, index) =>
      item('prompt', index),
    );
    const createFileSource = jest.fn(createStableFileSource);

    await expect(
      buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: {
            includedPaths: [],
            includedNoteIds: notes.map(({ id }) => id),
            includedPromptIds: prompts.map(({ id }) => id),
          },
        },
        dependencies(repo, {
          createFileSource,
          getHead: () => Promise.resolve('a'.repeat(40)),
          listDiff: () => Promise.resolve([row]),
          listUntracked: () => Promise.resolve([]),
          listNotes: () => Promise.resolve(notes),
          listPrompts: () => Promise.resolve(prompts),
          readWorkspaceItem: (
            workspaceItem,
            _kind,
            reserveBytes,
          ): Promise<{
            meta: typeof workspaceItem;
            content: string;
            sourceSizeBytes: bigint;
          }> => {
            reserveBytes(BigInt(MAX_SHARED_CONTAINER_ARTIFACT_BYTES));
            return Promise.resolve({
              meta: workspaceItem,
              content: workspaceItem.id,
              sourceSizeBytes: BigInt(MAX_SHARED_CONTAINER_ARTIFACT_BYTES),
            });
          },
          usesLfs: () => Promise.resolve(false),
          inspectTreeEntries: () => Promise.resolve([]),
        }),
      ),
    ).rejects.toMatchObject<SharedContainerPublishRefusalError>({
      reason: 'artifact-budget',
    });
    expect(createFileSource).not.toHaveBeenCalled();
  });

  it('withholds a credential-shaped tracked change instead of publishing its bytes', async () => {
    const repo = await initializeRepository();
    await writeFile(join(repo, '.env.example'), 'ACME_TOKEN=committed\n');
    await execFileAsync('git', ['add', '.env.example'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'credential fixture'], {
      cwd: repo,
    });
    await writeFile(join(repo, '.env.example'), 'ACME_TOKEN=changed-secret\n');

    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: {
          includedPaths: [],
          runSharingEnabled: true,
          includedRunScripts: ['launch'],
        },
        runEnabled: true,
      },
      dependencies(repo, {
        resolveRunScripts: () =>
          Promise.resolve({
            launch: {
              source: 'repo-canopy',
              definition: { command: 'make dev' },
            },
          }),
        readRunEnvSample: (repoPath, name) =>
          name === '.env.example'
            ? readFile(join(repoPath, name), 'utf8')
            : Promise.resolve(null),
      }),
    );

    expect(inventory.repositories[0].files).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '.env.example' }),
      ]),
    );
    expect(inventory.withheldFileCount).toBe(1);
    expect(inventory.withheldFileReasons).toEqual(['credential-shaped']);
    expect(inventory.run?.requiredEnv).toEqual(['ACME_TOKEN']);
    const plaintext = buildCodeRevisionArtifacts(inventory, 'seed')
      .flatMap((artifact) =>
        artifact.bytes ? [artifact.bytes.toString('utf8')] : [],
      )
      .join('\n');
    expect(plaintext).not.toContain('.env.example');
    expect(plaintext).not.toContain('changed-secret');
  });

  it('omits run config when the emission flag is off despite stored opt-in', async () => {
    const repo = await initializeRepository();
    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: {
          includedPaths: [],
          runSharingEnabled: true,
          includedRunScripts: ['launch'],
        },
        runEnabled: false,
      },
      dependencies(repo, {
        resolveRunScripts: () =>
          Promise.resolve({
            launch: {
              source: 'repo-canopy',
              definition: { command: 'make dev' },
            },
          }),
      }),
    );

    expect(inventory.run).toBeUndefined();
  });

  it('refuses to publish a command matching the safety deny set', async () => {
    const run = await deriveSharedContainerRunConfig(
      'project-1',
      [
        {
          repoId: 'repo-1',
          repoName: 'repo',
          repoPath: '/repo',
          relativePrefix: '',
        },
      ],
      {
        includedPaths: [],
        runSharingEnabled: true,
        includedRunScripts: ['setup'],
      },
      {
        resolveRunScripts: () =>
          Promise.resolve({
            setup: {
              source: 'repo-canopy',
              definition: { command: 'rm -rf /' },
            },
          }),
        readRunEnvSample: () => Promise.resolve(null),
      },
    );

    expect(run?.commands).toEqual([]);
  });

  it('withholds an approved untracked hardlink without turning the snapshot into an infinite retry', async () => {
    const repo = await initializeRepository();
    await writeFile(join(repo, 'hardlink-source.txt'), 'shared inode\n');
    await link(
      join(repo, 'hardlink-source.txt'),
      join(repo, 'hardlink-approved.txt'),
    );

    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: ['hardlink-approved.txt'] },
      },
      dependencies(repo),
    );
    expect(inventory.withheldFileCount).toBe(2);
    expect(inventory.withheldFileReasons).toEqual(['credential-shaped']);
    expect(inventory.repositories[0]?.files).not.toContainEqual(
      expect.objectContaining({ path: 'hardlink-approved.txt' }),
    );
  });

  it('withholds a tracked file replaced by a hardlink to external content', async () => {
    const repo = await initializeRepository();
    const externalSecret = `${repo}-external-secret.txt`;
    const trackedPath = join(repo, 'src', 'tracked.ts');
    await writeFile(externalSecret, 'external secret\n');
    await rm(trackedPath);
    await link(externalSecret, trackedPath);

    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: [] },
      },
      dependencies(repo),
    );

    expect(inventory.withheldFileCount).toBe(1);
    expect(inventory.withheldFileReasons).toEqual(['credential-shaped']);
    expect(inventory.repositories[0]?.files).not.toContainEqual(
      expect.objectContaining({ path: 'src/tracked.ts' }),
    );
  });

  it('withholds tracked hardlinks before applying the materialized-file ceiling', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-code-hardlink-limit-'));
    const source = join(repo, 'shared-source.txt');
    await writeFile(source, 'shared inode\n');
    const rows: RawDiffEntry[] = Array.from(
      { length: MAX_SHARED_CONTAINER_MATERIALIZED_FILES + 1 },
      (_, index) => ({
        path: `hardlink-${index}.txt`,
        status: 'A',
        srcMode: '000000',
        dstMode: '100644',
      }),
    );
    await Promise.all(rows.map((row) => link(source, join(repo, row.path))));

    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: [] },
      },
      dependencies(repo, {
        getHead: () => Promise.resolve('a'.repeat(40)),
        listDiff: () => Promise.resolve(rows),
        listUntracked: () => Promise.resolve([]),
        usesLfs: () => Promise.resolve(false),
        inspectTreeEntries: () => Promise.resolve([]),
      }),
    );

    expect(inventory.repositories[0]?.files).toEqual([]);
    expect(inventory.withheldFileCount).toBe(rows.length);
    expect(inventory.withheldFileReasons).toEqual(['credential-shaped']);
  });

  it('publishes a mode-only tracked change with its destination mode', async () => {
    const repo = await initializeRepository();
    await execFileAsync('chmod', ['+x', 'src/tracked.ts'], { cwd: repo });

    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: [] },
      },
      dependencies(repo),
    );

    expect(inventory.repositories[0]?.files).toContainEqual(
      expect.objectContaining({
        path: 'src/tracked.ts',
        status: 'modified',
        mode: '100755',
      }),
    );
  });

  it('rejects a tracked path redirected through a symlinked parent directory', async () => {
    const repo = await initializeRepository();
    const outside = await mkdtemp(join(tmpdir(), 'shared-code-outside-'));
    try {
      await writeFile(join(outside, 'tracked.ts'), 'external bytes\n');
      await rm(join(repo, 'src'), { recursive: true, force: true });
      await symlink(outside, join(repo, 'src'), 'dir');

      await expect(
        buildCodePublishInventory(
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            scope: { includedPaths: [] },
          },
          dependencies(repo),
        ),
      ).rejects.toBeInstanceOf(SharedContainerPublishInventoryChangedError);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('publishes a base commit containing an in-repository symlink', async () => {
    const repo = await initializeRepository();
    try {
      await symlink('src/tracked.ts', join(repo, 'tracked-link'));
      await execFileAsync('git', ['add', 'tracked-link'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'add symlink'], {
        cwd: repo,
      });

      await expect(
        buildCodePublishInventory(
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            scope: { includedPaths: [] },
          },
          dependencies(repo),
        ),
      ).resolves.toMatchObject({
        withheldFileCount: 0,
        withheldFileReasons: [],
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('withholds an escaping symlink from the base commit', async () => {
    const repo = await initializeRepository();
    try {
      await symlink('../outside', join(repo, 'escaping-link'));
      await execFileAsync('git', ['add', 'escaping-link'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'add escaping symlink'], {
        cwd: repo,
      });

      await expect(
        buildCodePublishInventory(
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            scope: { includedPaths: [] },
          },
          dependencies(repo),
        ),
      ).resolves.toMatchObject({
        withheldFileCount: 1,
        withheldFileReasons: ['symlink-escaping'],
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('publishes a safe replacement for a symlink withheld from a snapshot base', async () => {
    const repo = await initializeRepository();
    let snapshot: SharedContainerCodeSnapshot | undefined;
    try {
      await symlink('../outside', join(repo, 'escaping-link'));
      await execFileAsync('git', ['add', 'escaping-link'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'add escaping symlink'], {
        cwd: repo,
      });
      await rm(join(repo, 'escaping-link'));
      await writeFile(join(repo, 'escaping-link'), 'safe replacement\n');

      const inventory = await buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo, {
          getRemoteUrl: () => Promise.resolve(null),
          resolvePushedBase: () => Promise.resolve(null),
          buildSnapshot: buildSharedContainerCodeSnapshot,
        }),
      );
      snapshot = inventory.repositories[0]?.snapshot;

      expect(inventory.repositories[0]?.files).toEqual([
        expect.objectContaining({ path: 'escaping-link', status: 'added' }),
      ]);
    } finally {
      if (snapshot) await disposeSnapshot(snapshot);
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('omits deletion of a symlink already withheld from a snapshot base', async () => {
    const repo = await initializeRepository();
    let snapshot: SharedContainerCodeSnapshot | undefined;
    try {
      await symlink('../outside', join(repo, 'escaping-link'));
      await execFileAsync('git', ['add', 'escaping-link'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'add escaping symlink'], {
        cwd: repo,
      });
      await rm(join(repo, 'escaping-link'));

      const inventory = await buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo, {
          getRemoteUrl: () => Promise.resolve(null),
          resolvePushedBase: () => Promise.resolve(null),
          buildSnapshot: buildSharedContainerCodeSnapshot,
        }),
      );
      snapshot = inventory.repositories[0]?.snapshot;

      expect(inventory.repositories[0]?.files).toEqual([]);
    } finally {
      if (snapshot) await disposeSnapshot(snapshot);
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('withholds an oversized in-repository symlink from the base commit', async () => {
    const repo = await initializeRepository();
    const oversizedTarget = `${'nested/'.repeat(10_000)}target.ts`;
    try {
      await expect(
        buildCodePublishInventory(
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            scope: { includedPaths: [] },
          },
          dependencies(repo, {
            inspectTreeEntries: () =>
              Promise.resolve([
                {
                  mode: '120000',
                  type: 'blob',
                  objectId: 'a'.repeat(40),
                  path: 'oversized-link',
                  symlinkTarget: oversizedTarget,
                  symlinkEscapesRepository: false,
                },
              ]),
          }),
        ),
      ).resolves.toMatchObject({
        repositories: [{ files: [] }],
        withheldFileCount: 1,
        withheldFileReasons: ['oversized'],
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('withholds a committed symlink target larger than the Git inspection buffer', async () => {
    const repo = await initializeRepository();
    const targetPath = join(repo, 'oversized-target');
    try {
      await writeFile(targetPath, Buffer.alloc(64 * 1024 * 1024 + 1, 0x61));
      const { stdout: blobSha } = await execFileAsync(
        'git',
        ['hash-object', '-w', 'oversized-target'],
        { cwd: repo },
      );
      await rm(targetPath);
      await execFileAsync(
        'git',
        [
          'update-index',
          '--add',
          '--cacheinfo',
          '120000',
          blobSha.trim(),
          'oversized-link',
        ],
        { cwd: repo },
      );
      await execFileAsync('git', ['commit', '-m', 'add oversized symlink'], {
        cwd: repo,
      });
      await execFileAsync(
        'git',
        ['update-index', '--skip-worktree', 'oversized-link'],
        { cwd: repo },
      );

      await expect(
        buildCodePublishInventory(
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            scope: { includedPaths: [] },
          },
          dependencies(repo),
        ),
      ).resolves.toMatchObject({
        repositories: [{ files: [] }],
        withheldFileCount: 1,
        withheldFileReasons: ['oversized'],
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  it('counts a changed escaping base symlink only once', async () => {
    const repo = await initializeRepository();
    try {
      await symlink('../outside', join(repo, 'escaping-link'));
      await execFileAsync('git', ['add', 'escaping-link'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'add escaping symlink'], {
        cwd: repo,
      });
      await rm(join(repo, 'escaping-link'));
      await symlink('../../other-outside', join(repo, 'escaping-link'));

      await expect(
        buildCodePublishInventory(
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            scope: { includedPaths: [] },
          },
          dependencies(repo),
        ),
      ).resolves.toMatchObject({
        repositories: [{ files: [] }],
        withheldFileCount: 1,
        withheldFileReasons: ['symlink-escaping'],
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('publishes an in-repository working-tree symlink as an overlay', async () => {
    const repo = await initializeRepository();
    try {
      await symlink('src/tracked.ts', join(repo, 'tracked-link'));
      await execFileAsync('git', ['add', 'tracked-link'], { cwd: repo });

      const inventory = await buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo),
      );
      const file = inventory.repositories[0]?.files.find(
        (candidate) => candidate.path === 'tracked-link',
      );
      expect(file).toMatchObject({ status: 'added', mode: '120000' });
      const chunks: Buffer[] = [];
      for await (const value of file?.source?.createReadStream() ?? []) {
        const chunk: unknown = value;
        if (!Buffer.isBuffer(chunk)) throw new Error('Expected binary chunk');
        chunks.push(chunk);
      }
      expect(Buffer.concat(chunks).toString('utf8')).toBe('src/tracked.ts');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('publishes an approved untracked in-repository symlink as an overlay', async () => {
    const repo = await initializeRepository();
    try {
      await symlink('src/tracked.ts', join(repo, 'approved-link'));

      const inventory = await buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: ['approved-link'] },
        },
        dependencies(repo),
      );
      const file = inventory.repositories[0]?.files.find(
        (candidate) => candidate.path === 'approved-link',
      );

      expect(file).toMatchObject({
        status: 'added',
        mode: '120000',
        untracked: true,
      });
      const chunks: Buffer[] = [];
      for await (const value of file?.source?.createReadStream() ?? []) {
        const chunk: unknown = value;
        if (!Buffer.isBuffer(chunk)) throw new Error('Expected binary chunk');
        chunks.push(chunk);
      }
      expect(Buffer.concat(chunks).toString('utf8')).toBe('src/tracked.ts');
      expect(inventory.withheldFileCount).toBe(0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('publishes an approved symlink replacing a tracked directory with descendant deletions', async () => {
    const repo = await initializeRepository();
    try {
      await rm(join(repo, 'src'), { recursive: true, force: true });
      await symlink('target.ts', join(repo, 'src'));

      const inventory = await buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: ['src'] },
        },
        dependencies(repo),
      );

      expect(inventory.repositories[0]?.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'src/tracked.ts',
            status: 'deleted',
          }),
          expect.objectContaining({
            path: 'src',
            status: 'added',
            mode: '120000',
            untracked: true,
          }),
        ]),
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('publishes an approved file beneath a deleted tracked symlink', async () => {
    const repo = await initializeRepository();
    try {
      await rm(join(repo, 'src'), { recursive: true, force: true });
      await symlink('target.ts', join(repo, 'src'));
      await execFileAsync('git', ['add', '--all'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'replace directory'], {
        cwd: repo,
      });
      await rm(join(repo, 'src'));
      await mkdir(join(repo, 'src'));
      await writeFile(join(repo, 'src', 'replacement.ts'), 'replacement\n');

      const inventory = await buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: ['src/replacement.ts'] },
        },
        dependencies(repo),
      );

      expect(inventory.repositories[0]?.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'src',
            status: 'deleted',
            mode: '120000',
          }),
          expect.objectContaining({
            path: 'src/replacement.ts',
            status: 'added',
            mode: '100644',
            untracked: true,
          }),
        ]),
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('withholds an approved untracked escaping symlink with the symlink reason', async () => {
    const repo = await initializeRepository();
    try {
      await symlink('../outside', join(repo, 'approved-escaping-link'));

      await expect(
        buildCodePublishInventory(
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            scope: { includedPaths: ['approved-escaping-link'] },
          },
          dependencies(repo),
        ),
      ).resolves.toMatchObject({
        repositories: [{ files: [] }],
        withheldFileCount: 1,
        withheldFileReasons: ['symlink-escaping'],
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('withholds an escaping working-tree symlink overlay', async () => {
    const repo = await initializeRepository();
    try {
      await symlink('../outside', join(repo, 'escaping-link'));
      await execFileAsync('git', ['add', 'escaping-link'], { cwd: repo });

      await expect(
        buildCodePublishInventory(
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            scope: { includedPaths: [] },
          },
          dependencies(repo),
        ),
      ).resolves.toMatchObject({
        repositories: [{ files: [] }],
        withheldFileCount: 1,
        withheldFileReasons: ['symlink-escaping'],
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  // The recipient rebuilds a symlink from the published bytes and rejects any
  // target that decodes with replacement characters. `readlink` decodes
  // lossily, so without a publisher guard this publishes cleanly and then
  // fails materialization on the other side.
  it('refuses a working-tree symlink whose target is not valid UTF-8', async () => {
    const repo = await initializeRepository();
    try {
      await symlink(
        Buffer.from([0x2e, 0x2f, 0xff]),
        join(repo, 'invalid-link'),
      );
      await execFileAsync('git', ['add', 'invalid-link'], { cwd: repo });

      await expect(
        buildCodePublishInventory(
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            scope: { includedPaths: [] },
          },
          dependencies(repo),
        ),
      ).rejects.toThrow('non-UTF-8 symlink target');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('publishes a working-tree symlink whose valid UTF-8 target contains U+FFFD', async () => {
    const repo = await initializeRepository();
    try {
      await symlink('src/\uFFFD.ts', join(repo, 'replacement-character-link'));
      await execFileAsync('git', ['add', 'replacement-character-link'], {
        cwd: repo,
      });

      const inventory = await buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo),
      );

      expect(inventory.repositories[0]?.files).toContainEqual(
        expect.objectContaining({
          path: 'replacement-character-link',
          mode: '120000',
        }),
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects case-colliding repository paths before opening their bytes', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-code-collision-'));
    await writeFile(join(repo, 'README.md'), 'upper\n');
    await writeFile(join(repo, 'readme.md'), 'lower\n');
    const rows: RawDiffEntry[] = [
      {
        path: 'README.md',
        status: 'A',
        srcMode: '000000',
        dstMode: '100644',
      },
      {
        path: 'readme.md',
        status: 'A',
        srcMode: '000000',
        dstMode: '100644',
      },
    ];

    await expect(
      buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo, {
          getHead: () => Promise.resolve('a'.repeat(40)),
          listDiff: () => Promise.resolve(rows),
          listUntracked: () => Promise.resolve([]),
          usesLfs: () => Promise.resolve(false),
          inspectTreeEntries: () => Promise.resolve([]),
        }),
      ),
    ).rejects.toThrow('output path collision');
  });

  it('deduplicates identical overlays before applying the artifact budget', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-code-budget-'));
    const rows: RawDiffEntry[] = Array.from({ length: 200 }, (_, index) => ({
      path: `file-${index}.txt`,
      status: 'A',
      srcMode: '000000',
      dstMode: '100644',
    }));
    await Promise.all(
      rows.map((row) => writeFile(join(repo, row.path), 'small')),
    );
    const getHead = jest.fn(() => Promise.resolve('a'.repeat(40)));

    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: [] },
      },
      dependencies(repo, {
        getHead,
        listDiff: () => Promise.resolve(rows),
        listUntracked: () => Promise.resolve([]),
        usesLfs: () => Promise.resolve(false),
        inspectTreeEntries: () => Promise.resolve([]),
      }),
    );

    expect(inventory.repositories[0]?.files).toHaveLength(rows.length);
    expect(buildCodeRevisionArtifacts(inventory, 'deduplicated')).toHaveLength(
      2,
    );
    expect(getHead).toHaveBeenCalledTimes(2);
  });

  it('bounds simultaneous changed-file source inspections', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-code-concurrency-'));
    const rows: RawDiffEntry[] = Array.from({ length: 12 }, (_, index) => ({
      path: `file-${index}.txt`,
      status: 'A',
      srcMode: '000000',
      dstMode: '100644',
    }));
    await Promise.all(
      rows.map((row) => writeFile(join(repo, row.path), `file:${row.path}`)),
    );
    let activeInspections = 0;
    let maximumActiveInspections = 0;
    const inspectFileSource = jest.fn(
      async (...args: Parameters<typeof createStableFileSource>) => {
        activeInspections += 1;
        maximumActiveInspections = Math.max(
          maximumActiveInspections,
          activeInspections,
        );
        try {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return await createStableFileSource(...args);
        } finally {
          activeInspections -= 1;
        }
      },
    );

    await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: [] },
      },
      dependencies(repo, {
        createFileSource: inspectFileSource,
        getHead: () => Promise.resolve('a'.repeat(40)),
        listDiff: () => Promise.resolve(rows),
        listUntracked: () => Promise.resolve([]),
        usesLfs: () => Promise.resolve(false),
        inspectTreeEntries: () => Promise.resolve([]),
      }),
    );

    expect(inspectFileSource).toHaveBeenCalledTimes(rows.length);
    expect(maximumActiveInspections).toBeLessThanOrEqual(4);
  });

  it('rejects inventories that exceed the materialized-file ceiling before artifact construction', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-code-projection-limit-'));
    await writeFile(join(repo, 'changed.txt'), 'changed');
    const row: RawDiffEntry = {
      path: 'changed.txt',
      status: 'A',
      srcMode: '000000',
      dstMode: '100644',
    };
    const chats: PersistedChatTab[] = Array.from(
      { length: MAX_SHARED_CONTAINER_MATERIALIZED_FILES },
      (_, index) => ({
        id: `chat-${index}`,
        title: `Chat ${index}`,
        kind: 'chat',
        createdAt: '2026-09-01T00:00:00.000Z',
        messages: [],
      }),
    );
    const createFileSource = jest.fn(createStableFileSource);
    const listAttachmentFiles = jest.fn(() => Promise.resolve([]));
    const openAttachmentFile = jest.fn(() =>
      Promise.reject(new Error('unexpected attachment open')),
    );

    await expect(
      buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo, {
          readChatTabs: () =>
            Promise.resolve({
              version: 1,
              tabs: chats,
              activeTabId: chats[0]?.id ?? '',
            }),
          getHead: () => Promise.resolve('a'.repeat(40)),
          listDiff: () => Promise.resolve([row]),
          listUntracked: () => Promise.resolve([]),
          createFileSource,
          listAttachmentFiles,
          openAttachmentFile,
          usesLfs: () => Promise.resolve(false),
          inspectTreeEntries: () => Promise.resolve([]),
        }),
      ),
    ).rejects.toMatchObject<SharedContainerPublishRefusalError>({
      reason: 'artifact-budget',
    });
    expect(createFileSource).not.toHaveBeenCalled();
    expect(listAttachmentFiles).toHaveBeenCalledTimes(1);
    expect(openAttachmentFile).not.toHaveBeenCalled();
  });

  it('classifies an oversized snapshot tree as an artifact-budget refusal', async () => {
    const repo = await initializeRepository();
    const disposeSnapshotSource = jest.fn(() => Promise.resolve());

    await expect(
      buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo, {
          getRemoteUrl: () => Promise.resolve(null),
          resolvePushedBase: () => Promise.resolve(null),
          listDiff: () => Promise.resolve([]),
          listUntracked: () => Promise.resolve([]),
          buildSnapshot: () =>
            Promise.resolve({
              baseCommitSha: 'b'.repeat(40),
              chunks: [
                {
                  hash: 'a'.repeat(64),
                  sizeBytes: 1,
                  source: {
                    hash: `sha256:${'a'.repeat(64)}`,
                    sizeBytes: 1,
                    createReadStream: (): Readable => Readable.from([]),
                    dispose: disposeSnapshotSource,
                  },
                },
              ],
              treeFileCount: MAX_SHARED_CONTAINER_MATERIALIZED_FILES + 1,
              treeBytes: BigInt(1),
              treeFileSizes: new Map(),
              withheldPaths: [],
            }),
        }),
      ),
    ).rejects.toMatchObject<SharedContainerPublishRefusalError>({
      reason: 'artifact-budget',
    });
    expect(disposeSnapshotSource).toHaveBeenCalledTimes(1);
  });

  it('disposes a snapshot that finishes after a concurrent repository refusal', async () => {
    const firstRepo = await mkdtemp(
      join(tmpdir(), 'snapshot-concurrent-first-'),
    );
    const secondRepo = await mkdtemp(
      join(tmpdir(), 'snapshot-concurrent-second-'),
    );
    const snapshotStarted = Promise.withResolvers<void>();
    const disposeSnapshotSource = jest.fn(() => Promise.resolve());
    const refused = new Error('unsupported LFS repository');

    try {
      const build = buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(firstRepo, {
          listRepositories: () =>
            Promise.resolve([
              {
                repoId: 'first',
                repoName: 'first',
                repoPath: firstRepo,
                relativePrefix: 'first',
              },
              {
                repoId: 'second',
                repoName: 'second',
                repoPath: secondRepo,
                relativePrefix: 'second',
              },
            ]),
          getRemoteUrl: () => Promise.resolve(null),
          getHead: () => Promise.resolve(null),
          listUntracked: () => Promise.resolve([]),
          usesLfs: async (repoPath) => {
            if (repoPath === firstRepo) return false;
            await snapshotStarted.promise;
            throw refused;
          },
          inspectTreeEntries: () => Promise.resolve([]),
          buildSnapshot: async ({ repoPath }) => {
            if (repoPath !== firstRepo) {
              throw new Error('refused repository must not build a snapshot');
            }
            snapshotStarted.resolve();
            await new Promise((resolve) => setTimeout(resolve, 50));
            return {
              baseCommitSha: 'b'.repeat(40),
              chunks: [
                {
                  hash: 'a'.repeat(64),
                  sizeBytes: 1,
                  source: {
                    hash: `sha256:${'a'.repeat(64)}`,
                    sizeBytes: 1,
                    createReadStream: (): Readable => Readable.from([]),
                    dispose: disposeSnapshotSource,
                  },
                },
              ],
              treeFileCount: 0,
              treeBytes: BigInt(0),
              treeFileSizes: new Map(),
              withheldPaths: [],
            };
          },
        }),
      );

      await expect(build).rejects.toBe(refused);
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(disposeSnapshotSource).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all([
        rm(firstRepo, { recursive: true, force: true }),
        rm(secondRepo, { recursive: true, force: true }),
      ]);
    }
  });

  it('classifies an oversized snapshot tree byte projection as an artifact-budget refusal', async () => {
    const repo = await initializeRepository();

    await expect(
      buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo, {
          getRemoteUrl: () => Promise.resolve(null),
          resolvePushedBase: () => Promise.resolve(null),
          listDiff: () => Promise.resolve([]),
          listUntracked: () => Promise.resolve([]),
          buildSnapshot: () =>
            Promise.resolve({
              baseCommitSha: 'b'.repeat(40),
              chunks: [],
              treeFileCount: 1,
              treeBytes:
                BigInt(MAX_SHARED_CONTAINER_REVISION_BYTES) + BigInt(1),
              treeFileSizes: new Map([
                [
                  'oversized.txt',
                  BigInt(MAX_SHARED_CONTAINER_REVISION_BYTES) + BigInt(1),
                ],
              ]),
              withheldPaths: [],
            }),
        }),
      ),
    ).rejects.toMatchObject<SharedContainerPublishRefusalError>({
      reason: 'artifact-budget',
    });
  });

  it('does not double-count bytes replaced in a snapshot overlay', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'snapshot-replacement-budget-'));
    await writeFile(join(repo, 'replacement.txt'), 'new');
    const row: RawDiffEntry = {
      path: 'replacement.txt',
      status: 'M',
      srcMode: '100644',
      dstMode: '100644',
    };

    await expect(
      buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo, {
          getRemoteUrl: () => Promise.resolve(null),
          getHead: () => Promise.resolve('a'.repeat(40)),
          resolvePushedBase: () => Promise.resolve(null),
          listDiff: () => Promise.resolve([row]),
          listUntracked: () => Promise.resolve([]),
          usesLfs: () => Promise.resolve(false),
          inspectTreeEntries: () => Promise.resolve([]),
          buildSnapshot: () =>
            Promise.resolve({
              baseCommitSha: 'b'.repeat(40),
              chunks: [],
              treeFileCount: 1,
              treeBytes: BigInt(MAX_SHARED_CONTAINER_REVISION_BYTES),
              treeFileSizes: new Map([
                [
                  'replacement.txt',
                  BigInt(MAX_SHARED_CONTAINER_REVISION_BYTES),
                ],
              ]),
              withheldPaths: [],
            }),
        }),
      ),
    ).resolves.toMatchObject({
      repositories: [
        expect.objectContaining({
          files: [expect.objectContaining({ path: 'replacement.txt' })],
        }),
      ],
    });
  });

  it('shares one pre-hash byte budget across attachments and repository files', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-code-source-budget-'));
    await writeFile(join(repo, 'changed.bin'), 'x');
    const row: RawDiffEntry = {
      path: 'changed.bin',
      status: 'A',
      srcMode: '000000',
      dstMode: '100644',
    };
    const attachmentCount = Math.floor(
      MAX_SHARED_CONTAINER_REVISION_BYTES / MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
    );
    const attachmentFiles = Array.from(
      { length: attachmentCount },
      (_, index) => ({
        displayName: `attachment-${index}.bin`,
        requestedPath: `/attachments/${index}.bin`,
        absolutePath: `/attachments/${index}.bin`,
        sourcePaths: [`/attachments/${index}.bin`],
        size: MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
      }),
    );
    const openAttachmentFile = jest.fn(
      (
        ...args: Parameters<
          CodePublishInventoryDependencies['openAttachmentFile']
        >
      ): ReturnType<CodePublishInventoryDependencies['openAttachmentFile']> => {
        const [file, options] = args;
        options.reserveInspectionBytes?.(
          BigInt(MAX_SHARED_CONTAINER_ARTIFACT_BYTES),
        );
        return Promise.resolve({
          displayName: file.displayName,
          sourcePath: file.sourcePaths[0],
          sourcePaths: file.sourcePaths,
          source: {
            sizeBytes: MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
            hash: `sha256:${'a'.repeat(64)}`,
            createReadStream: () => Readable.from([]),
          },
        });
      },
    );
    const createFileSource = jest.fn(createStableFileSource);

    await expect(
      buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo, {
          createFileSource,
          getHead: () => Promise.resolve('a'.repeat(40)),
          listAttachmentFiles: () => Promise.resolve(attachmentFiles),
          openAttachmentFile,
          listDiff: () => Promise.resolve([row]),
          listUntracked: () => Promise.resolve([]),
          usesLfs: () => Promise.resolve(false),
          inspectTreeEntries: () => Promise.resolve([]),
        }),
      ),
    ).rejects.toMatchObject<SharedContainerPublishRefusalError>({
      reason: 'artifact-budget',
    });
    expect(createFileSource).not.toHaveBeenCalled();
  });

  it('counts deleted overlays in the materialized-file ceiling', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-code-deletion-limit-'));
    const rows: RawDiffEntry[] = Array.from(
      { length: MAX_SHARED_CONTAINER_MATERIALIZED_FILES + 1 },
      (_, index) => ({
        path: `deleted-${index}.txt`,
        status: 'D',
        srcMode: '100644',
        dstMode: '000000',
      }),
    );

    await expect(
      buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo, {
          getHead: () => Promise.resolve('a'.repeat(40)),
          listDiff: () => Promise.resolve(rows),
          listUntracked: () => Promise.resolve([]),
          usesLfs: () => Promise.resolve(false),
          inspectTreeEntries: () => Promise.resolve([]),
        }),
      ),
    ).rejects.toMatchObject<SharedContainerPublishRefusalError>({
      reason: 'artifact-budget',
    });
  });

  it('bounds aggregate changed-file bytes before hashing beyond the revision limit', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-code-byte-limit-'));
    const filesWithinLimit = Math.floor(
      MAX_SHARED_CONTAINER_REVISION_BYTES / MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
    );
    const rows: RawDiffEntry[] = Array.from(
      { length: filesWithinLimit + 1 },
      (_, index) => ({
        path: `changed-${index}.bin`,
        status: 'A',
        srcMode: '000000',
        dstMode: '100644',
      }),
    );
    await Promise.all(
      rows.map(async (row) => {
        await writeFile(join(repo, row.path), '');
        await truncate(
          join(repo, row.path),
          MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
        );
      }),
    );
    const createFileSource = jest.fn(
      (
        ...args: Parameters<typeof createStableFileSource>
      ): ReturnType<typeof createStableFileSource> =>
        Promise.resolve({
          sizeBytes: Number(args[3].size),
          hash: `sha256:${'a'.repeat(64)}`,
          createReadStream: () => Readable.from([]),
        }),
    );

    await expect(
      buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo, {
          createFileSource,
          getHead: () => Promise.resolve('a'.repeat(40)),
          listDiff: () => Promise.resolve(rows),
          listUntracked: () => Promise.resolve([]),
          usesLfs: () => Promise.resolve(false),
          inspectTreeEntries: () => Promise.resolve([]),
        }),
      ),
    ).rejects.toMatchObject<SharedContainerPublishRefusalError>({
      reason: 'artifact-budget',
    });
    expect(createFileSource).toHaveBeenCalledTimes(filesWithinLimit);
  });

  it('withholds oversized tracked changes before applying the artifact budget', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-code-oversized-budget-'));
    const rows: RawDiffEntry[] = Array.from(
      { length: MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION },
      (_, index) => ({
        path: `oversized-${index}.bin`,
        status: 'A',
        srcMode: '000000',
        dstMode: '100644',
      }),
    );
    await Promise.all(
      rows.map(async (row) => {
        await writeFile(join(repo, row.path), '');
        await truncate(
          join(repo, row.path),
          MAX_SHARED_CONTAINER_ARTIFACT_BYTES + 1,
        );
      }),
    );

    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: [] },
      },
      dependencies(repo, {
        getHead: () => Promise.resolve('a'.repeat(40)),
        listDiff: () => Promise.resolve(rows),
        listUntracked: () => Promise.resolve([]),
        usesLfs: () => Promise.resolve(false),
        inspectTreeEntries: () => Promise.resolve([]),
      }),
    );

    expect(inventory.repositories[0]?.files).toEqual([]);
    expect(inventory.withheldFileCount).toBe(rows.length);
    expect(inventory.withheldFileReasons).toEqual(['oversized']);
  });

  it('rejects a repository snapshot that changes while its files are hashed', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-code-race-'));
    await writeFile(join(repo, 'tracked.txt'), 'content');
    const initial: RawDiffEntry = {
      path: 'tracked.txt',
      status: 'M',
      srcMode: '100644',
      dstMode: '100644',
    };
    const listDiff = jest
      .fn()
      .mockResolvedValueOnce([initial])
      .mockResolvedValueOnce([
        initial,
        {
          path: 'appeared.txt',
          status: 'A',
          srcMode: '000000',
          dstMode: '100644',
        },
      ]);

    await expect(
      buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo, {
          getHead: () => Promise.resolve('a'.repeat(40)),
          listDiff,
          listUntracked: () => Promise.resolve([]),
          usesLfs: () => Promise.resolve(false),
          inspectTreeEntries: () => Promise.resolve([]),
        }),
      ),
    ).rejects.toBeInstanceOf(SharedContainerPublishInventoryChangedError);
  });

  it('classifies an approved untracked file that disappears before inspection as a transient inventory change', async () => {
    const repo = await mkdtemp(
      join(tmpdir(), 'shared-code-missing-untracked-'),
    );

    await expect(
      buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: ['approved.txt'] },
        },
        dependencies(repo, {
          getHead: () => Promise.resolve('a'.repeat(40)),
          listDiff: () => Promise.resolve([]),
          listUntracked: () => Promise.resolve(['approved.txt']),
          usesLfs: () => Promise.resolve(false),
          inspectTreeEntries: () => Promise.resolve([]),
        }),
      ),
    ).rejects.toBeInstanceOf(SharedContainerPublishInventoryChangedError);
  });

  it('classifies an approved untracked file that disappears during fingerprint validation as a transient inventory change', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-code-raced-untracked-'));
    const approvedPath = join(repo, 'approved.txt');
    await writeFile(approvedPath, 'approved');
    const listUntracked = jest
      .fn()
      .mockResolvedValueOnce(['approved.txt'])
      .mockImplementationOnce(async () => {
        await rm(approvedPath);
        return ['approved.txt'];
      });

    await expect(
      buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: ['approved.txt'] },
        },
        dependencies(repo, {
          getHead: () => Promise.resolve('a'.repeat(40)),
          listDiff: () => Promise.resolve([]),
          listUntracked,
          usesLfs: () => Promise.resolve(false),
          inspectTreeEntries: () => Promise.resolve([]),
        }),
      ),
    ).rejects.toBeInstanceOf(SharedContainerPublishInventoryChangedError);
  });

  it('ignores an unselected file that appears after resolved-scope enumeration', async () => {
    const repo = await mkdtemp(
      join(tmpdir(), 'shared-code-appeared-untracked-'),
    );
    const approvedPath = join(repo, 'approved.txt');
    const listUntracked = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => {
        await writeFile(approvedPath, 'appeared');
        return ['approved.txt'];
      });

    await expect(
      buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: ['approved.txt'] },
        },
        dependencies(repo, {
          getHead: () => Promise.resolve('a'.repeat(40)),
          listDiff: () => Promise.resolve([]),
          listUntracked,
          usesLfs: () => Promise.resolve(false),
          inspectTreeEntries: () => Promise.resolve([]),
        }),
      ),
    ).resolves.toMatchObject({
      repositories: [{ approvedUntrackedPaths: [] }],
    });
  });

  it('classifies a source that disappears before deferred upload as a transient inventory change', async () => {
    const repo = await initializeRepository();
    const trackedPath = join(repo, 'src', 'tracked.ts');
    await writeFile(trackedPath, 'after\n');
    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: [] },
      },
      dependencies(repo),
    );
    const source = inventory.repositories[0]?.files[0]?.source;
    if (!source) throw new Error('Expected a deferred file source');
    await rm(trackedPath);

    await expect(
      (async (): Promise<void> => {
        for await (const chunk of source.createReadStream()) {
          void chunk; // Drain the deferred upload stream.
        }
      })(),
    ).rejects.toBeInstanceOf(SharedContainerPublishInventoryChangedError);
  });

  it('classifies a substituted source parent as a transient inventory change', async () => {
    const repo = await initializeRepository();
    const sourceDirectory = join(repo, 'src');
    const trackedPath = join(sourceDirectory, 'tracked.ts');
    await writeFile(trackedPath, 'after\n');
    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: [] },
      },
      dependencies(repo),
    );
    const source = inventory.repositories[0]?.files[0]?.source;
    if (!source) throw new Error('Expected a deferred file source');
    await rm(sourceDirectory, { recursive: true });
    await writeFile(sourceDirectory, 'replacement');

    await expect(
      (async (): Promise<void> => {
        for await (const chunk of source.createReadStream()) {
          void chunk; // Drain the deferred upload stream.
        }
      })(),
    ).rejects.toBeInstanceOf(SharedContainerPublishInventoryChangedError);
  });

  it('publishes against an older pushed base without an unpushed-HEAD refusal', async () => {
    await expect(
      buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies('/unused', {
          resolvePushedBase: () =>
            Promise.resolve({
              baseSha: 'b'.repeat(40),
              headSha: 'a'.repeat(40),
              unpushedCommitCount: 1,
            }),
          getHead: () => Promise.resolve('a'.repeat(40)),
          listDiff: () => Promise.resolve([]),
          listUntracked: () => Promise.resolve([]),
          usesLfs: () => Promise.resolve(false),
          inspectTreeEntries: () => Promise.resolve([]),
        }),
      ),
    ).resolves.toMatchObject({
      repositories: [
        expect.objectContaining({
          baseCommitSha: 'b'.repeat(40),
          headSha: 'a'.repeat(40),
          unpushedCommitCount: 1,
        }),
      ],
    });
  });

  it('keeps deferred sources stable for files added by an unpushed commit', async () => {
    const repo = await initializeRepository();
    try {
      const baseSha = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo })
      ).stdout.trim();
      await writeFile(join(repo, 'symlink-target.txt'), 'target\n');
      await symlink('symlink-target.txt', join(repo, 'link.txt'));
      await execFileAsync('git', ['add', 'symlink-target.txt', 'link.txt'], {
        cwd: repo,
      });
      await execFileAsync('git', ['commit', '-m', 'unpushed files'], {
        cwd: repo,
      });
      const headSha = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo })
      ).stdout.trim();

      const inventory = await buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo, {
          resolvePushedBase: () =>
            Promise.resolve({ baseSha, headSha, unpushedCommitCount: 1 }),
          listDiff: listWorkingTreeDiffAgainstCommit,
        }),
      );

      expect(inventory.repositories[0]?.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'link.txt', mode: '120000' }),
          expect.objectContaining({
            path: 'symlink-target.txt',
            mode: '100644',
          }),
        ]),
      );
      await expect(
        assertCodePublishInventoryHeadsStable(inventory),
      ).resolves.toBeUndefined();
      for (const file of inventory.repositories[0]?.files ?? []) {
        for await (const chunk of file.source?.createReadStream() ?? []) {
          expect(Buffer.isBuffer(chunk)).toBe(true);
        }
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('publishes a repository without a remote as a snapshot layout', async () => {
    const snapshotBytes = Buffer.from('snapshot bundle');
    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: [] },
      },
      dependencies('/unused', {
        resolvePushedBase: () => Promise.resolve(null),
        getRemoteUrl: () => Promise.resolve(null),
        getHead: () => Promise.resolve('a'.repeat(40)),
        // The committed snapshot and the overlay can both encounter the same
        // protected path. It is one omitted file in the owner disclosure.
        listDiff: () =>
          Promise.resolve([
            {
              path: '.env.local',
              status: 'M',
              srcMode: '100644',
              dstMode: '100644',
            },
          ]),
        listUntracked: () => Promise.resolve([]),
        usesLfs: () => Promise.resolve(false),
        inspectTreeEntries: () => Promise.resolve([]),
        buildSnapshot: () =>
          Promise.resolve({
            baseCommitSha: 'b'.repeat(40),
            chunks: [snapshotChunk(snapshotBytes)],
            treeFileCount: 1,
            treeBytes: BigInt(15),
            treeFileSizes: new Map([['src/tracked.ts', BigInt(15)]]),
            withheldPaths: ['.env.local'],
            withheldReasons: { '.env.local': 'credential-shaped' },
          }),
      }),
    );

    expect(inventory.repositories).toEqual([
      expect.objectContaining({
        source: 'snapshot',
        baseCommitSha: 'b'.repeat(40),
      }),
    ]);
    const artifacts = buildCodeRevisionArtifacts(inventory, 'snapshot');
    const layout: unknown = JSON.parse(
      artifacts
        .find((artifact) => artifact.path === 'container.json')
        ?.bytes?.toString('utf8') ?? '{}',
    ) as unknown;
    expect(layout).toMatchObject({
      schemaVersion: 2,
      repositories: [
        {
          source: 'snapshot',
          baseCommitSha: 'b'.repeat(40),
          snapshot: {
            treeFileCount: 1,
            treeBytes: '15',
          },
        },
      ],
    });
    expect(inventory.withheldFileCount).toBe(1);
    expect(inventory.withheldFileReasons).toEqual(['credential-shaped']);
  });

  it('keeps an unborn snapshot stable before staging', async () => {
    const snapshotBytes = Buffer.from('unborn snapshot bundle');
    const buildSnapshot = jest.fn(() =>
      Promise.resolve({
        baseCommitSha: 'b'.repeat(40),
        chunks: [snapshotChunk(snapshotBytes)],
        treeFileCount: 1,
        treeBytes: BigInt(10),
        treeFileSizes: new Map([['new.txt', BigInt(10)]]),
        withheldPaths: [],
      }),
    );
    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: [] },
      },
      dependencies('/unused', {
        getRemoteUrl: () => Promise.resolve(null),
        getHead: () => Promise.resolve(null),
        listUntracked: () => Promise.resolve([]),
        usesLfs: () => Promise.resolve(false),
        inspectTreeEntries: () => Promise.resolve([]),
        buildSnapshot,
      }),
    );

    expect(inventory.repositories[0]?.headSha).toBeNull();
    await expect(
      assertCodePublishInventoryHeadsStable(inventory, {
        getHead: () => Promise.resolve(null),
        buildSnapshot,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects an unborn snapshot that changes while the inventory is built', async () => {
    const buildSnapshot = jest
      .fn()
      .mockResolvedValueOnce({
        baseCommitSha: 'b'.repeat(40),
        chunks: [snapshotChunk(Buffer.from('before'))],
        treeFileCount: 1,
        treeBytes: BigInt(6),
        treeFileSizes: new Map([['new.txt', BigInt(6)]]),
        withheldPaths: [],
      })
      .mockResolvedValueOnce({
        baseCommitSha: 'c'.repeat(40),
        chunks: [snapshotChunk(Buffer.from('after'))],
        treeFileCount: 1,
        treeBytes: BigInt(5),
        treeFileSizes: new Map([['new.txt', BigInt(5)]]),
        withheldPaths: [],
      });

    await expect(
      buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies('/unused', {
          getRemoteUrl: () => Promise.resolve(null),
          getHead: () => Promise.resolve(null),
          listUntracked: () => Promise.resolve([]),
          usesLfs: () => Promise.resolve(false),
          inspectTreeEntries: () => Promise.resolve([]),
          buildSnapshot,
        }),
      ),
    ).rejects.toBeInstanceOf(SharedContainerPublishInventoryChangedError);
  });

  it('rejects an unborn snapshot that changes before staging', async () => {
    const stableSnapshot = {
      baseCommitSha: 'b'.repeat(40),
      chunks: [snapshotChunk(Buffer.from('stable'))],
      treeFileCount: 1,
      treeBytes: BigInt(6),
      treeFileSizes: new Map([['new.txt', BigInt(6)]]),
      withheldPaths: [],
    };
    const buildSnapshot = jest
      .fn()
      .mockResolvedValueOnce(stableSnapshot)
      .mockResolvedValueOnce(stableSnapshot)
      .mockResolvedValueOnce({
        ...stableSnapshot,
        baseCommitSha: 'c'.repeat(40),
        chunks: [snapshotChunk(Buffer.from('changed'))],
      });
    const inventory = await buildCodePublishInventory(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: { includedPaths: [] },
      },
      dependencies('/unused', {
        getRemoteUrl: () => Promise.resolve(null),
        getHead: () => Promise.resolve(null),
        listUntracked: () => Promise.resolve([]),
        usesLfs: () => Promise.resolve(false),
        inspectTreeEntries: () => Promise.resolve([]),
        buildSnapshot,
      }),
    );

    await expect(
      assertCodePublishInventoryHeadsStable(inventory, {
        getHead: () => Promise.resolve(null),
        buildSnapshot,
      }),
    ).rejects.toBeInstanceOf(SharedContainerPublishInventoryChangedError);
  });

  it('builds an unborn repository inventory without inspecting a nonexistent HEAD tree', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-code-unborn-inventory-'));
    await execFileAsync('git', ['init'], { cwd: repo });
    await writeFile(join(repo, 'new.txt'), 'new repository\n');
    const inspectTreeEntries = jest.fn(inspectRepositoryTreeEntryKinds);
    let snapshot: SharedContainerCodeSnapshot | undefined;

    try {
      const inventory = await buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo, {
          getRemoteUrl: () => Promise.resolve(null),
          resolvePushedBase: () => Promise.resolve(null),
          inspectTreeEntries,
          buildSnapshot: buildSharedContainerCodeSnapshot,
        }),
      );

      snapshot = inventory.repositories[0]?.snapshot;
      expect(inventory.repositories[0]).toMatchObject({
        source: 'snapshot',
        headSha: null,
      });
      expect(snapshot?.treeFileSizes).toEqual(
        new Map([['new.txt', BigInt('new repository\n'.length)]]),
      );
      expect(inspectTreeEntries).not.toHaveBeenCalled();
    } finally {
      if (snapshot) await disposeSnapshot(snapshot);
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('refuses a submodule in an unborn repository snapshot', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-code-unborn-submodule-'));
    const nestedRepo = join(repo, 'vendor', 'example');
    await execFileAsync('git', ['init'], { cwd: repo });
    await mkdir(nestedRepo, { recursive: true });
    await execFileAsync('git', ['init'], { cwd: nestedRepo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], {
      cwd: nestedRepo,
    });
    await execFileAsync('git', ['config', 'user.email', 'test@example.test'], {
      cwd: nestedRepo,
    });
    await writeFile(join(nestedRepo, 'README.md'), 'nested repository\n');
    await execFileAsync('git', ['add', '.'], { cwd: nestedRepo });
    await execFileAsync('git', ['commit', '-m', 'nested fixture'], {
      cwd: nestedRepo,
    });

    try {
      await expect(
        buildSharedContainerCodeSnapshot({
          repoPath: repo,
          headSha: null,
          includeChunkSources: false,
        }),
      ).rejects.toMatchObject({ reason: 'submodule' });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it.each([
    ['git-lfs', { usesLfs: (): Promise<boolean> => Promise.resolve(true) }],
    [
      'submodule',
      {
        inspectTreeEntries: (): ReturnType<
          typeof inspectRepositoryTreeEntryKinds
        > =>
          Promise.resolve([
            {
              mode: '160000',
              type: 'commit' as const,
              objectId: 'b'.repeat(40),
              path: 'vendor/example',
            },
          ]),
      },
    ],
  ] as const)('surfaces an actionable %s refusal', async (reason, override) => {
    const repo = await mkdtemp(join(tmpdir(), 'shared-code-refusal-'));
    await expect(
      buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo, {
          getHead: () => Promise.resolve('a'.repeat(40)),
          listDiff: () => Promise.resolve([]),
          listUntracked: () => Promise.resolve([]),
          usesLfs: () => Promise.resolve(false),
          inspectTreeEntries: () => Promise.resolve([]),
          ...override,
        }),
      ),
    ).rejects.toMatchObject({ reason });
  });
  // CAN-2551: the recipient's "Changes" view was empty whenever the publisher
  // had committed their work, because a share only ever carried the working
  // tree. The manifest now also names the branch's own commits.
  describe('committed changes', () => {
    async function commitOnBranch(repo: string): Promise<void> {
      await execFileAsync('git', ['checkout', '-b', 'feature'], { cwd: repo });
      await writeFile(join(repo, 'src', 'tracked.ts'), 'before\nafter\n');
      await writeFile(join(repo, 'src', 'added.ts'), 'brand new\n');
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'branch work'], {
        cwd: repo,
      });
    }

    it('stamps the base branch, merge base, and committed files', async () => {
      const repo = await initializeRepository();
      await execFileAsync('git', ['branch', '-M', 'main'], { cwd: repo });
      const mergeBase = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo })
      ).stdout.trim();
      await commitOnBranch(repo);

      const inventory = await buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo),
      );

      const repository = inventory.repositories[0];
      expect(repository?.baseBranch).toBe('main');
      expect(repository?.mergeBaseSha).toBe(mergeBase);
      expect(repository?.committedFiles).toEqual([
        expect.objectContaining({ path: 'src/added.ts', status: 'added' }),
        expect.objectContaining({
          path: 'src/tracked.ts',
          status: 'modified',
          insertions: 1,
          deletions: 0,
        }),
      ]);
      // Committed blobs live in the recipient's own clone, so they must never
      // be uploaded as artifacts.
      const committedKeys = new Set(
        (repository?.committedFiles ?? []).flatMap((file) => Object.keys(file)),
      );
      expect(committedKeys.has('artifactId')).toBe(false);
    });

    // CAN-2551: git's default `core.quotePath` renders a non-ASCII path
    // C-quoted and octal-escaped, which `validateRepositoryPath` rejects for
    // its quotes and backslashes. Every accented, CJK, or emoji-named committed
    // file was therefore dropped from the manifest with no disclosure.
    it('publishes committed files with non-ASCII names', async () => {
      const repo = await initializeRepository();
      await execFileAsync('git', ['branch', '-M', 'main'], { cwd: repo });
      await execFileAsync('git', ['checkout', '-b', 'feature'], { cwd: repo });
      await writeFile(join(repo, 'src', 'café.ts'), 'accented\n');
      await writeFile(join(repo, 'src', '日本.ts'), 'cjk\n');
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'non-ascii'], { cwd: repo });

      const inventory = await buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo),
      );

      const paths = (inventory.repositories[0]?.committedFiles ?? []).map(
        (file) => file.path,
      );
      expect(paths).toContain('src/café.ts');
      expect(paths).toContain('src/日本.ts');
    });

    it('emits an empty committed list when nothing was committed past the merge base', async () => {
      const repo = await initializeRepository();
      await execFileAsync('git', ['branch', '-M', 'main'], { cwd: repo });

      const inventory = await buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo),
      );

      expect(inventory.repositories[0]?.committedFiles).toEqual([]);
    });

    it('publishes the uncommitted half even when the base branch cannot be resolved', async () => {
      const repo = await initializeRepository();
      await writeFile(join(repo, 'src', 'tracked.ts'), 'dirty\n');

      const inventory = await buildCodePublishInventory(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          scope: { includedPaths: [] },
        },
        dependencies(repo, {
          resolveBaseBranch: () =>
            Promise.reject(new Error('no tracked base branch')),
        }),
      );

      const repository = inventory.repositories[0];
      expect(repository?.mergeBaseSha).toBeUndefined();
      expect(repository?.committedFiles).toBeUndefined();
      expect(repository?.files).toContainEqual(
        expect.objectContaining({ path: 'src/tracked.ts', status: 'modified' }),
      );
    });
  });
});

describe('code shared-container published layout', () => {
  it('keeps publisher tabs on unchanged tracked files but not withheld ones', async () => {
    const { panelLayoutPersistenceStore } =
      await import('../panels/persistence');
    const repoPath = await initializeRepository();
    await writeFile(join(repoPath, 'README.md'), 'readme\n');
    await writeFile(join(repoPath, '.env.production'), 'TOKEN=secret\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoPath });
    await execFileAsync('git', ['commit', '-m', 'more fixtures'], {
      cwd: repoPath,
    });
    await writeFile(join(repoPath, 'src', 'tracked.ts'), 'after\n');
    const fileTab = (id: string, path: string): PersistedChatTab => ({
      id,
      title: path,
      messages: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      kind: 'file',
      filePath: join(repoPath, ...path.split('/')),
    });
    const tabs = [
      fileTab('tab-changed', 'src/tracked.ts'),
      fileTab('tab-unchanged', 'README.md'),
      fileTab('tab-credential', '.env.production'),
    ];
    panelLayoutPersistenceStore.saveWorktreeLayout('project-1', 'layout-wt', {
      version: 1,
      grid: {
        orientation: 1,
        width: 1200,
        height: 800,
        root: {
          type: 'leaf',
          groupId: 'group-1',
          size: 1200,
          activePanelId: 'panel-2',
          panels: tabs.map((tab, index) => ({
            panelId: `panel-${index + 1}`,
            kind: 'chat',
            instance: { chatTabId: tab.id },
          })),
        },
      },
      activeGroupId: 'group-1',
      mostRecentActiveGroupIds: ['group-1'],
    });
    try {
      const inventory = await buildCodePublishInventory(
        { projectId: 'project-1', worktreeId: 'layout-wt', scope: {} },
        dependencies(repoPath, {
          readChatTabs: () =>
            Promise.resolve({ version: 1 as const, tabs, activeTabId: '' }),
        }),
      );

      expect(inventory.layout?.root).toEqual({
        type: 'leaf',
        size: 1200,
        tabs: [
          {
            kind: 'file',
            repoId: 'repo-1',
            relativePath: 'src/tracked.ts',
            viewMode: 'raw',
          },
          {
            kind: 'file',
            repoId: 'repo-1',
            relativePath: 'README.md',
            viewMode: 'raw',
          },
        ],
        activeTabIndex: 1,
      });
      // The unchanged file is layout metadata only, never an upload.
      expect(inventory.repositories[0]?.files.map((file) => file.path)).toEqual(
        ['src/tracked.ts'],
      );

      // Turning the preferred layout off ships no layout at all.
      await writeSharedContainerFileScope('project-1', 'layout-wt', {
        includedPaths: [],
        preferredLayout: { enabled: false },
      });
      const withoutLayout = await buildCodePublishInventory(
        { projectId: 'project-1', worktreeId: 'layout-wt', scope: {} },
        dependencies(repoPath, {
          readChatTabs: () =>
            Promise.resolve({ version: 1 as const, tabs, activeTabId: '' }),
        }),
      );
      expect(withoutLayout).not.toHaveProperty('layout');
    } finally {
      panelLayoutPersistenceStore.deleteWorktreeLayout(
        'project-1',
        'layout-wt',
      );
      await rm(getWorktreeShareFileScopePath('project-1', 'layout-wt'), {
        force: true,
      });
      await rm(repoPath, { recursive: true, force: true });
    }
  });
});
