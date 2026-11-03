import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createW5BoundaryFixture } from '../../lib/__tests__/fixtures/w5-boundary-fixture';
import type * as MainProcessLogging from '../../lib/main-process-logging';

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
jest.mock('../../lib/main-process-logging', () => ({
  ...jest.requireActual<typeof MainProcessLogging>(
    '../../lib/main-process-logging',
  ),
  logMainProcessWarn: jest.fn(),
}));

import { logMainProcessWarn } from '../../lib/main-process-logging';
import { notifyPortalStructureChanged } from '../../portal/portal-event-bus';
import { schedulePortalStructuralSync } from '../../portal/portal-structural-sync';
import {
  createEventsCore,
  type EventsCore,
} from '../../../../../../packages/core-client/src/__tests__/fixtures/events-core';
import {
  getWorkspaceExternalPath,
  listRegisteredWorkspaceIds,
} from '../../lib/workspace-registry';
import { __setDesktopW5FileStoreForTests } from '../../lib/w5-commit-log-file-store';
import { nodeW5FileStore } from '../../lib/w5-file-store';
import {
  __resetSidebarItemsStateForTests,
  readAllSidebarItems,
  WorkspaceRegistriesDegradedError,
} from '../../lib/sidebar-items';
import {
  clearWorktreesSelfWriteTracking,
  getWorkspaceManifestRepository,
  isWorktreesSelfWriteContent,
  readProjectPluginDefaults,
  wasRecentWorktreesSelfWrite,
} from '../../lib/workspace-persistence';
import {
  subscribeWorktreeLifecycleChanges,
  type WorktreeLifecycleChange,
} from '../../lib/worktree-lifecycle-signals';
import { getProjectPluginDefaultsRevision } from '../../plugins/plugin-defaults-revision';
import * as pluginDefaultsCache from '../../plugins/project-plugin-defaults-cache';
import { projectPluginDefaultsWritten } from '../../plugins/project-plugin-defaults-cache';
import { getWorkspaceConfigPath } from '../../lib/paths';
import {
  __pluginDefaultsHandOffsForTests,
  __setInlinePluginDefaultsReconcileBoundForTests,
} from '../../lib/workspace-plugin-defaults';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import {
  commitsLandingOnEveryPass,
  settlesWithin,
} from '../../lib/__tests__/fixtures/plugin-defaults-reconcile-bound';
import {
  createDesktopWorkspaceCommitEventHandlers,
  ManifestPluginDefaultsUndecidedError,
} from '../workspace-commit-event-handlers';
import {
  createWorkspaceCommitEventBinding,
  WorkspaceCommitHandlersError,
  type WorkspaceCommitEventBinding,
} from '../workspace-commit-events';

jest.setTimeout(30_000);
let dir: string;
let root: string;
let repo: string;
let originalDataDir: string | undefined;
let binding: WorkspaceCommitEventBinding;

beforeEach(() => {
  ({ dir, root, repo } = createW5BoundaryFixture((createdAt) => [
    { id: 'wt-1', branchName: 'dev-mole', createdAt },
  ]));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  clearWorktreesSelfWriteTracking('a');
  binding = createWorkspaceCommitEventBinding({
    handlers: createDesktopWorkspaceCommitEventHandlers(),
    isOwnOrigin: () => false,
  });
});
afterEach(async () => {
  await binding.close();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.clearAllMocks();
});

const listPlan = {
  broad: false,
  index: false,
  workspaces: [],
  manifests: [],
  worktreeLists: ['a'],
};

it('leaves a list another origin committed to the watcher’s external path', async () => {
  const changes: WorktreeLifecycleChange[] = [];
  const unsubscribe = subscribeWorktreeLifecycleChanges(
    (change) => void changes.push(change),
  );
  try {
    await binding.apply(listPlan);
    const path = join(root, 'a', 'worktrees.json');
    const createdAt = new Date().toISOString();
    // The daemon's commit, written by another process.
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        worktrees: [
          { id: 'wt-1', branchName: 'dev-mole', createdAt },
          { id: 'wt-2', branchName: 'cli-made', createdAt },
        ],
      }),
    );
    changes.length = 0;
    await binding.apply(listPlan);

    expect(changes).toEqual(['worktree-list-membership']);
    expect(schedulePortalStructuralSync).toHaveBeenCalled();
    // No self-write record: the watcher still reconciles it as external.
    expect(wasRecentWorktreesSelfWrite('a')).toBe(false);
    expect(isWorktreesSelfWriteContent('a', readFileSync(path, 'utf8'))).toBe(
      false,
    );
    // An unchanged membership publishes nothing more.
    changes.length = 0;
    await binding.apply(listPlan);
    expect(changes).toEqual([]);
  } finally {
    unsubscribe();
  }
});

