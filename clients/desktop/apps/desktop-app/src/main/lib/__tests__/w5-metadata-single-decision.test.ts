// CAN-4393: the four metadata boundaries (core.workspace.update,
// core.workspace.reorder, core.worktree.update, core.worktree.reorder) each
// commit their files, revisions, receipt and outcome as one decision. Real
// commit-log worker, filesystem and sidebar group reconciler.
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  W5CommitLog,
  type W5Resource,
} from '@canopy/desktop-shared/node/w5-commit-log';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

import { notifyPortalStructureChanged } from '../../portal/portal-event-bus';
import { schedulePortalStructuralSync } from '../../portal/portal-structural-sync';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  W5FileWriteRefusedError,
  W5RevisionConflictError,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { diagnoseW5State } from '../w5-maintenance-diagnosis';
import {
  moveWorktree,
  updateWorktree,
  type WorktreeMoveRequest,
} from '../worktree-update';
import {
  reorderWorkspaces,
  updateWorkspaceMetadata,
} from '../workspace-metadata';
import {
  __resetSidebarItemsStateForTests,
  getWorkspaceIndexRepository,
} from '../sidebar-items';
import {
  setBeforeProjectPluginDefaultsChangeHandler,
  setWorktreeRegistryReconciler,
  updateWorkspaceConfig,
  updateWorkspaceWorktrees,
} from '../workspace-persistence';
import {
  initializeSidebarItemGroups,
  sidebarItemGroupsService,
} from '../../services/sidebar-item-groups-service';

jest.setTimeout(90_000);
let dir: string;
let root: string;
let dbPath: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;

const indexPath = (): string => join(root, 'index.json');
const manifestPath = (): string => join(root, 'a', 'workspace.json');
const listPath = (): string => join(root, 'a', 'worktrees.json');
const sidecarPath = (): string => join(root, 'a', 'sidebar-item-groups.json');
const files = (): string[] => [
  indexPath(),
  `${indexPath()}.bak`,
  manifestPath(),
  listPath(),
  sidecarPath(),
  ...['b', 'c'].flatMap((id) => [
    join(root, id, 'workspace.json'),
    join(root, id, 'worktrees.json'),
  ]),
];
function images(): Record<string, string> {
  return Object.fromEntries(
    files().map((path) => [
      path,
      existsSync(path) ? readFileSync(path, 'utf8') : '<absent>',
    ]),
  );
}
function restore(saved: Record<string, string>): void {
  for (const [path, contents] of Object.entries(saved)) {
    if (contents === '<absent>') rmSync(path, { force: true });
    else writeFileSync(path, contents);
  }
  __resetSidebarItemsStateForTests();
}

const listSchema = z
  .object({
    worktrees: z.array(
      z.object({ id: z.string(), label: z.string().optional() }).passthrough(),
    ),
  })
  .passthrough();
const indexSchema = z.object({
  workspaces: z.array(z.object({ id: z.string(), name: z.string() })),
});
const manifestSchema = z.object({ itemSortMode: z.string().optional() });
const rows = (): z.infer<typeof listSchema>['worktrees'] =>
  listSchema.parse(JSON.parse(readFileSync(listPath(), 'utf8'))).worktrees;
const rowOrder = (): string[] => rows().map((row) => row.id);
const label = (id: string): string | undefined =>
  rows().find((row) => row.id === id)?.label;
const workspaceOrder = (): string[] =>
  indexSchema
    .parse(JSON.parse(readFileSync(indexPath(), 'utf8')))
    .workspaces.map((entry) => entry.id);
const workspaceName = (): string | undefined =>
  indexSchema
    .parse(JSON.parse(readFileSync(indexPath(), 'utf8')))
    .workspaces.find((entry) => entry.id === 'a')?.name;
/** Untyped callers reach the boundary unchecked; tests send them the same way. */
const untypedMove = (value: Record<string, unknown>): WorktreeMoveRequest =>
  value as WorktreeMoveRequest;
const sortMode = (): string | undefined =>
  manifestSchema.parse(JSON.parse(readFileSync(manifestPath(), 'utf8')))
    .itemSortMode;

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

/** The offline resolve an operator runs on a cold log after shutdown. */
async function resolveColdRecovery(): Promise<void> {
  await host.shutdown();
  const cold = W5CommitLog.open(dbPath);
  try {
    for (const reservation of cold.listReservations())
      if (reservation.state === 'recovery-required')
        cold.resolveRecovery(reservation.reservationId);
  } finally {
    cold.close();
  }
  startHost();
}

/** The decision request fails as if the worker died before deciding. */
function failBeforeDecision(): void {
  jest.spyOn(host, 'commit').mockImplementation(async () => {
    await host.shutdown();
    throw new Error('worker died before decision');
  });
  // The process dies too, before it can mark its reservation.
  jest
    .spyOn(host, 'markReservationRecoveryRequired')
    .mockRejectedValue(new Error('process died'));
}

