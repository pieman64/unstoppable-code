// CAN-4409: keyed replay and revisions of the core.workspace.plugins.update
// user changes (setDefaults, selectRecommended), a one-decision boundary,
// with the real commit-log worker and filesystem. The server move stays
// unkeyed; the marketplace prune is keyed per workspace only with its
// fan-out's request ID (CAN-4717).
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { W5CommitLog } from '@canopy/desktop-shared/node/w5-commit-log';
import { withStorageOwnershipChange } from '@canopy/desktop-shared/node/lib/storage-admission';
import type {
  ChatTabPluginSelections,
  ChatTabsFile,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { AsyncResource } from 'node:async_hooks';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
}));

/**
 * The chat state service behind the real normalization handler: one tabs
 * file per scope, counting the updates that changed it. `afterWrite` stands
 * in for the chat commit observers, which run in the writer's context.
 */
const mockChats: {
  scopes: Map<string, ChatTabsFile>;
  updates: number;
  writes: number;
  afterWrite?: (scope: { projectId: string; worktreeId: string }) => unknown;
} = { scopes: new Map(), updates: 0, writes: 0 };
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): object => ({
    updateCompatibilityTabs: async (
      scope: { projectId: string; worktreeId: string },
      update: (tabsFile: ChatTabsFile) => ChatTabsFile,
    ): Promise<ChatTabsFile> => {
      const current = mockChats.scopes.get(scope.worktreeId);
      if (!current) throw new Error(`No chat scope ${scope.worktreeId}`);
      mockChats.updates += 1;
      const next = update(current);
      if (next !== current) {
        mockChats.writes += 1;
        mockChats.scopes.set(scope.worktreeId, next);
        await mockChats.afterWrite?.(scope);
      }
      return next;
    },
  }),
}));
jest.mock('../../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
// An unreadable discovery index makes the handler load every scope, so a
// second normalization is measured by what it writes, not by a skip.
jest.mock('../chat-storage-discovery', () => ({
  ...jest.requireActual<object>('../chat-storage-discovery'),
  chatStorageScopeIds: (): Promise<string[]> =>
    Promise.resolve(Array.from(mockChats.scopes.keys())),
  readChatStorageDiscoveryIndex: (): Promise<never> =>
    Promise.reject(new Error('index unreadable')),
}));

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  W5FileWriteRefusedError,
  W5RevisionConflictError,
  withW5Commit,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { normalizeWorkspaceChatsForInheritedPluginDefaults } from '../inherited-plugin-defaults-normalization';
import { recordWorkspaceCrudTelemetry } from '../desktop-telemetry';
import {
  PROJECT_PLUGIN_DEFAULTS_NORMALIZATION_FAILED,
  readProjectPluginDefaults,
  setBeforeProjectPluginDefaultsChangeHandler,
  updateWorkspaceConfig,
} from '../workspace-persistence';
import * as workspacePersistence from '../workspace-persistence';
import { diagnoseW5State } from '../w5-maintenance-diagnosis';
import { afterW5Commit, currentW5CommitScope } from '../w5-commit-scope';
import { touchWorkspaceTargetAfterCommit } from '../workspace-activity';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { registerChatPersistenceHandlers } from '../../ipc/chat-persistence';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import {
  projectPluginDefaultsWritten,
  readThroughProjectPluginDefaults,
  type ProjectPluginDefaultsRead,
} from '../../plugins/project-plugin-defaults-cache';
import * as pluginDefaultsCache from '../../plugins/project-plugin-defaults-cache';
import { getProjectPluginDefaultsRevision } from '../../plugins/plugin-defaults-revision';
import { getWorkspaceConfigPath } from '../paths';
import {
  updateWorkspacePlugins,
  WorkspacePluginsRefusedError,
  type WorkspacePluginsChange,
  type WorkspacePluginsSource,
  type WorkspacePluginsUpdateOutcome,
  type WorkspacePluginsUserChange,
} from '../workspace-plugin-defaults';

jest.setTimeout(90_000);
let dir: string;
let root: string;
let dbPath: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;

const OPERATION = 'core.workspace.plugins.update';
const RESOURCE = { kind: 'workspace', workspaceId: 'a' } as const;

function startHost(): void {
  host = new W5CommitLogHost({
    dbPath,
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  __resetSidebarItemsStateForTests();
}

beforeEach(() => {
  ({ dir, root } = createW5BoundaryFixture());
  dbPath = join(dir, 'data', 'w5', 'commit-log.sqlite');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  mockChats.scopes = new Map();
  mockChats.updates = 0;
  mockChats.writes = 0;
  delete mockChats.afterWrite;
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

const manifestPath = (): string => join(root, 'a', 'workspace.json');

function images(): string[] {
  return ['index.json', 'a/workspace.json', 'a/worktrees.json'].map((file) =>
    readFileSync(join(root, file), 'utf8'),
  );
}

function manifest(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath(), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('Expected a manifest object');
  return { ...parsed };
}

function selections(
  overrides: Partial<ChatTabPluginSelections> = {},
): ChatTabPluginSelections {
  return { collectionIds: [], skillRefs: [], pluginRefs: [], ...overrides };
}

const OLD_DEFAULTS = selections({
  pluginRefs: [{ marketplaceId: 'm', pluginName: 'old' }],
});
const NEW_DEFAULTS = selections({
  pluginRefs: [{ marketplaceId: 'm', pluginName: 'new' }],
});

/** The persisted `defaultPluginSelections` of the given selections. */
function persisted(value: ChatTabPluginSelections): Record<string, unknown> {
  return {
    collectionIds: value.collectionIds,
    skillRefs: value.skillRefs,
    pluginRefs: value.pluginRefs,
  };
}

function setDefaults(
  defaultPluginSelections: ChatTabPluginSelections,
  options: { expectedRevision?: number; idempotencyKey?: string } = {},
): Promise<WorkspacePluginsUpdateOutcome> {
  return updateWorkspacePlugins({
    ...options,
    workspaceId: 'a',
    change: { kind: 'setDefaults', defaultPluginSelections },
    source: 'project_settings',
  });
}

const RECOMMENDED: Extract<
  WorkspacePluginsChange,
  { kind: 'selectRecommended' }
> = {
  kind: 'selectRecommended',
  selections: [{ kind: 'skill', sourceId: 'github-org', skillName: 'review' }],
  optOutKeys: ['opt-out'],
  clearOptOutKeys: [],
};
const RECOMMENDED_SKILL_REFS = [
  { sourceId: 'github-org', skillName: 'review' },
];

function selectRecommended(
  change: Extract<
    WorkspacePluginsChange,
    { kind: 'selectRecommended' }
  > = RECOMMENDED,
  options: { expectedRevision?: number; idempotencyKey?: string } = {},
): Promise<WorkspacePluginsUpdateOutcome> {
  return updateWorkspacePlugins({
    ...options,
    workspaceId: 'a',
    change,
    source: 'recommended_plugins',
  });
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

/** Seeds the old defaults with a plain manifest write. */
async function seedDefaults(): Promise<void> {
  await updateWorkspaceConfig('a', (config): void => {
    config.defaultPluginSelections = OLD_DEFAULTS;
  });
}

/** Counts the stub normalizations of a defaults change. */
function countNormalizations(): jest.Mock<Promise<void>, []> {
  const normalize = jest.fn((): Promise<void> => Promise.resolve());
  setBeforeProjectPluginDefaultsChangeHandler(normalize);
  return normalize;
}

/** A foreign manifest write between staging and the decision's preflight. */
function armPreflightForeignWrite(): {
  fired: () => number;
  restore: () => void;
} {
  const read = nodeW5FileStore.read.bind(nodeW5FileStore);
  let fired = 0;
  const spy = jest.spyOn(nodeW5FileStore, 'read');
  spy.mockImplementation(async (path) => {
    if (
      fired === 0 &&
      path === manifestPath() &&
      /w5-commit-log-file-store\.ts:182:/.test(new Error().stack ?? '')
    ) {
      fired += 1;
      writeFileSync(
        path,
        JSON.stringify({ ...manifest(), foreignField: 'foreign-write' }),
      );
    }
    return read(path);
  });
  return { fired: () => fired, restore: () => spy.mockRestore() };
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

/** The next decision lands, but its response is lost. */
function loseNextResponse(): void {
  const commit = host.commit.bind(host);
  jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
    await commit(request);
    throw new Error('response lost');
  });
}

/** The project plugin layer chat resolution reads, through its cache. */
async function cachedDefaults(): Promise<ChatTabPluginSelections> {
  const { defaultPluginSelections } = await readProjectPluginDefaults('a');
  return normalizePluginSelections(defaultPluginSelections);
}

/** The revision a running session of a chat in workspace `a` was created under. */
function sessionRevision(): number {
  return getProjectPluginDefaultsRevision('a');
}

/** Replaces the cached layer with `value`, as a racing read would leave it. */
function cacheStaleDefaults(value: ChatTabPluginSelections): void {
  projectPluginDefaultsWritten({
    configPath: getWorkspaceConfigPath('a'),
    workspaceId: 'a',
    layerChanged: false,
  });
  void readThroughProjectPluginDefaults(
    getWorkspaceConfigPath('a'),
    (): Promise<ProjectPluginDefaultsRead> =>
      Promise.resolve({
        defaults: { defaultPluginSelections: value },
        cacheable: true,
      }),
  );
}

function barrier(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

interface Hold {
  /** Resolves once the held step has run up to its hold. */
  reached: Promise<void>;
  release: () => void;
}

const readWorkspaceConfigDetailedActual =
  workspacePersistence.readWorkspaceConfigDetailed;
const manifestRepository =
  workspacePersistence.getWorkspaceManifestRepository();
const readManifestActual = manifestRepository.read.bind(manifestRepository);
const projectPluginDefaultsWrittenActual =
  pluginDefaultsCache.projectPluginDefaultsWritten;

/** Holds the reconcile's next manifest read after it read the file. */
function holdReconcileRead(): Hold {
  const reached = barrier();
  const gate = barrier();
  jest
    .spyOn(workspacePersistence, 'readWorkspaceConfigDetailed')
    .mockImplementationOnce(async (workspaceId) => {
      const detail = await readWorkspaceConfigDetailedActual(workspaceId);
      reached.open();
      await gate.promise;
      return detail;
    });
  return { reached: reached.promise, release: gate.open };
}

/** Holds the next manifest read of any reader after it read the file. */
function holdManifestRead(): Hold {
  const reached = barrier();
  const gate = barrier();
  jest
    .spyOn(manifestRepository, 'read')
    .mockImplementationOnce(async (workspaceId) => {
      const read = await readManifestActual(workspaceId);
      reached.open();
      await gate.promise;
      return read;
    });
  return { reached: reached.promise, release: gate.open };
}

/**
 * A session created as production creates one: the revision is stamped
 * synchronously, then the provider reads the layer after an await. The read
 * is held after it loaded the manifest, before the cache records it.
 */
async function stampedSessionReadHeld(): Promise<{
  session: Promise<{ revision: number; layer: ChatTabPluginSelections }>;
  release: () => void;
}> {
  const read = holdManifestRead();
  const revision = sessionRevision();
  const session = (async (): Promise<{
    revision: number;
    layer: ChatTabPluginSelections;
  }> => {
    await Promise.resolve();
    return { revision, layer: await cachedDefaults() };
  })();
  await read.reached;
  return { session, release: read.release };
}

/**
 * Runs every queued microtask. A step that waits on no lock, commit or I/O
 * has run by then, so its absence is a deterministic signal.
 */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type ReconcileStep = 'queue' | 'settling' | 'read';

/**
 * Which of `steps` the next reconcile reaches first: asking for the manifest
 * queue, finding commits of the manifest still settling, or finishing its
 * read. Each is an event, so the order needs no time bound.
 */
function nextReconcileStep(...steps: ReconcileStep[]): Promise<ReconcileStep> {
  const first = barrier();
  let step: ReconcileStep | undefined;
  const reach = (reached: ReconcileStep): void => {
    if (!steps.includes(reached)) return;
    step ??= reached;
    first.open();
  };
  const reconcile = pluginDefaultsCache.reconcileProjectPluginDefaults;
  jest
    .spyOn(pluginDefaultsCache, 'reconcileProjectPluginDefaults')
    .mockImplementationOnce((write) =>
      reconcile({
        ...write,
        serialize: (work) => {
          reach('queue');
          return write.serialize(work);
        },
        committing: () => {
          const settling = write.committing();
          if (settling.length > 0) reach('settling');
          return settling;
        },
        load: async () => {
          const read = await write.load();
          reach('read');
          return read;
        },
      }),
    );
  return first.promise.then((): ReconcileStep => step ?? 'read');
}

/** Resolves when the next caller asks for the manifest queue; it goes through. */
function nextManifestQueueRequest(): Promise<void> {
  const requested = barrier();
  const serialize = manifestRepository.serialize.bind(manifestRepository);
  jest
    .spyOn(manifestRepository, 'serialize')
    .mockImplementationOnce((workspaceId, work) => {
      requested.open();
      return serialize(workspaceId, work);
    });
  return requested.promise;
}

/** Holds the next writer's post-commit plugin cache refresh. */
function holdNextRefresh(): Hold {
  const reached = barrier();
  const gate = barrier();
  // The writer awaits its post-commit callback, which returns this promise.
  jest
    .spyOn(pluginDefaultsCache, 'projectPluginDefaultsWritten')
    .mockImplementationOnce(async (write) => {
      reached.open();
      await gate.promise;
      projectPluginDefaultsWrittenActual(write);
    });
  return { reached: reached.promise, release: gate.open };
}

function legacyChat(id: string): PersistedChatTab {
  return {
    id,
    title: 'Chat',
    createdAt: '2026-09-01T00:00:00.000Z',
    messages: [],
    pluginSelections: selections({
      pluginRefs: [{ marketplaceId: 'm', pluginName: 'old' }],
    }),
  };
}

describe('setDefaults', () => {
  it('saves the change, revision, receipt and outcome in one decision and replays it without a write', async () => {
    await seedDefaults();
    const normalize = countNormalizations();
    const commits = jest.spyOn(host, 'commit');
    const first = await setDefaults(NEW_DEFAULTS, {
      idempotencyKey: 'key',
      expectedRevision: 1,
    });
    expect(first).toEqual({
      workspaceId: 'a',
      written: true,
      defaultPluginSelections: NEW_DEFAULTS,
      recommendedPluginOptOutKeys: [],
    });
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(commits).toHaveBeenCalledTimes(1);
    const [decision] = commits.mock.calls[0] ?? [];
    expect(decision).toMatchObject({
      operation: OPERATION,
      receipt: {
        caller: 'desktop-host:project_settings',
        operation: OPERATION,
      },
      expectedRevisions: [{ resource: RESOURCE, revision: 1 }],
      outcome: first,
    });
    expect(typeof decision?.reservationId).toBe('string');
    expect(decision?.files.map((file) => file.path)).toEqual([manifestPath()]);
    expect(JSON.stringify(decision?.outcome)).not.toContain(dir);
    expect(manifest().defaultPluginSelections).toEqual(persisted(NEW_DEFAULTS));
    expect(await revision()).toBe(2);
    expect(recordWorkspaceCrudTelemetry).toHaveBeenCalledTimes(1);

    const before = images();
    // Replay precedes the revision check: a stale revision still replays.
    expect(
      await setDefaults(NEW_DEFAULTS, {
        idempotencyKey: 'key',
        expectedRevision: 999,
      }),
    ).toEqual(first);
    expect(images()).toEqual(before);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(normalize).toHaveBeenCalledTimes(1);
    // Telemetry stays outside the receipt.
    expect(recordWorkspaceCrudTelemetry).toHaveBeenCalledTimes(2);
  });

  it('replays after the worker restarts without undoing a later change', async () => {
    const first = await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' });
    await setDefaults(OLD_DEFAULTS);
    await restartHost();
    const normalize = countNormalizations();
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    expect(await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' })).toEqual(
      first,
    );
    expect(images()).toEqual(before);
    expect(manifest().defaultPluginSelections).toEqual(persisted(OLD_DEFAULTS));
    expect(commits).not.toHaveBeenCalled();
    expect(normalize).not.toHaveBeenCalled();
  });

  it('refuses changed parameters for a used key with unchanged bytes and no normalization', async () => {
    await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' });
    const normalize = countNormalizations();
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    await expect(
      setDefaults(OLD_DEFAULTS, { idempotencyKey: 'key' }),
    ).rejects.toMatchObject({ reason: 'key-reused' });
    // The same caller's key for the other user change is reused too.
    await expect(
      updateWorkspacePlugins({
        workspaceId: 'a',
        change: RECOMMENDED,
        source: 'project_settings',
        idempotencyKey: 'key',
      }),
    ).rejects.toMatchObject({ reason: 'key-reused' });
    expect(images()).toEqual(before);
    expect(commits).not.toHaveBeenCalled();
    expect(normalize).not.toHaveBeenCalled();
  });

  it('fingerprints the persisted shape, so an equivalent payload replays', async () => {
    const legacy: ChatTabPluginSelections = {
      collectionIds: ['c1'],
      bundleIds: ['c1', 'c2'],
      skillRefs: [{ sourceId: 'builtin', skillName: 'review' }],
      pluginRefs: [],
    };
    const first = await setDefaults(legacy, { idempotencyKey: 'key' });
    // The saved outcome is the persisted shape, the same on every replay.
    expect(first.defaultPluginSelections).toEqual({
      collectionIds: ['c1', 'c2'],
      skillRefs: [{ sourceId: 'builtin:app', skillName: 'review' }],
      pluginRefs: [],
    });
    expect(manifest().defaultPluginSelections).toEqual(
      first.defaultPluginSelections,
    );
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    expect(
      await setDefaults(
        selections({
          collectionIds: ['c1', 'c2'],
          skillRefs: [{ sourceId: 'builtin:app', skillName: 'review' }],
        }),
        { idempotencyKey: 'key' },
      ),
    ).toEqual(first);
    await restartHost();
    expect(await setDefaults(legacy, { idempotencyKey: 'key' })).toEqual(first);
    expect(commits).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
  });

  it('refuses a stale revision before normalization with unchanged bytes and releases the key', async () => {
    await seedDefaults();
    const normalize = countNormalizations();
    const before = images();
    for (const idempotencyKey of [undefined, 'key']) {
      const pending = setDefaults(NEW_DEFAULTS, {
        idempotencyKey,
        expectedRevision: 0,
      });
      await expect(pending).rejects.toBeInstanceOf(W5RevisionConflictError);
      await expect(pending).rejects.toMatchObject({
        resource: 'workspace:a',
        expected: 0,
        actual: 1,
      });
      expect(images()).toEqual(before);
    }
    expect(normalize).not.toHaveBeenCalled();
    expect(await revision()).toBe(1);
    await setDefaults(NEW_DEFAULTS, {
      idempotencyKey: 'key',
      expectedRevision: 1,
    });
    expect(manifest().defaultPluginSelections).toEqual(persisted(NEW_DEFAULTS));
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(await revision()).toBe(2);
  });

  it('releases the key when the decision itself refuses a stale revision after normalization', async () => {
    await seedDefaults();
    const normalize = countNormalizations();
    const before = images();
    // The preflight passes; the worker's decision sees the newer revision.
    jest.spyOn(host, 'revision').mockResolvedValueOnce(2);
    const commits = jest.spyOn(host, 'commit');
    await expect(
      setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key', expectedRevision: 2 }),
    ).rejects.toBeInstanceOf(W5RevisionConflictError);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(images()).toEqual(before);
    expect(await revision()).toBe(1);
    await setDefaults(NEW_DEFAULTS, {
      idempotencyKey: 'key',
      expectedRevision: 1,
    });
    expect(normalize).toHaveBeenCalledTimes(2);
    expect(await revision()).toBe(2);
  });

  it('X5: without a key, a preflight conflict after normalization writes nothing and the retry normalizes again', async () => {
    await seedDefaults();
    const normalize = countNormalizations();
    const commits = jest.spyOn(host, 'commit');
    const armed = armPreflightForeignWrite();
    await expect(setDefaults(NEW_DEFAULTS)).rejects.toBeInstanceOf(
      W5FileWriteRefusedError,
    );
    expect(armed.fired()).toBe(1);
    expect(commits).not.toHaveBeenCalled();
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(manifest()).toMatchObject({
      foreignField: 'foreign-write',
      defaultPluginSelections: persisted(OLD_DEFAULTS),
    });
    armed.restore();
    await setDefaults(NEW_DEFAULTS);
    expect(normalize).toHaveBeenCalledTimes(2);
    expect(manifest()).toMatchObject({
      foreignField: 'foreign-write',
      defaultPluginSelections: persisted(NEW_DEFAULTS),
    });
  });

  it('X5k: a preflight conflict after normalization releases the key; the retry normalizes again and commits; the replay runs nothing', async () => {
    await seedDefaults();
    const normalize = countNormalizations();
    const reserve = jest.spyOn(host, 'reserve');
    const commits = jest.spyOn(host, 'commit');
    const armed = armPreflightForeignWrite();
    await expect(
      setDefaults(NEW_DEFAULTS, { idempotencyKey: 'pk' }),
    ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    expect(armed.fired()).toBe(1);
    expect(commits).not.toHaveBeenCalled();
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(manifest()).toMatchObject({
      foreignField: 'foreign-write',
      defaultPluginSelections: persisted(OLD_DEFAULTS),
    });
    expect(await host.lookupReceipt(receiptOf(reserve))).toMatchObject({
      status: 'none',
    });
    expect(await revision()).toBe(1);

    armed.restore();
    const retried = await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'pk' });
    expect(retried).toMatchObject({ workspaceId: 'a', written: true });
    expect(normalize).toHaveBeenCalledTimes(2);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(manifest()).toMatchObject({
      foreignField: 'foreign-write',
      defaultPluginSelections: persisted(NEW_DEFAULTS),
    });

    const applied = images();
    expect(await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'pk' })).toEqual(
      retried,
    );
    expect(normalize).toHaveBeenCalledTimes(2);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(images()).toEqual(applied);
  });

  it('X5k with the real normalization handler: the retry normalization over already normalized chats writes nothing', async () => {
    await seedDefaults();
    mockChats.scopes.set('wt-1', {
      version: 1,
      activeTabId: 'legacy',
      tabs: [legacyChat('legacy')],
    });
    setBeforeProjectPluginDefaultsChangeHandler(
      normalizeWorkspaceChatsForInheritedPluginDefaults,
    );
    const commits = jest.spyOn(host, 'commit');
    const armed = armPreflightForeignWrite();
    await expect(
      setDefaults(NEW_DEFAULTS, { idempotencyKey: 'pk' }),
    ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    expect(commits).not.toHaveBeenCalled();
    // The completed normalization precedes the decision and stays.
    expect(mockChats).toMatchObject({ updates: 1, writes: 1 });
    const normalized = mockChats.scopes.get('wt-1');
    expect(normalized?.tabs[0]).toMatchObject({
      inheritedPluginDefaultsVersion: 1,
    });

    armed.restore();
    await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'pk' });
    // The second normalization read the chats again and wrote nothing.
    expect(mockChats).toMatchObject({ updates: 2, writes: 1 });
    expect(mockChats.scopes.get('wt-1')).toBe(normalized);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(manifest().defaultPluginSelections).toEqual(persisted(NEW_DEFAULTS));

    await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'pk' });
    expect(mockChats).toMatchObject({ updates: 2, writes: 1 });
    expect(commits).toHaveBeenCalledTimes(1);
  });

  it('CW3: a normalization failure leaves a keyed attempt recovery-required with 0 commits; an unkeyed retry applies', async () => {
    await seedDefaults();
    setBeforeProjectPluginDefaultsChangeHandler(() =>
      Promise.reject(new Error('a chat scope could not be normalized')),
    );
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    const reserve = jest.spyOn(host, 'reserve');
    const first = setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' });
    await expect(first).rejects.toThrow(
      PROJECT_PLUGIN_DEFAULTS_NORMALIZATION_FAILED,
    );
    await expect(first).rejects.not.toBeInstanceOf(
      WorkspacePluginsRefusedError,
    );
    expect(commits).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
    expect(await host.lookupReceipt(receiptOf(reserve))).toMatchObject({
      status: 'recovery-required',
      diagnostics: { operation: OPERATION, errorName: 'Error' },
    });

    setBeforeProjectPluginDefaultsChangeHandler(undefined);
    await expect(
      setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' }),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(images()).toEqual(before);
    expect(commits).not.toHaveBeenCalled();

    await expect(setDefaults(NEW_DEFAULTS)).resolves.toMatchObject({
      written: true,
    });
    expect(manifest().defaultPluginSelections).toEqual(persisted(NEW_DEFAULTS));
  });

  it('without a key writes the same bytes as the plain manifest write, with no receipt', async () => {
    const original = readFileSync(manifestPath(), 'utf8');
    await updateWorkspaceConfig('a', (config): void => {
      config.defaultPluginSelections = NEW_DEFAULTS;
    });
    const plain = readFileSync(manifestPath(), 'utf8');
    writeFileSync(manifestPath(), original);

    const commits = jest.spyOn(host, 'commit');
    await setDefaults(NEW_DEFAULTS);
    expect(readFileSync(manifestPath(), 'utf8')).toBe(plain);
    expect(commits).toHaveBeenCalledTimes(1);
    // It is the plain manifest write, outside any boundary scope.
    expect(commits.mock.calls[0]?.[0]).toMatchObject({
      operation: 'w5.workspace_manifest.write',
      receipt: undefined,
      reservationId: undefined,
      expectedRevisions: undefined,
      outcome: null,
    });
    // The same defaults again write nothing and make no decision.
    await setDefaults(NEW_DEFAULTS);
    expect(commits).toHaveBeenCalledTimes(1);
  });

  it('checks a current revision without a key and advances it', async () => {
    const commits = jest.spyOn(host, 'commit');
    await setDefaults(NEW_DEFAULTS, { expectedRevision: 0 });
    expect(commits.mock.calls[0]?.[0]).toMatchObject({
      receipt: undefined,
      expectedRevisions: [{ resource: RESOURCE, revision: 0 }],
    });
    expect(await revision()).toBe(1);
  });

  it('saves a keyed unchanged change as a receipt-only decision and replays it', async () => {
    await setDefaults(NEW_DEFAULTS);
    const normalize = countNormalizations();
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    const outcome = await setDefaults(NEW_DEFAULTS, {
      idempotencyKey: 'key',
      expectedRevision: 1,
    });
    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits.mock.calls[0]?.[0].files).toEqual([]);
    // Unchanged defaults need no normalization.
    expect(normalize).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
    expect(await revision()).toBe(1);
    await restartHost();
    const restarted = jest.spyOn(host, 'commit');
    expect(await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' })).toEqual(
      outcome,
    );
    expect(restarted).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
  });

  it('holds manifest storage admission from operation entry until it settles', async () => {
    const reserve = host.reserve.bind(host);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reserving: () => void = () => {};
    const reservingStarted = new Promise<void>((resolve) => {
      reserving = resolve;
    });
    jest.spyOn(host, 'reserve').mockImplementationOnce(async (input) => {
      reserving();
      await gate;
      return reserve(input);
    });
    const events: string[] = [];
    const pending = setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' });
    await reservingStarted;
    const change = withStorageOwnershipChange(['workspace_manifest'], () => {
      events.push(
        `ownership change, applied=${String(
          manifest().defaultPluginSelections !== undefined,
        )}`,
      );
    });
    // An unheld namespace would have let the change run by now.
    await drainMicrotasks();
    expect(events).toEqual([]);
    release();
    await Promise.all([pending, change]);
    expect(events).toEqual(['ownership change, applied=true']);
  });

  it('refuses a same-key attempt while the first is deciding, then replays it', async () => {
    const commit = host.commit.bind(host);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let deciding: () => void = () => {};
    const decidingStarted = new Promise<void>((resolve) => {
      deciding = resolve;
    });
    jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
      deciding();
      await gate;
      return commit(request);
    });
    const first = setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' });
    await decidingStarted;
    await expect(
      setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' }),
    ).rejects.toMatchObject({ reason: 'in-progress' });
    release();
    const outcome = await first;
    const before = images();
    expect(await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' })).toEqual(
      outcome,
    );
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
      setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' }),
    ).rejects.toThrow('response lost');
    expect(manifest().defaultPluginSelections).toEqual(persisted(NEW_DEFAULTS));
    expect(await revision()).toBe(1);
    // A later unkeyed change the replays must not undo.
    await setDefaults(OLD_DEFAULTS);
    const superseded = images();
    expect(commits).toHaveBeenCalledTimes(2);
    const normalize = countNormalizations();
    const saved = {
      workspaceId: 'a',
      written: true,
      defaultPluginSelections: NEW_DEFAULTS,
      recommendedPluginOptOutKeys: [],
    };
    expect(await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' })).toEqual(
      saved,
    );
    await restartHost();
    const restarted = jest.spyOn(host, 'commit');
    expect(await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' })).toEqual(
      saved,
    );
    expect(images()).toEqual(superseded);
    expect(commits).toHaveBeenCalledTimes(2);
    expect(restarted).not.toHaveBeenCalled();
    expect(normalize).not.toHaveBeenCalled();
  });

  it('X6a: reconciles the cached plugin layer and session revision once after a lost response; its replays repeat nothing', async () => {
    await seedDefaults();
    expect(await cachedDefaults()).toEqual(
      normalizePluginSelections(OLD_DEFAULTS),
    );
    const initial = sessionRevision();
    loseNextResponse();
    await expect(
      setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' }),
    ).rejects.toThrow('response lost');
    expect(manifest().defaultPluginSelections).toEqual(persisted(NEW_DEFAULTS));
    // The writer's post-commit refresh was dropped with the response.
    expect(await cachedDefaults()).toEqual(
      normalizePluginSelections(NEW_DEFAULTS),
    );
    expect(sessionRevision()).toBe(initial + 1);

    const replayed = images();
    const reconciled = sessionRevision();
    for (const restart of [false, false, true, false]) {
      if (restart) await restartHost();
      const commits = jest.spyOn(host, 'commit').mockClear();
      await expect(
        setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' }),
      ).resolves.toMatchObject({ written: true });
      // A chat turn between retries resolves the inherited layer.
      expect(await cachedDefaults()).toEqual(
        normalizePluginSelections(NEW_DEFAULTS),
      );
      expect(sessionRevision()).toBe(reconciled);
      expect(commits).not.toHaveBeenCalled();
      expect(images()).toEqual(replayed);
    }
  });

  it('X6a: a replay reconciles a layer a read cached across the late application, once', async () => {
    await seedDefaults();
    loseNextResponse();
    await expect(
      setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' }),
    ).rejects.toThrow('response lost');
    const replayed = images();
    for (const restart of [false, true]) {
      if (restart) await restartHost();
      const commits = jest.spyOn(host, 'commit').mockClear();
      // A read that raced the late application cached the old layer.
      cacheStaleDefaults(OLD_DEFAULTS);
      expect(await cachedDefaults()).toEqual(
        normalizePluginSelections(OLD_DEFAULTS),
      );
      const stale = sessionRevision();
      for (let replay = 0; replay < 3; replay += 1) {
        await expect(
          setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' }),
        ).resolves.toMatchObject({ written: true });
        expect(await cachedDefaults()).toEqual(
          normalizePluginSelections(NEW_DEFAULTS),
        );
        expect(sessionRevision()).toBe(stale + 1);
      }
      expect(commits).not.toHaveBeenCalled();
      expect(images()).toEqual(replayed);
    }
  });

  it('replays an acknowledged write without advancing the session revision again, before and after a restart', async () => {
    await seedDefaults();
    expect(await cachedDefaults()).toEqual(
      normalizePluginSelections(OLD_DEFAULTS),
    );
    const initial = sessionRevision();
    const first = await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' });
    expect(sessionRevision()).toBe(initial + 1);
    const applied = images();
    const commits = jest.spyOn(host, 'commit');
    // Before any read, then with a chat turn between retries.
    expect(await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' })).toEqual(
      first,
    );
    expect(sessionRevision()).toBe(initial + 1);
    for (const restart of [false, false, true, false]) {
      if (restart) await restartHost();
      expect(await cachedDefaults()).toEqual(
        normalizePluginSelections(NEW_DEFAULTS),
      );
      expect(
        await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' }),
      ).toEqual(first);
      expect(sessionRevision()).toBe(initial + 1);
    }
    expect(commits).not.toHaveBeenCalled();
    expect(images()).toEqual(applied);

    // A later change advances it once; replays of the earlier key do not.
    await setDefaults(OLD_DEFAULTS);
    expect(sessionRevision()).toBe(initial + 2);
    for (let replay = 0; replay < 2; replay += 1) {
      expect(await cachedDefaults()).toEqual(
        normalizePluginSelections(OLD_DEFAULTS),
      );
      await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' });
      expect(sessionRevision()).toBe(initial + 2);
    }
  });

  it('replays a saved no-op outcome without advancing the session revision', async () => {
    await setDefaults(NEW_DEFAULTS);
    expect(await cachedDefaults()).toEqual(
      normalizePluginSelections(NEW_DEFAULTS),
    );
    const initial = sessionRevision();
    const commits = jest.spyOn(host, 'commit');
    const outcome = await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' });
    // Unchanged bytes: a receipt-only decision.
    expect(commits.mock.calls[0]?.[0].files).toEqual([]);
    expect(sessionRevision()).toBe(initial);
    for (const restart of [false, true, false]) {
      if (restart) await restartHost();
      expect(
        await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' }),
      ).toEqual(outcome);
      expect(await cachedDefaults()).toEqual(
        normalizePluginSelections(NEW_DEFAULTS),
      );
      expect(sessionRevision()).toBe(initial);
    }
  });

  it('leaves the cached layer and session revision alone for key reuse, refusals and failures that landed nothing', async () => {
    await seedDefaults();
    await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'used' });
    expect(await cachedDefaults()).toEqual(
      normalizePluginSelections(NEW_DEFAULTS),
    );
    const initial = sessionRevision();
    const unchanged = async (): Promise<void> => {
      expect(sessionRevision()).toBe(initial);
      expect(await cachedDefaults()).toEqual(
        normalizePluginSelections(NEW_DEFAULTS),
      );
    };

    await expect(
      setDefaults(OLD_DEFAULTS, { idempotencyKey: 'used' }),
    ).rejects.toMatchObject({ reason: 'key-reused' });
    await unchanged();
    await expect(
      setDefaults(OLD_DEFAULTS, {
        idempotencyKey: 'stale',
        expectedRevision: 0,
      }),
    ).rejects.toBeInstanceOf(W5RevisionConflictError);
    await unchanged();
    jest.spyOn(host, 'revision').mockResolvedValueOnce(3);
    await expect(
      setDefaults(OLD_DEFAULTS, {
        idempotencyKey: 'raced',
        expectedRevision: 3,
      }),
    ).rejects.toBeInstanceOf(W5RevisionConflictError);
    await unchanged();
    const armed = armPreflightForeignWrite();
    await expect(
      setDefaults(OLD_DEFAULTS, { idempotencyKey: 'file' }),
    ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    armed.restore();
    await unchanged();

    // Staged, then failed without a decision: the attempt may have landed,
    // so the layer is checked, and found unchanged.
    const error = Object.assign(new Error('worker failed'), { code: 'EIO' });
    jest.spyOn(host, 'commit').mockRejectedValueOnce(error);
    await expect(
      setDefaults(OLD_DEFAULTS, { idempotencyKey: 'failed' }),
    ).rejects.toBe(error);
    await unchanged();
    failBeforeDecision();
    await expect(
      setDefaults(OLD_DEFAULTS, { idempotencyKey: 'died' }),
    ).rejects.toThrow('worker died before decision');
    jest.restoreAllMocks();
    await restartHost();
    await unchanged();
    for (const key of ['failed', 'died']) {
      await expect(
        setDefaults(OLD_DEFAULTS, { idempotencyKey: key }),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      await unchanged();
    }
    expect(manifest().defaultPluginSelections).toEqual(persisted(NEW_DEFAULTS));
  });

  it('a replay advances the session revision once when reads at it served two layers', async () => {
    await seedDefaults();
    await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' });
    // A session created now inherits the new layer.
    expect(await cachedDefaults()).toEqual(
      normalizePluginSelections(NEW_DEFAULTS),
    );
    const initial = sessionRevision();
    // A layer change that landed without its refresh, then a write that
    // leaves the layer alone: the next read serves the other layer at the
    // same revision.
    writeFileSync(
      manifestPath(),
      JSON.stringify({ ...manifest(), defaultPluginSelections: OLD_DEFAULTS }),
    );
    await updateWorkspaceConfig('a', (config): void => {
      config.recommendedPluginOptOutKeys = ['unrelated'];
    });
    expect(sessionRevision()).toBe(initial);
    expect(await cachedDefaults()).toEqual(
      normalizePluginSelections(OLD_DEFAULTS),
    );
    for (let replay = 0; replay < 3; replay += 1) {
      await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' });
      expect(sessionRevision()).toBe(initial + 1);
      expect(await cachedDefaults()).toEqual(
        normalizePluginSelections(OLD_DEFAULTS),
      );
    }
  });

  it('when the reconcile after a lost response cannot read the manifest, its replay advances the session revision once', async () => {
    await seedDefaults();
    expect(await cachedDefaults()).toEqual(
      normalizePluginSelections(OLD_DEFAULTS),
    );
    const initial = sessionRevision();
    loseNextResponse();
    jest
      .spyOn(workspacePersistence, 'readWorkspaceConfigDetailed')
      .mockRejectedValueOnce(new Error('read failed'));
    await expect(
      setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' }),
    ).rejects.toThrow('response lost');
    // The failed read decides nothing, but the stale layer is dropped.
    expect(sessionRevision()).toBe(initial);
    expect(await cachedDefaults()).toEqual(
      normalizePluginSelections(NEW_DEFAULTS),
    );
    for (let replay = 0; replay < 2; replay += 1) {
      await expect(
        setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' }),
      ).resolves.toMatchObject({ written: true });
      expect(await cachedDefaults()).toEqual(
        normalizePluginSelections(NEW_DEFAULTS),
      );
      expect(sessionRevision()).toBe(initial + 1);
    }
  });

  it('refreshes the cached plugin layer after a lost response with a revision and no key', async () => {
    await seedDefaults();
    expect(await cachedDefaults()).toEqual(
      normalizePluginSelections(OLD_DEFAULTS),
    );
    const initial = getProjectPluginDefaultsRevision('a');
    loseNextResponse();
    await expect(
      setDefaults(NEW_DEFAULTS, { expectedRevision: 1 }),
    ).rejects.toThrow('response lost');
    expect(await revision()).toBe(2);
    expect(await cachedDefaults()).toEqual(
      normalizePluginSelections(NEW_DEFAULTS),
    );
    expect(getProjectPluginDefaultsRevision('a')).toBeGreaterThan(initial);
  });

  it('keeps the cached plugin layer and session revision when the decision refuses', async () => {
    await seedDefaults();
    // A cached layer the manifest does not hold shows whether it was dropped.
    const marker = selections({
      pluginRefs: [{ marketplaceId: 'm', pluginName: 'cached' }],
    });
    cacheStaleDefaults(marker);
    const initial = getProjectPluginDefaultsRevision('a');
    jest.spyOn(host, 'revision').mockResolvedValueOnce(2);
    await expect(
      setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key', expectedRevision: 2 }),
    ).rejects.toBeInstanceOf(W5RevisionConflictError);
    expect(await cachedDefaults()).toEqual(normalizePluginSelections(marker));
    expect(getProjectPluginDefaultsRevision('a')).toBe(initial);
    expect(manifest().defaultPluginSelections).toEqual(persisted(OLD_DEFAULTS));
  });

  it('X6b: an attempt that died before its decision is recovery-required after restart, reported offline, and applies once after resolve', async () => {
    const before = images();
    failBeforeDecision();
    await expect(
      setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' }),
    ).rejects.toThrow('worker died before decision');
    jest.restoreAllMocks();
    await restartHost();
    expect(images()).toEqual(before);
    const commits = jest.spyOn(host, 'commit');
    await expect(
      setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' }),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(images()).toEqual(before);
    expect(commits).not.toHaveBeenCalled();

    await host.shutdown();
    const diagnosis = await diagnoseW5State(join(dir, 'data'));
    expect(diagnosis.reservations).toEqual([
      expect.objectContaining({ state: 'recovery-required' }),
    ]);
    expect(diagnosis.commits).toEqual([]);

    await resolveColdRecovery();
    const resolved = jest.spyOn(host, 'commit');
    const applied = await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' });
    expect(applied).toMatchObject({ written: true });
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved.mock.calls[0]?.[0].receipt).toBeDefined();
    const after = images();
    expect(await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' })).toEqual(
      applied,
    );
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(images()).toEqual(after);
  });

  it.each(['plain', 'expected'] as const)(
    'X6c-%s: after a resolve, a same-key retry over an intervening write',
    async (variant) => {
      const expectedRevision = variant === 'expected' ? 0 : undefined;
      failBeforeDecision();
      await expect(
        setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key', expectedRevision }),
      ).rejects.toThrow('worker died before decision');
      jest.restoreAllMocks();
      await restartHost();
      expect(manifest()).not.toHaveProperty('defaultPluginSelections');

      // Another, unkeyed request intervenes.
      await setDefaults(OLD_DEFAULTS);
      expect(await revision()).toBe(1);
      await expect(
        setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key', expectedRevision }),
      ).rejects.toMatchObject({ reason: 'recovery-required' });

      await resolveColdRecovery();
      const commits = jest.spyOn(host, 'commit');
      const retry = setDefaults(NEW_DEFAULTS, {
        idempotencyKey: 'key',
        expectedRevision,
      });
      if (variant === 'plain') {
        // A first application: the last writer wins.
        await expect(retry).resolves.toMatchObject({ written: true });
        expect(commits).toHaveBeenCalledTimes(1);
        expect(commits.mock.calls[0]?.[0].receipt).toBeDefined();
        expect(manifest().defaultPluginSelections).toEqual(
          persisted(NEW_DEFAULTS),
        );
        const applied = images();
        await setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' });
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
        expect(manifest().defaultPluginSelections).toEqual(
          persisted(OLD_DEFAULTS),
        );
        expect(await revision()).toBe(1);
        // The refusal released the key.
        await expect(
          setDefaults(NEW_DEFAULTS, {
            idempotencyKey: 'key',
            expectedRevision: 1,
          }),
        ).resolves.toMatchObject({ written: true });
        expect(commits).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('marks a failed decision recovery-required at once, as diagnosed offline', async () => {
    const reserve = jest.spyOn(host, 'reserve');
    const error = Object.assign(new Error('worker failed'), { code: 'EIO' });
    jest.spyOn(host, 'commit').mockRejectedValueOnce(error);
    await expect(
      setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' }),
    ).rejects.toBe(error);
    expect(await host.lookupReceipt(receiptOf(reserve))).toMatchObject({
      status: 'recovery-required',
      diagnostics: { operation: OPERATION, errorCode: 'EIO' },
    });
    const before = images();
    await expect(
      setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' }),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(images()).toEqual(before);
    await host.shutdown();
    const diagnosis = await diagnoseW5State(join(dir, 'data'));
    expect(diagnosis.reservations).toHaveLength(1);
    expect(diagnosis.reservations[0]?.state).toBe('recovery-required');
    startHost();
  });

  it('lets one of two keyed changes at the same revision land and releases the other key', async () => {
    const results = await Promise.allSettled([
      setDefaults(NEW_DEFAULTS, {
        idempotencyKey: 'first',
        expectedRevision: 0,
      }),
      setDefaults(OLD_DEFAULTS, {
        idempotencyKey: 'second',
        expectedRevision: 0,
      }),
    ]);
    const refused = results.filter((result) => result.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reason).toBeInstanceOf(W5RevisionConflictError);
    expect(await revision()).toBe(1);
    const loser = results[0]?.status === 'rejected' ? 'first' : 'second';
    await setDefaults(loser === 'first' ? NEW_DEFAULTS : OLD_DEFAULTS, {
      idempotencyKey: loser,
      expectedRevision: 1,
    });
    expect(await revision()).toBe(2);
    expect(manifest().defaultPluginSelections).toEqual(
      persisted(loser === 'first' ? NEW_DEFAULTS : OLD_DEFAULTS),
    );
  });
});

describe('the replay reconcile against concurrent reads and writes', () => {
  const OLD = normalizePluginSelections(OLD_DEFAULTS);
  const NEW = normalizePluginSelections(NEW_DEFAULTS);

  /** The old layer, a keyed change that leaves it, and a read serving it. */
  async function servedOldWithNoOpKey(): Promise<number> {
    await setDefaults(OLD_DEFAULTS);
    await expect(
      setDefaults(OLD_DEFAULTS, { idempotencyKey: 'key' }),
    ).resolves.toMatchObject({ written: true });
    expect(await cachedDefaults()).toEqual(OLD);
    return sessionRevision();
  }

  it('a layer change requested while a replay reconciles lands after its comparison and advances the revision once', async () => {
    const initial = await servedOldWithNoOpKey();
    const reconcileRead = holdReconcileRead();
    const replay = setDefaults(OLD_DEFAULTS, { idempotencyKey: 'key' });
    // The reconcile read the old layer inside the manifest queue.
    await reconcileRead.reached;
    const queued = nextManifestQueueRequest();
    const manifestReads = jest.spyOn(manifestRepository, 'read');
    const change = setDefaults(NEW_DEFAULTS);
    await queued;
    // An open queue would have started the change's manifest read by now.
    await drainMicrotasks();
    // A session reads while the change waits for the queue.
    const during = {
      changeReadTheManifest: manifestReads.mock.calls.length > 0,
      served: await cachedDefaults(),
      manifest: manifest().defaultPluginSelections,
      revision: sessionRevision(),
    };
    reconcileRead.release();
    await expect(replay).resolves.toMatchObject({ written: true });
    await change;
    expect({ during, revision: sessionRevision() }).toEqual({
      during: {
        changeReadTheManifest: false,
        served: OLD,
        manifest: persisted(OLD_DEFAULTS),
        revision: initial,
      },
      revision: initial + 1,
    });
    expect(await cachedDefaults()).toEqual(NEW);
    for (const restart of [false, true]) {
      if (restart) await restartHost();
      await setDefaults(OLD_DEFAULTS, { idempotencyKey: 'key' });
      expect(await cachedDefaults()).toEqual(NEW);
      expect(sessionRevision()).toBe(initial + 1);
    }
    expect(manifest().defaultPluginSelections).toEqual(persisted(NEW_DEFAULTS));
  });

  it('a replay waiting for a read in flight while a layer change lands compares only what was served since, and advances nothing', async () => {
    const initial = await servedOldWithNoOpKey();
    // An unrelated write drops the cached layer; a session read of the old
    // layer is then in flight.
    await updateWorkspaceConfig('a', (config): void => {
      config.recommendedPluginOptOutKeys = ['unrelated'];
    });
    const inFlight = await stampedSessionReadHeld();
    const replay = setDefaults(OLD_DEFAULTS, { idempotencyKey: 'key' });
    let replaySettled = false;
    void replay.then(
      (): void => {
        replaySettled = true;
      },
      (): void => {
        replaySettled = true;
      },
    );
    // The change lands and advances the revision; a session reads it.
    await setDefaults(NEW_DEFAULTS);
    expect(sessionRevision()).toBe(initial + 1);
    expect(await cachedDefaults()).toEqual(NEW);
    await drainMicrotasks();
    // The replay compares only after the read in flight settles.
    expect(replaySettled).toBe(false);
    inFlight.release();
    // That session was stamped before the advance, so it is recreated: the
    // old layer it read is not compared at the advanced revision.
    expect(await inFlight.session).toEqual({ revision: initial, layer: OLD });
    await replay;
    expect(sessionRevision()).toBe(initial + 1);
    expect(await cachedDefaults()).toEqual(NEW);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await setDefaults(OLD_DEFAULTS, { idempotencyKey: 'key' });
      expect(await cachedDefaults()).toEqual(NEW);
      expect(sessionRevision()).toBe(initial + 1);
    }
  });

  const OTHER_DEFAULTS = selections({
    pluginRefs: [{ marketplaceId: 'm', pluginName: 'other' }],
  });

  function keyedChange(
    kind: WorkspacePluginsUserChange['kind'],
  ): Promise<WorkspacePluginsUpdateOutcome> {
    return kind === 'setDefaults'
      ? setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' })
      : selectRecommended(RECOMMENDED, { idempotencyKey: 'key' });
  }

  it.each(['setDefaults', 'selectRecommended'] as const)(
    'B1 %s: a session read in flight across an acknowledged change, stamped before it, leaves its replays advancing nothing, before and after a restart',
    async (kind) => {
      await seedDefaults();
      expect(await cachedDefaults()).toEqual(OLD);
      // A write leaving the layer alone drops the cached layer.
      await updateWorkspaceConfig('a', (config): void => {
        config.recommendedPluginOptOutKeys = ['unrelated'];
      });
      const initial = sessionRevision();
      const inFlight = await stampedSessionReadHeld();
      const saved = await keyedChange(kind);
      expect(saved).toMatchObject({ written: true });
      expect(sessionRevision()).toBe(initial + 1);
      inFlight.release();
      expect(await inFlight.session).toEqual({ revision: initial, layer: OLD });
      const savedLayer = normalizePluginSelections(
        manifest().defaultPluginSelections,
      );
      expect(savedLayer).not.toEqual(OLD);
      expect(await cachedDefaults()).toEqual(savedLayer);
      for (const restart of [false, false, true, false]) {
        if (restart) await restartHost();
        const commits = jest.spyOn(host, 'commit').mockClear();
        expect(await keyedChange(kind)).toEqual(saved);
        expect(commits).not.toHaveBeenCalled();
        expect(sessionRevision()).toBe(initial + 1);
        expect(await cachedDefaults()).toEqual(savedLayer);
      }
    },
  );

  it.each(['setDefaults', 'selectRecommended'] as const)(
    'B3 %s: after another writer settled an owed refresh while a session read was in flight, the replay advances nothing',
    async (kind) => {
      await seedDefaults();
      expect(await cachedDefaults()).toEqual(OLD);
      const initial = sessionRevision();
      loseNextResponse();
      jest
        .spyOn(workspacePersistence, 'readWorkspaceConfigDetailed')
        .mockRejectedValueOnce(new Error('read failed'));
      await expect(keyedChange(kind)).rejects.toThrow('response lost');
      // Owed at `initial`; the failed reconcile dropped the cached layer.
      expect(sessionRevision()).toBe(initial);
      const savedLayer = normalizePluginSelections(
        manifest().defaultPluginSelections,
      );
      const inFlight = await stampedSessionReadHeld();
      // The other writer's advance follows the landing, settling the mark.
      await setDefaults(OTHER_DEFAULTS);
      expect(sessionRevision()).toBe(initial + 1);
      const other = normalizePluginSelections(OTHER_DEFAULTS);
      expect(await cachedDefaults()).toEqual(other);
      inFlight.release();
      expect(await inFlight.session).toEqual({
        revision: initial,
        layer: savedLayer,
      });
      const commits = jest.spyOn(host, 'commit').mockClear();
      for (let replay = 0; replay < 2; replay += 1) {
        await expect(keyedChange(kind)).resolves.toMatchObject({
          written: true,
        });
        expect(sessionRevision()).toBe(initial + 1);
        expect(await cachedDefaults()).toEqual(other);
      }
      expect(commits).not.toHaveBeenCalled();
    },
  );

  it('after a lost response, a change back requested while the attempt reconciles lands after it; back and forth, replays repeat nothing', async () => {
    await seedDefaults();
    expect(await cachedDefaults()).toEqual(OLD);
    const initial = sessionRevision();
    loseNextResponse();
    const reconcileRead = holdReconcileRead();
    const attempt = setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' });
    // The attempt's own reconcile after the lost response read the new layer.
    await reconcileRead.reached;
    const back = setDefaults(OLD_DEFAULTS);
    expect(await cachedDefaults()).toEqual(OLD);
    reconcileRead.release();
    await expect(attempt).rejects.toThrow('response lost');
    await back;
    // One advance for the landed change, one for the change back.
    expect(sessionRevision()).toBe(initial + 2);
    expect(await cachedDefaults()).toEqual(OLD);

    await setDefaults(NEW_DEFAULTS);
    expect(sessionRevision()).toBe(initial + 3);
    const commits = jest.spyOn(host, 'commit').mockClear();
    for (const restart of [false, true, false]) {
      if (restart) await restartHost();
      expect(await cachedDefaults()).toEqual(NEW);
      await expect(
        setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' }),
      ).resolves.toMatchObject({ written: true });
      expect(sessionRevision()).toBe(initial + 3);
    }
    expect(commits).not.toHaveBeenCalled();
  });

  it('a session read the cache dropped, still in flight across a replay, is compared once it served', async () => {
    await setDefaults(OLD_DEFAULTS);
    await expect(
      setDefaults(OLD_DEFAULTS, { idempotencyKey: 'key' }),
    ).resolves.toMatchObject({ written: true });
    const initial = sessionRevision();
    const sessionRead = holdManifestRead();
    const session = cachedDefaults();
    await sessionRead.reached;
    // A change that landed without its refresh, then an unrelated write that
    // drops the cached read without advancing the revision.
    writeFileSync(
      manifestPath(),
      JSON.stringify({ ...manifest(), defaultPluginSelections: NEW_DEFAULTS }),
    );
    await updateWorkspaceConfig('a', (config): void => {
      config.recommendedPluginOptOutKeys = ['unrelated'];
    });
    expect(sessionRevision()).toBe(initial);
    const replay = setDefaults(OLD_DEFAULTS, { idempotencyKey: 'key' });
    sessionRead.release();
    expect(await session).toEqual(OLD);
    await replay;
    expect(sessionRevision()).toBe(initial + 1);
    expect(await cachedDefaults()).toEqual(NEW);
    await setDefaults(OLD_DEFAULTS, { idempotencyKey: 'key' });
    expect(sessionRevision()).toBe(initial + 1);
  });

  it('an external change during a reconcile is reconciled by the next replay, once', async () => {
    const initial = await servedOldWithNoOpKey();
    const reconcileRead = holdReconcileRead();
    const replay = setDefaults(OLD_DEFAULTS, { idempotencyKey: 'key' });
    await reconcileRead.reached;
    // Another process changes the layer; nothing in this one observes it.
    writeFileSync(
      manifestPath(),
      JSON.stringify({ ...manifest(), defaultPluginSelections: NEW_DEFAULTS }),
    );
    expect(await cachedDefaults()).toEqual(OLD);
    reconcileRead.release();
    await replay;
    expect(sessionRevision()).toBe(initial);
    expect(await cachedDefaults()).toEqual(NEW);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await setDefaults(OLD_DEFAULTS, { idempotencyKey: 'key' });
      expect(sessionRevision()).toBe(initial + 1);
      expect(await cachedDefaults()).toEqual(NEW);
    }
  });

  it('a replay while an unkeyed change has landed but not refreshed waits for that refresh and advances nothing more', async () => {
    const initial = await servedOldWithNoOpKey();
    const refresh = holdNextRefresh();
    const write = setDefaults(NEW_DEFAULTS);
    // The change landed; its refresh, inside the manifest queue, has not run.
    await refresh.reached;
    expect(manifest().defaultPluginSelections).toEqual(persisted(NEW_DEFAULTS));
    const step = nextReconcileStep('queue', 'read');
    const replay = setDefaults(OLD_DEFAULTS, { idempotencyKey: 'key' });
    // A reconcile not held by the queue reads, and decides, before the refresh.
    const first = await step;
    refresh.release();
    await write;
    await replay;
    expect({ first, revision: sessionRevision() }).toEqual({
      first: 'queue',
      revision: initial + 1,
    });
    expect(await cachedDefaults()).toEqual(NEW);
  });

  it('a same-key replay while the original still refreshes the cache waits for that refresh and advances nothing more', async () => {
    await seedDefaults();
    expect(await cachedDefaults()).toEqual(OLD);
    const initial = sessionRevision();
    const refresh = holdNextRefresh();
    const original = setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' });
    // The decision landed; its refresh has not run.
    await refresh.reached;
    expect(manifest().defaultPluginSelections).toEqual(persisted(NEW_DEFAULTS));
    const step = nextReconcileStep('settling', 'read');
    const replay = setDefaults(NEW_DEFAULTS, { idempotencyKey: 'key' });
    // The queue is free: only the settling commit can hold the read back.
    const first = await step;
    refresh.release();
    const outcome = await original;
    await expect(replay).resolves.toEqual(outcome);
    expect({ first, revision: sessionRevision() }).toEqual({
      first: 'settling',
      revision: initial + 1,
    });
    expect(await cachedDefaults()).toEqual(NEW);
  });

  /** Another W5 commit of the manifest that changes the plugin layer. */
  function otherW5LayerChange(
    beforeWrite: () => Promise<void> = () => Promise.resolve(),
  ): Promise<void> {
    return withW5Commit(
      {
        operation: 'test.manifest',
        locks: [{ kind: 'manifest', path: manifestPath() }],
      },
      async () => {
        await beforeWrite();
        await updateWorkspaceConfig('a', (config): void => {
          config.defaultPluginSelections = NEW_DEFAULTS;
        });
      },
    );
  }

  it('a replay while another W5 commit still refreshes a layer change after the queue waits for it and advances nothing more', async () => {
    const initial = await servedOldWithNoOpKey();
    const refresh = holdNextRefresh();
    const other = otherW5LayerChange();
    // It landed and released the queue; its refresh has not run.
    await refresh.reached;
    expect(manifest().defaultPluginSelections).toEqual(persisted(NEW_DEFAULTS));
    const step = nextReconcileStep('settling', 'read');
    const replay = setDefaults(OLD_DEFAULTS, { idempotencyKey: 'key' });
    // A reconcile that does not wait for the commit reads, and decides, first.
    const first = await step;
    refresh.release();
    await other;
    await replay;
    expect({ first, revision: sessionRevision() }).toEqual({
      first: 'settling',
      revision: initial + 1,
    });
    expect(await cachedDefaults()).toEqual(NEW);
    await setDefaults(OLD_DEFAULTS, { idempotencyKey: 'key' });
    expect(sessionRevision()).toBe(initial + 1);
  });

  it('a W5 commit whose post-commit work fails before its refresh holds no replay back; the replay reconciles the lost refresh once', async () => {
    const initial = await servedOldWithNoOpKey();
    await expect(
      otherW5LayerChange(() =>
        afterW5Commit(() => {
          throw new Error('post-commit work failed');
        }),
      ),
    ).rejects.toThrow('post-commit work failed');
    expect(manifest().defaultPluginSelections).toEqual(persisted(NEW_DEFAULTS));
    expect(sessionRevision()).toBe(initial);
    for (let replay = 0; replay < 2; replay += 1) {
      await setDefaults(OLD_DEFAULTS, { idempotencyKey: 'key' });
      expect(await cachedDefaults()).toEqual(NEW);
      expect(sessionRevision()).toBe(initial + 1);
    }
  });
});