it('registers the external path from a manifest another origin committed', async () => {
  const path = join(root, 'a', 'workspace.json');
  const externalPath = join(dir, 'external');
  writeFileSync(
    path,
    JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), externalPath }),
  );
  expect(getWorkspaceExternalPath('a')).toBeNull();

  await binding.apply({ ...listPlan, worktreeLists: [], manifests: ['a'] });

  expect(getWorkspaceExternalPath('a')).toBe(externalPath);
  expect(schedulePortalStructuralSync).toHaveBeenCalled();
  expect(notifyPortalStructureChanged).toHaveBeenCalled();
});

describe('a degraded read', () => {
  const manifestPlan = { ...listPlan, worktreeLists: [], manifests: ['a'] };
  const manifestPath = (): string => join(root, 'a', 'workspace.json');
  const externalPath = (): string => join(dir, 'external');
  const coworkManifest = (): Record<string, unknown> => ({
    version: 1,
    type: 'cowork',
    repos: [],
    externalPath: externalPath(),
  });
  /** Workspace `a` as an attached Cowork workspace. */
  const attachCowork = (): void => {
    const indexPath = join(root, 'index.json');
    writeFileSync(
      indexPath,
      readFileSync(indexPath, 'utf8').replace(
        '"type":"single-repo"',
        '"type":"cowork"',
      ),
    );
    writeFileSync(manifestPath(), JSON.stringify(coworkManifest()));
  };

  it('keeps the registries and rejects for an unreadable manifest', async () => {
    attachCowork();
    await binding.apply(manifestPlan);
    expect(getWorkspaceExternalPath('a')).toBe(externalPath());

    writeFileSync(manifestPath(), '{ not json');
    const failure = await binding
      .apply(manifestPlan)
      .catch((error: unknown) => error);
    expect(
      failure instanceof WorkspaceCommitHandlersError &&
        failure.errors.map((error) => error?.constructor),
    ).toEqual([
      WorkspaceRegistriesDegradedError,
      ManifestPluginDefaultsUndecidedError,
    ]);
    // Not the managed home: the last authoritative projection stays.
    expect(getWorkspaceExternalPath('a')).toBe(externalPath());
    // Nor does the sidebar read the plan's Portal sync starts replace it.
    await readAllSidebarItems();
    expect(getWorkspaceExternalPath('a')).toBe(externalPath());
  });

  it('keeps the registries and rejects for an unreadable index', async () => {
    attachCowork();
    await binding.apply({ ...listPlan, worktreeLists: [], index: true });
    writeFileSync(join(root, 'index.json'), '{ not json');

    await expect(
      binding.apply({ ...listPlan, worktreeLists: [], index: true }),
    ).rejects.toThrow(WorkspaceRegistriesDegradedError);
    expect(listRegisteredWorkspaceIds()).toEqual(['a']);
    expect(getWorkspaceExternalPath('a')).toBe(externalPath());
    await readAllSidebarItems();
    expect(listRegisteredWorkspaceIds()).toEqual(['a']);
    expect(getWorkspaceExternalPath('a')).toBe(externalPath());
  });

  it('refreshes from an index whose unreadable entry no retry can change', async () => {
    const indexPath = join(root, 'index.json');
    // A newer version's workspace type; the index keeps it on every write.
    const future = JSON.stringify({ id: 'future', name: 'F', type: 'notes' });
    writeFileSync(
      indexPath,
      readFileSync(indexPath, 'utf8').replace(/]}$/, `,${future}]}`),
    );

    await binding.apply({ ...listPlan, worktreeLists: [], index: true });

    expect(listRegisteredWorkspaceIds()).toEqual(['a']);
  });

  it('registers a readable manifest whose workspace failed to project for another reason', async () => {
    const manifest = readFileSync(manifestPath(), 'utf8');
    const withPath = (path: string): string =>
      manifest.replace(/}$/, `,"externalPath":${JSON.stringify(path)}}`);
    writeFileSync(manifestPath(), withPath(externalPath()));
    await binding.apply(manifestPlan);
    expect(getWorkspaceExternalPath('a')).toBe(externalPath());

    // Fails every read until someone fixes the repository's file.
    writeFileSync(join(repo, 'canopy.json'), '{ not json');
    const moved = join(dir, 'moved');
    writeFileSync(manifestPath(), withPath(moved));
    await binding.apply(manifestPlan);
    // From this manifest read, not carried over from the last projection.
    expect(getWorkspaceExternalPath('a')).toBe(moved);
  });

  it('rejects an unreadable manifest’s plugin defaults until a read decides them', async () => {
    await readProjectPluginDefaults('a');
    const revision = getProjectPluginDefaultsRevision('a');
    const manifest = readFileSync(manifestPath(), 'utf8');
    writeFileSync(manifestPath(), '{ not json');

    const failure = await binding
      .apply(manifestPlan)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkspaceCommitHandlersError);
    expect(
      failure instanceof WorkspaceCommitHandlersError &&
        failure.errors.map((error) => error?.constructor),
    ).toEqual([
      WorkspaceRegistriesDegradedError,
      ManifestPluginDefaultsUndecidedError,
    ]);
    expect(getProjectPluginDefaultsRevision('a')).toBe(revision);

    writeFileSync(
      manifestPath(),
      JSON.stringify({
        ...JSON.parse(manifest),
        defaultPluginSelections: {
          pluginRefs: [{ marketplaceId: 'market', pluginName: 'tool' }],
        },
      }),
    );
    await binding.apply(manifestPlan);
    // Sessions that inherited the served layer are recreated.
    expect(getProjectPluginDefaultsRevision('a')).toBe(revision + 1);
  });

  it('pushes a membership change for an unreadable list without rejecting', async () => {
    const changes: WorktreeLifecycleChange[] = [];
    const unsubscribe = subscribeWorktreeLifecycleChanges(
      (change) => void changes.push(change),
    );
    try {
      await binding.apply(listPlan);
      writeFileSync(join(root, 'a', 'worktrees.json'), '{ not json');
      changes.length = 0;
      await binding.apply(listPlan);
      // The observer re-reads membership itself; this read has nothing to hold.
      expect(changes).toEqual(['worktree-list-membership']);
    } finally {
      unsubscribe();
    }
  });

  describe('over a subscription', () => {
    let core: EventsCore;
    // Captured before any test fakes `Date`.
    const realNow = Date.now;
    afterEach(async () => {
      jest.useRealTimers();
      await core.close();
    });
    /**
     * Yields to real file reads until `done`, without advancing timers. A
     * real-time deadline, not a turn count: on a loaded shard the reads can
     * outlast thousands of turns. Callers assert the awaited value.
     */
    const until = async (done: () => boolean): Promise<void> => {
      const deadline = realNow() + 10_000;
      while (!done() && realNow() < deadline)
        await new Promise<void>((resolve) => setImmediate(resolve));
    };

    it('acknowledges a manifest commit only once its re-reads are authoritative', async () => {
      attachCowork();
      await binding.apply(manifestPlan);
      await readProjectPluginDefaults('a');
      const revision = getProjectPluginDefaultsRevision('a');
      core = createEventsCore();
      await binding.attach(await core.connect());
      await until(() => core.subscriptions.length > 0);
      expect(core.subscriptions).toHaveLength(1);
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
      writeFileSync(manifestPath(), '{ not json');
      await core.append(
        'core.workspace.committed',
        {
          commit: 'w5:cli',
          changes: [{ kind: 'workspace', workspaceId: 'a', revision: 1 }],
          files: [{ kind: 'manifest', workspaceId: 'a' }],
          publishedBy: 'cli-1',
        },
        { workspaceId: 'a' },
      );
      // The commit's plan and the first broad re-read both fail.
      const bridgeFailures = (): number =>
        jest
          .mocked(logMainProcessWarn)
          .mock.calls.filter(
            ([message]) =>
              message ===
              '[workspace-commit-events] delivery or subscription failed',
          ).length;
      await until(() => bridgeFailures() >= 2);
      expect(bridgeFailures()).toBe(2);
      expect(core.acknowledgements).toEqual([]);
      expect(getWorkspaceExternalPath('a')).toBe(externalPath());

      const moved = join(dir, 'moved');
      writeFileSync(
        manifestPath(),
        JSON.stringify({
          ...coworkManifest(),
          externalPath: moved,
          defaultPluginSelections: {
            pluginRefs: [{ marketplaceId: 'market', pluginName: 'tool' }],
          },
        }),
      );
      await jest.advanceTimersByTimeAsync(250);
      await until(() => core.acknowledgements.length > 0);
      expect(core.acknowledgements).toHaveLength(1);
      expect(getWorkspaceExternalPath('a')).toBe(moved);
      expect(getProjectPluginDefaultsRevision('a')).toBe(revision + 1);
    });
  });
});

