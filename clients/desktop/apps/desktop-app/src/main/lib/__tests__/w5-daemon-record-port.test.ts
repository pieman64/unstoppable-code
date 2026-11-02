// W6g (CAN-5498): Electron main's W5 store over the daemon record port, on a
// real commit-log worker and real files. The daemon side is the core-runtime
// authority served through the daemon control-stream code.
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as CoreStorage from '@canopy/core-runtime/storage';
import type { W5CommitLogHostPort } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import type { W5Resource } from '@canopy/desktop-shared/node/w5-commit-log';
import type { CoreWorkspaceRecordsCommitParams } from '@canopy/protocol/canopy-core';
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
  // Same array every checked writer reads, the authority's included.
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

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { startW5DaemonRecordHarness } from './fixtures/w5-daemon-record-harness';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  __setDesktopW5FileStoreForTests,
  createW5CommitLogFileStore,
  readW5Revisions,
  W5FileWriteRefusedError,
} from '../w5-commit-log-file-store';
import {
  createW5DaemonRecordStore,
  installW5DaemonRecordStoreForTests,
  w5RecordPortTransport,
  type W5RecordPortClient,
} from '../w5-daemon-record-store';
import { nodeW5FileStore } from '../w5-file-store';
import { w5ConflictCounts } from '../w5-pre-effect-retry';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  getWorkspaceWorktreeCreatedAt,
  isWorkspaceWorktreeCurrent,
  markWorkspaceWorktreeRecentlyRemoved,
  readWorkspaceWorktrees,
  readWorkspaceWorktreesDetailed,
  setWorktreeRegistryReconciler,
  updateWorkspaceWorktrees,
} from '../workspace-persistence';
import { applyWorktreeRowDecision } from '../worktree-record-decision-port';

jest.setTimeout(60_000);

const W5_NAMESPACES = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
];
const WORKER = join(__dirname, '../../w5-commit-log/commit-log-worker.ts');

let dir: string;
let root: string;
let host: W5CommitLogHost;
let harness: Awaited<ReturnType<typeof startW5DaemonRecordHarness>>;
let restore: () => void;
let originalDataDir: string | undefined;

const listPath = (): string => join(root, 'a', 'worktrees.json');
function listRows(): { id: unknown; branchName: unknown }[] {
  const parsed: unknown = JSON.parse(readFileSync(listPath(), 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('worktrees' in parsed) ||
    !Array.isArray(parsed.worktrees)
  )
    throw new Error('worktrees.json shape');
  return parsed.worktrees.map((row: unknown) =>
    typeof row === 'object' && row !== null
      ? {
          id: 'id' in row ? row.id : null,
          branchName: 'branchName' in row ? row.branchName : null,
        }
      : { id: null, branchName: null },
  );
}

function newHost(): W5CommitLogHost {
  return new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: WORKER,
  });
}

/** Electron's store over `client`, optionally intercepting its commits. */
function installDaemonStore(
  client: W5RecordPortClient,
  beforeCommit?: () => Promise<void>,
): void {
  const transport = w5RecordPortTransport(client);
  const store = createW5DaemonRecordStore({
    root,
    transport: {
      ...transport,
      commit: async (request) => {
        await beforeCommit?.();
        return transport.commit(request);
      },
    },
  });
  restore();
  restore = installW5DaemonRecordStoreForTests(store);
}

/** Another routed writer: a fresh capture read, then a CAS commit. */
async function routedRename(
  client: W5RecordPortClient,
  id: string,
  branchName: string,
): Promise<void> {
  const capture = await client.query('core.workspaceRecords.capture', {
    files: [{ kind: 'worktrees', workspaceId: 'a' }],
    discoverWorkspaces: false,
  });
  const [image] = capture.files;
  if (image?.state !== 'present' || image.base64 === undefined)
    throw new Error('list not captured');
  const raw = Buffer.from(image.base64, 'base64').toString('utf8');
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('worktrees' in parsed) ||
    !Array.isArray(parsed.worktrees)
  )
    throw new Error('list shape');
  const rows: unknown[] = parsed.worktrees;
  const next = JSON.stringify({
    ...parsed,
    worktrees: rows.map((row) =>
      typeof row === 'object' && row !== null && 'id' in row && row.id === id
        ? { ...row, branchName }
        : row,
    ),
  });
  const { createHash } = await import('node:crypto');
  await client.instruction('core.workspaceRecords.commit', {
    operation: 'w6g.test.routed-writer',
    advance: [{ kind: 'worktrees', workspaceId: 'a' }],
    files: [
      {
        target: { kind: 'worktrees', workspaceId: 'a' },
        contents: next,
        previousFingerprint: createHash('sha256')
          .update(raw, 'utf8')
          .digest('hex'),
      },
    ],
    outcome: null,
  });
}