beforeEach(() => {
  ({ dir, root } = createW5BoundaryFixture(
    (createdAt) => [
      { id: 'one', branchName: 'old', createdAt },
      { id: 'two', branchName: 'second', createdAt },
      { id: 'three', branchName: 'third', createdAt },
    ],
    ['b', 'c'],
  ));
  dbPath = join(dir, 'data', 'w5', 'commit-log.sqlite');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  initializeSidebarItemGroups();
  startHost();
  jest.clearAllMocks();
});
afterEach(async () => {
  jest.restoreAllMocks();
  await settleDetachedWork();
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

interface Options {
  idempotencyKey?: string;
  expectedRevision?: number;
}
interface BoundaryCase {
  /** The keyed change under test, from the fixture. */
  run: (options?: Options) => Promise<unknown>;
  /** Its saved outcome on the fixture. */
  outcome: unknown;
  /** The keyed change applied exactly once to the fixture. */
  applied: () => void;
  resource: W5Resource;
  /** An unkeyed write of the same resource. */
  intervene: () => Promise<unknown>;
  /** The intervening value is what the files hold. */
  intervened: () => void;
  /** The keyed change's first application over the intervening write. */
  appliedOver: { outcome: unknown; verify: () => void };
}

const KEYED_ROW: unknown = expect.objectContaining({
  id: 'one',
  label: 'keyed',
});
const ANY_NUMBER: unknown = expect.any(Number);

const boundaries: Record<string, BoundaryCase> = {
  'core.workspace.update': {
    run: (options) =>
      updateWorkspaceMetadata({
        ...options,
        workspaceId: 'a',
        source: 'portal',
        patch: { name: 'Keyed', itemSortMode: 'last-updated' },
      }),
    outcome: { workspaceId: 'a', indexWritten: true, manifestWritten: true },
    applied: () => {
      expect(workspaceName()).toBe('Keyed');
      expect(sortMode()).toBe('last-updated');
    },
    resource: { kind: 'workspace', workspaceId: 'a' },
    intervene: () =>
      updateWorkspaceMetadata({
        workspaceId: 'a',
        source: 'portal',
        patch: { name: 'Newer' },
      }),
    intervened: () => {
      expect(workspaceName()).toBe('Newer');
      expect(sortMode()).toBe('manual');
    },
    appliedOver: {
      outcome: { workspaceId: 'a', indexWritten: true, manifestWritten: true },
      verify: () => {
        expect(workspaceName()).toBe('Keyed');
        expect(sortMode()).toBe('last-updated');
      },
    },
  },
  'core.workspace.reorder': {
    run: (options) =>
      reorderWorkspaces({
        ...options,
        visibleWorkspaceIds: ['a', 'b', 'c'],
        activeWorkspaceId: 'c',
        overWorkspaceId: 'a',
      }),
    outcome: { workspaceIds: ['c', 'a', 'b'] },
    applied: () => expect(workspaceOrder()).toEqual(['c', 'a', 'b']),
    resource: { kind: 'workspaces' },
    intervene: () =>
      reorderWorkspaces({
        source: 'projects_save',
        workspaceOrder: ['b', 'a', 'c'],
      }),
    intervened: () => expect(workspaceOrder()).toEqual(['b', 'a', 'c']),
    appliedOver: {
      outcome: { workspaceIds: ['b', 'c', 'a'] },
      verify: () => expect(workspaceOrder()).toEqual(['b', 'c', 'a']),
    },
  },
  'core.worktree.update': {
    run: (options) =>
      updateWorktree({
        ...options,
        workspaceId: 'a',
        worktreeId: 'one',
        patch: { label: 'keyed' },
      }),
    outcome: {
      worktree: KEYED_ROW,
      changed: true,
    },
    applied: () => expect(label('one')).toBe('keyed'),
    resource: { kind: 'worktree', workspaceId: 'a', worktreeId: 'one' },
    intervene: () =>
      updateWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        patch: { label: 'newer' },
      }),
    intervened: () => expect(label('one')).toBe('newer'),
    appliedOver: {
      outcome: {
        worktree: KEYED_ROW,
        changed: true,
      },
      verify: () => expect(label('one')).toBe('keyed'),
    },
  },
  'core.worktree.reorder': {
    run: (options) =>
      moveWorktree({
        ...options,
        workspaceId: 'a',
        activeWorktreeId: 'three',
        overWorktreeId: 'one',
      }),
    outcome: undefined,
    // A second application would move `three` again, to ['one', 'three', 'two'].
    applied: () => expect(rowOrder()).toEqual(['three', 'one', 'two']),
    resource: { kind: 'worktrees', workspaceId: 'a' },
    intervene: () =>
      moveWorktree({
        workspaceId: 'a',
        activeWorktreeId: 'two',
        overWorktreeId: 'one',
      }),
    intervened: () => expect(rowOrder()).toEqual(['two', 'one', 'three']),
    appliedOver: {
      outcome: undefined,
      verify: () => expect(rowOrder()).toEqual(['two', 'three', 'one']),
    },
  },
};
const operations = Object.keys(boundaries);
function boundary(operation: string): BoundaryCase {
  const testCase = boundaries[operation];
  if (!testCase) throw new Error(`Unknown boundary ${operation}`);
  return testCase;
}

