import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  readlink,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  isSharedContainerRevisionLayout,
  MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
  MAX_SHARED_CONTAINER_MATERIALIZED_BYTES,
  MAX_SHARED_CONTAINER_MATERIALIZED_FILES,
  type SharedContainerArtifactDetail,
  type SharedContainerRevisionLayout,
  type SharedContainerRevisionLayoutV2,
} from '@canopy/protocol/shared-containers';
import { materializeCoworkRevision } from '../shared-containers/materialize/cowork';
import {
  materializeCodeRevision,
  parseGitHubRemote,
  SHARED_CONTAINER_GIT_OPERATION_TIMEOUT_MS,
  type MaterializeCodeDependencies,
} from '../shared-containers/materialize/code';
import { validateMaterializedRelativePath } from '../shared-containers/materialize/path-safety';
import { validateSharedContainerProjectionBudget } from '../shared-containers/materialize/projection-budget';
import { buildSharedContainerDirtyFileFixture } from './fixtures/shared-container-replica-fixture';
import {
  makeReplicaTreeWritable,
  SharedContainerReplicaStore,
} from '../shared-containers/replica/store';
import { materializeGitCommitRaw } from '../lib/git';
import * as gitExecutable from '../lib/git-executable';
import { SharedContainerReader } from '../shared-containers/read/reader';
import { resolveSharedContainerViewerReadRoots } from '../shared-containers/read/viewer-root';
import { COWORK_WORKSPACE_FILE_ROOT_ID } from '@canopy/desktop-shared/types';

const execFileAsync = promisify(execFile);

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(30_000);

