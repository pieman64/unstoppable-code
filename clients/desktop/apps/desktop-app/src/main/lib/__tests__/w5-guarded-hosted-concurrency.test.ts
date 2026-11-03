// W5d2 PR 3c (CAN-5537): W5d2's guarded Electron commands racing W5d1's
// hosted metadata commands, and a second record-port client, through W6g's
// daemon-backed store on one root, by deterministic injection: no write is
// lost, nothing is recovery-required and no change is left unapplied.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as CoreStorage from '@canopy/core-runtime/storage';
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
// The hook binding's captured execution context.
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: (): boolean => true,
  }),
}));
jest.mock('../workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    initialize: (): Promise<void> => Promise.resolve(),
    whenIdle: (): Promise<void> => Promise.resolve(),
    getState: (): { context: { kind: string } } => ({
      context: { kind: 'personal' },
    }),
  }),
}));

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  callHostedMetadata,
  pickerSelection,
  startW5HostedMetadataHarness,
  type W5HostedMetadataClient,
  type W5HostedMetadataHarness,
  type W5HostedMetadataRequest,
} from './fixtures/w5-hosted-metadata-harness';
import { updateCoworkWorkspaceSettings } from '../cowork-workspace-crud';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { __setDesktopW5FileStoreForTests } from '../w5-commit-log-file-store';
import {
  createW5DaemonRecordStore,
  installW5DaemonRecordStoreForTests,
  w5RecordPortTransport,
  type W5RecordPortClient,
} from '../w5-daemon-record-store';
import { nodeW5FileStore } from '../w5-file-store';
import { w5ConflictCounts } from '../w5-pre-effect-retry';
import { setWorktreeRegistryReconciler } from '../workspace-persistence';
import { updateWorkspacePlugins } from '../workspace-plugin-defaults';
import { registerWorkspaceTypes } from '../workspace-registry';
import { updateWorkspaceRetention } from '../workspace-retention';
import {
  setWorktreeHooksPaused,
  updateWorkspaceHooks,
} from '../workspace-script-hook-settings';
import { moveWorktree, updateWorktree } from '../worktree-update';

jest.setTimeout(60_000);

const W5_NAMESPACES = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
];
const WORKER = join(__dirname, '../../w5-commit-log/commit-log-worker.ts');
const ELECTRON = 'electron-main';
const SELECTIONS = {
  collectionIds: [],
  skillRefs: [{ sourceId: 'source', skillName: 'chosen' }],
  pluginRefs: [],
};

let dir: string;
let root: string;
let repo: string;
let harness: W5HostedMetadataHarness;
let hosted: W5HostedMetadataClient;
let restore: () => void;
let originalDataDir: string | undefined;
/** Runs once before Electron's next record-port commit, then clears. */
let beforeElectronCommit: (() => Promise<void>) | undefined;

function gitRepo(path: string): void {
  mkdirSync(path);
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
}

const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(join(root, name), 'utf8'));

const writeJson = (name: string, value: unknown): void =>
  writeFileSync(join(root, name), JSON.stringify(value, null, 2));

const WORKTREES = {
  version: 1,
  worktrees: [
    { id: 'one', branchName: 'first', createdAt: new Date(0).toISOString() },
    { id: 'two', branchName: 'second', createdAt: new Date(0).toISOString() },
  ],
};

function seed(): void {
  for (const id of ['a', 'c']) mkdirSync(join(root, id), { recursive: true });
  writeJson('index.json', {
    version: 1,
    workspaces: [
      { id: 'a', name: 'A', type: 'multi-repo', color: '#7C3AED', order: 0 },
      { id: 'c', name: 'C', type: 'cowork', color: '#7C3AED', order: 1 },
    ],
  });
  writeJson('a/workspace.json', {
    version: 1,
    type: 'multi-repo',
    repos: [{ id: 'web', name: 'web', repoPath: repo }],
    alwaysShow: true,
  });
  writeJson('c/workspace.json', {
    version: 1,
    type: 'cowork',
    repos: [],
    cowork: { description: 'original', presets: [] },
  });
  writeJson('a/worktrees.json', WORKTREES);
}

const apply = (params: W5HostedMetadataRequest): Promise<unknown> =>
  callHostedMetadata(hosted, params);

/** Electron main's store over the record port, with the injection seam. */
async function installElectron(): Promise<void> {
  const records = await harness.connectRecords(ELECTRON);
  const transport = w5RecordPortTransport(records);
  restore = installW5DaemonRecordStoreForTests(
    createW5DaemonRecordStore({
      root,
      transport: {
        ...transport,
        commit: async (request) => {
          const inject = beforeElectronCommit;
          beforeElectronCommit = undefined;
          await inject?.();
          return transport.commit(request);
        },
      },
    }),
  );
}

