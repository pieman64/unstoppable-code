import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
// Real worker, filesystem and sidebar group reconciler. A foreign
// (out-of-process) write lands at the commit preflight of a keyed metadata
// command; the refusal must release the key (KA5, CAN-4384).
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
import { diagnoseW5State } from '../w5-maintenance-diagnosis';
import { updateWorktree, moveWorktree } from '../worktree-update';
import { reorderWorkspaces } from '../workspace-metadata';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { setBeforeProjectPluginDefaultsChangeHandler } from '../workspace-persistence';
import { initializeSidebarItemGroups } from '../../services/sidebar-item-groups-service';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;

const dataRoot = (): string => join(dir, 'data');
const listPath = (): string => join(root, 'a', 'worktrees.json');
const indexPath = (): string => join(root, 'index.json');
const manifestPath = (): string => join(root, 'a', 'workspace.json');
const sidecarPath = (): string => join(root, 'a', 'sidebar-item-groups.json');
const canonicalFiles = (): string[] => [
  indexPath(),
  manifestPath(),
  listPath(),
  ...['b', 'c'].flatMap((id) => [
    join(root, id, 'workspace.json'),
    join(root, id, 'worktrees.json'),
  ]),
];
function images(): Record<string, string> {
  return Object.fromEntries(
    [...canonicalFiles(), sidecarPath()].map((path) => [
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
const indexSchema = z.object({
  workspaces: z.array(z.object({ id: z.string(), name: z.string() })),
});
const rows = (): z.infer<typeof listSchema>['worktrees'] =>
  listSchema.parse(JSON.parse(readFileSync(listPath(), 'utf8'))).worktrees;
const rowOrder = (): string[] => rows().map((row) => row.id);
const label = (id: string): string | undefined =>
  rows().find((row) => row.id === id)?.label;
const indexEntries = (): { id: string; name: string }[] =>
  indexSchema.parse(JSON.parse(readFileSync(indexPath(), 'utf8'))).workspaces;

function startHost(): void {
  host = new W5CommitLogHost({
    dbPath: join(dataRoot(), 'w5', 'commit-log.sqlite'),
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

/**
 * A non-CAS writer changes `target` on its second read: the first read stages
 * the change and the second is the commit preflight, after staging and before
 * the canonical decision. Returns the bytes that writer left.
 */
function armPreflightForeignWrite(
  target: () => string,
  mutate: (raw: string) => string,
): { written: () => string | undefined } {
  const read = nodeW5FileStore.read.bind(nodeW5FileStore);
  let reads = 0;
  let written: string | undefined;
  const spy = jest
    .spyOn(nodeW5FileStore, 'read')
    .mockImplementation(async (path) => {
      if (path === target() && ++reads === 2) {
        written = mutate(readFileSync(path, 'utf8'));
        writeFileSync(path, written);
        spy.mockRestore();
      }
      return read(path);
    });
  return { written: () => written };
}
function foreignListLabel(raw: string): string {
  const parsed = listSchema.parse(JSON.parse(raw));
  return JSON.stringify({
    ...parsed,
    worktrees: parsed.worktrees.map((row) =>
      row.id === 'two' ? { ...row, label: 'foreign-cli-write' } : row,
    ),
  });
}

beforeAll(() => {
  initializeSidebarItemGroups();
});
beforeEach(() => {
  ({ dir, root } = createW5BoundaryFixture(
    (createdAt) => [
      { id: 'one', branchName: 'old', createdAt },
      { id: 'two', branchName: 'second', createdAt },
      { id: 'three', branchName: 'third', createdAt },
    ],
    ['b', 'c'],
  ));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataRoot();
  // `ghost` is no live row: any list write that reaches the reconciler's
  // post-application write prunes it, so an unchanged sidecar is evidence.
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

interface PreflightCase {
  readonly target: () => string;
  readonly mutate: (raw: string) => string;
  readonly setup?: () => void;
  readonly run: () => Promise<unknown>;
  readonly verify: () => void;
}
const preflightCases: Record<string, PreflightCase> = {
  'V1 keyed update': {
    target: listPath,
    mutate: foreignListLabel,
    run: () =>
      updateWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        patch: { label: 'mine' },
        idempotencyKey: 'k1',
      }),
    verify: () => {
      expect(label('one')).toBe('mine');
      expect(label('two')).toBe('foreign-cli-write');
    },
  },
  'V3 keyed move': {
    target: listPath,
    mutate: foreignListLabel,
    run: () =>
      moveWorktree({
        workspaceId: 'a',
        activeWorktreeId: 'two',
        overWorktreeId: 'one',
        idempotencyKey: 'm1',
      }),
    verify: () => {
      expect(rowOrder()).toEqual(['two', 'one', 'three']);
      expect(label('two')).toBe('foreign-cli-write');
    },
  },
  'keyed update with worktreeOrder': {
    target: listPath,
    mutate: foreignListLabel,
    run: () =>
      updateWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        patch: { label: 'ordered' },
        worktreeOrder: ['three', 'one', 'two'],
        idempotencyKey: 'o1',
      }),
    verify: () => {
      expect(rowOrder()).toEqual(['three', 'one', 'two']);
      expect(label('one')).toBe('ordered');
      expect(label('two')).toBe('foreign-cli-write');
    },
  },
  'V4 keyed reorderWorkspaces': {
    target: indexPath,
    mutate: (raw) => raw.replace('"name":"c"', '"name":"C-foreign"'),
    run: () =>
      reorderWorkspaces({
        workspaceOrder: ['c', 'b', 'a'],
        idempotencyKey: 'r1',
      }),
    verify: () => {
      expect(indexEntries().map((entry) => entry.id)).toEqual(['c', 'b', 'a']);
      expect(indexEntries()[0]?.name).toBe('C-foreign');
    },
  },
  'V4 keyed reorderWorkspaces move': {
    target: indexPath,
    mutate: (raw) => raw.replace('"name":"c"', '"name":"C-foreign"'),
    run: () =>
      reorderWorkspaces({
        visibleWorkspaceIds: ['a', 'b', 'c'],
        activeWorkspaceId: 'c',
        overWorkspaceId: 'a',
        idempotencyKey: 'r2',
      }),
    verify: () => {
      expect(indexEntries().map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
      expect(indexEntries()[0]?.name).toBe('C-foreign');
    },
  },
  'V5 keyed update with last-updated sort': {
    target: listPath,
    mutate: foreignListLabel,
    setup: () => {
      const manifest = z
        .object({})
        .passthrough()
        .parse(JSON.parse(readFileSync(manifestPath(), 'utf8')));
      writeFileSync(
        manifestPath(),
        JSON.stringify({ ...manifest, itemSortMode: 'last-updated' }),
      );
    },
    run: () =>
      updateWorktree({
        workspaceId: 'a',
        worktreeId: 'two',
        patch: { label: 'lu' },
        idempotencyKey: 'l1',
      }),
    verify: () => {
      expect(label('two')).toBe('lu');
      expect(rowOrder()).toEqual(['one', 'two', 'three']);
    },
  },
};

it.each(Object.keys(preflightCases))(
  '%s: a foreign write at preflight refuses without effects and releases the key',
  async (name) => {
    const testCase = preflightCases[name];
    if (!testCase) throw new Error(`Unknown case ${name}`);
    testCase.setup?.();
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    const foreign = armPreflightForeignWrite(testCase.target, testCase.mutate);

    const first = testCase.run();
    await expect(first).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    await expect(first).rejects.toMatchObject({
      reason: 'fingerprint-conflict',
    });
    const written = foreign.written();
    if (written === undefined) throw new Error('Foreign write did not run');
    // Only the foreign writer's bytes changed; the sidecar is untouched.
    expect(images()).toEqual({ ...before, [testCase.target()]: written });
    expect(commits).not.toHaveBeenCalled();

    await testCase.run();
    testCase.verify();
    if (testCase.target === listPath)
      expect(readFileSync(sidecarPath(), 'utf8')).not.toBe(
        before[sidecarPath()],
      );
  },
);

type KeyedCommand = 'workspace-reorder' | 'update' | 'move';
const keyedCommands: readonly KeyedCommand[] = [
  'workspace-reorder',
  'update',
  'move',
];
function runKeyed(kind: KeyedCommand): Promise<unknown> {
  switch (kind) {
    case 'workspace-reorder':
      return reorderWorkspaces({
        workspaceOrder: ['c', 'b', 'a'],
        idempotencyKey: 'key',
      });
    case 'update':
      return updateWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        patch: { label: 'Edited' },
        idempotencyKey: 'key',
      });
    case 'move':
      return moveWorktree({
        workspaceId: 'a',
        activeWorktreeId: 'two',
        overWorktreeId: 'one',
        idempotencyKey: 'key',
      });
  }
}

it.each(keyedCommands)(
  '%s replays the same key after a worker restart without another commit',
  async (kind) => {
    const first = await runKeyed(kind);
    const before = images();
    await restartHost();
    const commits = jest.spyOn(host, 'commit');
    expect(await runKeyed(kind)).toEqual(first);
    expect(commits).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
  },
);

it.each(keyedCommands)(
  '%s keeps an interrupted reservation recovery-required and diagnosable',
  async (kind) => {
    jest.spyOn(host, 'commit').mockImplementationOnce(async () => {
      await host.shutdown();
      throw new Error('interrupted at decision');
    });
    await expect(runKeyed(kind)).rejects.toThrow('interrupted at decision');
    await restartHost();
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    const retry = runKeyed(kind);
    await expect(retry).rejects.toBeInstanceOf(W5CommitRefusedError);
    await expect(retry).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(commits).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
    await host.shutdown();
    const diagnosis = await diagnoseW5State(dataRoot());
    expect(diagnosis.reservations).toEqual([
      expect.objectContaining({ state: 'recovery-required' }),
    ]);
  },
);