it.each(operations)(
  '%s commits the files, receipt and outcome in one decision',
  async (operation) => {
    const testCase = boundary(operation);
    const commits = jest.spyOn(host, 'commit');
    expect(
      await testCase.run({ idempotencyKey: 'key', expectedRevision: 0 }),
    ).toEqual(testCase.outcome);
    testCase.applied();
    expect(commits).toHaveBeenCalledTimes(1);
    const [decision] = commits.mock.calls[0] ?? [];
    expect(decision?.operation).toBe(operation);
    expect(decision?.receipt).toMatchObject({ operation });
    expect(typeof decision?.reservationId).toBe('string');
    expect(decision?.expectedRevisions).toEqual([
      { resource: testCase.resource, revision: 0 },
    ]);
    expect(decision?.files.length).toBeGreaterThan(0);
    expect(decision?.outcome).toEqual(testCase.outcome ?? null);
    expect(JSON.stringify(decision?.outcome)).not.toContain(dir);
  },
);

it.each([
  ['a full order', ['b', 'c', 'a'], ['b', 'c', 'a']],
  ['the current order', ['a', 'b', 'c'], ['a', 'b', 'c']],
])(
  'core.workspace.reorder saves %s in its decision and replays it',
  async (_label, order, workspaceIds) => {
    const commits = jest.spyOn(host, 'commit');
    const run = (): Promise<unknown> =>
      reorderWorkspaces({
        source: 'projects_save',
        workspaceOrder: order,
        idempotencyKey: 'key',
      });
    expect(await run()).toEqual({ workspaceIds });
    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits.mock.calls[0]?.[0].outcome).toEqual({ workspaceIds });
    expect(commits.mock.calls[0]?.[0].receipt).toBeDefined();
    const applied = images();
    expect(workspaceOrder()).toEqual(workspaceIds);
    await restartHost();
    const restarted = jest.spyOn(host, 'commit');
    expect(await run()).toEqual({ workspaceIds });
    expect(restarted).not.toHaveBeenCalled();
    expect(images()).toEqual(applied);
  },
);

it.each(operations)(
  '%s: a lost response replays the saved decision, before and after a restart',
  async (operation) => {
    const testCase = boundary(operation);
    const commit = host.commit.bind(host);
    const commits = jest
      .spyOn(host, 'commit')
      .mockImplementationOnce(async (request) => {
        await commit(request);
        throw new Error('response lost');
      });
    await expect(testCase.run({ idempotencyKey: 'key' })).rejects.toThrow(
      'response lost',
    );
    testCase.applied();
    const applied = images();
    expect(commits).toHaveBeenCalledTimes(1);

    expect(await testCase.run({ idempotencyKey: 'key' })).toEqual(
      testCase.outcome,
    );
    expect(commits).toHaveBeenCalledTimes(1);
    expect(images()).toEqual(applied);

    await restartHost();
    const restarted = jest.spyOn(host, 'commit');
    expect(await testCase.run({ idempotencyKey: 'key' })).toEqual(
      testCase.outcome,
    );
    expect(restarted).not.toHaveBeenCalled();
    expect(images()).toEqual(applied);
  },
);

it.each(operations)(
  '%s: death before the decision leaves the files and the key recovery-required, then applies once after a resolve',
  async (operation) => {
    const testCase = boundary(operation);
    const before = images();
    failBeforeDecision();
    await expect(testCase.run({ idempotencyKey: 'key' })).rejects.toThrow(
      'worker died before decision',
    );
    jest.restoreAllMocks();
    await restartHost();
    expect(images()).toEqual(before);
    const blocked = jest.spyOn(host, 'commit');
    await expect(testCase.run({ idempotencyKey: 'key' })).rejects.toMatchObject(
      { reason: 'recovery-required' },
    );
    expect(blocked).not.toHaveBeenCalled();
    expect(images()).toEqual(before);

    await host.shutdown();
    const diagnosis = await diagnoseW5State(join(dir, 'data'));
    expect(diagnosis.reservations).toEqual([
      expect.objectContaining({ state: 'recovery-required' }),
    ]);
    expect(diagnosis.commits).toEqual([]);

    await resolveColdRecovery();
    const resolved = jest.spyOn(host, 'commit');
    expect(await testCase.run({ idempotencyKey: 'key' })).toEqual(
      testCase.outcome,
    );
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved.mock.calls[0]?.[0].receipt).toBeDefined();
    testCase.applied();
    const applied = images();
    expect(await testCase.run({ idempotencyKey: 'key' })).toEqual(
      testCase.outcome,
    );
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(images()).toEqual(applied);
  },
);

