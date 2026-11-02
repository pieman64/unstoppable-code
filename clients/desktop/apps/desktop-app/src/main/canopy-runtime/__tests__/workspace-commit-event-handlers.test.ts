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
  isWorktreesSelfWriteContent,
  readProjectPluginDefaults,
  wasRecentWorktreesSelfWrite,
} from '../../lib/workspace-persistence';
import {
  subscribeWorktreeLifecycleChanges,
  type WorktreeLifecycleChange,
} from '../../lib/worktree-lifecycle-signals';
import { getProjectPluginDefaultsRevision } from '../../plugins/plugin-defaults-revision';
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
    afterEach(async () => {
      jest.useRealTimers();
      await core.close();
    });
    /** Yields to real file reads until `done`, without advancing timers. */
    const until = async (done: () => boolean): Promise<void> => {
      for (let turn = 0; turn < 5_000 && !done(); turn += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(done()).toBe(true);
    };

    it('acknowledges a manifest commit only once its re-reads are authoritative', async () => {
      attachCowork();
      await binding.apply(manifestPlan);
      await readProjectPluginDefaults('a');
      const revision = getProjectPluginDefaultsRevision('a');
      core = createEventsCore();
      await binding.attach(await core.connect());
      await until(() => core.subscriptions.length === 1);
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
      await until(() => bridgeFailures() === 2);
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
      await until(() => core.acknowledgements.length === 1);
      expect(getWorkspaceExternalPath('a')).toBe(moved);
      expect(getProjectPluginDefaultsRevision('a')).toBe(revision + 1);
    });
  });
});