function conflictCount(key: string): number {
  return w5ConflictCounts().get(key) ?? 0;
}

beforeAll(() => {
  setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
    Promise.resolve({ rows: next }),
  );
});
beforeEach(async () => {
  ({ dir, root } = createW5BoundaryFixture((createdAt) => [
    { id: 'one', branchName: 'first', createdAt },
    { id: 'two', branchName: 'second', createdAt },
  ]));
  dir = realpathSync(dir);
  root = join(dir, 'data', 'workspaces');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  host = newHost();
  harness = await startW5DaemonRecordHarness({ host });
  restore = (): void => undefined;
  setDaemonOwnedForTest(W5_NAMESPACES);
});
afterEach(async () => {
  restore();
  setDaemonOwnedForTest([]);
  await settleDetachedWork();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await harness.close();
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('A21′: repairing reads over the daemon record port', () => {
  it('persists read-time removal cleanup through the daemon while every namespace is daemon-owned', async () => {
    installDaemonStore(await harness.connect());
    const two = (
      await readWorkspaceWorktrees('a', { persistRemovalCleanup: false })
    ).find((row) => row.id === 'two');
    if (!two) throw new Error('fixture lacks two');
    markWorkspaceWorktreeRecentlyRemoved('a', 'two', two.createdAt);
    const commits = jest.spyOn(host, 'commit');

    await expect(readWorkspaceWorktrees('a')).resolves.toEqual([
      expect.objectContaining({ id: 'one' }),
    ]);
    // The cleanup committed through the daemon's host, label unchanged.
    expect(commits.mock.calls.map(([request]) => request.operation)).toEqual([
      'w5.worktree_list.write',
    ]);
    expect(listRows().map((row) => row.id)).toEqual(['one']);
    await expect(readWorkspaceWorktreesDetailed('a')).resolves.toMatchObject({
      authority: 'ok',
    });
    await expect(getWorkspaceWorktreeCreatedAt('a', 'one')).resolves.toBe(
      two.createdAt,
    );
    await expect(isWorkspaceWorktreeCurrent('a', 'two')).resolves.toBe(false);
    // A write that the in-process store refuses `daemon_owned` succeeds.
    await expect(
      updateWorkspaceWorktrees('a', (rows) =>
        rows.map((row) => ({ ...row, branchName: 'renamed' })),
      ),
    ).resolves.toEqual([expect.objectContaining({ branchName: 'renamed' })]);
    const [revision] = await readW5Revisions([
      { kind: 'worktrees', workspaceId: 'a' },
    ]);
    expect(revision?.revision).toBe(1);
    commits.mockRestore();
  });

  it('reruns a repairing read whose cleanup races a routed write, and keeps both changes', async () => {
    const other = await harness.connect('another-peer');
    let raced = false;
    installDaemonStore(await harness.connect(), async () => {
      if (raced) return;
      raced = true;
      await routedRename(other, 'one', 'routed');
    });
    const two = (
      await readWorkspaceWorktrees('a', { persistRemovalCleanup: false })
    ).find((row) => row.id === 'two');
    if (!two) throw new Error('fixture lacks two');
    markWorkspaceWorktreeRecentlyRemoved('a', 'two', two.createdAt);
    const retried = conflictCount(
      'internal.repository.write fingerprint retried',
    );

    await expect(readWorkspaceWorktrees('a')).resolves.toEqual([
      expect.objectContaining({ id: 'one', branchName: 'routed' }),
    ]);
    expect(raced).toBe(true);
    expect(conflictCount('internal.repository.write fingerprint retried')).toBe(
      retried + 1,
    );
    expect(listRows()).toEqual([{ id: 'one', branchName: 'routed' }]);
    expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
  });

  it('control: the in-process store still refuses daemon-owned writes', async () => {
    __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
    await expect(
      updateWorkspaceWorktrees('a', (rows) => rows.slice(1)),
    ).rejects.toMatchObject({
      name: 'StorageWriteRefusedError',
      namespaceId: 'worktree_list',
      reason: 'daemon_owned',
    });
  });
});

describe('E9 is unreachable from authority-routed writers', () => {
  it('turns a routed write between the fresh read and the CAS into a pre-decision conflict, and lands the record on retry', async () => {
    const other = await harness.connect('another-peer');
    let raced = false;
    installDaemonStore(await harness.connect(), async () => {
      if (raced) return;
      raced = true;
      await routedRename(other, 'two', 'routed');
    });
    const commits = jest.spyOn(host, 'commit');
    const retried = conflictCount(
      'internal.worktree.record fingerprint retried',
    );

    await expect(
      applyWorktreeRowDecision(
        { workspaceId: 'a', worktreeId: 'one' },
        { kind: 'discovery.branch-prompt', sent: true },
      ),
    ).resolves.toMatchObject({ status: 'recorded' });

    expect(raced).toBe(true);
    // The routed writer's commit, then this record's second attempt only.
    expect(commits).toHaveBeenCalledTimes(2);
    expect(conflictCount('internal.worktree.record fingerprint retried')).toBe(
      retried + 1,
    );
    expect(listRows()).toEqual([
      { id: 'one', branchName: 'first' },
      { id: 'two', branchName: 'routed' },
    ]);
    const report = await host.recoveryReport();
    expect(report.recoveryRequired).toEqual([]);
    commits.mockRestore();

    // No fence: a restarted daemon host keeps serving writes to the list.
    await harness.close();
    await host.shutdown();
    host = newHost();
    harness = await startW5DaemonRecordHarness({ host });
    installDaemonStore(await harness.connect());
    await expect(
      updateWorkspaceWorktrees('a', (rows) => rows.slice(0, 1)),
    ).resolves.toEqual([expect.objectContaining({ id: 'one' })]);
    expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
  });

  it('contrast: a raw out-of-band write after the preflight still wedges the file (W6h/W10 trigger)', async () => {
    await harness.close();
    // Writes the list outside every authority between preflight and apply.
    const racing: W5CommitLogHostPort = {
      root: host.root,
      recoveryReport: () => host.recoveryReport(),
      lookupReceipt: (receipt) => host.lookupReceipt(receipt),
      reserve: (input) => host.reserve(input),
      updateReservationDiagnostics: (id, diagnostics) =>
        host.updateReservationDiagnostics(id, diagnostics),
      releaseReservation: (id) => host.releaseReservation(id),
      markReservationRecoveryRequired: (id, diagnostics) =>
        host.markReservationRecoveryRequired(id, diagnostics),
      revision: (resource) => host.revision(resource),
      capture: (request) => host.capture(request),
      commit: (request) => {
        writeFileSync(
          listPath(),
          readFileSync(listPath(), 'utf8').replace('"second"', '"raw"'),
        );
        return host.commit(request);
      },
    };
    harness = await startW5DaemonRecordHarness({
      host,
      portFor: () => racing,
    });
    installDaemonStore(await harness.connect());
    const commits = jest.spyOn(host, 'commit');

    await expect(
      applyWorktreeRowDecision(
        { workspaceId: 'a', worktreeId: 'one' },
        { kind: 'discovery.branch-prompt', sent: true },
      ),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    // Never retried: the decision was made.
    expect(commits).toHaveBeenCalledTimes(1);
    const fenced: unknown = await updateWorkspaceWorktrees('a', (rows) =>
      rows.slice(0, 1),
    ).catch((error: unknown) => error);
    expect(fenced).toBeInstanceOf(W5CommitRefusedError);
    expect(fenced).toMatchObject({
      reason: 'unapplied-change',
      details: { path: listPath() },
    });
    expect(
      conflictCount('w5.worktree_list.write unapplied-change surfaced'),
    ).toBeGreaterThan(0);
    commits.mockRestore();
  });
});

describe('commit requests the wire accepts', () => {
  it('refuses a fileless revision advance under legacy ownership, moving nothing', async () => {
    setDaemonOwnedForTest([]);
    const client = await harness.connect();
    const commits = jest.spyOn(host, 'commit');
    await expect(
      client.instruction('core.workspaceRecords.commit', {
        operation: 'w6g.test.fileless',
        advance: [{ kind: 'worktrees', workspaceId: 'a' }],
        files: [],
        outcome: null,
      }),
    ).rejects.toMatchObject({
      payload: {
        code: 'core.workspaceRecords.writeRefused',
        details: { namespaceId: 'worktree_list', reason: 'unlisted_writer' },
      },
    });
    expect(commits).not.toHaveBeenCalled();
    await expect(
      host.revision({ kind: 'worktrees', workspaceId: 'a' }),
    ).resolves.toBe(0);
    commits.mockRestore();
  });

  it('reads back the revision of the longest worktree resource it accepts through the fresh read', async () => {
    const client = await harness.connect();
    const resource = {
      kind: 'worktree',
      workspaceId: 'w'.repeat(128),
      worktreeId: 't'.repeat(256),
    } satisfies W5Resource;
    await expect(
      client.instruction('core.workspaceRecords.commit', {
        operation: 'w6g.test.longest-key',
        advance: [resource],
        files: [],
        outcome: null,
      }),
    ).resolves.toMatchObject({
      status: 'applied',
      revisions: {
        [`worktree:${resource.workspaceId}/${resource.worktreeId}`]: 1,
      },
    });
    installDaemonStore(client);
    await expect(readW5Revisions([resource])).resolves.toEqual([
      { resource, revision: 1 },
    ]);
  });

  it('reads back the revision of every worktree id it accepts, and refuses a lone surrogate before any decision', async () => {
    const client = await harness.connect();
    installDaemonStore(client);
    const commit = (resource: W5Resource): Promise<unknown> =>
      client.instruction('core.workspaceRecords.commit', {
        operation: 'w6g.test.worktree-id',
        advance: [resource],
        files: [],
        outcome: null,
      });
    for (const worktreeId of ['a\u0000b', '\u{1F600}'.repeat(128), 'x/y']) {
      const resource = {
        kind: 'worktree',
        workspaceId: 'a',
        worktreeId,
      } as const;
      await expect(commit(resource)).resolves.toMatchObject({
        status: 'applied',
      });
      await expect(readW5Revisions([resource])).resolves.toEqual([
        { resource, revision: 1 },
      ]);
    }
    const commits = jest.spyOn(host, 'commit');
    // Stored as UTF-8, this key would become U+FFFD and never read back.
    const lone = {
      kind: 'worktree',
      workspaceId: 'a',
      worktreeId: '\uD800x',
    } as const;
    await expect(commit(lone)).rejects.toMatchObject({
      payload: { kind: 'invalid_argument' },
    });
    expect(commits).not.toHaveBeenCalled();
    await expect(
      host.revision({ ...lone, worktreeId: '\uFFFDx' }),
    ).resolves.toBe(0);
    commits.mockRestore();
  });

  it('tracked debt: a workspace the capture cannot name or serve reads unreadable and writes nothing', async () => {
    installDaemonStore(await harness.connect());
    // More worktree revision rows than one capture carries.
    await host.commit({
      operation: 'w6g.test.seed',
      advance: Array.from({ length: 4097 }, (_, index) => ({
        kind: 'worktree' as const,
        workspaceId: 'a',
        worktreeId: `seed-${index}`,
      })),
      files: [],
      outcome: null,
    });
    const commits = jest.spyOn(host, 'commit');
    for (const [workspaceId, refusal] of [
      ['a', { details: { capture: 'limit-exceeded' } }],
      ['a.b', { payload: { kind: 'capability_unavailable' } }],
    ] as const) {
      await expect(
        readWorkspaceWorktreesDetailed(workspaceId),
      ).resolves.toMatchObject({ authority: 'unreadable' });
      await expect(
        updateWorkspaceWorktrees(workspaceId, (rows) => rows.slice(1)),
      ).rejects.toMatchObject({ name: 'WorktreeRegistryUnreadableError' });
      await expect(
        readW5Revisions([{ kind: 'worktrees', workspaceId }]),
      ).rejects.toMatchObject(refusal);
    }
    expect(commits).not.toHaveBeenCalled();
    expect(listRows()).toEqual([
      { id: 'one', branchName: 'first' },
      { id: 'two', branchName: 'second' },
    ]);
    commits.mockRestore();
  });

  it('refuses a workspace id the capture cannot name before any decision, on either end', async () => {
    const client = await harness.connect();
    const commits = jest.spyOn(host, 'commit');
    const workspaceId = 'w'.repeat(129);
    const params: CoreWorkspaceRecordsCommitParams = {
      operation: 'w6g.test.unnameable',
      advance: [{ kind: 'worktrees', workspaceId }],
      files: [],
      outcome: null,
    };
    const invalid = { payload: { kind: 'invalid_argument' } };
    await expect(
      client.instruction('core.workspaceRecords.commit', params),
    ).rejects.toMatchObject(invalid);
    // The daemon's own validation, without Electron's client in front of it.
    await expect(
      harness.runtime.dispatcher.instruction(
        'core.workspaceRecords.commit',
        params,
        {
          caller: {
            principalId: 'local-user',
            clientInstanceId: 'electron-main',
            authorityId: 'w6g',
            interfaceKind: 'desktop',
            grants: ['core.workspaceRecords.write'],
          },
        },
      ),
    ).rejects.toMatchObject(invalid);
    expect(commits).not.toHaveBeenCalled();
    await expect(
      host.revision({ kind: 'worktrees', workspaceId }),
    ).resolves.toBe(0);
    commits.mockRestore();
  });

  it('refuses a request larger than one frame in Electron, before sending', async () => {
    const client = await harness.connect();
    const commits = jest.spyOn(host, 'commit');
    // Under the per-file character cap, over one frame in UTF-8 bytes.
    const contents = 'é'.repeat(4 * 1024 * 1024);
    await expect(
      client.instruction('core.workspaceRecords.commit', {
        operation: 'w6g.test.oversize',
        advance: [{ kind: 'worktrees', workspaceId: 'a' }],
        files: [
          {
            target: { kind: 'worktrees', workspaceId: 'a' },
            contents,
            previousFingerprint: null,
          },
        ],
        outcome: null,
      }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(commits).not.toHaveBeenCalled();
    commits.mockRestore();
  });
});

describe('the retry bound', () => {
  it('surfaces the conflict after three refused attempts, rolling back the group pre-write each time', async () => {
    const other = await harness.connect('another-peer');
    let races = 0;
    installDaemonStore(await harness.connect(), async () => {
      races += 1;
      await routedRename(other, 'two', `routed-${races}`);
    });
    const phases: string[] = [];
    setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
      Promise.resolve({
        rows: next,
        beforeWrite: () => {
          phases.push('beforeWrite');
          return Promise.resolve();
        },
        rollback: () => {
          phases.push('rollback');
          return Promise.resolve();
        },
      }),
    );
    const exhausted = conflictCount(
      'internal.worktree.record fingerprint exhausted',
    );
    try {
      await expect(
        applyWorktreeRowDecision(
          { workspaceId: 'a', worktreeId: 'one' },
          { kind: 'discovery.branch-prompt', sent: true },
        ),
      ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    } finally {
      setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
        Promise.resolve({ rows: next }),
      );
    }
    expect(races).toBe(3);
    expect(phases).toEqual([
      'beforeWrite',
      'rollback',
      'beforeWrite',
      'rollback',
      'beforeWrite',
      'rollback',
    ]);
    expect(
      conflictCount('internal.worktree.record fingerprint exhausted'),
    ).toBe(exhausted + 1);
    expect(listRows()).toEqual([
      { id: 'one', branchName: 'first' },
      { id: 'two', branchName: 'routed-3' },
    ]);
  });
});
