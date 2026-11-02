// W6e2: record-seam evidence on the real worker, not unmodified lifecycle evidence.
// These observable commit/effect expectations also run against the pre-port
// fork-metadata module; decision routing is asserted in the fake-port suite.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ProjectStartPage } from '@canopy/protocol/start-page';
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
  hideSharedContainerForkWorkspace,
  recordSharedContainerForkStartPage,
} from '../../shared-containers/fork/fork-metadata';
import { deleteForkWorkspaceOrHide } from '../../shared-containers/fork/rollback';
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
import { getWorkspaceType } from '../workspace-registry';

jest.setTimeout(60_000);
const OPERATION = 'core.sharedContainer.fork';
let dir: string;
let root: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
let beforeWorkerCommit:
  | ((commit: W5CommitLogHost['commit']) => Promise<void>)
  | undefined;
const START_PAGE = { kind: 'url' as const, url: 'https://example.test' };

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
  ({ dir, root } = createW5BoundaryFixture(() => [], ['other']));
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
function keyedRecord(): Promise<{
  workspaceId: string;
  startPage: ProjectStartPage;
}> {
  return runKeyedW5Operation(
    {
      caller: 'test:fork',
      operation: OPERATION,
      idempotencyKey: 'metadata',
      parameters: { workspaceId: 'a' },
      isPreEffectRefusal: () => false,
    },
    (outcome) =>
      outcome as { workspaceId: string; startPage: ProjectStartPage },
    async (binding, attempt) => {
      attempt.beforeEffects();
      writeFileSync(join(dir, 'copied-file'), 'fork effect');
      mockEvents.push('files');
      const step = {
        operation: binding.operation,
        beforeDecision: binding.beforeDecision,
        expectedRevisions: [
          {
            resource: { kind: 'workspace' as const, workspaceId: 'a' },
            revision: 0,
          },
        ],
      };
      const result = await recordSharedContainerForkStartPage(
        { source: 'code_fork', workspaceId: 'a', startPage: START_PAGE },
        step,
      );
      return commitW5BoundaryStep(
        {
          ...binding,
          expectedRevisions: step.expectedRevisions,
          outcome: result,
        },
        [],
        () => Promise.resolve(result),
      );
    },
  );
}
it('keeps manifest publication then the final receipt-only commit, and replay writes nothing', async () => {
  const before = images();
  const result = await keyedRecord();
  expect(mockEvents).toEqual([
    'reserve',
    'files',
    {
      operation: OPERATION,
      files: ['a/workspace.json'],
      advance: ['workspace:a'],
      expected: ['workspace:a@0'],
    },
    {
      operation: OPERATION,
      files: [],
      advance: [],
      expected: ['workspace:a@1'],
      reservation: true,
      receipt: true,
    },
  ]);
  const after = images();
  expect(after).toEqual({
    ...before,
    'a/workspace.json': after['a/workspace.json'],
  });
  expect(after['a/workspace.json']).toContain(START_PAGE.url);
  expect(await host.revision({ kind: 'workspace', workspaceId: 'a' })).toBe(1);
  mockEvents.length = 0;
  expect(await keyedRecord()).toEqual(result);
  expect(mockEvents).toEqual([]);
});
it.each(['manifest', 'receipt'] as const)(
  'post-effect %s conflict preserves effects and retains recovery-required',
  async (conflictAt) => {
    const before = images();
    let published: Record<string, string> | undefined;
    const conflict = async (
      commit: W5CommitLogHost['commit'],
    ): Promise<void> => {
      published = images();
      await commit({
        operation: 'test.concurrent-edit',
        outcome: null,
        files: [],
        advance: [{ kind: 'workspace', workspaceId: 'a' }],
      });
    };
    beforeWorkerCommit =
      conflictAt === 'manifest'
        ? conflict
        : (): Promise<void> => {
            beforeWorkerCommit = conflict;
            return Promise.resolve();
          };
    await expect(keyedRecord()).rejects.toBeInstanceOf(W5RevisionConflictError);
    expect(readFileSync(join(dir, 'copied-file'), 'utf8')).toBe('fork effect');
    expect(images()).toEqual(published);
    if (conflictAt === 'manifest') {
      expect(images()).toEqual(before);
    } else {
      expect(images()).toEqual({
        ...before,
        'a/workspace.json': published?.['a/workspace.json'],
      });
      expect(published?.['a/workspace.json']).toContain(START_PAGE.url);
    }
    expect(await host.revision({ kind: 'workspace', workspaceId: 'a' })).toBe(
      conflictAt === 'manifest' ? 1 : 2,
    );
    expect(mockEvents.at(-1)).toBe('recovery-required');
    mockEvents.length = 0;
    await expect(keyedRecord()).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect(mockEvents).toEqual([]);
  },
);
it.each(['code_fork', 'cowork_fork'] as const)(
  'fallback hide (%s) commits only the index and leaves files for recovery',
  async (source) => {
    const before = images();
    const deletion = new Error('delete failed');
    await expect(
      deleteForkWorkspaceOrHide({ source, workspaceId: 'a' }, () =>
        Promise.reject(deletion),
      ),
    ).rejects.toBe(deletion);
    expect(mockEvents).toEqual([
      {
        operation: 'w5.workspace_index.write',
        files: ['index.json', 'index.json.bak'],
        advance: ['workspaces', 'workspace:a'],
      },
      'sync',
      'notify',
    ]);
    const after = images();
    expect(after).toEqual({ ...before, 'index.json': after['index.json'] });
    expect(getWorkspaceType('a')).toBeNull();
    expect(await host.revision({ kind: 'workspaces' })).toBe(1);
    expect(await host.revision({ kind: 'workspace', workspaceId: 'a' })).toBe(
      1,
    );
    mockEvents.length = 0;
    await expect(
      hideSharedContainerForkWorkspace({ source, workspaceId: 'a' }),
    ).resolves.toEqual({ status: 'not-found' });
    expect(mockEvents).toEqual([]);
  },
);
