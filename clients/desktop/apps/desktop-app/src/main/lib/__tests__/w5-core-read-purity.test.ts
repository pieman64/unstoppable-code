// RR1: core read adapter queries over the real W5 commit-log worker and files.
import { readFileSync, realpathSync, rmSync } from 'node:fs';
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
  setWorkspaceActivitySectionOrder,
} from '../sidebar-items';
import {
  markWorkspaceWorktreeRecentlyRemoved,
  readWorkspaceWorktrees,
  setBeforeProjectPluginDefaultsChangeHandler,
  setWorktreeRegistryReconciler,
  updateWorkspaceConfig,
  updateWorkspaceWorktrees,
} from '../workspace-persistence';
import { createCoreWorkspaceAdapter } from '../../canopy-runtime/core-workspace-adapter';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';

jest.setTimeout(60_000);
let dir: string;
let root: string;
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
  ({ dir, root } = createW5BoundaryFixture((createdAt) => [
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
