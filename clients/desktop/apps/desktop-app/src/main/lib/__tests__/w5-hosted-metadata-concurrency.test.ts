// W5d1 (CAN-5522): hosted metadata commands racing Electron main's W5 writes
// through W6g's daemon-backed store on one root, by deterministic injection:
// no write is lost, the only recovery class is the declared post-effect one,
// and no change is left unapplied.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
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

import { planCanopyWorkspaceInvalidation } from '@canopy/core-client';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  callHostedMetadata,
  pickerSelection,
  startW5HostedMetadataHarness,
  type W5HostedMetadataClient,
  type W5HostedMetadataHarness,
  type W5HostedMetadataRequest,
} from './fixtures/w5-hosted-metadata-harness';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  __setDesktopW5FileStoreForTests,
  W5FileWriteRefusedError,
  W5RevisionConflictError,
} from '../w5-commit-log-file-store';
import {
  createW5DaemonRecordStore,
  installW5DaemonRecordStoreForTests,
  w5RecordPortTransport,
  type W5RecordPortClient,
} from '../w5-daemon-record-store';
import { nodeW5FileStore } from '../w5-file-store';
import { w5ConflictCounts } from '../w5-pre-effect-retry';
import { updateWorkspaceMetadata } from '../workspace-metadata';
import { createWorkspace } from '../workspace-creation';
import { setWorktreeRegistryReconciler } from '../workspace-persistence';
import { updateWorkspaceScripts } from '../workspace-script-hook-settings';
import { applyWorktreeRowDecision } from '../worktree-record-decision-port';

jest.setTimeout(60_000);

const W5_NAMESPACES = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
];
const WORKER = join(__dirname, '../../w5-commit-log/commit-log-worker.ts');
const ELECTRON = 'electron-main';

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

function seed(): void {
  const createdAt = new Date(0).toISOString();
  for (const id of ['a', 'b']) mkdirSync(join(root, id), { recursive: true });
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify(
      {
        version: 1,
        workspaces: [
          {
            id: 'a',
            name: 'A',
            type: 'multi-repo',
            color: '#7C3AED',
            order: 0,
          },
          {
            id: 'b',
            name: 'B',
            type: 'multi-repo',
            color: '#7C3AED',
            order: 1,
          },
        ],
      },
      null,
      2,
    ),
  );
  for (const id of ['a', 'b'])
    writeFileSync(
      join(root, id, 'workspace.json'),
      JSON.stringify(
        {
          version: 1,
          type: 'multi-repo',
          repos: [{ id: 'web', name: 'web', repoPath: repo }],
          alwaysShow: true,
        },
        null,
        2,
      ),
    );
  writeFileSync(
    join(root, 'a', 'worktrees.json'),
    JSON.stringify({
      version: 1,
      worktrees: [{ id: 'one', branchName: 'first', createdAt }],
    }),
  );
}

const apply = (params: W5HostedMetadataRequest): Promise<unknown> =>
  callHostedMetadata(hosted, params);

/** Electron main's store over the record port, with the injection seam. */
async function installElectron(): Promise<W5RecordPortClient> {
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
  return records;
}

async function noRecovery(): Promise<void> {
  const report = await harness.host().recoveryReport();
  expect(report.recoveryRequired).toEqual([]);
  expect(report.recoveryRequiredReservations ?? []).toEqual([]);
}

const conflicts = (key: string): number => w5ConflictCounts().get(key) ?? 0;

const startHarness = (epoch?: string): Promise<W5HostedMetadataHarness> =>
  startW5HostedMetadataHarness({
    dbPath: join(dir, 'data', 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: WORKER,
    daemonOwned: W5_NAMESPACES,
    repositorySelections: new Map([['pick-other', join(dir, 'other')]]),
    isRepository: () => Promise.resolve(true),
    ...(epoch !== undefined && { epoch }),
  });

beforeAll(() => {
  setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
    Promise.resolve({ rows: next }),
  );
});
beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'w5d1-concurrency-')));
  root = join(dir, 'data', 'workspaces');
  repo = join(dir, 'repo');
  gitRepo(repo);
  gitRepo(join(dir, 'other'));
  seed();
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  harness = await startHarness();
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

