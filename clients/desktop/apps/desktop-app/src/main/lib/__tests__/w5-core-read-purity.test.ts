// RR1: core read adapter queries over the real W5 commit-log worker and files.
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type * as CoreStorage from '@canopy/core-runtime/storage';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof CoreStorage>(
    '@canopy/core-runtime/storage',
  );
  // Same array the checked writer reads; rows are swapped in place.
  const rows: CoreStorage.StorageOwnershipRow[] = [...actual.STORAGE_OWNERSHIP];
  return {
    ...actual,
    STORAGE_OWNERSHIP: rows,
    setDaemonOwnedForTest: (namespaceIds: readonly string[]): void => {
      actual.STORAGE_OWNERSHIP.forEach((row, index) => {
        rows[index] = namespaceIds.includes(row.id)
          ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
          : row;
      });
    },
  };
});
const { setDaemonOwnedForTest } = jest.requireMock<{
  setDaemonOwnedForTest: (namespaceIds: readonly string[]) => void;
}>('@canopy/core-runtime/storage');
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: jest.fn(() => Promise.resolve()),
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  readW5Revisions,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import {
  __resetSidebarItemsStateForTests,
  getWorkspaceIndexRepository,
  removeWorkspaceIndexEntry,
  setWorkspaceActivitySectionOrder,
} from '../sidebar-items';
import { getWorkspaceType } from '../workspace-registry';
import { updateWorkspaceMetadata } from '../workspace-metadata';
import {
  getWorkspaceManifestRepository,
  markWorkspaceWorktreeRecentlyRemoved,
  readWorkspaceWorktrees,
  readWorkspaceWorktreesDetailed,
  setBeforeProjectPluginDefaultsChangeHandler,
  setWorktreeRegistryReconciler,
  updateWorkspaceConfig,
  updateWorkspaceWorktrees,
} from '../workspace-persistence';
import { createWorktreeListRepository } from '../worktree-list-repository';
import { getWorkspaceWorktreesFilePath } from '../paths';
import { WORKTREE_LIST_STORAGE, withStorageAdmission } from '../w5-storage';
import { desktopW5FileStore } from '../w5-commit-log-file-store';
import {
  createCoreWorkspaceAdapter,
  type CoreWorkspaceReadDetail,
} from '../../canopy-runtime/core-workspace-adapter';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { getFeatureFlagService } from '../../feature-flags/service';
import { getPrimaryProjectConfigFilePath } from '../canopy-json';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;

const listPath = (): string => join(root, 'a', 'worktrees.json');
const images = (): string[] =>
  ['index.json', 'a/workspace.json', 'a/worktrees.json'].map((file) =>
    readFileSync(join(root, file), 'utf8'),
  );