describe('chat normalization stays outside the decision', () => {
  function lastTouchedAt(worktreeId: string): unknown {
    const list: unknown = JSON.parse(
      readFileSync(join(root, 'a', 'worktrees.json'), 'utf8'),
    );
    if (typeof list !== 'object' || list === null || !('worktrees' in list))
      throw new Error('Expected a worktree list');
    const rows: unknown = list.worktrees;
    if (!Array.isArray(rows)) throw new Error('Expected worktree rows');
    const row: unknown = rows.find(
      (candidate: unknown) =>
        typeof candidate === 'object' &&
        candidate !== null &&
        'id' in candidate &&
        candidate.id === worktreeId,
    );
    return typeof row === 'object' && row !== null && 'lastTouchedAt' in row
      ? row.lastTouchedAt
      : undefined;
  }

  it.each([
    ['without a key', 'wt-plain'],
    ['with a key', 'wt-keyed'],
    ['with a revision', 'wt-revision'],
  ] as const)(
    '%s, a deferred activity touch a normalized chat schedules commits on its own',
    async (name, worktreeId) => {
      await seedDefaults();
      writeFileSync(
        join(root, 'a', 'worktrees.json'),
        JSON.stringify({
          version: 1,
          worktrees: [
            { id: worktreeId, branchName: 'main', createdAt: '2026' },
          ],
        }),
      );
      mockChats.scopes.set(worktreeId, {
        version: 1,
        activeTabId: 'legacy',
        tabs: [legacyChat('legacy')],
      });
      mockChats.afterWrite = (scope): Promise<void> =>
        touchWorkspaceTargetAfterCommit(scope.projectId, scope.worktreeId);
      // The production registration of the normalization handler.
      registerChatPersistenceHandlers();
      // Arms nothing: each deferred touch fires when the test chooses, in
      // the context that armed it, as its timer would.
      const deferred: Array<{
        fire: () => void;
        inCommitScope: boolean;
        manifest: unknown;
      }> = [];
      const realSetTimeout = global.setTimeout;
      jest
        .spyOn(global, 'setTimeout')
        .mockImplementation((handler, delay, ...args) => {
          if (!/workspace-activity\.ts/.test(new Error().stack ?? ''))
            return realSetTimeout(handler, delay, ...args);
          deferred.push({
            fire: AsyncResource.bind(() => handler(...args)),
            inCommitScope: currentW5CommitScope() !== undefined,
            manifest: manifest().defaultPluginSelections,
          });
          const inert = realSetTimeout(() => undefined, 0);
          clearTimeout(inert);
          return inert;
        });
      // A touch inside the write interval defers the next one to a timer.
      const recent = Date.now() - 1_000;
      await touchWorkspaceTargetAfterCommit('a', worktreeId, recent);
      const touchedBefore = lastTouchedAt(worktreeId);
      expect(touchedBefore).toBe(new Date(recent).toISOString());

      const commits = jest.spyOn(host, 'commit');
      await setDefaults(
        NEW_DEFAULTS,
        name === 'with a key'
          ? { idempotencyKey: 'key' }
          : name === 'with a revision'
            ? { expectedRevision: await revision() }
            : {},
      );
      expect(mockChats.writes).toBe(1);
      expect(commits).toHaveBeenCalledTimes(1);
      expect(commits.mock.calls[0]?.[0].files.map(({ path }) => path)).toEqual([
        manifestPath(),
      ]);
      const touchedAtDecision = lastTouchedAt(worktreeId);

      for (const touch of deferred) touch.fire();
      await settleDetachedWork();
      expect({
        deferred: deferred.map((touch) => ({
          inCommitScope: touch.inCommitScope,
          manifest: touch.manifest,
        })),
        touchedAtDecision,
        touchedAfterFiring: lastTouchedAt(worktreeId) !== touchedBefore,
        commits: commits.mock.calls.map(([request]) =>
          request.files.map(({ path }) => path),
        ),
      }).toEqual({
        deferred: [{ inCommitScope: false, manifest: persisted(OLD_DEFAULTS) }],
        touchedAtDecision: touchedBefore,
        touchedAfterFiring: true,
        commits: [[manifestPath()], [join(root, 'a', 'worktrees.json')]],
      });
    },
  );
});