it('core.worktree.reorder: death at the receipt decision moves the row once after a resolve', async () => {
  const testCase = boundary('core.worktree.reorder');
  const commit = host.commit.bind(host);
  // Fails whichever decision carries the receipt; a receipt-less list
  // decision before it would apply.
  jest.spyOn(host, 'commit').mockImplementation(async (request) => {
    if (!request.receipt) return commit(request);
    await host.shutdown();
    throw new Error('worker died at the receipt decision');
  });
  jest
    .spyOn(host, 'markReservationRecoveryRequired')
    .mockRejectedValue(new Error('process died'));
  await expect(testCase.run({ idempotencyKey: 'key' })).rejects.toThrow(
    'worker died at the receipt decision',
  );
  jest.restoreAllMocks();
  await restartHost();
  await expect(testCase.run({ idempotencyKey: 'key' })).rejects.toMatchObject({
    reason: 'recovery-required',
  });
  await resolveColdRecovery();
  await expect(testCase.run({ idempotencyKey: 'key' })).resolves.toEqual(
    testCase.outcome,
  );
  // A second application would leave ['one', 'three', 'two'].
  testCase.applied();
});

describe.each(operations)('%s X6c', (operation) => {
  it.each(['plain', 'expected'] as const)(
    '%s: after a resolve, a same-key retry over an intervening write',
    async (variant) => {
      const testCase = boundary(operation);
      const expectedRevision = variant === 'expected' ? 0 : undefined;
      failBeforeDecision();
      await expect(
        testCase.run({ idempotencyKey: 'key', expectedRevision }),
      ).rejects.toThrow('worker died before decision');
      jest.restoreAllMocks();
      await restartHost();

      // Another, unkeyed request intervenes.
      await testCase.intervene();
      testCase.intervened();
      expect(await host.revision(testCase.resource)).toBe(1);
      await expect(
        testCase.run({ idempotencyKey: 'key', expectedRevision }),
      ).rejects.toMatchObject({ reason: 'recovery-required' });

      await resolveColdRecovery();
      const intervened = images();
      const commits = jest.spyOn(host, 'commit');
      const retry = testCase.run({ idempotencyKey: 'key', expectedRevision });
      if (variant === 'plain') {
        // A first application: the last writer wins.
        await expect(retry).resolves.toEqual(testCase.appliedOver.outcome);
        expect(commits).toHaveBeenCalledTimes(1);
        expect(commits.mock.calls[0]?.[0].receipt).toBeDefined();
        testCase.appliedOver.verify();
        const applied = images();
        await expect(testCase.run({ idempotencyKey: 'key' })).resolves.toEqual(
          testCase.appliedOver.outcome,
        );
        expect(commits).toHaveBeenCalledTimes(1);
        expect(images()).toEqual(applied);
      } else {
        await expect(retry).rejects.toBeInstanceOf(W5RevisionConflictError);
        await expect(retry).rejects.toMatchObject({
          reason: 'revision-conflict',
          expected: 0,
          actual: 1,
        });
        expect(commits).not.toHaveBeenCalled();
        testCase.intervened();
        expect(images()).toEqual(intervened);
        expect(await host.revision(testCase.resource)).toBe(1);
        // The refusal released the key.
        await expect(
          testCase.run({ idempotencyKey: 'key', expectedRevision: 1 }),
        ).resolves.toEqual(testCase.appliedOver.outcome);
        expect(commits).toHaveBeenCalledTimes(1);
      }
    },
  );
});

