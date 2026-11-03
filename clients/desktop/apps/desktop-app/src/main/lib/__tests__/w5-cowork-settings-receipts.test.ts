// CAN-4719 (W3a1): the keyed, settings-only core.workspace.cowork.update
// (A28′(a)) and the unkeyed mixed Cowork save it leaves in place, with the
// real commit-log worker and filesystem.
import {
  createW5BoundaryFixture,
  isW5FinalPreflightRead,
} from './fixtures/w5-boundary-fixture';
import { W5CommitLog } from '@canopy/desktop-shared/node/w5-commit-log';
import type {
  ChatTabPluginSelections,
  UpdateChatProjectRequest,
} from '@canopy/desktop-shared/types';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type * as AsyncHooks from 'node:async_hooks';
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
jest.mock('../archived-containers', () => {
  // A real re-entrant per-workspace lock without the archive store.
  const { AsyncLocalStorage } =
    jest.requireActual<typeof AsyncHooks>('node:async_hooks');
  const held = new AsyncLocalStorage<ReadonlySet<string>>();
  const tails = new Map<string, Promise<unknown>>();
  return {
    countArchivedContainers: jest.fn(() => Promise.resolve(0)),
    withArchivedWorkspaceOperationLock: jest.fn(
      (id: string, work: () => Promise<unknown>) => {
        const outer = held.getStore() ?? new Set<string>();
        if (outer.has(id)) return work();
        const inner = (): Promise<unknown> =>
          held.run(new Set([...outer, id]), work);
        const run = (tails.get(id) ?? Promise.resolve()).then(inner, inner);
        tails.set(
          id,
          run.catch(() => undefined),
        );
        return run;
      },
    ),
  };
});

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  W5RevisionConflictError,
  withW5Commit,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import * as SidebarItems from '../sidebar-items';
import { schedulePortalStructuralSync } from '../../portal/portal-structural-sync';
import { notifyPortalStructureChanged } from '../../portal/portal-event-bus';
import { registerWorkspaceTypes } from '../workspace-registry';
import {
  PROJECT_PLUGIN_DEFAULTS_NORMALIZATION_FAILED,
  isWorkspaceWorktreeRecentlyRemoved,
  markWorkspaceWorktreeRecentlyRemoved,
  readProjectPluginDefaults,
  setBeforeProjectPluginDefaultsChangeHandler,
} from '../workspace-persistence';
import { diagnoseW5State } from '../w5-maintenance-diagnosis';
import { withArchivedWorkspaceOperationLock } from '../archived-containers';
import {
  getWorkspaceConfigPath,
  getWorkspaceWorkEntriesFilePath,
} from '../paths';
import { touchAllWorkspaceTargets } from '../workspace-activity';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import {
  projectPluginDefaultsWritten,
  readThroughProjectPluginDefaults,
  type ProjectPluginDefaultsRead,
} from '../../plugins/project-plugin-defaults-cache';
import { getProjectPluginDefaultsRevision } from '../../plugins/plugin-defaults-revision';
import {
  updateCoworkWorkspace,
  updateCoworkWorkspaceSettings,
  type CoworkSettingsUpdateRequest,
  type CoworkSettingsUpdateOutcome,
} from '../cowork-workspace-crud';
import { isRecord } from '../type-guards';
import * as workspacePersistence from '../workspace-persistence';
import {
  __pluginDefaultsHandOffsForTests,
  __setInlinePluginDefaultsReconcileBoundForTests,
} from '../workspace-plugin-defaults';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  commitsLandingOnEveryPass,
  settlesWithin,
  stalledManifestCommit,
} from './fixtures/plugin-defaults-reconcile-bound';

jest.setTimeout(90_000);
let dir: string;
let root: string;
let dbPath: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;

const OPERATION = 'core.workspace.cowork.update';
const RESOURCE = { kind: 'workspace', workspaceId: 'one' } as const;
const PRESET_SELECTIONS: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [{ sourceId: 'source', skillName: 'preset-skill' }],
  pluginRefs: [],
};
const EXPLICIT_SELECTIONS: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [{ sourceId: 'source', skillName: 'explicit-skill' }],
  pluginRefs: [],
};
const OUTCOME: CoworkSettingsUpdateOutcome = { workspaceId: 'one' };
const STALE_TOUCH = '2020-01-01T00:00:00.000Z';

const indexPath = (): string => join(root, 'index.json');
const manifestPath = (): string => join(root, 'one', 'workspace.json');
const entriesPath = (): string => getWorkspaceWorkEntriesFilePath('one');

