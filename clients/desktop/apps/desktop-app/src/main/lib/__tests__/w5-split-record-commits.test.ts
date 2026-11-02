// Record-seam evidence, deliberately runnable against the pre-port records.
// This is not the unmodified split lifecycle (whose background phase is detached).
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type { W5CommitRequest } from '@canopy/desktop-shared/node/w5-commit-log';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';

const mockEvents: unknown[] = [];
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(() => mockEvents.push('sync')),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(() => mockEvents.push('notify')),
}));
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  reserveSplitDestinationRecord,
  markSplitRecoveryRecord,
  promoteSplitDestinationRecord,
  recordSplitArchiveDestination,
  removeSplitDestinationRecord,
  removeSplitCreatedWorkspace,
} from '../split-temporary-workspace-records';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  createW5CommitLogFileStore,
  w5ResourceKey,
  W5RevisionConflictError,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { runKeyedW5Operation } from '../w5-keyed-operation';
import { commitW5BoundaryStep } from '../w5-composition-operation';

jest.setTimeout(60_000);
const OPERATION = 'core.workspace.composition.split';
const identity = {
  source: 'temporary_split' as const,
  workspaceId: 'a',
  worktreeId: 'reserved',
  createdAt: '2026-10-24T00:00:00.000Z',
};
let dir: string;
let root: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
let beforeWorkerCommit:
  | ((commit: W5CommitLogHost['commit']) => Promise<void>)
  | undefined;
function commitEvent(request: W5CommitRequest): unknown {
  return {
    operation: request.operation,
    files: request.files.map((file) => relative(root, file.path)),
    advance: request.advance.map(w5ResourceKey),
    ...(request.expectedRevisions?.length
      ? {
          expected: request.expectedRevisions.map(
            ({ resource, revision }) =>
              `${w5ResourceKey(resource)}@${revision}`,
          ),
        }
      : {}),
    ...(request.reservationId ? { reservation: true } : {}),
    ...(request.receipt ? { receipt: true } : {}),
  };
}
beforeEach(() => {
  ({ dir, root } = createW5BoundaryFixture(
    (createdAt) => {
      // Removal tombstones outlive the data root; each test needs a new incarnation.
      identity.createdAt = createdAt;
      return [];
    },
    ['other'],
  ));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  const commit = host.commit.bind(host);
  jest.spyOn(host, 'commit').mockImplementation(async (request) => {
    mockEvents.push(commitEvent(request));
    const before = beforeWorkerCommit;
    beforeWorkerCommit = undefined;
    await before?.(commit);
    return commit(request);
  });
  const reserve = host.reserve.bind(host);
  jest.spyOn(host, 'reserve').mockImplementation(async (input) => {
    mockEvents.push('reserve');
    return reserve(input);
  });
  const recovery = host.markReservationRecoveryRequired.bind(host);
  jest
    .spyOn(host, 'markReservationRecoveryRequired')
    .mockImplementation(async (...args) => {
      mockEvents.push('recovery-required');
      return recovery(...args);
    });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  beforeWorkerCommit = undefined;
  mockEvents.length = 0;
});
afterEach(async () => {
  await settleDetachedWork();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});
