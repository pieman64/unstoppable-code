// CAN-4409: the chat normalization of a keyed core.workspace.plugins.update
// user change through the real ChatStateService and the W5-writing chat
// commit observers, with the real commit-log worker and filesystem, under
// strict test storage admission (CAN-4418).
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { AsyncResource } from 'node:async_hooks';
import { readFileSync, rmSync } from 'node:fs';
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
jest.mock('../../ipc/register', () => ({ registerIpcHandler: jest.fn() }));

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  getWorkspaceManifestRepository,
  setBeforeProjectPluginDefaultsChangeHandler,
  updateWorkspaceConfig,
  updateWorkspaceWorktrees,
} from '../workspace-persistence';
import {
  setChatTabsRequiredDurabilityObserver,
  setChatTabsWriteObserver,
} from '../chat-tabs';
import { syncWorktreeChatBadgesFromWrite } from '../chat-badge-sync';
import {
  flushWorkspaceTargetTouches,
  resetWorkspaceActivityForTests,
  touchWorkspaceTargetAfterCommit,
} from '../workspace-activity';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  getChatStateService,
  resetChatStateServiceForTests,
} from '../../services/chat-state-service';
import { registerChatPersistenceHandlers } from '../../ipc/chat-persistence';
import { rewriteMcpServerRefs } from '../../mcp/server-ref-rewrite';
import { captureMcpRefRewriteOutcome } from '../../mcp/server-ref-rewrite-outcome';
import { updateWorkspacePlugins } from '../workspace-plugin-defaults';
import { currentW5CommitScope } from '../w5-commit-scope';
import {
  WORKSPACE_MANIFEST_STORAGE,
  WORKTREE_LIST_STORAGE,
  withStorageAdmission,
} from '../w5-storage';
import { StorageAdmissionError } from '@canopy/desktop-shared/node/lib/storage-admission';

jest.setTimeout(90_000);
let dir: string;
let root: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;

const SCOPE = { projectId: 'a', worktreeId: 'wt-1' } as const;

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

/** The required W5-writing part of the production chat commit observer. */
const observed: { calls: number; errors: unknown[] } = {
  calls: 0,
  errors: [],
};
/** Holds the observer, and so the normalization awaiting it, when set. */
let holdObserver: (() => Promise<void>) | undefined;
async function chatCommitObserver(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  observed.calls += 1;
  try {
    await touchWorkspaceTargetAfterCommit(projectId, worktreeId);
  } catch (error) {
    observed.errors.push(error);
    throw error;
  }
  await holdObserver?.();
}