describe('selectRecommended', () => {
  it('saves the merged defaults and opt-outs as one keyed decision and replays them', async () => {
    await updateWorkspaceConfig('a', (config): void => {
      config.defaultPluginSelections = OLD_DEFAULTS;
      config.recommendedPluginOptOutKeys = ['stale'];
    });
    const commits = jest.spyOn(host, 'commit');
    const change = { ...RECOMMENDED, clearOptOutKeys: ['stale'] };
    const first = await selectRecommended(change, {
      idempotencyKey: 'key',
      expectedRevision: 1,
    });
    expect(first).toEqual({
      workspaceId: 'a',
      written: true,
      defaultPluginSelections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'github-org', skillName: 'review' }],
        pluginRefs: [{ marketplaceId: 'm', pluginName: 'old' }],
        mcpServerRefs: [],
        mcpHttpAuthPreferences: [],
      },
      recommendedPluginOptOutKeys: ['opt-out'],
    });
    expect(commits.mock.calls[0]?.[0]).toMatchObject({
      operation: OPERATION,
      receipt: { caller: 'desktop-host:recommended_plugins' },
      expectedRevisions: [{ resource: RESOURCE, revision: 1 }],
      outcome: first,
    });
    expect(manifest().recommendedPluginOptOutKeys).toEqual(['opt-out']);

    // A later change; the replay neither repeats nor undoes anything.
    await selectRecommended({
      kind: 'selectRecommended',
      selections: [],
      optOutKeys: ['later'],
      clearOptOutKeys: [],
    });
    const before = images();
    await restartHost();
    const restarted = jest.spyOn(host, 'commit');
    expect(
      await selectRecommended(change, {
        idempotencyKey: 'key',
        expectedRevision: 1,
      }),
    ).toEqual(first);
    expect(restarted).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
    expect(manifest().recommendedPluginOptOutKeys).toEqual([
      'later',
      'opt-out',
    ]);

    await expect(
      selectRecommended(
        { ...change, optOutKeys: ['other'] },
        { idempotencyKey: 'key' },
      ),
    ).rejects.toMatchObject({ reason: 'key-reused' });
  });

  it('refuses a stale revision with unchanged bytes and releases the key', async () => {
    const before = images();
    await expect(
      selectRecommended(RECOMMENDED, {
        idempotencyKey: 'key',
        expectedRevision: 3,
      }),
    ).rejects.toBeInstanceOf(W5RevisionConflictError);
    expect(images()).toEqual(before);
    await expect(
      selectRecommended(RECOMMENDED, {
        idempotencyKey: 'key',
        expectedRevision: 0,
      }),
    ).resolves.toMatchObject({ written: true });
    expect(manifest().recommendedPluginOptOutKeys).toEqual(['opt-out']);
  });

  it('reconciles the cached plugin layer and session revision once after a lost response; its replays repeat nothing', async () => {
    await seedDefaults();
    expect(await cachedDefaults()).toEqual(
      normalizePluginSelections(OLD_DEFAULTS),
    );
    const initial = sessionRevision();
    loseNextResponse();
    await expect(
      selectRecommended(RECOMMENDED, { idempotencyKey: 'key' }),
    ).rejects.toThrow('response lost');
    const merged = normalizePluginSelections(
      manifest().defaultPluginSelections,
    );
    expect(merged.skillRefs).toEqual(RECOMMENDED_SKILL_REFS);
    expect(await cachedDefaults()).toEqual(merged);
    const lost = sessionRevision();
    expect(lost).toBe(initial + 1);

    const commits = jest.spyOn(host, 'commit').mockClear();
    for (let replay = 0; replay < 2; replay += 1) {
      await expect(
        selectRecommended(RECOMMENDED, { idempotencyKey: 'key' }),
      ).resolves.toMatchObject({ written: true });
      expect(await cachedDefaults()).toEqual(merged);
      expect(sessionRevision()).toBe(lost);
    }

    await restartHost();
    const restarted = jest.spyOn(host, 'commit');
    cacheStaleDefaults(OLD_DEFAULTS);
    for (let replay = 0; replay < 2; replay += 1) {
      await expect(
        selectRecommended(RECOMMENDED, { idempotencyKey: 'key' }),
      ).resolves.toMatchObject({ written: true });
      expect(await cachedDefaults()).toEqual(merged);
      expect(sessionRevision()).toBe(lost + 1);
    }
    expect(commits).not.toHaveBeenCalled();
    expect(restarted).not.toHaveBeenCalled();
  });

  it('replays an acknowledged selection without advancing the session revision again', async () => {
    await seedDefaults();
    await cachedDefaults();
    const initial = sessionRevision();
    const first = await selectRecommended(RECOMMENDED, {
      idempotencyKey: 'key',
    });
    expect(sessionRevision()).toBe(initial + 1);
    for (const restart of [false, true, false]) {
      if (restart) await restartHost();
      expect((await cachedDefaults()).skillRefs).toEqual(
        RECOMMENDED_SKILL_REFS,
      );
      expect(
        await selectRecommended(RECOMMENDED, { idempotencyKey: 'key' }),
      ).toEqual(first);
      expect(sessionRevision()).toBe(initial + 1);
    }
  });

  it('without a key writes the same bytes as the plain manifest write', async () => {
    const original = readFileSync(manifestPath(), 'utf8');
    await updateWorkspaceConfig('a', (config): void => {
      config.defaultPluginSelections = {
        collectionIds: [],
        skillRefs: [{ sourceId: 'github-org', skillName: 'review' }],
        pluginRefs: [],
        mcpServerRefs: [],
        mcpHttpAuthPreferences: [],
      };
      config.recommendedPluginOptOutKeys = ['opt-out'];
    });
    const plain = readFileSync(manifestPath(), 'utf8');
    writeFileSync(manifestPath(), original);
    const commits = jest.spyOn(host, 'commit');
    await selectRecommended();
    expect(readFileSync(manifestPath(), 'utf8')).toBe(plain);
    expect(commits.mock.calls[0]?.[0]).toMatchObject({
      operation: 'w5.workspace_manifest.write',
      receipt: undefined,
    });
  });
});

