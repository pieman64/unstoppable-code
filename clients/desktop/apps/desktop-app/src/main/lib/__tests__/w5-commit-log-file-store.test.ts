import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import log from 'electron-log/main.js';
import type {
  WorkspaceIndexEntry,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  W5CommitLog,
  fingerprintW5File,
  type W5Resource,
} from '@canopy/desktop-shared/node/w5-commit-log';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);

import {
  W5CommitLogHost,
  W5CommitLogHostError,
} from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  W5FileWriteRefusedError,
} from '../w5-commit-log-file-store';
import {
  createWorkspaceIndexRepository,
  WorkspaceIndexUnreadableError,
} from '../workspace-index-repository';
import {
  createWorkspaceManifestRepository,
  WorkspaceConfigUnreadableError,
} from '../workspace-manifest-repository';
import {
  createWorktreeListRepository,
  WorktreeRegistryUnreadableError,
} from '../worktree-list-repository';
import {
  WORKSPACE_INDEX_STORAGE,
  WORKSPACE_MANIFEST_STORAGE,
  WORKTREE_LIST_STORAGE,
  withStorageAdmission,
  PROJECT_W5_STORAGE,
} from '../w5-storage';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let dbPath: string;
let host: W5CommitLogHost;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w5-repositories-'));
  root = join(dir, 'workspaces');
  mkdirSync(root);
  dbPath = join(dir, 'w5', 'commit-log.sqlite');
  host = new W5CommitLogHost({
    dbPath,
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
});
afterEach(async () => {
  await host.shutdown();
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function entry(id: string, order = 0): WorkspaceIndexEntry {
  return {
    id,
    name: id,
    type: 'cowork',
    color: '#fff',
    collapsed: false,
    order,
  };
}
function row(id: string): WorktreeData {
  return { id, branchName: id, createdAt: '2026-10-14T00:00:00Z' };
}
function repositories(): {
  store: ReturnType<typeof createW5CommitLogFileStore>;
  index: ReturnType<typeof createWorkspaceIndexRepository>;
  manifest: ReturnType<typeof createWorkspaceManifestRepository>;
  list: ReturnType<typeof createWorktreeListRepository>;
} {
  const store = createW5CommitLogFileStore(() => host);
  const index = createWorkspaceIndexRepository({
    store,
    filePath: () => join(root, 'index.json'),
    storage: WORKSPACE_INDEX_STORAGE,
    onCommitted: () => {},
    onRefused: () => {},
  });
  const manifest = createWorkspaceManifestRepository({
    store,
    filePath: (id) => join(root, id, 'workspace.json'),
    storage: WORKSPACE_MANIFEST_STORAGE,
    knownFields: new Set(['version', 'type', 'repos']),
    knownRepoFields: new Set(['id', 'name', 'repoPath']),
  });
  const list = createWorktreeListRepository({
    store,
    filePath: (id) => join(root, id, 'worktrees.json'),
    storage: WORKTREE_LIST_STORAGE,
    knownRowFields: new Set(['id', 'branchName', 'createdAt', 'label']),
  });
  return { store, index, manifest, list };
}
async function revisions(resources: W5Resource[]): Promise<number[]> {
  return Promise.all(resources.map((resource) => host.revision(resource)));
}
const workspaces: W5Resource = { kind: 'workspaces' };
const workspace = (workspaceId: string): W5Resource => ({
  kind: 'workspace',
  workspaceId,
});
const worktrees: W5Resource = { kind: 'worktrees', workspaceId: 'a' };
const worktree = (worktreeId: string): W5Resource => ({
  kind: 'worktree',
  workspaceId: 'a',
  worktreeId,
});

it('writes all three repositories, advancing only changed resources and skipping equivalent contents', async () => {
  const { index, manifest, list } = repositories();
  const recovery = jest.spyOn(host, 'recoveryReport');
  await withStorageAdmission(PROJECT_W5_STORAGE, async () => {
    await index.update(() => ({
      result: null,
      entries: [entry('a'), entry('b', 1)],
    }));
    expect(readFileSync(join(root, 'index.json'), 'utf8')).toContain(
      '"id": "a"',
    );
    expect(
      await revisions([workspaces, workspace('a'), workspace('b')]),
    ).toEqual([1, 1, 1]);
    await index.update(({ entries }) => ({
      result: null,
      entries: entries.map((item) =>
        item.id === 'a' ? { ...item, name: 'Edited' } : item,
      ),
    }));
    expect(
      await revisions([workspaces, workspace('a'), workspace('b')]),
    ).toEqual([1, 2, 1]);
    expect(readFileSync(join(root, 'index.json.bak'), 'utf8')).toContain(
      '"name": "a"',
    );
    await index.update(({ entries }) => ({
      result: null,
      entries: [...entries]
        .reverse()
        .map((item, order) => ({ ...item, order })),
    }));
    expect(
      await revisions([workspaces, workspace('a'), workspace('b')]),
    ).toEqual([2, 2, 1]);
    await index.update(({ entries }) => ({
      result: null,
      entries: entries.filter((item) => item.id !== 'b'),
    }));
    expect(
      await revisions([workspaces, workspace('a'), workspace('b')]),
    ).toEqual([3, 2, 2]);
    await manifest.serialize('a', async () => {
      await manifest.replace(
        'a',
        { version: 1, type: 'cowork', repos: [] },
        await manifest.read('a'),
      );
      const previous = await manifest.read('a');
      if (previous.authority !== 'ok') throw new Error('missing manifest');
      await manifest.replaceDocument(
        'a',
        { ...previous.document, future: { value: 1 } },
        previous,
      );
    });
    expect(await revisions([workspace('a'), workspace('b')])).toEqual([4, 2]);
    expect(readFileSync(join(root, 'a/workspace.json'), 'utf8')).toContain(
      '"future"',
    );
    await list.replace('a', [row('one'), row('two')], await list.read('a'));
    expect(
      await revisions([worktrees, worktree('one'), worktree('two')]),
    ).toEqual([1, 1, 1]);
    await list.replace(
      'a',
      [{ ...row('one'), label: 'Edited' }, row('two')],
      await list.read('a'),
    );
    expect(
      await revisions([worktrees, worktree('one'), worktree('two')]),
    ).toEqual([1, 2, 1]);
    const current = await list.read('a');
    if (current.authority !== 'ok') throw new Error('missing list');
    await list.replace('a', [...current.worktrees].reverse(), current);
    expect(
      await revisions([worktrees, worktree('one'), worktree('two')]),
    ).toEqual([2, 2, 1]);
    await list.replace('a', [row('two')], await list.read('a'));
    expect(
      await revisions([worktrees, worktree('one'), worktree('two')]),
    ).toEqual([3, 3, 1]);
    await index.update(({ entries }) => ({ result: null, entries }));
    const m = await manifest.read('a');
    if (m.authority !== 'ok') throw new Error('missing manifest');
    // Raw manifest edits can mutate their read document: diff against raw text.
    await manifest.replaceDocument('a', m.document, m);
    const l = await list.read('a');
    if (l.authority !== 'ok') throw new Error('missing list');
    await list.replace('a', l.worktrees, l);
  });
  expect(recovery).toHaveBeenCalledTimes(1);
  await host.shutdown();
  const db = new DatabaseSync(dbPath);
  try {
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM w5_commits').get()?.count,
    ).toBe(10);
    expect(
      db
        .prepare('SELECT DISTINCT operation FROM w5_commits ORDER BY operation')
        .all(),
    ).toEqual([
      { operation: 'w5.workspace_index.write' },
      { operation: 'w5.workspace_manifest.write' },
      { operation: 'w5.worktree_list.write' },
    ]);
  } finally {
    db.close();
  }
});

it('refuses an out-of-band change made after the queued read, without advancing or overwriting it', async () => {
  const { index } = repositories();
  const file = join(root, 'index.json');
  const original = JSON.stringify({ version: 1, workspaces: [entry('a')] });
  writeFileSync(file, original);
  const externallyWritten = JSON.stringify({
    version: 1,
    workspaces: [entry('outside')],
  });
  await withStorageAdmission([WORKSPACE_INDEX_STORAGE], async () => {
    const write = index.update(({ entries }) => {
      writeFileSync(file, externallyWritten);
      return {
        result: null,
        entries: entries.map((item) => ({ ...item, name: 'Edit' })),
      };
    });
    await expect(write).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    await expect(write).rejects.toMatchObject({
      reason: 'fingerprint-conflict',
    });
  });
  expect(readFileSync(file, 'utf8')).toBe(externallyWritten);
  expect(existsSync(`${file}.bak`)).toBe(false);
  expect(await revisions([workspaces, workspace('a')])).toEqual([0, 0]);
});

it('recovers an unapplied commit before any repository read returns and reports interrupted reservations without contents', async () => {
  const file = join(root, 'index.json');
  const contents = JSON.stringify({
    version: 1,
    workspaces: [entry('recovered')],
  });
  const logStore = W5CommitLog.open(dbPath);
  logStore.commit({
    operation: 'interrupted',
    advance: [workspaces],
    files: [
      { path: file, contents, previousFingerprint: fingerprintW5File(null) },
    ],
    outcome: null,
  });
  logStore.reserve({
    reservationId: 'interrupted-reservation',
    operation: 'interrupted',
    diagnostics: { contents: 'never log this' },
  });
  const blocked = join(root, 'blocked.json');
  writeFileSync(blocked, 'edited outside the log');
  logStore.commit({
    operation: 'blocked',
    advance: [],
    files: [
      {
        path: blocked,
        contents: 'committed',
        previousFingerprint: fingerprintW5File('before'),
      },
    ],
    outcome: null,
  });
  logStore.close();
  const warning = jest.spyOn(log, 'warn');
  const { index, manifest, list } = repositories();
  const [snapshot, m, l] = await Promise.all([
    index.read(),
    manifest.read('a'),
    list.read('a'),
  ]);
  expect(snapshot.entries.map((item) => item.id)).toEqual(['recovered']);
  expect(m.authority).toBe('absent');
  expect(l.authority).toBe('absent');
  expect(readFileSync(file, 'utf8')).toBe(contents);
  expect(warning).toHaveBeenCalledWith('W5 reservation requires recovery', {
    reservationId: 'interrupted-reservation',
    reason: 'interrupted-operation',
  });
  expect(JSON.stringify(warning.mock.calls)).not.toContain('never log this');
  expect(warning).toHaveBeenCalledWith('W5 commit requires recovery', {
    commitId: 2,
    reason: 'file-apply-incomplete',
    diagnostics: {
      conflictCount: 1,
      writtenFileCount: 0,
      unexpectedFailure: false,
    },
  });
  expect(readFileSync(blocked, 'utf8')).toBe('edited outside the log');
});

it('recovers again after a failed host call before serving the next read', async () => {
  const file = join(root, 'index.json');
  const before = JSON.stringify({ version: 1, workspaces: [entry('before')] });
  writeFileSync(file, before);
  const { index } = repositories();
  await expect(index.read()).resolves.toMatchObject({ authority: 'ok' });
  // The worker goes away with a durable commit its file never received.
  await host.shutdown();
  const after = JSON.stringify({ version: 1, workspaces: [entry('after')] });
  const logStore = W5CommitLog.open(dbPath);
  logStore.commit({
    operation: 'interrupted',
    advance: [workspaces],
    files: [
      {
        path: file,
        contents: after,
        previousFingerprint: fingerprintW5File(before),
      },
    ],
    outcome: null,
  });
  logStore.close();
  host = new W5CommitLogHost({
    dbPath,
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });

  await expect(
    withStorageAdmission(PROJECT_W5_STORAGE, () =>
      index.update(() => ({ result: null, entries: [entry('stale-write')] })),
    ),
  ).rejects.toBeInstanceOf(W5CommitLogHostError);
  await expect(index.read()).resolves.toMatchObject({
    authority: 'ok',
    entries: [entry('after')],
  });
  expect(readFileSync(file, 'utf8')).toBe(after);
});

it('shares a failed recovery attempt, then retries successfully on a later read', async () => {
  const file = join(root, 'index.json');
  const contents = JSON.stringify({ version: 1, workspaces: [entry('a')] });
  writeFileSync(file, contents);
  const failure = new W5CommitLogHostError('unavailable', 'Startup timed out');
  const recovery = jest
    .spyOn(host, 'recoveryReport')
    .mockRejectedValueOnce(failure);
  const { store, index } = repositories();
  await expect(Promise.all([store.read(file), index.read()])).resolves.toEqual([
    { state: 'unreadable', error: failure },
    { authority: 'unreadable', entries: [] },
  ]);
  expect(recovery).toHaveBeenCalledTimes(1);
  await expect(index.read()).resolves.toMatchObject({
    authority: 'ok',
    entries: [entry('a')],
  });
  expect(recovery).toHaveBeenCalledTimes(2);
  await expect(store.read(file)).resolves.toEqual({
    state: 'present',
    raw: contents,
  });
  expect(recovery).toHaveBeenCalledTimes(2);
});

it('reports unreadable reads and typed failed writes when the host is unavailable, leaving files untouched', async () => {
  const file = join(root, 'index.json');
  const contents = JSON.stringify({ version: 1, workspaces: [entry('a')] });
  writeFileSync(file, contents);
  await host.shutdown();
  const { store, index, manifest, list } = repositories();
  expect((await index.read()).authority).toBe('unreadable');
  expect((await manifest.read('a')).authority).toBe('unreadable');
  expect((await list.read('a')).authority).toBe('unreadable');
  const indexWrite = index.update(() => ({
    result: null,
    entries: [entry('b')],
  }));
  await expect(indexWrite).rejects.toBeInstanceOf(
    WorkspaceIndexUnreadableError,
  );
  await expect(indexWrite).rejects.toHaveProperty(
    'cause.reason',
    'unavailable',
  );
  const manifestWrite = manifest.replace(
    'a',
    { version: 1, type: 'cowork', repos: [] },
    await manifest.read('a'),
  );
  await expect(manifestWrite).rejects.toBeInstanceOf(
    WorkspaceConfigUnreadableError,
  );
  await expect(manifestWrite).rejects.toHaveProperty(
    'cause.reason',
    'unavailable',
  );
  const listWrite = list.replace('a', [row('one')], await list.read('a'));
  await expect(listWrite).rejects.toBeInstanceOf(
    WorktreeRegistryUnreadableError,
  );
  await expect(listWrite).rejects.toHaveProperty('cause.reason', 'unavailable');
  await withStorageAdmission([WORKSPACE_INDEX_STORAGE], async () => {
    const write = store.replace(file, 'replacement', WORKSPACE_INDEX_STORAGE, {
      operation: 'w5.workspace_index.write',
      advance: [workspaces],
      previousRaw: contents,
    });
    await expect(write).rejects.toBeInstanceOf(W5CommitLogHostError);
    await expect(write).rejects.toMatchObject({ reason: 'unavailable' });
  });
  expect(readFileSync(file, 'utf8')).toBe(contents);
  expect(existsSync(dbPath)).toBe(false);
});

it('commits record removals on the real worker and refuses stale peer writes without recovery debt', async () => {
  await withStorageAdmission(PROJECT_W5_STORAGE, async () => {
    const { store, manifest, list } = repositories();
    const peer = createW5CommitLogFileStore(() => host);
    const manifestPath = join(root, 'a', 'workspace.json');
    const listPath = join(root, 'a', 'worktrees.json');
    mkdirSync(join(root, 'a'));
    const oldManifest = JSON.stringify({ version: 1, repos: [] });
    writeFileSync(manifestPath, oldManifest);
    writeFileSync(
      listPath,
      JSON.stringify({ version: 1, worktrees: [row('one')] }),
    );
    const before = await peer.read(manifestPath);
    expect(before).toEqual({ state: 'present', raw: oldManifest });
    await store.withCommit({ operation: 'test.records.remove' }, async () => {
      await manifest.remove('a');
      await list.remove('a');
      expect(await store.read(manifestPath)).toEqual({ state: 'absent' });
      expect(await store.read(listPath)).toEqual({ state: 'absent' });
    });
    expect(existsSync(manifestPath)).toBe(false);
    expect(existsSync(listPath)).toBe(false);
    expect(
      await revisions([workspace('a'), worktrees, worktree('one')]),
    ).toEqual([1, 1, 1]);
    await expect(
      peer.replace(manifestPath, '{}', WORKSPACE_MANIFEST_STORAGE, {
        operation: 'test.stale.peer',
        advance: [{ kind: 'workspace', workspaceId: 'a' }],
        previousRaw: oldManifest,
      }),
    ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    await expect(
      peer.withCommit(
        {
          operation: 'test.stale.list',
          expectedRevisions: [{ resource: worktrees, revision: 0 }],
        },
        async () => {},
      ),
    ).rejects.toMatchObject({ name: 'W5RevisionConflictError' });
    expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
  });
});