describe('the manifest plugin-defaults reconcile waits within a bound (CAN-4409 D1)', () => {
  const BOUND = { passes: 3, deadlineMs: 250 };
  const TOOL = { marketplaceId: 'market', pluginName: 'tool' };
  const manifestPlan = { ...listPlan, worktreeLists: [], manifests: ['a'] };
  const manifestPath = (): string => join(root, 'a', 'workspace.json');

  // The gates of stalled reads, opened after each test so a failed one
  // cannot hold detached work past it.
  const gates: Array<() => void> = [];

  beforeEach(() => {
    __setInlinePluginDefaultsReconcileBoundForTests(BOUND);
  });
  afterEach(async () => {
    __setInlinePluginDefaultsReconcileBoundForTests(undefined);
    for (const open of gates.splice(0)) open();
    await settleDetachedWork();
    // A spy left on the reconcile would wrap the next test's spy.
    jest.restoreAllMocks();
  });

  /**
   * A chat read of the layer that loaded the manifest and does not return
   * until released. (This suite's plain file store opens no commit scope, so
   * no commit of it is ever settling.)
   */
  async function stalledChatRead(): Promise<{
    release: () => Promise<void>;
  }> {
    const repository = getWorkspaceManifestRepository();
    const read = repository.read.bind(repository);
    let reached = (): void => {};
    const loaded = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    gates.push(() => open());
    jest
      .spyOn(repository, 'read')
      .mockImplementationOnce(async (workspaceId) => {
        const result = await read(workspaceId);
        reached();
        await gate;
        return result;
      });
    // A write that leaves the layer alone: the read loads instead of hitting
    // the cache.
    projectPluginDefaultsWritten({
      configPath: getWorkspaceConfigPath('a'),
      workspaceId: 'a',
      layerChanged: false,
    });
    const session = readProjectPluginDefaults('a');
    await loaded;
    return {
      release: async (): Promise<void> => {
        open();
        await session;
      },
    };
  }

  /** Another origin's commit that adds a default plugin. */
  function commitToolDefault(): void {
    writeFileSync(
      manifestPath(),
      JSON.stringify({
        ...JSON.parse(readFileSync(manifestPath(), 'utf8')),
        defaultPluginSelections: { pluginRefs: [TOOL] },
      }),
    );
  }

  async function servedPluginRefs(): Promise<unknown> {
    return normalizePluginSelections(
      (await readProjectPluginDefaults('a')).defaultPluginSelections,
    ).pluginRefs;
  }

  it('a manifest commit behind a chat read that never returns rejects undecided within the bound; later plans apply, chat reads serve the manifest and the revision advances once', async () => {
    await readProjectPluginDefaults('a');
    const revision = getProjectPluginDefaultsRevision('a');
    const stalled = await stalledChatRead();
    commitToolDefault();

    const failure = await settlesWithin(
      binding.apply(manifestPlan).catch((error: unknown) => error),
    );
    expect(failure).toBeInstanceOf(ManifestPluginDefaultsUndecidedError);
    expect(getProjectPluginDefaultsRevision('a')).toBe(revision);
    // A later plan still applies.
    await settlesWithin(binding.apply(listPlan));

    await stalled.release();
    expect(await servedPluginRefs()).toEqual([TOOL]);
    await settleDetachedWork();
    expect(getProjectPluginDefaultsRevision('a')).toBe(revision + 1);
    // The bridge's retry now decides inline and adds nothing.
    await binding.apply(manifestPlan);
    expect(getProjectPluginDefaultsRevision('a')).toBe(revision + 1);
  });

  it('a delivery handed off after the background read loaded waits for another read', async () => {
    await readProjectPluginDefaults('a');
    const reconcile = pluginDefaultsCache.reconcileProjectPluginDefaults;
    let backgroundLoads = 0;
    let reached = (): void => {};
    const loaded = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    // The first background read, held after it loaded.
    jest
      .spyOn(pluginDefaultsCache, 'reconcileProjectPluginDefaults')
      .mockImplementation((write) =>
        reconcile(
          write.bound
            ? write
            : {
                ...write,
                load: async (): Promise<
                  | pluginDefaultsCache.ProjectPluginDefaultsRead
                  | pluginDefaultsCache.ProjectPluginDefaultsRemoved
                > => {
                  backgroundLoads += 1;
                  const read = await write.load();
                  if (backgroundLoads === 1) {
                    reached();
                    await gate;
                  }
                  return read;
                },
              },
        ),
      );
    const stalled = await stalledChatRead();
    commitToolDefault();
    expect(
      await settlesWithin(
        binding.apply(manifestPlan).catch((error: unknown) => error),
      ),
    ).toBeInstanceOf(ManifestPluginDefaultsUndecidedError);
    await stalled.release();
    await loaded;

    // A later commit, delivered while that read holds the write queue.
    writeFileSync(
      manifestPath(),
      JSON.stringify({
        ...JSON.parse(readFileSync(manifestPath(), 'utf8')),
        defaultPluginSelections: {
          pluginRefs: [{ marketplaceId: 'market', pluginName: 'later' }],
        },
      }),
    );
    expect(
      await settlesWithin(
        binding.apply(manifestPlan).catch((error: unknown) => error),
      ),
    ).toBeInstanceOf(ManifestPluginDefaultsUndecidedError);
    open();
    await settleDetachedWork();
    expect(backgroundLoads).toBe(2);
    expect(__pluginDefaultsHandOffsForTests('a')).toBe(0);
  });

  it('a manifest commit while commits keep landing stops at the pass bound; the background advances the revision once', async () => {
    await readProjectPluginDefaults('a');
    const revision = getProjectPluginDefaultsRevision('a');
    commitToolDefault();
    const commits = commitsLandingOnEveryPass();
    const failure = await settlesWithin(
      binding.apply(manifestPlan).catch((error: unknown) => error),
    );
    expect(failure).toBeInstanceOf(ManifestPluginDefaultsUndecidedError);
    expect(commits.passes()).toBe(BOUND.passes);
    await settlesWithin(binding.apply(listPlan));
    await settleDetachedWork();
    expect(await servedPluginRefs()).toEqual([TOOL]);
    expect(getProjectPluginDefaultsRevision('a')).toBe(revision + 1);
  });

  /**
   * A delivery handed off behind a stalled chat read, whose background read
   * then finds the manifest unreadable, so the hand-off stays owed; then the
   * readable manifest is written back.
   */
  async function handOffLeftUndecided(): Promise<void> {
    const stalled = await stalledChatRead();
    expect(
      await settlesWithin(
        binding.apply(manifestPlan).catch((error: unknown) => error),
      ),
    ).toBeInstanceOf(ManifestPluginDefaultsUndecidedError);
    const manifest = readFileSync(manifestPath(), 'utf8');
    writeFileSync(manifestPath(), '{ not json');
    await stalled.release();
    await settleDetachedWork();
    expect(__pluginDefaultsHandOffsForTests('a')).toBe(1);
    writeFileSync(manifestPath(), manifest);
  }

  /** Settled: a chat read caches the layer again, and the next is cached. */
  async function expectLayerSettled(refs: unknown): Promise<void> {
    expect(__pluginDefaultsHandOffsForTests('a')).toBe(0);
    expect(await servedPluginRefs()).toEqual(refs);
    const reads = jest
      .spyOn(getWorkspaceManifestRepository(), 'read')
      .mockClear();
    expect(await servedPluginRefs()).toEqual(refs);
    expect(reads).not.toHaveBeenCalled();
  }

  it('a hand-off left undecided by an unreadable manifest is retried once a later commit event decides inline, and the layer settles', async () => {
    await readProjectPluginDefaults('a');
    const revision = getProjectPluginDefaultsRevision('a');
    await handOffLeftUndecided();

    commitToolDefault();
    await binding.apply(manifestPlan);
    await settleDetachedWork();
    expect(getProjectPluginDefaultsRevision('a')).toBe(revision + 1);
    await expectLayerSettled([TOOL]);
  });

  it('a hand-off left undecided by an unreadable manifest is retried by the next chat read that reads it, though the layer is unchanged', async () => {
    await readProjectPluginDefaults('a');
    const revision = getProjectPluginDefaultsRevision('a');
    await handOffLeftUndecided();

    expect(await servedPluginRefs()).toEqual([]);
    await settleDetachedWork();
    expect(getProjectPluginDefaultsRevision('a')).toBe(revision);
    await expectLayerSettled([]);
  });

  describe('over a subscription', () => {
    let core: EventsCore;
    afterEach(async () => {
      jest.useRealTimers();
      await core.close();
    });

    // Captured before any test fakes `Date`.
    const realNow = Date.now;
    /**
     * Yields to real file reads and fires the next fake timer until `done`,
     * or for 10 s of real time; the caller asserts the outcome. A real-time
     * budget, not a step count: on a loaded runner one re-read's file reads
     * outlast the few milliseconds a fixed count of turns yields.
     */
    const drive = async (done: () => boolean): Promise<void> => {
      const deadline = realNow() + 10_000;
      while (!done() && realNow() < deadline) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await jest.advanceTimersToNextTimerAsync();
      }
    };

    it('a later delivery is acknowledged while a chat read of the manifest never returns', async () => {
      await readProjectPluginDefaults('a');
      const revision = getProjectPluginDefaultsRevision('a');
      core = createEventsCore();
      await binding.attach(await core.connect());
      await drive(() => core.subscriptions.length === 1);
      expect(core.subscriptions).toHaveLength(1);
      const stalled = await stalledChatRead();
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
      commitToolDefault();
      await core.append(
        'core.workspace.committed',
        {
          commit: 'w5:cli-1',
          changes: [{ kind: 'workspace', workspaceId: 'a', revision: 1 }],
          files: [{ kind: 'manifest', workspaceId: 'a' }],
          publishedBy: 'cli-1',
        },
        { workspaceId: 'a' },
      );
      const later = await core.append(
        'core.workspace.committed',
        {
          commit: 'w5:cli-2',
          changes: [],
          files: [{ kind: 'worktrees', workspaceId: 'a' }],
          publishedBy: 'cli-1',
        },
        { workspaceId: 'a' },
      );
      const acknowledged = (): boolean =>
        core.acknowledgements.some(
          (ack) => ack.cursor.sequence === later.cursor.sequence,
        );
      await drive(acknowledged);
      expect(acknowledged()).toBe(true);
      jest.useRealTimers();
      await stalled.release();
      await settleDetachedWork();
      expect(await servedPluginRefs()).toEqual([TOOL]);
      expect(getProjectPluginDefaultsRevision('a')).toBe(revision + 1);
    });

    it('the owed broad recoveries behind a chat read that never returns keep one hand-off; one background read decides them once it returns', async () => {
      await readProjectPluginDefaults('a');
      const revision = getProjectPluginDefaultsRevision('a');
      const reconcile = pluginDefaultsCache.reconcileProjectPluginDefaults;
      let backgroundLoads = 0;
      jest
        .spyOn(pluginDefaultsCache, 'reconcileProjectPluginDefaults')
        .mockImplementation((write) =>
          reconcile(
            write.bound
              ? write
              : {
                  ...write,
                  load: (): ReturnType<typeof write.load> => {
                    backgroundLoads += 1;
                    return write.load();
                  },
                },
          ),
        );
      const undecided = (): number =>
        jest
          .mocked(logMainProcessWarn)
          .mock.calls.filter(
            ([message, details]) =>
              message === '[workspace-commit-events] handler failed' &&
              typeof details === 'object' &&
              details !== null &&
              'error' in details &&
              details.error instanceof ManifestPluginDefaultsUndecidedError,
          ).length;
      core = createEventsCore();
      await binding.attach(await core.connect());
      await drive(() => core.subscriptions.length === 1);
      expect(core.subscriptions).toHaveLength(1);
      const stalled = await stalledChatRead();
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
      commitToolDefault();
      await core.append(
        'core.workspace.committed',
        {
          commit: 'w5:cli-1',
          changes: [{ kind: 'workspace', workspaceId: 'a', revision: 1 }],
          files: [{ kind: 'manifest', workspaceId: 'a' }],
          publishedBy: 'cli-1',
        },
        { workspaceId: 'a' },
      );
      // The plan and three broad re-reads, then owed recoveries under backoff.
      await drive(() => undecided() >= 7);
      expect(undecided()).toBeGreaterThanOrEqual(7);
      expect(__pluginDefaultsHandOffsForTests('a')).toBe(1);

      jest.useRealTimers();
      await binding.close();
      await stalled.release();
      await settleDetachedWork();
      expect(backgroundLoads).toBe(1);
      expect(__pluginDefaultsHandOffsForTests('a')).toBe(0);
      expect(await servedPluginRefs()).toEqual([TOOL]);
      expect(getProjectPluginDefaultsRevision('a')).toBe(revision + 1);
    });
  });
});
