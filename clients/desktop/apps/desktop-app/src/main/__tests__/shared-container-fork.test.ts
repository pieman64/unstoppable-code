import type * as WorkspacePersistenceModule from '../lib/workspace-persistence';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { MAX_SHARED_CONTAINER_MATERIALIZED_BYTES } from '@canopy/protocol/shared-containers';
import { copySharedContainerTree } from '../shared-containers/fork/copy-tree';
import {
  forkSharedCodeContainer,
  mapCodeForkStartPage,
  replaySharedContainerOverlay,
} from '../shared-containers/fork/code';
import {
  copyForkWorkspaceItems,
  forkSharedCoworkContainer,
  mapCoworkForkStartPage,
} from '../shared-containers/fork/cowork';
import {
  assertNoPublishedPlans,
  rehydrateForkChats,
  writeForkFileFromReplica,
} from '../shared-containers/fork/finalize';
import { assertRevisionCheckoutNotBorrowed } from '../shared-containers/fork/fork-guard';
import {
  readSharedContainerForkProvenance,
  writeSharedContainerForkProvenance,
} from '../shared-containers/fork/provenance';
import {
  deleteForkWorkspaceOrHide,
  runWithSharedContainerForkRollback,
} from '../shared-containers/fork/rollback';
import { SharedContainerReplicaManager } from '../shared-containers/replica/manager';
import { SharedContainerReplicaStore } from '../shared-containers/replica/store';
import type { SharedContainerReplicaTransport } from '../shared-containers/transport';
import {
  getWorkspaceChatTabsFilePath,
  getWorkspaceWorkEntriesFilePath,
  getWorkspaceWorktreeDir,
  getWorkspaceWorktreeRepoDir,
  getWorktreeDataRootDir,
} from '../lib/paths';
import { removePersistedWorktreeDataDirectory } from '@canopy/desktop-shared/node/lib/worktree-data-cleanup';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import type * as ChatTabsModule from '../lib/chat-tabs';
import type * as ChatStateServiceModule from '../services/chat-state-service';
import {
  getChatStateService,
  resetChatStateServiceForTests,
} from '../services/chat-state-service';
import { cleanupPersistedWorktreeData } from '../lib/worktree-data-cleanup';
import {
  registerWorkspaceExternalPaths,
  registerWorkspaceTypes,
} from '../lib/workspace-registry';
import { readNote, readPrompt } from '../lib/standalone-workspace-files';
import type * as GitModule from '../lib/git';
import { deleteBranchIfMatches, getRemoteUrl, resolveRefSha } from '../lib/git';
import {
  readAllSidebarItems,
  removeWorkspaceIndexEntry,
} from '../lib/sidebar-items';
import {
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
  createMultiRepoWorktree,
  createSingleRepoWorktree,
} from '../lib/worktree-service';
import { writeChatTabsFile } from '../lib/chat-tabs';
import {
  getSharedContainerReader,
  SharedContainerReader,
} from '../shared-containers/read/reader';
import type * as SharedContainerReaderModule from '../shared-containers/read/reader';
import {
  projectSharedContainerViewerChats,
  projectPublishedChatsToTabs,
  selectProjectedViewerActiveTabId,
} from '../shared-containers/chat-projection';
import { migratePanelLayout } from '@canopy/protocol/panels';
import { panelLayoutPersistenceStore } from '../panels/persistence';
import type { ChatStateService } from '../services/chat-state-service';

jest.mock('../lib/workspace-persistence', () => {
  const actual = jest.requireActual<typeof WorkspacePersistenceModule>(
    '../lib/workspace-persistence',
  );
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      readWorkspaceOwnership: {
        value: jest.fn(() =>
          Promise.resolve({
            authority: 'ok',
            type: 'single-repo',
          }),
        ),
        enumerable: true,
      },
    },
  );
});
jest.mock('../lib/git', () => {
  // The symlink helpers are pure path/decoding logic with no process or
  // filesystem access, and the copy under test classifies links with the same
  // rules materialization does. Stubbing them would test a fiction.
  const actual = jest.requireActual<typeof GitModule>('../lib/git');
  return {
    classifySharedContainerSymlinkTarget:
      actual.classifySharedContainerSymlinkTarget,
    decodeUtf8SymlinkTarget: actual.decodeUtf8SymlinkTarget,
    isInRepositorySymlinkTarget: actual.isInRepositorySymlinkTarget,
    deleteBranchIfMatches: jest.fn(),
    getRemoteUrl: jest.fn(),
    materializeGitCommitRaw: jest.fn(),
    resolveRefSha: jest.fn(),
  };
});
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
  removeWorkspaceIndexEntry: jest.fn(),
}));
jest.mock('../lib/worktree-service', () => ({
  archiveMultiRepoWorktree: jest.fn(),
  archiveSingleRepoWorktree: jest.fn(),
  createMultiRepoWorktree: jest.fn(),
  createSingleRepoWorktree: jest.fn(),
}));
jest.mock('../lib/chat-tabs', () => ({
  writeChatTabsFile: jest.fn(),
  notifyChatTabsMaterialized: jest.fn(() => Promise.resolve()),
}));
// Chat-state commands queue diagnostic writes on a separate flush timer.
// Keep that unrelated sink from racing removal of this spec's temp data dir.
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordSessionDiagnostic: jest.fn(),
  })),
}));
// The production helper also tears down chat-search, code-graph, browser and
// observability state that this spec does not exercise; delegate to the two
// closures a fork rollback must reclaim on disk: the canonical chat scope and
// the worktree-data directory.
jest.mock('../lib/worktree-data-cleanup', () => ({
  cleanupPersistedWorktreeData: jest.fn(
    async (projectId: string, worktreeId: string): Promise<string[]> => {
      const { getChatStateService } = jest.requireActual<
        typeof ChatStateServiceModule
      >('../services/chat-state-service');
      await getChatStateService().deleteScope({ projectId, worktreeId });
      await removePersistedWorktreeDataDirectory(projectId, worktreeId, {
        worktreeDataRootDir: getWorktreeDataRootDir(projectId),
      });
      return [];
    },
  ),
}));
jest.mock('../shared-containers/read/reader', () => {
  const actual = jest.requireActual<typeof SharedContainerReaderModule>(
    '../shared-containers/read/reader',
  );
  return { ...actual, getSharedContainerReader: jest.fn() };
});
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return { ...actual, chmod: jest.fn(actual.chmod) };
});