function diskIds(): unknown[] {
  const parsed: unknown = JSON.parse(readFileSync(listPath(), 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('worktrees' in parsed) ||
    !Array.isArray(parsed.worktrees)
  )
    throw new Error('worktrees.json shape');
  return parsed.worktrees.map((row: unknown) =>
    typeof row === 'object' && row !== null && 'id' in row ? row.id : null,
  );
}
async function revisions(): Promise<number[]> {
  const read = await readW5Revisions([
    { kind: 'workspaces' },
    { kind: 'workspace', workspaceId: 'a' },
    { kind: 'worktrees', workspaceId: 'a' },
    { kind: 'worktree', workspaceId: 'a', worktreeId: 'two' },
  ]);
  return read.map((entry) => entry.revision);
}

type Adapter = ReturnType<typeof createCoreWorkspaceAdapter>;
// Handler context is unused by the adapter.
const context = undefined;
// Every adapter read, each over the default (production) services.
const reads: [string, (adapter: Adapter) => Promise<unknown>][] = [
  [
    'core.worktree.list scoped',
    async (adapter): Promise<string[]> =>
      (
        await adapter['core.worktree.list'](
          { scope: { workspaceId: 'a' } },
          context,
        )
      ).items.map((item) => item.worktreeId),
  ],
  [
    'core.worktree.list unscoped',
    async (adapter): Promise<string[]> =>
      (await adapter['core.worktree.list']({}, context)).items.map(
        (item) => item.worktreeId,
      ),
  ],
  [
    'core.worktree.get scoped',
    async (adapter): Promise<string> =>
      (
        await adapter['core.worktree.get'](
          { worktreeId: 'one', scope: { workspaceId: 'a' } },
          context,
        )
      ).worktreeId,
  ],
  [
    'core.worktree.get unscoped',
    async (adapter): Promise<string> =>
      (await adapter['core.worktree.get']({ worktreeId: 'three' }, context))
        .worktreeId,
  ],
  [
    'core.workspace.list',
    async (adapter): Promise<string[]> =>
      (await adapter['core.workspace.list']({}, context)).items.map(
        (item) => item.workspaceId,
      ),
  ],
  [
    'core.workspace.get',
    async (adapter): Promise<string> =>
      (await adapter['core.workspace.get']({ workspaceId: 'a' }, context))
        .workspaceId,
  ],
];
const expected: Record<string, unknown> = {
  'core.worktree.list scoped': ['one', 'three'],
  'core.worktree.list unscoped': ['one', 'three'],
  'core.worktree.get scoped': 'one',
  'core.worktree.get unscoped': 'three',
  'core.workspace.list': ['a'],
  'core.workspace.get': 'a',
};

beforeAll(() => {
  setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
    Promise.resolve({ rows: next }),
  );
});
beforeEach(async () => {
  ({ dir, root, repo } = createW5BoundaryFixture((createdAt) => [
    { id: 'one', branchName: 'first', createdAt },
    { id: 'two', branchName: 'second', createdAt },
    { id: 'three', branchName: 'third', createdAt },
  ]));
  // Canonical paths: macOS aliases /var to /private/var.
  dir = realpathSync(dir);
  root = join(dir, 'data', 'workspaces');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  setDaemonOwnedForTest([]);
  // Tombstone 'two' in this process, as an archive or deletion would.
  const two = (
    await readWorkspaceWorktrees('a', { persistRemovalCleanup: false })
  ).find((row) => row.id === 'two');
  if (!two) throw new Error('fixture lacks worktree two');
  markWorkspaceWorktreeRecentlyRemoved('a', 'two', two.createdAt);
});
afterEach(async () => {
  setDaemonOwnedForTest([]);
  await settleDetachedWork();
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('core read adapter never persists removal cleanup (RR1)', () => {
  it.each(reads)(
    '%s returns filtered results without writing files or advancing revisions',
    async (name, read) => {
      const before = images();
      expect(diskIds()).toEqual(['one', 'two', 'three']);
      expect(await revisions()).toEqual([0, 0, 0, 0]);

      await expect(read(createCoreWorkspaceAdapter())).resolves.toEqual(
        expected[name],
      );
      await settleDetachedWork();

      expect(await revisions()).toEqual([0, 0, 0, 0]);
      expect(images()).toEqual(before);
    },
  );

  it('keeps the tombstoned row out of scoped and unscoped gets', async () => {
    const adapter = createCoreWorkspaceAdapter();
    const before = images();
    await expect(
      adapter['core.worktree.get'](
        { worktreeId: 'two', scope: { workspaceId: 'a' } },
        context,
      ),
    ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
    await expect(
      adapter['core.worktree.get']({ worktreeId: 'two' }, context),
    ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
    expect(await revisions()).toEqual([0, 0, 0, 0]);
    expect(images()).toEqual(before);
  });

  it.each(reads)(
    '%s succeeds while worktree_list is daemon-owned',
    async (name, read) => {
      const before = images();
      setDaemonOwnedForTest(['worktree_list']);

      await expect(read(createCoreWorkspaceAdapter())).resolves.toEqual(
        expected[name],
      );
      // The flip bites: the cleanup write a read used to make is refused.
      await expect(
        updateWorkspaceWorktrees('a', (rows) => rows),
      ).rejects.toMatchObject({
        name: 'StorageWriteRefusedError',
        namespaceId: 'worktree_list',
        reason: 'daemon_owned',
      });

      setDaemonOwnedForTest([]);
      expect(await revisions()).toEqual([0, 0, 0, 0]);
      expect(images()).toEqual(before);
    },
  );

  it('serves every read while all three W5 namespaces are daemon-owned', async () => {
    const before = images();
    setDaemonOwnedForTest([
      'workspace_index',
      'workspace_manifest',
      'worktree_list',
    ]);
    const adapter = createCoreWorkspaceAdapter();

    for (const [name, read] of reads) {
      await expect(read(adapter)).resolves.toEqual(expected[name]);
    }
    const refused = {
      name: 'StorageWriteRefusedError',
      reason: 'daemon_owned',
    };
    await expect(
      setWorkspaceActivitySectionOrder('a', []),
    ).rejects.toMatchObject({ ...refused, namespaceId: 'workspace_index' });
    await expect(
      updateWorkspaceConfig('a', (config) => config),
    ).rejects.toMatchObject({ ...refused, namespaceId: 'workspace_manifest' });

    setDaemonOwnedForTest([]);
    expect(await revisions()).toEqual([0, 0, 0, 0]);
    expect(images()).toEqual(before);
  });

  it('keeps the production runtime (no injected services) and its legacy IPC projections pure', async () => {
    const caller: CanopyCallerDescriptor = {
      principalId: 'test-user',
      clientInstanceId: 'test-client',
      authorityId: 'local-desktop',
      interfaceKind: 'test',
      grants: ['core.workspace.read', 'core.worktree.read'],
    };
    const runtime = createDesktopRuntime();
    const before = images();
    try {
      const sidebar = await runtime.queryWorkspaceListForLegacyIpc(
        {},
        { caller },
      );
      const sidebarRows = sidebar.legacyResult.items.flatMap((item) =>
        item.type === 'cowork' ? [] : item.worktrees.map((row) => row.id),
      );
      expect(sidebarRows).toEqual(['one', 'three']);
      const scoped = await runtime.queryWorktreeListForLegacyIpc(
        { scope: { workspaceId: 'a' } },
        { caller },
      );
      expect(
        scoped.canonicalResult?.items.map((row) => row.worktreeId),
      ).toEqual(['one', 'three']);
      const unscoped = await runtime.queryWorktreeListForLegacyIpc(
        {},
        { caller },
      );
      expect(
        unscoped.canonicalResult?.items.map((row) => row.worktreeId),
      ).toEqual(['one', 'three']);
      const got = await runtime.queryWorktreeGetForLegacyIpc(
        { worktreeId: 'three', scope: { workspaceId: 'a' } },
        { caller },
      );
      expect(got.legacyResult.id).toBe('three');
    } finally {
      await runtime.shutdown();
    }
    expect(await revisions()).toEqual([0, 0, 0, 0]);
    expect(images()).toEqual(before);
  });

  it('leaves persisting the filtered list to the next in-process list write', async () => {
    await createCoreWorkspaceAdapter()['core.worktree.list'](
      { scope: { workspaceId: 'a' } },
      context,
    );
    expect(diskIds()).toEqual(['one', 'two', 'three']);

    await updateWorkspaceWorktrees('a', (rows) => rows);

    expect(diskIds()).toEqual(['one', 'three']);
    const [, , worktreesRevision] = await revisions();
    expect(worktreesRevision).toBe(1);
  });
});

const owner = {
  type: 'organization',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  bindingGeneration: 1,
};
function writeOwnedManifest(): void {
  writeFileSync(
    join(root, 'a', 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'single-repo',
      repoPath: repo,
      repos: [],
      owner,
    }),
  );
}

const readCaller: CanopyCallerDescriptor = {
  principalId: 'test-user',
  clientInstanceId: 'test-client',
  authorityId: 'local-desktop',
  interfaceKind: 'test',
  grants: ['core.workspace.read', 'core.worktree.read'],
};

/** Recreates the fixture's three files from absence through logged writes. */
async function logFixtureFromAbsence(): Promise<void> {
  const { worktrees } = await readWorkspaceWorktreesDetailed('a', {
    includeRecentlyRemoved: true,
  });
  for (const file of ['index.json', 'a/workspace.json', 'a/worktrees.json'])
    rmSync(join(root, file));
  await getWorkspaceIndexRepository().update(() => ({
    result: null,
    entries: [
      {
        id: 'a',
        name: 'Original',
        type: 'single-repo',
        color: '#7C3AED',
        collapsed: false,
        order: 0,
      },
    ],
  }));
  const manifests = getWorkspaceManifestRepository();
  await manifests.serialize('a', async () =>
    manifests.replace(
      'a',
      { version: 1, type: 'single-repo', repoPath: repo, repos: [] },
      await manifests.read('a'),
    ),
  );
  const list = createWorktreeListRepository({
    store: desktopW5FileStore,
    filePath: getWorkspaceWorktreesFilePath,
    storage: WORKTREE_LIST_STORAGE,
    knownRowFields: new Set(['id', 'branchName', 'createdAt']),
  });
  await withStorageAdmission([WORKTREE_LIST_STORAGE], async () => {
    await list.replace('a', worktrees, await list.read('a'));
  });
}

function labels(detail: CoreWorkspaceReadDetail | undefined): string[] {
  return (detail?.provenance?.resources ?? []).map(
    ({ resource, completeness, filters, eligibility }) =>
      [
        resource.kind === 'workspaces'
          ? 'workspaces'
          : resource.kind === 'worktree'
            ? `worktree:${resource.worktreeId}`
            : `${resource.kind}:${resource.workspaceId}`,
        completeness,
        ...filters,
        eligibility.status === 'eligible'
          ? `r${eligibility.revision}`
          : eligibility.reason,
      ].join(' '),
  );
}

describe('core read adapter serves each query from one W5 capture (CAN-5318)', () => {
  it.each(reads)(
    '%s reads every W5 file from one capture, never the live files',
    async (name, read) => {
      const capture = jest.spyOn(host, 'capture');
      const live = jest.spyOn(nodeW5FileStore, 'read');
      try {
        await expect(read(createCoreWorkspaceAdapter())).resolves.toEqual(
          expected[name],
        );
        expect(capture).toHaveBeenCalledTimes(1);
        expect(live).not.toHaveBeenCalled();
      } finally {
        capture.mockRestore();
        live.mockRestore();
      }
    },
  );

  it('keeps the captured position when a logged write lands mid-query', async () => {
    const capture = host.capture.bind(host);
    const spy = jest
      .spyOn(host, 'capture')
      .mockImplementationOnce(async (request) => {
        const captured = await capture(request);
        await updateWorkspaceWorktrees('a', (rows) =>
          rows.filter((row) => row.id !== 'one'),
        );
        return captured;
      });
    try {
      const listed = await createCoreWorkspaceAdapter()['core.worktree.list'](
        { scope: { workspaceId: 'a' } },
        context,
      );
      expect(listed.items.map((item) => item.worktreeId)).toEqual([
        'one',
        'three',
      ]);
      expect(diskIds()).toEqual(['three']);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses an unscoped get whose ID repeats across the captured workspaces', async () => {
    writeFileSync(
      join(root, 'index.json'),
      readFileSync(join(root, 'index.json'), 'utf8').replace(
        '"order":0}',
        '"order":0},{"id":"b","name":"b","type":"single-repo","color":"#7C3AED","collapsed":false,"order":1}',
      ),
    );
    mkdirSync(join(root, 'b'));
    writeFileSync(
      join(root, 'b', 'workspace.json'),
      readFileSync(join(root, 'a', 'workspace.json'), 'utf8'),
    );
    writeFileSync(join(root, 'b', 'worktrees.json'), readFileSync(listPath()));
    const capture = jest.spyOn(host, 'capture');
    try {
      await expect(
        createCoreWorkspaceAdapter()['core.worktree.get'](
          { worktreeId: 'three' },
          context,
        ),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
      expect(capture).toHaveBeenCalledTimes(1);
      await expect(
        createCoreWorkspaceAdapter()['core.worktree.get'](
          { worktreeId: 'three', scope: { workspaceId: 'b' } },
          context,
        ),
      ).resolves.toMatchObject({ workspaceId: 'b' });
    } finally {
      capture.mockRestore();
    }
  });

  it('filters by organization on the manifest from the same capture', async () => {
    writeOwnedManifest();
    const live = jest.spyOn(nodeW5FileStore, 'read');
    const capture = jest.spyOn(host, 'capture');
    try {
      const adapter = createCoreWorkspaceAdapter();
      const scope = { workspaceId: 'a', organizationId: owner.organizationId };
      const listed = await adapter['core.worktree.list']({ scope }, context);
      expect(listed.items.map((item) => item.worktreeId)).toEqual([
        'one',
        'three',
      ]);
      await expect(
        adapter['core.worktree.get']({ worktreeId: 'one', scope }, context),
      ).resolves.toMatchObject({ worktreeId: 'one' });
      expect(capture).toHaveBeenCalledTimes(2);
      expect(live).not.toHaveBeenCalled();
    } finally {
      live.mockRestore();
      capture.mockRestore();
    }
  });

  it('lets the next read correct registries a mid-query index write outran', async () => {
    writeFileSync(
      join(root, 'index.json'),
      readFileSync(join(root, 'index.json'), 'utf8').replace(
        '"order":0}',
        '"order":0},{"id":"b","name":"b","type":"cowork","color":"#7C3AED","collapsed":false,"order":1}',
      ),
    );
    mkdirSync(join(root, 'b'));
    writeFileSync(
      join(root, 'b', 'workspace.json'),
      JSON.stringify({ version: 1, type: 'cowork', repos: [] }),
    );
    const capture = host.capture.bind(host);
    const spy = jest
      .spyOn(host, 'capture')
      .mockImplementationOnce(async (request) => {
        const captured = await capture(request);
        await removeWorkspaceIndexEntry('b');
        return captured;
      });
    try {
      const adapter = createCoreWorkspaceAdapter();
      const listed = await adapter['core.workspace.list']({}, context);
      // The captured position, as develop's single index read gave.
      expect(listed.items.map((item) => item.workspaceId)).toEqual(['a', 'b']);
      await adapter['core.workspace.list']({}, context);
      expect(getWorkspaceType('b')).toBeNull();
      expect(getWorkspaceType('a')).toBe('single-repo');
    } finally {
      spy.mockRestore();
    }
  });

  it('carries per-resource eligibility and removal filtering through the legacy projections', async () => {
    const runtime = createDesktopRuntime();
    try {
      // Pre-log fixture files: readable, never labelled.
      const preLog = await runtime.queryWorktreeListForLegacyIpc(
        { scope: { workspaceId: 'a' } },
        { caller: readCaller },
      );
      expect(labels(preLog.legacyAuthority)).toEqual([
        'worktrees:a partial recently-removed untracked',
        'worktree:one complete untracked',
        'worktree:three complete untracked',
      ]);

      await logFixtureFromAbsence();
      const before = images();
      const revisionsBefore = await revisions();

      const scoped = await runtime.queryWorktreeListForLegacyIpc(
        { scope: { workspaceId: 'a' } },
        { caller: readCaller },
      );
      // Filtering is recorded, not folded into the list's authority.
      expect(scoped.legacyAuthority?.authority).toBe('ok');
      expect(scoped.legacyAuthority?.provenance?.position).toMatchObject({
        status: 'captured',
      });
      expect(labels(scoped.legacyAuthority)).toEqual([
        'worktrees:a partial recently-removed projection-incomplete',
        'worktree:one complete r1',
        'worktree:three complete r1',
      ]);
      const unscoped = await runtime.queryWorktreeListForLegacyIpc(
        {},
        { caller: readCaller },
      );
      expect(labels(unscoped.legacyAuthority)).toEqual([
        'worktrees:a partial recently-removed projection-incomplete',
        'worktree:one complete r1',
        'worktree:three complete r1',
      ]);
      expect(unscoped.legacyAuthority?.authority).toBe('ok');
      expect(unscoped.legacyAuthority?.provenance?.result).toEqual({
        completeness: 'partial',
        filters: ['recently-removed'],
      });
      // The workspace collection is its own resource: the list's
      // filtering does not reach it.
      const workspaces = await runtime.queryWorkspaceListForLegacyIpc(
        {},
        { caller: readCaller },
      );
      expect(labels(workspaces.legacyAuthority)).toEqual([
        'workspaces complete r1',
        'workspace:a complete r2',
      ]);
      const workspace = await runtime.queryWorkspaceGetForLegacyIpc(
        { workspaceId: 'a' },
        { caller: readCaller },
      );
      expect(labels(workspace.legacyAuthority)).toEqual([
        'workspace:a complete r2',
      ]);
      for (const scope of [{ workspaceId: 'a' }, {}]) {
        const got = await runtime.queryWorktreeGetForLegacyIpc(
          { worktreeId: 'three', scope },
          { caller: readCaller },
        );
        expect(labels(got.legacyAuthority)).toEqual([
          'worktree:three complete r1',
        ]);
      }

      expect(await revisions()).toEqual(revisionsBefore);
      expect(images()).toEqual(before);
      // A foreign rewrite withholds the list's labels, not the workspace's.
      writeFileSync(
        listPath(),
        readFileSync(listPath(), 'utf8').replace('"third"', '"cli"'),
      );
      const foreign = await runtime.queryWorktreeListForLegacyIpc(
        {},
        { caller: readCaller },
      );
      expect(labels(foreign.legacyAuthority)).toEqual([
        'worktrees:a partial recently-removed diverged',
        'worktree:one complete diverged',
        'worktree:three complete diverged',
      ]);
      expect(
        labels(
          (
            await runtime.queryWorkspaceListForLegacyIpc(
              {},
              { caller: readCaller },
            )
          ).legacyAuthority,
        ),
      ).toEqual(['workspaces complete r1', 'workspace:a complete r2']);
    } finally {
      await runtime.shutdown();
    }
  });
});

describe('public revisions and pinned list continuation (CAN-5319)', () => {
  const scope = { workspaceId: 'a' };
  const options = { caller: readCaller };
  async function counter(
    resource: Parameters<typeof readW5Revisions>[0][number],
  ): Promise<number> {
    const [read] = await readW5Revisions([resource]);
    if (!read) throw new Error('no counter');
    return read.revision;
  }
  /** Logged history from absence, with the tombstoned row's removal persisted. */
  async function verifiedFixture(): Promise<void> {
    await logFixtureFromAbsence();
    await updateWorkspaceWorktrees('a', (rows) => rows);
  }
  function cursorOf(result: { nextCursor: string | null } | null): string {
    if (!result?.nextCursor) throw new Error('expected a continuation');
    return result.nextCursor;
  }
  const labelled = (items: readonly { revision?: number }[]): unknown[] =>
    items.map((item) => item.revision);

  it('publishes eligible revisions only, and collection revisions only for complete lists', async () => {
    const runtime = createDesktopRuntime();
    try {
      const preLog = await runtime.query(
        'core.worktree.list',
        { scope },
        options,
      );
      expect(preLog).not.toHaveProperty('collectionRevision');
      expect(labelled(preLog.items)).toEqual([undefined, undefined]);
      const preLogWorkspaces = await runtime.query(
        'core.workspace.list',
        {},
        options,
      );
      expect(preLogWorkspaces).not.toHaveProperty('collectionRevision');
      expect(labelled(preLogWorkspaces.items)).toEqual([undefined]);

      await logFixtureFromAbsence();
      // RR1 removal filtering withholds the collection's revision, not its rows'.
      const removing = await runtime.query(
        'core.worktree.list',
        { scope },
        options,
      );
      expect(removing).not.toHaveProperty('collectionRevision');
      expect(labelled(removing.items)).toEqual([1, 1]);

      await updateWorkspaceWorktrees('a', (rows) => rows);
      const list = await counter({ kind: 'worktrees', workspaceId: 'a' });
      const row = await counter({
        kind: 'worktree',
        workspaceId: 'a',
        worktreeId: 'three',
      });
      const complete = await runtime.query(
        'core.worktree.list',
        { scope },
        options,
      );
      expect(complete.collectionRevision).toBe(list);
      expect(list).toBeGreaterThan(0);
      expect(labelled(complete.items)).toEqual([
        await counter({
          kind: 'worktree',
          workspaceId: 'a',
          worktreeId: 'one',
        }),
        row,
      ]);
      for (const filtered of [
        { ...scope, worktreeId: 'one' },
        { ...scope, organizationId: owner.organizationId },
      ]) {
        const result = await runtime.query(
          'core.worktree.list',
          { scope: filtered },
          options,
        );
        expect(result).not.toHaveProperty('collectionRevision');
      }
      // No collection spans workspaces, so the aggregation has no revision.
      const unscoped = await runtime.query('core.worktree.list', {}, options);
      expect(unscoped).not.toHaveProperty('collectionRevision');
      expect(labelled(unscoped.items)).toEqual(labelled(complete.items));

      const workspaces = await runtime.query(
        'core.workspace.list',
        {},
        options,
      );
      expect(workspaces.collectionRevision).toBe(
        await counter({ kind: 'workspaces' }),
      );
      const workspace = await counter({ kind: 'workspace', workspaceId: 'a' });
      expect(labelled(workspaces.items)).toEqual([workspace]);
      const scopedWorkspaces = await runtime.query(
        'core.workspace.list',
        { scope },
        options,
      );
      expect(scopedWorkspaces).not.toHaveProperty('collectionRevision');
      expect(labelled(scopedWorkspaces.items)).toEqual([workspace]);
      await expect(
        runtime.query('core.workspace.get', { workspaceId: 'a' }, options),
      ).resolves.toMatchObject({ revision: workspace });
      for (const getScope of [scope, {}])
        await expect(
          runtime.query(
            'core.worktree.get',
            { worktreeId: 'three', scope: getScope },
            options,
          ),
        ).resolves.toMatchObject({ revision: row });

      // A foreign rewrite withholds the list's revisions, not the workspace's.
      writeFileSync(
        listPath(),
        readFileSync(listPath(), 'utf8').replace('"third"', '"cli"'),
      );
      const foreign = await runtime.query(
        'core.worktree.list',
        { scope },
        options,
      );
      expect(foreign).not.toHaveProperty('collectionRevision');
      expect(labelled(foreign.items)).toEqual([undefined, undefined]);
      await expect(
        runtime.query('core.workspace.list', {}, options),
      ).resolves.toMatchObject({
        collectionRevision: workspaces.collectionRevision,
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it('publishes a revision over fields a source repository contributes (decision B1)', async () => {
    await logFixtureFromAbsence();
    await getWorkspaceIndexRepository().update(() => ({
      result: null,
      entries: [
        {
          id: 'a',
          name: 'Original',
          type: 'multi-repo',
          color: '#7C3AED',
          collapsed: false,
          order: 0,
        },
      ],
    }));
    const manifests = getWorkspaceManifestRepository();
    await manifests.serialize('a', async () =>
      manifests.replace(
        'a',
        { version: 1, type: 'multi-repo', sourceRepoPath: repo, repos: [] },
        await manifests.read('a'),
      ),
    );
    const workspace = await counter({ kind: 'workspace', workspaceId: 'a' });
    const runtime = createDesktopRuntime();
    try {
      const got = await runtime.queryWorkspaceGetForLegacyIpc(
        { workspaceId: 'a' },
        options,
      );
      const listed = await runtime.queryWorkspaceListForLegacyIpc({}, options);
      for (const detail of [got.legacyAuthority, listed.legacyAuthority])
        expect(detail?.provenance?.resources).toContainEqual(
          expect.objectContaining({
            resource: { kind: 'workspace', workspaceId: 'a' },
            external: ['repositorySources'],
            eligibility: { status: 'eligible', revision: workspace },
          }),
        );
      expect(got.canonicalResult?.revision).toBe(workspace);
      expect(listed.canonicalResult?.items).toEqual([
        expect.objectContaining({ workspaceId: 'a', revision: workspace }),
      ]);
    } finally {
      await runtime.shutdown();
    }
  });

  it('publishes the typed workspace fields under the workspace revision, and echoing stored values writes nothing (CAN-5373)', async () => {
    await logFixtureFromAbsence();
    await updateWorkspaceMetadata({
      workspaceId: 'a',
      source: 'desktop_canopy_client',
      patch: {
        color: '#0EA5E9',
        pinned: true,
        collapsed: true,
        itemSortMode: 'last-updated',
        activitySectionOrder: ['cost', 'summary'],
        alwaysShow: false,
        startPage: {
          kind: 'set',
          startPage: { kind: 'url', url: 'https://example.com/start' },
        },
      },
    });
    const workspace = await counter({ kind: 'workspace', workspaceId: 'a' });
    const typed = {
      color: '#0EA5E9',
      pinned: true,
      collapsed: true,
      itemSortMode: 'last-updated',
      activitySectionOrder: ['cost', 'summary'],
      alwaysShow: false,
      startPage: { kind: 'url', url: 'https://example.com/start' },
    };
    const runtime = createDesktopRuntime();
    try {
      const got = await runtime.query(
        'core.workspace.get',
        { workspaceId: 'a' },
        options,
      );
      const listed = await runtime.query('core.workspace.list', {}, options);
      expect(got).toMatchObject({
        ...typed,
        settings: {},
        revision: workspace,
      });
      expect(listed.items).toEqual([
        expect.objectContaining({ ...typed, revision: workspace }),
      ]);

      // Every typed field read back as the edit baseline is a no-op edit.
      const { startPage } = got;
      if (startPage === undefined) throw new Error('no start page');
      const before = images();
      await updateWorkspaceMetadata({
        workspaceId: 'a',
        source: 'desktop_canopy_client',
        expectedRevision: got.revision,
        patch: {
          color: got.color,
          pinned: got.pinned,
          collapsed: got.collapsed,
          itemSortMode: got.itemSortMode,
          activitySectionOrder: got.activitySectionOrder,
          alwaysShow: got.alwaysShow,
          startPage:
            startPage?.kind === 'inherit'
              ? { kind: 'inherit' }
              : { kind: 'set', startPage },
        },
      });
      expect(images()).toEqual(before);
      await expect(
        counter({ kind: 'workspace', workspaceId: 'a' }),
      ).resolves.toBe(workspace);
    } finally {
      await runtime.shutdown();
    }
  });

  it('reads an unedited workspace as default edits that an echo leaves in effect (CAN-5373)', async () => {
    await logFixtureFromAbsence();
    const runtime = createDesktopRuntime();
    try {
      const got = await runtime.query(
        'core.workspace.get',
        { workspaceId: 'a' },
        options,
      );
      const typed = {
        color: '#7C3AED',
        pinned: false,
        collapsed: false,
        itemSortMode: 'manual',
        activitySectionOrder: [],
        alwaysShow: true,
        startPage: { kind: 'inherit' },
      };
      expect(got).toMatchObject(typed);
      const [index] = images();
      await updateWorkspaceMetadata({
        workspaceId: 'a',
        source: 'desktop_canopy_client',
        expectedRevision: got.revision,
        patch: {
          color: got.color,
          pinned: got.pinned,
          collapsed: got.collapsed,
          itemSortMode: got.itemSortMode,
          activitySectionOrder: got.activitySectionOrder,
          alwaysShow: got.alwaysShow,
          startPage: { kind: 'inherit' },
        },
      });
      // The manifest write persists the read default `alwaysShow: true`, as
      // every desktop manifest write does; the index entry is unchanged.
      expect(images()[0]).toBe(index);
      await expect(
        runtime.query('core.workspace.get', { workspaceId: 'a' }, options),
      ).resolves.toMatchObject(typed);
    } finally {
      await runtime.shutdown();
    }
  });

  /** Stores the index entry and manifest of `a` as written, outside any writer. */
  function storeWorkspace(
    entry: Record<string, unknown>,
    manifest: Record<string, unknown>,
  ): void {
    writeFileSync(
      join(root, 'index.json'),
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: 'a',
            name: 'Original',
            type: 'single-repo',
            color: '#7C3AED',
            order: 0,
            ...entry,
          },
        ],
      }),
    );
    writeFileSync(
      join(root, 'a', 'workspace.json'),
      JSON.stringify({
        version: 1,
        type: 'single-repo',
        repoPath: repo,
        repos: [],
        ...manifest,
      }),
    );
  }

  async function getAndList(): Promise<Record<string, unknown>[]> {
    const runtime = createDesktopRuntime();
    try {
      const got = await runtime.query(
        'core.workspace.get',
        { workspaceId: 'a' },
        options,
      );
      const listed = await runtime.query('core.workspace.list', {}, options);
      if (!listed.items[0]) throw new Error('workspace not listed');
      return [got, listed.items[0]];
    } finally {
      await runtime.shutdown();
    }
  }

  it.each([
    ['collapsed', { collapsed: 'yes' }, {}],
    ['pinned', { pinned: 1 }, {}],
    ['activitySectionOrder', { activitySectionOrder: 'summary' }, {}],
    [
      'activitySectionOrder',
      { activitySectionOrder: ['summary', 'retired-section'] },
      {},
    ],
    ['itemSortMode', {}, { itemSortMode: 'alphabetical' }],
    ['alwaysShow', {}, { alwaysShow: 'sometimes' }],
    ['startPage', {}, { startPage: { kind: 'file', path: '../outside' } }],
    ['startPage', {}, { startPage: { kind: 'inherit' } }],
    // `null` is a stored value, not an unset one.
    ['pinned', { pinned: null }, {}],
    ['activitySectionOrder', { activitySectionOrder: null }, {}],
    [
      'itemSortMode',
      { type: 'cowork' },
      { type: 'cowork', repoPath: undefined, itemSortMode: 'alphabetical' },
      { kind: 'cowork', alwaysShow: true },
    ],
    [
      'alwaysShow',
      { type: 'cowork' },
      { type: 'cowork', repoPath: undefined, alwaysShow: 'sometimes' },
      { kind: 'cowork', itemSortMode: 'manual' },
    ],
  ])(
    'omits a malformed stored %s that the reader replaces with a default (CAN-5373)',
    async (field, entry, manifest, kept: Record<string, unknown> = {}) => {
      storeWorkspace(entry, manifest);
      for (const result of await getAndList()) {
        expect(result).not.toHaveProperty(field);
        expect(result).toMatchObject({
          name: 'Original',
          color: '#7C3AED',
          ...kept,
        });
      }
    },
  );

  it('reads stored values that equal the read defaults as stored (CAN-5373)', async () => {
    storeWorkspace(
      { collapsed: false, pinned: false, activitySectionOrder: [] },
      { itemSortMode: 'manual', alwaysShow: true, startPage: null },
    );
    for (const result of await getAndList())
      expect(result).toMatchObject({
        collapsed: false,
        pinned: false,
        activitySectionOrder: [],
        itemSortMode: 'manual',
        alwaysShow: true,
        startPage: null,
      });
  });

  it('reads a stored section order with repeated ids as the rendered order (CAN-5373)', async () => {
    storeWorkspace(
      { activitySectionOrder: ['cost', 'summary', 'cost', 'notes'] },
      {},
    );
    for (const result of await getAndList())
      expect(result.activitySectionOrder).toEqual(['cost', 'summary', 'notes']);
  });

  it.each(['#123456', '#7c3aed'])(
    'omits a stored color %s outside the palette, so the read echoes back as an accepted edit (CAN-5373)',
    async (color) => {
      storeWorkspace({ color, pinned: true }, { itemSortMode: 'last-updated' });
      const [got, listed] = await getAndList();
      for (const result of [got, listed])
        expect(result).not.toHaveProperty('color');
      const runtime = createDesktopRuntime();
      try {
        const read = await runtime.query(
          'core.workspace.get',
          { workspaceId: 'a' },
          options,
        );
        await expect(
          updateWorkspaceMetadata({
            workspaceId: 'a',
            source: 'desktop_canopy_client',
            patch: {
              color: read.color,
              pinned: read.pinned,
              collapsed: read.collapsed,
              itemSortMode: read.itemSortMode,
              activitySectionOrder: read.activitySectionOrder,
              alwaysShow: read.alwaysShow,
            },
          }),
        ).resolves.toBeDefined();
      } finally {
        await runtime.shutdown();
      }
      expect(JSON.parse(images()[0] ?? '')).toMatchObject({
        workspaces: [{ id: 'a', color }],
      });
    },
  );

  it("reads each duplicate-id index row's typed fields from that row, and get from the first (CAN-5373)", async () => {
    storeWorkspace({}, {});
    const row = { id: 'a', type: 'single-repo' };
    writeFileSync(
      join(root, 'index.json'),
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            ...row,
            name: 'Original',
            color: '#7C3AED',
            order: 0,
            pinned: true,
          },
          {
            ...row,
            name: 'Second',
            color: '#0EA5E9',
            order: 1,
            pinned: 1,
            collapsed: true,
            activitySectionOrder: ['cost'],
          },
        ],
      }),
    );
    const first = {
      name: 'Original',
      color: '#7C3AED',
      pinned: true,
      collapsed: false,
      activitySectionOrder: [],
    };
    const [got] = await getAndList();
    const runtime = createDesktopRuntime();
    try {
      const listed = await runtime.query('core.workspace.list', {}, options);
      expect(listed.items).toEqual([
        expect.objectContaining(first),
        expect.objectContaining({
          name: 'Second',
          color: '#0EA5E9',
          collapsed: true,
          activitySectionOrder: ['cost'],
        }),
      ]);
      expect(listed.items[1]).not.toHaveProperty('pinned');
      expect(got).toMatchObject(first);
    } finally {
      await runtime.shutdown();
    }
  });

  it('keeps duplicate-id rows on their own fields past skipped rows, scoping and continuation (CAN-5373)', async () => {
    storeWorkspace({}, {});
    const row = { id: 'a', type: 'single-repo' };
    writeFileSync(
      join(root, 'index.json'),
      JSON.stringify({
        version: 1,
        workspaces: [
          { ...row, name: 'First', color: '#7C3AED', order: 2, pinned: 1 },
          // Readable but unprojectable (no workspace.json), then unreadable.
          { ...row, id: 'b', name: 'Gone', color: '#7C3AED', order: 0 },
          { id: 'u', type: 'mystery', name: 'Odd', color: '#7C3AED', order: 0 },
          { ...row, name: 'Second', color: '#0EA5E9', order: 1, pinned: true },
        ],
      }),
    );
    const runtime = createDesktopRuntime();
    try {
      const got = await runtime.query(
        'core.workspace.get',
        { workspaceId: 'a' },
        options,
      );
      expect(got).toMatchObject({ name: 'First', color: '#7C3AED' });
      expect(got).not.toHaveProperty('pinned');
      const listed = await runtime.query('core.workspace.list', {}, options);
      expect(listed.items.map((item) => item.name)).toEqual([
        'Second',
        'First',
      ]);
      expect(listed.items[0]).toMatchObject({ color: '#0EA5E9', pinned: true });
      expect(listed.items[1]).toMatchObject({ color: '#7C3AED' });
      expect(listed.items[1]).not.toHaveProperty('pinned');
      const page = await runtime.query(
        'core.workspace.list',
        { scope: { workspaceId: 'a' }, pageSize: 1 },
        options,
      );
      expect(page.items).toEqual([listed.items[0]]);
      const next = await runtime.query(
        'core.workspace.list',
        { scope: { workspaceId: 'a' }, pageSize: 1, cursor: cursorOf(page) },
        options,
      );
      expect(next.items).toEqual([listed.items[1]]);
    } finally {
      await runtime.shutdown();
    }
  });

  it('pins continuation across a logged insert, removal, reorder and item update', async () => {
    await verifiedFixture();
    const runtime = createDesktopRuntime();
    const capture = jest.spyOn(host, 'capture');
    try {
      const first = await runtime.queryWorktreeListForLegacyIpc(
        { scope, pageSize: 1 },
        options,
      );
      expect(
        first.canonicalResult?.items.map((item) => item.worktreeId),
      ).toEqual(['one']);
      const collection = first.canonicalResult?.collectionRevision;
      expect(collection).toBeGreaterThan(0);
      const three = await counter({
        kind: 'worktree',
        workspaceId: 'a',
        worktreeId: 'three',
      });
      const createdAt = new Date().toISOString();
      await updateWorkspaceWorktrees('a', (rows) => [
        ...rows
          .filter((row) => row.id === 'three')
          .map((row) => ({ ...row, branchName: 'renamed' })),
        { id: 'zero', branchName: 'zeroth', createdAt },
      ]);
      expect(diskIds()).toEqual(['three', 'zero']);

      const next = await runtime.queryWorktreeListForLegacyIpc(
        { scope, pageSize: 1, cursor: cursorOf(first.canonicalResult) },
        options,
      );
      expect(next.canonicalResult).toEqual({
        items: [
          expect.objectContaining({
            worktreeId: 'three',
            branch: 'third',
            revision: three,
          }),
        ],
        nextCursor: null,
        collectionRevision: collection,
      });
      // The same legacy capture, not the list as it now is.
      expect(next.legacyResult).toEqual(first.legacyResult);
      expect(next.legacyAuthority).toEqual(first.legacyAuthority);
      expect(capture).toHaveBeenCalledTimes(1);

      const fresh = await runtime.query(
        'core.worktree.list',
        { scope },
        options,
      );
      expect(fresh.items.map((item) => item.branch)).toEqual([
        'renamed',
        'zeroth',
      ]);
      expect(fresh.collectionRevision).toBeGreaterThan(collection ?? 0);
    } finally {
      capture.mockRestore();
      await runtime.shutdown();
    }
  });

  it('keeps continuation stable when only an item changes and its collection counter does not', async () => {
    await verifiedFixture();
    const runtime = createDesktopRuntime();
    try {
      const first = await runtime.query(
        'core.worktree.list',
        { scope, pageSize: 1 },
        options,
      );
      const collection = await counter({ kind: 'worktrees', workspaceId: 'a' });
      expect(first.collectionRevision).toBe(collection);
      const before = await counter({
        kind: 'worktree',
        workspaceId: 'a',
        worktreeId: 'three',
      });
      await updateWorkspaceWorktrees('a', (rows) =>
        rows.map((row) =>
          row.id === 'three' ? { ...row, branchName: 'renamed' } : row,
        ),
      );
      expect(await counter({ kind: 'worktrees', workspaceId: 'a' })).toBe(
        collection,
      );
      const item = await counter({
        kind: 'worktree',
        workspaceId: 'a',
        worktreeId: 'three',
      });
      expect(item).toBeGreaterThan(before);

      const next = await runtime.query(
        'core.worktree.list',
        { scope, pageSize: 1, cursor: cursorOf(first) },
        options,
      );
      expect(next.items).toEqual([
        expect.objectContaining({ branch: 'third', revision: before }),
      ]);
      // Same collection revision, different contents: never a page-cache key.
      const fresh = await runtime.query(
        'core.worktree.list',
        { scope },
        options,
      );
      expect(fresh.collectionRevision).toBe(collection);
      expect(fresh.items[1]).toMatchObject({
        branch: 'renamed',
        revision: item,
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it('pins a workspace listing across index changes', async () => {
    writeFileSync(
      join(root, 'index.json'),
      readFileSync(join(root, 'index.json'), 'utf8').replace(
        '"order":0}',
        '"order":0},{"id":"b","name":"b","type":"cowork","color":"#7C3AED","collapsed":false,"order":1}',
      ),
    );
    mkdirSync(join(root, 'b'));
    writeFileSync(
      join(root, 'b', 'workspace.json'),
      JSON.stringify({ version: 1, type: 'cowork', repos: [] }),
    );
    const runtime = createDesktopRuntime();
    const capture = jest.spyOn(host, 'capture');
    try {
      const first = await runtime.query(
        'core.workspace.list',
        { pageSize: 1 },
        options,
      );
      expect(first.items.map((item) => item.workspaceId)).toEqual(['a']);
      await getWorkspaceIndexRepository().update(() => ({
        result: null,
        entries: [
          {
            id: 'c',
            name: 'Inserted',
            type: 'cowork',
            color: '#7C3AED',
            collapsed: false,
            order: 0,
          },
          {
            id: 'a',
            name: 'Renamed',
            type: 'single-repo',
            color: '#7C3AED',
            collapsed: false,
            order: 1,
          },
        ],
      }));
      await expect(
        runtime.query(
          'core.workspace.list',
          { pageSize: 1, cursor: cursorOf(first) },
          options,
        ),
      ).resolves.toEqual({
        items: [expect.objectContaining({ workspaceId: 'b', name: 'b' })],
        nextCursor: null,
      });
      expect(capture).toHaveBeenCalledTimes(1);
    } finally {
      capture.mockRestore();
      await runtime.shutdown();
    }
  });
});

describe('a projection that binds inherited organization hooks', () => {
  let flag: jest.SpyInstance;
  beforeEach(() => {
    flag = jest
      .spyOn(getFeatureFlagService(), 'isEnabled')
      .mockReturnValue(true);
    writeOwnedManifest();
    writeFileSync(
      getPrimaryProjectConfigFilePath(repo),
      JSON.stringify({
        version: 1,
        hooks: {
          'pr:create': [{ type: 'pipeline', source: 'bundled', id: 'review' }],
        },
      }),
    );
  });
  afterEach(() => flag.mockRestore());

  it('keeps the workspace listed and persists the binding once the read ends', async () => {
    const runtime = createDesktopRuntime();
    try {
      const listed = await runtime.queryWorkspaceListForLegacyIpc(
        {},
        { caller: readCaller },
      );
      expect(listed.legacyResult.warnings).toBeUndefined();
      expect(
        listed.canonicalResult?.items.map((item) => item.workspaceId),
      ).toEqual(['a']);
      const bound = {
        'pr:create': [
          expect.objectContaining({
            executionContext: `org:${owner.organizationId}`,
          }),
        ],
      };
      expect(listed.legacyResult.items[0]).toMatchObject({
        effectiveHooks: bound,
      });
      const manifest: unknown = JSON.parse(
        readFileSync(join(root, 'a', 'workspace.json'), 'utf8'),
      );
      expect(manifest).toMatchObject({ hooks: bound });
    } finally {
      await runtime.shutdown();
    }
  });

  it("binds a multi-repo project's repository hooks in that repository", async () => {
    writeFileSync(
      join(root, 'index.json'),
      readFileSync(join(root, 'index.json'), 'utf8').replace(
        '"single-repo"',
        '"multi-repo"',
      ),
    );
    writeFileSync(
      join(root, 'a', 'workspace.json'),
      JSON.stringify({
        version: 1,
        type: 'multi-repo',
        repos: [{ id: 'r1', name: 'r1', repoPath: repo }],
        owner,
      }),
    );
    const runtime = createDesktopRuntime();
    try {
      const listed = await runtime.queryWorkspaceListForLegacyIpc(
        {},
        { caller: readCaller },
      );
      expect(listed.legacyResult.warnings).toBeUndefined();
      const bound = {
        'pr:create': [
          expect.objectContaining({
            executionContext: `org:${owner.organizationId}`,
          }),
        ],
      };
      expect(listed.legacyResult.items[0]).toMatchObject({
        repos: [{ id: 'r1', effectiveHooks: bound }],
      });
      const manifest: unknown = JSON.parse(
        readFileSync(join(root, 'a', 'workspace.json'), 'utf8'),
      );
      expect(manifest).toMatchObject({ repos: [{ id: 'r1', hooks: bound }] });
      expect(manifest).not.toHaveProperty('hooks');
    } finally {
      await runtime.shutdown();
    }
  });
});

// Workspace ids are name slugs, which the capture's id grammar can refuse.
describe.each(['aux', 'x'.repeat(129)])(
  'a workspace id the capture cannot name (%s)',
  (id) => {
    beforeEach(() => {
      writeFileSync(
        join(root, 'index.json'),
        readFileSync(join(root, 'index.json'), 'utf8').replace(
          '"order":0}',
          `"order":0},{"id":"${id}","name":"Other","type":"single-repo","color":"#7C3AED","collapsed":false,"order":1}`,
        ),
      );
      mkdirSync(join(root, id));
      writeFileSync(
        join(root, id, 'workspace.json'),
        readFileSync(join(root, 'a', 'workspace.json'), 'utf8'),
      );
      writeFileSync(join(root, id, 'worktrees.json'), readFileSync(listPath()));
    });

    it('reads the whole query live and says so, instead of dropping the workspace', async () => {
      const runtime = createDesktopRuntime();
      try {
        const listed = await runtime.queryWorkspaceListForLegacyIpc(
          {},
          { caller: readCaller },
        );
        expect(
          listed.canonicalResult?.items.map((item) => item.workspaceId),
        ).toEqual(['a', id]);
        expect(listed.legacyAuthority?.provenance?.position).toEqual({
          status: 'uncaptured',
          reason: 'unsupported-id',
        });
        const got = await runtime.queryWorktreeGetForLegacyIpc(
          { worktreeId: 'one', scope: { workspaceId: id } },
          { caller: readCaller },
        );
        expect(got.canonicalResult).toMatchObject({ workspaceId: id });
        expect(got.legacyAuthority?.provenance?.position).toEqual({
          status: 'uncaptured',
          reason: 'unsupported-id',
        });
        expect(labels(got.legacyAuthority)).toEqual([
          'worktree:one complete not-captured',
        ]);
      } finally {
        await runtime.shutdown();
      }
    });

    it('publishes no revision from the live fallback, though captured reads of the same rows do', async () => {
      await logFixtureFromAbsence();
      await updateWorkspaceWorktrees('a', (rows) => rows);
      const index: unknown = JSON.parse(
        readFileSync(join(root, 'index.json'), 'utf8'),
      );
      if (
        typeof index !== 'object' ||
        index === null ||
        !('workspaces' in index) ||
        !Array.isArray(index.workspaces)
      )
        throw new Error('index.json shape');
      const workspaces: unknown[] = index.workspaces;
      writeFileSync(
        join(root, 'index.json'),
        JSON.stringify({
          ...index,
          workspaces: [
            ...workspaces,
            {
              id,
              name: 'Other',
              type: 'single-repo',
              color: '#7C3AED',
              collapsed: false,
              order: 1,
            },
          ],
        }),
      );
      const runtime = createDesktopRuntime();
      try {
        const live = await runtime.queryWorktreeListForLegacyIpc(
          {},
          { caller: readCaller },
        );
        expect(live.legacyAuthority?.provenance?.position).toEqual({
          status: 'uncaptured',
          reason: 'unsupported-id',
        });
        expect(
          live.canonicalResult?.items
            .filter((item) => item.workspaceId === 'a')
            .map((item) => item.worktreeId),
        ).toEqual(['one', 'three']);
        for (const item of live.canonicalResult?.items ?? [])
          expect(item).not.toHaveProperty('revision');
        const captured = await runtime.query(
          'core.worktree.list',
          { scope: { workspaceId: 'a' } },
          { caller: readCaller },
        );
        expect(captured.items.map((item) => item.revision)).toEqual([
          expect.any(Number),
          expect.any(Number),
        ]);
        expect(captured.collectionRevision).toBeGreaterThan(0);
      } finally {
        await runtime.shutdown();
      }
    });
  },
);

// Discovery decodes strictly; the repositories decode as the live store does.
describe('an index with an invalid UTF-8 byte', () => {
  beforeEach(() => {
    const index = readFileSync(join(root, 'index.json'));
    const name = index.indexOf('"name":"') + '"name":"'.length;
    writeFileSync(
      join(root, 'index.json'),
      Buffer.concat([
        index.subarray(0, name),
        Buffer.from([0xff]),
        index.subarray(name),
      ]),
    );
  });

  it('reads discovery queries live and says so, instead of dropping every project', async () => {
    const runtime = createDesktopRuntime();
    try {
      const listed = await runtime.queryWorkspaceListForLegacyIpc(
        {},
        { caller: readCaller },
      );
      expect(listed.legacyResult.warnings).toBeUndefined();
      expect(
        listed.canonicalResult?.items.map((item) => item.workspaceId),
      ).toEqual(['a']);
      expect(listed.legacyAuthority?.provenance?.position).toEqual({
        status: 'uncaptured',
        reason: 'undecodable-index',
      });
      const worktrees = await runtime.queryWorktreeListForLegacyIpc(
        {},
        { caller: readCaller },
      );
      expect(
        worktrees.canonicalResult?.items.map((item) => item.worktreeId),
      ).toEqual(['one', 'three']);
      const got = await runtime.queryWorktreeGetForLegacyIpc(
        { worktreeId: 'three' },
        { caller: readCaller },
      );
      expect(got.canonicalResult).toMatchObject({ workspaceId: 'a' });
    } finally {
      await runtime.shutdown();
    }
  });

  it('keeps a scoped query captured, since it names its own files', async () => {
    const runtime = createDesktopRuntime();
    try {
      const got = await runtime.queryWorktreeGetForLegacyIpc(
        { worktreeId: 'one', scope: { workspaceId: 'a' } },
        { caller: readCaller },
      );
      expect(got.canonicalResult).toMatchObject({ workspaceId: 'a' });
      expect(got.legacyAuthority?.provenance?.position).toMatchObject({
        status: 'captured',
        discovery: 'not-requested',
      });
      expect(
        got.legacyAuthority?.provenance?.files.filter(
          ({ provenance }) =>
            provenance.status === 'unverified' &&
            provenance.reason === 'not-captured',
        ),
      ).toEqual([]);
    } finally {
      await runtime.shutdown();
    }
  });
});

it('keeps a discovery query captured when the invalid index entry names no files', async () => {
  writeFileSync(
    join(root, 'index.json'),
    readFileSync(join(root, 'index.json'), 'utf8').replace(
      '"order":0}',
      '"order":0},{"id":7,"name":"Bad","type":"single-repo","color":"#7C3AED","order":1}',
    ),
  );
  const runtime = createDesktopRuntime();
  try {
    const listed = await runtime.queryWorkspaceListForLegacyIpc(
      {},
      { caller: readCaller },
    );
    expect(
      listed.canonicalResult?.items.map((item) => item.workspaceId),
    ).toEqual(['a']);
    expect(listed.legacyAuthority?.provenance?.position).toMatchObject({
      status: 'captured',
      discovery: 'invalid-index',
    });
  } finally {
    await runtime.shutdown();
  }
});
