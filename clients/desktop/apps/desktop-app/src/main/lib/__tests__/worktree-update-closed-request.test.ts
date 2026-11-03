// CAN-5526 (W5d2 PR 2): `core.worktree.update`'s request and patch are
// closed, and its two host-only fields keep their bytes. `worktreeOrder` is
// sent only by branch grouping and `expectedCreatedAt` only by `projects_save`.
// Real commit-log worker, filesystem and sidebar save adapter.
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import type { W5Resource } from '@canopy/desktop-shared/node/w5-commit-log';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
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
jest.mock('../archived-containers', () => ({
  countArchivedContainers: jest.fn(() => Promise.resolve(0)),
}));
jest.mock('../script-resolver', () => ({
  resolveProjectScripts: jest.fn(() => Promise.resolve({})),
  toScriptOverrides: jest.fn(),
}));
jest.mock('../hook-resolver', () => ({
  resolveProjectHooks: jest.fn(() => Promise.resolve({})),
  toHookOverrides: jest.fn(),
}));
jest.mock('../../services/foreign-activity-sources', () => ({
  markForeignPipelineResultsSeen: jest.fn(),
}));

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import * as worktreeUpdate from '../worktree-update';
import {
  updateWorktree,
  type WorktreeMetadataPatch,
  type WorktreeUpdateRequest,
} from '../worktree-update';
import {
  __resetSidebarItemsStateForTests,
  readAllSidebarItems,
} from '../sidebar-items';
import { saveSidebarItems } from '../sidebar-save-adapter';
import { updateWorkspaceWorktrees } from '../workspace-persistence';

jest.setTimeout(90_000);
let dir: string;
let root: string;
let dbPath: string;
let host: W5CommitLogHost;
let createdAt: string;
let originalDataDir: string | undefined;

const listPath = (): string => join(root, 'a', 'worktrees.json');
const files = (): string[] => [
  join(root, 'index.json'),
  join(root, 'a', 'workspace.json'),
  listPath(),
  join(root, 'a', 'sidebar-item-groups.json'),
];
function images(): Record<string, string> {
  return Object.fromEntries(
    files().map((path) => [
      path,
      existsSync(path) ? readFileSync(path, 'utf8') : '<absent>',
    ]),
  );
}
const replicaListSchema = z.object({
  worktrees: z.array(z.object({ id: z.string(), replica: z.unknown() })),
});
/** Each row's replica, recorded with random ids by the first list write. */
let replicas: Map<string, unknown>;
/**
 * The exact list bytes for `rows` in order. Each row's own fields come in the
 * order given, followed by its preserved replica.
 */