describe('shared-container fork scaffolding', () => {
  it('maps published start pages into destination workspace identities', () => {
    expect(
      mapCodeForkStartPage(
        { kind: 'file', repoId: 'published-repo', relativePath: 'README.md' },
        new Map([['published-repo', 'local-repo']]),
        'multi-repo',
      ),
    ).toEqual({ kind: 'file', repoId: 'local-repo', path: 'README.md' });
    expect(
      mapCodeForkStartPage(
        { kind: 'file', repoId: 'missing', relativePath: 'README.md' },
        new Map(),
        'multi-repo',
      ),
    ).toBeUndefined();
    expect(
      mapCodeForkStartPage(
        { kind: 'file', repoId: 'published-repo', relativePath: 'README.md' },
        new Map([['published-repo', 'local-repo']]),
        'single-repo',
      ),
    ).toEqual({ kind: 'file', path: 'README.md' });
    expect(
      mapCoworkForkStartPage({
        kind: 'file',
        repoId: 'workspace',
        relativePath: 'README.md',
      }),
    ).toEqual({ kind: 'file', path: 'README.md' });
    expect(
      mapCoworkForkStartPage({ kind: 'url', url: 'https://example.test' }),
    ).toEqual({ kind: 'url', url: 'https://example.test' });
  });

  let tempPath: string;
  const originalDataDir = process.env.CANOPY_DATA_DIR;

  beforeEach(async () => {
    jest.clearAllMocks();
    tempPath = await mkdtemp(join(tmpdir(), 'shared-container-fork-'));
    process.env.CANOPY_DATA_DIR = join(tempPath, 'data');
    resetResolvedCanopyDataDirForTests();
  });

  afterEach(async () => {
    await rm(tempPath, { recursive: true, force: true });
    registerWorkspaceTypes(new Map());
    registerWorkspaceExternalPaths(new Map());
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    resetResolvedCanopyDataDirForTests();
  });

  it('copies regular files with writable destination permissions and leaves the source unchanged', async () => {
    const source = join(tempPath, 'source');
    const destination = join(tempPath, 'destination');
    await mkdir(join(source, 'nested'), { recursive: true });
    await writeFile(join(source, 'nested', 'run.sh'), '#!/bin/sh\n', {
      mode: 0o500,
    });

    await copySharedContainerTree(source, destination);

    expect(await readFile(join(destination, 'nested', 'run.sh'), 'utf8')).toBe(
      '#!/bin/sh\n',
    );
    expect(
      (await lstat(join(destination, 'nested', 'run.sh'))).mode & 0o777,
    ).toBe(0o700);
    expect((await lstat(join(source, 'nested', 'run.sh'))).mode & 0o777).toBe(
      0o500,
    );
  });

  /**
   * A committed symlink is ordinary repository content, not an attack.
   * Publish classifies it and ships it as a `120000` entry, and materialize
   * recreates it on disk; a fork that refused every link could not copy any
   * repository containing one — including Canopy's own `.claude/skills`.
   */
  it('recreates an in-repository symbolic link', async () => {
    const source = join(tempPath, 'inrepo-symlink-source');
    const destination = join(tempPath, 'inrepo-symlink-destination');
    await mkdir(join(source, 'nested', 'skills'), { recursive: true });
    await writeFile(join(source, 'real.txt'), 'safe');
    await symlink('real.txt', join(source, 'link.txt'));
    // The shape that broke a real fork: a link that climbs out of its own
    // directory but lands back inside the repository.
    await symlink(
      '../../real.txt',
      join(source, 'nested', 'skills', 'climbing-link'),
    );

    await copySharedContainerTree(source, destination);

    const copied = await lstat(join(destination, 'link.txt'));
    expect(copied.isSymbolicLink()).toBe(true);
    expect(await readlink(join(destination, 'link.txt'), 'utf8')).toBe(
      'real.txt',
    );
    const climbing = join(destination, 'nested', 'skills', 'climbing-link');
    expect((await lstat(climbing)).isSymbolicLink()).toBe(true);
    expect(await readlink(climbing, 'utf8')).toBe('../../real.txt');
    // The link is recreated, never dereferenced into a second copy of the file.
    expect(await readFile(join(destination, 'real.txt'), 'utf8')).toBe('safe');
  });

  /**
   * An escaping link is skipped rather than thrown on, matching
   * `materializeGitCommitRaw`. Promotion re-materializes the base tree from
   * the object database immediately afterwards, so refusing the whole fork
   * over a link git itself would decline to restore buys nothing.
   */
  it('skips a symbolic link that escapes the copied tree', async () => {
    const source = join(tempPath, 'escaping-symlink-source');
    const destination = join(tempPath, 'escaping-symlink-destination');
    await mkdir(join(source, 'nested'), { recursive: true });
    await writeFile(join(source, 'real.txt'), 'safe');
    await symlink('/etc/passwd', join(source, 'absolute-link'));
    await symlink('../../outside.txt', join(source, 'nested', 'escaping-link'));

    await copySharedContainerTree(source, destination);

    expect(await readFile(join(destination, 'real.txt'), 'utf8')).toBe('safe');
    await expect(
      lstat(join(destination, 'absolute-link')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      lstat(join(destination, 'nested', 'escaping-link')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects hard-linked files', async () => {
    const hardlinkSource = join(tempPath, 'hardlink-source');
    await mkdir(hardlinkSource, { recursive: true });
    await writeFile(join(hardlinkSource, 'one.txt'), 'same inode');
    await link(
      join(hardlinkSource, 'one.txt'),
      join(hardlinkSource, 'two.txt'),
    );
    await expect(
      copySharedContainerTree(
        hardlinkSource,
        join(tempPath, 'hardlink-destination'),
      ),
    ).rejects.toThrow(/hard link/i);
  });

  it('never replaces an existing copy destination', async () => {
    const source = join(tempPath, 'exclusive-source');
    const destination = join(tempPath, 'exclusive-destination');
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(source, 'source.txt'), 'source');
    await writeFile(join(destination, 'keep.txt'), 'keep');

    await expect(
      copySharedContainerTree(source, destination),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(readFile(join(destination, 'keep.txt'), 'utf8')).resolves.toBe(
      'keep',
    );
  });

  it('removes a partial destination when the recursive copy exceeds its budget', async () => {
    const source = join(tempPath, 'bounded-source');
    const destination = join(tempPath, 'bounded-destination');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'too-large.txt'), 'four');

    await expect(
      copySharedContainerTree(source, destination, { maxBytes: BigInt(3) }),
    ).rejects.toThrow(/copy budget/i);
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not apply the shared-artifact ceiling to a promoted repository by default', async () => {
    const source = join(tempPath, 'repository-source');
    const destination = join(tempPath, 'repository-destination');
    const largeFile = join(source, 'large-pack');
    await mkdir(source, { recursive: true });
    await writeFile(largeFile, 'x');
    await truncate(largeFile, MAX_SHARED_CONTAINER_MATERIALIZED_BYTES + 1);

    await copySharedContainerTree(source, destination);

    expect((await lstat(join(destination, 'large-pack'))).size).toBe(
      MAX_SHARED_CONTAINER_MATERIALIZED_BYTES + 1,
    );
  }, 300_000);

  it.each([undefined, '2026-09-08T10:00:00.000Z'])(
    'round trips validated provenance with source time %s',
    async (sourceRevisionCreatedAt) => {
      const filePath = join(tempPath, 'metadata', 'fork-provenance.json');
      const provenance = {
        sourceContainerId: 'container-1',
        sourceRevisionId: 'revision-1',
        sourceOwnerDisplayName: 'Ada',
        ...(sourceRevisionCreatedAt === undefined
          ? {}
          : { sourceRevisionCreatedAt }),
        organizationId: 'organization-1',
        forkedAt: '2026-09-09T12:00:00.000Z',
      };

      await writeSharedContainerForkProvenance(filePath, provenance);
      await expect(
        readSharedContainerForkProvenance(filePath),
      ).resolves.toEqual(provenance);
    },
  );

  it('refuses invalid publication time before persisting provenance', async () => {
    const filePath = join(tempPath, 'invalid-provenance.json');
    await expect(
      writeSharedContainerForkProvenance(filePath, {
        sourceContainerId: 'container-1',
        sourceRevisionId: 'revision-2',
        sourceOwnerDisplayName: 'Ada',
        sourceRevisionCreatedAt: 'later',
        forkedAt: '2026-09-09T12:00:00.000Z',
      }),
    ).rejects.toThrow('Invalid shared-container fork provenance');
    await expect(lstat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['later', 42, null])(
    'rejects malformed persisted publication time %j',
    async (sourceRevisionCreatedAt) => {
      const filePath = join(tempPath, 'invalid-provenance.json');
      await writeFile(
        filePath,
        JSON.stringify({
          sourceContainerId: 'container-1',
          sourceRevisionId: 'revision-2',
          sourceOwnerDisplayName: 'Ada',
          sourceRevisionCreatedAt,
          forkedAt: '2026-09-09T12:00:00.000Z',
        }),
      );
      await expect(readSharedContainerForkProvenance(filePath)).rejects.toThrow(
        'Invalid shared-container fork provenance',
      );
    },
  );

  it('rolls back completed stages in reverse order', async () => {
    const events: string[] = [];

    await expect(
      runWithSharedContainerForkRollback((rollback) => {
        rollback.defer(() => {
          events.push('first');
          return Promise.resolve();
        });
        rollback.defer(() => {
          events.push('second');
          return Promise.resolve();
        });
        return Promise.reject(new Error('failed'));
      }),
    ).rejects.toThrow('failed');

    expect(events).toEqual(['second', 'first']);
  });

  it('continues rollback after cleanup failures and surfaces every failure', async () => {
    const events: string[] = [];

    const result = runWithSharedContainerForkRollback((rollback) => {
      rollback.defer(() => {
        events.push('first');
        return Promise.reject(new Error('first cleanup failed'));
      });
      rollback.defer(() => {
        events.push('second');
        return Promise.reject(new Error('second cleanup failed'));
      });
      return Promise.reject(new Error('fork failed'));
    });

    await expect(result).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [
        expect.objectContaining({ message: 'fork failed' }),
        expect.objectContaining({ message: 'second cleanup failed' }),
        expect.objectContaining({ message: 'first cleanup failed' }),
      ],
    });
    expect(events).toEqual(['second', 'first']);
  });

  it('removes a copied Cowork file and its new parent directories when chmod fails', async () => {
    const replicaRoot = join(tempPath, 'replicas');
    const revisionRoot = join(
      replicaRoot,
      'container-1',
      'revisions',
      'revision-1',
    );
    const source = join(revisionRoot, 'content', 'nested.txt');
    const destinationRoot = join(tempPath, 'existing-cowork');
    await mkdir(join(revisionRoot, 'content'), { recursive: true });
    await mkdir(destinationRoot, { recursive: true });
    await writeFile(source, 'shared content');
    jest.mocked(chmod).mockRejectedValueOnce(new Error('chmod failed'));

    await expect(
      runWithSharedContainerForkRollback((rollback) =>
        writeForkFileFromReplica({
          store: new SharedContainerReplicaStore(replicaRoot),
          revisionRoot,
          source,
          destinationRoot,
          relativePath: 'new/parents/copied.txt',
          rollback,
        }),
      ),
    ).rejects.toThrow('chmod failed');

    await expect(lstat(join(destinationRoot, 'new'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('hides a newly created fork workspace when full deletion fails', async () => {
    jest.mocked(removeWorkspaceIndexEntry).mockResolvedValue(true);
    await expect(
      deleteForkWorkspaceOrHide(
        { source: 'cowork_fork', workspaceId: 'fork-workspace' },
        () => Promise.reject(new Error('delete failed')),
      ),
    ).rejects.toThrow('delete failed');

    // Only the index entry goes (CAN-3824); no sidebar snapshot is written.
    expect(jest.mocked(removeWorkspaceIndexEntry)).toHaveBeenCalledWith(
      'fork-workspace',
    );
    expect(jest.mocked(readAllSidebarItems)).not.toHaveBeenCalled();
  });

  it('replays full overlay bytes, modes, and deletions into the new worktree', async () => {
    const replicaRoot = join(tempPath, 'replicas');
    const revisionRoot = join(
      replicaRoot,
      'container-1',
      'revisions',
      'revision-1',
    );
    const sourceRepo = join(revisionRoot, 'repos', 'source-repo');
    await mkdir(join(sourceRepo, 'nested'), { recursive: true });
    await writeFile(join(sourceRepo, 'modified.txt'), 'after');
    await writeFile(join(sourceRepo, 'nested', 'added.sh'), '#!/bin/sh\n');
    const destination = getWorkspaceWorktreeDir('workspace-1', 'worktree-1');
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'modified.txt'), 'before');
    await writeFile(join(destination, 'deleted.txt'), 'remove me');

    await replaySharedContainerOverlay({
      store: new SharedContainerReplicaStore(replicaRoot),
      revisionRoot,
      layout: {
        schemaVersion: 1,
        containerType: 'CODE_WORKTREE',
        title: 'Fork',
        repositories: [
          {
            repoId: 'source-repo',
            repoName: 'Repo',
            remoteUrl: 'https://github.com/example/repo.git',
            owner: 'example',
            repository: 'repo',
            baseCommitSha: 'a'.repeat(40),
            files: [
              {
                path: 'modified.txt',
                status: 'modified',
                artifactId: 'm',
                mode: '100644',
              },
              {
                path: 'nested/added.sh',
                status: 'added',
                artifactId: 'a',
                mode: '100755',
              },
              { path: 'deleted.txt', status: 'deleted', mode: '100644' },
            ],
          },
        ],
        files: [],
        notes: [],
        prompts: [],
        attachmentPaths: {},
      },
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
      repoIds: new Map([['source-repo', 'workspace-1']]),
      singleRepo: true,
    });

    expect(await readFile(join(destination, 'modified.txt'), 'utf8')).toBe(
      'after',
    );
    expect(
      await readFile(join(destination, 'nested', 'added.sh'), 'utf8'),
    ).toBe('#!/bin/sh\n');
    expect(
      (await lstat(join(destination, 'nested', 'added.sh'))).mode & 0o777,
    ).toBe(0o700);
    await expect(
      readFile(join(destination, 'deleted.txt')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  /**
   * A `120000` overlay entry is stored in the replica as a real symlink, not
   * as a file holding its target text, and the reader refuses to follow one
   * (`O_NOFOLLOW`). Replaying it as bytes therefore fails outright rather than
   * producing a link, so the replay must read the target and recreate it the
   * way materialization does.
   */
  it('replays an overlay symbolic link as a link, not as bytes', async () => {
    const replicaRoot = join(tempPath, 'overlay-symlink-replicas');
    const revisionRoot = join(
      replicaRoot,
      'container-1',
      'revisions',
      'revision-1',
    );
    const sourceRepo = join(revisionRoot, 'repos', 'source-repo');
    await mkdir(join(sourceRepo, 'nested'), { recursive: true });
    await writeFile(join(sourceRepo, 'real.txt'), 'linked body');
    await symlink('real.txt', join(sourceRepo, 'added-link'));
    await symlink('../real.txt', join(sourceRepo, 'nested', 'climbing-link'));
    await symlink('/etc/passwd', join(sourceRepo, 'escaping-link'));

    const destination = getWorkspaceWorktreeDir('workspace-1', 'worktree-1');
    await mkdir(destination, { recursive: true });

    await replaySharedContainerOverlay({
      store: new SharedContainerReplicaStore(replicaRoot),
      revisionRoot,
      layout: {
        schemaVersion: 1,
        containerType: 'CODE_WORKTREE',
        title: 'Fork',
        repositories: [
          {
            repoId: 'source-repo',
            repoName: 'Repo',
            remoteUrl: 'https://github.com/example/repo.git',
            owner: 'example',
            repository: 'repo',
            baseCommitSha: 'a'.repeat(40),
            files: [
              {
                path: 'added-link',
                status: 'added',
                artifactId: 'l',
                mode: '120000',
              },
              {
                path: 'nested/climbing-link',
                status: 'added',
                artifactId: 'c',
                mode: '120000',
              },
              {
                path: 'escaping-link',
                status: 'added',
                artifactId: 'e',
                mode: '120000',
              },
            ],
          },
        ],
        files: [],
        notes: [],
        prompts: [],
        attachmentPaths: {},
      },
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
      repoIds: new Map([['source-repo', 'workspace-1']]),
      singleRepo: true,
    });

    const added = join(destination, 'added-link');
    expect((await lstat(added)).isSymbolicLink()).toBe(true);
    expect(await readlink(added, 'utf8')).toBe('real.txt');
    const climbing = join(destination, 'nested', 'climbing-link');
    expect((await lstat(climbing)).isSymbolicLink()).toBe(true);
    expect(await readlink(climbing, 'utf8')).toBe('../real.txt');
    // Escaping targets are skipped, never written as a link or as bytes.
    await expect(
      lstat(join(destination, 'escaping-link')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replays file and directory type changes independent of declaration order', async () => {
    const replicaRoot = join(tempPath, 'type-change-replicas');
    const revisionRoot = join(
      replicaRoot,
      'container-1',
      'revisions',
      'revision-1',
    );
    const sourceRepo = join(revisionRoot, 'repos', 'source-repo');
    await mkdir(join(sourceRepo, 'file-to-directory'), { recursive: true });
    await writeFile(
      join(sourceRepo, 'file-to-directory', 'added.txt'),
      'nested replacement',
    );
    await writeFile(join(sourceRepo, 'directory-to-file'), 'file replacement');

    const destination = getWorkspaceWorktreeDir('workspace-1', 'worktree-1');
    await mkdir(join(destination, 'directory-to-file'), { recursive: true });
    await writeFile(join(destination, 'file-to-directory'), 'old file');
    await writeFile(
      join(destination, 'directory-to-file', 'deleted.txt'),
      'old nested file',
    );

    await replaySharedContainerOverlay({
      store: new SharedContainerReplicaStore(replicaRoot),
      revisionRoot,
      layout: {
        schemaVersion: 1,
        containerType: 'CODE_WORKTREE',
        title: 'Fork',
        repositories: [
          {
            repoId: 'source-repo',
            repoName: 'Repo',
            remoteUrl: 'https://github.com/example/repo.git',
            owner: 'example',
            repository: 'repo',
            baseCommitSha: 'a'.repeat(40),
            files: [
              {
                path: 'file-to-directory/added.txt',
                status: 'added',
                artifactId: 'nested',
                mode: '100644',
              },
              {
                path: 'directory-to-file',
                status: 'added',
                artifactId: 'replacement',
                mode: '100644',
              },
              {
                path: 'directory-to-file/deleted.txt',
                status: 'deleted',
                mode: '100644',
              },
              {
                path: 'file-to-directory',
                status: 'deleted',
                mode: '100644',
              },
            ],
          },
        ],
        files: [],
        notes: [],
        prompts: [],
        attachmentPaths: {},
      },
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
      repoIds: new Map([['source-repo', 'workspace-1']]),
      singleRepo: true,
    });

    await expect(
      readFile(join(destination, 'file-to-directory', 'added.txt'), 'utf8'),
    ).resolves.toBe('nested replacement');
    await expect(
      readFile(join(destination, 'directory-to-file'), 'utf8'),
    ).resolves.toBe('file replacement');
  });

  it('uses locally allocated repository ids when replaying a schema-v2 snapshot overlay', async () => {
    const replicaRoot = join(tempPath, 'multi-repo-replicas');
    const revisionRoot = join(
      replicaRoot,
      'container-1',
      'revisions',
      'revision-1',
    );
    for (const [repoId, content] of [
      ['published-one', 'one'],
      ['published-two', 'two'],
    ] as const) {
      await mkdir(join(revisionRoot, 'repos', repoId), { recursive: true });
      await writeFile(
        join(revisionRoot, 'repos', repoId, 'changed.txt'),
        content,
      );
    }
    const firstDestination = getWorkspaceWorktreeRepoDir(
      'workspace-1',
      'worktree-1',
      'local-one-2',
    );
    const secondDestination = getWorkspaceWorktreeRepoDir(
      'workspace-1',
      'worktree-1',
      'local-two-2',
    );
    await mkdir(firstDestination, { recursive: true });
    await mkdir(secondDestination, { recursive: true });

    await replaySharedContainerOverlay({
      store: new SharedContainerReplicaStore(replicaRoot),
      revisionRoot,
      layout: {
        schemaVersion: 2,
        containerType: 'CODE_WORKTREE',
        title: 'Fork',
        repositories: [
          {
            repoId: 'published-one',
            repoName: 'One',
            source: 'snapshot',
            baseCommitSha: 'a'.repeat(40),
            snapshot: {
              bundleArtifactIds: ['snapshot-bundle'],
              treeFileCount: 1,
              treeBytes: '3',
            },
            files: [
              {
                path: 'changed.txt',
                status: 'modified',
                artifactId: 'one',
                mode: '100644',
              },
            ],
          },
          {
            repoId: 'published-two',
            repoName: 'Two',
            remoteUrl: 'https://github.com/example/two.git',
            owner: 'example',
            repository: 'two',
            baseCommitSha: 'b'.repeat(40),
            files: [
              {
                path: 'changed.txt',
                status: 'modified',
                artifactId: 'two',
                mode: '100644',
              },
            ],
          },
        ],
        files: [],
        notes: [],
        prompts: [],
        attachmentPaths: {},
      },
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
      repoIds: new Map([
        ['published-one', 'local-one-2'],
        ['published-two', 'local-two-2'],
      ]),
      singleRepo: false,
    });

    await expect(
      readFile(join(firstDestination, 'changed.txt'), 'utf8'),
    ).resolves.toBe('one');
    await expect(
      readFile(join(secondDestination, 'changed.txt'), 'utf8'),
    ).resolves.toBe('two');
  });

  it('removes a retained multi-repo root checkout when repair blocks a fork', async () => {
    jest.mocked(readAllSidebarItems).mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'workspace-1',
          type: 'multi-repo',
          name: 'Existing workspace',
          color: '#000000',
          collapsed: false,
          order: 0,
          sourceRepoPath: '/repos/workspace-root',
          repos: [
            { id: 'local-one', name: 'One', repoPath: '/repos/one' },
            { id: 'local-two', name: 'Two', repoPath: '/repos/two' },
          ],
          worktrees: [],
        },
      ],
    });
    jest
      .mocked(getRemoteUrl)
      .mockImplementation((repoPath) =>
        Promise.resolve(
          repoPath === '/repos/one'
            ? 'https://github.com/example/one.git'
            : 'https://github.com/example/two.git',
        ),
      );
    jest.mocked(createMultiRepoWorktree).mockResolvedValue({
      id: 'repair-worktree',
      branchName: 'canopy/fork-repair',
      createdAt: '2026-10-15T00:00:00.000Z',
      needsRepair: true,
      repairIssues: [
        {
          code: 'missing-canopy-json',
          message: 'canopy.json is missing',
          blocking: true,
        },
      ],
    });
    jest.mocked(archiveMultiRepoWorktree).mockResolvedValue({
      success: true,
      warnings: [],
    });
    jest.mocked(resolveRefSha).mockResolvedValue('c'.repeat(40));
    jest.mocked(deleteBranchIfMatches).mockResolvedValue(undefined);
    const layout = {
      schemaVersion: 1 as const,
      containerType: 'CODE_WORKTREE' as const,
      title: 'Fork',
      repositories: [
        {
          repoId: 'published-one',
          repoName: 'One',
          remoteUrl: 'https://github.com/example/one.git',
          owner: 'example',
          repository: 'one',
          baseCommitSha: 'a'.repeat(40),
          files: [],
        },
        {
          repoId: 'published-two',
          repoName: 'Two',
          remoteUrl: 'https://github.com/example/two.git',
          owner: 'example',
          repository: 'two',
          baseCommitSha: 'b'.repeat(40),
          files: [],
        },
      ],
      files: [],
      notes: [],
      prompts: [],
      attachmentPaths: {},
    };

    await expect(
      forkSharedCodeContainer({
        owner: { kind: 'personal' },
        request: {
          containerId: 'container-1',
          revisionId: 'revision-1',
          organizationId: 'organization-1',
          sourceOwnerDisplayName: 'Ada',
          destination: {
            kind: 'existing-workspace',
            workspaceId: 'workspace-1',
          },
        },
        provenance: {
          sourceContainerId: 'container-1',
          sourceRevisionId: 'revision-1',
          sourceOwnerDisplayName: 'Ada',
          organizationId: 'organization-1',
          forkedAt: '2026-09-10T00:00:00.000Z',
        },
        revisionRoot: join(tempPath, 'revision'),
        layout,
        store: new SharedContainerReplicaStore(join(tempPath, 'replicas')),
      }),
    ).rejects.toThrow('Fork destination workspace root requires repair');

    expect(archiveMultiRepoWorktree).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      worktreeId: 'repair-worktree',
      allowMissingRow: true,
      expectedCreatedAt: '2026-10-15T00:00:00.000Z',
      expectedBranchName: 'canopy/fork-repair',
      retainAsArchivedContainer: false,
      deleteBranch: false,
    });
    expect(resolveRefSha).toHaveBeenCalledWith(
      '/repos/workspace-root',
      'refs/heads/canopy/fork-repair',
    );
    expect(deleteBranchIfMatches).toHaveBeenCalledWith(
      '/repos/workspace-root',
      'canopy/fork-repair',
      'c'.repeat(40),
    );
    expect(
      jest.mocked(archiveMultiRepoWorktree).mock.invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(deleteBranchIfMatches).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('forces generated branch deletion when an existing-workspace fork rolls back', async () => {
    jest.mocked(readAllSidebarItems).mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'workspace-1',
          type: 'single-repo',
          name: 'Existing workspace',
          color: '#000000',
          collapsed: false,
          order: 0,
          repoPath: '/repos/existing',
          worktrees: [],
        },
      ],
    });
    jest
      .mocked(getRemoteUrl)
      .mockResolvedValue('https://github.com/example/repo.git');
    jest.mocked(createSingleRepoWorktree).mockResolvedValue({
      id: 'failed-worktree',
      branchName: 'canopy/fork-failed',
      createdAt: '2026-10-15T00:00:00.000Z',
    });
    jest.mocked(archiveSingleRepoWorktree).mockResolvedValue({
      success: true,
      warnings: [],
    });

    await expect(
      forkSharedCodeContainer({
        owner: { kind: 'personal' },
        request: {
          containerId: 'container-1',
          revisionId: 'revision-1',
          organizationId: 'organization-1',
          sourceOwnerDisplayName: 'Ada',
          destination: {
            kind: 'existing-workspace',
            workspaceId: 'workspace-1',
          },
        },
        provenance: {
          sourceContainerId: 'container-1',
          sourceRevisionId: 'revision-1',
          sourceOwnerDisplayName: 'Ada',
          organizationId: 'organization-1',
          forkedAt: '2026-09-10T00:00:00.000Z',
        },
        revisionRoot: join(tempPath, 'missing-revision'),
        layout: {
          schemaVersion: 1,
          containerType: 'CODE_WORKTREE',
          title: 'Fork',
          repositories: [
            {
              repoId: 'published-repo',
              repoName: 'Repo',
              remoteUrl: 'https://github.com/example/repo.git',
              owner: 'example',
              repository: 'repo',
              baseCommitSha: 'a'.repeat(40),
              files: [
                {
                  path: 'missing.txt',
                  status: 'modified',
                  artifactId: 'missing',
                  mode: '100644',
                },
              ],
            },
          ],
          files: [],
          notes: [],
          prompts: [],
          attachmentPaths: {},
        },
        store: new SharedContainerReplicaStore(join(tempPath, 'replicas')),
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    expect(archiveSingleRepoWorktree).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      worktreeId: 'failed-worktree',
      retainAsArchivedContainer: false,
      deleteBranch: true,
    });
  });

  it('removes the rehydrated chat scope when a fork into an existing Cowork workspace rolls back', async () => {
    jest.mocked(readAllSidebarItems).mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'cowork-1',
          type: 'cowork',
          name: 'Existing cowork',
          color: '#000000',
          collapsed: false,
          order: 0,
        },
      ],
    });
    const chat = {
      schemaVersion: 1 as const,
      chatId: 'published-chat',
      title: 'Published transcript',
      createdAt: '2026-09-10T12:00:00.000Z',
      messages: [],
    };
    const reader = new SharedContainerReader(
      new SharedContainerReplicaStore(join(tempPath, 'replicas')),
    );
    jest
      .spyOn(reader, 'readForkChats')
      .mockResolvedValue([{ artifactChatId: 'artifact-one', chat }]);
    jest.mocked(getSharedContainerReader).mockReturnValue(reader);
    // Finalize commits the rehydrated tabs into canonical v2 storage before
    // provenance is written; the failure lands after that commit.
    jest
      .mocked(writeChatTabsFile)
      .mockImplementationOnce(async (projectId, worktreeId, data) => {
        await jest
          .requireActual<typeof ChatTabsModule>('../lib/chat-tabs')
          .writeChatTabsFile(projectId, worktreeId, data);
        throw new Error('provenance write failed');
      });

    await expect(
      forkSharedCoworkContainer({
        owner: { kind: 'personal' },
        request: {
          containerId: 'container-1',
          revisionId: 'revision-1',
          organizationId: 'organization-1',
          sourceOwnerDisplayName: 'Ada',
          destination: { kind: 'existing-workspace', workspaceId: 'cowork-1' },
        },
        provenance: {
          sourceContainerId: 'container-1',
          sourceRevisionId: 'revision-1',
          sourceOwnerDisplayName: 'Ada',
          organizationId: 'organization-1',
          forkedAt: '2026-09-10T00:00:00.000Z',
        },
        revisionRoot: join(tempPath, 'missing-revision'),
        layout: {
          schemaVersion: 1,
          containerType: 'COWORK_WORK_ENTRY',
          title: 'Fork',
          repositories: [],
          files: [],
          notes: [],
          prompts: [],
          attachmentPaths: {},
        },
        store: new SharedContainerReplicaStore(join(tempPath, 'replicas')),
      }),
    ).rejects.toThrow('provenance write failed');

    const tabsWrite = jest.mocked(writeChatTabsFile).mock.calls[0];
    if (!tabsWrite) throw new Error('fork never wrote the rehydrated tabs');
    const entryId = tabsWrite[1];
    const legacyTabsPath = getWorkspaceChatTabsFilePath('cowork-1', entryId);
    const store = new ChatStorageV2(join(legacyTabsPath, '..', '..'), entryId);
    await expect(lstat(store.manifestPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(jest.mocked(cleanupPersistedWorktreeData)).toHaveBeenCalledWith(
      'cowork-1',
      entryId,
    );
    await expect(lstat(store.directory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(lstat(legacyTabsPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      lstat(join(getWorktreeDataRootDir('cowork-1'), entryId)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const registry: unknown = JSON.parse(
      await readFile(getWorkspaceWorkEntriesFilePath('cowork-1'), 'utf8'),
    );
    expect(registry).toMatchObject({ entries: [] });
    // Settle every admitted scope operation before the temp data dir goes
    // away; the singleton is process-wide, so hand later tests a fresh one.
    await getChatStateService().drain();
    resetChatStateServiceForTests();
  }, 15_000);

  it('copies only declared Cowork items to an external folder and deduplicates a repeated fork', async () => {
    const replicaRoot = join(tempPath, 'cowork-replicas');
    const revisionRoot = join(
      replicaRoot,
      'container-1',
      'revisions',
      'revision-1',
    );
    await mkdir(join(revisionRoot, 'content', 'notes'), { recursive: true });
    await mkdir(join(revisionRoot, 'content', 'prompts'), { recursive: true });
    await writeFile(
      join(revisionRoot, 'content', 'notes', 'Selected_Note.md'),
      '# Selected note\n\nKeep this.\n',
    );
    await writeFile(
      join(revisionRoot, 'content', 'notes', 'unticked-note.md'),
      '# Unticked note\n\nDo not copy this.\n',
    );
    await writeFile(
      join(revisionRoot, 'content', 'prompts', 'Selected_Prompt.md'),
      '---\nmode: literal\n---\nPrompt body',
    );
    const externalRoot = join(tempPath, 'external-cowork');
    await mkdir(externalRoot, { recursive: true });
    registerWorkspaceTypes(new Map([['cowork-1', 'cowork']]));
    registerWorkspaceExternalPaths(new Map([['cowork-1', externalRoot]]));
    const layout = {
      schemaVersion: 1 as const,
      containerType: 'COWORK_WORK_ENTRY' as const,
      title: 'Fork',
      repositories: [],
      files: [],
      notes: [{ itemId: 'Selected_Note', title: 'Selected note' }],
      prompts: [{ itemId: 'Selected_Prompt', title: 'Selected prompt' }],
      attachmentPaths: {},
    };
    const rollbackActions: Array<() => Promise<unknown>> = [];
    const options = {
      store: new SharedContainerReplicaStore(replicaRoot),
      revisionRoot,
      layout,
      workspaceId: 'cowork-1',
      sourceContainerId: 'container-1',
      sourceRevisionId: 'revision-1',
      rollback: {
        defer: (action: () => Promise<unknown>): void => {
          rollbackActions.push(action);
        },
      },
    };

    await copyForkWorkspaceItems(options);
    await copyForkWorkspaceItems(options);

    const noteFiles = await readdir(
      getCoworkManagedSubdir(externalRoot, 'notes'),
    );
    const promptFiles = await readdir(
      getCoworkManagedSubdir(externalRoot, 'prompts'),
    );
    expect(noteFiles).toHaveLength(1);
    expect(promptFiles).toHaveLength(1);
    expect(noteFiles[0]).toMatch(/^Selected_Note-[a-f0-9]{12}\.md$/);
    expect(promptFiles[0]).toMatch(/^Selected_Prompt-[a-f0-9]{12}\.md$/);
    await expect(
      readNote('cowork-1', noteFiles[0]?.slice(0, -3) ?? ''),
    ).resolves.toMatchObject({ content: '# Selected note\n\nKeep this.\n' });
    await expect(
      readPrompt('cowork-1', promptFiles[0]?.slice(0, -3) ?? ''),
    ).resolves.toMatchObject({
      content: '---\nmode: literal\n---\nPrompt body',
    });
    await expect(
      lstat(
        join(getCoworkManagedSubdir(externalRoot, 'notes'), 'unticked-note.md'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(rollbackActions).toHaveLength(2);
    for (const action of rollbackActions.reverse()) await action();
    await expect(
      lstat(
        join(getCoworkManagedSubdir(externalRoot, 'notes'), noteFiles[0] ?? ''),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      lstat(
        join(
          getCoworkManagedSubdir(externalRoot, 'prompts'),
          promptFiles[0] ?? '',
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rehydrates every chat artifact with a unique local tab id', async () => {
    const first = {
      schemaVersion: 1 as const,
      chatId: 'duplicate-chat',
      title: 'First transcript',
      createdAt: '2026-09-10T12:00:00.000Z',
      messages: [],
    };
    const second = { ...first, title: 'Second transcript' };
    const reader = new SharedContainerReader(
      new SharedContainerReplicaStore(join(tempPath, 'replicas')),
    );
    jest.spyOn(reader, 'readForkChats').mockResolvedValue([
      { artifactChatId: 'artifact-one', chat: first },
      { artifactChatId: 'artifact-two', chat: second },
    ]);
    jest.mocked(getSharedContainerReader).mockReturnValue(reader);

    const warnings = await rehydrateForkChats({
      containerId: 'container-1',
      revisionId: 'revision-1',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      attachments: new Map(),
    });

    expect(jest.mocked(writeChatTabsFile)).toHaveBeenCalledWith(
      'workspace-1',
      'worktree-1',
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            id: 'duplicate-chat',
            title: 'First transcript',
          }),
          expect.objectContaining({
            id: 'artifact-two',
            title: 'Second transcript',
          }),
        ],
      }),
    );
    expect(warnings).toEqual([expect.stringContaining('duplicate-chat')]);
  });

  it('projects recipient chats as read-only tabs', () => {
    const result = projectPublishedChatsToTabs({
      publishedChats: [
        {
          artifactChatId: 'artifact-one',
          chat: {
            schemaVersion: 1,
            chatId: 'chat-one',
            title: 'Published transcript',
            createdAt: '2026-09-10T12:00:00.000Z',
            messages: [],
          },
        },
      ],
      projectId: 'shared-container-viewer',
      worktreeId: 'container-1',
      resolveAttachment: () => undefined,
      readOnly: true,
    });

    expect(result.tabs).toEqual([
      expect.objectContaining({ id: 'chat-one', readOnly: true }),
    ]);
  });

  it('leaves initial recipient layout retryable when canonical chat projection fails', async () => {
    const replicaRoot = join(tempPath, 'projection-replicas');
    const revisionRoot = join(
      replicaRoot,
      'container-1',
      'revisions',
      'revision-1',
    );
    const repoRoot = join(revisionRoot, 'repos', 'repo-1');
    await mkdir(join(revisionRoot, 'artifacts'), { recursive: true });
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, 'index.html'), '<h1>Shared</h1>');
    await writeFile(
      join(revisionRoot, 'artifacts', 'container.json'),
      JSON.stringify({
        schemaVersion: 3,
        containerType: 'CODE_WORKTREE',
        title: 'Shared feature',
        repositories: [
          {
            repoId: 'repo-1',
            repoName: 'Repo',
            remoteUrl: 'https://github.com/acme/repo.git',
            owner: 'acme',
            repository: 'repo',
            baseCommitSha: 'a'.repeat(40),
            files: [
              {
                path: 'index.html',
                status: 'added',
                artifactId: 'file-1',
                mode: '100644',
              },
            ],
          },
        ],
        files: [],
        notes: [],
        prompts: [],
        attachmentPaths: {},
        layout: {
          orientation: 0,
          root: {
            type: 'leaf',
            size: 1,
            tabs: [
              {
                kind: 'browser',
                repoId: 'repo-1',
                relativePath: 'index.html',
              },
            ],
            activeTabIndex: 0,
          },
        },
      }),
    );
    const store = new SharedContainerReplicaStore(replicaRoot);
    await store.set({
      containerId: 'container-1',
      organizationId: 'organization-1',
      containerType: 'CODE_WORKTREE',
      status: 'available',
      revisionId: 'revision-1',
      revision: 1,
      revisionCreatedAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    });
    jest
      .mocked(getSharedContainerReader)
      .mockReturnValue(new SharedContainerReader(store));
    const chatState = {
      getCompatibilityTabs: jest.fn().mockResolvedValue({
        version: 1,
        tabs: [],
        activeTabId: '',
      }),
      replaceCompatibilityTabs: jest
        .fn()
        .mockRejectedValue(new Error('canonical chat projection failed')),
    } as unknown as ChatStateService;

    try {
      await expect(
        projectSharedContainerViewerChats(
          'container-1',
          'revision-1',
          chatState,
        ),
      ).rejects.toThrow('canonical chat projection failed');
      expect(
        panelLayoutPersistenceStore.loadWorktreeLayout(
          'shared-container-viewer',
          'container-1',
        ),
      ).toBeNull();
    } finally {
      panelLayoutPersistenceStore.deleteWorktreeLayout(
        'shared-container-viewer',
        'container-1',
      );
    }
  });

  it('falls back to the publisher layout when a v4 start page is inadmissible', async () => {
    const replicaRoot = join(tempPath, 'start-page-fallback-replicas');
    const revisionRoot = join(
      replicaRoot,
      'container-1',
      'revisions',
      'revision-1',
    );
    const repoRoot = join(revisionRoot, 'repos', 'repo-1');
    await mkdir(join(revisionRoot, 'artifacts', 'chats'), { recursive: true });
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, 'index.html'), '<h1>Fallback</h1>');
    await writeFile(
      join(revisionRoot, 'artifacts', 'container.json'),
      JSON.stringify({
        schemaVersion: 4,
        containerType: 'CODE_WORKTREE',
        title: 'Shared feature',
        repositories: [
          {
            repoId: 'repo-1',
            repoName: 'Repo',
            remoteUrl: 'https://github.com/acme/repo.git',
            owner: 'acme',
            repository: 'repo',
            baseCommitSha: 'a'.repeat(40),
            files: [
              {
                path: 'index.html',
                status: 'added',
                artifactId: 'file-1',
                mode: '100644',
              },
            ],
          },
        ],
        files: [],
        notes: [],
        prompts: [],
        attachmentPaths: {},
        startPage: {
          kind: 'file',
          repoId: 'repo-1',
          relativePath: 'missing.html',
        },
        layout: {
          orientation: 0,
          root: {
            type: 'leaf',
            size: 1,
            tabs: [
              {
                kind: 'browser',
                repoId: 'repo-1',
                relativePath: 'index.html',
              },
            ],
            activeTabIndex: 0,
          },
        },
      }),
    );
    const store = new SharedContainerReplicaStore(replicaRoot);
    await store.set({
      containerId: 'container-1',
      organizationId: 'organization-1',
      containerType: 'CODE_WORKTREE',
      status: 'available',
      revisionId: 'revision-1',
      revision: 1,
      revisionCreatedAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    });
    jest
      .mocked(getSharedContainerReader)
      .mockReturnValue(new SharedContainerReader(store));
    const chatState = {
      getCompatibilityTabs: jest.fn().mockResolvedValue({
        version: 1,
        tabs: [],
        activeTabId: '',
      }),
      replaceCompatibilityTabs: jest.fn().mockResolvedValue(undefined),
    } as unknown as ChatStateService;

    try {
      await projectSharedContainerViewerChats(
        'container-1',
        'revision-1',
        chatState,
      );

      const layout = migratePanelLayout(
        panelLayoutPersistenceStore.loadWorktreeLayout(
          'shared-container-viewer',
          'container-1',
        ),
      );
      const root = layout?.grid.root;
      expect(root?.type === 'leaf' ? root.panels : []).toEqual([
        expect.objectContaining({ kind: 'browser' }),
      ]);
    } finally {
      panelLayoutPersistenceStore.deleteWorktreeLayout(
        'shared-container-viewer',
        'container-1',
      );
    }
  });

  it('repoints retained multi-repo file tabs without truncating nested content directories', async () => {
    const replicaRoot = join(tempPath, 'repoint-replicas');
    const revisionRoot = join(
      replicaRoot,
      'container-1',
      'revisions',
      'revision-2',
    );
    const firstRepoRoot = join(revisionRoot, 'repos', 'repo-1');
    const secondRepoRoot = join(revisionRoot, 'repos', 'repo-2');
    await mkdir(join(revisionRoot, 'artifacts', 'chats'), { recursive: true });
    await mkdir(firstRepoRoot, { recursive: true });
    await mkdir(join(secondRepoRoot, 'docs', 'content'), { recursive: true });
    await writeFile(join(firstRepoRoot, 'index.html'), 'wrong repository');
    await writeFile(
      join(secondRepoRoot, 'docs', 'content', 'index.html'),
      'retained file',
    );
    await writeFile(
      join(revisionRoot, 'artifacts', 'container.json'),
      JSON.stringify({
        schemaVersion: 1,
        containerType: 'CODE_WORKTREE',
        title: 'Shared feature',
        repositories: [
          {
            repoId: 'repo-1',
            repoName: 'First',
            remoteUrl: 'https://github.com/acme/first.git',
            owner: 'acme',
            repository: 'first',
            baseCommitSha: 'a'.repeat(40),
            files: [],
          },
          {
            repoId: 'repo-2',
            repoName: 'Second',
            remoteUrl: 'https://github.com/acme/second.git',
            owner: 'acme',
            repository: 'second',
            baseCommitSha: 'b'.repeat(40),
            files: [],
          },
        ],
        files: [],
        notes: [],
        prompts: [],
        attachmentPaths: {},
      }),
    );
    const store = new SharedContainerReplicaStore(replicaRoot);
    await store.set({
      containerId: 'container-1',
      organizationId: 'organization-1',
      containerType: 'CODE_WORKTREE',
      status: 'available',
      revisionId: 'revision-2',
      revision: 2,
      revisionCreatedAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
    });
    jest
      .mocked(getSharedContainerReader)
      .mockReturnValue(new SharedContainerReader(store));
    const previousFilePath = join(
      replicaRoot,
      'container-1',
      'revisions',
      'revision-1',
      'repos',
      'repo-2',
      'docs',
      'content',
      'index.html',
    );
    const replaceCompatibilityTabs = jest.fn().mockResolvedValue(undefined);
    const chatState = {
      getCompatibilityTabs: jest.fn().mockResolvedValue({
        version: 1,
        tabs: [
          {
            id: 'retained-file',
            title: 'index.html',
            kind: 'file',
            filePath: previousFilePath,
            createdAt: '2026-09-10T00:00:00.000Z',
            messages: [],
          },
        ],
        activeTabId: 'retained-file',
      }),
      replaceCompatibilityTabs,
    } as unknown as ChatStateService;

    await projectSharedContainerViewerChats(
      'container-1',
      'revision-2',
      chatState,
    );

    expect(replaceCompatibilityTabs).toHaveBeenCalledWith(
      { projectId: 'shared-container-viewer', worktreeId: 'container-1' },
      expect.objectContaining({
        activeTabId: 'retained-file',
        tabs: [
          expect.objectContaining({
            id: 'retained-file',
            filePath: join(secondRepoRoot, 'docs', 'content', 'index.html'),
          }),
        ],
      }),
      expect.objectContaining({ activeTabId: 'retained-file' }),
    );
  });

  it('opens publisher tabs on unchanged files the code replica checked out', async () => {
    const replicaRoot = join(tempPath, 'unchanged-file-replicas');
    const revisionRoot = join(
      replicaRoot,
      'container-1',
      'revisions',
      'revision-1',
    );
    const repoRoot = join(revisionRoot, 'repos', 'repo-1');
    await mkdir(join(revisionRoot, 'artifacts', 'chats'), { recursive: true });
    await mkdir(join(repoRoot, 'docs'), { recursive: true });
    await writeFile(join(repoRoot, 'docs', 'guide.md'), 'unchanged file');
    await writeFile(
      join(revisionRoot, 'artifacts', 'container.json'),
      JSON.stringify({
        schemaVersion: 3,
        containerType: 'CODE_WORKTREE',
        title: 'Shared feature',
        repositories: [
          {
            repoId: 'repo-1',
            repoName: 'First',
            remoteUrl: 'https://github.com/acme/first.git',
            owner: 'acme',
            repository: 'first',
            baseCommitSha: 'a'.repeat(40),
            files: [],
          },
        ],
        files: [],
        notes: [],
        prompts: [],
        attachmentPaths: {},
        layout: {
          orientation: 0,
          root: {
            type: 'leaf',
            size: 1,
            tabs: [
              {
                kind: 'file',
                repoId: 'repo-1',
                relativePath: 'docs/guide.md',
                viewMode: 'raw',
              },
              {
                kind: 'file',
                repoId: 'repo-1',
                relativePath: 'docs/missing.md',
                viewMode: 'raw',
              },
            ],
            activeTabIndex: 0,
          },
        },
      }),
    );
    const store = new SharedContainerReplicaStore(replicaRoot);
    await store.set({
      containerId: 'container-1',
      organizationId: 'organization-1',
      containerType: 'CODE_WORKTREE',
      status: 'available',
      revisionId: 'revision-1',
      revision: 1,
      revisionCreatedAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    });
    jest
      .mocked(getSharedContainerReader)
      .mockReturnValue(new SharedContainerReader(store));
    const replaceCompatibilityTabs = jest.fn().mockResolvedValue(undefined);
    const chatState = {
      getCompatibilityTabs: jest.fn().mockResolvedValue({
        version: 1,
        tabs: [],
        activeTabId: '',
      }),
      replaceCompatibilityTabs,
    } as unknown as ChatStateService;

    try {
      await projectSharedContainerViewerChats(
        'container-1',
        'revision-1',
        chatState,
      );

      const layout = migratePanelLayout(
        panelLayoutPersistenceStore.loadWorktreeLayout(
          'shared-container-viewer',
          'container-1',
        ),
      );
      const root = layout?.grid.root;
      expect(root?.type === 'leaf' ? root.panels : []).toHaveLength(1);
      expect(replaceCompatibilityTabs).toHaveBeenCalledWith(
        { projectId: 'shared-container-viewer', worktreeId: 'container-1' },
        expect.objectContaining({
          tabs: [
            expect.objectContaining({
              kind: 'file',
              filePath: join(repoRoot, 'docs', 'guide.md'),
              readOnly: true,
            }),
          ],
        }),
        expect.anything(),
      );
    } finally {
      panelLayoutPersistenceStore.deleteWorktreeLayout(
        'shared-container-viewer',
        'container-1',
      );
    }
  });

  it('keeps the selected recipient chat when it survives a revision', () => {
    const tabs = [
      {
        id: 'chat-one',
        title: 'One',
        createdAt: '2026-09-10T12:00:00.000Z',
        messages: [],
      },
      {
        id: 'chat-two',
        title: 'Two',
        createdAt: '2026-09-10T12:00:00.000Z',
        messages: [],
      },
    ];
    expect(selectProjectedViewerActiveTabId('chat-two', tabs)).toBe('chat-two');
    expect(selectProjectedViewerActiveTabId('removed-chat', tabs)).toBe(
      'chat-one',
    );
  });

  it('keeps Cowork items from unrelated source revisions separate', async () => {
    const replicaRoot = join(tempPath, 'cowork-source-replicas');
    const firstRevisionRoot = join(
      replicaRoot,
      'container-1',
      'revisions',
      'revision-1',
    );
    const secondRevisionRoot = join(
      replicaRoot,
      'container-2',
      'revisions',
      'revision-2',
    );
    for (const revisionRoot of [firstRevisionRoot, secondRevisionRoot]) {
      await mkdir(join(revisionRoot, 'content', 'notes'), { recursive: true });
    }
    await writeFile(
      join(firstRevisionRoot, 'content', 'notes', 'shared-id.md'),
      'First source',
    );
    await writeFile(
      join(secondRevisionRoot, 'content', 'notes', 'shared-id.md'),
      'Second source',
    );
    const externalRoot = join(tempPath, 'external-source-cowork');
    await mkdir(externalRoot, { recursive: true });
    registerWorkspaceTypes(new Map([['cowork-1', 'cowork']]));
    registerWorkspaceExternalPaths(new Map([['cowork-1', externalRoot]]));
    const layout = {
      schemaVersion: 1 as const,
      containerType: 'COWORK_WORK_ENTRY' as const,
      title: 'Fork',
      repositories: [],
      files: [],
      notes: [{ itemId: 'shared-id', title: 'Shared note' }],
      prompts: [],
      attachmentPaths: {},
    };
    const rollback = { defer: jest.fn() };

    await copyForkWorkspaceItems({
      store: new SharedContainerReplicaStore(replicaRoot),
      revisionRoot: firstRevisionRoot,
      layout,
      workspaceId: 'cowork-1',
      sourceContainerId: 'container-1',
      sourceRevisionId: 'revision-1',
      rollback,
    });
    await copyForkWorkspaceItems({
      store: new SharedContainerReplicaStore(replicaRoot),
      revisionRoot: secondRevisionRoot,
      layout,
      workspaceId: 'cowork-1',
      sourceContainerId: 'container-2',
      sourceRevisionId: 'revision-2',
      rollback,
    });

    const noteFiles = await readdir(
      getCoworkManagedSubdir(externalRoot, 'notes'),
    );
    expect(noteFiles).toHaveLength(2);
    await expect(
      Promise.all(
        noteFiles.map((filename) =>
          readNote('cowork-1', filename.slice(0, -3)),
        ),
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: 'First source' }),
        expect.objectContaining({ content: 'Second source' }),
      ]),
    );
  });

  it('rejects a Cowork revision that materialized a plan', async () => {
    const replicaRoot = join(tempPath, 'replicas');
    const revisionRoot = join(
      replicaRoot,
      'container-1',
      'revisions',
      'revision-1',
    );
    await mkdir(join(revisionRoot, 'content', 'plans'), { recursive: true });
    await writeFile(join(revisionRoot, 'content', 'plans', 'plan.json'), '{}');

    await expect(
      assertNoPublishedPlans(
        new SharedContainerReplicaStore(replicaRoot),
        revisionRoot,
      ),
    ).rejects.toThrow(/cannot contain plans/i);
  });

  it('refuses a revision whose checkout is on loan to staging', async () => {
    const revisionRoot = join(tempPath, 'revision');
    await mkdir(join(revisionRoot, 'repos'), { recursive: true });
    await writeFile(join(revisionRoot, 'repos', '.canopy-borrowed'), '');

    await expect(
      assertRevisionCheckoutNotBorrowed(revisionRoot),
    ).rejects.toThrow(/temporarily unavailable/i);
  });

  it('holds replica mutations until the guarded fork read completes', async () => {
    const replicaRoot = join(tempPath, 'guarded-replicas');
    const revisionRoot = join(
      replicaRoot,
      'container-1',
      'revisions',
      'revision-1',
    );
    await mkdir(revisionRoot, { recursive: true });
    const manager = new SharedContainerReplicaManager({
      rootDir: replicaRoot,
      transport: {} as SharedContainerReplicaTransport,
    });
    await manager.store.set({
      containerId: 'container-1',
      organizationId: 'organization-1',
      containerType: 'COWORK_WORK_ENTRY',
      status: 'available',
      revisionId: 'revision-1',
      revision: 1,
      revisionCreatedAt: '2026-09-09T12:00:00.000Z',
      updatedAt: '2026-09-09T12:00:00.000Z',
    });

    const events: string[] = [];
    let releaseGuard!: () => void;
    let markGuardStarted!: () => void;
    const guardStarted = new Promise<void>((resolve) => {
      markGuardStarted = resolve;
    });
    const guardHeld = new Promise<void>((resolve) => {
      releaseGuard = resolve;
    });
    const guardedRead = manager.withReplicaReadGuard(
      'container-1',
      'organization-1',
      'revision-1',
      async (resolvedRoot) => {
        expect(resolvedRoot).toBe(revisionRoot);
        events.push('guard-start');
        markGuardStarted();
        await guardHeld;
        events.push('guard-end');
      },
    );
    await guardStarted;

    const pin = manager.pin('container-1', 'organization-1').then(() => {
      events.push('pin');
    });
    await Promise.resolve();
    expect(events).toEqual(['guard-start']);

    releaseGuard();
    await Promise.all([guardedRead, pin]);
    expect(events).toEqual(['guard-start', 'guard-end', 'pin']);
  });
});
