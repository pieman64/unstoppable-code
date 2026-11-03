// W5d2 PRs 3a and 3b (CAN-5535, CAN-5536): the decision-only bounded retry of
// the guarded host commands #7, #9, #11, #12, #22, #23 and #26 over both W5
// stores, on a real commit-log worker and real files. Over the daemon store a
// routed write between Electron's fresh read and its CAS refuses the
// decision, which the command's outermost entry reruns; the in-process store
// keeps one attempt.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type * as CoreStorage from '@canopy/core-runtime/storage';
import type { ClientFeatureFlagKey } from '@canopy/protocol/feature-flags';
import type * as FeatureFlags from '../../feature-flags';
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
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
  recordStandaloneProjectCrudTelemetry: jest.fn(),
}));
// W7b-1c: `chat-project:update` runs from its registered handler.
jest.mock('../../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
// #7 binds new hooks to the selected navigation context it captures (P17).
jest.mock('../../feature-flags', () => {
  const actual = jest.requireActual<typeof FeatureFlags>('../../feature-flags');
  return {
    ...actual,
    getFeatureFlagService: (): {
      isEnabled: (key: ClientFeatureFlagKey) => boolean;
    } => ({
      isEnabled: (key: ClientFeatureFlagKey): boolean =>
        key === 'canopy-shared-org-projects-enabled' ||
        actual.getFeatureFlagService().isEnabled(key),
    }),
  };
});
const ORGANIZATION = {
  kind: 'organization',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
} as const;
const mockSelectedContext = jest.fn<
  { kind: 'personal' } | typeof ORGANIZATION,
  []
>(() => ({ kind: 'personal' }));
jest.mock('../workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    initialize: (): Promise<void> => Promise.resolve(),
    whenIdle: (): Promise<void> => Promise.resolve(),
    getState: (): {
      context: ReturnType<typeof mockSelectedContext>;
      organizations: [];
    } => ({ context: mockSelectedContext(), organizations: [] }),
  }),
}));

import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import { W5CommitLog } from '@canopy/desktop-shared/node/w5-commit-log';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { W5Resource } from '@canopy/desktop-shared/node/w5-commit-log';
import {
  createW5CommitEventSource,
  type W5CommitEventSource,
} from '@canopy/core-runtime/node/w5/commit-events';
import {
  w5RecordTargetFor,
  type W5RecordPortTransport,
} from '@canopy/core-runtime/node/w5/record-port';
import {
  CORE_WORKSPACE_COMMITTED_EVENT,
  hasHostAbsolutePath,
} from '@canopy/protocol/canopy-core';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  projectPluginDefaultsWritten,
  readThroughProjectPluginDefaults,
} from '../../plugins/project-plugin-defaults-cache';
import { getProjectPluginDefaultsRevision } from '../../plugins/plugin-defaults-revision';
import { notifyPortalStructureChanged } from '../../portal/portal-event-bus';
import { schedulePortalStructuralSync } from '../../portal/portal-structural-sync';
import * as splitLocks from '../../services/split-lock-service';
import {
  createW5BoundaryFixture,
  isW5FinalPreflightRead,
} from './fixtures/w5-boundary-fixture';
import { shutdownW5BoundaryHost } from './fixtures/w5-boundary-host';
import {
  installW5StoreSide,
  W5_STORE_SIDES,
  type W5StoreSide,
} from './fixtures/w5-store-sides';
import { updateCoworkWorkspaceSettings } from '../cowork-workspace-crud';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { registerChatProjectHandlers } from '../../ipc/chat-projects';
import { registerIpcHandler } from '../../ipc/register';
import {
  createWorkspaceMetadataTestDispatcher,
  TEST_IPC_CALLER,
} from '../../__tests__/fixtures/workspace-metadata-dispatcher';
import {
  getWorkspaceConfigPath,
  getWorkspaceWorkEntriesFilePath,
} from '../paths';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  __setDesktopW5FileStoreForTests,
  createW5CommitLogFileStore,
  W5FileWriteRefusedError,
  W5RevisionConflictError,
  withW5Commit,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { w5ConflictCounts } from '../w5-pre-effect-retry';
import { resetWorkspaceActivityForTests } from '../workspace-activity';
import {
  readProjectPluginDefaults,
  setBeforeProjectPluginDefaultsChangeHandler,
  setWorktreeRegistryReconciler,
  type WorktreeRegistryWriteOptions,
} from '../workspace-persistence';
import {
  __pluginDefaultsHandOffsForTests,
  updateWorkspacePlugins,
} from '../workspace-plugin-defaults';
import { registerWorkspaceTypes } from '../workspace-registry';
import { updateWorkspaceRetention } from '../workspace-retention';
import {
  setWorktreeHooksPaused,
  updateWorkspaceHooks,
} from '../workspace-script-hook-settings';
import { moveWorktree, updateWorktree } from '../worktree-update';

jest.setTimeout(90_000);

/** The routed writer's commit label. */
const ROUTED = 'w5d2.test.routed-writer';
const NEW_DEFAULTS: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [{ sourceId: 'source', skillName: 'new-skill' }],
  pluginRefs: [],
};
const STALE_TOUCH = '2020-01-01T00:00:00.000Z';
/** A new pipeline hook, which #7 binds to the context it captures. */
const newHooks = (): {
  'worktree:created': { type: 'pipeline'; source: 'bundled'; id: string }[];
} => ({
  'worktree:created': [{ type: 'pipeline', source: 'bundled', id: 'p' }],
});

let dir: string;
let root: string;
let dbPath: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
let normalizations: jest.Mock;
/** Daemon side: the commits Electron's transport sent, with their results. */
let sent: { operation: string; result: 'committed' | 'refused' | 'failed' }[];
/** Routed writes still armed, each before Electron's next commit of `path`. */
let armed: { path: string; remaining: number; fired: number } | undefined;

const manifestPath = (id: string): string => join(root, id, 'workspace.json');
const listPath = (): string => join(root, 'a', 'worktrees.json');
const entriesPath = (): string => getWorkspaceWorkEntriesFilePath('c');

function readObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`Expected an object in ${path}`);
  return { ...parsed };
}
function rows(): Record<string, unknown>[] {
  const { worktrees } = readObject(listPath());
  if (!Array.isArray(worktrees)) throw new Error('worktrees.json shape');
  return worktrees.map((row: unknown) =>
    typeof row === 'object' && row !== null ? { ...row } : {},
  );
}
function images(): string[] {
  return [
    join(root, 'index.json'),
    manifestPath('a'),
    manifestPath('c'),
    listPath(),
  ].map((path) => readFileSync(path, 'utf8'));
}
const count = (key: string): number => w5ConflictCounts().get(key) ?? 0;

/** A foreign change of the file at `path`, the `n`th routed write. */
function foreign(path: string, n: number): string {
  if (path === listPath()) {
    const list = readObject(path);
    return JSON.stringify({
      ...list,
      worktrees: rows().map((row) =>
        row.id === 'two' ? { ...row, label: `Routed ${n}` } : row,
      ),
    });
  }
  return JSON.stringify({ ...readObject(path), foreignField: `routed-${n}` });
}

/** Whether every routed write so far is still on disk. */
function routedKept(path: string, n: number): boolean {
  if (path === listPath())
    return rows().some(
      (row) => row.id === 'two' && row.label === `Routed ${n}`,
    );
  return readObject(path).foreignField === `routed-${n}`;
}

/**
 * Arms `times` routed writes of `path`. Daemon side: another writer's CAS
 * commit lands just before each of Electron's commits touching the file,
 * after its fresh read. In-process: a foreign write lands at the decision's
 * final preflight read.
 */
function armRoutedWrites(
  side: W5StoreSide,
  path: string,
  times: number,
): { fired: () => number } {
  armed = { path, remaining: times, fired: 0 };
  if (side === 'in-process') {
    const read = nodeW5FileStore.read.bind(nodeW5FileStore);
    jest.spyOn(nodeW5FileStore, 'read').mockImplementation(async (file) => {
      if (
        armed &&
        armed.remaining > 0 &&
        file === armed.path &&
        isW5FinalPreflightRead(new Error().stack ?? '')
      ) {
        armed.remaining -= 1;
        armed.fired += 1;
        writeFileSync(file, foreign(file, armed.fired));
      }
      return read(file);
    });
  }
  return { fired: () => armed?.fired ?? 0 };
}

/** The authority's typed stale-file refusal, as the wire carries it. */
function isFingerprintConflict(error: unknown): boolean {
  if (!(error instanceof Error) || !('payload' in error)) return false;
  const { payload } = error;
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'code' in payload &&
    payload.code === 'core.workspaceRecords.fingerprintConflict'
  );
}

/** Daemon side: the routed writes and the record of Electron's commits. */
function wrapTransport(
  transport: W5RecordPortTransport,
): W5RecordPortTransport {
  return {
    ...transport,
    commit: async (request) => {
      const target = armed && w5RecordTargetFor(root, armed.path);
      if (
        armed &&
        target &&
        armed.remaining > 0 &&
        request.files.some(
          (file) => JSON.stringify(file.target) === JSON.stringify(target),
        )
      ) {
        armed.remaining -= 1;
        armed.fired += 1;
        const raw = readFileSync(armed.path, 'utf8');
        await transport.commit({
          operation: ROUTED,
          advance: [],
          files: [
            {
              target,
              contents: foreign(armed.path, armed.fired),
              previousFingerprint: createHash('sha256')
                .update(raw, 'utf8')
                .digest('hex'),
            },
          ],
          outcome: null,
        });
      }
      try {
        const result = await transport.commit(request);
        sent.push({ operation: request.operation, result: 'committed' });
        return result;
      } catch (error) {
        sent.push({
          operation: request.operation,
          result: isFingerprintConflict(error) ? 'refused' : 'failed',
        });
        throw error;
      }
    },
  };
}