function images(): Record<string, string> {
  return Object.fromEntries(
    [
      'index.json',
      'a/workspace.json',
      'a/worktrees.json',
      'other/workspace.json',
      'other/worktrees.json',
    ].map((file) => [file, readFileSync(join(root, file), 'utf8')]),
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function worktreesImage(content: string): Record<string, unknown>[] {
  const image: unknown = JSON.parse(content);
  if (
    !isRecord(image) ||
    !Array.isArray(image.worktrees) ||
    !image.worktrees.every(isRecord)
  )
    throw new Error('Expected a worktrees image containing object rows');
  return image.worktrees;
}
it('worktreesImage preserves every JSON row field, including prototype-named keys', () => {
  const rows: unknown = JSON.parse(
    '[{"id":"reserved","createdAt":"now","branchName":"topic","replica":{"state":"recorded","future":[null,{"kept":true}]},"future":false,"__proto__":{"sentinel":"preserved"}}]',
  );
  expect(
    worktreesImage(JSON.stringify({ version: 1, worktrees: rows })),
  ).toStrictEqual(rows);
});
it.each([
  'not JSON',
  'null',
  '[]',
  '{}',
  '{"worktrees":null}',
  '{"worktrees":[null]}',
  '{"worktrees":[[]]}',
  '{"worktrees":[1]}',
])('worktreesImage rejects malformed images (%s)', (content) => {
  expect(() => worktreesImage(content)).toThrow();
});
function foreground(): Promise<{ accepted: boolean }> {
  return runKeyedW5Operation(
    {
      caller: 'test:split',
      operation: OPERATION,
      idempotencyKey: 'split',
      parameters: { workspaceId: 'a' },
      isPreEffectRefusal: () => false,
    },
    (outcome) => z.object({ accepted: z.boolean() }).parse(outcome),
    async (binding, attempt) => {
      const step = {
        operation: binding.operation,
        beforeDecision: binding.beforeDecision,
        expectedRevisions: [
          {
            resource: { kind: 'worktrees' as const, workspaceId: 'a' },
            revision: 0,
          },
        ],
      };
      await reserveSplitDestinationRecord(
        {
          source: identity.source,
          workspaceId: 'a',
          worktree: {
            id: identity.worktreeId,
            createdAt: identity.createdAt,
            branchName: 'topic',
            setupPhase: 'git-pending',
            splitRecoveryRequired: true,
          },
        },
        step,
      );
      attempt.beforeEffects();
      writeFileSync(join(dir, 'migrated-items'), 'split effect');
      mockEvents.push('items');
      const outcome = { accepted: true };
      return commitW5BoundaryStep(
        { ...binding, expectedRevisions: step.expectedRevisions, outcome },
        [],
        () => Promise.resolve(outcome),
      );
    },
  );
}
it('keeps reservation, foreground receipt and later background promotion as separate commits', async () => {
  const before = images();
  expect(await foreground()).toEqual({ accepted: true });
  expect(mockEvents).toEqual([
    'reserve',
    {
      operation: OPERATION,
      files: [join('a', 'worktrees.json')],
      advance: ['worktrees:a', 'worktree:a/reserved'],
      expected: ['worktrees:a@0'],
    },
    'sync',
    'notify',
    'items',
    {
      operation: OPERATION,
      files: [],
      advance: [],
      expected: ['worktrees:a@1'],
      reservation: true,
      receipt: true,
    },
  ]);
  const reserved = worktreesImage(images()['a/worktrees.json']);
  const replica = reserved[0].replica;
  const replicaId: unknown = expect.any(String);
  expect(replica).toMatchObject({
    state: 'recorded',
    repositories: [
      {
        authorityId: 'local-desktop',
        workspaceId: 'a',
        worktreeId: 'reserved',
        replicaId,
        branchName: { state: 'known', value: 'topic' },
      },
    ],
  });
  mockEvents.length = 0;
  expect(await foreground()).toEqual({ accepted: true });
  expect(mockEvents).toEqual([]);
  await promoteSplitDestinationRecord({ ...identity, branchName: 'moved' });
  expect(mockEvents).toEqual([
    {
      operation: 'w5.worktree_list.write',
      files: [join('a', 'worktrees.json')],
      advance: ['worktree:a/reserved'],
    },
    'sync',
    'notify',
  ]);
  const after = images();
  expect(after).toEqual({
    ...before,
    'a/worktrees.json': after['a/worktrees.json'],
  });
  expect(worktreesImage(after['a/worktrees.json'])).toEqual([
    {
      id: 'reserved',
      createdAt: identity.createdAt,
      branchName: 'moved',
      setupPhase: 'git-ready',
      replica,
    },
  ]);
  expect(
    await host.revision({
      kind: 'worktree',
      workspaceId: 'a',
      worktreeId: 'reserved',
    }),
  ).toBe(2);
});
it('post-effect receipt conflict preserves migrated items and reservation bytes and requires recovery', async () => {
  const before = images();
  let reserved: Record<string, string> | undefined;
  beforeWorkerCommit = (): Promise<void> => {
    beforeWorkerCommit = async (commit): Promise<void> => {
      reserved = images();
      await commit({
        operation: 'test.concurrent-edit',
        outcome: null,
        files: [],
        advance: [{ kind: 'worktrees', workspaceId: 'a' }],
      });
    };
    return Promise.resolve();
  };
  await expect(foreground()).rejects.toBeInstanceOf(W5RevisionConflictError);
  expect(readFileSync(join(dir, 'migrated-items'), 'utf8')).toBe(
    'split effect',
  );
  expect(images()).toEqual(reserved);
  expect(images()).toEqual({
    ...before,
    'a/worktrees.json': reserved?.['a/worktrees.json'],
  });
  expect(reserved?.['a/worktrees.json']).toContain('splitRecoveryRequired');
  expect(await host.revision({ kind: 'worktrees', workspaceId: 'a' })).toBe(2);
  expect(mockEvents.at(-1)).toBe('recovery-required');
  mockEvents.length = 0;
  await expect(foreground()).rejects.toMatchObject({
    reason: 'recovery-required',
  });
  expect(mockEvents).toEqual([]);
});
it('cleanup keeps row removal, index removal and host file deletion in order', async () => {
  await foreground();
  mockEvents.length = 0;
  await removeSplitDestinationRecord(identity);
  await expect(
    removeSplitCreatedWorkspace({
      source: identity.source,
      workspaceId: 'a',
      worktreeIds: [],
      containsRollbackData: () => {
        mockEvents.push('probe');
        return Promise.resolve(false);
      },
    }),
  ).resolves.toBe(true);
  expect(mockEvents).toEqual([
    {
      operation: 'w5.worktree_list.write',
      files: [join('a', 'worktrees.json')],
      advance: ['worktrees:a', 'worktree:a/reserved'],
    },
    'sync',
    'probe',
    {
      operation: 'w5.workspace_index.write',
      files: ['index.json', 'index.json.bak'],
      advance: ['workspaces', 'workspace:a'],
    },
    'sync',
    'notify',
  ]);
  expect(() => readFileSync(join(root, 'a/worktrees.json'))).toThrow();
  expect(readFileSync(join(root, 'index.json'), 'utf8')).toContain('other');
});

it.each([false, true])(
  'background recovery and archive keep their commits, publications and replica (reserved=%s)',
  async (reserved) => {
    if (reserved) await foreground();
    const before = images();
    const previous = worktreesImage(before['a/worktrees.json']);
    const healthIssue = {
      status: 'broken' as const,
      code: 'git-error' as const,
      message: 'rollback incomplete',
      checkedAt: identity.createdAt,
      worktreePath: join(dir, 'retained-checkout'),
      gitError: 'move failed',
    };
    const worktree = {
      id: identity.worktreeId,
      createdAt: identity.createdAt,
      branchName: 'topic',
      hidden: true,
      setupPhase: 'git-pending' as const,
      splitRecoveryRequired: true as const,
    };
    mockEvents.length = 0;
    await markSplitRecoveryRecord({
      ...identity,
      fallbackWorktree: worktree,
      healthIssue,
    });
    const recovered = worktreesImage(images()['a/worktrees.json']);
    const replica = recovered[0].replica;
    expect(replica).toBeDefined();
    if (reserved) expect(replica).toEqual(previous[0].replica);
    expect(recovered).toEqual([
      {
        id: identity.worktreeId,
        createdAt: identity.createdAt,
        branchName: 'topic',
        splitRecoveryRequired: true,
        healthIssue,
        replica,
      },
    ]);
    await recordSplitArchiveDestination({
      source: identity.source,
      workspaceId: identity.workspaceId,
      worktree: { ...worktree, branchName: 'surviving', status: 'done' },
    });
    expect(mockEvents).toEqual([
      {
        operation: 'w5.worktree_list.write',
        files: [join('a', 'worktrees.json')],
        advance: reserved
          ? ['worktree:a/reserved']
          : ['worktrees:a', 'worktree:a/reserved'],
      },
      'sync',
      'notify',
      {
        operation: 'w5.worktree_list.write',
        files: [join('a', 'worktrees.json')],
        advance: ['worktree:a/reserved'],
      },
      'sync',
      'notify',
    ]);
    const after = images();
    expect(after).toEqual({
      ...before,
      'a/worktrees.json': after['a/worktrees.json'],
    });
    expect(worktreesImage(after['a/worktrees.json'])).toEqual([
      {
        id: identity.worktreeId,
        createdAt: identity.createdAt,
        branchName: 'surviving',
        healthIssue,
        status: 'done',
        replica,
      },
    ]);
    expect(await host.revision({ kind: 'worktrees', workspaceId: 'a' })).toBe(
      1,
    );
    expect(
      await host.revision({
        kind: 'worktree',
        workspaceId: 'a',
        worktreeId: identity.worktreeId,
      }),
    ).toBe(reserved ? 3 : 2);
  },
);