const stagingRefusals: Record<string, () => Promise<unknown>> = {
  'core.workspace.update': () =>
    updateWorkspaceMetadata({
      workspaceId: 'missing',
      source: 'portal',
      patch: { name: 'Keyed' },
      idempotencyKey: 'key',
    }),
  'core.workspace.reorder': () =>
    reorderWorkspaces({
      visibleWorkspaceIds: ['a', 'b', 'c'],
      activeWorkspaceId: 'c',
      overWorkspaceId: 'missing',
      idempotencyKey: 'key',
    }),
  'core.worktree.update': () =>
    updateWorktree({
      workspaceId: 'a',
      worktreeId: 'missing',
      patch: { label: 'keyed' },
      idempotencyKey: 'key',
    }),
  'core.worktree.reorder': () =>
    moveWorktree({
      workspaceId: 'a',
      activeWorktreeId: 'missing',
      overWorktreeId: 'one',
      idempotencyKey: 'key',
    }),
};
it.each(operations)(
  '%s releases the key after a state-dependent refusal in staging',
  async (operation) => {
    const run = stagingRefusals[operation];
    if (!run) throw new Error(`Unknown boundary ${operation}`);
    const before = images();
    const reserve = jest.spyOn(host, 'reserve');
    const commits = jest.spyOn(host, 'commit');
    await expect(run()).rejects.toMatchObject({ reason: 'not-found' });
    const receipt = reserve.mock.calls[0]?.[0].receipt;
    if (!receipt) throw new Error('Expected a reservation');
    expect(await host.lookupReceipt(receipt)).toMatchObject({
      status: 'none',
    });
    // Released, not recovery-required: the retry is admitted and refused again.
    await expect(run()).rejects.toMatchObject({ reason: 'not-found' });
    expect(commits).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
  },
);

it.each(['core.worktree.update', 'core.worktree.reorder'])(
  '%s admits one of concurrent same-key attempts and decides once',
  async (operation) => {
    const testCase = boundary(operation);
    const commits = jest.spyOn(host, 'commit');
    const results = await Promise.allSettled(
      [0, 1, 2].map(() => testCase.run({ idempotencyKey: 'key' })),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).not.toHaveLength(0);
    for (const result of results) {
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ reason: 'in-progress' });
    }
    expect(commits).toHaveBeenCalledTimes(1);
    testCase.applied();
    expect(await testCase.run({ idempotencyKey: 'key' })).toEqual(
      testCase.outcome,
    );
    expect(commits).toHaveBeenCalledTimes(1);
  },
);

const noWriteCases: Record<string, () => Promise<unknown>> = {
  'core.workspace.update': () =>
    updateWorkspaceMetadata({
      workspaceId: 'a',
      source: 'portal',
      patch: {},
      idempotencyKey: 'key',
    }),
  'core.worktree.reorder': () =>
    moveWorktree({
      workspaceId: 'a',
      activeWorktreeId: 'one',
      overWorktreeId: 'one',
      idempotencyKey: 'key',
    }),
};
it.each(Object.keys(noWriteCases))(
  '%s: a keyed change that writes nothing decides its receipt alone and replays after a restart',
  async (operation) => {
    const run = noWriteCases[operation];
    if (!run) throw new Error(`Unknown boundary ${operation}`);
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    const first = await run();
    expect(commits).toHaveBeenCalledTimes(1);
    const [decision] = commits.mock.calls[0] ?? [];
    expect(decision?.files).toEqual([]);
    expect(decision?.receipt).toMatchObject({ operation });
    expect(decision?.outcome).toEqual(first ?? null);
    expect(images()).toEqual(before);
    await restartHost();
    const restarted = jest.spyOn(host, 'commit');
    expect(await run()).toEqual(first);
    expect(restarted).not.toHaveBeenCalled();
  },
);