function startHost(): W5CommitLogHost {
  return new W5CommitLogHost({
    dbPath,
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
}

/**
 * The fixture directory, every ISO time and every UUID (read repair assigns
 * each fixture row a fresh replica id), masked.
 */
function portable(text: string): string {
  return text
    .split(dir)
    .join('<dir>')
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      '<uuid>',
    )
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<time>');
}

beforeAll(() => {
  setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
    Promise.resolve({ rows: next }),
  );
});
beforeEach(() => {
  ({ dir, root } = createW5BoundaryFixture((createdAt) => [
    { id: 'one', branchName: 'first', createdAt },
    { id: 'two', branchName: 'second', createdAt },
  ]));
  const index = readObject(join(root, 'index.json'));
  const workspaces: unknown[] = Array.isArray(index.workspaces)
    ? index.workspaces
    : [];
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      ...index,
      workspaces: [
        ...workspaces,
        {
          id: 'c',
          name: 'Cowork',
          type: 'cowork',
          color: '#7C3AED',
          collapsed: false,
          order: 1,
        },
      ],
    }),
  );
  mkdirSync(join(root, 'c'), { recursive: true });
  writeFileSync(
    manifestPath('c'),
    JSON.stringify({
      version: 1,
      type: 'cowork',
      repos: [],
      cowork: { description: 'original', futureSetting: true },
    }),
  );
  writeFileSync(
    join(root, 'c', 'worktrees.json'),
    JSON.stringify({ version: 1, worktrees: [] }),
  );
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  mkdirSync(join(entriesPath(), '..'), { recursive: true });
  writeFileSync(
    entriesPath(),
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'first',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastTouchedAt: STALE_TOUCH,
        },
      ],
    }),
  );
  __resetSidebarItemsStateForTests();
  registerWorkspaceTypes(
    new Map([
      ['a', 'single-repo'],
      ['c', 'cowork'],
    ]),
  );
  dbPath = join(dir, 'w5', 'commit-log.sqlite');
  host = startHost();
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  normalizations = jest.fn(() => Promise.resolve());
  setBeforeProjectPluginDefaultsChangeHandler(normalizations);
  mockSelectedContext.mockReset();
  mockSelectedContext.mockImplementation(() => ({ kind: 'personal' }));
  sent = [];
  armed = undefined;
});
afterEach(async () => {
  jest.restoreAllMocks();
  await settleDetachedWork();
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  resetWorkspaceActivityForTests();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await shutdownW5BoundaryHost(host, dbPath);
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

interface Retry {
  idempotencyKey?: string;
  expectedRevision?: number;
}

interface GuardedCommand {
  name: string;
  /** The boundary's operation, which labels its retry counts. */
  operation: string;
  /** The canonical file a routed write races. */
  path: () => string;
  resource: () => W5Resource;
  run: (retry?: Retry) => Promise<unknown>;
  landed: () => boolean;
}

const PERSONAL = serializeWorkspaceContext({ kind: 'personal' });

/** The stored #7 hooks, bound to `context`. */
function hooksBoundTo(context: string): boolean {
  return isDeepStrictEqual(readObject(manifestPath('a')).hooks, {
    'worktree:created': [
      {
        type: 'pipeline',
        source: 'bundled',
        id: 'p',
        executionContext: context,
      },
    ],
  });
}

const HOOKS_UPDATE: GuardedCommand = {
  name: '#7 updateWorkspaceHooks',
  operation: 'core.workspace.hooks.update',
  path: () => manifestPath('a'),
  resource: () => ({ kind: 'workspace', workspaceId: 'a' }),
  run: (retry) =>
    updateWorkspaceHooks({
      workspaceId: 'a',
      source: 'desktop',
      change: { kind: 'replace', hooks: newHooks() },
      ...retry,
    }),
  landed: () => hooksBoundTo(PERSONAL),
};

const HOOKS_PAUSE: GuardedCommand = {
  name: '#26 setWorktreeHooksPaused',
  operation: 'core.worktree.hooks.setPaused',
  path: listPath,
  resource: () => ({ kind: 'worktree', workspaceId: 'a', worktreeId: 'one' }),
  run: (retry) =>
    setWorktreeHooksPaused({
      workspaceId: 'a',
      worktreeId: 'one',
      source: 'desktop',
      change: { kind: 'pause', hookKeys: ['hook-a'] },
      ...retry,
    }),
  landed: () =>
    rows().some(
      (row) =>
        row.id === 'one' && isDeepStrictEqual(row.pausedHookKeys, ['hook-a']),
    ),
};

const COMMANDS: readonly GuardedCommand[] = [
  HOOKS_UPDATE,
  {
    name: '#9 updateWorkspacePlugins setDefaults',
    operation: 'core.workspace.plugins.update',
    path: () => manifestPath('a'),
    resource: () => ({ kind: 'workspace', workspaceId: 'a' }),
    run: (retry) =>
      updateWorkspacePlugins({
        workspaceId: 'a',
        source: 'project_settings',
        change: { kind: 'setDefaults', defaultPluginSelections: NEW_DEFAULTS },
        ...retry,
      }),
    landed: () =>
      JSON.stringify(readObject(manifestPath('a')).defaultPluginSelections) ===
      JSON.stringify(normalizePluginSelections(NEW_DEFAULTS)),
  },
  {
    name: '#11 updateWorkspaceRetention',
    operation: 'core.workspace.retention.update',
    path: () => manifestPath('a'),
    resource: () => ({ kind: 'workspace', workspaceId: 'a' }),
    run: (retry) =>
      updateWorkspaceRetention({
        workspaceId: 'a',
        source: 'workspace_settings',
        patch: { archiveRetentionDays: 30 },
        ...retry,
      }),
    landed: () => readObject(manifestPath('a')).archiveRetentionDays === 30,
  },
  {
    name: '#12 updateCoworkWorkspaceSettings',
    operation: 'core.workspace.cowork.update',
    path: () => manifestPath('c'),
    resource: () => ({ kind: 'workspace', workspaceId: 'c' }),
    run: (retry) =>
      updateCoworkWorkspaceSettings({
        projectId: 'c',
        description: 'edited',
        ...retry,
      }),
    landed: () => {
      const { cowork } = readObject(manifestPath('c'));
      return (
        typeof cowork === 'object' &&
        cowork !== null &&
        'description' in cowork &&
        cowork.description === 'edited'
      );
    },
  },
  {
    name: '#22 updateWorktree',
    operation: 'core.worktree.update',
    path: listPath,
    resource: () => ({ kind: 'worktree', workspaceId: 'a', worktreeId: 'one' }),
    run: (retry) =>
      updateWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        patch: { label: 'Edited' },
        ...retry,
      }),
    landed: () =>
      rows().some((row) => row.id === 'one' && row.label === 'Edited'),
  },
  {
    name: '#23 moveWorktree',
    operation: 'core.worktree.reorder',
    path: listPath,
    resource: () => ({ kind: 'worktrees', workspaceId: 'a' }),
    run: (retry) =>
      moveWorktree({
        workspaceId: 'a',
        activeWorktreeId: 'one',
        overWorktreeId: 'two',
        ...retry,
      }),
    landed: () =>
      rows()
        .map((row) => row.id)
        .join() === 'two,one',
  },
  HOOKS_PAUSE,
];

/**
 * Per command, what each side decided for the same keyed change, portable:
 * compared after both sides ran (§5 item 1).
 */
const decidedBySide = new Map<string, Map<W5StoreSide, unknown>>();