/** No recovery-required decision or reservation, and no reservation held. */
async function noRecovery(): Promise<void> {
  const report = await harness.host().recoveryReport();
  expect(report.recoveryRequired).toEqual([]);
  expect(report.recoveryRequiredReservations ?? []).toEqual([]);
  expect(report.reservations ?? []).toEqual([]);
}

/** Fingerprint conflicts retried or surfaced, under any label. */
function fingerprintConflicts(): number {
  let total = 0;
  for (const [key, count] of w5ConflictCounts())
    if (/ fingerprint (retried|surfaced)$/.test(key)) total += count;
  return total;
}

/**
 * A guarded Electron write the injected write overtook lands on the first
 * call: W5d2 PR 3a/3b's retry (CAN-5535, CAN-5536) reruns its refused
 * decision from a fresh read. One conflict is counted and the write decides
 * once, with commit label `label`.
 */
async function landsOnceOvertaken(
  label: string,
  write: () => Promise<unknown>,
): Promise<void> {
  const before = fingerprintConflicts();
  await write();
  expect(fingerprintConflicts()).toBe(before + 1);
  expect(harness.commits.filter((commit) => commit === label)).toEqual([label]);
}

/** A second record-port client's write of row `two`'s label, over the seed. */
async function peerRelabelsTwo(records: W5RecordPortClient): Promise<void> {
  const raw = readFileSync(join(root, 'a', 'worktrees.json'), 'utf8');
  await records.instruction('core.workspaceRecords.commit', {
    operation: 'w5d2.test.peer',
    advance: [
      { kind: 'worktrees', workspaceId: 'a' },
      { kind: 'worktree', workspaceId: 'a', worktreeId: 'two' },
    ],
    files: [
      {
        target: { kind: 'worktrees', workspaceId: 'a' },
        contents: JSON.stringify({
          ...WORKTREES,
          worktrees: WORKTREES.worktrees.map((row) =>
            row.id === 'two' ? { ...row, label: 'Peer' } : row,
          ),
        }),
        previousFingerprint: createHash('sha256')
          .update(raw, 'utf8')
          .digest('hex'),
      },
    ],
    outcome: null,
  });
}