/** A22(a): group membership is desktop-only and never part of the reorder. */
describe('core.worktree.reorder excludes group membership', () => {
  it.each([
    ['sidebarItemGroupId', 'grp-g1'],
    ['memberIds', ['three']],
    ['source', 'sidebar_item_groups'],
  ])(
    'refuses a %s field before its key is looked up or reserved, leaving the key free',
    async (field, value) => {
      const moveWithMembership = (): Promise<void> =>
        moveWorktree(
          untypedMove({
            workspaceId: 'a',
            activeWorktreeId: 'three',
            overWorktreeId: 'one',
            idempotencyKey: 'key',
            [field]: value,
          }),
        );
      const testCase = boundary('core.worktree.reorder');
      const before = images();
      const lookups = jest.spyOn(host, 'lookupReceipt');
      const reserve = jest.spyOn(host, 'reserve');
      const commits = jest.spyOn(host, 'commit');
      await expect(moveWithMembership()).rejects.toMatchObject({
        reason: 'invalid-patch',
      });
      expect(lookups).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
      expect(commits).not.toHaveBeenCalled();
      expect(images()).toEqual(before);

      expect(await testCase.run({ idempotencyKey: 'key' })).toEqual(
        testCase.outcome,
      );
      testCase.applied();
      expect(lookups).toHaveBeenCalled();
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(commits).toHaveBeenCalledTimes(1);
      const applied = images();

      // Still refused at admission after the decision, not replayed or key-reused.
      await expect(moveWithMembership()).rejects.toMatchObject({
        reason: 'invalid-patch',
      });
      await restartHost();
      const restarted = jest.spyOn(host, 'commit');
      await expect(moveWithMembership()).rejects.toMatchObject({
        reason: 'invalid-patch',
      });
      expect(await testCase.run({ idempotencyKey: 'key' })).toEqual(
        testCase.outcome,
      );
      expect(restarted).not.toHaveBeenCalled();
      expect(images()).toEqual(applied);
    },
  );

  // Receipts recorded before the closed schema must still replay.
  it('fingerprints only the move ids, as before the closed schema', async () => {
    const reserve = jest.spyOn(host, 'reserve');
    await moveWorktree({
      workspaceId: 'a',
      activeWorktreeId: 'three',
      overWorktreeId: 'one',
      expectedRevision: undefined,
      idempotencyKey: 'key',
    });
    expect(reserve.mock.calls[0]?.[0].receipt.fingerprint).toBe(
      createHash('sha256')
        .update(
          JSON.stringify({
            activeWorktreeId: 'three',
            overWorktreeId: 'one',
            workspaceId: 'a',
          }),
        )
        .digest('hex'),
    );
  });

  it('a sidebar group move stays an unkeyed list write with its sidecar committed first', async () => {
    const scope = { workspaceLocalId: 'a' };
    const group = await sidebarItemGroupsService.create({
      scope,
      itemId: 'one',
    });
    const reserve = jest.spyOn(host, 'reserve');
    const commit = host.commit.bind(host);
    const sidecarAtListDecision: string[] = [];
    const commits = jest
      .spyOn(host, 'commit')
      .mockImplementation(async (request) => {
        if (request.files.some((file) => file.path === listPath()))
          sidecarAtListDecision.push(readFileSync(sidecarPath(), 'utf8'));
        return commit(request);
      });

    await sidebarItemGroupsService.moveItem({
      scope,
      itemId: 'three',
      groupId: group.id,
    });

    expect(rowOrder()).toEqual(['one', 'three', 'two']);
    expect(reserve).not.toHaveBeenCalled();
    expect(
      commits.mock.calls.map(([request]) => [
        request.operation,
        request.receipt,
      ]),
    ).toEqual([['w5.worktree_list.write', undefined]]);
    expect(sidecarAtListDecision).toEqual([
      readFileSync(sidecarPath(), 'utf8'),
    ]);
    expect(sidecarAtListDecision[0]).toContain('"three"');
  });
});

it('core.worktree.update decides the group-ordered rows of a keyed worktreeOrder under manual sort', async () => {
  await updateWorkspaceWorktrees('a', (worktrees) => [...worktrees]);
  writeFileSync(
    sidecarPath(),
    JSON.stringify({
      version: 1,
      groups: [
        {
          id: 'grp-g1',
          name: 'G',
          color: 'neutral',
          collapsed: false,
          memberIds: ['one', 'three'],
        },
      ],
    }),
  );
  const commits = jest.spyOn(host, 'commit');
  const run = (): Promise<unknown> =>
    updateWorktree({
      workspaceId: 'a',
      worktreeId: 'two',
      patch: { label: 'keyed' },
      worktreeOrder: ['one', 'two', 'three'],
      idempotencyKey: 'key',
    });
  const first = await run();
  // The reconciler keeps the group together in the decided list.
  expect(rowOrder()).toEqual(['one', 'three', 'two']);
  expect(commits).toHaveBeenCalledTimes(1);
  expect(commits.mock.calls[0]?.[0].receipt).toBeDefined();
  const applied = images();
  await restartHost();
  const restarted = jest.spyOn(host, 'commit');
  expect(await run()).toEqual(first);
  expect(restarted).not.toHaveBeenCalled();
  expect(images()).toEqual(applied);
});

it('core.workspace.reorder releases the key when the index changes on disk before the decision', async () => {
  const repository = getWorkspaceIndexRepository();
  const update = repository.update.bind(repository);
  let armed = false;
  jest
    .spyOn(repository, 'update')
    .mockImplementation(async (...args: Parameters<typeof update>) => {
      const result = await update(...args);
      armed = true;
      return result;
    });
  const read = nodeW5FileStore.read.bind(nodeW5FileStore);
  // The first index read after staging is the decision's preflight.
  jest.spyOn(nodeW5FileStore, 'read').mockImplementation(async (path) => {
    if (armed && path === indexPath()) {
      armed = false;
      writeFileSync(indexPath(), `${readFileSync(indexPath(), 'utf8')}\n`);
    }
    return read(path);
  });
  const reserve = jest.spyOn(host, 'reserve');
  const commits = jest.spyOn(host, 'commit');
  const testCase = boundary('core.workspace.reorder');
  await expect(testCase.run({ idempotencyKey: 'key' })).rejects.toBeInstanceOf(
    W5FileWriteRefusedError,
  );
  expect(commits).not.toHaveBeenCalled();
  expect(workspaceOrder()).toEqual(['a', 'b', 'c']);
  const receipt = reserve.mock.calls[0]?.[0].receipt;
  if (!receipt) throw new Error('Expected a reservation');
  expect(await host.lookupReceipt(receipt)).toMatchObject({ status: 'none' });

  jest.restoreAllMocks();
  const retried = jest.spyOn(host, 'commit');
  expect(await testCase.run({ idempotencyKey: 'key' })).toEqual(
    testCase.outcome,
  );
  expect(retried).toHaveBeenCalledTimes(1);
  testCase.applied();
});