describe.each(W5_STORE_SIDES)('over the %s store', (side) => {
  let teardown = (): Promise<void> => Promise.resolve();
  /** Daemon side: the W5e source the record port publishes through. */
  let events: W5CommitEventSource | undefined;
  async function install(): Promise<void> {
    events =
      side === 'daemon'
        ? createW5CommitEventSource({ host, epoch: 'runtime:w5d2-test' })
        : undefined;
    teardown = await installW5StoreSide(side, {
      host,
      root,
      setDaemonOwned: setDaemonOwnedForTest,
      wrapTransport,
      ...(events && { events }),
    });
  }
  beforeEach(install);
  afterEach(() => teardown());

  /** The worker and, on the daemon side, the record port restart. */
  async function restart(beforeStart?: () => void): Promise<void> {
    await teardown();
    await shutdownW5BoundaryHost(host, dbPath);
    beforeStart?.();
    host = startHost();
    await install();
  }

  /** The offline resolve (RX2) an operator runs on the cold log. */
  function resolveColdRecovery(): Promise<void> {
    return restart(() => {
      const cold = W5CommitLog.open(dbPath);
      try {
        for (const reservation of cold.listReservations())
          if (reservation.state === 'recovery-required')
            cold.resolveRecovery(reservation.reservationId);
      } finally {
        cold.close();
      }
    });
  }

  /** Daemon side: the published `core.workspace.committed` events. */
  function committedEvents(): { publishedBy?: unknown }[] {
    if (!events) return [];
    const replay = events.journal.resume({
      daemonEpoch: events.journal.epoch,
      sequence: 0,
    });
    if (replay.kind !== 'replay') throw new Error(replay.reason);
    return replay.entries
      .filter(({ event }) => event.name === CORE_WORKSPACE_COMMITTED_EVENT)
      .map(({ event }) => ({ ...event.payload }));
  }

  const attempts = (operation: string): number =>
    sent.filter((commit) => commit.operation === operation).length;

  describe.each(COMMANDS)('$name', (command) => {
    const retried = `${command.operation} fingerprint retried`;
    const exhausted = `${command.operation} fingerprint exhausted`;

    it.each([
      ['unkeyed', undefined],
      ['keyed', 'key'],
    ])(
      'a forced routed conflict, %s: daemon reruns once and lands once; in-process makes one attempt',
      async (_kind, idempotencyKey) => {
        const before = count(retried);
        const routed = armRoutedWrites(side, command.path(), 1);
        const run = command.run(
          idempotencyKey === undefined ? undefined : { idempotencyKey },
        );
        if (side === 'in-process') {
          await expect(run).rejects.toBeInstanceOf(W5FileWriteRefusedError);
          expect(routed.fired()).toBe(1);
          expect(command.landed()).toBe(false);
          expect(count(retried)).toBe(before);
          expect(routedKept(command.path(), 1)).toBe(true);
          return;
        }
        const outcome = await run;
        expect(routed.fired()).toBe(1);
        expect(count(retried)).toBe(before + 1);
        expect(command.landed()).toBe(true);
        // The routed write is kept: the rerun decided from a fresh read.
        expect(routedKept(command.path(), 1)).toBe(true);
        const decisions = sent.filter(
          (commit) => commit.operation !== ROUTED && commit.result !== 'failed',
        );
        expect(decisions.filter((c) => c.result === 'refused')).toHaveLength(1);
        expect(decisions.filter((c) => c.result === 'committed')).toHaveLength(
          1,
        );
        expect(hasHostAbsolutePath(outcome)).toBe(false);
        expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
        // One event per applied decision, the routed write's and the
        // change's, none for the refusal. Each names Electron's client, whose
        // own subscriber skips it.
        const published = committedEvents();
        expect(published).toHaveLength(routed.fired() + 1);
        for (const event of published)
          expect(event.publishedBy).toBe('electron-main');
        if (idempotencyKey === undefined) return;
        // The landed attempt saved the outcome its replay returns.
        const landed = images();
        await expect(command.run({ idempotencyKey })).resolves.toEqual(outcome);
        expect(images()).toEqual(landed);
        expect(committedEvents()).toHaveLength(published.length);
      },
    );

    it('a conflict on every attempt: daemon exhausts after three and releases the key', async () => {
      const before = count(exhausted);
      const routed = armRoutedWrites(side, command.path(), 3);
      await expect(
        command.run({ idempotencyKey: 'key' }),
      ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
      expect(routed.fired()).toBe(side === 'daemon' ? 3 : 1);
      expect(count(exhausted)).toBe(side === 'daemon' ? before + 1 : before);
      expect(command.landed()).toBe(false);
      // Daemon side: only the routed writes published; no refusal did.
      if (side === 'daemon') expect(committedEvents()).toHaveLength(3);
      // Released: the same key runs again and decides, rather than in-progress.
      armed = undefined;
      await command.run({ idempotencyKey: 'key' });
      expect(command.landed()).toBe(true);
      expect(routedKept(command.path(), side === 'daemon' ? 3 : 1)).toBe(true);
      if (side === 'daemon') expect(committedEvents()).toHaveLength(4);
    });

    it('a stale revision is never retried and commits nothing', async () => {
      const before = images();
      const retries = count(retried);
      const commits = jest.spyOn(host, 'commit');
      await expect(
        command.run({ expectedRevision: 99, idempotencyKey: 'key' }),
      ).rejects.toBeInstanceOf(W5RevisionConflictError);
      expect(images()).toEqual(before);
      expect(count(retried)).toBe(retries);
      expect(
        commits.mock.calls.filter(([request]) => request.files.length > 0),
      ).toEqual([]);
      if (side === 'daemon')
        expect(attempts(command.operation)).toBeLessThanOrEqual(1);
      expect(await host.revision(command.resource())).toBe(0);
    });

    it('a replay runs no host step again and returns a path-free outcome', async () => {
      const first = await command.run({ idempotencyKey: 'key' });
      expect(hasHostAbsolutePath(first)).toBe(false);
      const applied = images();
      const normalized = normalizations.mock.calls.length;
      const captured = mockSelectedContext.mock.calls.length;
      const leases = jest.spyOn(
        splitLocks,
        'acquireWorkspaceArchiveRetentionLease',
      );
      const commits = jest.spyOn(host, 'commit');
      const replayed = await command.run({ idempotencyKey: 'key' });
      expect(replayed).toEqual(first);
      expect(hasHostAbsolutePath(replayed)).toBe(false);
      expect(commits).not.toHaveBeenCalled();
      expect(images()).toEqual(applied);
      expect(normalizations).toHaveBeenCalledTimes(normalized);
      expect(mockSelectedContext).toHaveBeenCalledTimes(captured);
      expect(leases).not.toHaveBeenCalled();
    });

    it('after a restart, a replay runs no host step and commits nothing', async () => {
      const first = await command.run({ idempotencyKey: 'key' });
      const landed = images();
      await restart();
      const normalized = normalizations.mock.calls.length;
      const captured = mockSelectedContext.mock.calls.length;
      const leases = jest.spyOn(
        splitLocks,
        'acquireWorkspaceArchiveRetentionLease',
      );
      const commits = jest.spyOn(host, 'commit');
      await expect(command.run({ idempotencyKey: 'key' })).resolves.toEqual(
        first,
      );
      expect(commits).not.toHaveBeenCalled();
      expect(images()).toEqual(landed);
      expect(normalizations).toHaveBeenCalledTimes(normalized);
      expect(mockSelectedContext).toHaveBeenCalledTimes(captured);
      expect(leases).not.toHaveBeenCalled();
      expect(committedEvents()).toEqual([]);
    });

    it('records its keyed decision, refusal and outcome for the cross-side comparison', async () => {
      const commits = jest.spyOn(host, 'commit');
      const outcome = await command.run({
        idempotencyKey: 'key',
        expectedRevision: 0,
      });
      const refusal: unknown = await command
        .run({ idempotencyKey: 'other', expectedRevision: 0 })
        .then(
          () => 'applied',
          (error: unknown) =>
            error instanceof Error
              ? `${error.constructor.name}: ${portable(error.message)}`
              : 'unknown',
        );
      const decisions = commits.mock.calls.map(([request]) => ({
        operation: request.operation,
        receipt: request.receipt,
        advance: request.advance,
        expectedRevisions: request.expectedRevisions,
        outcome: request.outcome,
        files: request.files.map((file) => ({
          path: portable(file.path),
          contents: file.contents === null ? null : portable(file.contents),
        })),
      }));
      const record: unknown = JSON.parse(
        portable(
          JSON.stringify({
            outcome: outcome ?? null,
            refusal,
            decisions,
            revision: await host.revision(command.resource()),
            images: images(),
          }),
        ),
      );
      expect(decisions.length).toBeGreaterThan(0);
      const sides =
        decidedBySide.get(command.name) ?? new Map<W5StoreSide, unknown>();
      sides.set(side, record);
      decidedBySide.set(command.name, sides);
    });
  });

  describe('#9 updateWorkspacePlugins', () => {
    it('returns the normalized selections it stored', async () => {
      const repeated: ChatTabPluginSelections = {
        collectionIds: [],
        skillRefs: [
          { sourceId: 'source', skillName: 'b-skill' },
          { sourceId: 'source', skillName: 'a-skill' },
          { sourceId: 'source', skillName: 'b-skill' },
        ],
        pluginRefs: [],
      };
      armRoutedWrites(side, manifestPath('a'), side === 'daemon' ? 1 : 0);
      const outcome = await updateWorkspacePlugins({
        workspaceId: 'a',
        source: 'project_settings',
        change: { kind: 'setDefaults', defaultPluginSelections: repeated },
        idempotencyKey: 'key',
      });
      expect(outcome.defaultPluginSelections).toEqual(
        normalizePluginSelections(repeated),
      );
      expect(readObject(manifestPath('a')).defaultPluginSelections).toEqual(
        normalizePluginSelections(repeated),
      );
    });

    it('an unkeyed exhausted refusal wrote nothing, so it leaves no reconcile owed', async () => {
      armRoutedWrites(side, manifestPath('a'), 3);
      await expect(
        updateWorkspacePlugins({
          workspaceId: 'a',
          source: 'project_settings',
          change: {
            kind: 'setDefaults',
            defaultPluginSelections: NEW_DEFAULTS,
          },
        }),
      ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
      // Normalization is the repeat-safe host step each attempt runs again.
      expect(normalizations).toHaveBeenCalledTimes(side === 'daemon' ? 3 : 1);
      await settleDetachedWork();
      expect(__pluginDefaultsHandOffsForTests('a')).toBe(0);
    });

    it('a normalization failure leaves the key recovery-required, unretried', async () => {
      const before = count('core.workspace.plugins.update fingerprint retried');
      normalizations.mockRejectedValueOnce(new Error('chats unavailable'));
      await expect(
        updateWorkspacePlugins({
          workspaceId: 'a',
          source: 'project_settings',
          change: {
            kind: 'setDefaults',
            defaultPluginSelections: NEW_DEFAULTS,
          },
          idempotencyKey: 'key',
        }),
      ).rejects.toThrow();
      expect(normalizations).toHaveBeenCalledTimes(1);
      expect(count('core.workspace.plugins.update fingerprint retried')).toBe(
        before,
      );
      await expect(
        updateWorkspacePlugins({
          workspaceId: 'a',
          source: 'project_settings',
          change: {
            kind: 'setDefaults',
            defaultPluginSelections: NEW_DEFAULTS,
          },
          idempotencyKey: 'key',
        }),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      // RX2: the operator's offline resolve frees the key; the retry
      // normalizes again and decides once.
      const unresolved = images();
      await resolveColdRecovery();
      const commits = jest.spyOn(host, 'commit');
      await expect(
        updateWorkspacePlugins({
          workspaceId: 'a',
          source: 'project_settings',
          change: {
            kind: 'setDefaults',
            defaultPluginSelections: NEW_DEFAULTS,
          },
          idempotencyKey: 'key',
        }),
      ).resolves.toMatchObject({ written: true });
      expect(commits).toHaveBeenCalledTimes(1);
      expect(commits.mock.calls[0]?.[0].receipt).toBeDefined();
      expect(normalizations).toHaveBeenCalledTimes(2);
      expect(images()).not.toEqual(unresolved);
    });

    it.each([false, true])(
      'a replay still reconciles a layer a read cached stale (restart: %s)',
      async (restarted) => {
        const change = (): Promise<unknown> =>
          updateWorkspacePlugins({
            workspaceId: 'a',
            source: 'project_settings',
            change: {
              kind: 'setDefaults',
              defaultPluginSelections: NEW_DEFAULTS,
            },
            idempotencyKey: 'key',
          });
        await change();
        if (restarted) await restart();
        // A read that raced the decision cached the earlier, empty layer.
        projectPluginDefaultsWritten({
          configPath: getWorkspaceConfigPath('a'),
          workspaceId: 'a',
          layerChanged: false,
        });
        void readThroughProjectPluginDefaults(getWorkspaceConfigPath('a'), () =>
          Promise.resolve({
            defaults: { defaultPluginSelections: undefined },
            cacheable: true,
          }),
        );
        expect(
          (await readProjectPluginDefaults('a')).defaultPluginSelections,
        ).toBeUndefined();
        const stale = getProjectPluginDefaultsRevision('a');
        const commits = jest.spyOn(host, 'commit');
        await change();
        expect(commits).not.toHaveBeenCalled();
        expect(
          normalizePluginSelections(
            (await readProjectPluginDefaults('a')).defaultPluginSelections,
          ),
        ).toEqual(normalizePluginSelections(NEW_DEFAULTS));
        expect(getProjectPluginDefaultsRevision('a')).toBe(stale + 1);
      },
    );

    it("reruns a fork's selectRecommended, which runs after the fork's own decision", async () => {
      const before = count('core.workspace.plugins.update fingerprint retried');
      const routed = armRoutedWrites(side, manifestPath('a'), 1);
      // As `install.ts` adds a fork's default skills: outside any scope.
      const run = updateWorkspacePlugins({
        workspaceId: 'a',
        source: 'shared_container_fork',
        change: {
          kind: 'selectRecommended',
          selections: [
            { kind: 'skill', sourceId: 'source', skillName: 'forked' },
          ],
          optOutKeys: [],
          clearOptOutKeys: [],
        },
      });
      const forked = (): boolean =>
        JSON.stringify(
          readObject(manifestPath('a')).defaultPluginSelections ?? null,
        ).includes('"forked"');
      if (side === 'in-process') {
        await expect(run).rejects.toBeInstanceOf(W5FileWriteRefusedError);
        expect(forked()).toBe(false);
        return;
      }
      await run;
      expect(routed.fired()).toBe(1);
      expect(forked()).toBe(true);
      expect(routedKept(manifestPath('a'), 1)).toBe(true);
      expect(normalizations).toHaveBeenCalledTimes(2);
      expect(count('core.workspace.plugins.update fingerprint retried')).toBe(
        before + 1,
      );
    });

    it('runs once nested in an enclosing commit scope', async () => {
      const before = count('core.workspace.plugins.update fingerprint retried');
      armRoutedWrites(side, manifestPath('a'), 1);
      await expect(
        withW5Commit({ operation: 'w5d2.test.parent' }, () =>
          updateWorkspacePlugins({
            workspaceId: 'a',
            source: 'shared_container_fork',
            change: {
              kind: 'selectRecommended',
              selections: [
                { kind: 'skill', sourceId: 'source', skillName: 'forked' },
              ],
              optOutKeys: [],
              clearOptOutKeys: [],
            },
          }),
        ),
      ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
      expect(normalizations).toHaveBeenCalledTimes(1);
      expect(count('core.workspace.plugins.update fingerprint retried')).toBe(
        before,
      );
      if (side === 'daemon') expect(attempts('w5d2.test.parent')).toBe(1);
    });

    it('leaves replaceMcpServerRefs unwrapped: one attempt, surfaced', async () => {
      const device = { serverId: 'dev-1', configId: 'cfg-1' };
      await updateWorkspacePlugins({
        workspaceId: 'a',
        source: 'project_settings',
        change: {
          kind: 'setDefaults',
          defaultPluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [device],
          },
        },
      });
      const retries = count(
        'core.workspace.plugins.update fingerprint retried',
      );
      sent = [];
      armRoutedWrites(side, manifestPath('a'), 1);
      await expect(
        updateWorkspacePlugins({
          workspaceId: 'a',
          source: 'mcp_server_move',
          change: {
            kind: 'replaceMcpServerRefs',
            from: [{ serverId: 'dev-1' }],
            to: { serverId: 'custom:abc', configId: 'default' },
          },
        }),
      ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
      expect(count('core.workspace.plugins.update fingerprint retried')).toBe(
        retries,
      );
      if (side === 'daemon')
        expect(sent.filter((c) => c.operation !== ROUTED)).toHaveLength(1);
    });
  });

  describe('#11 updateWorkspaceRetention', () => {
    const enable = {
      workspaceId: 'a',
      source: 'workspace_settings' as const,
      patch: { archiveRetentionDays: 30, autoArchiveDays: 7 },
      idempotencyKey: 'key',
    };

    it('a held retention lease is retention-busy and releases the key', async () => {
      const release = splitLocks.acquireWorkspaceArchiveRetentionLease('a');
      try {
        await expect(updateWorkspaceRetention(enable)).rejects.toMatchObject({
          reason: 'retention-busy',
        });
      } finally {
        release();
      }
      await expect(updateWorkspaceRetention(enable)).resolves.toMatchObject({
        workspaceId: 'a',
      });
    });

    it('takes the lease again on each attempt', async () => {
      const leases = jest.spyOn(
        splitLocks,
        'acquireWorkspaceArchiveRetentionLease',
      );
      armRoutedWrites(side, manifestPath('a'), side === 'daemon' ? 1 : 0);
      await updateWorkspaceRetention({ ...enable, idempotencyKey: undefined });
      expect(leases).toHaveBeenCalledTimes(side === 'daemon' ? 2 : 1);
    });

    it('the stamp shares one commit with the settings and the receipt; a manifest conflict commits neither file', async () => {
      const commits = jest.spyOn(host, 'commit');
      const routed = armRoutedWrites(side, manifestPath('a'), 1);
      const run = updateWorkspaceRetention(enable);
      if (side === 'in-process') {
        await expect(run).rejects.toBeInstanceOf(W5FileWriteRefusedError);
        expect(routed.fired()).toBe(1);
        expect(commits).not.toHaveBeenCalled();
        expect(readObject(manifestPath('a')).autoArchiveDays).toBeUndefined();
        armed = undefined;
        await updateWorkspaceRetention(enable);
      } else {
        await run;
      }
      const decided = commits.mock.calls.filter(
        ([request]) =>
          request.operation === 'core.workspace.retention.update' &&
          request.files.length > 0,
      );
      expect(decided).toHaveLength(1);
      expect(decided[0]?.[0].files.map((file) => file.path).sort()).toEqual(
        [manifestPath('a'), listPath()].sort(),
      );
      expect(decided[0]?.[0].receipt).toMatchObject({ idempotencyKey: 'key' });
    });

    it('without a stamp, the fenced list is still CAS-checked', async () => {
      const before = count(
        'core.workspace.retention.update fingerprint retried',
      );
      const routed = armRoutedWrites(side, listPath(), 1);
      const run = updateWorkspaceRetention({
        workspaceId: 'a',
        source: 'workspace_settings',
        patch: { archiveRetentionDays: 30, autoArchiveDays: null },
      });
      if (side === 'in-process')
        await expect(run).rejects.toBeInstanceOf(W5FileWriteRefusedError);
      else await run;
      expect(routed.fired()).toBe(1);
      expect(readObject(manifestPath('a')).archiveRetentionDays).toBe(
        side === 'daemon' ? 30 : undefined,
      );
      expect(count('core.workspace.retention.update fingerprint retried')).toBe(
        side === 'daemon' ? before + 1 : before,
      );
      expect(routedKept(listPath(), 1)).toBe(true);
    });
  });

  describe('#12 updateCoworkWorkspaceSettings', () => {
    it('a failed Auto Delete touch is activity-unavailable and releases the key', async () => {
      const valid = readFileSync(entriesPath(), 'utf8');
      writeFileSync(entriesPath(), '{"version":1,"entries":');
      const request = {
        projectId: 'c',
        autoArchiveDays: 7,
        idempotencyKey: 'key',
      };
      await expect(
        updateCoworkWorkspaceSettings(request),
      ).rejects.toMatchObject({ reason: 'activity-unavailable' });
      writeFileSync(entriesPath(), valid);
      await expect(updateCoworkWorkspaceSettings(request)).resolves.toEqual({
        workspaceId: 'c',
      });
    });

    it.each([false, true])(
      'a replay still runs the CAN-4797 reconcile (restart: %s)',
      async (restarted) => {
        const request = {
          projectId: 'c',
          description: 'edited',
          idempotencyKey: 'key',
        };
        await updateCoworkWorkspaceSettings(request);
        if (restarted) await restart();
        const syncs = jest.mocked(schedulePortalStructuralSync);
        syncs.mockClear();
        const commits = jest.spyOn(host, 'commit');
        await expect(updateCoworkWorkspaceSettings(request)).resolves.toEqual({
          workspaceId: 'c',
        });
        expect(commits).not.toHaveBeenCalled();
        expect(syncs).toHaveBeenCalledTimes(1);
      },
    );

    it('refuses an enclosing commit scope before any attempt', async () => {
      await expect(
        withW5Commit({ operation: 'w5d2.test.parent' }, () =>
          updateCoworkWorkspaceSettings({ projectId: 'c', description: 'x' }),
        ),
      ).rejects.toMatchObject({ reason: 'invalid-request' });
    });

    /** The registered `chat-project:update` handler (W7b-1c). */
    function chatProjectUpdate(): (
      event: unknown,
      request: unknown,
    ) => Promise<unknown> {
      jest.mocked(registerIpcHandler).mockClear();
      registerChatProjectHandlers({
        dispatcher: createWorkspaceMetadataTestDispatcher(),
        resolveCaller: () => TEST_IPC_CALLER,
      });
      const registration = jest
        .mocked(registerIpcHandler)
        .mock.calls.find(
          ([channel]) => channel === IPC_CHANNELS.chatProjectUpdate,
        );
      if (!registration)
        throw new Error('chat-project:update is not registered');
      return registration[1] as (
        event: unknown,
        request: unknown,
      ) => Promise<unknown>;
    }
    const coworkName = (): unknown => {
      const { workspaces } = readObject(join(root, 'index.json'));
      const entries: unknown[] = Array.isArray(workspaces) ? workspaces : [];
      for (const entry of entries)
        if (
          typeof entry === 'object' &&
          entry !== null &&
          'id' in entry &&
          entry.id === 'c' &&
          'name' in entry
        )
          return entry.name;
      return undefined;
    };

    it("chat-project:update's Cowork settings take #12's rerun, then its name lands (W5d2 P2)", async () => {
      const save = chatProjectUpdate();
      const before = count('core.workspace.cowork.update fingerprint retried');
      const routed = armRoutedWrites(side, manifestPath('c'), 1);
      const settled = save(
        {},
        { projectId: 'c', name: 'Renamed', description: 'edited' },
      );
      if (side === 'in-process') {
        await expect(settled).rejects.toBeInstanceOf(W5FileWriteRefusedError);
        expect(routed.fired()).toBe(1);
        // The refused settings leave the save's other part unwritten.
        expect(coworkName()).toBe('Cowork');
        return;
      }
      await settled;
      expect(routed.fired()).toBe(1);
      expect(count('core.workspace.cowork.update fingerprint retried')).toBe(
        before + 1,
      );
      expect(readObject(manifestPath('c')).cowork).toMatchObject({
        description: 'edited',
        futureSetting: true,
      });
      expect(routedKept(manifestPath('c'), 1)).toBe(true);
      expect(coworkName()).toBe('Renamed');
      // The settings decision carries no receipt: the projection is unkeyed.
      expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
    });
  });

  describe('#7 updateWorkspaceHooks', () => {
    const contextUnavailable = (): never => {
      throw new Error('context unavailable');
    };

    it('a keyed change whose context capture fails consumes no key and decides nothing', async () => {
      const before = images();
      const commits = jest.spyOn(host, 'commit');
      mockSelectedContext.mockImplementationOnce(contextUnavailable);
      await expect(HOOKS_UPDATE.run({ idempotencyKey: 'key' })).rejects.toThrow(
        'context unavailable',
      );
      // Not a stale-file refusal, so it is never rerun.
      expect(mockSelectedContext).toHaveBeenCalledTimes(1);
      expect(commits).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
      expect(images()).toEqual(before);
      expect((await host.recoveryReport()).reservations ?? []).toEqual([]);
      // The key is free: the same request decides once.
      await HOOKS_UPDATE.run({ idempotencyKey: 'key' });
      expect(HOOKS_UPDATE.landed()).toBe(true);
      expect(await host.revision(HOOKS_UPDATE.resource())).toBe(1);
    });

    it('each attempt captures the context again, in admission, and binds the fresh one', async () => {
      const routed = armRoutedWrites(side, manifestPath('a'), 1);
      mockSelectedContext
        .mockImplementationOnce(() => ({ kind: 'personal' }))
        .mockImplementation(() => ORGANIZATION);
      const run = HOOKS_UPDATE.run({ idempotencyKey: 'key' });
      if (side === 'in-process') {
        await expect(run).rejects.toBeInstanceOf(W5FileWriteRefusedError);
        expect(mockSelectedContext).toHaveBeenCalledTimes(1);
        expect(readObject(manifestPath('a'))).not.toHaveProperty('hooks');
        return;
      }
      await run;
      expect(routed.fired()).toBe(1);
      expect(mockSelectedContext).toHaveBeenCalledTimes(2);
      expect(hooksBoundTo(serializeWorkspaceContext(ORGANIZATION))).toBe(true);
      expect(routedKept(manifestPath('a'), 1)).toBe(true);
    });

    it('a capture that fails on the rerun surfaces and releases the key', async () => {
      armRoutedWrites(side, manifestPath('a'), side === 'daemon' ? 1 : 0);
      mockSelectedContext
        .mockImplementationOnce(() => ({ kind: 'personal' }))
        .mockImplementationOnce(contextUnavailable);
      const run = HOOKS_UPDATE.run({ idempotencyKey: 'key' });
      if (side === 'in-process') {
        // No conflict in process, so the one attempt lands.
        await run;
        expect(mockSelectedContext).toHaveBeenCalledTimes(1);
        expect(HOOKS_UPDATE.landed()).toBe(true);
        return;
      }
      await expect(run).rejects.toThrow('context unavailable');
      expect(mockSelectedContext).toHaveBeenCalledTimes(2);
      expect(readObject(manifestPath('a'))).not.toHaveProperty('hooks');
      // Only the routed write published; the change decided nothing.
      expect(committedEvents()).toHaveLength(1);
      expect((await host.recoveryReport()).reservations ?? []).toEqual([]);
      await HOOKS_UPDATE.run({ idempotencyKey: 'key' });
      expect(HOOKS_UPDATE.landed()).toBe(true);
      expect(routedKept(manifestPath('a'), 1)).toBe(true);
    });
  });

  describe('#26 setWorktreeHooksPaused', () => {
    it('a keyed outcome decodes a path-free row, after a rerun too', async () => {
      const deletion = {
        referenceRepoPath: join(dir, 'repo'),
        repositoryIdentity: 'identity',
        branchName: 'first',
        expectedTip: 'abc123',
      };
      writeFileSync(
        listPath(),
        JSON.stringify({
          ...readObject(listPath()),
          worktrees: rows().map((row) =>
            row.id === 'one'
              ? { ...row, pendingArchiveBranchDeletion: deletion }
              : row,
          ),
        }),
      );
      const routed = armRoutedWrites(
        side,
        listPath(),
        side === 'daemon' ? 1 : 0,
      );
      const notifications = jest.mocked(notifyPortalStructureChanged);
      notifications.mockClear();
      const outcome = await setWorktreeHooksPaused({
        workspaceId: 'a',
        worktreeId: 'one',
        source: 'desktop',
        change: { kind: 'pause', hookKeys: ['hook-a'] },
        idempotencyKey: 'key',
      });
      expect(routed.fired()).toBe(side === 'daemon' ? 1 : 0);
      // The refused attempt's notification dropped with its scope.
      expect(notifications).toHaveBeenCalledTimes(1);
      expect(hasHostAbsolutePath(outcome)).toBe(false);
      expect(outcome).toMatchObject({
        changed: true,
        pausedHookKeys: ['hook-a'],
        worktree: { id: 'one', pausedHookKeys: ['hook-a'] },
      });
      expect(outcome.worktree).not.toHaveProperty(
        'pendingArchiveBranchDeletion',
      );
      // The stored row keeps its host fields.
      expect(rows().find((row) => row.id === 'one')).toMatchObject({
        pendingArchiveBranchDeletion: deletion,
        pausedHookKeys: ['hook-a'],
      });
    });
  });

  describe.each([HOOKS_UPDATE, HOOKS_PAUSE])('$name nested', (command) => {
    it('runs once in an enclosing commit scope', async () => {
      const retried = `${command.operation} fingerprint retried`;
      const before = count(retried);
      armRoutedWrites(side, command.path(), 1);
      await expect(
        withW5Commit({ operation: 'w5d2.test.parent' }, () => command.run()),
      ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
      expect(count(retried)).toBe(before);
      expect(command.landed()).toBe(false);
      expect(mockSelectedContext).toHaveBeenCalledTimes(
        command === HOOKS_UPDATE ? 1 : 0,
      );
      if (side === 'daemon') expect(attempts('w5d2.test.parent')).toBe(1);
    });
  });

  it('P14 guard: no guarded list write carries newItemId or sidebarItemGroupId', async () => {
    const options: (WorktreeRegistryWriteOptions | undefined)[] = [];
    setWorktreeRegistryReconciler((_workspaceId, _current, next, write) => {
      options.push(write);
      return Promise.resolve({ rows: next });
    });
    try {
      await updateWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        patch: { label: 'Edited' },
        worktreeOrder: ['two', 'one'],
      });
      await moveWorktree({
        workspaceId: 'a',
        activeWorktreeId: 'one',
        overWorktreeId: 'two',
      });
      await updateWorkspaceRetention({
        workspaceId: 'a',
        source: 'workspace_settings',
        patch: { archiveRetentionDays: 30, autoArchiveDays: 7 },
      });
      const beforePause = options.length;
      await HOOKS_PAUSE.run();
      expect(options.length).toBeGreaterThan(beforePause);
    } finally {
      setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
        Promise.resolve({ rows: next }),
      );
    }
    expect(options.length).toBeGreaterThanOrEqual(2);
    for (const write of options) {
      expect(write?.newItemId).toBeUndefined();
      expect(write?.sidebarItemGroupId).toBeUndefined();
    }
  });
});

describe('temp-root equivalence across W5_STORE_SIDES (§5 item 1)', () => {
  it.each(COMMANDS.map((command) => command.name))(
    '%s decides the same bytes, labels, revisions, receipts, outcomes and refusals',
    (name) => {
      const sides = decidedBySide.get(name);
      expect(sides?.size).toBe(W5_STORE_SIDES.length);
      expect(sides?.get('daemon')).toEqual(sides?.get('in-process'));
    },
  );
});