beforeAll(() => {
  setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
    Promise.resolve({ rows: next }),
  );
});
beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'w5d2-concurrency-')));
  root = join(dir, 'data', 'workspaces');
  repo = join(dir, 'repo');
  gitRepo(repo);
  gitRepo(join(dir, 'other'));
  seed();
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  registerWorkspaceTypes(
    new Map([
      ['a', 'multi-repo'],
      ['c', 'cowork'],
    ]),
  );
  harness = await startW5HostedMetadataHarness({
    dbPath: join(dir, 'data', 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: WORKER,
    daemonOwned: W5_NAMESPACES,
    repositorySelections: new Map([['pick-other', join(dir, 'other')]]),
    isRepository: () => Promise.resolve(true),
  });
  hosted = await harness.connectMetadata('hosted-peer');
  restore = (): void => undefined;
  beforeElectronCommit = undefined;
  await installElectron();
});
afterEach(async () => {
  restore();
  await settleDetachedWork();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await harness.close();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('guarded Electron commands racing hosted metadata commands through W6g', () => {
  it('runs the daemon side in its own module registry', () => {
    // Shared repository locks would serialize the race into a false pass.
    expect(harness.isolated).toBe(true);
  });

  it('#7 hooks against hosted #6 scripts keeps both', async () => {
    beforeElectronCommit = async (): Promise<void> => {
      await apply({
        operation: 'core.workspace.scripts.update',
        workspaceId: 'a',
        change: { kind: 'merge-commands', commands: { setup: 'pnpm i' } },
      });
    };
    await landsOnceOvertaken('core.workspace.hooks.update', () =>
      updateWorkspaceHooks({
        workspaceId: 'a',
        source: 'desktop',
        change: { kind: 'replace', hooks: { 'worktree:created': null } },
      }),
    );
    expect(readJson('a/workspace.json')).toMatchObject({
      scripts: { setup: 'pnpm i' },
      hooks: { 'worktree:created': null },
    });
    expect(harness.commits[0]).toBe('core.workspace.scripts.update');
    await noRecovery();
  });

  it('#9 a user plugins change against hosted #10 private memory keeps both', async () => {
    beforeElectronCommit = async (): Promise<void> => {
      await apply({
        operation: 'core.workspace.privateMemory.update',
        workspaceId: 'a',
        privateMemory: true,
      });
    };
    // An unkeyed user change keeps the plain manifest write's label.
    await landsOnceOvertaken('w5.workspace_manifest.write', () =>
      updateWorkspacePlugins({
        workspaceId: 'a',
        source: 'workspace_settings',
        change: { kind: 'setDefaults', defaultPluginSelections: SELECTIONS },
      }),
    );
    expect(readJson('a/workspace.json')).toMatchObject({
      privateMemory: true,
      defaultPluginSelections: SELECTIONS,
    });
    expect(harness.commits[0]).toBe('core.workspace.privateMemory.update');
    await noRecovery();
  });

  it('#11 retention against hosted #13 repository add keeps both', async () => {
    beforeElectronCommit = async (): Promise<void> => {
      await apply({
        operation: 'core.workspace.repository.add',
        workspaceId: 'a',
        repository: { selection: pickerSelection('pick-other') },
      });
    };
    await landsOnceOvertaken('core.workspace.retention.update', () =>
      updateWorkspaceRetention({
        workspaceId: 'a',
        source: 'workspace_settings',
        patch: { archiveRetentionDays: 9 },
      }),
    );
    expect(readJson('a/workspace.json')).toMatchObject({
      repos: [{ id: 'web' }, { id: 'other' }],
      archiveRetentionDays: 9,
    });
    expect(harness.commits[0]).toBe('core.workspace.repository.add');
    await noRecovery();
  });

  it('#12 Cowork settings against hosted #4 reorder keeps both, never writing the index it read', async () => {
    beforeElectronCommit = async (): Promise<void> => {
      await apply({
        operation: 'core.workspace.reorder',
        visibleWorkspaceIds: ['a', 'c'],
        activeWorkspaceId: 'c',
        overWorkspaceId: 'a',
      });
    };
    const before = fingerprintConflicts();
    // Settings decide only the manifest, so the reorder of the index the
    // change read before it is no conflict.
    await expect(
      updateCoworkWorkspaceSettings({ projectId: 'c', description: 'Updated' }),
    ).resolves.toEqual({ workspaceId: 'c' });
    expect(fingerprintConflicts()).toBe(before);
    expect(harness.commits).toEqual([
      'core.workspace.reorder',
      'core.workspace.cowork.update',
    ]);
    expect(readJson('index.json')).toMatchObject({
      workspaces: [{ id: 'c' }, { id: 'a' }],
    });
    expect(readJson('c/workspace.json')).toMatchObject({
      cowork: { description: 'Updated' },
    });
    expect(harness.commits[0]).toBe('core.workspace.reorder');
    await noRecovery();
  });
});

describe('guarded Electron worktree commands racing a second record-port client', () => {
  let peer: W5RecordPortClient;
  beforeEach(async () => {
    peer = await harness.connectRecords('record-peer');
    beforeElectronCommit = (): Promise<void> => peerRelabelsTwo(peer);
  });

  const rows = (): unknown => readJson('a/worktrees.json');

  it('#22 a row update keeps the peer write', async () => {
    await landsOnceOvertaken('core.worktree.update', () =>
      updateWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        patch: { label: 'Edited' },
      }),
    );
    expect(rows()).toMatchObject({
      worktrees: [
        { id: 'one', label: 'Edited' },
        { id: 'two', label: 'Peer' },
      ],
    });
    expect(harness.commits[0]).toBe('w5d2.test.peer');
    await noRecovery();
  });

  it('#23 a row move keeps the peer write', async () => {
    await landsOnceOvertaken('core.worktree.reorder', () =>
      moveWorktree({
        workspaceId: 'a',
        activeWorktreeId: 'two',
        overWorktreeId: 'one',
      }),
    );
    expect(rows()).toMatchObject({
      worktrees: [{ id: 'two', label: 'Peer' }, { id: 'one' }],
    });
    expect(harness.commits[0]).toBe('w5d2.test.peer');
    await noRecovery();
  });

  it('#26 a hook pause keeps the peer write', async () => {
    await landsOnceOvertaken('core.worktree.hooks.setPaused', () =>
      setWorktreeHooksPaused({
        workspaceId: 'a',
        worktreeId: 'one',
        source: 'desktop',
        change: { kind: 'pause', hookKeys: ['hook-a'] },
      }),
    );
    expect(rows()).toMatchObject({
      worktrees: [
        { id: 'one', pausedHookKeys: ['hook-a'] },
        { id: 'two', label: 'Peer' },
      ],
    });
    expect(harness.commits[0]).toBe('w5d2.test.peer');
    await noRecovery();
  });
});