function goldenList(
  rows: ReadonlyArray<{ id: string; fields: Record<string, unknown> }>,
): string {
  const branchNames: Record<string, string> = {
    one: 'first',
    two: 'second',
    three: 'third',
  };
  return JSON.stringify(
    {
      version: 1,
      worktrees: rows.map(({ id, fields }) => ({
        id,
        branchName: branchNames[id],
        createdAt,
        ...fields,
        replica: replicas.get(id),
      })),
    },
    null,
    2,
  );
}
const RESOURCES: Record<string, W5Resource> = {
  list: { kind: 'worktrees', workspaceId: 'a' },
  one: { kind: 'worktree', workspaceId: 'a', worktreeId: 'one' },
  two: { kind: 'worktree', workspaceId: 'a', worktreeId: 'two' },
  three: { kind: 'worktree', workspaceId: 'a', worktreeId: 'three' },
};
async function revisions(): Promise<Record<string, number>> {
  const entries = await Promise.all(
    Object.entries(RESOURCES).map(
      async ([name, resource]) =>
        [name, await host.revision(resource)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

/** Untyped callers reach the boundary unchecked; tests send them the same way. */
const untypedRequest = (
  request: WorktreeUpdateRequest,
  extra: Record<string, unknown>,
): WorktreeUpdateRequest => Object.assign({ ...request }, extra);
const untypedPatch = (value: Record<string, unknown>): WorktreeMetadataPatch =>
  value;

function startHost(): void {
  host = new W5CommitLogHost({
    dbPath,
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  __resetSidebarItemsStateForTests();
}
async function restartHost(): Promise<void> {
  await host.shutdown();
  startHost();
}

beforeEach(async () => {
  ({ dir, root } = createW5BoundaryFixture((incarnation) => {
    createdAt = incarnation;
    return [
      { id: 'one', branchName: 'first', createdAt },
      { id: 'two', branchName: 'second', createdAt },
      { id: 'three', branchName: 'third', createdAt },
    ];
  }));
  dbPath = join(dir, 'data', 'w5', 'commit-log.sqlite');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  startHost();
  // The first list write records the rows' replica ids; later writes keep them.
  await updateWorkspaceWorktrees('a', (worktrees) => [...worktrees]);
  replicas = new Map(
    replicaListSchema
      .parse(JSON.parse(readFileSync(listPath(), 'utf8')))
      .worktrees.map((row) => [row.id, row.replica]),
  );
  jest.clearAllMocks();
});
afterEach(async () => {
  jest.restoreAllMocks();
  await settleDetachedWork();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const KEYED = {
  workspaceId: 'a',
  worktreeId: 'one',
  patch: { label: 'keyed' },
  idempotencyKey: 'key',
};

describe('the closed request', () => {
  const unknownFields: Array<[string, Record<string, unknown>]> = [
    // Web's first-come wire patch has `targetId`; desktop has no disposition
    // for it yet, so it is refused, never dropped.
    ['patch targetId', { patch: { label: 'keyed', targetId: 'two' } }],
    [
      'patch branchGroupingParentWorktreeId',
      { patch: { label: 'keyed', branchGroupingParentWorktreeId: 'two' } },
    ],
    ['patch worktreeOrder', { patch: { label: 'keyed', worktreeOrder: [] } }],
    ['patch status', { patch: { label: 'keyed', status: 'done' } }],
    ['top-level targetId', { targetId: 'two' }],
    ['top-level label', { label: 'outside the patch' }],
    ['top-level workspaceOrder', { workspaceOrder: ['a'] }],
    ['top-level source', { source: 'projects_save' }],
  ];

  it.each(unknownFields)(
    'refuses an unknown %s before its key is looked up or reserved, leaving the key free',
    async (_field, extra) => {
      const withUnknown = (): Promise<unknown> =>
        updateWorktree(untypedRequest(KEYED, extra));
      const before = images();
      const lookups = jest.spyOn(host, 'lookupReceipt');
      const reserve = jest.spyOn(host, 'reserve');
      const commits = jest.spyOn(host, 'commit');
      await expect(withUnknown()).rejects.toMatchObject({
        reason: 'invalid-patch',
      });
      expect(lookups).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
      expect(commits).not.toHaveBeenCalled();
      expect(images()).toEqual(before);

      // The key is free: the valid request is its first application.
      const outcome = await updateWorktree(KEYED);
      expect(outcome.changed).toBe(true);
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(commits).toHaveBeenCalledTimes(1);
      const applied = images();

      // Still refused at admission after the decision, not replayed.
      await expect(withUnknown()).rejects.toMatchObject({
        reason: 'invalid-patch',
      });
      await restartHost();
      const restartedLookups = jest.spyOn(host, 'lookupReceipt');
      const restartedCommits = jest.spyOn(host, 'commit');
      await expect(withUnknown()).rejects.toMatchObject({
        reason: 'invalid-patch',
      });
      expect(restartedLookups).not.toHaveBeenCalled();
      expect(await updateWorktree(KEYED)).toEqual(outcome);
      expect(restartedCommits).not.toHaveBeenCalled();
      expect(images()).toEqual(applied);
    },
  );

  it.each([
    ['a non-array worktreeOrder', { worktreeOrder: 'two' }],
    ['a non-string expectedCreatedAt', { expectedCreatedAt: 1 }],
    ['a non-number expectedRevision', { expectedRevision: '0' }],
  ])('refuses %s before any read or write', async (_name, extra) => {
    const before = images();
    const lookups = jest.spyOn(host, 'lookupReceipt');
    const commits = jest.spyOn(host, 'commit');
    await expect(
      updateWorktree(untypedRequest(KEYED, extra)),
    ).rejects.toMatchObject({ reason: 'invalid-patch' });
    expect(lookups).not.toHaveBeenCalled();
    expect(commits).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
  });

  it('names an unknown patch key, not an empty patch, when it is the only key', async () => {
    const before = images();
    await expect(
      updateWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        patch: untypedPatch({ targetId: null }),
      }),
    ).rejects.toMatchObject({
      reason: 'invalid-patch',
      message: 'Unknown worktree patch field',
    });
    expect(images()).toEqual(before);
  });

  // Receipts recorded before the closure must still replay.
  it('fingerprints the same parameters as before the closure, host-only fields included', async () => {
    const reserve = jest.spyOn(host, 'reserve');
    await updateWorktree({
      workspaceId: 'a',
      worktreeId: 'two',
      expectedCreatedAt: createdAt,
      patch: { branchGroupingOverride: 'ungroup', label: ' Two ' },
      worktreeOrder: ['two', 'one', 'three'],
      expectedRevision: undefined,
      idempotencyKey: 'key',
    });
    expect(reserve.mock.calls[0]?.[0]?.receipt?.fingerprint).toBe(
      createHash('sha256')
        .update(
          JSON.stringify({
            expectedCreatedAt: createdAt,
            patch: { branchGroupingOverride: 'ungroup', label: ' Two ' },
            workspaceId: 'a',
            worktreeId: 'two',
            worktreeOrder: ['two', 'one', 'three'],
          }),
        )
        .digest('hex'),
    );
  });
});

describe('host-only callers keep their golden bytes, labels and revisions', () => {
  it('branch grouping applies its override and full order in one decision', async () => {
    const commits = jest.spyOn(host, 'commit');
    // The request `worktree:set-branch-grouping` composes (worktrees.ts).
    const outcome = await updateWorktree({
      workspaceId: 'a',
      worktreeId: 'three',
      patch: { branchGroupingOverride: 'ungroup' },
      worktreeOrder: ['three', 'one', 'two'],
    });

    expect(outcome.changed).toBe(true);
    expect(
      commits.mock.calls.map(([request]) => [
        request.operation,
        request.receipt,
        request.expectedRevisions,
        request.files.map((file) => file.path),
      ]),
    ).toEqual([['core.worktree.update', undefined, undefined, [listPath()]]]);
    expect(readFileSync(listPath(), 'utf8')).toBe(
      goldenList([
        { id: 'three', fields: { branchGroupingOverride: 'ungroup' } },
        { id: 'one', fields: {} },
        { id: 'two', fields: {} },
      ]),
    );
    // The order bumps the list; the override bumps only its own row.
    expect(await revisions()).toEqual({ list: 1, one: 1, two: 1, three: 2 });
  });

  it('projects_save edits only the incarnation it was shown', async () => {
    const baseline = (await readAllSidebarItems()).items;
    const incoming = baseline.map((item) =>
      item.type === 'cowork'
        ? item
        : {
            ...item,
            worktrees: item.worktrees.map((worktree) =>
              worktree.id === 'two'
                ? { ...worktree, label: 'Saved', pinned: true }
                : worktree,
            ),
          },
    );
    const commits = jest.spyOn(host, 'commit');
    const updates = jest.spyOn(worktreeUpdate, 'updateWorktree');
    await saveSidebarItems({
      source: 'projects_save',
      items: incoming,
      previousItems: baseline,
    });

    expect(
      commits.mock.calls
        .filter(([request]) =>
          request.files.some((file) => file.path === listPath()),
        )
        .map(([request]) => [
          request.operation,
          request.receipt,
          request.expectedRevisions,
        ]),
    ).toEqual([['core.worktree.update', undefined, undefined]]);
    expect(updates.mock.calls).toEqual([
      [
        {
          workspaceId: 'a',
          worktreeId: 'two',
          expectedCreatedAt: createdAt,
          patch: { label: 'Saved', pinned: true },
        },
      ],
    ]);
    expect(readFileSync(listPath(), 'utf8')).toBe(
      goldenList([
        { id: 'one', fields: {} },
        { id: 'two', fields: { label: 'Saved', pinned: true } },
        { id: 'three', fields: {} },
      ]),
    );
    expect(await revisions()).toEqual({ list: 0, one: 1, two: 2, three: 1 });
  });

  it('a stale expectedCreatedAt is not found and writes nothing', async () => {
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    await expect(
      updateWorktree({
        workspaceId: 'a',
        worktreeId: 'two',
        expectedCreatedAt: '2000-01-01T00:00:00.000Z',
        patch: { label: 'Saved' },
      }),
    ).rejects.toMatchObject({
      reason: 'not-found',
      message: 'Worktree two not found in project a',
    });
    expect(
      commits.mock.calls.filter(([request]) => request.files.length),
    ).toEqual([]);
    expect(images()).toEqual(before);
    expect(await revisions()).toEqual({ list: 0, one: 1, two: 1, three: 1 });
  });
});
