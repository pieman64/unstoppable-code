// CAN-5527 (W5d2 O-7): `portal.worktree.update` and `portal.worktree.reorder`
// write through the unkeyed `updateWorktree` and `moveWorktree` boundaries,
// keeping the Portal's codes, messages, broadcasts, golden bytes, labels and
// revisions. Real commit-log worker, filesystem and adapters, over both the
// in-process and the daemon-backed W5 store.
import { createW5BoundaryFixture } from '../../../lib/__tests__/fixtures/w5-boundary-fixture';
import { shutdownW5BoundaryHost } from '../../../lib/__tests__/fixtures/w5-boundary-host';
import {
  installW5StoreSide,
  W5_STORE_SIDES,
} from '../../../lib/__tests__/fixtures/w5-store-sides';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import type { W5Resource } from '@canopy/desktop-shared/node/w5-commit-log';
import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type PortalCommandEnvelope,
} from '@canopy/desktop-shared/types';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type * as TsxWorkerThreads from '../../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as CoreStorage from '@canopy/core-runtime/storage';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
// W6g: the daemon side marks the W5 namespaces daemon-owned.
jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof CoreStorage>(
    '@canopy/core-runtime/storage',
  );
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
jest.mock('../../../agents/session-manager', () => ({
  getLiveBackgroundTasksForChat: jest.fn(),
  listLiveBackgroundTaskOwners: jest.fn(() => []),
}));
jest.mock('../../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: jest.fn(() => Promise.resolve()),
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal-event-bus', () => ({
  ...jest.requireActual<object>('../../portal-event-bus'),
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../../../lib/desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));
jest.mock('../../../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

import { W5CommitLogHost } from '../../../w5-commit-log/commit-log-host';
import { __setDesktopW5FileStoreForTests } from '../../../lib/w5-commit-log-file-store';
import { nodeW5FileStore } from '../../../lib/w5-file-store';
import { updateWorkspaceWorktrees } from '../../../lib/workspace-persistence';
import { READ_ONLY_SCOPE_ERROR } from '../../../lib/read-only-scope';
import { sendToWindow } from '../../../lib/window-send';
import { notifyPortalStructureChanged } from '../../portal-event-bus';
import type { PortalAdapterContext } from '../types';
import {
  handlePortalWorktreeReorder,
  handlePortalWorktreeUpdate,
} from '../worktree-adapter';

jest.setTimeout(90_000);
let dir: string;
let root: string;
let dbPath: string;
let host: W5CommitLogHost;
let createdAt: string;
let originalDataDir: string | undefined;

const BRANCHES: Record<string, string> = {
  one: 'first',
  two: 'second',
  three: 'third',
  four: 'fourth',
};
const listPath = (): string => join(root, 'a', 'worktrees.json');
function images(): Record<string, string> {
  return Object.fromEntries(
    [
      join(root, 'index.json'),
      join(root, 'a', 'workspace.json'),
      listPath(),
    ].map((path) => [
      path,
      existsSync(path) ? readFileSync(path, 'utf8') : '<absent>',
    ]),
  );
}
const replicaListSchema = z.object({
  worktrees: z.array(z.object({ id: z.string(), replica: z.unknown() })),
});
let replicas: Map<string, unknown>;
/** The exact list bytes: each row's own fields in order, then its replica. */
function goldenList(
  rows: ReadonlyArray<{ id: string; fields?: Record<string, unknown> }>,
): string {
  return JSON.stringify(
    {
      version: 1,
      worktrees: rows.map(({ id, fields }) => ({
        id,
        branchName: BRANCHES[id],
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
  four: { kind: 'worktree', workspaceId: 'a', worktreeId: 'four' },
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
/** Revisions after `beforeEach`'s replica-recording write. */
const SEEDED = { list: 0, one: 1, two: 1, three: 1, four: 1 };

type Outcome =
  | { kind: 'completed'; result: unknown }
  | { kind: 'failed'; code: string; message: string; retryable?: boolean };
let outcomes: Outcome[];
const context: PortalAdapterContext = {
  getWindow: () => null,
  enqueueEvent: () => undefined,
  complete: (_command, result) => {
    outcomes.push({ kind: 'completed', result });
  },
  fail: (_command, code, message, retryable) => {
    outcomes.push({
      kind: 'failed',
      code,
      message,
      ...(retryable === undefined ? {} : { retryable }),
    });
  },
};
function command(
  type: 'portal.worktree.update' | 'portal.worktree.reorder',
  payload: Record<string, unknown>,
): PortalCommandEnvelope<unknown> {
  return {
    id: 'cmd-1',
    sequence: 1,
    type,
    payload,
    createdAt: '2026-07-10T00:00:00.000Z',
    expiresAt: null,
  };
}
const update = (payload: Record<string, unknown>): Promise<void> =>
  handlePortalWorktreeUpdate(
    command('portal.worktree.update', { workspaceId: 'a', ...payload }),
    context,
  );
const reorder = (payload: Record<string, unknown>): Promise<void> =>
  handlePortalWorktreeReorder(
    command('portal.worktree.reorder', { workspaceId: 'a', ...payload }),
    context,
  );
const listCommits = (commits: jest.SpyInstance): unknown[] =>
  commits.mock.calls
    .filter(([request]: Parameters<W5CommitLogHost['commit']>) =>
      request.files.some((file) => file.path === listPath()),
    )
    .map(([request]: Parameters<W5CommitLogHost['commit']>) => [
      request.operation,
      request.receipt,
      request.expectedRevisions,
    ]);
/** The persisted rows, replicas included, as the Portal broadcasts them. */
function persistedRows(): Array<Record<string, unknown>> {
  return z
    .object({ worktrees: z.array(z.record(z.string(), z.unknown())) })
    .parse(JSON.parse(readFileSync(listPath(), 'utf8'))).worktrees;
}

let teardownStoreSide = (): Promise<void> => Promise.resolve();

async function seed(side: (typeof W5_STORE_SIDES)[number]): Promise<void> {
  ({ dir, root } = createW5BoundaryFixture((incarnation) => {
    createdAt = incarnation;
    return [
      { id: 'one', branchName: 'first', createdAt, label: 'Old label' },
      { id: 'two', branchName: 'second', createdAt, hidden: true },
      { id: 'three', branchName: 'third', createdAt },
      { id: 'four', branchName: 'fourth', createdAt },
    ];
  }));
  dbPath = join(dir, 'data', 'w5', 'commit-log.sqlite');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  host = new W5CommitLogHost({
    dbPath,
    root,
    workerEntry: join(__dirname, '../../../w5-commit-log/commit-log-worker.ts'),
  });
  teardownStoreSide = await installW5StoreSide(side, {
    host,
    root,
    setDaemonOwned: setDaemonOwnedForTest,
  });
  // The first list write records the rows' replica ids; later writes keep them.
  await updateWorkspaceWorktrees('a', (worktrees) => [...worktrees]);
  replicas = new Map(
    replicaListSchema
      .parse(JSON.parse(readFileSync(listPath(), 'utf8')))
      .worktrees.map((row) => [row.id, row.replica]),
  );
  outcomes = [];
  jest.clearAllMocks();
}
afterEach(async () => {
  jest.restoreAllMocks();
  await settleDetachedWork();
  await teardownStoreSide();
  teardownStoreSide = (): Promise<void> => Promise.resolve();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await shutdownW5BoundaryHost(host, dbPath);
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe.each(W5_STORE_SIDES)('over the %s store', (side) => {
  beforeEach(() => seed(side));

  describe('portal.worktree.update through updateWorktree', () => {
    it.each<
      [
        string,
        Record<string, unknown>,
        string,
        Record<string, unknown>,
        Record<string, number>,
      ]
    >([
      [
        'trims a label and hides',
        { worktreeId: 'three', label: '  My  label  ', hidden: true },
        'three',
        { label: 'My  label', hidden: true },
        { ...SEEDED, three: 2 },
      ],
      [
        'replaces a label',
        { worktreeId: 'one', label: 'New' },
        'one',
        { label: 'New' },
        { ...SEEDED, one: 2 },
      ],
      [
        'clears a null label',
        { worktreeId: 'one', label: null },
        'one',
        {},
        { ...SEEDED, one: 2 },
      ],
      [
        'clears an empty label',
        { worktreeId: 'one', label: '' },
        'one',
        {},
        { ...SEEDED, one: 2 },
      ],
      [
        'clears a blank label',
        { worktreeId: 'one', label: ' \t\n ' },
        'one',
        {},
        { ...SEEDED, one: 2 },
      ],
      [
        'labels a hidden row, keeping the omitted flag',
        { worktreeId: 'two', label: 'Named' },
        'two',
        { hidden: true, label: 'Named' },
        { ...SEEDED, two: 2 },
      ],
      [
        'hides a labelled row, keeping the omitted label',
        { worktreeId: 'one', hidden: true },
        'one',
        { label: 'Old label', hidden: true },
        { ...SEEDED, one: 2 },
      ],
      [
        'unhides, deleting the flag',
        { worktreeId: 'two', hidden: false },
        'two',
        {},
        { ...SEEDED, two: 2 },
      ],
    ])(
      '%s with golden bytes, revisions and broadcast',
      async (_name, payload, id, fields, expectedRevisions) => {
        const commits = jest.spyOn(host, 'commit');
        await update(payload);

        expect(outcomes).toEqual([
          { kind: 'completed', result: { success: true } },
        ]);
        const rows = [
          { id: 'one', fields: { label: 'Old label' } },
          { id: 'two', fields: { hidden: true } },
          { id: 'three' },
          { id: 'four' },
        ].map((row) => (row.id === id ? { id, fields } : row));
        expect(readFileSync(listPath(), 'utf8')).toBe(goldenList(rows));
        expect(await revisions()).toEqual(expectedRevisions);
        expect(listCommits(commits)).toEqual([
          ['core.worktree.update', undefined, undefined],
        ]);
        const row = persistedRows().find((worktree) => worktree.id === id);
        expect(jest.mocked(sendToWindow).mock.calls).toEqual([
          [
            null,
            IPC_CHANNELS.workspaceWorktreesUpdated,
            { workspaceId: 'a', worktree: row },
          ],
        ]);
        expect(notifyPortalStructureChanged).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      [
        'a label that matches after trimming',
        { worktreeId: 'one', label: ' Old label ' },
        'one',
      ],
      [
        'clearing an absent label',
        { worktreeId: 'three', label: '  ' },
        'three',
      ],
      ['hiding a hidden row', { worktreeId: 'two', hidden: true }, 'two'],
      ['unhiding a visible row', { worktreeId: 'four', hidden: false }, 'four'],
    ])(
      'completes %s without a write and broadcasts the stored row',
      async (_name, payload, id) => {
        const before = images();
        const commits = jest.spyOn(host, 'commit');
        await update(payload);

        expect(outcomes).toEqual([
          { kind: 'completed', result: { success: true } },
        ]);
        expect(images()).toEqual(before);
        expect(await revisions()).toEqual(SEEDED);
        expect(listCommits(commits)).toEqual([]);
        expect(notifyPortalStructureChanged).not.toHaveBeenCalled();
        expect(jest.mocked(sendToWindow).mock.calls).toEqual([
          [
            null,
            IPC_CHANNELS.workspaceWorktreesUpdated,
            {
              workspaceId: 'a',
              worktree: persistedRows().find((worktree) => worktree.id === id),
            },
          ],
        ]);
      },
    );

    it('keeps not_found and its message for a missing row, writing nothing', async () => {
      const before = images();
      await update({ worktreeId: 'missing', hidden: true });

      expect(outcomes).toEqual([
        {
          kind: 'failed',
          code: 'not_found',
          message: 'Worktree to update was not found.',
        },
      ]);
      expect(images()).toEqual(before);
      expect(await revisions()).toEqual(SEEDED);
      expect(sendToWindow).not.toHaveBeenCalled();
    });

    it('refuses the read-only shared-container scope as forbidden', async () => {
      await handlePortalWorktreeUpdate(
        command('portal.worktree.update', {
          workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          worktreeId: 'one',
          hidden: true,
        }),
        context,
      );

      expect(outcomes).toEqual([
        {
          kind: 'failed',
          code: 'forbidden',
          message: READ_ONLY_SCOPE_ERROR,
          retryable: false,
        },
      ]);
      expect(sendToWindow).not.toHaveBeenCalled();
    });

    it('keeps the Portal payload checks ahead of the boundary', async () => {
      const before = images();
      await update({ worktreeId: 'one', label: 'Keep', pinned: true });
      await update({ worktreeId: 'one' });

      // Fields outside the Portal command are ignored, not refused.
      expect(outcomes).toEqual([
        { kind: 'completed', result: { success: true } },
        {
          kind: 'failed',
          code: 'invalid_payload',
          message:
            'Worktree update requires a string/null label and/or a boolean hidden value.',
        },
      ]);
      expect(readFileSync(listPath(), 'utf8')).toBe(
        goldenList([
          { id: 'one', fields: { label: 'Keep' } },
          { id: 'two', fields: { hidden: true } },
          { id: 'three' },
          { id: 'four' },
        ]),
      );
      expect(images()[join(root, 'index.json')]).toBe(
        before[join(root, 'index.json')],
      );
    });
  });

  describe('portal.worktree.reorder through moveWorktree', () => {
    it('moves a visible row, keeps the hidden slot, and broadcasts the list', async () => {
      const commits = jest.spyOn(host, 'commit');
      await reorder({ activeWorktreeId: 'four', overWorktreeId: 'one' });

      expect(outcomes).toEqual([
        {
          kind: 'completed',
          result: {
            workspaceId: 'a',
            activeWorktreeId: 'four',
            overWorktreeId: 'one',
          },
        },
      ]);
      expect(readFileSync(listPath(), 'utf8')).toBe(
        goldenList([
          { id: 'four' },
          { id: 'two', fields: { hidden: true } },
          { id: 'one', fields: { label: 'Old label' } },
          { id: 'three' },
        ]),
      );
      // Order is the list's; no row's fields changed.
      expect(await revisions()).toEqual({ ...SEEDED, list: 1 });
      expect(listCommits(commits)).toEqual([
        ['core.worktree.reorder', undefined, undefined],
      ]);
      expect(jest.mocked(sendToWindow).mock.calls).toEqual([
        [
          null,
          IPC_CHANNELS.workspaceWorktreesUpdated,
          { workspaceId: 'a', worktrees: persistedRows() },
        ],
      ]);
      expect(notifyPortalStructureChanged).toHaveBeenCalledTimes(1);
    });

    it('moves a row down past the hidden slot', async () => {
      await reorder({ activeWorktreeId: 'one', overWorktreeId: 'three' });

      expect(outcomes).toEqual([
        {
          kind: 'completed',
          result: {
            workspaceId: 'a',
            activeWorktreeId: 'one',
            overWorktreeId: 'three',
          },
        },
      ]);
      expect(readFileSync(listPath(), 'utf8')).toBe(
        goldenList([
          { id: 'three' },
          { id: 'two', fields: { hidden: true } },
          { id: 'one', fields: { label: 'Old label' } },
          { id: 'four' },
        ]),
      );
      expect(await revisions()).toEqual({ ...SEEDED, list: 1 });
    });

    it('completes a move onto itself without a write', async () => {
      const before = images();
      const commits = jest.spyOn(host, 'commit');
      await reorder({ activeWorktreeId: 'three', overWorktreeId: 'three' });

      expect(outcomes).toEqual([
        {
          kind: 'completed',
          result: {
            workspaceId: 'a',
            activeWorktreeId: 'three',
            overWorktreeId: 'three',
          },
        },
      ]);
      expect(images()).toEqual(before);
      expect(await revisions()).toEqual(SEEDED);
      expect(listCommits(commits)).toEqual([]);
      expect(notifyPortalStructureChanged).not.toHaveBeenCalled();
      expect(jest.mocked(sendToWindow).mock.calls).toEqual([
        [
          null,
          IPC_CHANNELS.workspaceWorktreesUpdated,
          { workspaceId: 'a', worktrees: persistedRows() },
        ],
      ]);
    });

    it.each([
      [
        'a hidden active row',
        { activeWorktreeId: 'two', overWorktreeId: 'one' },
      ],
      [
        'a hidden target row',
        { activeWorktreeId: 'one', overWorktreeId: 'two' },
      ],
      ['a missing row', { activeWorktreeId: 'missing', overWorktreeId: 'one' }],
    ])(
      'keeps not_found and its message for %s, writing nothing',
      async (_name, payload) => {
        const before = images();
        await reorder(payload);

        expect(outcomes).toEqual([
          {
            kind: 'failed',
            code: 'not_found',
            message: 'Worktree to reorder was not found.',
          },
        ]);
        expect(images()).toEqual(before);
        expect(await revisions()).toEqual(SEEDED);
        expect(sendToWindow).not.toHaveBeenCalled();
      },
    );

    it('keeps refusing a cowork project before the boundary', async () => {
      writeFileSync(
        join(root, 'a', 'workspace.json'),
        JSON.stringify({ version: 1, type: 'cowork', repos: [] }),
      );
      const before = images();
      await reorder({ activeWorktreeId: 'four', overWorktreeId: 'one' });

      expect(outcomes).toEqual([
        {
          kind: 'failed',
          code: 'not_found',
          message: 'Project to reorder was not found.',
        },
      ]);
      expect(images()).toEqual(before);
    });

    it('refuses the read-only shared-container scope as forbidden', async () => {
      await handlePortalWorktreeReorder(
        command('portal.worktree.reorder', {
          workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          activeWorktreeId: 'four',
          overWorktreeId: 'one',
        }),
        context,
      );

      expect(outcomes).toEqual([
        {
          kind: 'failed',
          code: 'forbidden',
          message: READ_ONLY_SCOPE_ERROR,
          retryable: false,
        },
      ]);
      expect(sendToWindow).not.toHaveBeenCalled();
    });
  });
});
