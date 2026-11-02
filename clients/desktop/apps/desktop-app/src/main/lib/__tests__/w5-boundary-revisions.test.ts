import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { serializeWorkspaceMutation } from '../chat-project-operation-queue';
// Same real worker/filesystem harness as part 4, with production command callers.
import { execFileSync } from 'node:child_process';
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
import type * as CoreStorage from '@canopy/core-runtime/storage';
// W6g: the same rows every checked writer reads, daemon-owned on the daemon side.
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

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import { notifyPortalStructureChanged } from '../../portal/portal-event-bus';
import { recordWorkspaceCrudTelemetry } from '../desktop-telemetry';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  W5RevisionConflictError,
  readW5Revisions,
  withW5Commit,
} from '../w5-commit-log-file-store';
import { installW5StoreSide, W5_STORE_SIDES } from './fixtures/w5-store-sides';
import { ownsW5RepositoryLock } from '../w5-repository-locks';
import * as sourceControl from '../workspace-source-control';
import { ChatStateV2Repository } from '../../services/chat-state-v2-repository';
import { updateWorkspacePlugins } from '../workspace-plugin-defaults';
import { recordWorktreeActivity } from '../worktree-observer-records';
import { nodeW5FileStore } from '../w5-file-store';
import { createWorkspace } from '../workspace-creation';
import { updateWorkspaceMetadata } from '../workspace-metadata';
import { createWorktreeFromSelection } from '../worktree-creation';
import {
  __resetSidebarItemsStateForTests,
  getWorkspaceIndexRepository,
} from '../sidebar-items';
import {
  updateWorkspaceWorktrees,
  readWorkspaceWorktrees,
  setBeforeProjectPluginDefaultsChangeHandler,
} from '../workspace-persistence';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;

