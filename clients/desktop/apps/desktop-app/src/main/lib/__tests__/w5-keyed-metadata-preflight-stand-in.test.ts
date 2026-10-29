import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
// Real worker and filesystem with a stand-in group reconciler that simulates
// an out-of-process (non-CAS) writer under the list lock, after the in-lock
// read and before the commit preflight (CAN-4384).
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
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

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  W5FileWriteRefusedError,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { updateWorktree, moveWorktree } from '../worktree-update';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  setBeforeProjectPluginDefaultsChangeHandler,
  setWorktreeRegistryReconciler,
} from '../workspace-persistence';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
let injectForeignWrite = false;

const listPath = (): string => join(root, 'a', 'worktrees.json');
const sidecarPath = (): string => join(root, 'a', 'sidebar-item-groups.json');
function images(): Record<string, string> {
  return Object.fromEntries(
    [
      join(root, 'index.json'),
      join(root, 'a', 'workspace.json'),
      listPath(),
      sidecarPath(),
    ].map((path) => [
      path,
      existsSync(path) ? readFileSync(path, 'utf8') : '<absent>',
    ]),
  );
}
const listSchema = z
  .object({
    worktrees: z.array(
      z.object({ id: z.string(), label: z.string().optional() }).passthrough(),
    ),
  })
  .passthrough();
const rows = (): z.infer<typeof listSchema>['worktrees'] =>
  listSchema.parse(JSON.parse(readFileSync(listPath(), 'utf8'))).worktrees;
const label = (id: string): string | undefined =>
  rows().find((row) => row.id === id)?.label;
function writeForeignLabel(value: string): string {
  const list = listSchema.parse(JSON.parse(readFileSync(listPath(), 'utf8')));
  const raw = JSON.stringify({
    ...list,
    worktrees: list.worktrees.map((row) =>
      row.id === 'two' ? { ...row, label: value } : row,
    ),
  });
  writeFileSync(listPath(), raw);
  return raw;
}
let foreignBytes: string | undefined;

function startHost(): void {
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
}

beforeAll(() => {
  setWorktreeRegistryReconciler((_workspaceId, _current, next) => {
    if (injectForeignWrite) {
      injectForeignWrite = false;
      foreignBytes = writeForeignLabel('foreign-cli-write');
    }
    return Promise.resolve({ rows: next });
  });
});
beforeEach(() => {
  ({ dir, root } = createW5BoundaryFixture((createdAt) => [
    { id: 'one', branchName: 'old', createdAt },
    { id: 'two', branchName: 'second', createdAt },
    { id: 'three', branchName: 'third', createdAt },
  ]));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  startHost();
  injectForeignWrite = false;
  foreignBytes = undefined;
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

const preflightCases: Record<
  string,
  { run: () => Promise<unknown>; verify: () => void }
> = {
  'E1 keyed label update': {
    run: () =>
      updateWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        patch: { label: 'mine' },
        idempotencyKey: 'k1',
      }),
    verify: () => expect(label('one')).toBe('mine'),
  },
  'E3 keyed move that changes order': {
    run: () =>
      moveWorktree({
        workspaceId: 'a',
        activeWorktreeId: 'three',
        overWorktreeId: 'one',
        idempotencyKey: 'm1',
      }),
    verify: () =>
      expect(rows().map((row) => row.id)).toEqual(['three', 'one', 'two']),
  },
  'E1o keyed update with a worktreeOrder that changes order': {
    run: () =>
      updateWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        patch: { label: 'ordered' },
        worktreeOrder: ['three', 'one', 'two'],
        idempotencyKey: 'o1',
      }),
    verify: () => {
      expect(rows().map((row) => row.id)).toEqual(['three', 'one', 'two']);
      expect(label('one')).toBe('ordered');
    },
  },
};

it.each(Object.keys(preflightCases))(
  '%s: a foreign write before preflight refuses without effects and releases the key',
  async (name) => {
    const testCase = preflightCases[name];
    if (!testCase) throw new Error(`Unknown case ${name}`);
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    injectForeignWrite = true;

    const first = testCase.run();
    await expect(first).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    await expect(first).rejects.toMatchObject({
      reason: 'fingerprint-conflict',
    });
    if (foreignBytes === undefined)
      throw new Error('Foreign write did not run');
    expect(images()).toEqual({ ...before, [listPath()]: foreignBytes });
    expect(commits).not.toHaveBeenCalled();

    await testCase.run();
    testCase.verify();
    expect(label('two')).toBe('foreign-cli-write');
  },
);

it('E9: a foreign write after the decision still requires recovery and fences the list', async () => {
  const commit = host.commit.bind(host);
  let armed = true;
  jest.spyOn(host, 'commit').mockImplementation(async (request) => {
    if (
      armed &&
      request.operation === 'core.worktree.update' &&
      request.files.length > 0
    ) {
      armed = false;
      writeForeignLabel('foreign-after-preflight');
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

  await expect(updateWorktree(request)).rejects.toMatchObject({
    reason: 'recovery-required',
  });
  const later = { workspaceId: 'a', worktreeId: 'three' };
  await expect(
    updateWorktree({ ...later, patch: { label: 'later' } }),
  ).rejects.toMatchObject({ reason: 'unapplied-change' });
  await host.shutdown();
  startHost();
  await expect(
    updateWorktree({ ...later, patch: { label: 'later2' } }),
  ).rejects.toMatchObject({ reason: 'unapplied-change' });
  expect(label('one')).toBeUndefined();
  expect(label('three')).toBeUndefined();
});