function startHost(): void {
  host = new W5CommitLogHost({
    dbPath,
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  SidebarItems.__resetSidebarItemsStateForTests();
  registerWorkspaceTypes(
    new Map([
      ['a', 'single-repo'],
      ['one', 'cowork'],
    ]),
  );
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
  ({ dir, root } = createW5BoundaryFixture());
  writeFileSync(
    indexPath(),
    JSON.stringify({
      version: 1,
      workspaces: [
        {
          id: 'a',
          name: 'Original',
          type: 'single-repo',
          color: '#7C3AED',
          collapsed: false,
          order: 0,
        },
        {
          id: 'one',
          name: 'One',
          type: 'cowork',
          color: '#7C3AED',
          collapsed: false,
          order: 1,
        },
      ],
    }),
  );
  mkdirSync(join(root, 'one'), { recursive: true });
  writeFileSync(
    manifestPath(),
    JSON.stringify({
      version: 1,
      type: 'cowork',
      repos: [],
      cowork: {
        description: 'original',
        archiveRetentionDays: 7,
        presets: [
          { id: 'preset', name: 'Preset', pluginSelections: PRESET_SELECTIONS },
        ],
        futureSetting: true,
      },
    }),
  );
  dbPath = join(dir, 'data', 'w5', 'commit-log.sqlite');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  mkdirSync(dirname(entriesPath()), { recursive: true });
  resetTouches();
  startHost();
  jest.clearAllMocks();
});
afterEach(async () => {
  jest.restoreAllMocks();
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

/** Canonical bytes, recorded apart from revisions, reservations and results. */
function images(): Record<string, string> {
  return Object.fromEntries(
    [
      indexPath(),
      `${indexPath()}.bak`,
      manifestPath(),
      join(root, 'a', 'workspace.json'),
      join(root, 'a', 'worktrees.json'),
    ].map((path) => [
      path,
      existsSync(path) ? readFileSync(path, 'utf8') : '<absent>',
    ]),
  );
}
function readObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`Expected an object in ${path}`);
  return parsed;
}
const manifest = (): Record<string, unknown> => readObject(manifestPath());
function cowork(): Record<string, unknown> {
  const settings = manifest().cowork;
  if (!isRecord(settings)) throw new Error('Expected Cowork settings');
  return settings;
}
/** Both Work Entries' recency, the visible residue of an Auto Delete touch. */
function touches(): unknown[] {
  const entries = readObject(entriesPath()).entries;
  return Array.isArray(entries)
    ? entries.map((entry) => (isRecord(entry) ? entry.lastTouchedAt : null))
    : [];
}
function resetTouches(): void {
  writeFileSync(
    entriesPath(),
    JSON.stringify({
      version: 1,
      entries: ['first', 'second'].map((id) => ({
        id,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastTouchedAt: STALE_TOUCH,
      })),
    }),
  );
}
const restamped = (): boolean =>
  touches().length === 2 && touches().every((touch) => touch !== STALE_TOUCH);

/** A stand-in for chat normalization, the host step before a defaults change. */
function stubNormalization(): jest.Mock {
  const normalize = jest.fn(() => Promise.resolve());
  setBeforeProjectPluginDefaultsChangeHandler(normalize);
  return normalize;
}

function decisionsOf(commits: {
  mock: { calls: ReadonlyArray<Parameters<W5CommitLogHost['commit']>> };
}): Array<Record<string, unknown>> {
  return commits.mock.calls.map(([request]) => ({
    operation: request.operation,
    receipt: request.receipt,
    reservationId: request.reservationId,
    expectedRevisions: request.expectedRevisions,
    paths: request.files.map((file) => file.path),
  }));
}

function update(
  settings: Omit<CoworkSettingsUpdateRequest, 'projectId'>,
): Promise<CoworkSettingsUpdateOutcome> {
  return updateCoworkWorkspaceSettings({ projectId: 'one', ...settings });
}

function revision(): Promise<number> {
  return host.revision(RESOURCE);
}

function receiptOf(reserve: {
  mock: { calls: ReadonlyArray<Parameters<W5CommitLogHost['reserve']>> };
}): NonNullable<Parameters<W5CommitLogHost['reserve']>[0]['receipt']> {
  const receipt = reserve.mock.calls[0]?.[0].receipt;
  if (!receipt) throw new Error('Expected a reservation');
  return receipt;
}

/** The next decision lands, but its response is lost. */
function loseNextResponse(
  failure = new Error('response lost'),
): jest.SpyInstance {
  const commit = host.commit.bind(host);
  return jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
    await commit(request);
    throw failure;
  });
}

/** The project plugin layer chat resolution reads, through its cache. */
async function cachedDefaults(): Promise<ChatTabPluginSelections> {
  const { defaultPluginSelections } = await readProjectPluginDefaults('one');
  return normalizePluginSelections(defaultPluginSelections);
}

/** The revision a running session of a chat in `one` was created under. */
function sessionRevision(): number {
  return getProjectPluginDefaultsRevision('one');
}

/** Replaces the cached layer with `value`, as a racing read would leave it. */
function cacheStaleDefaults(value: ChatTabPluginSelections | undefined): void {
  projectPluginDefaultsWritten({
    configPath: getWorkspaceConfigPath('one'),
    workspaceId: 'one',
    layerChanged: false,
  });
  void readThroughProjectPluginDefaults(
    getWorkspaceConfigPath('one'),
    (): Promise<ProjectPluginDefaultsRead> =>
      Promise.resolve({
        defaults: { defaultPluginSelections: value },
        cacheable: true,
      }),
  );
}

/** A foreign manifest write between staging and the decision's preflight. */
function armPreflightForeignWrite(): () => number {
  const read = nodeW5FileStore.read.bind(nodeW5FileStore);
  let fired = 0;
  jest.spyOn(nodeW5FileStore, 'read').mockImplementation(async (path) => {
    if (
      fired === 0 &&
      path === manifestPath() &&
      isW5FinalPreflightRead(new Error().stack ?? '')
    ) {
      fired += 1;
      writeFileSync(
        path,
        JSON.stringify({ ...manifest(), foreignField: 'foreign-write' }),
      );
    }
    return read(path);
  });
  return () => fired;
}