describe('refusals before the decision', () => {
  const changes: Array<[string, WorkspacePluginsUserChange]> = [
    [
      'setDefaults',
      { kind: 'setDefaults', defaultPluginSelections: NEW_DEFAULTS },
    ],
    ['selectRecommended', RECOMMENDED],
  ];

  it.each(changes)(
    'refuses %s for a missing manifest, writes nothing and releases the key',
    async (_name, change) => {
      const original = readFileSync(manifestPath(), 'utf8');
      rmSync(manifestPath());
      const reserve = jest.spyOn(host, 'reserve');
      const pending = updateWorkspacePlugins({
        workspaceId: 'a',
        change,
        source: 'project_settings',
        idempotencyKey: 'key',
      });
      await expect(pending).rejects.toBeInstanceOf(
        WorkspacePluginsRefusedError,
      );
      await expect(pending).rejects.toMatchObject({
        reason: 'not-found',
        message: 'Project a not found.',
      });
      expect(() => readFileSync(manifestPath(), 'utf8')).toThrow();
      expect(await host.lookupReceipt(receiptOf(reserve))).toMatchObject({
        status: 'none',
      });
      writeFileSync(manifestPath(), original);
      await expect(
        updateWorkspacePlugins({
          workspaceId: 'a',
          change,
          source: 'project_settings',
          idempotencyKey: 'key',
        }),
      ).resolves.toMatchObject({ written: true });
    },
  );

  it.each(changes)(
    'refuses %s for an unreadable manifest, leaves it as it is and releases the key',
    async (_name, change) => {
      const original = readFileSync(manifestPath(), 'utf8');
      writeFileSync(manifestPath(), '{"vers');
      const reserve = jest.spyOn(host, 'reserve');
      const pending = updateWorkspacePlugins({
        workspaceId: 'a',
        change,
        source: 'project_settings',
        idempotencyKey: 'key',
      });
      await expect(pending).rejects.toMatchObject({
        reason: 'configuration-unavailable',
      });
      await expect(pending).rejects.toThrow(/could not be read/);
      expect(readFileSync(manifestPath(), 'utf8')).toBe('{"vers');
      expect(await host.lookupReceipt(receiptOf(reserve))).toMatchObject({
        status: 'none',
      });
      writeFileSync(manifestPath(), original);
      await expect(
        updateWorkspacePlugins({
          workspaceId: 'a',
          change,
          source: 'project_settings',
          idempotencyKey: 'key',
        }),
      ).resolves.toMatchObject({ written: true });
    },
  );

  it('refuses invalid default selections before any reservation', async () => {
    const change: WorkspacePluginsUserChange = {
      kind: 'setDefaults',
      defaultPluginSelections: NEW_DEFAULTS,
    };
    Reflect.set(change, 'defaultPluginSelections', 'all');
    const reserve = jest.spyOn(host, 'reserve');
    await expect(
      updateWorkspacePlugins({
        workspaceId: 'a',
        change,
        source: 'project_settings',
        idempotencyKey: 'key',
      }),
    ).rejects.toMatchObject({ reason: 'invalid-change' });
    expect(reserve).not.toHaveBeenCalled();
  });
});