describe('an injected sidebar group afterWrite failure', () => {
  let afterWrites: number;
  let failures: number;
  beforeEach(() => {
    afterWrites = 0;
    failures = 1;
    setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
      Promise.resolve({
        rows: next,
        afterWrite: (): Promise<void> => {
          afterWrites += 1;
          if (failures === 0) return Promise.resolve();
          failures -= 1;
          return Promise.reject(new Error('sidecar write failed'));
        },
      }),
    );
  });

  const sidecarCases: Record<
    string,
    { noOp: () => Promise<unknown> } & Pick<
      BoundaryCase,
      'run' | 'outcome' | 'applied'
    >
  > = {
    'core.worktree.update': {
      ...boundary('core.worktree.update'),
      noOp: () =>
        updateWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          patch: { label: 'keyed' },
        }),
    },
    'core.worktree.reorder': {
      ...boundary('core.worktree.reorder'),
      noOp: () =>
        moveWorktree({
          workspaceId: 'a',
          activeWorktreeId: 'one',
          overWorktreeId: 'one',
        }),
    },
  };

  it.each(Object.keys(sidecarCases))(
    '%s reaches the first caller, records the invalidation and replays without rerunning hooks',
    async (operation) => {
      const testCase = sidecarCases[operation];
      if (!testCase) throw new Error(`Unknown boundary ${operation}`);
      const commits = jest.spyOn(host, 'commit');
      await expect(testCase.run({ idempotencyKey: 'key' })).rejects.toThrow(
        'sidecar write failed',
      );
      // The list decision applied; the sidecar recovery was scheduled, and
      // the after-commit publication did not run.
      testCase.applied();
      expect(commits).toHaveBeenCalledTimes(1);
      expect(commits.mock.calls[0]?.[0].receipt).toBeDefined();
      expect(afterWrites).toBe(1);
      expect(schedulePortalStructuralSync).toHaveBeenCalledTimes(1);
      expect(notifyPortalStructureChanged).not.toHaveBeenCalled();

      const applied = images();
      expect(await testCase.run({ idempotencyKey: 'key' })).toEqual(
        testCase.outcome,
      );
      expect(commits).toHaveBeenCalledTimes(1);
      expect(afterWrites).toBe(1);
      expect(schedulePortalStructuralSync).toHaveBeenCalledTimes(1);
      expect(notifyPortalStructureChanged).not.toHaveBeenCalled();
      expect(images()).toEqual(applied);

      // The recorded invalidation drains at the next list lock release.
      await testCase.noOp();
      expect(images()).toEqual(applied);
      expect(notifyPortalStructureChanged).toHaveBeenCalledTimes(1);
    },
  );
});

/** CAN-4384's E9, with the single decision's commit-scoped refusal. */
it('E9: a foreign write after the decision leaves a commit to recover, no reservation, and fences the list', async () => {
  const commit = host.commit.bind(host);
  let armed = true;
  jest.spyOn(host, 'commit').mockImplementation(async (request) => {
    if (
      armed &&
      request.operation === 'core.worktree.update' &&
      request.files.length > 0
    ) {
      armed = false;
      const list = listSchema.parse(
        JSON.parse(readFileSync(listPath(), 'utf8')),
      );
      writeFileSync(
        listPath(),
        JSON.stringify({
          ...list,
          worktrees: list.worktrees.map((row) =>
            row.id === 'two'
              ? { ...row, label: 'foreign-after-preflight' }
              : row,
          ),
        }),
      );
    }
    return commit(request);
  });
  const request = {
    workspaceId: 'a',
    worktreeId: 'one',
    patch: { label: 'mine' },
    idempotencyKey: 'c1',
  };
  const first = updateWorktree(request);
  await expect(first).rejects.toBeInstanceOf(W5CommitRefusedError);
  await expect(first).rejects.toMatchObject({ reason: 'recovery-required' });
  expect(label('one')).toBeUndefined();
  expect(label('two')).toBe('foreign-after-preflight');

  const retry = updateWorktree(request);
  await expect(retry).rejects.toBeInstanceOf(W5CommitRefusedError);
  await expect(retry).rejects.toMatchObject({
    reason: 'recovery-required',
    details: { commitId: ANY_NUMBER },
  });
  expect((await host.recoveryReport()).reservations ?? []).toEqual([]);

  const later = { workspaceId: 'a', worktreeId: 'three' };
  await expect(
    updateWorktree({ ...later, patch: { label: 'later' } }),
  ).rejects.toMatchObject({ reason: 'unapplied-change' });
  await restartHost();
  await expect(
    updateWorktree({ ...later, patch: { label: 'later2' } }),
  ).rejects.toMatchObject({ reason: 'unapplied-change' });
  expect((await host.recoveryReport()).reservations ?? []).toEqual([]);
  expect(label('one')).toBeUndefined();
  expect(label('three')).toBeUndefined();
});