beforeEach(async () => {
  ({ dir, root } = createW5BoundaryFixture((createdAt) => [
    { id: SCOPE.worktreeId, branchName: 'main', createdAt },
  ]));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  host = new W5CommitLogHost({
    dbPath: join(dir, 'data', 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  __resetSidebarItemsStateForTests();
  resetChatStateServiceForTests();
  resetWorkspaceActivityForTests();
  observed.calls = 0;
  observed.errors = [];
  holdObserver = undefined;
  await updateWorkspaceConfig('a', (config): void => {
    config.defaultPluginSelections = OLD_DEFAULTS;
  });
  // A legacy chat, inheriting the old defaults by copy.
  await getChatStateService().replaceCompatibilityTabs(SCOPE, {
    version: 1,
    activeTabId: 'legacy',
    tabs: [
      {
        id: 'legacy',
        title: 'Chat',
        createdAt: '2026-09-01T00:00:00.000Z',
        messages: [],
        pluginSelections: OLD_DEFAULTS,
      },
    ],
  });
  await settleDetachedWork();
  setChatTabsRequiredDurabilityObserver(chatCommitObserver);
  setChatTabsWriteObserver((projectId, worktreeId, data) => {
    void syncWorktreeChatBadgesFromWrite(projectId, worktreeId, data).catch(
      () => undefined,
    );
  });
  // The production registration of the normalization handler.
  registerChatPersistenceHandlers();
});
afterEach(async () => {
  setChatTabsWriteObserver(null);
  setChatTabsRequiredDurabilityObserver(null);
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  await settleDetachedWork();
  resetChatStateServiceForTests();
  jest.restoreAllMocks();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

/** Runs `work`, then lets the touches and detached work it started land. */
async function settled<T>(
  work: () => Promise<T>,
  { flushTouches = true } = {},
): Promise<T> {
  const result = await work();
  if (flushTouches) await flushWorkspaceTargetTouches();
  await settleDetachedWork();
  return result;
}

it('runs under strict storage admission', async () => {
  // The observers' worktree list write once nested in the manifest write's
  // admission this way (CAN-4418).
  await expect(
    withStorageAdmission([WORKSPACE_MANIFEST_STORAGE], () =>
      withStorageAdmission([WORKTREE_LIST_STORAGE], () => Promise.resolve()),
    ),
  ).rejects.toBeInstanceOf(StorageAdmissionError);
});

interface CapturedTouchTimer {
  delay: number;
  /** Fires the timer in the context that armed it, as the timer would. */
  fire: () => void;
  /** Whether a commit scope was current when the touch was deferred. */
  inCommitScope: boolean;
  /** The manifest's default selections when the touch was deferred. */
  manifestDefaults: unknown;
}

/**
 * Captures the timers the activity touch lane arms instead of arming them,
 * so a deferred touch fires when the test chooses rather than after a
 * real-time margin.
 */
function captureTouchTimers(): CapturedTouchTimer[] {
  const captured: CapturedTouchTimer[] = [];
  const realSetTimeout = global.setTimeout;
  jest
    .spyOn(global, 'setTimeout')
    .mockImplementation((handler, delay, ...args) => {
      if (!/workspace-activity\.ts/.test(new Error().stack ?? ''))
        return realSetTimeout(handler, delay, ...args);
      captured.push({
        delay: delay ?? 0,
        fire: AsyncResource.bind(() => handler(...args)),
        inCommitScope: currentW5CommitScope() !== undefined,
        manifestDefaults: manifestDefaults(),
      });
      // An inert handle for the lane to keep, unref and clear.
      const inert = realSetTimeout(() => undefined, 0);
      clearTimeout(inert);
      return inert;
    });
  return captured;
}

function worktreeFile(): string {
  return join(root, 'a', 'worktrees.json');
}

function worktreeRow(): Record<string, unknown> {
  const list: unknown = JSON.parse(
    readFileSync(join(root, 'a', 'worktrees.json'), 'utf8'),
  );
  if (typeof list !== 'object' || list === null || !('worktrees' in list))
    throw new Error('Expected a worktree list');
  const rows: unknown = list.worktrees;
  const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
  if (typeof row !== 'object' || row === null)
    throw new Error('Expected a worktree row');
  return { ...row };
}

function manifestDefaults(): unknown {
  const parsed: unknown = JSON.parse(
    readFileSync(join(root, 'a', 'workspace.json'), 'utf8'),
  );
  return typeof parsed === 'object' && parsed !== null
    ? Reflect.get(parsed, 'defaultPluginSelections')
    : undefined;
}

it.each([
  ['with a key', { idempotencyKey: 'key' }],
  ['with a revision', { expectedRevision: 1 }],
  ['without either', {}],
] as const)(
  '%s, the real chat state service normalizes outside the decision, and its observers commit on their own',
  async (_name, options) => {
    const commits = jest.spyOn(host, 'commit');
    const outcome = await settled(() =>
      updateWorkspacePlugins({
        ...options,
        workspaceId: 'a',
        change: { kind: 'setDefaults', defaultPluginSelections: NEW_DEFAULTS },
        source: 'project_settings',
      }),
    );
    expect(outcome.written).toBe(true);

    const [chat] = (await getChatStateService().getCompatibilityTabs(SCOPE))
      .tabs;
    expect(chat).toMatchObject({ inheritedPluginDefaultsVersion: 1 });
    expect(observed).toEqual({ calls: 1, errors: [] });
    expect(manifestDefaults()).toMatchObject({
      pluginRefs: NEW_DEFAULTS.pluginRefs,
    });
    // The observers' activity and badge writes reached the worktree list.
    const row = worktreeRow();
    expect(typeof row.lastTouchedAt).toBe('string');
    expect(typeof row.chatBadges).toBe('object');
    expect(row.chatBadges).not.toBeNull();

    const manifest = join(root, 'a', 'workspace.json');
    const worktrees = join(root, 'a', 'worktrees.json');
    const decisions = commits.mock.calls.map(([request]) => ({
      operation: request.operation,
      keyed: request.receipt !== undefined,
      files: request.files.map(({ path }) => path),
    }));
    // The defaults decision holds only the manifest; every worktree list
    // write commits as its own decision.
    const defaults = decisions.filter(({ files }) => files.includes(manifest));
    expect(defaults).toEqual([
      {
        operation:
          'expectedRevision' in options || 'idempotencyKey' in options
            ? 'core.workspace.plugins.update'
            : 'w5.workspace_manifest.write',
        keyed: 'idempotencyKey' in options,
        files: [manifest],
      },
    ]);
    const observerWrites = decisions.filter(({ files }) =>
      files.includes(worktrees),
    );
    expect(observerWrites.length).toBeGreaterThan(0);
    for (const write of observerWrites) {
      expect(write.keyed).toBe(false);
      expect(write.files).not.toContain(manifest);
    }
    // The awaited activity write commits before the decision.
    expect(
      decisions.findIndex(({ files }) => files.includes(worktrees)),
    ).toBeLessThan(
      decisions.findIndex(({ files }) => files.includes(manifest)),
    );

    if ('idempotencyKey' in options) {
      commits.mockClear();
      const tabs = await getChatStateService().getCompatibilityTabs(SCOPE);
      expect(
        await settled(() =>
          updateWorkspacePlugins({
            ...options,
            workspaceId: 'a',
            change: {
              kind: 'setDefaults',
              defaultPluginSelections: NEW_DEFAULTS,
            },
            source: 'project_settings',
          }),
        ),
      ).toEqual(outcome);
      expect(commits).not.toHaveBeenCalled();
      expect(observed.calls).toBe(1);
      expect(await getChatStateService().getCompatibilityTabs(SCOPE)).toEqual(
        tabs,
      );
    }
  },
);

it.each([
  ['with a key', { idempotencyKey: 'key' }],
  ['with a revision', { expectedRevision: 1 }],
  ['without either', {}],
] as const)(
  '%s, an activity touch the observers defer during normalization lands after the decision',
  async (_name, options) => {
    const timers = captureTouchTimers();
    // A touch inside the write interval makes the observer's touch, during
    // normalization, wait for a timer armed in the normalization's context.
    const previous = Date.now() - 1_000;
    await touchWorkspaceTargetAfterCommit('a', SCOPE.worktreeId, previous);
    const before = worktreeRow().lastTouchedAt;
    expect(before).toBe(new Date(previous).toISOString());
    expect(timers).toEqual([]);

    const commits = jest.spyOn(host, 'commit');
    const outcome = await settled(
      () =>
        updateWorkspacePlugins({
          ...options,
          workspaceId: 'a',
          change: {
            kind: 'setDefaults',
            defaultPluginSelections: NEW_DEFAULTS,
          },
          source: 'project_settings',
        }),
      { flushTouches: false },
    );
    expect(outcome.written).toBe(true);
    expect(observed).toEqual({ calls: 1, errors: [] });
    expect(manifestDefaults()).toMatchObject({
      pluginRefs: NEW_DEFAULTS.pluginRefs,
    });
    const decided = commits.mock.calls.length;
    const touchedAtDecision = worktreeRow().lastTouchedAt;
    // The observers' detached badge write is not refused either.
    expect(worktreeRow().chatBadges).toEqual(expect.any(Object));

    // The decision, its commit scope and its locks have finished.
    for (const timer of timers) timer.fire();
    await settleDetachedWork();
    const after = worktreeRow().lastTouchedAt;
    expect({
      // Deferred once, during normalization: outside any commit scope and
      // before the decision wrote the manifest.
      deferred: timers.map((timer) => ({
        waits: timer.delay > 0,
        inCommitScope: timer.inCommitScope,
        manifestDefaults: timer.manifestDefaults,
      })),
      touchedAtDecision,
      touchedAfterFiring: Date.parse(String(after)) > previous,
      // The fired touch commits on its own.
      afterDecision: commits.mock.calls.slice(decided).map(([request]) => ({
        keyed: request.receipt !== undefined,
        files: request.files.map(({ path }) => path),
      })),
    }).toEqual({
      deferred: [
        { waits: true, inCommitScope: false, manifestDefaults: OLD_DEFAULTS },
      ],
      touchedAtDecision: before,
      touchedAfterFiring: true,
      afterDecision: [
        { keyed: false, files: [join(root, 'a', 'worktrees.json')] },
      ],
    });
  },
);

it.each([
  ['with a key', { idempotencyKey: 'key' }],
  ['with a revision', { expectedRevision: 1 }],
  ['without either', {}],
] as const)(
  '%s, an activity touch the observers defer that fires during normalization lands before the decision',
  async (_name, options) => {
    const timers = captureTouchTimers();
    const previous = Date.now() - 1_000;
    await touchWorkspaceTargetAfterCommit('a', SCOPE.worktreeId, previous);
    expect(worktreeRow().lastTouchedAt).toBe(new Date(previous).toISOString());

    // Normalization awaits the observer inside the manifest write's
    // admission and, with a key or revision, the decision's commit scope.
    let reached = false;
    let reachObserver = (): void => undefined;
    const observerReached = new Promise<void>((resolve) => {
      reachObserver = resolve;
    });
    let releaseObserver = (): void => undefined;
    const observerReleased = new Promise<void>((resolve) => {
      releaseObserver = resolve;
    });
    holdObserver = (): Promise<void> => {
      reached = true;
      reachObserver();
      return observerReleased;
    };
    const commits = jest.spyOn(host, 'commit');
    const update = updateWorkspacePlugins({
      ...options,
      workspaceId: 'a',
      change: { kind: 'setDefaults', defaultPluginSelections: NEW_DEFAULTS },
      source: 'project_settings',
    });
    let inFlight: { touched: boolean; defaults: unknown };
    try {
      // Fails fast if the update settles without holding the observer.
      await Promise.race([
        observerReached,
        update.then(
          () => undefined,
          () => undefined,
        ),
      ]);
      expect(reached).toBe(true);
      for (const timer of timers) timer.fire();
      await flushWorkspaceTargetTouches();
      inFlight = {
        touched: Date.parse(String(worktreeRow().lastTouchedAt)) > previous,
        defaults: manifestDefaults(),
      };
    } finally {
      releaseObserver();
    }
    const outcome = await settled(() => update);
    expect(outcome.written).toBe(true);
    expect(observed).toEqual({ calls: 1, errors: [] });
    expect(manifestDefaults()).toMatchObject({
      pluginRefs: NEW_DEFAULTS.pluginRefs,
    });
    expect(worktreeRow().chatBadges).toEqual(expect.any(Object));
    const manifest = join(root, 'a', 'workspace.json');
    const decisions = commits.mock.calls.map(([request]) => ({
      keyed: request.receipt !== undefined,
      files: request.files.map(({ path }) => path),
    }));
    const decision = decisions.findIndex(({ files }) =>
      files.includes(manifest),
    );
    expect({
      deferred: timers.map((timer) => ({
        waits: timer.delay > 0,
        inCommitScope: timer.inCommitScope,
      })),
      inFlight,
      // The fired touch, and any badge write, commit on their own before it.
      beforeDecision: decisions
        .slice(0, decision)
        .some(
          ({ keyed, files }) =>
            !keyed && files.length === 1 && files[0] === worktreeFile(),
        ),
      decision: decisions[decision]?.files,
    }).toEqual({
      deferred: [{ waits: true, inCommitScope: false }],
      inFlight: { touched: true, defaults: OLD_DEFAULTS },
      beforeDecision: true,
      decision: [manifest],
    });
    for (const { files } of decisions.slice(0, decision))
      expect(files).toEqual([worktreeFile()]);
  },
);

it.each(['success', 'normalization', 'manifestCommit'])(
  'MCP rewrite records real normalization effects separately: %s',
  async (failure) => {
    const device = { serverId: 'dev-1', configId: 'cfg-1' };
    const destination = { serverId: 'custom:abc', configId: 'default' };
    const defaults = selections({ mcpServerRefs: [device] });
    setBeforeProjectPluginDefaultsChangeHandler(undefined);
    await updateWorkspaceConfig('a', (config) => {
      config.defaultPluginSelections = defaults;
    });
    await updateWorkspaceWorktrees('a', (worktrees) => [
      ...worktrees,
      { id: 'wt-2', branchName: 'other', createdAt: '2026-10-27T00:00:00Z' },
    ]);
    for (const worktreeId of ['wt-1', 'wt-2']) {
      await getChatStateService().replaceCompatibilityTabs(
        { projectId: 'a', worktreeId },
        {
          version: 1,
          activeTabId: 'legacy',
          tabs: [
            {
              id: 'legacy',
              title: 'Chat',
              createdAt: '2026-10-27T00:00:00Z',
              messages: [],
              pluginSelections: defaults,
            },
          ],
        },
        { authoritative: true },
      );
      const seeded = (
        await getChatStateService().getCompatibilityTabs({
          projectId: 'a',
          worktreeId,
        })
      ).tabs[0];
      expect(seeded?.pluginSelections?.mcpServerRefs).toEqual([device]);
      expect(seeded?.inheritedPluginDefaultsVersion).toBeUndefined();
    }
    await settleDetachedWork();
    registerChatPersistenceHandlers();
    const service = getChatStateService();
    const update = service.updateCompatibilityTabs.bind(service);
    jest
      .spyOn(service, 'updateCompatibilityTabs')
      .mockImplementation((scope, ...args) => {
        if (failure === 'normalization' && scope.worktreeId === 'wt-2') {
          return Promise.reject(
            Object.assign(new Error('disk'), { code: 'EIO' }),
          );
        }
        return update(scope, ...args);
      });
    const explicit = jest.spyOn(service, 'updateCompatibilityTab');
    if (failure === 'manifestCommit') {
      jest
        .spyOn(getWorkspaceManifestRepository(), 'replace')
        .mockRejectedValueOnce(
          Object.assign(new Error('disk'), { code: 'EIO' }),
        );
    }
    const outcome = await settled(() =>
      captureMcpRefRewriteOutcome(() =>
        rewriteMcpServerRefs({ from: [device], to: destination }),
      ),
    );
    resetChatStateServiceForTests();
    const first = (await getChatStateService().getCompatibilityTabs(SCOPE))
      .tabs[0];
    expect(first).toMatchObject({
      inheritedPluginDefaultsVersion: 1,
      pluginSelections: { mcpServerRefs: [] },
    });
    expect(explicit).not.toHaveBeenCalled();
    if (failure === 'success') {
      expect(outcome).toEqual({
        ok: true,
        value: { globalDefaults: false, workspaces: 1, chats: 0 },
      });
      expect(manifestDefaults()).toMatchObject({
        mcpServerRefs: [destination],
      });
    } else {
      expect(outcome).toMatchObject({
        ok: false,
        error: {
          kind: 'unavailable',
          code: 'core.catalog.mcpServer.rewriteIncomplete',
          details: { phase: 'rewrite', phases: [failure], effects: 'unknown' },
          retry: { kind: 'never' },
        },
      });
      expect(outcome).not.toHaveProperty('value');
      expect(manifestDefaults()).toMatchObject({ mcpServerRefs: [device] });
      const second = (
        await getChatStateService().getCompatibilityTabs({
          projectId: 'a',
          worktreeId: 'wt-2',
        })
      ).tabs[0];
      expect(second?.inheritedPluginDefaultsVersion).toBe(
        failure === 'normalization' ? undefined : 1,
      );
    }
  },
);