describe('fan-out kinds without a fan-out request ID stay unkeyed on their own paths', () => {
  const device = { serverId: 'dev-1', configId: 'cfg-1' };
  const cloud = { serverId: 'custom:abc', configId: 'default' };
  const fanOut: Array<[string, WorkspacePluginsChange]> = [
    [
      'replaceMcpServerRefs',
      {
        kind: 'replaceMcpServerRefs',
        from: [{ serverId: 'dev-1' }],
        to: cloud,
      },
    ],
    ['pruneMarketplace', { kind: 'pruneMarketplace', marketplaceId: 'm' }],
  ];

  beforeEach(async () => {
    await updateWorkspaceConfig('a', (config): void => {
      config.defaultPluginSelections = selections({
        pluginRefs: [{ marketplaceId: 'm', pluginName: 'old' }],
        mcpServerRefs: [device],
      });
    });
  });

  it.each(fanOut)(
    '%s commits as the plain manifest write, outside any boundary scope',
    async (_name, change) => {
      const commits = jest.spyOn(host, 'commit');
      const reserve = jest.spyOn(host, 'reserve');
      const outcome = await updateWorkspacePlugins({
        workspaceId: 'a',
        change,
        source:
          change.kind === 'pruneMarketplace'
            ? 'marketplace_removal'
            : 'mcp_server_move',
      });
      expect(outcome.written).toBe(true);
      expect(commits).toHaveBeenCalledTimes(1);
      expect(commits.mock.calls[0]?.[0]).toMatchObject({
        operation: 'w5.workspace_manifest.write',
        receipt: undefined,
        reservationId: undefined,
        expectedRevisions: undefined,
        outcome: null,
      });
      expect(reserve).not.toHaveBeenCalled();
      expect(recordWorkspaceCrudTelemetry).not.toHaveBeenCalled();
    },
  );

  it.each(fanOut)(
    '%s takes no key or revision: its request type has neither, and a stray one is ignored as before',
    async (_name, change) => {
      const original = readFileSync(manifestPath(), 'utf8');
      const commits = jest.spyOn(host, 'commit');
      const reserve = jest.spyOn(host, 'reserve');
      const source: WorkspacePluginsSource =
        change.kind === 'pruneMarketplace'
          ? 'marketplace_removal'
          : 'mcp_server_move';
      const plain = await updateWorkspacePlugins({
        workspaceId: 'a',
        change,
        source,
      });
      const plainBytes = readFileSync(manifestPath(), 'utf8');
      for (const options of [
        { idempotencyKey: 'key' },
        { expectedRevision: 999 },
      ]) {
        writeFileSync(manifestPath(), original);
        // A caller outside the typed surface, such as an untyped payload.
        const request = { ...options, workspaceId: 'a', change, source };
        expect(await updateWorkspacePlugins(request)).toEqual(plain);
        expect(readFileSync(manifestPath(), 'utf8')).toBe(plainBytes);
      }
      expect(commits).toHaveBeenCalledTimes(3);
      for (const [decision] of commits.mock.calls)
        expect(decision).toMatchObject({
          operation: 'w5.workspace_manifest.write',
          receipt: undefined,
          reservationId: undefined,
          expectedRevisions: undefined,
        });
      expect(reserve).not.toHaveBeenCalled();
    },
  );

  it('types a key or revision only for the user changes', () => {
    const typeOnly = (): void => {
      // @ts-expect-error The prune takes no key.
      void updateWorkspacePlugins({
        workspaceId: 'a',
        change: { kind: 'pruneMarketplace', marketplaceId: 'm' },
        source: 'marketplace_removal',
        idempotencyKey: 'key',
      });
      // @ts-expect-error The server move takes no revision.
      void updateWorkspacePlugins({
        workspaceId: 'a',
        change: { kind: 'replaceMcpServerRefs', from: [], to: cloud },
        source: 'mcp_server_move',
        expectedRevision: 1,
      });
      void updateWorkspacePlugins({
        workspaceId: 'a',
        change: { kind: 'setDefaults', defaultPluginSelections: NEW_DEFAULTS },
        source: 'project_settings',
        idempotencyKey: 'key',
        expectedRevision: 1,
      });
      void updateWorkspacePlugins({
        workspaceId: 'a',
        change: { kind: 'pruneMarketplace', marketplaceId: 'm' },
        source: 'marketplace_removal',
      });
      void updateWorkspacePlugins({
        workspaceId: 'a',
        change: { kind: 'pruneMarketplace', marketplaceId: 'm' },
        source: 'marketplace_removal',
        fanOutRequestId: 'removal',
      });
      void updateWorkspacePlugins({
        workspaceId: 'a',
        change: { kind: 'setDefaults', defaultPluginSelections: NEW_DEFAULTS },
        source: 'project_settings',
        // @ts-expect-error Only the prune takes a fan-out request ID.
        fanOutRequestId: 'removal',
      });
      void updateWorkspacePlugins({
        workspaceId: 'a',
        change: { kind: 'pruneMarketplace', marketplaceId: 'm' },
        source: 'workspace_settings',
        // @ts-expect-error Only marketplace removal keys a prune.
        fanOutRequestId: 'removal',
      });
    };
    expect(typeof typeOnly).toBe('function');
  });
});