describe('hosted metadata commands racing Electron through W6g', () => {
  it('(a) lands both sides of disjoint files, each revision once, events in commit order', async () => {
    beforeElectronCommit = async (): Promise<void> => {
      await apply({
        operation: 'core.workspace.scripts.update',
        workspaceId: 'a',
        change: { kind: 'merge-commands', commands: { setup: 'pnpm i' } },
      });
      await apply({
        operation: 'core.workspace.repository.add',
        workspaceId: 'a',
        repository: { selection: pickerSelection('pick-other') },
      });
    };
    await expect(
      applyWorktreeRowDecision(
        { workspaceId: 'a', worktreeId: 'one' },
        { kind: 'discovery.branch-prompt', sent: true },
      ),
    ).resolves.toMatchObject({ status: 'recorded' });
    expect(harness.commits).toEqual([
      'core.workspace.scripts.update',
      'core.workspace.repository.add',
      'w5.worktree_list.write',
    ]);
    expect(readJson('a/workspace.json')).toMatchObject({
      scripts: { setup: 'pnpm i' },
      repos: [{ id: 'web' }, { id: 'other' }],
    });
    expect(readJson('a/worktrees.json')).toMatchObject({
      worktrees: [{ id: 'one', branchPromptSent: true }],
    });
    await expect(
      harness.revision({ kind: 'workspace', workspaceId: 'a' }),
    ).resolves.toBe(2);
    const events = harness.events();
    expect(
      events.map((event) =>
        planCanopyWorkspaceInvalidation(event, (id) => id === ELECTRON),
      ),
    ).toEqual([
      expect.objectContaining({ manifests: ['a'] }),
      expect.objectContaining({ manifests: ['a'] }),
      // Electron's own W6g commit: its own subscriber skips it.
      null,
    ]);
    await noRecovery();
  });

  it('applies a hosted command Electron itself issued on its own subscriber', async () => {
    const own = await harness.connectMetadata(ELECTRON);
    await callHostedMetadata(own, {
      operation: 'core.workspace.planDetection.update',
      workspaceId: 'a',
      planDetection: { disabledRuleIds: ['plans-dir'] },
    });
    const [event] = harness.events();
    if (!event) throw new Error('no event');
    expect(
      planCanopyWorkspaceInvalidation(event, (id) => id === ELECTRON),
    ).toMatchObject({ broad: false, manifests: ['a'] });
  });

  it('(b) reruns an overtaken Electron metadata write refused before its decision, keeping the hosted one, and lands both', async () => {
    const surfaced = conflicts('core.workspace.update fingerprint surfaced');
    const retried = conflicts('core.workspace.update fingerprint retried');
    beforeElectronCommit = async (): Promise<void> => {
      await apply({
        operation: 'core.workspace.reorder',
        visibleWorkspaceIds: ['a', 'b'],
        activeWorkspaceId: 'b',
        overWorkspaceId: 'a',
      });
    };
    // W5d2 O-2 (CAN-5537): W5d1's Electron entries rerun a stale-file
    // refusal, as the hosted commands do, so this case flipped.
    await expect(
      updateWorkspaceMetadata({
        workspaceId: 'a',
        source: 'portal',
        patch: { name: 'Renamed' },
      }),
    ).resolves.toMatchObject({ indexWritten: true });
    expect(conflicts('core.workspace.update fingerprint retried')).toBe(
      retried + 1,
    );
    expect(conflicts('core.workspace.update fingerprint surfaced')).toBe(
      surfaced,
    );
    expect(readJson('index.json')).toMatchObject({
      workspaces: [{ id: 'b' }, { id: 'a', name: 'Renamed' }],
    });
    expect(harness.commits).toEqual([
      'core.workspace.reorder',
      'core.workspace.update',
    ]);
    await noRecovery();
  });

  it('(b′) reruns a keyed Electron metadata write under its one reservation, deciding it once', async () => {
    const retried = conflicts('core.workspace.update fingerprint retried');
    beforeElectronCommit = async (): Promise<void> => {
      await apply({
        operation: 'core.workspace.reorder',
        visibleWorkspaceIds: ['a', 'b'],
        activeWorkspaceId: 'b',
        overWorkspaceId: 'a',
      });
    };
    const request = {
      workspaceId: 'a',
      source: 'portal',
      patch: { name: 'Keyed' },
      idempotencyKey: 'electron-rename',
    } as const;
    await expect(updateWorkspaceMetadata(request)).resolves.toMatchObject({
      indexWritten: true,
    });
    expect(conflicts('core.workspace.update fingerprint retried')).toBe(
      retried + 1,
    );
    // The same key replays its one decision, after another hosted write.
    await apply({
      operation: 'core.workspace.reorder',
      visibleWorkspaceIds: ['b', 'a'],
      activeWorkspaceId: 'a',
      overWorkspaceId: 'b',
    });
    await expect(updateWorkspaceMetadata(request)).resolves.toMatchObject({
      indexWritten: true,
    });
    expect(harness.commits).toEqual([
      'core.workspace.reorder',
      'core.workspace.update',
      'core.workspace.reorder',
    ]);
    expect(readJson('index.json')).toMatchObject({
      workspaces: [{ id: 'a', name: 'Keyed' }, { id: 'b' }],
    });
    const report = await harness.host().recoveryReport();
    expect(report.recoveryRequired).toEqual([]);
    expect(report.reservations ?? []).toEqual([]);
  });

  it('(b′) keeps the reservation across the rerun: a same-key Electron request is in progress', async () => {
    let atRerun = (): void => undefined;
    const rerunCommitting = new Promise<void>((resolve) => {
      atRerun = resolve;
    });
    let releaseRerun = (): void => undefined;
    const rerunReleased = new Promise<void>((resolve) => {
      releaseRerun = resolve;
    });
    beforeElectronCommit = async (): Promise<void> => {
      // The rerun's commit waits while the duplicate is admitted.
      beforeElectronCommit = async (): Promise<void> => {
        atRerun();
        await rerunReleased;
      };
      await apply({
        operation: 'core.workspace.reorder',
        visibleWorkspaceIds: ['a', 'b'],
        activeWorkspaceId: 'b',
        overWorkspaceId: 'a',
      });
    };
    const request = {
      workspaceId: 'a',
      source: 'portal',
      patch: { name: 'Keyed' },
      idempotencyKey: 'electron-rename',
    } as const;
    const first = updateWorkspaceMetadata(request);
    await rerunCommitting;
    await expect(updateWorkspaceMetadata(request)).rejects.toMatchObject({
      reason: 'in-progress',
    });
    releaseRerun();
    await expect(first).resolves.toMatchObject({ indexWritten: true });
    expect(harness.commits).toEqual([
      'core.workspace.reorder',
      'core.workspace.update',
    ]);
    await noRecovery();
  });

  it('(b″) surfaces the last refusal once three hosted writes overtake an Electron metadata write', async () => {
    const exhausted = conflicts('core.workspace.update fingerprint exhausted');
    let overtakes = 0;
    const overtake = async (): Promise<void> => {
      overtakes += 1;
      if (overtakes < 3) beforeElectronCommit = overtake;
      await apply({
        operation: 'core.workspace.update',
        workspaceId: 'b',
        patch: { name: `Hosted ${overtakes}` },
      });
    };
    beforeElectronCommit = overtake;
    await expect(
      updateWorkspaceMetadata({
        workspaceId: 'a',
        source: 'portal',
        patch: { name: 'Overtaken' },
      }),
    ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    expect(overtakes).toBe(3);
    expect(conflicts('core.workspace.update fingerprint exhausted')).toBe(
      exhausted + 1,
    );
    expect(readJson('index.json')).toMatchObject({
      workspaces: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'Hosted 3' },
      ],
    });
    await noRecovery();
  });

  it('(b‴) refuses the rerun of a revisioned Electron metadata write at the revision a hosted write advanced', async () => {
    const retried = conflicts('core.workspace.update fingerprint retried');
    const expectedRevision = await harness.revision({
      kind: 'workspace',
      workspaceId: 'a',
    });
    beforeElectronCommit = async (): Promise<void> => {
      await apply({
        operation: 'core.workspace.update',
        workspaceId: 'a',
        patch: { name: 'Hosted' },
      });
    };
    await expect(
      updateWorkspaceMetadata({
        workspaceId: 'a',
        source: 'portal',
        patch: { name: 'Stale' },
        expectedRevision,
      }),
    ).rejects.toBeInstanceOf(W5RevisionConflictError);
    // The stale-file refusal reran once; the caller resolves the revision.
    expect(conflicts('core.workspace.update fingerprint retried')).toBe(
      retried + 1,
    );
    expect(readJson('index.json')).toMatchObject({
      workspaces: [{ id: 'a', name: 'Hosted' }, { id: 'b' }],
    });
    expect(harness.commits).toEqual(['core.workspace.update']);
    await noRecovery();
  });

  it('(c) retries a hosted command an Electron commit overtook, and lands both', async () => {
    let raced = false;
    harness.hooks.afterRead = async (
      filePath,
      _read,
      staging,
    ): Promise<void> => {
      if (raced || !staging || !filePath.endsWith(join('a', 'workspace.json')))
        return;
      raced = true;
      await updateWorkspaceScripts({
        workspaceId: 'a',
        source: 'desktop',
        change: { kind: 'merge-commands', commands: { launch: 'pnpm dev' } },
      });
    };
    await expect(
      apply({
        operation: 'core.workspace.privateMemory.update',
        workspaceId: 'a',
        privateMemory: true,
        idempotencyKey: 'overtaken',
      }),
    ).resolves.toMatchObject({ privateMemory: true });
    expect(raced).toBe(true);
    expect(harness.retryCounts()).toEqual(
      new Map([['core.workspace.privateMemory.update fingerprint retried', 1]]),
    );
    expect(readJson('a/workspace.json')).toMatchObject({
      privateMemory: true,
      scripts: { launch: 'pnpm dev' },
    });
    expect(harness.commits).toEqual([
      'core.workspace.scripts.update',
      'core.workspace.privateMemory.update',
    ]);
    await noRecovery();
  });

  it('(d) refuses an update of a workspace deleted under it, and resurrects nothing', async () => {
    const records = await harness.connectRecords('deleting-peer');
    let deleted = false;
    harness.hooks.afterRead = async (
      filePath,
      read,
      staging,
    ): Promise<void> => {
      if (deleted || staging || !filePath.endsWith(join('b', 'workspace.json')))
        return;
      if (read.state !== 'present') return;
      deleted = true;
      await records.instruction('core.workspaceRecords.commit', {
        operation: 'w5d1.test.delete',
        advance: [{ kind: 'workspace', workspaceId: 'b' }],
        files: [
          {
            target: { kind: 'manifest', workspaceId: 'b' },
            contents: null,
            previousFingerprint: createHash('sha256')
              .update(read.raw, 'utf8')
              .digest('hex'),
          },
        ],
        outcome: null,
      });
    };
    const error: unknown = await apply({
      operation: 'core.workspace.scripts.update',
      workspaceId: 'b',
      change: { kind: 'replace', scripts: { setup: 'make' } },
    }).catch((caught: unknown) => caught);
    expect(deleted).toBe(true);
    expect(error).toMatchObject({
      payload: {
        code: 'core.workspace.configurationUnavailable',
        details: { reason: 'configuration-unavailable' },
        // As the first-come #6 page retries it.
        retry: { kind: 'after_refresh', resource: 'core.workspace.get' },
      },
    });
    expect(existsSync(join(root, 'b', 'workspace.json'))).toBe(false);
    expect(harness.commits).toEqual(['w5d1.test.delete']);
    await noRecovery();
  });

  it('(e) refuses a workspace create the hosted index write overtook after its effects, holding its identity for recovery: the declared class', async () => {
    const source = join(dir, 'import-source');
    gitRepo(source);
    execFileSync('git', [
      '-C',
      source,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'base',
    ]);
    const importRepo = join(dir, 'import-repo');
    execFileSync('git', ['clone', '-q', source, importRepo]);
    // The create's effect (canopy.json) has run; its index publication is
    // next, and the hosted reorder lands between its read and its commit.
    beforeElectronCommit = async (): Promise<void> => {
      await apply({
        operation: 'core.workspace.reorder',
        visibleWorkspaceIds: ['a', 'b'],
        activeWorkspaceId: 'b',
        overWorkspaceId: 'a',
      });
    };
    const surfaced = conflicts('core.workspace.create fingerprint surfaced');
    await expect(
      createWorkspace({
        source: 'folder',
        variant: { kind: 'local-folder', folderPath: importRepo },
      }),
    ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    // Not a pre-effect unit: the conflict surfaces, never rerun.
    expect(conflicts('core.workspace.create fingerprint surfaced')).toBe(
      surfaced + 1,
    );
    // The effect and the hosted write stay; the create published nothing.
    expect(existsSync(join(importRepo, 'canopy.json'))).toBe(true);
    expect(readJson('index.json')).toMatchObject({
      workspaces: [{ id: 'b' }, { id: 'a' }],
    });
    expect(existsSync(join(root, 'import-repo', 'workspace.json'))).toBe(false);
    expect(harness.commits).toEqual(['core.workspace.reorder']);
    // Never an unapplied change, and the identity stays reserved.
    const report = await harness.host().recoveryReport();
    expect(report.recoveryRequired).toEqual([]);
    const [reservation, ...others] = report.reservations ?? [];
    expect(others).toEqual([]);
    expect(reservation).toMatchObject({
      operation: 'core.workspace.create',
      diagnostics: { workspaceId: 'import-repo' },
    });
    // After a restart that reservation is recovery-required (W5 Q3).
    restore();
    await harness.close();
    harness = await startHarness('runtime:w5d1-restarted');
    hosted = await harness.connectMetadata('hosted-peer');
    await installElectron();
    const restarted = await harness.host().recoveryReport();
    expect(restarted.recoveryRequired).toEqual([]);
    expect(restarted.recoveryRequiredReservations).toEqual([
      reservation?.reservationId,
    ]);
    // The next writer of the index lands.
    await updateWorkspaceMetadata({
      workspaceId: 'b',
      source: 'portal',
      patch: { name: 'Later' },
    });
    expect(readJson('index.json')).toMatchObject({
      workspaces: [{ id: 'b', name: 'Later' }, { id: 'a' }],
    });
  });
});