describe('CW2 keyed Cowork settings', () => {
  it.each([
    ['Portal sync', schedulePortalStructuralSync],
    ['sidebar invalidation', notifyPortalStructureChanged],
  ] as const)(
    'CAN-4797: runs %s after a lost response',
    async (_name, effect) => {
      const commits = loseNextResponse();
      await expect(
        update({ description: 'keyed', idempotencyKey: 'key' }),
      ).rejects.toThrow('response lost');
      expect(cowork().description).toBe('keyed');
      expect(commits).toHaveBeenCalledTimes(1);
      expect(effect).toHaveBeenCalledTimes(1);
      expect(effect).toHaveBeenCalledWith();
    },
  );

  it.each([
    ['Portal sync', schedulePortalStructuralSync],
    ['sidebar invalidation', notifyPortalStructureChanged],
  ] as const)(
    'CAN-4797: runs %s on every replay, including after restart',
    async (_name, effect) => {
      const request = { description: 'keyed', idempotencyKey: 'key' };
      await update(request);
      await updateCoworkWorkspace({ projectId: 'one', description: 'newer' });
      const applied = images();
      jest.clearAllMocks();
      for (const restart of [false, true, false]) {
        if (restart) await restartHost();
        const commits = jest.spyOn(host, 'commit').mockClear();
        jest.mocked(effect).mockClear();
        expect(await update({ ...request, expectedRevision: 999 })).toEqual(
          OUTCOME,
        );
        expect(effect).toHaveBeenCalledTimes(1);
        expect(effect).toHaveBeenCalledWith();
        expect(commits).not.toHaveBeenCalled();
        expect(images()).toEqual(applied);
        expect(cowork().description).toBe('newer');
      }
    },
  );

  it('CAN-4797: typed refusals skip Portal sync and sidebar invalidation', async () => {
    await expect(
      update({
        description: 'keyed',
        idempotencyKey: 'key',
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(W5RevisionConflictError);
    await expect(
      updateCoworkWorkspaceSettings({
        projectId: 'a',
        description: 'keyed',
        idempotencyKey: 'key',
      }),
    ).rejects.toMatchObject({ reason: 'not-found' });
    expect(schedulePortalStructuralSync).not.toHaveBeenCalled();
    expect(notifyPortalStructureChanged).not.toHaveBeenCalled();

    await update({ description: 'keyed', idempotencyKey: 'key' });
    jest.clearAllMocks();
    await expect(
      update({ description: 'changed', idempotencyKey: 'key' }),
    ).rejects.toMatchObject({ reason: 'key-reused' });
    expect(schedulePortalStructuralSync).not.toHaveBeenCalled();
    expect(notifyPortalStructureChanged).not.toHaveBeenCalled();
  });

  it.each(['lost response', 'replay'] as const)(
    'CAN-4797: %s refresh does not persist removal cleanup in another workspace',
    async (attempt) => {
      const request = { description: 'keyed', idempotencyKey: 'key' };
      if (attempt === 'replay') await update(request);
      else loseNextResponse();
      const createdAt = '2026-01-01T00:00:00.000Z';
      const worktreeId = `removed-${attempt.replace(' ', '-')}`;
      const worktreesPath = join(root, 'a', 'worktrees.json');
      writeFileSync(
        worktreesPath,
        JSON.stringify({
          version: 1,
          worktrees: [{ id: worktreeId, branchName: 'removed', createdAt }],
        }),
      );
      expect(
        isWorkspaceWorktreeRecentlyRemoved('a', worktreeId, createdAt),
      ).toBe(false);
      markWorkspaceWorktreeRecentlyRemoved('a', worktreeId, createdAt);
      const before = images();
      jest.clearAllMocks();
      const commits = jest.spyOn(host, 'commit');
      const readSidebar = SidebarItems.readAllSidebarItems;
      let sidebar: Awaited<ReturnType<typeof readSidebar>> | undefined;
      const refresh = jest
        .spyOn(SidebarItems, 'readAllSidebarItems')
        .mockImplementation(async (options) => {
          sidebar = await readSidebar(options);
          return sidebar;
        });

      const pending = update(request);
      if (attempt === 'replay') await expect(pending).resolves.toEqual(OUTCOME);
      else await expect(pending).rejects.toThrow('response lost');

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith({ persistRemovalCleanup: false });
      expect(sidebar?.items.find((item) => item.id === 'a')).toMatchObject({
        worktrees: [],
      });
      expect(sidebar?.items.find((item) => item.id === 'one')).toMatchObject({
        cowork: { description: 'keyed' },
      });
      expect(sidebar?.warnings).toBeUndefined();
      expect(commits).toHaveBeenCalledTimes(attempt === 'replay' ? 0 : 1);
      expect(readFileSync(worktreesPath, 'utf8')).toBe(before[worktreesPath]);
      expect(readFileSync(indexPath(), 'utf8')).toBe(before[indexPath()]);
      expect(await host.revision({ kind: 'workspace', workspaceId: 'a' })).toBe(
        0,
      );
      expect(await revision()).toBe(1);
      if (attempt === 'replay') expect(images()).toEqual(before);
      expect(schedulePortalStructuralSync).toHaveBeenCalledTimes(1);
      expect(notifyPortalStructureChanged).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['lost response', 'replay'] as const)(
    'CAN-4797: %s still notifies with unreadable worktree tracking',
    async (attempt) => {
      const request = { description: 'keyed', idempotencyKey: 'key' };
      if (attempt === 'replay') await update(request);
      else loseNextResponse();
      const worktreesPath = join(root, 'a', 'worktrees.json');
      const unreadable = '{broken worktree tracking';
      writeFileSync(worktreesPath, unreadable);
      jest.clearAllMocks();
      const commits = jest.spyOn(host, 'commit');

      const pending = update(request);
      if (attempt === 'replay') await expect(pending).resolves.toEqual(OUTCOME);
      else await expect(pending).rejects.toThrow('response lost');

      expect(readFileSync(worktreesPath, 'utf8')).toBe(unreadable);
      expect(commits).toHaveBeenCalledTimes(attempt === 'replay' ? 0 : 1);
      expect(schedulePortalStructuralSync).toHaveBeenCalledTimes(1);
      expect(notifyPortalStructureChanged).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['lost response', 'replay'] as const)(
    'CAN-4797: a failed sidebar refresh does not block notifications or mask the %s',
    async (attempt) => {
      const request = { description: 'keyed', idempotencyKey: 'key' };
      const responseFailure = new Error('response lost');
      if (attempt === 'replay') await update(request);
      else loseNextResponse(responseFailure);
      jest.clearAllMocks();
      const refresh = jest
        .spyOn(SidebarItems, 'readAllSidebarItems')
        .mockRejectedValueOnce(new Error('sidebar refresh failed'));

      const pending = update(request);
      if (attempt === 'replay') await expect(pending).resolves.toEqual(OUTCOME);
      else await expect(pending).rejects.toBe(responseFailure);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(schedulePortalStructuralSync).toHaveBeenCalledTimes(1);
      expect(notifyPortalStructureChanged).toHaveBeenCalledTimes(1);
    },
  );

  it('commits only the manifest, revision, receipt and outcome in one decision under the queue and archive lock', async () => {
    const commits = jest.spyOn(host, 'commit');
    const indexBefore = readFileSync(indexPath(), 'utf8');
    const first = await update({
      description: 'keyed',
      defaultPresetId: 'preset',
      startPage: { kind: 'file', path: 'README.md' },
      idempotencyKey: 'key',
      expectedRevision: 0,
    });
    expect(first).toEqual(OUTCOME);
    expect(withArchivedWorkspaceOperationLock).toHaveBeenCalledWith(
      'one',
      expect.any(Function),
    );
    expect(commits).toHaveBeenCalledTimes(1);
    const [decision] = commits.mock.calls[0] ?? [];
    expect(decision).toMatchObject({
      operation: OPERATION,
      receipt: {
        caller: 'desktop-host:chat_project_update',
        operation: OPERATION,
      },
      expectedRevisions: [{ resource: RESOURCE, revision: 0 }],
      outcome: OUTCOME,
    });
    expect(typeof decision?.reservationId).toBe('string');
    expect(decision?.files.map((file) => file.path)).toEqual([manifestPath()]);
    expect(JSON.stringify(decision?.outcome)).not.toContain(dir);
    expect(cowork()).toMatchObject({
      description: 'keyed',
      defaultPresetId: 'preset',
      startPage: { kind: 'file', path: 'README.md' },
      futureSetting: true,
    });
    // Preset-derived defaults are part of the settings decision.
    expect(manifest().defaultPluginSelections).toMatchObject({
      skillRefs: PRESET_SELECTIONS.skillRefs,
    });
    expect(readFileSync(indexPath(), 'utf8')).toBe(indexBefore);
    expect(await revision()).toBe(1);

    const applied = images();
    // Replay precedes the revision check: a stale revision still replays.
    expect(
      await update({
        description: 'keyed',
        defaultPresetId: 'preset',
        startPage: { kind: 'file', path: 'README.md' },
        idempotencyKey: 'key',
        expectedRevision: 999,
      }),
    ).toEqual(first);
    expect(images()).toEqual(applied);
    expect(commits).toHaveBeenCalledTimes(1);
  });

  it('replays after the worker restarts without undoing a later change', async () => {
    const first = await update({ description: 'keyed', idempotencyKey: 'key' });
    await updateCoworkWorkspace({ projectId: 'one', description: 'newer' });
    await restartHost();
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    expect(
      await update({ description: 'keyed', idempotencyKey: 'key' }),
    ).toEqual(first);
    expect(images()).toEqual(before);
    expect(cowork().description).toBe('newer');
    expect(commits).not.toHaveBeenCalled();
  });

  it('refuses changed parameters for a used key with unchanged bytes', async () => {
    await update({ description: 'keyed', idempotencyKey: 'key' });
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    await expect(
      update({ description: 'different', idempotencyKey: 'key' }),
    ).rejects.toMatchObject({ reason: 'key-reused' });
    await expect(
      update({
        description: 'keyed',
        autoArchiveDays: 3,
        idempotencyKey: 'key',
      }),
    ).rejects.toMatchObject({ reason: 'key-reused' });
    expect(images()).toEqual(before);
    expect(commits).not.toHaveBeenCalled();
  });

  it('refuses a stale revision before the stamp and normalization, with unchanged bytes, and releases the key', async () => {
    const normalize = stubNormalization();
    const enable = { defaultPresetId: 'preset', autoArchiveDays: 7 };
    const before = images();
    for (const idempotencyKey of [undefined, 'key']) {
      const pending = update({
        ...enable,
        idempotencyKey,
        expectedRevision: 1,
      });
      await expect(pending).rejects.toBeInstanceOf(W5RevisionConflictError);
      await expect(pending).rejects.toMatchObject({
        resource: 'workspace:one',
        expected: 1,
        actual: 0,
      });
      expect(images()).toEqual(before);
    }
    expect(normalize).not.toHaveBeenCalled();
    expect(touches()).toEqual([STALE_TOUCH, STALE_TOUCH]);
    expect(await revision()).toBe(0);
    await update({ ...enable, idempotencyKey: 'key', expectedRevision: 0 });
    expect(cowork().autoArchiveDays).toBe(7);
    expect(await revision()).toBe(1);
  });

  it('releases the key after a typed refusal in the queue', async () => {
    const before = images();
    const reserve = jest.spyOn(host, 'reserve');
    const commits = jest.spyOn(host, 'commit');
    const run = (): Promise<CoworkSettingsUpdateOutcome> =>
      updateCoworkWorkspaceSettings({
        projectId: 'a',
        description: 'keyed',
        idempotencyKey: 'key',
      });
    // `a` is indexed, but not as a Cowork workspace.
    await expect(run()).rejects.toMatchObject({ reason: 'not-found' });
    expect(await host.lookupReceipt(receiptOf(reserve))).toMatchObject({
      status: 'none',
    });
    await expect(run()).rejects.toMatchObject({ reason: 'not-found' });
    expect(commits).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
  });

  it('X6a: replays a decision whose response was lost, before and after a restart', async () => {
    const commit = host.commit.bind(host);
    const commits = jest
      .spyOn(host, 'commit')
      .mockImplementationOnce(async (request) => {
        await commit(request);
        throw new Error('response lost');
      });
    await expect(
      update({ description: 'keyed', idempotencyKey: 'key' }),
    ).rejects.toThrow('response lost');
    expect(cowork().description).toBe('keyed');
    const applied = images();
    expect(
      await update({ description: 'keyed', idempotencyKey: 'key' }),
    ).toEqual(OUTCOME);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(images()).toEqual(applied);
    await restartHost();
    const restarted = jest.spyOn(host, 'commit');
    expect(
      await update({ description: 'keyed', idempotencyKey: 'key' }),
    ).toEqual(OUTCOME);
    expect(restarted).not.toHaveBeenCalled();
    expect(images()).toEqual(applied);
  });

  it('X6a: reconciles the cached plugin layer and session revision once after a lost response; its replays repeat nothing', async () => {
    expect(await cachedDefaults()).toEqual(
      normalizePluginSelections(undefined),
    );
    const initial = sessionRevision();
    loseNextResponse();
    await expect(
      update({ defaultPresetId: 'preset', idempotencyKey: 'key' }),
    ).rejects.toThrow('response lost');
    expect(manifest().defaultPluginSelections).toMatchObject({
      skillRefs: PRESET_SELECTIONS.skillRefs,
    });
    // The writer's post-commit refresh was dropped with the response.
    expect(await cachedDefaults()).toEqual(
      normalizePluginSelections(PRESET_SELECTIONS),
    );
    expect(sessionRevision()).toBe(initial + 1);

    const replayed = images();
    for (const restart of [false, true, false]) {
      if (restart) await restartHost();
      const commits = jest.spyOn(host, 'commit').mockClear();
      expect(
        await update({ defaultPresetId: 'preset', idempotencyKey: 'key' }),
      ).toEqual(OUTCOME);
      expect(await cachedDefaults()).toEqual(
        normalizePluginSelections(PRESET_SELECTIONS),
      );
      expect(sessionRevision()).toBe(initial + 1);
      expect(commits).not.toHaveBeenCalled();
      expect(images()).toEqual(replayed);
    }
  });

  it('X6a: a replay reconciles a layer a read cached across the late application, once', async () => {
    loseNextResponse();
    await expect(
      update({ defaultPresetId: 'preset', idempotencyKey: 'key' }),
    ).rejects.toThrow('response lost');
    const replayed = images();
    for (const restart of [false, true]) {
      if (restart) await restartHost();
      const commits = jest.spyOn(host, 'commit').mockClear();
      // A read that raced the late application cached the old layer.
      cacheStaleDefaults(undefined);
      expect(await cachedDefaults()).toEqual(
        normalizePluginSelections(undefined),
      );
      const stale = sessionRevision();
      for (let replay = 0; replay < 3; replay += 1) {
        expect(
          await update({ defaultPresetId: 'preset', idempotencyKey: 'key' }),
        ).toEqual(OUTCOME);
        expect(await cachedDefaults()).toEqual(
          normalizePluginSelections(PRESET_SELECTIONS),
        );
        expect(sessionRevision()).toBe(stale + 1);
      }
      expect(commits).not.toHaveBeenCalled();
      expect(images()).toEqual(replayed);
    }
  });

  it('X6b: an attempt that died before its decision is recovery-required, diagnosed offline, and applies once after resolve', async () => {
    const before = images();
    failBeforeDecision();
    await expect(
      update({ description: 'keyed', idempotencyKey: 'key' }),
    ).rejects.toThrow('worker died before decision');
    jest.restoreAllMocks();
    await restartHost();
    expect(images()).toEqual(before);
    const blocked = jest.spyOn(host, 'commit');
    await expect(
      update({ description: 'keyed', idempotencyKey: 'key' }),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
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
    expect(
      await update({ description: 'keyed', idempotencyKey: 'key' }),
    ).toEqual(OUTCOME);
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved.mock.calls[0]?.[0].receipt).toBeDefined();
    const applied = images();
    expect(
      await update({ description: 'keyed', idempotencyKey: 'key' }),
    ).toEqual(OUTCOME);
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(images()).toEqual(applied);
  });

  it.each(['plain', 'expected'] as const)(
    'X6c-%s: after a resolve, a same-key retry over an intervening write',
    async (variant) => {
      const expectedRevision = variant === 'expected' ? 0 : undefined;
      failBeforeDecision();
      await expect(
        update({
          description: 'keyed',
          idempotencyKey: 'key',
          expectedRevision,
        }),
      ).rejects.toThrow('worker died before decision');
      jest.restoreAllMocks();
      await restartHost();

      // Another, unkeyed request intervenes.
      await updateCoworkWorkspace({ projectId: 'one', description: 'newer' });
      expect(await revision()).toBe(1);
      await expect(
        update({
          description: 'keyed',
          idempotencyKey: 'key',
          expectedRevision,
        }),
      ).rejects.toMatchObject({ reason: 'recovery-required' });

      await resolveColdRecovery();
      const intervened = images();
      const commits = jest.spyOn(host, 'commit');
      const retry = update({
        description: 'keyed',
        idempotencyKey: 'key',
        expectedRevision,
      });
      if (variant === 'plain') {
        // A first application: the last writer wins.
        await expect(retry).resolves.toEqual(OUTCOME);
        expect(commits).toHaveBeenCalledTimes(1);
        expect(cowork().description).toBe('keyed');
        const applied = images();
        await expect(
          update({ description: 'keyed', idempotencyKey: 'key' }),
        ).resolves.toEqual(OUTCOME);
        expect(commits).toHaveBeenCalledTimes(1);
        expect(images()).toEqual(applied);
      } else {
        await expect(retry).rejects.toBeInstanceOf(W5RevisionConflictError);
        expect(commits).not.toHaveBeenCalled();
        expect(images()).toEqual(intervened);
        expect(cowork().description).toBe('newer');
        // The refusal released the key.
        await expect(
          update({
            description: 'keyed',
            idempotencyKey: 'key',
            expectedRevision: 1,
          }),
        ).resolves.toEqual(OUTCOME);
        expect(commits).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('Q2(a): a failed chat normalization for preset-derived defaults leaves the key recovery-required and the manifest unchanged', async () => {
    setBeforeProjectPluginDefaultsChangeHandler(() =>
      Promise.reject(new Error('chat normalization failed')),
    );
    const before = images();
    const served = await cachedDefaults();
    const initial = sessionRevision();
    const reserve = jest.spyOn(host, 'reserve');
    const commits = jest.spyOn(host, 'commit');
    await expect(
      update({ defaultPresetId: 'preset', idempotencyKey: 'key' }),
    ).rejects.toThrow(PROJECT_PLUGIN_DEFAULTS_NORMALIZATION_FAILED);
    expect(commits).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
    // The failure's reconcile finds the layer it served unchanged.
    expect(await cachedDefaults()).toEqual(served);
    expect(sessionRevision()).toBe(initial);
    expect(await host.lookupReceipt(receiptOf(reserve))).toMatchObject({
      status: 'recovery-required',
      diagnostics: { operation: OPERATION },
    });
  });

  it('CW2: a preflight conflict after the stamp and normalization releases the key; the retry repeats both and commits one decision; a replay does neither', async () => {
    const normalize = stubNormalization();
    const reserve = jest.spyOn(host, 'reserve');
    const commits = jest.spyOn(host, 'commit');
    const fired = armPreflightForeignWrite();
    const enable = {
      defaultPresetId: 'preset',
      autoArchiveDays: 7,
      idempotencyKey: 'key',
    };
    await expect(update(enable)).rejects.toMatchObject({
      reason: 'fingerprint-conflict',
      path: manifestPath(),
    });
    expect(fired()).toBe(1);
    expect(commits).not.toHaveBeenCalled();
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(schedulePortalStructuralSync).not.toHaveBeenCalled();
    expect(notifyPortalStructureChanged).not.toHaveBeenCalled();
    expect(restamped()).toBe(true);
    expect(cowork()).not.toHaveProperty('autoArchiveDays');
    expect(manifest()).not.toHaveProperty('defaultPluginSelections');
    expect(await host.lookupReceipt(receiptOf(reserve))).toMatchObject({
      status: 'none',
    });
    expect(await revision()).toBe(0);

    jest.restoreAllMocks();
    const retried = jest.spyOn(host, 'commit');
    resetTouches();
    expect(await update(enable)).toEqual(OUTCOME);
    expect(normalize).toHaveBeenCalledTimes(2);
    expect(restamped()).toBe(true);
    // Under A28′(a) the keyed request cannot rename, so its decision holds the
    // manifest alone; the r6 prototype's index files came from a rename.
    const decisions = decisionsOf(retried);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      operation: OPERATION,
      receipt: { idempotencyKey: 'key' },
      expectedRevisions: undefined,
      paths: [manifestPath()],
    });
    expect(typeof decisions[0]?.reservationId).toBe('string');
    expect(cowork()).toMatchObject({
      autoArchiveDays: 7,
      defaultPresetId: 'preset',
    });
    expect(manifest()).toMatchObject({ foreignField: 'foreign-write' });

    const applied = images();
    resetTouches();
    expect(await update(enable)).toEqual(OUTCOME);
    expect(retried).toHaveBeenCalledTimes(1);
    expect(normalize).toHaveBeenCalledTimes(2);
    expect(touches()).toEqual([STALE_TOUCH, STALE_TOUCH]);
    expect(images()).toEqual(applied);
  });

  it('a failed Auto Delete stamp is a typed refusal before staging and normalization that releases the key; the retry stamps and commits one decision', async () => {
    const normalize = stubNormalization();
    const reserve = jest.spyOn(host, 'reserve');
    const commits = jest.spyOn(host, 'commit');
    // The real stamp fails on an unreadable Work Entries registry.
    writeFileSync(entriesPath(), '{"version":1,"entries":');
    const stampFailure = await touchAllWorkspaceTargets('one').then(
      () => 'no failure',
      (error: unknown) => (error instanceof Error ? error.message : 'untyped'),
    );
    expect(stampFailure).not.toBe('no failure');
    const before = images();
    const enable = {
      defaultPresetId: 'preset',
      autoArchiveDays: 7,
      idempotencyKey: 'key',
    };
    await expect(update(enable)).rejects.toMatchObject({
      name: 'CoworkWorkspaceRecordRefusedError',
      reason: 'activity-unavailable',
      message: stampFailure,
    });
    expect(commits).not.toHaveBeenCalled();
    expect(normalize).not.toHaveBeenCalled();
    expect(schedulePortalStructuralSync).not.toHaveBeenCalled();
    expect(notifyPortalStructureChanged).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
    expect(await revision()).toBe(0);
    expect(await host.lookupReceipt(receiptOf(reserve))).toMatchObject({
      status: 'none',
    });
    // The unkeyed save fails the same way and keeps its message.
    await expect(
      updateCoworkWorkspace({ projectId: 'one', autoArchiveDays: 7 }),
    ).rejects.toMatchObject({
      reason: 'activity-unavailable',
      message: stampFailure,
    });
    expect(images()).toEqual(before);

    resetTouches();
    expect(await update(enable)).toEqual(OUTCOME);
    expect(restamped()).toBe(true);
    expect(normalize).toHaveBeenCalledTimes(1);
    const decisions = decisionsOf(commits);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      operation: OPERATION,
      receipt: { idempotencyKey: 'key' },
      paths: [manifestPath()],
    });
    expect(cowork().autoArchiveDays).toBe(7);
  });
});

describe('refusal before reservation', () => {
  it.each<[string, Partial<UpdateChatProjectRequest>]>([
    ['name', { name: 'Renamed' }],
    ['color', { color: '#0EA5E9' }],
    ['alwaysShow', { alwaysShow: false }],
    [
      'explicit plugin defaults',
      { defaultPluginSelections: EXPLICIT_SELECTIONS },
    ],
    [
      'an invalid start page',
      { startPage: { kind: 'file', path: '../secret' } },
    ],
  ])(
    'refuses %s with no receipt lookup or reservation',
    async (_label, extra) => {
      const before = images();
      const lookup = jest.spyOn(host, 'lookupReceipt');
      const reserve = jest.spyOn(host, 'reserve');
      const commits = jest.spyOn(host, 'commit');
      await expect(
        update({ description: 'keyed', ...extra, idempotencyKey: 'key' }),
      ).rejects.toMatchObject({ reason: 'invalid-request' });
      expect(lookup).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
      expect(commits).not.toHaveBeenCalled();
      expect(images()).toEqual(before);
      // The key was never consumed.
      expect(
        await update({ description: 'keyed', idempotencyKey: 'key' }),
      ).toEqual(OUTCOME);
    },
  );

  it('refuses standalone options inside a parent commit scope before reservation', async () => {
    const reserve = jest.spyOn(host, 'reserve');
    const commits = jest.spyOn(host, 'commit');
    const before = images();
    for (const options of [
      { idempotencyKey: 'key' },
      { expectedRevision: 0 },
      {},
    ]) {
      await expect(
        withW5Commit({ operation: 'parent' }, () =>
          update({ description: 'keyed', ...options }),
        ),
      ).rejects.toMatchObject({ reason: 'invalid-request' });
    }
    expect(reserve).not.toHaveBeenCalled();
    expect(commits).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
  });
});

describe('CW0/CW1 compatibility: updateCoworkWorkspace stays unkeyed', () => {
  const mixed: UpdateChatProjectRequest = {
    projectId: 'one',
    name: '  Renamed  ',
    color: '#0EA5E9',
    alwaysShow: false,
    defaultPluginSelections: EXPLICIT_SELECTIONS,
    description: 'mixed',
  };
  const MANIFEST_WRITE = 'w5.workspace_manifest.write';
  const INDEX_WRITE = 'w5.workspace_index.write';
  const receiptless = (
    operation: string,
    paths: string[],
  ): Record<string, unknown> => ({
    operation,
    receipt: undefined,
    reservationId: undefined,
    expectedRevisions: undefined,
    paths,
  });

  it('CW0: a mixed save is two receipt-less decisions, manifest then index, and ignores untyped retry fields', async () => {
    const reserve = jest.spyOn(host, 'reserve');
    const commits = jest.spyOn(host, 'commit');
    const payload: UpdateChatProjectRequest = Object.assign(
      { ...mixed },
      { idempotencyKey: 'key', expectedRevision: 999 },
    );
    await updateCoworkWorkspace(payload);
    expect(reserve).not.toHaveBeenCalled();
    expect(decisionsOf(commits)).toEqual([
      receiptless(MANIFEST_WRITE, [manifestPath()]),
      receiptless(INDEX_WRITE, [indexPath(), `${indexPath()}.bak`]),
    ]);
    expect(manifest()).toMatchObject({
      alwaysShow: false,
      defaultPluginSelections: { skillRefs: EXPLICIT_SELECTIONS.skillRefs },
    });
    expect(cowork()).toMatchObject({
      description: 'mixed',
      futureSetting: true,
    });
    expect(readObject(indexPath())).toMatchObject({
      workspaces: [{}, { name: 'Renamed', color: '#0EA5E9' }],
    });
  });

  it('CW1: enabling Auto Delete with a rename stamps recency even when the manifest preflight refuses; a plain retry stamps again and commits', async () => {
    const commits = jest.spyOn(host, 'commit');
    const fired = armPreflightForeignWrite();
    const request = { projectId: 'one', name: 'Renamed', autoArchiveDays: 7 };
    await expect(updateCoworkWorkspace(request)).rejects.toMatchObject({
      reason: 'fingerprint-conflict',
    });
    expect(fired()).toBe(1);
    expect(commits).not.toHaveBeenCalled();
    expect(readObject(indexPath())).toMatchObject({
      workspaces: [{}, { name: 'One' }],
    });
    expect(cowork()).not.toHaveProperty('autoArchiveDays');
    expect(restamped()).toBe(true);

    resetTouches();
    await updateCoworkWorkspace(request);
    expect(restamped()).toBe(true);
    expect(decisionsOf(commits)).toEqual([
      receiptless(MANIFEST_WRITE, [manifestPath()]),
      receiptless(INDEX_WRITE, [indexPath(), `${indexPath()}.bak`]),
    ]);
    expect(cowork().autoArchiveDays).toBe(7);
    expect(readObject(indexPath())).toMatchObject({
      workspaces: [{}, { name: 'Renamed' }],
    });
  });

  it('keeps the install save of explicit defaults one receipt-less manifest decision; the keyed entry refuses it', async () => {
    const reserve = jest.spyOn(host, 'reserve');
    const commits = jest.spyOn(host, 'commit');
    const install = {
      projectId: 'one',
      defaultPluginSelections: EXPLICIT_SELECTIONS,
    };
    await expect(
      updateCoworkWorkspaceSettings({ ...install, idempotencyKey: 'key' }),
    ).rejects.toMatchObject({ reason: 'invalid-request' });
    await updateCoworkWorkspace(install);
    expect(reserve).not.toHaveBeenCalled();
    expect(decisionsOf(commits)).toEqual([
      receiptless(MANIFEST_WRITE, [manifestPath()]),
    ]);
    expect(manifest()).toMatchObject({
      defaultPluginSelections: { skillRefs: EXPLICIT_SELECTIONS.skillRefs },
    });
  });

  it('keeps the fork save one decision under its parent operation', async () => {
    const reserve = jest.spyOn(host, 'reserve');
    const commits = jest.spyOn(host, 'commit');
    await updateCoworkWorkspace(
      { projectId: 'one', startPage: { kind: 'file', path: 'README.md' } },
      { operation: 'core.workspace.fork' },
    );
    expect(reserve).not.toHaveBeenCalled();
    expect(decisionsOf(commits)).toEqual([
      receiptless('core.workspace.fork', [manifestPath()]),
    ]);
    expect(cowork().startPage).toEqual({ kind: 'file', path: 'README.md' });
  });
});

describe('the replay reconcile waits within a bound, then hands off to the background (CAN-4409 D1)', () => {
  const BOUND = { passes: 3, deadlineMs: 250 };
  const PRESET = normalizePluginSelections(PRESET_SELECTIONS);
  const request = { defaultPresetId: 'preset', idempotencyKey: 'key' };

  beforeEach(() => {
    __setInlinePluginDefaultsReconcileBoundForTests(BOUND);
  });
  afterEach(async () => {
    __setInlinePluginDefaultsReconcileBoundForTests(undefined);
    await settleDetachedWork();
  });

  /** A lost keyed decision, then a read that cached the old layer. */
  async function staleAfterLostResponse(): Promise<number> {
    loseNextResponse();
    await expect(update(request)).rejects.toThrow('response lost');
    cacheStaleDefaults(undefined);
    expect(await cachedDefaults()).toEqual(
      normalizePluginSelections(undefined),
    );
    return sessionRevision();
  }

  it('a replay behind a commit that never settles returns within the bound; chat reads serve the manifest and the revision advances once', async () => {
    loseNextResponse();
    await expect(update(request)).rejects.toThrow('response lost');
    const stalled = await stalledManifestCommit('one');
    cacheStaleDefaults(undefined);
    expect(await cachedDefaults()).toEqual(
      normalizePluginSelections(undefined),
    );
    const stale = sessionRevision();

    await expect(settlesWithin(update(request))).resolves.toEqual(OUTCOME);
    expect(sessionRevision()).toBe(stale);
    expect(await cachedDefaults()).toEqual(PRESET);
    // The other refreshes still ran.
    expect(schedulePortalStructuralSync).toHaveBeenCalled();
    expect(notifyPortalStructureChanged).toHaveBeenCalled();

    await stalled.release();
    await settleDetachedWork();
    expect(sessionRevision()).toBe(stale + 1);
    for (let replay = 0; replay < 2; replay += 1) {
      await expect(update(request)).resolves.toEqual(OUTCOME);
      await settleDetachedWork();
      expect(await cachedDefaults()).toEqual(PRESET);
      expect(sessionRevision()).toBe(stale + 1);
    }
  });

  it('repeated replays behind a commit that never settles keep one hand-off, and one background read decides them all', async () => {
    const stale = await staleAfterLostResponse();
    const stalled = await stalledManifestCommit('one');
    for (let replay = 0; replay < 3; replay += 1)
      await expect(settlesWithin(update(request))).resolves.toEqual(OUTCOME);
    const retained = __pluginDefaultsHandOffsForTests('one');

    const loads = jest.spyOn(
      workspacePersistence,
      'readWorkspaceConfigDetailed',
    );
    await stalled.release();
    await settleDetachedWork();
    expect(retained).toBe(1);
    expect(loads).toHaveBeenCalledTimes(1);
    expect(__pluginDefaultsHandOffsForTests('one')).toBe(0);
    expect(sessionRevision()).toBe(stale + 1);
    expect(await cachedDefaults()).toEqual(PRESET);
  });

  it('a replay hand-off left undecided by an unreadable manifest is retried once a later replay decides inline, and the layer settles', async () => {
    const stale = await staleAfterLostResponse();
    const stalled = await stalledManifestCommit('one');
    await expect(settlesWithin(update(request))).resolves.toEqual(OUTCOME);
    const readable = readFileSync(manifestPath(), 'utf8');
    writeFileSync(manifestPath(), '{ not json');
    await stalled.release();
    await settleDetachedWork();
    expect(__pluginDefaultsHandOffsForTests('one')).toBe(1);
    writeFileSync(manifestPath(), readable);

    await expect(update(request)).resolves.toEqual(OUTCOME);
    await settleDetachedWork();
    expect(__pluginDefaultsHandOffsForTests('one')).toBe(0);
    expect(sessionRevision()).toBe(stale + 1);
    expect(await cachedDefaults()).toEqual(PRESET);
    const loads = jest.spyOn(
      workspacePersistence,
      'readWorkspaceConfigDetailed',
    );
    expect(await cachedDefaults()).toEqual(PRESET);
    expect(loads).not.toHaveBeenCalled();
  });

  it('a replay while commits keep landing stops at the pass bound, and the background advances the revision once', async () => {
    const stale = await staleAfterLostResponse();
    const commits = commitsLandingOnEveryPass();
    await expect(settlesWithin(update(request))).resolves.toEqual(OUTCOME);
    expect(commits.passes()).toBe(BOUND.passes);
    await settleDetachedWork();
    expect(await cachedDefaults()).toEqual(PRESET);
    expect(sessionRevision()).toBe(stale + 1);
    await update(request);
    expect(sessionRevision()).toBe(stale + 1);
  });
});