describe('marketplace prune keyed per workspace from one fan-out request (CAN-4717)', () => {
  const WORKSPACES = ['a', 'b', 'c'] as const;
  const PRUNED = { marketplaceId: 'm', pluginName: 'old' };
  const KEPT = { marketplaceId: 'other', pluginName: 'kept' };

  const pathOf = (workspaceId: string): string =>
    join(root, workspaceId, 'workspace.json');

  /** Every fan-out manifest's bytes, or null once removed. */
  function fanOutImages(): Array<string | null> {
    return WORKSPACES.map((workspaceId) => {
      try {
        return readFileSync(pathOf(workspaceId), 'utf8');
      } catch {
        return null;
      }
    });
  }

  function pluginRefsOf(workspaceId: string): unknown {
    const parsed: unknown = JSON.parse(
      readFileSync(pathOf(workspaceId), 'utf8'),
    );
    if (typeof parsed !== 'object' || parsed === null)
      throw new Error('Expected a manifest object');
    const defaults: unknown = Reflect.get(parsed, 'defaultPluginSelections');
    return typeof defaults === 'object' && defaults !== null
      ? Reflect.get(defaults, 'pluginRefs')
      : undefined;
  }

  /** The removal fan-out: each workspace in turn, every failure swallowed. */
  async function fanOut(
    fanOutRequestId: string,
    marketplaceId = 'm',
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const workspaceId of WORKSPACES) {
      try {
        results.push(
          await updateWorkspacePlugins({
            workspaceId,
            change: { kind: 'pruneMarketplace', marketplaceId },
            source: 'marketplace_removal',
            fanOutRequestId,
          }),
        );
      } catch (error) {
        results.push(error);
      }
    }
    return results;
  }

  const outcomes = [
    { workspaceId: 'a', written: true },
    { workspaceId: 'b', written: true },
    { workspaceId: 'c', written: false },
  ];

  /** One workspace's prune of the `removal` fan-out. */
  function pruneOne(
    workspaceId: string,
  ): Promise<WorkspacePluginsUpdateOutcome> {
    return updateWorkspacePlugins({
      workspaceId,
      change: { kind: 'pruneMarketplace', marketplaceId: 'm' },
      source: 'marketplace_removal',
      fanOutRequestId: 'removal',
    });
  }

  beforeEach(() => {
    mkdirSync(join(root, 'b'));
    mkdirSync(join(root, 'c'));
    for (const [workspaceId, pluginRefs] of [
      ['a', [PRUNED, KEPT]],
      ['b', [PRUNED]],
      ['c', [KEPT]],
    ] as const)
      writeFileSync(
        pathOf(workspaceId),
        JSON.stringify({
          version: 1,
          type: 'single-repo',
          repos: [],
          defaultPluginSelections: { pluginRefs },
        }),
      );
  });

  it('applies each workspace once under a key derived from the request, and replays every saved result without a write, before and after a restart', async () => {
    const commits = jest.spyOn(host, 'commit');
    expect(await fanOut('removal')).toEqual(outcomes);
    expect(commits).toHaveBeenCalledTimes(3);
    expect(commits.mock.calls.map(([decision]) => decision.receipt)).toEqual(
      WORKSPACES.map((workspaceId): unknown =>
        expect.objectContaining({
          caller: 'desktop-host:marketplace_removal',
          operation: OPERATION,
          idempotencyKey: JSON.stringify(['removal', workspaceId]),
        }),
      ),
    );
    expect(commits.mock.calls.map(([decision]) => decision.operation)).toEqual([
      OPERATION,
      OPERATION,
      OPERATION,
    ]);
    // An unchanged workspace saves its outcome without a write.
    expect(commits.mock.calls[2]?.[0].files).toEqual([]);
    expect(pluginRefsOf('a')).toEqual([KEPT]);
    expect(pluginRefsOf('b')).toEqual([]);
    expect(pluginRefsOf('c')).toEqual([KEPT]);
    expect(await host.revision({ kind: 'workspace', workspaceId: 'b' })).toBe(
      1,
    );

    // A ref saved again since must not be pruned by a replay.
    await updateWorkspaceConfig('b', (config): void => {
      config.defaultPluginSelections = selections({ pluginRefs: [PRUNED] });
    });
    const before = fanOutImages();
    for (const restart of [false, true]) {
      if (restart) await restartHost();
      const replays = jest.spyOn(host, 'commit').mockClear();
      expect(await fanOut('removal')).toEqual(outcomes);
      expect(replays).not.toHaveBeenCalled();
      expect(fanOutImages()).toEqual(before);
    }
  });

  it('refuses changed parameters for a used request with unchanged bytes; another request applies', async () => {
    await fanOut('removal');
    const before = fanOutImages();
    const commits = jest.spyOn(host, 'commit');
    const reused = await fanOut('removal', 'other');
    expect(reused).toEqual(
      WORKSPACES.map((): unknown =>
        expect.objectContaining({ reason: 'key-reused' }),
      ),
    );
    expect(commits).not.toHaveBeenCalled();
    expect(fanOutImages()).toEqual(before);

    expect(await fanOut('second', 'other')).toEqual([
      { workspaceId: 'a', written: true },
      { workspaceId: 'b', written: false },
      { workspaceId: 'c', written: true },
    ]);
    expect(commits).toHaveBeenCalledTimes(3);
  });

  it('replays one workspace whose response was lost and refreshes its plugin layer once', async () => {
    expect(
      normalizePluginSelections(
        (await readProjectPluginDefaults('b')).defaultPluginSelections,
      ).pluginRefs,
    ).toEqual([PRUNED]);
    const initial = getProjectPluginDefaultsRevision('b');
    const commit = host.commit.bind(host);
    jest.spyOn(host, 'commit').mockImplementation(async (request) => {
      const result = await commit(request);
      if (request.receipt?.idempotencyKey === JSON.stringify(['removal', 'b']))
        throw new Error('response lost');
      return result;
    });
    const first = await fanOut('removal');
    expect(first[0]).toEqual(outcomes[0]);
    expect(first[1]).toEqual(new Error('response lost'));
    expect(first[2]).toEqual(outcomes[2]);
    expect(pluginRefsOf('b')).toEqual([]);
    // The refresh dropped with the response is reconciled once.
    expect(
      normalizePluginSelections(
        (await readProjectPluginDefaults('b')).defaultPluginSelections,
      ).pluginRefs,
    ).toEqual([]);
    expect(getProjectPluginDefaultsRevision('b')).toBe(initial + 1);

    jest.restoreAllMocks();
    const replayed = fanOutImages();
    for (const restart of [false, true]) {
      if (restart) await restartHost();
      const commits = jest.spyOn(host, 'commit');
      expect(await fanOut('removal')).toEqual(outcomes);
      expect(commits).not.toHaveBeenCalled();
      expect(fanOutImages()).toEqual(replayed);
      expect(getProjectPluginDefaultsRevision('b')).toBe(initial + 1);
    }
  });

  it('refreshes the plugin layer after the keyed decision lands, so a read before it caches nothing stale', async () => {
    const layerOfB = async (): Promise<unknown> =>
      normalizePluginSelections(
        (await readProjectPluginDefaults('b')).defaultPluginSelections,
      ).pluginRefs;
    const deciding = barrier();
    const proceed = barrier();
    const commit = host.commit.bind(host);
    jest.spyOn(host, 'commit').mockImplementation(async (request) => {
      if (
        request.receipt?.idempotencyKey === JSON.stringify(['removal', 'b'])
      ) {
        deciding.open();
        await proceed.promise;
      }
      return commit(request);
    });
    const initial = getProjectPluginDefaultsRevision('b');
    const pending = fanOut('removal');
    await deciding.promise;
    // Staged, not yet decided: a read still finds the old layer.
    expect(await layerOfB()).toEqual([PRUNED]);
    proceed.open();
    expect(await pending).toEqual(outcomes);
    expect(await layerOfB()).toEqual([]);
    expect(getProjectPluginDefaultsRevision('b')).toBe(initial + 1);
  });

  it('a concurrent fan-out with the same request applies no workspace twice', async () => {
    const deciding = barrier();
    const proceed = barrier();
    const commit = host.commit.bind(host);
    const commits = jest
      .spyOn(host, 'commit')
      .mockImplementation(async (request) => {
        if (
          request.receipt?.idempotencyKey === JSON.stringify(['removal', 'b'])
        ) {
          deciding.open();
          await proceed.promise;
        }
        return commit(request);
      });
    const prune = (workspaceId: string): Promise<unknown> =>
      updateWorkspacePlugins({
        workspaceId,
        change: { kind: 'pruneMarketplace', marketplaceId: 'm' },
        source: 'marketplace_removal',
        fanOutRequestId: 'removal',
      }).catch((error: unknown) => error);
    const first = fanOut('removal');
    await deciding.promise;
    // While `b` decides, `a` replays and `b` refuses.
    expect(await prune('a')).toEqual(outcomes[0]);
    expect(await prune('b')).toMatchObject({ reason: 'in-progress' });
    proceed.open();
    expect(await first).toEqual(outcomes);
    expect(commits).toHaveBeenCalledTimes(3);
    expect(await fanOut('removal')).toEqual(outcomes);
    expect(commits).toHaveBeenCalledTimes(3);
    expect(pluginRefsOf('a')).toEqual([KEPT]);
    expect(pluginRefsOf('b')).toEqual([]);
  });

  it('a partial fan-out: refusing workspaces release their keys while the others apply, and the retry applies only those', async () => {
    const originalA = readFileSync(pathOf('a'), 'utf8');
    const originalB = readFileSync(pathOf('b'), 'utf8');
    rmSync(pathOf('b'));
    writeFileSync(pathOf('a'), '{"vers');
    const reserve = jest.spyOn(host, 'reserve');
    const commits = jest.spyOn(host, 'commit');
    const first = await fanOut('removal');
    expect(first[0]).toMatchObject({ reason: 'configuration-unavailable' });
    expect(first[1]).toMatchObject({
      reason: 'not-found',
      message: 'Project b not found.',
    });
    expect(first[0]).toBeInstanceOf(WorkspacePluginsRefusedError);
    expect(first[2]).toEqual(outcomes[2]);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(readFileSync(pathOf('a'), 'utf8')).toBe('{"vers');
    for (const [{ receipt }] of reserve.mock.calls.slice(0, 2))
      expect(await host.lookupReceipt(receipt)).toMatchObject({
        status: 'none',
      });

    writeFileSync(pathOf('a'), originalA);
    writeFileSync(pathOf('b'), originalB);
    commits.mockClear();
    expect(await fanOut('removal')).toEqual(outcomes);
    // The released keys apply; the saved one replays.
    expect(commits).toHaveBeenCalledTimes(2);
    expect(pluginRefsOf('a')).toEqual([KEPT]);
    expect(pluginRefsOf('b')).toEqual([]);
  });

  it('a preflight file conflict writes nothing and releases the key; the retry applies over the newer file', async () => {
    const armed = armPreflightForeignWrite();
    const reserve = jest.spyOn(host, 'reserve');
    const first = await fanOut('removal');
    armed.restore();
    expect(armed.fired()).toBe(1);
    expect(first[0]).toBeInstanceOf(W5FileWriteRefusedError);
    expect([first[1], first[2]]).toEqual([outcomes[1], outcomes[2]]);
    expect(manifest()).toMatchObject({
      foreignField: 'foreign-write',
      defaultPluginSelections: { pluginRefs: [PRUNED, KEPT] },
    });
    expect(await host.lookupReceipt(receiptOf(reserve))).toMatchObject({
      status: 'none',
    });
    expect(await fanOut('removal')).toEqual(outcomes);
    expect(manifest()).toMatchObject({
      foreignField: 'foreign-write',
      defaultPluginSelections: { pluginRefs: [KEPT] },
    });
  });

  it('leaves a workspace whose decision failed recovery-required and diagnosed, while the others apply and replay', async () => {
    const commit = host.commit.bind(host);
    const error = Object.assign(new Error('worker failed'), { code: 'EIO' });
    jest.spyOn(host, 'commit').mockImplementation(async (request) => {
      if (request.receipt?.idempotencyKey === JSON.stringify(['removal', 'b']))
        throw error;
      return commit(request);
    });
    const first = await fanOut('removal');
    expect(first).toEqual([outcomes[0], error, outcomes[2]]);
    expect(pluginRefsOf('b')).toEqual([PRUNED]);
    jest.restoreAllMocks();

    const before = fanOutImages();
    const retry = await fanOut('removal');
    expect(retry[1]).toMatchObject({ reason: 'recovery-required' });
    expect([retry[0], retry[2]]).toEqual([outcomes[0], outcomes[2]]);
    expect(fanOutImages()).toEqual(before);
    await host.shutdown();
    const diagnosis = await diagnoseW5State(join(dir, 'data'));
    expect(diagnosis.reservations).toEqual([
      expect.objectContaining({ state: 'recovery-required' }),
    ]);
    expect(diagnosis.reservations[0]?.diagnostics).toContain(
      `"operation":"${OPERATION}","errorName":"Error","errorCode":"EIO"`,
    );
    startHost();
  });

  it('a prune that died before its decision is recovery-required after restart and diagnosed, without holding the other workspaces, and applies once after resolve', async () => {
    const before = fanOutImages();
    failBeforeDecision();
    await expect(pruneOne('b')).rejects.toThrow('worker died before decision');
    jest.restoreAllMocks();
    await restartHost();
    expect(fanOutImages()).toEqual(before);
    const commits = jest.spyOn(host, 'commit');
    await expect(pruneOne('b')).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect(commits).not.toHaveBeenCalled();
    expect(fanOutImages()).toEqual(before);
    expect(await pruneOne('a')).toEqual(outcomes[0]);
    expect(commits).toHaveBeenCalledTimes(1);

    await host.shutdown();
    const diagnosis = await diagnoseW5State(join(dir, 'data'));
    expect(diagnosis.reservations).toEqual([
      expect.objectContaining({ state: 'recovery-required' }),
    ]);

    await resolveColdRecovery();
    const resolved = jest.spyOn(host, 'commit');
    expect(await pruneOne('b')).toEqual(outcomes[1]);
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(pluginRefsOf('b')).toEqual([]);
    const applied = fanOutImages();
    expect(await pruneOne('b')).toEqual(outcomes[1]);
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(fanOutImages()).toEqual(applied);
  });

  it('a replay that finds the manifest removed while its refresh is owed advances the session revision once', async () => {
    expect(
      normalizePluginSelections(
        (await readProjectPluginDefaults('a')).defaultPluginSelections,
      ).pluginRefs,
    ).toEqual([PRUNED, KEPT]);
    const initial = getProjectPluginDefaultsRevision('a');
    loseNextResponse();
    jest
      .spyOn(workspacePersistence, 'readWorkspaceConfigDetailed')
      .mockRejectedValueOnce(new Error('read failed'));
    await expect(pruneOne('a')).rejects.toThrow('response lost');
    expect(pluginRefsOf('a')).toEqual([KEPT]);
    // The failed read decided nothing, so the refresh is still owed.
    expect(getProjectPluginDefaultsRevision('a')).toBe(initial);
    jest.restoreAllMocks();

    rmSync(pathOf('a'));
    for (let replay = 0; replay < 2; replay += 1) {
      expect(await pruneOne('a')).toEqual(outcomes[0]);
      expect(getProjectPluginDefaultsRevision('a')).toBe(initial + 1);
    }
  });

  it('refuses an empty fan-out request ID, or one from another source, before any reservation', async () => {
    const reserve = jest.spyOn(host, 'reserve');
    const before = fanOutImages();
    expect(await fanOut('')).toEqual(
      WORKSPACES.map((): unknown =>
        expect.objectContaining({ reason: 'invalid-change' }),
      ),
    );
    // A caller outside the typed surface: the receipt caller stays fixed.
    const request = {
      workspaceId: 'a',
      change: { kind: 'pruneMarketplace', marketplaceId: 'm' } as const,
      source: 'workspace_settings' as const,
      fanOutRequestId: 'removal',
    };
    await expect(updateWorkspacePlugins(request)).rejects.toMatchObject({
      reason: 'invalid-change',
    });
    expect(recordWorkspaceCrudTelemetry).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(fanOutImages()).toEqual(before);
  });
});
