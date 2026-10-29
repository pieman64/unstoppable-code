import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getSharedContainerRunRootDir } from '../lib/paths';
import { SharedContainerReplicaStore } from '../shared-containers/replica/store';
import { refreshSharedContainerRunCopy } from '../shared-containers/run/run-copy';
import { ensureSharedContainerRunCopy } from '../shared-containers/run/run-copy';
import type {
  SharedContainerRevisionLayout,
  SharedContainerRevisionLayoutV2,
} from '@canopy/protocol/shared-containers';

function layout(): SharedContainerRevisionLayout {
  return {
    schemaVersion: 1,
    containerType: 'CODE_WORKTREE',
    title: 'Runnable share',
    repositories: [
      {
        repoId: 'repo-1',
        repoName: 'repo',
        remoteUrl: 'git@github.com:example/repo.git',
        owner: 'example',
        repository: 'repo',
        baseCommitSha: 'a'.repeat(40),
        files: [],
      },
    ],
    files: [],
    notes: [],
    prompts: [],
    attachmentPaths: {},
    run: {
      commands: [{ name: 'launch', command: 'make dev', repoId: 'repo-1' }],
      requiredEnv: [],
    },
  };
}

describe('shared-container run copy', () => {
  const originalDataDir = process.env.CANOPY_DATA_DIR;
  let root = '';
  let dataDir = '';
  let store: SharedContainerReplicaStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'shared-run-replica-'));
    dataDir = await mkdtemp(join(tmpdir(), 'shared-run-data-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    store = new SharedContainerReplicaStore(root);
    await store.prepareContainerForSync('container-1');
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  async function seedRevision(
    revisionId: string,
    files: Record<string, string>,
    revisionLayout:
      | SharedContainerRevisionLayout
      | SharedContainerRevisionLayoutV2 = layout(),
  ): Promise<void> {
    const revisionRoot = join(root, 'container-1', 'revisions', revisionId);
    const repoRoot = join(revisionRoot, 'repos', 'repo-1');
    await mkdir(join(revisionRoot, 'artifacts'), { recursive: true });
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    await writeFile(
      join(revisionRoot, 'artifacts', 'container.json'),
      JSON.stringify(revisionLayout),
    );
    await writeFile(join(repoRoot, '.git', 'config'), 'private remote');
    for (const [path, contents] of Object.entries(files)) {
      const target = join(repoRoot, ...path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents);
      await chmod(target, path.endsWith('.sh') ? 0o500 : 0o400);
    }
    await store.set({
      status: 'available',
      containerId: 'container-1',
      organizationId: 'org-1',
      containerType: 'CODE_WORKTREE',
      revisionId,
      revision: revisionId === 'revision-1' ? 1 : 2,
      revisionCreatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  it('copies bytes without git or hardlinks and refreshes by path provenance', async () => {
    await seedRevision('revision-1', {
      'src/app.txt': 'one',
      'src/old.txt': 'remove me',
      'bin/run.sh': '#!/bin/sh',
    });
    await refreshSharedContainerRunCopy('container-1', store);

    const runRoot = getSharedContainerRunRootDir('container-1');
    const appPath = join(runRoot, 'repo-1', 'src', 'app.txt');
    await expect(stat(join(runRoot, 'repo-1', '.git'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await stat(appPath)).nlink).toBe(1);
    expect(
      (await stat(join(runRoot, 'repo-1', 'bin', 'run.sh'))).mode & 0o777,
    ).toBe(0o700);
    expect(
      (
        await stat(
          join(
            root,
            'container-1',
            'revisions',
            'revision-1',
            'repos',
            'repo-1',
            'src',
            'app.txt',
          ),
        )
      ).mode & 0o777,
    ).toBe(0o400);

    await mkdir(join(runRoot, 'repo-1', '.venv'), { recursive: true });
    await writeFile(join(runRoot, 'repo-1', '.venv', 'marker'), 'keep');
    await mkdir(join(runRoot, 'repo-1', 'target'), { recursive: true });
    await writeFile(join(runRoot, 'repo-1', 'target', 'marker'), 'keep too');
    await writeFile(appPath, 'recipient edit');
    await seedRevision('revision-2', { 'src/app.txt': 'two' });
    await refreshSharedContainerRunCopy('container-1', store);

    expect(await readFile(appPath, 'utf8')).toBe('two');
    expect(
      await readFile(join(runRoot, 'repo-1', '.venv', 'marker'), 'utf8'),
    ).toBe('keep');
    expect(
      await readFile(join(runRoot, 'repo-1', 'target', 'marker'), 'utf8'),
    ).toBe('keep too');
    await expect(
      lstat(join(runRoot, 'repo-1', 'src', 'old.txt')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('copies a runnable schema-v2 snapshot repository', async () => {
    const snapshotLayout: SharedContainerRevisionLayoutV2 = {
      ...layout(),
      schemaVersion: 2,
      repositories: [
        {
          repoId: 'repo-1',
          repoName: 'repo',
          source: 'snapshot',
          baseCommitSha: 'a'.repeat(40),
          snapshot: {
            bundleArtifactIds: ['snapshot-artifact'],
            treeFileCount: 1,
            treeBytes: '3',
          },
          files: [],
        },
      ],
    };
    await seedRevision('revision-1', { 'src/app.txt': 'one' }, snapshotLayout);

    await expect(
      refreshSharedContainerRunCopy('container-1', store),
    ).resolves.toEqual(expect.any(String));
    await expect(
      readFile(
        join(
          getSharedContainerRunRootDir('container-1'),
          'repo-1',
          'src',
          'app.txt',
        ),
        'utf8',
      ),
    ).resolves.toBe('one');
  });

  it('fully rebuilds after finding a pending manifest', async () => {
    await seedRevision('revision-1', { 'src/app.txt': 'one' });
    await refreshSharedContainerRunCopy('container-1', store);
    const runRoot = getSharedContainerRunRootDir('container-1');
    await mkdir(join(runRoot, 'repo-1', 'target'), { recursive: true });
    await writeFile(join(runRoot, 'repo-1', 'target', 'marker'), 'generated');
    const manifestPath = join(runRoot, '.canopy-run-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, state: 'pending' }),
    );

    await refreshSharedContainerRunCopy('container-1', store);

    await expect(
      stat(join(runRoot, 'repo-1', 'target', 'marker')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not refresh an existing run copy during a later run request', async () => {
    await seedRevision('revision-1', { 'src/app.txt': 'one' });
    await refreshSharedContainerRunCopy('container-1', store);
    const runRoot = getSharedContainerRunRootDir('container-1');
    const appPath = join(runRoot, 'repo-1', 'src', 'app.txt');
    await writeFile(appPath, 'recipient edit');

    await seedRevision('revision-2', { 'src/app.txt': 'two' });
    await ensureSharedContainerRunCopy('container-1', store);

    expect(await readFile(appPath, 'utf8')).toBe('recipient edit');
  });

  it('refuses to materialize a different revision than the caller authorized', async () => {
    await seedRevision('revision-2', { 'src/app.txt': 'two' });
    const ensureForRevision = ensureSharedContainerRunCopy as (
      containerId: string,
      replicaStore: SharedContainerReplicaStore,
      expectedRevisionId: string,
    ) => Promise<string>;

    await expect(
      ensureForRevision('container-1', store, 'revision-1'),
    ).rejects.toThrow('revision changed');
  });

  it('rejects a published symlink whose destination escapes the run repo', async () => {
    await seedRevision('revision-1', { 'src/app.txt': 'one' });
    const sourceRoot = join(
      root,
      'container-1',
      'revisions',
      'revision-1',
      'repos',
      'repo-1',
    );
    await symlink('../../outside', join(sourceRoot, 'escaping-link'));

    await expect(
      refreshSharedContainerRunCopy('container-1', store),
    ).rejects.toThrow('escaped');
  });

  it('recreates an internal symlink without following it', async () => {
    await seedRevision('revision-1', { 'src/app.txt': 'one' });
    const sourceRoot = join(
      root,
      'container-1',
      'revisions',
      'revision-1',
      'repos',
      'repo-1',
    );
    await symlink('src/app.txt', join(sourceRoot, 'app-link'));

    await refreshSharedContainerRunCopy('container-1', store);

    const copied = join(
      getSharedContainerRunRootDir('container-1'),
      'repo-1',
      'app-link',
    );
    expect((await lstat(copied)).isSymbolicLink()).toBe(true);
    expect(await readlink(copied)).toBe('src/app.txt');
  });

  it('does not follow a recipient-created symlink ancestor during refresh', async () => {
    await seedRevision('revision-1', {
      'src/old.txt': 'published old value',
    });
    await refreshSharedContainerRunCopy('container-1', store);

    const runRepo = join(getSharedContainerRunRootDir('container-1'), 'repo-1');
    const outside = await mkdtemp(join(tmpdir(), 'shared-run-outside-'));
    try {
      await writeFile(join(outside, 'old.txt'), 'recipient outside value');
      await rm(join(runRepo, 'src'), { recursive: true, force: true });
      await symlink(outside, join(runRepo, 'src'));
      await seedRevision('revision-2', {
        'src/new.txt': 'published new value',
      });

      await refreshSharedContainerRunCopy('container-1', store);

      await expect(readFile(join(outside, 'old.txt'), 'utf8')).resolves.toBe(
        'recipient outside value',
      );
      expect((await lstat(join(runRepo, 'src'))).isSymbolicLink()).toBe(false);
      await expect(
        readFile(join(runRepo, 'src', 'new.txt'), 'utf8'),
      ).resolves.toBe('published new value');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rebuilds a repository on a pure-case rename', async () => {
    await seedRevision('revision-1', { 'src/OldName.txt': 'one' });
    await refreshSharedContainerRunCopy('container-1', store);
    await seedRevision('revision-2', { 'src/oldname.txt': 'two' });

    await refreshSharedContainerRunCopy('container-1', store);

    expect(
      await readdir(
        join(getSharedContainerRunRootDir('container-1'), 'repo-1', 'src'),
      ),
    ).toEqual(['oldname.txt']);
  });

  it('refuses a concurrent refresh instead of queueing it', async () => {
    await seedRevision('revision-1', { 'src/app.txt': 'one' });
    const original = store.resolveRevisionRootForRead.bind(store);
    let release: (() => void) | undefined;
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    jest
      .spyOn(store, 'resolveRevisionRootForRead')
      .mockImplementationOnce(async (...args) => {
        markEntered?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return original(...args);
      });

    const first = refreshSharedContainerRunCopy('container-1', store);
    await entered;
    await expect(
      refreshSharedContainerRunCopy('container-1', store),
    ).rejects.toThrow('already in progress');
    release?.();
    await expect(first).resolves.toContain('/run');
  });
});