beforeEach(() => {
  ({ dir, root, repo } = createW5BoundaryFixture());
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  jest.clearAllMocks();
});
afterEach(async () => {
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function images(): string[] {
  return ['index.json', 'a/workspace.json', 'a/worktrees.json'].map((file) =>
    readFileSync(join(root, file), 'utf8'),
  );
}
async function expectConflict(
  pending: Promise<unknown>,
  resource: string,
  before: string[],
): Promise<void> {
  await expect(pending).rejects.toBeInstanceOf(W5RevisionConflictError);
  await expect(pending).rejects.toMatchObject({
    resource,
    expected: 1,
    actual: 0,
  });
  expect(images()).toEqual(before);
  expect(notifyPortalStructureChanged).not.toHaveBeenCalled();
  expect(recordWorkspaceCrudTelemetry).not.toHaveBeenCalled();
}

describe.each(W5_STORE_SIDES)('over the %s store', (side) => {
  let teardown = (): Promise<void> => Promise.resolve();
  beforeEach(async () => {
    teardown = await installW5StoreSide(side, {
      host,
      root,
      setDaemonOwned: setDaemonOwnedForTest,
    });
  });
  afterEach(() => teardown());

  it('workspace create refuses a stale workspaces revision without applying index, manifest or list', async () => {
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    await expectConflict(
      createWorkspace({
        source: 'new_multi_repo',
        variant: { kind: 'new-multi-repo', name: 'New' },
        expectedRevision: 1,
      }),
      'workspaces',
      before,
    );
    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits.mock.calls[0]?.[0].operation).toBe('core.workspace.create');
    expect(await host.revision({ kind: 'workspaces' })).toBe(0);
  });

  it('workspace update refuses a stale workspace revision without applying either file', async () => {
    const before = images();
    await expectConflict(
      updateWorkspaceMetadata({
        workspaceId: 'a',
        source: 'desktop_canopy_client',
        patch: { name: 'Edited', itemSortMode: 'last-updated' },
        expectedRevision: 1,
      }),
      'workspace:a',
      before,
    );
    expect(await host.revision({ kind: 'workspace', workspaceId: 'a' })).toBe(
      0,
    );
  });

  it('worktree create refuses a stale worktrees revision before Git setup and preserves the list', async () => {
    const before = images();
    const branches = execFileSync('git', ['-C', repo, 'branch'], {
      encoding: 'utf8',
    });
    await expectConflict(
      createWorktreeFromSelection({
        workspaceId: 'a',
        workspaceKind: 'single-repo',
        branch: { kind: 'new', branchName: 'new-branch' },
        base: { kind: 'repository-default' },
        allowBaseBranchNetwork: false,
        expectedRevision: 1,
      }),
      'worktrees:a',
      before,
    );
    expect(
      execFileSync('git', ['-C', repo, 'branch'], { encoding: 'utf8' }),
    ).toBe(branches);
  });

  it('workspace update commits both files once and advances its workspace revision once', async () => {
    const commits = jest.spyOn(host, 'commit');
    const [expected] = await readW5Revisions([
      { kind: 'workspace', workspaceId: 'a' },
    ]);
    await updateWorkspaceMetadata({
      workspaceId: 'a',
      source: 'desktop_canopy_client',
      patch: { name: 'Edited', itemSortMode: 'last-updated' },
      expectedRevision: expected?.revision,
    });
    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits.mock.calls[0]?.[0].operation).toBe('core.workspace.update');
    expect(images()[0]).toContain('Edited');
    expect(images()[1]).toContain('last-updated');
    expect(await host.revision({ kind: 'workspace', workspaceId: 'a' })).toBe(
      1,
    );
    expect(notifyPortalStructureChanged).toHaveBeenCalled();
  });

  it('multi-repo create commits its index, manifest and list in one decision after initializing the source repo', async () => {
    const commits = jest.spyOn(host, 'commit');
    const outcome = await createWorkspace({
      source: 'new_multi_repo',
      variant: { kind: 'new-multi-repo', name: 'New' },
      expectedRevision: 0,
    });
    expect(commits).toHaveBeenCalledTimes(1);
    const id = outcome.workspace.id;
    expect(readFileSync(join(root, id, 'workspace.json'), 'utf8')).toContain(
      'sourceRepoPath',
    );
    expect(readFileSync(join(root, id, 'worktrees.json'), 'utf8')).toContain(
      'worktrees',
    );
    expect(await host.revision({ kind: 'workspace', workspaceId: id })).toBe(1);
    expect(await host.revision({ kind: 'workspaces' })).toBe(1);
  });

  it('plain-folder creation does not publish staged Cowork records on a stale collection revision', async () => {
    const folder = join(dir, 'plain-folder');
    mkdirSync(folder);
    const before = images();
    await expectConflict(
      createWorkspace({
        source: 'folder',
        variant: { kind: 'local-folder', folderPath: folder },
        expectedRevision: 1,
      }),
      'workspaces',
      before,
    );
  });

  it('workspace create keeps its existing mutation queue until the canonical commit applies', async () => {
    const originalCommit = host.commit.bind(host);
    let started: () => void = () => {};
    let release: () => void = () => {};
    const committing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
      started();
      await released;
      return originalCommit(request);
    });
    const creation = createWorkspace({
      source: 'new_multi_repo',
      variant: { kind: 'new-multi-repo', name: 'Queued' },
    });
    await committing;
    let followingEntered = false;
    const following = serializeWorkspaceMutation(() => {
      followingEntered = true;
      return Promise.resolve();
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const enteredBeforeCommit = followingEntered;
    release();
    const outcome = await creation;
    await following;
    expect(enteredBeforeCommit).toBe(false);
    expect(readFileSync(join(root, 'index.json'), 'utf8')).toContain(
      outcome.workspace.id,
    );
  });

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it('an unscoped index writer waits for a scoped workspace update and preserves both edits', async () => {
    const staged = deferred();
    const finish = deferred();
    const update = serializeWorkspaceMutation(() =>
      withW5Commit({ operation: 'test.update' }, async () => {
        await updateWorkspaceMetadata({
          workspaceId: 'a',
          source: 'desktop_canopy_client',
          patch: { name: 'Edited', itemSortMode: 'last-updated' },
        });
        staged.resolve();
        await finish.promise;
      }),
    );
    const updated = update.then(
      () => undefined,
      (error: unknown) => error,
    );
    await staged.promise;
    let entered = false;
    const observer = getWorkspaceIndexRepository().update(({ entries }) => {
      entered = true;
      return {
        result: undefined,
        entries: entries.map((entry) => ({ ...entry, pinned: true })),
      };
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const enteredBeforeCommit = entered;
    finish.resolve();
    expect(await updated).toBeUndefined();
    await observer;
    expect(enteredBeforeCommit).toBe(false);
    expect(
      (await getWorkspaceIndexRepository().read()).entries[0],
    ).toMatchObject({ name: 'Edited', pinned: true });
  });

  it('an unscoped list writer waits for a scoped worktree creation record and keeps its field', async () => {
    const staged = deferred();
    const finish = deferred();
    const creation = withW5Commit(
      { operation: 'core.worktree.create' },
      async () => {
        await updateWorkspaceWorktrees('a', (rows) => [
          ...rows,
          { id: 'new', branchName: 'new', createdAt: '2026-10-14T00:00:00Z' },
        ]);
        staged.resolve();
        await finish.promise;
      },
    );
    const created = creation.then(
      () => undefined,
      (error: unknown) => error,
    );
    await staged.promise;
    let entered = false;
    const observer = updateWorkspaceWorktrees('a', (rows) => {
      entered = true;
      return rows.map((row) => ({ ...row, label: 'Observed' }));
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const enteredBeforeCommit = entered;
    finish.resolve();
    expect(await created).toBeUndefined();
    await observer;
    expect(enteredBeforeCommit).toBe(false);
    expect(await readWorkspaceWorktrees('a')).toEqual([
      expect.objectContaining({ id: 'new', label: 'Observed' }),
    ]);
  });

  it('an abort releases waiting writers to read unchanged committed contents', async () => {
    const staged = deferred();
    const finish = deferred();
    const failure = new Error('abort');
    const scope = withW5Commit({ operation: 'test.abort' }, async () => {
      await getWorkspaceIndexRepository().update(({ entries }) => ({
        result: undefined,
        entries: entries.map((entry) => ({ ...entry, name: 'Abandoned' })),
      }));
      staged.resolve();
      await finish.promise;
      throw failure;
    });
    const aborted = scope.then(
      () => undefined,
      (error: unknown) => error,
    );
    await staged.promise;
    let observed: string | undefined;
    const observer = getWorkspaceIndexRepository().update(({ entries }) => {
      observed = entries[0]?.name;
      return {
        result: undefined,
        entries: entries.map((entry) => ({ ...entry, pinned: true })),
      };
    });
    await Promise.race([
      observer,
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
    ]);
    const observedBeforeAbort = observed;
    finish.resolve();
    expect(await aborted).toBe(failure);
    await observer;
    expect(observedBeforeAbort).toBeUndefined();
    expect(observed).toBe('Original');
    expect(
      (await getWorkspaceIndexRepository().read()).entries[0],
    ).toMatchObject({ name: 'Original', pinned: true });
  });

  it('workspace creation provisions without the writer gate and preserves an index observer edit', async () => {
    const preparing = deferred();
    const finish = deferred();
    const original = sourceControl.prepareNewWorkspaceSourceRepo;
    jest
      .spyOn(sourceControl, 'prepareNewWorkspaceSourceRepo')
      .mockImplementationOnce(async (...args) => {
        expect(ownsW5RepositoryLock()).toBe(false);
        preparing.resolve();
        await finish.promise;
        return original(...args);
      });
    const creation = createWorkspace({
      source: 'new_multi_repo',
      variant: { kind: 'new-multi-repo', name: 'Prepared' },
    });
    await preparing.promise;
    try {
      await getWorkspaceIndexRepository().update(({ entries }) => ({
        result: undefined,
        entries: entries.map((entry) => ({ ...entry, pinned: true })),
      }));
    } finally {
      finish.resolve();
    }
    const outcome = await creation;
    expect((await getWorkspaceIndexRepository().read()).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'a', pinned: true }),
        expect.objectContaining({ id: outcome.workspace.id }),
      ]),
    );
  });

  it('rejects entering workspace serialization after acquiring a repository lock', async () => {
    await expect(
      withW5Commit({ operation: 'test.inverse-order' }, async () => {
        await getWorkspaceIndexRepository().update(() => ({
          result: undefined,
        }));
        await serializeWorkspaceMutation(() => Promise.resolve());
      }),
    ).rejects.toThrow(
      'Workspace serialization must precede W5 repository locks',
    );
  });

  it('a real worktree create and an unscoped list observer both succeed through the reservation commit', async () => {
    const committing = deferred();
    const finish = deferred();
    const original = host.commit.bind(host);
    jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
      expect(request.operation).toBe('core.worktree.create');
      committing.resolve();
      await finish.promise;
      return original(request);
    });
    const creation = createWorktreeFromSelection({
      workspaceId: 'a',
      workspaceKind: 'single-repo',
      branch: { kind: 'new', branchName: 'racing-create' },
      base: { kind: 'repository-default' },
      allowBaseBranchNetwork: false,
    });
    await committing.promise;
    let entered = false;
    const observer = updateWorkspaceWorktrees('a', (rows) => {
      entered = true;
      return rows.map((row) => ({ ...row, label: 'Observed' }));
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const enteredBeforeCommit = entered;
    finish.resolve();
    await Promise.all([creation, observer]);
    expect(enteredBeforeCommit).toBe(false);
    expect(await readWorkspaceWorktrees('a')).toEqual([
      expect.objectContaining({
        branchName: 'racing-create',
        label: 'Observed',
      }),
    ]);
  });

  it('an expired unscoped writer context acquires a fresh gate for later observer work', async () => {
    const resume = deferred();
    let observer: Promise<unknown> = Promise.resolve();
    await getWorkspaceIndexRepository().update(({ entries }) => {
      observer = (async (): Promise<void> => {
        await resume.promise;
        await getWorkspaceIndexRepository().update(({ entries: current }) => ({
          result: undefined,
          entries: current.map((entry) => ({ ...entry, pinned: true })),
        }));
      })().then(
        () => undefined,
        (error: unknown) => error,
      );
      return {
        result: undefined,
        entries: entries.map((entry) => ({ ...entry, name: 'Edited' })),
      };
    });
    resume.resolve();
    expect(await observer).toBeUndefined();
    expect(
      (await getWorkspaceIndexRepository().read()).entries[0],
    ).toMatchObject({ name: 'Edited', pinned: true });
  });

  it('a plugin-default change and an earlier chat publication finish without a W5 lock cycle', async () => {
    const scope = { projectId: 'a', worktreeId: 'chat-scope' };
    const paths = {
      tabs: join(dir, 'chats', 'scope.json'),
      archives: join(dir, 'chat-archives', 'scope.json'),
      journal: join(dir, 'chat-journals', 'scope.jsonl'),
    };
    mkdirSync(join(dir, 'chats'));
    writeFileSync(
      paths.tabs,
      JSON.stringify({
        version: 1,
        activeTabId: 'chat',
        tabs: [
          { id: 'chat', title: 'Chat', createdAt: '2026-10-14', messages: [] },
        ],
      }),
    );
    writeFileSync(
      join(root, 'a', 'worktrees.json'),
      JSON.stringify({
        version: 1,
        worktrees: [
          { id: 'chat-scope', branchName: 'main', createdAt: '2026-10-14' },
        ],
      }),
    );
    const normalizing = deferred();
    const observerStarted = deferred();
    const chats = new ChatStateV2Repository({
      resolvePaths: (): typeof paths => paths,
      onCommit: async (): Promise<void> => {
        observerStarted.resolve();
        await recordWorktreeActivity({
          source: 'activity_watermark',
          workspaceId: 'a',
          worktreeId: 'chat-scope',
          touchedAt: '2026-10-14T12:00:00.000Z',
        });
      },
    });
    await chats.getState(scope);
    setBeforeProjectPluginDefaultsChangeHandler(async () => {
      normalizing.resolve();
      await observerStarted.promise;
      // Same ordered compatibility-chat transaction awaited by production normalization.
      await chats.transact(
        scope,
        [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat',
            patch: { unread: false },
          },
        ],
        { source: 'migration' },
      );
    });
    const change = updateWorkspacePlugins({
      workspaceId: 'a',
      source: 'project_settings',
      change: {
        kind: 'setDefaults',
        defaultPluginSelections: {
          collectionIds: ['new'],
          skillRefs: [],
          pluginRefs: [],
        },
      },
    });
    await normalizing.promise;
    const publication = chats.transact(
      scope,
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { unread: true },
        },
      ],
      { source: 'migration' },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([change, publication]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('W5/chat publication deadlock')),
            2000,
          );
        }),
      ]);
      expect(readFileSync(join(root, 'a', 'workspace.json'), 'utf8')).toContain(
        'new',
      );
      expect((await chats.getState(scope)).tabsFile.tabs[0]?.unread).toBe(
        false,
      );
      await chats.drainAll();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  });
});