describe('unkeyed byte parity', () => {
  // A manual-sort workspace with a group: a list write reorders the rows to
  // keep the group together and prunes `ghost` from the sidecar afterwards.
  beforeEach(async () => {
    // The first list write records random replica ids; later writes keep them.
    await updateWorkspaceWorktrees('a', (worktrees) => [...worktrees]);
    jest.clearAllMocks();
    writeFileSync(
      sidecarPath(),
      JSON.stringify({
        version: 1,
        groups: [
          {
            id: 'grp-g1',
            name: 'G',
            color: 'neutral',
            collapsed: false,
            memberIds: ['one', 'three', 'ghost'],
          },
        ],
      }),
    );
  });

  const parityCases: Record<
    string,
    { plain: () => Promise<unknown>; run: () => Promise<unknown> }
  > = {
    'core.workspace.update': {
      // The repository writes the boundary composes.
      plain: async () => {
        await updateWorkspaceConfig('a', (config): void => {
          config.itemSortMode = 'last-updated';
        });
        await getWorkspaceIndexRepository().update(({ entries }) => ({
          result: undefined,
          entries: entries.map((entry) =>
            entry.id === 'a' ? { ...entry, name: 'Edited' } : entry,
          ),
        }));
      },
      run: () =>
        updateWorkspaceMetadata({
          workspaceId: 'a',
          source: 'portal',
          patch: { name: '  Edited  ', itemSortMode: 'last-updated' },
        }),
    },
    'core.workspace.reorder': {
      plain: () =>
        getWorkspaceIndexRepository().update(({ entries }) => {
          const byId = new Map(entries.map((entry) => [entry.id, entry]));
          const next = ['c', 'a', 'b'].flatMap((id, order) => {
            const entry = byId.get(id);
            return entry ? [{ ...entry, order }] : [];
          });
          return { result: undefined, entries: next };
        }),
      run: () =>
        reorderWorkspaces({
          visibleWorkspaceIds: ['a', 'b', 'c'],
          activeWorkspaceId: 'c',
          overWorkspaceId: 'a',
        }),
    },
    'core.worktree.update': {
      plain: () =>
        updateWorkspaceWorktrees('a', (worktrees) =>
          worktrees.map((row) =>
            row.id === 'one' ? { ...row, label: 'Edited' } : row,
          ),
        ),
      run: () =>
        updateWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          patch: { label: 'Edited' },
        }),
    },
    'core.worktree.reorder': {
      plain: () =>
        updateWorkspaceWorktrees('a', (worktrees) =>
          ['three', 'one', 'two'].flatMap((id) =>
            worktrees.filter((row) => row.id === id),
          ),
        ),
      run: () =>
        moveWorktree({
          workspaceId: 'a',
          activeWorktreeId: 'three',
          overWorktreeId: 'one',
        }),
    },
  };

  it.each(operations)(
    '%s writes the bytes of its plain repository writes',
    async (operation) => {
      const testCase = parityCases[operation];
      if (!testCase) throw new Error(`Unknown boundary ${operation}`);
      const base = images();
      await testCase.plain();
      const plain = images();
      expect(plain).not.toEqual(base);
      restore(base);

      const commit = host.commit.bind(host);
      const sidecarAtListDecision: string[] = [];
      const commits = jest
        .spyOn(host, 'commit')
        .mockImplementation(async (request) => {
          if (request.files.some((file) => file.path === listPath()))
            sidecarAtListDecision.push(readFileSync(sidecarPath(), 'utf8'));
          return commit(request);
        });
      await testCase.run();
      expect(images()).toEqual(plain);
      expect(commits.mock.calls.map(([request]) => request.receipt)).toEqual(
        commits.mock.calls.map(() => undefined),
      );
      expect(
        commits.mock.calls.filter(([request]) => request.files.length > 0),
      ).toHaveLength(1);
      expect(commits.mock.calls[0]?.[0].operation).toBe(operation);
      if (operation.startsWith('core.worktree.')) {
        // The sidecar is written after the list decision.
        expect(sidecarAtListDecision).toEqual([base[sidecarPath()]]);
        expect(plain[sidecarPath()]).not.toBe(base[sidecarPath()]);
        expect(plain[sidecarPath()]).not.toContain('ghost');
      } else {
        expect(plain[sidecarPath()]).toBe(base[sidecarPath()]);
      }
    },
  );
});