describe('shared-container materialization', () => {
  const codeLayout = (
    remoteUrl = 'https://github.com/acme/repo.git',
  ): SharedContainerRevisionLayout => ({
    schemaVersion: 1,
    containerType: 'CODE_WORKTREE',
    title: 'Feature branch',
    repositories: [
      {
        repoId: 'repo-1',
        repoName: 'repo',
        remoteUrl,
        owner: 'acme',
        repository: 'repo',
        baseCommitSha: 'a'.repeat(40),
        files: [],
      },
    ],
    files: [],
    notes: [],
    prompts: [],
    attachmentPaths: {},
  });

  const codeDependencies = (): MaterializeCodeDependencies => ({
    resolveGitHubToken: () => Promise.resolve('recipient-token'),
    probeRepository: () => Promise.resolve(),
    probeCommit: () => Promise.resolve('b'.repeat(40)),
    inspectRepositoryTree: () =>
      Promise.resolve({
        fileCount: 0,
        totalBytes: BigInt(0),
      }),
    cloneRepo: () => Promise.resolve(),
    fetchOrigin: () => Promise.resolve(),
    prepareCommittedRange: () => Promise.resolve(),
    // Matches `codeLayout`'s default remote, so a pre-seeded checkout is
    // treated as reusable and the incremental fetch branch runs.
    readOriginUrl: () => Promise.resolve('https://github.com/acme/repo.git'),
    materializeRawCommit: () =>
      Promise.resolve({ fileCount: 0, totalBytes: BigInt(0) }),
  });

  it.each([
    '../escape',
    '/absolute',
    'C:\\absolute',
    'C:drive-relative',
    'dir\\file',
    'dir/../file',
    'dir/aux.c',
    'dir/trailing. ',
    'dir/name:bad',
  ])('rejects hostile or non-portable output path %s', (value) => {
    expect(() => validateMaterializedRelativePath(value)).toThrow();
  });

  it('projects verified Cowork artifacts read-only and rejects normalized collisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-materialize-'));
    const artifactsDir = join(root, 'artifacts');
    const outputDir = join(root, 'content');
    await mkdir(join(artifactsDir, 'attachments'), { recursive: true });
    const hash = 'a'.repeat(64);
    await writeFile(join(artifactsDir, 'attachments', hash), 'attachment');
    const layout: SharedContainerRevisionLayout = {
      schemaVersion: 1,
      containerType: 'COWORK_WORK_ENTRY',
      title: 'Work Entry',
      repositories: [],
      files: [],
      notes: [],
      prompts: [],
      attachmentPaths: {
        '/owner/first': {
          artifactId: `attachments/${hash}`,
          displayName: 'résumé.txt',
        },
      },
    };

    await materializeCoworkRevision({ layout, artifactsDir, outputDir });
    expect(
      await readFile(join(outputDir, 'attachments', 'résumé.txt'), 'utf8'),
    ).toBe('attachment');

    layout.attachmentPaths['/owner/second'] = {
      artifactId: `attachments/${'b'.repeat(64)}`,
      displayName: 're\u0301sume\u0301.txt',
    };
    await expect(
      materializeCoworkRevision({
        layout,
        artifactsDir,
        outputDir: join(root, 'bad'),
      }),
    ).rejects.toThrow('collision');
  });

  it('projects approved Cowork files and removes files absent from a later snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-files-'));
    const artifactsDir = join(root, 'artifacts');
    const outputDir = join(root, 'content');
    const hash = 'c'.repeat(64);
    await mkdir(join(artifactsDir, 'files'), { recursive: true });
    await writeFile(join(artifactsDir, 'files', hash), 'approved');
    const layout: SharedContainerRevisionLayout = {
      schemaVersion: 1,
      containerType: 'COWORK_WORK_ENTRY',
      title: 'Work Entry',
      repositories: [],
      files: [
        {
          path: 'reports/approved.txt',
          status: 'added',
          artifactId: 'approved-artifact',
          sizeBytes: '8',
        },
      ],
      notes: [],
      prompts: [],
      attachmentPaths: {},
    };
    await materializeCoworkRevision({
      layout,
      artifactsDir,
      outputDir,
      artifactPathsById: new Map([['approved-artifact', `files/${hash}`]]),
    });
    await expect(
      readFile(join(outputDir, 'reports', 'approved.txt'), 'utf8'),
    ).resolves.toBe('approved');

    await materializeCoworkRevision({
      layout: { ...layout, files: [] },
      artifactsDir,
      outputDir,
      artifactPathsById: new Map(),
    });
    await expect(
      stat(join(outputDir, 'reports', 'approved.txt')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects an orphaned Cowork file artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-files-orphan-'));
    await expect(
      materializeCoworkRevision({
        layout: {
          schemaVersion: 1,
          containerType: 'COWORK_WORK_ENTRY',
          title: 'Work Entry',
          repositories: [],
          files: [],
          notes: [],
          prompts: [],
          attachmentPaths: {},
        },
        artifactsDir: join(root, 'artifacts'),
        outputDir: join(root, 'content'),
        artifactPathsById: new Map([['orphan', `files/${'d'.repeat(64)}`]]),
      }),
    ).rejects.toThrow('missing its container.json entry');
  });

  it('rejects Cowork file entries that point outside files/', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-files-wrong-table-'));
    await expect(
      materializeCoworkRevision({
        layout: {
          schemaVersion: 1,
          containerType: 'COWORK_WORK_ENTRY',
          title: 'Work Entry',
          repositories: [],
          files: [
            {
              path: 'approved.txt',
              status: 'added',
              artifactId: 'wrong-artifact',
              sizeBytes: '1',
            },
          ],
          notes: [],
          prompts: [],
          attachmentPaths: {},
        },
        artifactsDir: join(root, 'artifacts'),
        outputDir: join(root, 'content'),
        artifactPathsById: new Map([['wrong-artifact', 'chats/chat-1.json']]),
      }),
    ).rejects.toThrow('non-file artifact');
  });

  it('rejects a defensive Cowork deletion carrying an artifact id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-files-deleted-'));
    await expect(
      materializeCoworkRevision({
        layout: {
          schemaVersion: 1,
          containerType: 'COWORK_WORK_ENTRY',
          title: 'Work Entry',
          repositories: [],
          files: [
            {
              path: 'removed.txt',
              status: 'deleted',
              artifactId: 'must-not-exist',
              sizeBytes: '0',
            },
          ],
          notes: [],
          prompts: [],
          attachmentPaths: {},
        },
        artifactsDir: join(root, 'artifacts'),
        outputDir: join(root, 'content'),
        artifactPathsById: new Map(),
      }),
    ).rejects.toThrow('must not reference an artifact');
  });

  it('materializes multiple display names from one verified attachment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-materialize-'));
    const artifactsDir = join(root, 'artifacts');
    const hash = 'a'.repeat(64);
    await mkdir(join(artifactsDir, 'attachments'), { recursive: true });
    await writeFile(join(artifactsDir, 'attachments', hash), 'attachment');
    const layout: SharedContainerRevisionLayout = {
      schemaVersion: 1,
      containerType: 'COWORK_WORK_ENTRY',
      title: 'Work Entry',
      repositories: [],
      files: [],
      notes: [],
      prompts: [],
      attachmentPaths: {
        '/owner/first': {
          artifactId: 'attachment-artifact',
          displayName: 'first.txt',
        },
        '/owner/second': {
          artifactId: 'attachment-artifact',
          displayName: 'second.txt',
        },
      },
    };

    const outputDir = join(root, 'content');
    await materializeCoworkRevision({
      layout,
      artifactsDir,
      outputDir,
      artifactPathsById: new Map([
        ['attachment-artifact', `attachments/${hash}`],
      ]),
    });
    await expect(
      readFile(join(outputDir, 'attachments', 'first.txt'), 'utf8'),
    ).resolves.toBe('attachment');
    await expect(
      readFile(join(outputDir, 'attachments', 'second.txt'), 'utf8'),
    ).resolves.toBe('attachment');
  });

  it('counts each display-name copy of one attachment against the projection budget', () => {
    const artifact: SharedContainerArtifactDetail = {
      artifactId: 'attachment-artifact',
      path: `attachments/${'a'.repeat(64)}`,
      representation: 'BLOB',
      hash: `sha256:${'a'.repeat(64)}`,
      objectSizeBytes: String(MAX_SHARED_CONTAINER_ARTIFACT_BYTES),
    };
    const layout = codeLayout();
    layout.attachmentPaths = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [
        `attachment-${index}`,
        {
          artifactId: artifact.artifactId,
          displayName: `${index}.bin`,
        },
      ]),
    );

    expect(() =>
      validateSharedContainerProjectionBudget(layout, [artifact]),
    ).toThrow('projection byte limit');
  });

  it('enforces one aggregate projection budget across content and code copies', () => {
    const attachmentArtifacts: SharedContainerArtifactDetail[] = Array.from(
      { length: 11 },
      (_, index) => ({
        artifactId: `attachment-${index}`,
        path: `attachments/${String(index).padStart(64, 'a')}`,
        representation: 'BLOB',
        hash: `sha256:${'a'.repeat(64)}`,
        objectSizeBytes: String(MAX_SHARED_CONTAINER_ARTIFACT_BYTES),
      }),
    );
    const repositoryArtifact: SharedContainerArtifactDetail = {
      artifactId: 'repository-artifact',
      path: `repos/repo-1/files/${'b'.repeat(64)}`,
      representation: 'BLOB',
      hash: `sha256:${'b'.repeat(64)}`,
      objectSizeBytes: String(MAX_SHARED_CONTAINER_ARTIFACT_BYTES),
    };
    const layout = codeLayout();
    layout.attachmentPaths = Object.fromEntries(
      attachmentArtifacts.map((artifact, index) => [
        `/owner/${index}`,
        { artifactId: artifact.artifactId, displayName: `${index}.bin` },
      ]),
    );
    layout.repositories[0].files = Array.from({ length: 10 }, (_, index) => ({
      path: `copies/${index}.bin`,
      status: 'added' as const,
      artifactId: repositoryArtifact.artifactId,
      mode: '100644',
    }));

    expect(() =>
      validateSharedContainerProjectionBudget(layout, [
        ...attachmentArtifacts,
        repositoryArtifact,
      ]),
    ).toThrow('projection byte limit');
  });

  it('does not double-count snapshot replacements in the projection budget', () => {
    const bundleArtifact: SharedContainerArtifactDetail = {
      artifactId: 'snapshot-bundle',
      path: `repos/repo-1/snapshot/${'a'.repeat(64)}`,
      representation: 'BLOB',
      hash: `sha256:${'a'.repeat(64)}`,
      objectSizeBytes: '1',
    };
    const replacementArtifact: SharedContainerArtifactDetail = {
      artifactId: 'replacement',
      path: `repos/repo-1/files/${'b'.repeat(64)}`,
      representation: 'BLOB',
      hash: `sha256:${'b'.repeat(64)}`,
      objectSizeBytes: '1',
    };
    const layout: SharedContainerRevisionLayoutV2 = {
      schemaVersion: 2,
      containerType: 'CODE_WORKTREE',
      title: 'Snapshot replacement',
      repositories: [
        {
          repoId: 'repo-1',
          repoName: 'repo',
          source: 'snapshot',
          baseCommitSha: 'a'.repeat(40),
          snapshot: {
            bundleArtifactIds: [bundleArtifact.artifactId],
            treeFileCount: MAX_SHARED_CONTAINER_MATERIALIZED_FILES,
            treeBytes: String(MAX_SHARED_CONTAINER_MATERIALIZED_BYTES),
          },
          files: [
            {
              path: 'existing.txt',
              status: 'modified',
              mode: '100644',
              artifactId: replacementArtifact.artifactId,
            },
          ],
        },
      ],
      files: [],
      notes: [],
      prompts: [],
      attachmentPaths: {},
    };

    expect(
      validateSharedContainerProjectionBudget(layout, [
        bundleArtifact,
        replacementArtifact,
      ]),
    ).toEqual({
      files: MAX_SHARED_CONTAINER_MATERIALIZED_FILES,
      bytes: BigInt(MAX_SHARED_CONTAINER_MATERIALIZED_BYTES),
    });
  });

  it('counts repository deletions and content artifacts in one projection file budget', () => {
    const layout = codeLayout();
    layout.repositories[0].files = Array.from(
      { length: MAX_SHARED_CONTAINER_MATERIALIZED_FILES - 1 },
      (_, index) => ({
        path: `deleted/${index}.txt`,
        status: 'deleted' as const,
        mode: '000000',
      }),
    );
    const artifacts: SharedContainerArtifactDetail[] = Array.from(
      { length: 2 },
      (_, index) => ({
        artifactId: `chat-${index}`,
        path: `chats/chat-${index}.json`,
        representation: 'BLOB',
        hash: `sha256:${String(index).padStart(64, 'a')}`,
        objectSizeBytes: '1',
      }),
    );

    expect(isSharedContainerRevisionLayout(layout)).toBe(true);
    expect(() =>
      validateSharedContainerProjectionBudget(layout, artifacts),
    ).toThrow('projection file limit');
  });

  it('fails closed when container metadata points outside its artifact family', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cowork-materialize-'));
    const artifactsDir = join(root, 'artifacts');
    await mkdir(join(artifactsDir, 'chats'), { recursive: true });
    await writeFile(join(artifactsDir, 'chats', 'chat-1.json'), '{}');
    const layout: SharedContainerRevisionLayout = {
      schemaVersion: 1,
      containerType: 'COWORK_WORK_ENTRY',
      title: 'Work Entry',
      repositories: [],
      files: [],
      notes: [{ itemId: '../escape', title: 'Unsafe' }],
      prompts: [],
      attachmentPaths: {
        '/owner/file': {
          artifactId: 'chat-artifact',
          displayName: 'leak.json',
        },
      },
    };

    await expect(
      materializeCoworkRevision({
        layout,
        artifactsDir,
        outputDir: join(root, 'content'),
        artifactPathsById: new Map([['chat-artifact', 'chats/chat-1.json']]),
      }),
    ).rejects.toThrow();
  });

  it('parses only GitHub HTTPS and SSH remotes', () => {
    expect(parseGitHubRemote('https://github.com/acme/repo.git')).toEqual({
      owner: 'acme',
      repository: 'repo',
    });
    expect(parseGitHubRemote('git@github.com:acme/repo.git')).toEqual({
      owner: 'acme',
      repository: 'repo',
    });
    expect(parseGitHubRemote('https://gitlab.com/acme/repo.git')).toBeNull();
  });

  it('blocks code shares on missing GitHub connection before cloning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    const cloneRepo = jest.fn(() => Promise.resolve());
    const result = await materializeCodeRevision(
      {
        layout: codeLayout(),
        artifactsDir: join(root, 'artifacts'),
        reposDir: join(root, 'repos'),
        committedRangesDir: join(root, 'committed-ranges'),
        artifactPathsById: new Map(),
      },
      {
        ...codeDependencies(),
        resolveGitHubToken: () => Promise.resolve(''),
        cloneRepo,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      block: { reason: 'github-not-connected' },
    });
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  it.each([403, 404])(
    'retains the canonical repository and diagnostic for a %s repository probe',
    async (status) => {
      const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
      const dependencies = codeDependencies();
      dependencies.probeRepository = (): Promise<void> =>
        Promise.reject(Object.assign(new Error('access failed'), { status }));

      const result = await materializeCodeRevision(
        {
          layout: codeLayout(),
          artifactsDir: join(root, 'artifacts'),
          reposDir: join(root, 'repos'),
          committedRangesDir: join(root, 'committed-ranges'),
          artifactPathsById: new Map(),
        },
        dependencies,
      );

      expect(result).toEqual({
        ok: false,
        block: {
          reason: 'repository-access-missing',
          repository: 'acme/repo',
          message: 'acme/repo: repository access is missing',
        },
      });
    },
  );

  it.each([
    ['repository-access-missing', 'repository'],
    ['commit-unavailable', 'commit'],
  ] as const)(
    'reports %s from the matching GitHub probe',
    async (reason, failingProbe) => {
      const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
      const dependencies = codeDependencies();
      const rejection = Object.assign(new Error('not found'), { status: 404 });
      if (failingProbe === 'repository') {
        dependencies.probeRepository = (): Promise<void> =>
          Promise.reject(rejection);
      } else {
        dependencies.probeCommit = (): Promise<string> =>
          Promise.reject(rejection);
      }

      const result = await materializeCodeRevision(
        {
          layout: codeLayout(),
          artifactsDir: join(root, 'artifacts'),
          reposDir: join(root, 'repos'),
          committedRangesDir: join(root, 'committed-ranges'),
          artifactPathsById: new Map(),
        },
        dependencies,
      );

      expect(result).toMatchObject({ ok: false, block: { reason } });
    },
  );

  it('distinguishes unsupported remotes, ambient git failure, and LFS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    const unsupported = await materializeCodeRevision(
      {
        layout: codeLayout('https://gitlab.com/acme/repo.git'),
        artifactsDir: join(root, 'artifacts'),
        reposDir: join(root, 'unsupported'),
        committedRangesDir: join(root, 'committed-ranges'),
        artifactPathsById: new Map(),
      },
      codeDependencies(),
    );
    expect(unsupported).toMatchObject({
      ok: false,
      block: { reason: 'unsupported-remote-host' },
    });

    const gitDependencies = codeDependencies();
    gitDependencies.cloneRepo = (): Promise<void> =>
      Promise.reject(
        new Error(
          "fatal: Authentication failed for 'https://github.com/acme/repo.git'",
        ),
      );
    const gitFailure = await materializeCodeRevision(
      {
        layout: codeLayout(),
        artifactsDir: join(root, 'artifacts'),
        reposDir: join(root, 'git-failure'),
        committedRangesDir: join(root, 'committed-ranges'),
        artifactPathsById: new Map(),
      },
      gitDependencies,
    );
    expect(gitFailure).toMatchObject({
      ok: false,
      block: { reason: 'git-credentials-missing' },
    });

    const lfsRepos = join(root, 'lfs');
    await mkdir(join(lfsRepos, 'repo-1', '.git'), { recursive: true });
    await writeFile(
      join(lfsRepos, 'repo-1', '.gitattributes'),
      '*.bin filter=lfs diff=lfs',
    );
    const lfs = await materializeCodeRevision(
      {
        layout: codeLayout(),
        artifactsDir: join(root, 'artifacts'),
        reposDir: lfsRepos,
        committedRangesDir: join(root, 'committed-ranges'),
        artifactPathsById: new Map(),
      },
      codeDependencies(),
    );
    expect(lfs).toMatchObject({
      ok: false,
      block: { reason: 'lfs-unsupported' },
    });
  });

  it.each(['clone', 'fetch'] as const)(
    'preserves transient %s failures instead of reporting missing credentials',
    async (operation) => {
      const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
      const reposDir = join(root, 'repos');
      const transportError = new Error('Git transport timed out');
      const dependencies = codeDependencies();
      if (operation === 'clone') {
        dependencies.cloneRepo = (): Promise<void> =>
          Promise.reject(transportError);
      } else {
        await mkdir(join(reposDir, 'repo-1', '.git'), { recursive: true });
        dependencies.fetchOrigin = (): Promise<void> =>
          Promise.reject(transportError);
      }

      await expect(
        materializeCodeRevision(
          {
            layout: codeLayout(),
            artifactsDir: join(root, 'artifacts'),
            reposDir,
            committedRangesDir: join(root, 'committed-ranges'),
            artifactPathsById: new Map(),
          },
          dependencies,
        ),
      ).rejects.toThrow(transportError);
    },
  );

  it('preserves storage failures after fetching a repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    const storageError = new Error(
      'Shared-container replica storage limit exceeded',
    );

    await expect(
      materializeCodeRevision(
        {
          layout: codeLayout(),
          artifactsDir: join(root, 'artifacts'),
          reposDir: join(root, 'repos'),
          committedRangesDir: join(root, 'committed-ranges'),
          artifactPathsById: new Map(),
          assertStorageAvailable: () => Promise.reject(storageError),
        },
        codeDependencies(),
      ),
    ).rejects.toThrow(storageError);
  });

  it('preserves raw-tree validation failures instead of reporting missing credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    const validationError = new Error('Raw Git tree contains a symbolic link');

    await expect(
      materializeCodeRevision(
        {
          layout: codeLayout(),
          artifactsDir: join(root, 'artifacts'),
          reposDir: join(root, 'repos'),
          committedRangesDir: join(root, 'committed-ranges'),
          artifactPathsById: new Map(),
        },
        {
          ...codeDependencies(),
          cloneRepo: (_remoteUrl, destination) =>
            mkdir(join(destination, '.git'), { recursive: true }).then<void>(
              () => undefined,
            ),
          materializeRawCommit: () => Promise.reject(validationError),
        },
      ),
    ).rejects.toThrow(validationError);
  });

  it('ignores commented-out Git LFS attributes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    const reposDir = join(root, 'repos');
    await mkdir(join(reposDir, 'repo-1', '.git'), { recursive: true });
    await writeFile(
      join(reposDir, 'repo-1', '.gitattributes'),
      '# *.bin filter=lfs diff=lfs\n*.txt text\n',
    );

    await expect(
      materializeCodeRevision(
        {
          layout: codeLayout(),
          artifactsDir: join(root, 'artifacts'),
          reposDir,
          committedRangesDir: join(root, 'committed-ranges'),
          artifactPathsById: new Map(),
        },
        codeDependencies(),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it('fails closed without buffering oversized Git attributes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    const reposDir = join(root, 'repos');
    await mkdir(join(reposDir, 'repo-1', '.git'), { recursive: true });
    await writeFile(
      join(reposDir, 'repo-1', '.gitattributes'),
      Buffer.alloc(1_048_577, 32),
    );

    await expect(
      materializeCodeRevision(
        {
          layout: codeLayout(),
          artifactsDir: join(root, 'artifacts'),
          reposDir,
          committedRangesDir: join(root, 'committed-ranges'),
          artifactPathsById: new Map(),
        },
        codeDependencies(),
      ),
    ).resolves.toMatchObject({
      ok: false,
      block: { reason: 'lfs-unsupported' },
    });
  });

  it('uses the recipient token only for probes and ambient credentials for clone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    const dependencies = codeDependencies();
    const cloneRepo = jest.fn((_remoteUrl: string, destination: string) =>
      mkdir(join(destination, '.git'), { recursive: true }).then(
        () => undefined,
      ),
    );
    const probeRepository = jest.fn(
      (
        _owner: string,
        _repository: string,
        _token: string,
        _signal?: AbortSignal,
      ): Promise<void> => {
        void [_owner, _repository, _token, _signal];
        return Promise.resolve();
      },
    );
    dependencies.cloneRepo = cloneRepo;
    dependencies.probeRepository = probeRepository;

    await expect(
      materializeCodeRevision(
        {
          layout: codeLayout('https://owner-secret@github.com/acme/repo.git'),
          artifactsDir: join(root, 'artifacts'),
          reposDir: join(root, 'repos'),
          committedRangesDir: join(root, 'committed-ranges'),
          artifactPathsById: new Map(),
        },
        dependencies,
      ),
    ).resolves.toEqual({ ok: true });
    expect(probeRepository.mock.calls[0][2]).toBe('recipient-token');
    expect(cloneRepo).toHaveBeenCalledWith(
      'https://github.com/acme/repo.git',
      expect.any(String),
      expect.objectContaining({
        skipLfsSmudge: true,
        timeoutMs: SHARED_CONTAINER_GIT_OPERATION_TIMEOUT_MS,
      }),
    );
    expect(JSON.stringify(cloneRepo.mock.calls)).not.toContain(
      'recipient-token',
    );
    expect(JSON.stringify(cloneRepo.mock.calls)).not.toContain('owner-secret');
  });

  it('fails closed when a repository artifact has no disclosed coordinates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    await expect(
      materializeCodeRevision(
        {
          layout: codeLayout(),
          artifactsDir: join(root, 'artifacts'),
          reposDir: join(root, 'repos'),
          committedRangesDir: join(root, 'committed-ranges'),
          artifactPathsById: new Map([
            ['orphan-artifact', `repos/orphan-repo/files/${'a'.repeat(64)}`],
          ]),
        },
        codeDependencies(),
      ),
    ).rejects.toThrow('no repository coordinates');
  });

  it('makes the managed checkout read-only after applying a revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    const dependencies = codeDependencies();
    dependencies.cloneRepo = (_remoteUrl, destination): Promise<void> =>
      mkdir(join(destination, '.git'), { recursive: true }).then(
        () => undefined,
      );

    await expect(
      materializeCodeRevision(
        {
          layout: codeLayout(),
          artifactsDir: join(root, 'artifacts'),
          reposDir: join(root, 'repos'),
          committedRangesDir: join(root, 'committed-ranges'),
          artifactPathsById: new Map(),
        },
        dependencies,
      ),
    ).resolves.toEqual({ ok: true });

    expect((await stat(join(root, 'repos', 'repo-1'))).mode & 0o222).toBe(0);
    expect(
      (await stat(join(root, 'repos', 'repo-1', '.git'))).mode & 0o222,
    ).toBe(0);
  });

  it('materializes raw commit blobs without checkout filters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    const cloneRepo = jest.fn((_remoteUrl: string, destination: string) =>
      mkdir(join(destination, '.git'), { recursive: true }).then<void>(
        () => undefined,
      ),
    );
    const materializeRawCommit = jest.fn(() =>
      Promise.resolve({ fileCount: 0, totalBytes: BigInt(0) }),
    );
    const dependencies = {
      ...codeDependencies(),
      cloneRepo,
      materializeRawCommit,
    } as MaterializeCodeDependencies;

    await materializeCodeRevision(
      {
        layout: codeLayout(),
        artifactsDir: join(root, 'artifacts'),
        reposDir: join(root, 'repos'),
        committedRangesDir: join(root, 'committed-ranges'),
        artifactPathsById: new Map(),
      },
      dependencies,
    );

    expect(cloneRepo).toHaveBeenCalledWith(
      'https://github.com/acme/repo.git',
      join(root, 'repos', 'repo-1'),
      expect.objectContaining({
        skipLfsSmudge: true,
        timeoutMs: SHARED_CONTAINER_GIT_OPERATION_TIMEOUT_MS,
      }),
    );
    expect(materializeRawCommit).toHaveBeenCalledWith(
      join(root, 'repos', 'repo-1'),
      'a'.repeat(40),
      expect.objectContaining({
        timeoutMs: SHARED_CONTAINER_GIT_OPERATION_TIMEOUT_MS,
      }),
    );
  });

  it('passes the replica abort signal and a bounded timeout to clone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    const controller = new AbortController();
    const cloneRepo = jest.fn((_remoteUrl: string, destination: string) =>
      mkdir(join(destination, '.git'), { recursive: true }).then<void>(
        () => undefined,
      ),
    );

    await materializeCodeRevision(
      {
        layout: codeLayout(),
        artifactsDir: join(root, 'artifacts'),
        reposDir: join(root, 'repos'),
        committedRangesDir: join(root, 'committed-ranges'),
        artifactPathsById: new Map(),
        signal: controller.signal,
      },
      { ...codeDependencies(), cloneRepo },
    );

    expect(cloneRepo).toHaveBeenCalledWith(
      'https://github.com/acme/repo.git',
      join(root, 'repos', 'repo-1'),
      expect.objectContaining({
        signal: controller.signal,
        timeoutMs: SHARED_CONTAINER_GIT_OPERATION_TIMEOUT_MS,
      }),
    );
  });

  it('rejects aggregate repository projection amplification before copying', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    const repoDir = join(root, 'repos', 'repo-1');
    const artifactsDir = join(root, 'artifacts');
    const artifactPath = `repos/repo-1/files/${'a'.repeat(64)}`;
    await mkdir(join(repoDir, '.git'), { recursive: true });
    await mkdir(join(artifactsDir, 'repos', 'repo-1', 'files'), {
      recursive: true,
    });
    await writeFile(join(artifactsDir, ...artifactPath.split('/')), 'small');
    const layout = codeLayout();
    layout.repositories[0].files = Array.from({ length: 21 }, (_, index) => ({
      path: `copies/${index}.bin`,
      status: 'added' as const,
      artifactId: 'shared-artifact',
      mode: '100644',
    }));

    await expect(
      materializeCodeRevision(
        {
          layout,
          artifactsDir,
          reposDir: join(root, 'repos'),
          committedRangesDir: join(root, 'committed-ranges'),
          artifactPathsById: new Map([['shared-artifact', artifactPath]]),
          artifactSizesById: new Map([
            ['shared-artifact', BigInt(MAX_SHARED_CONTAINER_ARTIFACT_BYTES)],
          ]),
        },
        codeDependencies(),
      ),
    ).rejects.toThrow('projection byte limit');
    await expect(stat(join(repoDir, 'copies'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('materializes a base tree far larger than the removed checkout budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    const cloneRepo = jest.fn((_remoteUrl: string, destination: string) =>
      mkdir(join(destination, '.git'), { recursive: true }).then<void>(
        () => undefined,
      ),
    );
    // A repository the retired base-checkout budget rejected outright: far more
    // entries than the old 64 KiB-per-entry reservation allowed, and more bytes
    // than the old ceiling. The recipient already holds authenticated GitHub
    // access to every one of these blobs and has accepted the share, so size is
    // no longer a reason to refuse.
    const baseUsage = {
      fileCount: 20_000,
      totalBytes: BigInt(900 * 1024 * 1024),
    };
    const inspectRepositoryTree = jest.fn(() => Promise.resolve(baseUsage));
    const materializeRawCommit = jest.fn(() => Promise.resolve(baseUsage));

    await expect(
      materializeCodeRevision(
        {
          layout: codeLayout(),
          artifactsDir: join(root, 'artifacts'),
          reposDir: join(root, 'repos'),
          committedRangesDir: join(root, 'committed-ranges'),
          artifactPathsById: new Map(),
        },
        {
          ...codeDependencies(),
          cloneRepo,
          inspectRepositoryTree,
          materializeRawCommit,
        },
      ),
    ).resolves.toEqual({ ok: true });
    expect(cloneRepo).toHaveBeenCalledTimes(1);
    expect(materializeRawCommit).toHaveBeenCalledTimes(1);
  });

  it('keeps content usage independent from the base checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    const repoDir = join(root, 'repos', 'repo-1');
    await mkdir(join(repoDir, '.git'), { recursive: true });
    const inspectRepositoryTree = jest.fn(() =>
      Promise.resolve({
        fileCount: 1,
        totalBytes: BigInt(2),
      }),
    );
    const options = {
      layout: codeLayout(),
      artifactsDir: join(root, 'artifacts'),
      reposDir: join(root, 'repos'),
      committedRangesDir: join(root, 'committed-ranges'),
      artifactPathsById: new Map<string, string>(),
      initialProjectionUsage: {
        files: 1,
        bytes: BigInt(MAX_SHARED_CONTAINER_MATERIALIZED_BYTES) - BigInt(1),
      },
    } as Parameters<typeof materializeCodeRevision>[0] & {
      initialProjectionUsage: { files: number; bytes: bigint };
    };

    await expect(
      materializeCodeRevision(options, {
        ...codeDependencies(),
        inspectRepositoryTree,
        materializeRawCommit: () =>
          Promise.resolve({ fileCount: 1, totalBytes: BigInt(2) }),
      }),
    ).resolves.toEqual({ ok: true });
    expect(inspectRepositoryTree).toHaveBeenCalledTimes(1);
  });

  it('fetches before replacing a prior managed projection with raw blobs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    await mkdir(join(root, 'repos', 'repo-1', '.git'), { recursive: true });
    const fetchOrigin = jest.fn(() => Promise.resolve());
    const materializeRawCommit = jest.fn(() =>
      Promise.resolve({ fileCount: 0, totalBytes: BigInt(0) }),
    );
    const dependencies = {
      ...codeDependencies(),
      fetchOrigin,
      materializeRawCommit,
    } as MaterializeCodeDependencies;

    await materializeCodeRevision(
      {
        layout: codeLayout(),
        artifactsDir: join(root, 'artifacts'),
        reposDir: join(root, 'repos'),
        committedRangesDir: join(root, 'committed-ranges'),
        artifactPathsById: new Map(),
      },
      dependencies,
    );

    expect(fetchOrigin.mock.invocationCallOrder[0]).toBeLessThan(
      materializeRawCommit.mock.invocationCallOrder[0] ??
        Number.MAX_SAFE_INTEGER,
    );
  });

  it('applies full modified and added blobs, deletes files, and ignores executable modes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    const fixture = buildSharedContainerDirtyFileFixture();
    const repoDir = join(root, 'repos', 'repo-1');
    const artifactsDir = join(root, 'artifacts');
    await mkdir(join(repoDir, '.git'), { recursive: true });
    await mkdir(join(repoDir, 'src'), { recursive: true });
    await writeFile(join(repoDir, 'src', 'modified.ts'), 'before\n');
    await writeFile(join(repoDir, 'src', 'deleted.ts'), 'delete me\n');
    for (const blob of fixture.blobs) {
      const destination = join(artifactsDir, ...blob.path.split('/'));
      await mkdir(join(destination, '..'), { recursive: true });
      await writeFile(destination, blob.bytes);
    }

    await materializeCodeRevision(
      {
        layout: fixture.layout,
        artifactsDir,
        reposDir: join(root, 'repos'),
        committedRangesDir: join(root, 'committed-ranges'),
        artifactPathsById: new Map(
          fixture.blobs.map((blob) => [blob.artifactId, blob.path]),
        ),
      },
      codeDependencies(),
    );

    expect(await readFile(join(repoDir, 'src', 'modified.ts'), 'utf8')).toBe(
      'export const changed = true;\n',
    );
    expect(await readFile(join(repoDir, 'src', 'added.ts'), 'utf8')).toBe(
      'export const added = true;\n',
    );
    await expect(
      stat(join(repoDir, 'src', 'deleted.ts')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(join(repoDir, 'src', 'added.ts'))).mode & 0o111).toBe(
      0o100,
    );
  });

  it.each([
    ['modified', '.git/config'],
    ['deleted', '.git/config'],
    ['modified', '.GIT/config'],
  ] as const)(
    'rejects a %s overlay targeting reserved Git metadata at %s',
    async (status, overlayPath) => {
      const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
      const repoDir = join(root, 'repos', 'repo-1');
      const artifactsDir = join(root, 'artifacts');
      const artifactPath = `repos/repo-1/files/${'a'.repeat(64)}`;
      await mkdir(join(repoDir, '.git'), { recursive: true });
      await writeFile(join(repoDir, '.git', 'config'), 'trusted\n');
      await mkdir(join(artifactsDir, 'repos', 'repo-1', 'files'), {
        recursive: true,
      });
      await writeFile(
        join(artifactsDir, ...artifactPath.split('/')),
        'publisher-controlled\n',
      );
      const layout = codeLayout();
      layout.repositories[0].files = [
        {
          path: overlayPath,
          status,
          ...(status === 'deleted' ? {} : { artifactId: 'overlay-artifact' }),
          mode: '100644',
        },
      ];

      await expect(
        materializeCodeRevision(
          {
            layout,
            artifactsDir,
            reposDir: join(root, 'repos'),
            committedRangesDir: join(root, 'committed-ranges'),
            artifactPathsById:
              status === 'deleted'
                ? new Map()
                : new Map([['overlay-artifact', artifactPath]]),
          },
          codeDependencies(),
        ),
      ).rejects.toThrow('Git metadata');
      await expect(
        readFile(join(repoDir, '.git', 'config'), 'utf8'),
      ).resolves.toBe('trusted\n');
    },
  );

  it('replaces a base-commit symlink when the overlay changes it to a regular file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    const repoDir = join(root, 'repos', 'repo-1');
    const artifactsDir = join(root, 'artifacts');
    const outsideDir = join(root, 'outside');
    const outsideFile = join(outsideDir, 'protected.txt');
    const artifactPath = `repos/repo-1/files/${'a'.repeat(64)}`;
    await mkdir(join(repoDir, '.git'), { recursive: true });
    await mkdir(join(artifactsDir, 'repos', 'repo-1', 'files'), {
      recursive: true,
    });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(outsideFile, 'protected\n');
    await writeFile(join(artifactsDir, ...artifactPath.split('/')), 'owned\n');
    await symlink(outsideFile, join(repoDir, 'changed.txt'));
    const layout = codeLayout();
    layout.repositories[0].files = [
      {
        path: 'changed.txt',
        status: 'modified',
        artifactId: 'overlay-artifact',
        mode: '100644',
      },
    ];

    await expect(
      materializeCodeRevision(
        {
          layout,
          artifactsDir,
          reposDir: join(root, 'repos'),
          committedRangesDir: join(root, 'committed-ranges'),
          artifactPathsById: new Map([['overlay-artifact', artifactPath]]),
        },
        codeDependencies(),
      ),
    ).resolves.toEqual({ ok: true });
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('protected\n');
    await expect(readFile(join(repoDir, 'changed.txt'), 'utf8')).resolves.toBe(
      'owned\n',
    );
    const materialized = await stat(join(repoDir, 'changed.txt'));
    expect(materialized.isFile()).toBe(true);
  });

  it('materializes an in-repository symlink overlay and rejects an escaping target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    const repoDir = join(root, 'repos', 'repo-1');
    const artifactsDir = join(root, 'artifacts');
    const artifactPath = 'repos/repo-1/files/link-target';
    await mkdir(join(repoDir, '.git'), { recursive: true });
    await mkdir(join(artifactsDir, 'repos', 'repo-1', 'files'), {
      recursive: true,
    });
    await writeFile(
      join(artifactsDir, ...artifactPath.split('/')),
      'target.txt',
    );
    await writeFile(join(repoDir, 'target.txt'), 'target');
    const layout = codeLayout();
    layout.repositories[0].files = [
      {
        path: 'link.txt',
        status: 'added',
        mode: '120000',
        artifactId: 'link-artifact',
      },
    ];

    await expect(
      materializeCodeRevision(
        {
          layout,
          artifactsDir,
          reposDir: join(root, 'repos'),
          committedRangesDir: join(root, 'committed-ranges'),
          artifactPathsById: new Map([['link-artifact', artifactPath]]),
        },
        codeDependencies(),
      ),
    ).resolves.toEqual({ ok: true });
    await expect(readlink(join(repoDir, 'link.txt'))).resolves.toBe(
      'target.txt',
    );

    await writeFile(
      join(artifactsDir, ...artifactPath.split('/')),
      'missing-\uFFFD.txt',
    );
    await expect(
      materializeCodeRevision(
        {
          layout,
          artifactsDir,
          reposDir: join(root, 'repos'),
          committedRangesDir: join(root, 'committed-ranges'),
          artifactPathsById: new Map([['link-artifact', artifactPath]]),
        },
        codeDependencies(),
      ),
    ).resolves.toEqual({ ok: true });
    await expect(readlink(join(repoDir, 'link.txt'))).resolves.toBe(
      'missing-\uFFFD.txt',
    );

    await writeFile(
      join(artifactsDir, ...artifactPath.split('/')),
      `${'nested/'.repeat(200)}target.txt`,
    );
    await expect(
      materializeCodeRevision(
        {
          layout,
          artifactsDir,
          reposDir: join(root, 'repos'),
          committedRangesDir: join(root, 'committed-ranges'),
          artifactPathsById: new Map([['link-artifact', artifactPath]]),
        },
        codeDependencies(),
      ),
    ).rejects.toThrow('Invalid symbolic link target');

    await writeFile(
      join(artifactsDir, ...artifactPath.split('/')),
      '../escape',
    );
    await expect(
      materializeCodeRevision(
        {
          layout,
          artifactsDir,
          reposDir: join(root, 'repos'),
          committedRangesDir: join(root, 'committed-ranges'),
          artifactPathsById: new Map([['link-artifact', artifactPath]]),
        },
        codeDependencies(),
      ),
    ).rejects.toThrow('Invalid symbolic link target');
  });

  it.each([
    ['publisher order', false],
    ['reversed authenticated order', true],
  ] as const)(
    'replaces a nested tracked directory with an in-repository symlink overlay in %s',
    async (_label, reverseOperations) => {
      const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
      const repoDir = join(root, 'repos', 'repo-1');
      const artifactsDir = join(root, 'artifacts');
      const artifactPath = 'repos/repo-1/files/link-target';
      await mkdir(join(repoDir, '.git'), { recursive: true });
      await mkdir(join(repoDir, 'linked', 'nested'), { recursive: true });
      await writeFile(
        join(repoDir, 'linked', 'nested', 'removed.txt'),
        'removed',
      );
      await mkdir(join(artifactsDir, 'repos', 'repo-1', 'files'), {
        recursive: true,
      });
      await writeFile(
        join(artifactsDir, ...artifactPath.split('/')),
        'target.txt',
      );
      await writeFile(join(repoDir, 'target.txt'), 'target');
      const deletion = {
        path: 'linked/nested/removed.txt',
        status: 'deleted' as const,
        mode: '100644',
      };
      const replacement = {
        path: 'linked',
        status: 'modified' as const,
        mode: '120000',
        artifactId: 'link-artifact',
      };
      const layout = codeLayout();
      layout.repositories[0].files = reverseOperations
        ? [replacement, deletion]
        : [deletion, replacement];

      await expect(
        materializeCodeRevision(
          {
            layout,
            artifactsDir,
            reposDir: join(root, 'repos'),
            committedRangesDir: join(root, 'committed-ranges'),
            artifactPathsById: new Map([['link-artifact', artifactPath]]),
          },
          codeDependencies(),
        ),
      ).resolves.toEqual({ ok: true });
      await expect(readlink(join(repoDir, 'linked'))).resolves.toBe(
        'target.txt',
      );
    },
  );

  it('returns a clean Windows block for a symlink overlay', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const layout = codeLayout();
      layout.repositories[0].files = [
        {
          path: 'link.txt',
          status: 'added',
          mode: '120000',
          artifactId: 'link-artifact',
        },
      ];
      await expect(
        materializeCodeRevision(
          {
            layout,
            artifactsDir: '/unused/artifacts',
            reposDir: '/unused/repos',
            committedRangesDir: '/unused/committed-ranges',
            artifactPathsById: new Map([
              ['link-artifact', 'repos/repo-1/files/link-target'],
            ]),
          },
          codeDependencies(),
        ),
      ).resolves.toMatchObject({
        ok: false,
        block: { reason: 'symlink-unsupported' },
      });
    } finally {
      if (originalPlatform)
        Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('returns a clean Windows block for a symlink in a snapshot base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    const sourceRepository = join(root, 'source');
    await mkdir(sourceRepository, { recursive: true });
    await execFileAsync('git', ['init'], { cwd: sourceRepository });
    await execFileAsync('git', ['config', 'user.name', 'Test'], {
      cwd: sourceRepository,
    });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: sourceRepository,
    });
    await writeFile(join(sourceRepository, 'target.txt'), 'target\n');
    await symlink('target.txt', join(sourceRepository, 'linked.txt'));
    await execFileAsync('git', ['add', '.'], { cwd: sourceRepository });
    await execFileAsync('git', ['commit', '-m', 'snapshot with symlink'], {
      cwd: sourceRepository,
    });
    const baseCommitSha = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: sourceRepository,
      })
    ).stdout.trim();
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    // The simulated platform should affect symlink policy, not Git discovery
    // on the host running this test.
    const resolveGitExecutable = jest
      .spyOn(gitExecutable, 'getResolvedGitExecutableForSpawn')
      .mockResolvedValue('git');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const artifactsDir = join(root, 'artifacts');
      const snapshotHash = 'c'.repeat(64);
      const snapshotPath = `repos/repo-1/snapshot/${snapshotHash}`;
      await mkdir(join(artifactsDir, 'repos', 'repo-1', 'snapshot'), {
        recursive: true,
      });
      await writeFile(join(artifactsDir, snapshotPath), 'bundle');
      const layout: SharedContainerRevisionLayoutV2 = {
        schemaVersion: 2,
        containerType: 'CODE_WORKTREE',
        title: 'Snapshot with symlink',
        repositories: [
          {
            repoId: 'repo-1',
            repoName: 'repo',
            source: 'snapshot',
            baseCommitSha,
            snapshot: {
              bundleArtifactIds: ['snapshot-bundle'],
              treeFileCount: 2,
              treeBytes: '100',
            },
            files: [],
          },
        ],
        files: [],
        notes: [],
        prompts: [],
        attachmentPaths: {},
      };
      await expect(
        materializeCodeRevision(
          {
            layout,
            artifactsDir,
            reposDir: join(root, 'repos'),
            committedRangesDir: join(root, 'committed-ranges'),
            artifactPathsById: new Map([['snapshot-bundle', snapshotPath]]),
          },
          {
            ...codeDependencies(),
            prepareSnapshot: (_bundle, destination) =>
              execFileAsync(
                'git',
                ['clone', '--no-checkout', sourceRepository, destination],
                { cwd: root },
              ).then(() => undefined),
            materializeRawCommit: (repoPath, sha, operationOptions) =>
              materializeGitCommitRaw(repoPath, sha, {
                ...operationOptions,
                resolveDestination: (relativePath) =>
                  join(repoPath, ...relativePath.split('/')),
              }),
          },
        ),
      ).resolves.toMatchObject({
        ok: false,
        block: { reason: 'symlink-unsupported' },
      });
      await expect(stat(join(root, 'repos', 'repo-1'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      if (originalPlatform)
        Object.defineProperty(process, 'platform', originalPlatform);
      resolveGitExecutable.mockRestore();
      await makeReplicaTreeWritable(join(root, 'repos', 'repo-1'));
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a publisher-controlled parent symlink before applying an overlay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
    const repoDir = join(root, 'repos', 'repo-1');
    const artifactsDir = join(root, 'artifacts');
    const outsideDir = join(root, 'outside');
    const outsideFile = join(outsideDir, 'protected.txt');
    const artifactPath = `repos/repo-1/files/${'a'.repeat(64)}`;
    await mkdir(join(repoDir, '.git'), { recursive: true });
    await mkdir(join(artifactsDir, 'repos', 'repo-1', 'files'), {
      recursive: true,
    });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(outsideFile, 'protected\n');
    await writeFile(join(artifactsDir, ...artifactPath.split('/')), 'owned\n');

    const overlayPath = 'linked/escape.txt';
    await symlink(outsideDir, join(repoDir, 'linked'), 'dir');
    const layout = codeLayout();
    layout.repositories[0].files = [
      {
        path: overlayPath,
        status: 'modified',
        artifactId: 'overlay-artifact',
        mode: '100644',
      },
    ];

    await expect(
      materializeCodeRevision(
        {
          layout,
          artifactsDir,
          reposDir: join(root, 'repos'),
          committedRangesDir: join(root, 'committed-ranges'),
          artifactPathsById: new Map([['overlay-artifact', artifactPath]]),
        },
        codeDependencies(),
      ),
    ).rejects.toThrow('symbolic link');
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('protected\n');
  });

  it('bounds recipient diffs without dropping large base blobs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-container-large-diff-'));
    const store = new SharedContainerReplicaStore(root);
    await store.set({
      status: 'available',
      containerId: 'container-1',
      organizationId: 'org-1',
      containerType: 'CODE_WORKTREE',
      revisionId: 'revision-1',
      revision: 1,
      revisionCreatedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    const revisionRoot = join(root, 'container-1', 'revisions', 'revision-1');
    const repositoryRoot = join(revisionRoot, 'repos', 'repo-1');
    await mkdir(repositoryRoot, { recursive: true });
    await execFileAsync('git', ['init'], { cwd: repositoryRoot });
    const filePath = join(repositoryRoot, 'large.txt');
    await writeFile(filePath, 'a'.repeat(8 * 1024 * 1024 + 1024));
    await execFileAsync('git', ['add', '--', 'large.txt'], {
      cwd: repositoryRoot,
    });
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=Canopy Test',
        '-c',
        'user.email=canopy@example.invalid',
        'commit',
        '-m',
        'base',
      ],
      { cwd: repositoryRoot },
    );
    await writeFile(filePath, 'new value\n');
    const layout: SharedContainerRevisionLayout = {
      schemaVersion: 1,
      containerType: 'CODE_WORKTREE',
      title: 'Feature branch',
      repositories: [
        {
          repoId: 'repo-1',
          repoName: 'repository',
          remoteUrl: 'https://github.com/acme/repository.git',
          owner: 'acme',
          repository: 'repository',
          baseCommitSha: 'a'.repeat(40),
          files: [
            {
              path: 'large.txt',
              status: 'modified',
              artifactId: 'large-artifact',
              mode: '100644',
            },
          ],
        },
      ],
      files: [],
      notes: [],
      prompts: [],
      attachmentPaths: {},
    };
    await mkdir(join(revisionRoot, 'artifacts'), { recursive: true });
    await writeFile(
      join(revisionRoot, 'artifacts', 'container.json'),
      JSON.stringify(layout),
    );

    await expect(
      new SharedContainerReader(store).readOverlayDiff({
        containerId: 'container-1',
        revisionId: 'revision-1',
        repoId: 'repo-1',
        path: 'large.txt',
      }),
    ).resolves.toEqual({
      oldValue: 'a'.repeat(500_000),
      newValue: 'new value\n',
      truncated: true,
      binary: false,
    });
  });

  it('projects list summaries immediately and bounds attachment previews', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'shared-container-bounded-read-'),
    );
    const store = new SharedContainerReplicaStore(root);
    await store.set({
      status: 'available',
      containerId: 'container-1',
      organizationId: 'org-1',
      containerType: 'CODE_WORKTREE',
      revisionId: 'revision-1',
      revision: 1,
      revisionCreatedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    const revisionRoot = join(root, 'container-1', 'revisions', 'revision-1');
    await mkdir(join(revisionRoot, 'artifacts', 'chats'), { recursive: true });
    await mkdir(join(revisionRoot, 'content', 'attachments'), {
      recursive: true,
    });
    const layout = codeLayout();
    layout.attachmentPaths = {
      'attachment-1': {
        artifactId: `attachments/${'a'.repeat(64)}`,
        displayName: 'large.txt',
      },
    };
    await writeFile(
      join(revisionRoot, 'artifacts', 'container.json'),
      JSON.stringify(layout),
    );
    await writeFile(
      join(revisionRoot, 'artifacts', 'chats', 'chat-1.json'),
      JSON.stringify({
        schemaVersion: 1,
        chatId: 'chat-1',
        title: 'First chat',
        createdAt: '2026-09-01T00:00:00.000Z',
        messages: [],
      }),
    );
    await writeFile(
      join(revisionRoot, 'artifacts', 'chats', 'chat-2.json'),
      JSON.stringify({
        schemaVersion: 1,
        chatId: 'chat-1',
        title: 'Second chat',
        createdAt: '2026-09-01T00:00:01.000Z',
        messages: [],
      }),
    );
    const previewLimit = 256 * 1024;
    await writeFile(
      join(revisionRoot, 'content', 'attachments', 'large.txt'),
      'x'.repeat(previewLimit + 1),
    );

    const reader = new SharedContainerReader(store);
    const readerInternals = reader as unknown as {
      readJson: (readRoot: string, target: string) => Promise<unknown>;
    };
    const originalReadJson = readerInternals.readJson.bind(reader);
    let firstParsed: { title: string } | null = null;
    readerInternals.readJson = async (readRoot, target): Promise<unknown> => {
      const value = await originalReadJson(readRoot, target);
      if (target.endsWith('chat-1.json')) {
        firstParsed = value as { title: string };
      } else if (target.endsWith('chat-2.json') && firstParsed !== null) {
        firstParsed.title = 'retained until the entire page was parsed';
      }
      return value;
    };

    await expect(
      reader.listChats({
        containerId: 'container-1',
        revisionId: 'revision-1',
      }),
    ).resolves.toMatchObject({
      items: [
        { chatId: 'chat-1', title: 'First chat' },
        { chatId: 'chat-1', title: 'Second chat' },
      ],
    });
    readerInternals.readJson = originalReadJson;
    await expect(
      reader.readForkChats({
        containerId: 'container-1',
        revisionId: 'revision-1',
      }),
    ).resolves.toMatchObject([
      {
        artifactChatId: 'chat-1',
        chat: { chatId: 'chat-1', title: 'First chat' },
      },
      {
        artifactChatId: 'chat-2',
        chat: { chatId: 'chat-1', title: 'Second chat' },
      },
    ]);
    await expect(
      reader.readAttachment({
        containerId: 'container-1',
        revisionId: 'revision-1',
        attachmentId: 'attachment-1',
      }),
    ).resolves.toMatchObject({
      displayName: 'large.txt',
      data: { byteLength: previewLimit },
      sizeBytes: String(previewLimit + 1),
      truncated: true,
    });

    await writeFile(
      join(revisionRoot, 'content', 'attachments', 'large.txt'),
      Buffer.concat([
        Buffer.from('x'.repeat(previewLimit - 1)),
        Buffer.from('€tail'),
      ]),
    );
    const utf8SafePreview = await reader.readAttachment({
      containerId: 'container-1',
      revisionId: 'revision-1',
      attachmentId: 'attachment-1',
    });
    expect(utf8SafePreview).toMatchObject({
      data: { byteLength: previewLimit - 1 },
      sizeBytes: String(previewLimit + 6),
      truncated: true,
    });
    expect(
      new TextDecoder('utf-8', { fatal: true }).decode(utf8SafePreview.data),
    ).toBe('x'.repeat(previewLimit - 1));

    await writeFile(
      join(revisionRoot, 'content', 'attachments', 'large.txt'),
      Buffer.concat([
        Buffer.from('x'.repeat(previewLimit - 2)),
        Buffer.from([0xe2, 0x82, 0x41]),
      ]),
    );
    const invalidContinuationPreview = await reader.readAttachment({
      containerId: 'container-1',
      revisionId: 'revision-1',
      attachmentId: 'attachment-1',
    });
    expect(invalidContinuationPreview).toMatchObject({
      data: { byteLength: previewLimit },
      sizeBytes: String(previewLimit + 1),
      truncated: true,
    });
    expect(() =>
      new TextDecoder('utf-8', { fatal: true }).decode(
        invalidContinuationPreview.data,
      ),
    ).toThrow();

    await writeFile(
      join(revisionRoot, 'content', 'attachments', 'large.txt'),
      Buffer.concat([
        Buffer.from('x'.repeat(previewLimit - 1)),
        Buffer.from([0xe0, 0x80, 0x80, 0x41]),
      ]),
    );
    const overlongPreview = await reader.readAttachment({
      containerId: 'container-1',
      revisionId: 'revision-1',
      attachmentId: 'attachment-1',
    });
    expect(overlongPreview).toMatchObject({
      data: { byteLength: previewLimit },
      sizeBytes: String(previewLimit + 3),
      truncated: true,
    });
    expect(() =>
      new TextDecoder('utf-8', { fatal: true }).decode(overlongPreview.data),
    ).toThrow();
  });

  it('lists and reads materialized Cowork files through the read-only file panels', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-container-cowork-read-'));
    const store = new SharedContainerReplicaStore(root);
    await store.set({
      status: 'available',
      containerId: 'container-1',
      organizationId: 'org-1',
      containerType: 'COWORK_WORK_ENTRY',
      revisionId: 'revision-1',
      revision: 1,
      revisionCreatedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    const revisionRoot = join(root, 'container-1', 'revisions', 'revision-1');
    const contentRoot = join(revisionRoot, 'content');
    await mkdir(join(revisionRoot, 'artifacts'), { recursive: true });
    await mkdir(join(contentRoot, 'exports'), { recursive: true });
    const layout: SharedContainerRevisionLayout = {
      schemaVersion: 1,
      containerType: 'COWORK_WORK_ENTRY',
      title: 'Customer follow-up',
      repositories: [],
      files: [
        {
          path: 'exports/summary.txt',
          status: 'added',
          artifactId: 'summary-artifact',
          sizeBytes: '17',
        },
      ],
      notes: [],
      prompts: [],
      attachmentPaths: {},
    };
    await writeFile(
      join(revisionRoot, 'artifacts', 'container.json'),
      JSON.stringify(layout),
    );
    const filePath = join(contentRoot, 'exports', 'summary.txt');
    await writeFile(filePath, 'Customer summary\n');
    const reader = new SharedContainerReader(store);

    // The viewer projection names the Cowork file root, and every standard
    // panel (Changes, file diff) passes that id back to the reader. The two
    // must agree or a published file-diff tab fails to open.
    const [viewerRoot] = await resolveSharedContainerViewerReadRoots(
      'container-1',
      reader,
    );
    expect(viewerRoot?.repoId).toBe(COWORK_WORKSPACE_FILE_ROOT_ID);

    await expect(
      reader.listRepositories({
        containerId: 'container-1',
        revisionId: 'revision-1',
      }),
    ).resolves.toEqual([
      { repoId: COWORK_WORKSPACE_FILE_ROOT_ID, repoName: 'Workspace' },
    ]);
    await expect(
      reader.listRepositoryTree({
        containerId: 'container-1',
        revisionId: 'revision-1',
        repoId: COWORK_WORKSPACE_FILE_ROOT_ID,
      }),
    ).resolves.toEqual({
      items: [
        {
          repoId: COWORK_WORKSPACE_FILE_ROOT_ID,
          path: 'exports',
          kind: 'directory',
        },
        {
          repoId: COWORK_WORKSPACE_FILE_ROOT_ID,
          path: 'exports/summary.txt',
          kind: 'file',
          sizeBytes: '17',
          status: 'added',
          source: 'uncommitted',
        },
      ],
      nextCursor: null,
      truncated: false,
    });
    await expect(
      reader.readOverlayDiff({
        containerId: 'container-1',
        revisionId: 'revision-1',
        repoId: COWORK_WORKSPACE_FILE_ROOT_ID,
        path: 'exports/summary.txt',
      }),
    ).resolves.toEqual({
      oldValue: '',
      newValue: 'Customer summary\n',
      truncated: false,
      binary: false,
    });

    await execFileAsync('git', ['init'], { cwd: contentRoot });
    await writeFile(filePath, 'Untrusted Cowork Git base\n');
    await execFileAsync('git', ['add', '--', 'exports/summary.txt'], {
      cwd: contentRoot,
    });
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=Canopy Test',
        '-c',
        'user.email=canopy@example.invalid',
        'commit',
        '-m',
        'untrusted base',
      ],
      { cwd: contentRoot },
    );
    await writeFile(filePath, 'Customer summary\n');
    await expect(
      reader.readOverlayDiff({
        containerId: 'container-1',
        revisionId: 'revision-1',
        repoId: COWORK_WORKSPACE_FILE_ROOT_ID,
        path: 'exports/summary.txt',
      }),
    ).resolves.toEqual({
      oldValue: '',
      newValue: 'Customer summary\n',
      truncated: false,
      binary: false,
    });

    await writeFile(filePath, 'x'.repeat(500_001));
    const bounded = await reader.readOverlayDiff({
      containerId: 'container-1',
      revisionId: 'revision-1',
      repoId: COWORK_WORKSPACE_FILE_ROOT_ID,
      path: 'exports/summary.txt',
    });
    expect(bounded.newValue).toHaveLength(500_000);
    expect(bounded).toMatchObject({
      oldValue: '',
      truncated: true,
      binary: false,
    });
    await writeFile(filePath, 'Customer summary\n');

    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'private\n');
    await unlink(filePath);
    await symlink(outside, filePath);
    await expect(
      reader.readOverlayDiff({
        containerId: 'container-1',
        revisionId: 'revision-1',
        repoId: COWORK_WORKSPACE_FILE_ROOT_ID,
        path: 'exports/summary.txt',
      }),
    ).rejects.toThrow(/symbolic link/i);

    // An empty Cowork snapshot is still a readable Files repository. Keeping
    // the synthetic repository lets the recipient distinguish a genuinely
    // empty or all-withheld share from unavailable repository content.
    await writeFile(
      join(revisionRoot, 'artifacts', 'container.json'),
      JSON.stringify({ ...layout, files: [], withheldFileCount: 1 }),
    );
    await expect(
      reader.listRepositories({
        containerId: 'container-1',
        revisionId: 'revision-1',
      }),
    ).resolves.toEqual([
      { repoId: COWORK_WORKSPACE_FILE_ROOT_ID, repoName: 'Workspace' },
    ]);
  });

  it('reads validated recipient content and refuses to follow a replaced replica leaf', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-container-read-'));
    const store = new SharedContainerReplicaStore(root);
    await store.set({
      status: 'available',
      containerId: 'container-1',
      organizationId: 'org-1',
      containerType: 'COWORK_WORK_ENTRY',
      revisionId: 'revision-1',
      revision: 1,
      revisionCreatedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    const revisionRoot = join(root, 'container-1', 'revisions', 'revision-1');
    await mkdir(join(revisionRoot, 'artifacts', 'chats'), { recursive: true });
    await mkdir(join(revisionRoot, 'content', 'notes'), { recursive: true });
    const layout: SharedContainerRevisionLayout = {
      schemaVersion: 1,
      containerType: 'CODE_WORKTREE',
      title: 'Feature branch',
      repositories: [
        {
          repoId: 'repo-1',
          repoName: 'repository',
          remoteUrl: 'https://github.com/acme/repository.git',
          owner: 'acme',
          repository: 'repository',
          baseCommitSha: 'a'.repeat(40),
          files: [
            {
              path: 'src/current.ts',
              status: 'modified',
              artifactId: 'current-artifact',
              mode: '100644',
            },
            {
              path: 'src/deleted.ts',
              status: 'deleted',
              mode: '100644',
            },
          ],
        },
      ],
      files: [],
      notes: [{ itemId: 'note-1', title: 'Note' }],
      prompts: [],
      attachmentPaths: {},
    };
    await writeFile(
      join(revisionRoot, 'artifacts', 'container.json'),
      JSON.stringify(layout),
    );
    await writeFile(
      join(revisionRoot, 'artifacts', 'chats', 'chat-1.json'),
      JSON.stringify({
        schemaVersion: 1,
        chatId: 'chat-1',
        title: 'Chat',
        createdAt: '2026-09-01T00:00:00.000Z',
        messages: [],
      }),
    );
    await writeFile(
      join(revisionRoot, 'artifacts', 'chats', 'chat-2.json'),
      '{ invalid second-page JSON',
    );
    const notePath = join(revisionRoot, 'content', 'notes', 'note-1.md');
    await writeFile(notePath, '# Safe note\n');
    await mkdir(join(revisionRoot, 'repos', 'repo-1', 'src'), {
      recursive: true,
    });
    await writeFile(
      join(revisionRoot, 'repos', 'repo-1', 'src', 'current.ts'),
      'export const current = true;\n',
    );
    await writeFile(
      join(revisionRoot, 'repos', 'repo-1', 'src', 'unshared.ts'),
      'export const unshared = true;\n',
    );
    const reader = new SharedContainerReader(store);

    await expect(
      (
        reader as unknown as {
          readRevisionMetadata: (request: {
            containerId: string;
            revisionId: string;
          }) => Promise<{ title: string }>;
        }
      ).readRevisionMetadata({
        containerId: 'container-1',
        revisionId: 'revision-1',
      }),
    ).resolves.toEqual({ title: 'Feature branch' });

    await expect(
      reader.listRepositories({
        containerId: 'container-1',
        revisionId: 'revision-1',
      }),
    ).resolves.toEqual([
      // CAN-2551: the base commit crosses the reader boundary so an empty
      // share can name the point in history it is empty relative to. This
      // layout declares no `baseBranch`, so the field is absent rather than
      // null.
      {
        repoId: 'repo-1',
        repoName: 'repository',
        baseCommitSha: 'a'.repeat(40),
      },
    ]);
    await expect(
      reader.listChats({
        containerId: 'container-1',
        revisionId: 'revision-1',
        limit: 1,
      }),
    ).resolves.toMatchObject({
      items: [{ chatId: 'chat-1', title: 'Chat' }],
      nextCursor: Buffer.from('1').toString('base64url'),
      truncated: true,
    });
    await expect(
      reader.listRepositoryTree({
        containerId: 'container-1',
        revisionId: 'revision-1',
        repoId: 'repo-1',
      }),
    ).resolves.toEqual({
      items: [
        { repoId: 'repo-1', path: 'src', kind: 'directory' },
        {
          repoId: 'repo-1',
          path: 'src/current.ts',
          kind: 'file',
          sizeBytes: '29',
          status: 'modified',
          source: 'uncommitted',
        },
        // A deletion has no overlay byte on disk, so it carries a status but
        // no `sizeBytes`.
        {
          repoId: 'repo-1',
          path: 'src/deleted.ts',
          kind: 'file',
          status: 'deleted',
          source: 'uncommitted',
        },
      ],
      nextCursor: null,
      truncated: false,
    });
    await expect(
      reader.readNote({
        containerId: 'container-1',
        revisionId: 'revision-1',
        itemId: 'note-1',
      }),
    ).resolves.toBe('# Safe note\n');

    const outside = join(root, 'outside.md');
    await writeFile(outside, 'private\n');
    await unlink(notePath);
    await symlink(outside, notePath);
    await expect(
      reader.readNote({
        containerId: 'container-1',
        revisionId: 'revision-1',
        itemId: 'note-1',
      }),
    ).rejects.toThrow(/symbolic link/i);

    const overlayPath = join(
      revisionRoot,
      'repos',
      'repo-1',
      'src',
      'current.ts',
    );
    await unlink(overlayPath);
    await symlink(outside, overlayPath);
    await expect(
      reader.readOverlayDiff({
        containerId: 'container-1',
        revisionId: 'revision-1',
        repoId: 'repo-1',
        path: 'src/current.ts',
      }),
    ).rejects.toThrow(/symbolic link/i);

    const repositoryRoot = join(revisionRoot, 'repos', 'repo-1');
    await rm(repositoryRoot, { recursive: true, force: true });
    const outsideRepository = join(root, 'outside-repository');
    await mkdir(outsideRepository);
    await symlink(outsideRepository, repositoryRoot, 'dir');
    await expect(
      reader.readOverlayDiff({
        containerId: 'container-1',
        revisionId: 'revision-1',
        repoId: 'repo-1',
        path: 'src/deleted.ts',
      }),
    ).rejects.toThrow(/symbolic link/i);
  });
  // CAN-2551: the recipient could not see the publisher's committed work at
  // all. It now arrives as manifest metadata resolved against the recipient's
  // own bounded checkout, never as re-uploaded artifacts.
  describe('committed changes', () => {
    const committedLayout = (
      mergeBaseSha: string,
      baseCommitSha: string,
    ): SharedContainerRevisionLayout => ({
      schemaVersion: 1,
      containerType: 'CODE_WORKTREE',
      title: 'Feature branch',
      repositories: [
        {
          repoId: 'repo-1',
          repoName: 'repository',
          remoteUrl: 'https://github.com/acme/repository.git',
          owner: 'acme',
          repository: 'repository',
          baseCommitSha,
          baseBranch: 'main',
          mergeBaseSha,
          files: [
            {
              path: 'src/dirty.ts',
              status: 'modified',
              artifactId: 'dirty-artifact',
              mode: '100644',
            },
          ],
          committedFiles: [
            {
              path: 'src/tracked.ts',
              status: 'modified',
              insertions: 1,
              deletions: 0,
            },
          ],
        },
      ],
      files: [],
      notes: [],
      prompts: [],
      attachmentPaths: {},
    });

    async function seedReplicaRepository(
      root: string,
      layout: SharedContainerRevisionLayout | SharedContainerRevisionLayoutV2,
      // Materialization writes this marker only after both the merge-base
      // fetch AND the blob warm succeed, and the reader gates the committed
      // group on it. Omitting it is how a test reproduces "the commit landed
      // but its blobs did not" (CAN-2551).
      committedRanges: Record<string, string> = {},
    ): Promise<SharedContainerReader> {
      const store = new SharedContainerReplicaStore(root);
      await store.set({
        status: 'available',
        containerId: 'container-1',
        organizationId: 'org-1',
        containerType: 'CODE_WORKTREE',
        revisionId: 'revision-1',
        revision: 1,
        revisionCreatedAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      });
      const revisionRoot = join(root, 'container-1', 'revisions', 'revision-1');
      await mkdir(join(revisionRoot, 'artifacts'), { recursive: true });
      await writeFile(
        join(revisionRoot, 'artifacts', 'container.json'),
        JSON.stringify(layout),
      );
      const markers = Object.entries(committedRanges);
      if (markers.length > 0) {
        await mkdir(join(revisionRoot, 'committed-ranges'), {
          recursive: true,
        });
        for (const [repoId, mergeBaseSha] of markers) {
          await writeFile(
            join(revisionRoot, 'committed-ranges', repoId),
            mergeBaseSha,
          );
        }
      }
      return new SharedContainerReader(store);
    }

    /** A real two-commit repository standing in for the recipient's checkout. */
    async function buildReplicaCheckout(
      repoDir: string,
    ): Promise<{ mergeBaseSha: string; baseCommitSha: string }> {
      await mkdir(join(repoDir, 'src'), { recursive: true });
      await execFileAsync('git', ['init'], { cwd: repoDir });
      await execFileAsync('git', ['config', 'user.name', 'Test'], {
        cwd: repoDir,
      });
      await execFileAsync(
        'git',
        ['config', 'user.email', 'test@example.test'],
        { cwd: repoDir },
      );
      await writeFile(join(repoDir, 'src', 'tracked.ts'), 'before\n');
      await execFileAsync('git', ['add', '.'], { cwd: repoDir });
      await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repoDir });
      const mergeBaseSha = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })
      ).stdout.trim();
      await writeFile(join(repoDir, 'src', 'tracked.ts'), 'before\nafter\n');
      await execFileAsync('git', ['add', '.'], { cwd: repoDir });
      await execFileAsync('git', ['commit', '-m', 'branch work'], {
        cwd: repoDir,
      });
      const baseCommitSha = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })
      ).stdout.trim();
      return { mergeBaseSha, baseCommitSha };
    }

    it('lists committed and uncommitted files as distinct groups and diffs the committed half from git', async () => {
      const root = await mkdtemp(join(tmpdir(), 'shared-container-read-'));
      const repoDir = join(
        root,
        'container-1',
        'revisions',
        'revision-1',
        'repos',
        'repo-1',
      );
      const { mergeBaseSha, baseCommitSha } =
        await buildReplicaCheckout(repoDir);
      await writeFile(join(repoDir, 'src', 'dirty.ts'), 'dirty overlay\n');
      const reader = await seedReplicaRepository(
        root,
        committedLayout(mergeBaseSha, baseCommitSha),
        { 'repo-1': mergeBaseSha },
      );

      const tree = await reader.listRepositoryTree({
        containerId: 'container-1',
        revisionId: 'revision-1',
        repoId: 'repo-1',
      });
      expect(tree.items).toContainEqual(
        expect.objectContaining({
          path: 'src/dirty.ts',
          source: 'uncommitted',
          status: 'modified',
        }),
      );
      expect(tree.items).toContainEqual({
        repoId: 'repo-1',
        path: 'src/tracked.ts',
        kind: 'file',
        status: 'modified',
        source: 'committed',
        insertions: 1,
        deletions: 0,
      });

      await expect(
        reader.readOverlayDiff({
          containerId: 'container-1',
          revisionId: 'revision-1',
          repoId: 'repo-1',
          path: 'src/tracked.ts',
          source: 'committed',
        }),
      ).resolves.toMatchObject({
        oldValue: 'before\n',
        newValue: 'before\nafter\n',
        binary: false,
      });
    });

    // CAN-2551: a repository that contains symlinks is ordinary — canopy itself
    // has several — and the publisher materializes them faithfully. Listing is
    // metadata only and never follows the link, so a symlinked leaf must not be
    // rejected, and one unreadable entry must not take out the whole tree.
    it('lists symlinked overlay files instead of failing the whole tree', async () => {
      const root = await mkdtemp(join(tmpdir(), 'shared-container-read-'));
      const repoDir = join(
        root,
        'container-1',
        'revisions',
        'revision-1',
        'repos',
        'repo-1',
      );
      const { mergeBaseSha, baseCommitSha } =
        await buildReplicaCheckout(repoDir);
      await writeFile(join(repoDir, 'src', 'dirty.ts'), 'dirty overlay\n');
      // The overlay entry the publisher recorded with git mode 120000.
      await symlink('./dirty.ts', join(repoDir, 'src', 'linked.ts'));

      const layout = committedLayout(mergeBaseSha, baseCommitSha);
      const repository = layout.repositories[0];
      if (!repository) throw new Error('fixture repository missing');
      const reader = await seedReplicaRepository(
        root,
        {
          ...layout,
          repositories: [
            {
              ...repository,
              files: [
                ...repository.files,
                {
                  path: 'src/linked.ts',
                  status: 'modified',
                  artifactId: 'linked-artifact',
                  mode: '120000',
                },
              ],
            },
          ],
        },
        { 'repo-1': mergeBaseSha },
      );

      const tree = await reader.listRepositoryTree({
        containerId: 'container-1',
        revisionId: 'revision-1',
        repoId: 'repo-1',
      });

      // The symlink is listed, without a size, and every sibling survives.
      expect(tree.items).toContainEqual(
        expect.objectContaining({
          path: 'src/linked.ts',
          kind: 'file',
          source: 'uncommitted',
        }),
      );
      expect(
        tree.items.find((item) => item.path === 'src/linked.ts')?.sizeBytes,
      ).toBeUndefined();
      expect(tree.items).toContainEqual(
        expect.objectContaining({
          path: 'src/dirty.ts',
          source: 'uncommitted',
        }),
      );
      expect(tree.items).toContainEqual(
        expect.objectContaining({
          path: 'src/tracked.ts',
          source: 'committed',
        }),
      );
    });

    // CAN-2551: git stores a symlink's blob as its target path, and that is
    // exactly what the publisher ships for a mode-120000 entry. The diff must
    // therefore show the link target — read with `readlink`, never by following
    // the link, which is what the read guard exists to prevent.
    it('diffs a symlinked overlay file as its link target', async () => {
      const root = await mkdtemp(join(tmpdir(), 'shared-container-read-'));
      const repoDir = join(
        root,
        'container-1',
        'revisions',
        'revision-1',
        'repos',
        'repo-1',
      );
      const { mergeBaseSha, baseCommitSha } =
        await buildReplicaCheckout(repoDir);
      await writeFile(join(repoDir, 'src', 'dirty.ts'), 'dirty overlay\n');
      await symlink('./tracked.ts', join(repoDir, 'src', 'linked.ts'));

      const layout = committedLayout(mergeBaseSha, baseCommitSha);
      const repository = layout.repositories[0];
      if (!repository) throw new Error('fixture repository missing');
      const reader = await seedReplicaRepository(
        root,
        {
          ...layout,
          repositories: [
            {
              ...repository,
              files: [
                ...repository.files,
                {
                  path: 'src/linked.ts',
                  status: 'modified',
                  artifactId: 'linked-artifact',
                  mode: '120000',
                },
              ],
            },
          ],
        },
        { 'repo-1': mergeBaseSha },
      );

      const diff = await reader.readOverlayDiff({
        containerId: 'container-1',
        revisionId: 'revision-1',
        repoId: 'repo-1',
        path: 'src/linked.ts',
      });

      // The target text, not the contents of the file it points at.
      expect(diff.newValue).toContain('./tracked.ts');
      expect(diff.newValue).not.toContain('tracked before');
    });

    // The readlink path is opt-in on the manifest's declared mode. An entry the
    // publisher declared as a regular file must still be refused when it is a
    // symlink on disk, because following it could read an arbitrary local file
    // and render it as shared content.
    it('still refuses to follow a symlink declared as a regular file', async () => {
      const root = await mkdtemp(join(tmpdir(), 'shared-container-read-'));
      const repoDir = join(
        root,
        'container-1',
        'revisions',
        'revision-1',
        'repos',
        'repo-1',
      );
      const { mergeBaseSha, baseCommitSha } =
        await buildReplicaCheckout(repoDir);
      await writeFile(join(repoDir, 'src', 'dirty.ts'), 'dirty overlay\n');
      await symlink('./tracked.ts', join(repoDir, 'src', 'spoofed.ts'));

      const layout = committedLayout(mergeBaseSha, baseCommitSha);
      const repository = layout.repositories[0];
      if (!repository) throw new Error('fixture repository missing');
      const reader = await seedReplicaRepository(
        root,
        {
          ...layout,
          repositories: [
            {
              ...repository,
              files: [
                ...repository.files,
                {
                  path: 'src/spoofed.ts',
                  status: 'modified',
                  artifactId: 'spoofed-artifact',
                  // Declared a regular file, but a symlink on disk.
                  mode: '100644',
                },
              ],
            },
          ],
        },
        { 'repo-1': mergeBaseSha },
      );

      await expect(
        reader.readOverlayDiff({
          containerId: 'container-1',
          revisionId: 'revision-1',
          repoId: 'repo-1',
          path: 'src/spoofed.ts',
        }),
      ).rejects.toThrow('symbolic link');
    });

    it('omits the committed group when the merge-base commit never reached the replica', async () => {
      const root = await mkdtemp(join(tmpdir(), 'shared-container-read-'));
      const repoDir = join(
        root,
        'container-1',
        'revisions',
        'revision-1',
        'repos',
        'repo-1',
      );
      const { baseCommitSha } = await buildReplicaCheckout(repoDir);
      await writeFile(join(repoDir, 'src', 'dirty.ts'), 'dirty overlay\n');
      const reader = await seedReplicaRepository(
        root,
        committedLayout('f'.repeat(40), baseCommitSha),
        { 'repo-1': 'f'.repeat(40) },
      );

      const tree = await reader.listRepositoryTree({
        containerId: 'container-1',
        revisionId: 'revision-1',
        repoId: 'repo-1',
      });
      expect(tree.items.filter((item) => item.source === 'committed')).toEqual(
        [],
      );
      await expect(
        reader.readOverlayDiff({
          containerId: 'container-1',
          revisionId: 'revision-1',
          repoId: 'repo-1',
          path: 'src/tracked.ts',
          source: 'committed',
        }),
      ).rejects.toThrow(/committed history is not available/i);
    });

    // CAN-2551: `prepareCommittedRange` fetches the merge-base commit and then
    // warms its diff's blobs as two steps. When the fetch lands and the warm
    // does not, the commit is local but its blobs are not — and by read time
    // the tree is sealed read-only, so git cannot fetch them and `getFileAtRef`
    // returns an empty string. Gating on the commit alone would render a blank,
    // "unchanged" diff instead of hiding the group.
    it('omits the committed group when the merge base landed but its blobs were never warmed', async () => {
      const root = await mkdtemp(join(tmpdir(), 'shared-container-read-'));
      const repoDir = join(
        root,
        'container-1',
        'revisions',
        'revision-1',
        'repos',
        'repo-1',
      );
      const { mergeBaseSha, baseCommitSha } =
        await buildReplicaCheckout(repoDir);
      await writeFile(join(repoDir, 'src', 'dirty.ts'), 'dirty overlay\n');
      // No marker: materialization's warm step failed, so it never wrote one.
      const reader = await seedReplicaRepository(
        root,
        committedLayout(mergeBaseSha, baseCommitSha),
      );

      const tree = await reader.listRepositoryTree({
        containerId: 'container-1',
        revisionId: 'revision-1',
        repoId: 'repo-1',
      });
      expect(
        tree.items.filter((item) => item.source === 'committed'),
      ).toHaveLength(0);
      expect(tree.items).toContainEqual(
        expect.objectContaining({
          path: 'src/dirty.ts',
          source: 'uncommitted',
        }),
      );

      // And the read is refused outright rather than answered with an empty
      // diff, so a stale renderer cannot surface one either.
      await expect(
        reader.readOverlayDiff({
          containerId: 'container-1',
          revisionId: 'revision-1',
          repoId: 'repo-1',
          path: 'src/tracked.ts',
          source: 'committed',
        }),
      ).rejects.toThrow('committed history is not available');
    });

    // A marker naming a different merge base than the manifest cannot vouch
    // for this revision's range.
    it('omits the committed group when the marker does not match the manifest', async () => {
      const root = await mkdtemp(join(tmpdir(), 'shared-container-read-'));
      const repoDir = join(
        root,
        'container-1',
        'revisions',
        'revision-1',
        'repos',
        'repo-1',
      );
      const { mergeBaseSha, baseCommitSha } =
        await buildReplicaCheckout(repoDir);
      await writeFile(join(repoDir, 'src', 'dirty.ts'), 'dirty overlay\n');
      const reader = await seedReplicaRepository(
        root,
        committedLayout(mergeBaseSha, baseCommitSha),
        { 'repo-1': 'a'.repeat(40) },
      );

      const tree = await reader.listRepositoryTree({
        containerId: 'container-1',
        revisionId: 'revision-1',
        repoId: 'repo-1',
      });
      expect(
        tree.items.filter((item) => item.source === 'committed'),
      ).toHaveLength(0);
    });

    it('surfaces the base commit and branch so an empty share can name them', async () => {
      const root = await mkdtemp(join(tmpdir(), 'shared-container-read-'));
      const repoDir = join(
        root,
        'container-1',
        'revisions',
        'revision-1',
        'repos',
        'repo-1',
      );
      const { mergeBaseSha, baseCommitSha } =
        await buildReplicaCheckout(repoDir);
      const reader = await seedReplicaRepository(
        root,
        committedLayout(mergeBaseSha, baseCommitSha),
      );

      await expect(
        reader.listRepositories({
          containerId: 'container-1',
          revisionId: 'revision-1',
        }),
      ).resolves.toEqual([
        {
          repoId: 'repo-1',
          repoName: 'repository',
          baseCommitSha,
          baseBranch: 'main',
        },
      ]);
    });

    it('lists a materialized schema-v2 snapshot repository', async () => {
      const root = await mkdtemp(join(tmpdir(), 'shared-container-read-'));
      const layout: SharedContainerRevisionLayoutV2 = {
        schemaVersion: 2,
        containerType: 'CODE_WORKTREE',
        title: 'Local snapshot',
        repositories: [
          {
            repoId: 'repo-1',
            repoName: 'local-only',
            source: 'snapshot',
            baseCommitSha: 'a'.repeat(40),
            snapshot: {
              bundleArtifactIds: ['snapshot-artifact'],
              treeFileCount: 1,
              treeBytes: '5',
            },
            files: [],
          },
        ],
        files: [],
        notes: [],
        prompts: [],
        attachmentPaths: {},
      };
      const reader = await seedReplicaRepository(root, layout);

      await expect(
        reader.listRepositories({
          containerId: 'container-1',
          revisionId: 'revision-1',
        }),
      ).resolves.toEqual([
        {
          repoId: 'repo-1',
          repoName: 'local-only',
          baseCommitSha: 'a'.repeat(40),
        },
      ]);
    });

    it('lists the uncommitted group for a manifest published before committed files existed', async () => {
      const root = await mkdtemp(join(tmpdir(), 'shared-container-read-'));
      const repoDir = join(
        root,
        'container-1',
        'revisions',
        'revision-1',
        'repos',
        'repo-1',
      );
      const { baseCommitSha } = await buildReplicaCheckout(repoDir);
      await writeFile(join(repoDir, 'src', 'dirty.ts'), 'dirty overlay\n');
      const legacy = committedLayout('b'.repeat(40), baseCommitSha);
      const repository = legacy.repositories[0];
      if (!repository) throw new Error('fixture repository is missing');
      delete repository.baseBranch;
      delete repository.mergeBaseSha;
      delete repository.committedFiles;
      const reader = await seedReplicaRepository(root, legacy);

      const tree = await reader.listRepositoryTree({
        containerId: 'container-1',
        revisionId: 'revision-1',
        repoId: 'repo-1',
      });
      expect(tree.items.map((item) => item.path)).toEqual([
        'src',
        'src/dirty.ts',
      ]);
      expect(tree.items[1]).toMatchObject({ source: 'uncommitted' });
    });

    it('fetches only the merge-base commit, and degrades instead of failing the open', async () => {
      const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
      const layout = committedLayout('c'.repeat(40), 'a'.repeat(40));
      const repository = layout.repositories[0];
      if (!repository) throw new Error('fixture repository is missing');
      repository.files = [];
      const prepareCommittedRange = jest.fn(() => Promise.resolve());

      await expect(
        materializeCodeRevision(
          {
            layout,
            artifactsDir: join(root, 'artifacts'),
            reposDir: join(root, 'repos'),
            committedRangesDir: join(root, 'committed-ranges'),
            artifactPathsById: new Map(),
          },
          {
            ...codeDependencies(),
            cloneRepo: async (_remote, destination): Promise<void> => {
              await mkdir(destination, { recursive: true });
            },
            prepareCommittedRange,
          },
        ),
      ).resolves.toEqual({ ok: true });
      expect(prepareCommittedRange).toHaveBeenCalledWith(
        expect.stringContaining('repo-1'),
        'c'.repeat(40),
        'a'.repeat(40),
        expect.objectContaining({
          timeoutMs: SHARED_CONTAINER_GIT_OPERATION_TIMEOUT_MS,
        }),
      );

      // A rebased or garbage-collected merge base must cost the committed
      // group, not the whole share.
      const failingRoot = await mkdtemp(join(tmpdir(), 'code-materialize-'));
      await expect(
        materializeCodeRevision(
          {
            layout,
            artifactsDir: join(failingRoot, 'artifacts'),
            reposDir: join(failingRoot, 'repos'),
            committedRangesDir: join(failingRoot, 'committed-ranges'),
            artifactPathsById: new Map(),
          },
          {
            ...codeDependencies(),
            cloneRepo: async (_remote, destination): Promise<void> => {
              await mkdir(destination, { recursive: true });
            },
            prepareCommittedRange: () =>
              Promise.reject(new Error('merge base is unreachable')),
          },
        ),
      ).resolves.toEqual({ ok: true });
    });

    it('does not touch the remote when the manifest declares no merge base', async () => {
      const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
      const prepareCommittedRange = jest.fn(() => Promise.resolve());

      await expect(
        materializeCodeRevision(
          {
            layout: codeLayout(),
            artifactsDir: join(root, 'artifacts'),
            reposDir: join(root, 'repos'),
            committedRangesDir: join(root, 'committed-ranges'),
            artifactPathsById: new Map(),
          },
          {
            ...codeDependencies(),
            cloneRepo: async (_remote, destination): Promise<void> => {
              await mkdir(destination, { recursive: true });
            },
            prepareCommittedRange,
          },
        ),
      ).resolves.toEqual({ ok: true });
      expect(prepareCommittedRange).not.toHaveBeenCalled();
    });
  });

  describe('reused checkout remote matching (CAN-2551)', () => {
    /** A seeded checkout whose `.git` exists, so the reuse branch is eligible. */
    const seedCheckout = async (reposDir: string): Promise<string> => {
      const repoDir = join(reposDir, 'repo-1');
      await mkdir(join(repoDir, '.git'), { recursive: true });
      await writeFile(join(repoDir, 'carried-over.txt'), 'stale\n');
      return repoDir;
    };

    it('reuses a checkout whose origin is the repository the manifest names', async () => {
      const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
      const reposDir = join(root, 'repos');
      await seedCheckout(reposDir);
      const cloneRepo = jest.fn<Promise<void>, [string, string]>(
        (_remote, destination) =>
          mkdir(destination, { recursive: true }).then(() => undefined),
      );
      const fetchOrigin = jest.fn(() => Promise.resolve());

      await expect(
        materializeCodeRevision(
          {
            layout: codeLayout(),
            artifactsDir: join(root, 'artifacts'),
            reposDir,
            committedRangesDir: join(root, 'committed-ranges'),
            artifactPathsById: new Map(),
          },
          {
            ...codeDependencies(),
            cloneRepo,
            fetchOrigin,
            // An `scp`-style origin for the same repository still matches the
            // manifest's `https` remote: coordinates are compared, not text.
            readOriginUrl: () =>
              Promise.resolve('git@github.com:acme/repo.git'),
          },
        ),
      ).resolves.toEqual({ ok: true });
      expect(fetchOrigin).toHaveBeenCalledTimes(1);
      expect(cloneRepo).not.toHaveBeenCalled();
    });

    it('replaces a carried GitHub checkout when the repository becomes a snapshot', async () => {
      const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
      const reposDir = join(root, 'repos');
      const artifactsDir = join(root, 'artifacts');
      const repoDir = await seedCheckout(reposDir);
      const snapshotHash = 'c'.repeat(64);
      const snapshotPath = `repos/repo-1/snapshot/${snapshotHash}`;
      await mkdir(join(artifactsDir, 'repos', 'repo-1', 'snapshot'), {
        recursive: true,
      });
      await writeFile(join(artifactsDir, snapshotPath), 'bundle');
      const prepareSnapshot = jest.fn(
        async (_bundle: string, destination: string) => {
          await mkdir(join(destination, '.git'), { recursive: true });
        },
      );
      const materializeRawCommit = jest.fn(() =>
        Promise.resolve({ fileCount: 0, totalBytes: BigInt(0) }),
      );
      const cloneRepo = jest.fn(() => Promise.resolve());
      const layout: SharedContainerRevisionLayoutV2 = {
        schemaVersion: 2,
        containerType: 'CODE_WORKTREE',
        title: 'Snapshot transition',
        repositories: [
          {
            repoId: 'repo-1',
            repoName: 'repo',
            source: 'snapshot',
            baseCommitSha: 'a'.repeat(40),
            snapshot: {
              bundleArtifactIds: ['snapshot-bundle'],
              treeFileCount: 0,
              treeBytes: '0',
            },
            files: [],
          },
        ],
        files: [],
        notes: [],
        prompts: [],
        attachmentPaths: {},
      };

      await expect(
        materializeCodeRevision(
          {
            layout,
            artifactsDir,
            reposDir,
            committedRangesDir: join(root, 'committed-ranges'),
            artifactPathsById: new Map([['snapshot-bundle', snapshotPath]]),
          },
          {
            ...codeDependencies(),
            cloneRepo,
            materializeRawCommit,
            prepareSnapshot,
          },
        ),
      ).resolves.toEqual({ ok: true });

      expect(prepareSnapshot).toHaveBeenCalledTimes(1);
      expect(materializeRawCommit).toHaveBeenCalledWith(
        repoDir,
        'a'.repeat(40),
        expect.objectContaining({
          allowPromisorFetch: false,
          maxFiles: 0,
          maxBytes: BigInt(0),
        }),
      );
      expect(cloneRepo).not.toHaveBeenCalled();
      await expect(
        readFile(join(repoDir, 'carried-over.txt'), 'utf8'),
      ).rejects.toThrow();
    });

    it.each([
      ['a different repository', 'https://github.com/acme/other.git'],
      ['an unreadable or snapshot origin', null],
      ['a non-GitHub origin', 'https://example.com/acme/repo.git'],
    ])(
      'discards a carried-over checkout with %s and clones instead',
      async (_label, origin) => {
        const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
        const reposDir = join(root, 'repos');
        const repoDir = await seedCheckout(reposDir);
        const cloneRepo = jest.fn<Promise<void>, [string, string]>(
          (_remote, destination) =>
            mkdir(destination, { recursive: true }).then(() => undefined),
        );
        const fetchOrigin = jest.fn(() => Promise.resolve());

        await expect(
          materializeCodeRevision(
            {
              layout: codeLayout(),
              artifactsDir: join(root, 'artifacts'),
              reposDir,
              committedRangesDir: join(root, 'committed-ranges'),
              artifactPathsById: new Map(),
            },
            {
              ...codeDependencies(),
              cloneRepo,
              fetchOrigin,
              readOriginUrl: () => Promise.resolve(origin),
            },
          ),
        ).resolves.toEqual({ ok: true });
        // Fetching into the wrong repository's checkout would either fail the
        // open or materialize the wrong code, so the stale tree must be gone.
        expect(fetchOrigin).not.toHaveBeenCalled();
        expect(cloneRepo).toHaveBeenCalledTimes(1);
        await expect(
          readFile(join(repoDir, 'carried-over.txt'), 'utf8'),
        ).rejects.toThrow();
      },
    );

    it('falls back to the clone when reading the origin throws', async () => {
      const root = await mkdtemp(join(tmpdir(), 'code-materialize-'));
      const reposDir = join(root, 'repos');
      await seedCheckout(reposDir);
      const cloneRepo = jest.fn<Promise<void>, [string, string]>(
        (_remote, destination) =>
          mkdir(destination, { recursive: true }).then(() => undefined),
      );
      const fetchOrigin = jest.fn(() => Promise.resolve());

      await expect(
        materializeCodeRevision(
          {
            layout: codeLayout(),
            artifactsDir: join(root, 'artifacts'),
            reposDir,
            committedRangesDir: join(root, 'committed-ranges'),
            artifactPathsById: new Map(),
          },
          {
            ...codeDependencies(),
            cloneRepo,
            fetchOrigin,
            readOriginUrl: () => Promise.reject(new Error('git unavailable')),
          },
        ),
      ).resolves.toEqual({ ok: true });
      expect(fetchOrigin).not.toHaveBeenCalled();
      expect(cloneRepo).toHaveBeenCalledTimes(1);
    });
  });
});
