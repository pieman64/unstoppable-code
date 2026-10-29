// W6d1 (CAN-4410): the W5 commit sequence of the composition records through
// the record decision port, on the real commit log worker.
//
// One log interleaves each port decision, each commit the worker receives,
// and the post-commit hooks: Portal notification and structural sync, group
// publication and refusal diagnostics. A committed site's decision lands in
// its caller's boundary step; a rollback, applied outside one as its callers
// do, commits on its own, exactly as before the port.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { W5CommitRequest } from '@canopy/desktop-shared/node/w5-commit-log';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as SidebarItemGroups from '../sidebar-item-groups';
import type * as Port from '../workspace-record-decision-port';

const mockEvents: unknown[] = [];
function mockDecisionEvent(args: readonly unknown[]): string {
  const decision = args.find(
    (arg): arg is { kind: string } =>
      typeof arg === 'object' &&
      arg !== null &&
      'kind' in arg &&
      typeof arg.kind === 'string',
  );
  return `decision:${decision?.kind ?? 'unknown'}`;
}

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn((diagnostic: { kind?: string }) =>
      mockEvents.push(`diagnostic:${diagnostic.kind ?? 'unknown'}`),
    ),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(() => mockEvents.push('sync')),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(() => mockEvents.push('notify')),
}));
jest.mock('../sidebar-item-groups', () => ({
  ...jest.requireActual<typeof SidebarItemGroups>('../sidebar-item-groups'),
  publishSidebarItemGroupsChanged: jest.fn(() => mockEvents.push('groups')),
}));
jest.mock('../workspace-record-decision-port', () => {
  const actual = jest.requireActual<typeof Port>(
    '../workspace-record-decision-port',
  );
  function logged<A extends unknown[], R>(
    apply: (...args: A) => Promise<R>,
  ): (...args: A) => Promise<R> {
    return (...args) => {
      mockEvents.push(mockDecisionEvent(args));
      return apply(...args);
    };
  }
  return {
    ...actual,
    applyWorktreeListUpdate: logged(actual.applyWorktreeListUpdate),
    applyWorktreeListRemoval: logged(actual.applyWorktreeListRemoval),
    applyWorkspaceManifestDecision: logged(
      actual.applyWorkspaceManifestDecision,
    ),
    applyWorkspaceIndexDecision: logged(actual.applyWorkspaceIndexDecision),
    applyWorkspaceIndexRemoval: logged(actual.applyWorkspaceIndexRemoval),
  };
});

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  w5ResourceKey,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import {
  commitW5BoundaryStep,
  w5CompositionLocks,
} from '../w5-composition-operation';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { updateWorkspaceWorktrees } from '../workspace-persistence';
import {
  cleanupCompositionDestination,
  createTemporaryCompositionRecords,
  indexTemporaryCompositionWorkspace,
  promoteCompositionWorkspace,
  recordCompositionSource,
  recordJoinedWorktree,
  removeCompositionWorktree,
  restoreCompositionWorktrees,
  undoCompositionRepositories,
  undoCompositionSource,
  undoJoinedWorktree,
} from '../workspace-composition-records';

jest.setTimeout(60_000);

const CREATED_AT = '2026-10-01T00:00:00.000Z';
const COMBINE = 'core.workspace.composition.combine';
const moved: WorktreeData = {
  id: 'moved',
  branchName: 'feature',
  createdAt: CREATED_AT,
};
const other: WorktreeData = {
  id: 'other',
  branchName: 'main',
  createdAt: CREATED_AT,
};
const transition = {
  sourceWorkspaceId: 'source',
  sourceWorktreeId: moved.id,
  sourceRepoIds: ['original'],
  createdAt: CREATED_AT,
};

let dir: string;
let root: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;

beforeEach(() => {
  // Recovery and path tests use the canonical TMPDIR.
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'w5-composition-commits-'));
  root = join(dir, 'data', 'workspaces');
  mkdirSync(root, { recursive: true });
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  const commit = host.commit.bind(host);
  jest
    .spyOn(host, 'commit')
    .mockImplementation(async (request: W5CommitRequest) => {
      mockEvents.push(commitEvent(request));
      return commit(request);
    });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  mockEvents.length = 0;
});
afterEach(async () => {
  await settleDetachedWork();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

interface CommitEvent {
  commit: string;
  advance: string[];
  files: string[];
}
function commitEvent(request: W5CommitRequest): CommitEvent {
  return {
    commit: request.operation,
    advance: request.advance.map(w5ResourceKey),
    files: request.files.map((file) => relative(root, file.path)),
  };
}
function listCommit(
  operation: string,
  workspaceId: string,
  advance: string[],
): CommitEvent {
  return {
    commit: operation,
    advance,
    files: [join(workspaceId, 'worktrees.json')],
  };
}

function seed(file: string, value: unknown): void {
  const path = join(root, file);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}
function seedList(workspaceId: string, worktrees: WorktreeData[]): void {
  seed(join(workspaceId, 'worktrees.json'), { version: 1, worktrees });
}
function seedIndex(ids: string[]): void {
  seed('index.json', {
    version: 1,
    workspaces: ids.map((id, order) => ({
      id,
      name: id,
      type: 'multi-repo',
      color: '#123456',
      collapsed: false,
      order,
    })),
  });
}
function temporaryCreate(): Parameters<
  typeof createTemporaryCompositionRecords
>[0] {
  return {
    source: 'temporary_workspace_create',
    workspace: {
      type: 'multi-repo',
      id: 'destination',
      name: 'Temporary',
      color: '#123456',
      repos: [{ id: 'r', name: 'R', repoPath: '/repo' }],
      worktrees: [],
      collapsed: false,
      order: 0,
      temporary: true,
      temporarySourceWorkspaceIds: ['source'],
      temporaryRepoIdentityKeys: ['path:repo'],
    },
  };
}

const LIST_WRITE = 'w5.worktree_list.write';
// A list update notifies the Portal; a removal publishes groups and syncs
// the Portal structure but does not notify it.
const UPDATED = ['groups', 'sync', 'notify'];
const REMOVED = ['groups', 'sync'];

describe('composition record commits', () => {
  it('a combine commits each record in its boundary step; its rollback commits each undo on its own', async () => {
    seedList('destination', [other]);
    seedList('source', [{ ...other, id: 'first' }, moved, other]);
    const commit = { operation: COMBINE };

    const recorded = await commitW5BoundaryStep(
      commit,
      w5CompositionLocks({ lists: ['destination'] }),
      () =>
        recordJoinedWorktree({
          source: 'workspace_combine',
          workspaceId: 'destination',
          worktreeId: moved.id,
          sourceWorktree: moved,
          repoIdRewrites: { original: 'joined' },
          compatibilitySymlinks: [],
          transition,
        }),
    );
    const removed = await commitW5BoundaryStep(
      commit,
      w5CompositionLocks({ lists: ['source'] }),
      () =>
        removeCompositionWorktree({
          source: 'workspace_combine',
          workspaceId: 'source',
          worktree: moved,
        }),
    );
    if (!recorded.undo) throw new Error('The join recorded nothing to undo');
    await undoJoinedWorktree(recorded.undo);
    await restoreCompositionWorktrees({
      source: 'workspace_combine',
      workspaceId: 'source',
      ...removed,
    });

    const destination = ['worktrees:destination', 'worktree:destination/moved'];
    const source = ['worktrees:source', 'worktree:source/moved'];
    expect(mockEvents).toEqual([
      'decision:composition.join.record',
      listCommit(COMBINE, 'destination', destination),
      ...UPDATED,
      'decision:composition.row.remove',
      listCommit(COMBINE, 'source', source),
      ...REMOVED,
      // The appended row's undo is a removal.
      'decision:composition.row.remove',
      listCommit(LIST_WRITE, 'destination', destination),
      ...REMOVED,
      'decision:composition.rows.restore',
      listCommit(LIST_WRITE, 'source', source),
      ...UPDATED,
    ]);
  });

  it('an existing join commits the source record in its step; a competing edit and the undos commit on their own', async () => {
    seedList('source', [
      { ...moved, trackedRepoBaseBranches: { original: 'main' } },
      other,
    ]);
    seed(join('source', 'workspace.json'), {
      version: 1,
      type: 'multi-repo',
      repos: [
        { id: 'original', name: 'O', repoPath: '/original' },
        { id: 'added', name: 'A', repoPath: '/added' },
      ],
    });
    const undoRepositories = (): Promise<void> =>
      undoCompositionRepositories({
        source: 'existing_worktree_join',
        workspaceId: 'source',
        repositories: [{ id: 'added', name: 'A', repoPath: '/added' }],
      });

    const undo = await commitW5BoundaryStep(
      { operation: COMBINE },
      w5CompositionLocks({ lists: ['source'] }),
      () =>
        recordCompositionSource({
          source: 'existing_worktree_join',
          workspaceId: 'source',
          worktree: moved,
          trackedBranches: { joined: 'develop' },
          compatibilitySymlinks: [],
          transition,
        }),
    );
    await updateWorkspaceWorktrees('source', (rows) =>
      rows.map((row) => ({ ...row, label: 'Competing' })),
    );
    await undoCompositionSource(undo);
    await undoRepositories();
    // Nothing is left to undo: neither commits.
    await undoCompositionSource(undo);
    await undoRepositories();

    const rows = ['worktree:source/moved', 'worktree:source/other'];
    expect(mockEvents).toEqual([
      'decision:composition.source.record',
      listCommit(COMBINE, 'source', rows),
      ...UPDATED,
      listCommit(LIST_WRITE, 'source', rows),
      ...UPDATED,
      'decision:composition.source.undo',
      listCommit(LIST_WRITE, 'source', ['worktree:source/moved']),
      ...UPDATED,
      'decision:composition.repositories.undo',
      {
        commit: 'w5.workspace_manifest.write',
        advance: ['workspace:source'],
        files: [join('source', 'workspace.json')],
      },
      'decision:composition.source.undo',
      // An unchanged list still publishes its groups and notifies, as before.
      ...UPDATED,
      'decision:composition.repositories.undo',
    ]);
  });

  it('a temporary create commits its list and manifest in one step; its index and cleanup commit on their own', async () => {
    seedIndex(['source']);

    await createTemporaryCompositionRecords(temporaryCreate());
    await indexTemporaryCompositionWorkspace(temporaryCreate());
    await cleanupCompositionDestination({
      source: 'temporary_workspace_create',
      workspaceId: 'destination',
    });

    const indexCommit: CommitEvent = {
      commit: 'w5.workspace_index.write',
      advance: ['workspaces', 'workspace:destination'],
      files: ['index.json', 'index.json.bak'],
    };
    expect(mockEvents).toEqual([
      // The nested manifest decision is applied by the composite one.
      'decision:composition.temporary.create',
      {
        commit: 'core.workspace.create',
        advance: ['workspace:destination'],
        files: [
          join('destination', 'workspace.json'),
          join('destination', 'worktrees.json'),
        ],
      },
      ...UPDATED,
      // Outside any decision (G3): the create routes pass no commit.
      'decision:composition.temporary.index',
      indexCommit,
      'sync',
      'notify',
      'decision:composition.destination.cleanup',
      indexCommit,
      'sync',
      'notify',
    ]);
  });

  it('a temporary create over an existing manifest commits nothing', async () => {
    seed(join('destination', 'workspace.json'), {
      version: 1,
      type: 'multi-repo',
    });

    await expect(
      createTemporaryCompositionRecords(temporaryCreate()),
    ).rejects.toMatchObject({ reason: 'identity-changed' });

    expect(mockEvents).toEqual(['decision:composition.temporary.create']);
  });

  it('a promotion commits its index and manifest in one step, then notifies', async () => {
    seedIndex(['destination', 'later']);
    seed(join('destination', 'workspace.json'), {
      version: 1,
      type: 'multi-repo',
      repos: [],
      temporary: true,
      temporarySourceWorkspaceIds: ['source'],
    });

    await promoteCompositionWorkspace({
      source: 'temporary_promote',
      workspaceId: 'destination',
      name: ' Permanent ',
      sourceRepoPath: '/source',
    });

    expect(mockEvents).toEqual([
      'decision:composition.promote',
      {
        commit: 'core.workspace.composition.promote',
        advance: ['workspace:destination'],
        files: [
          'index.json',
          'index.json.bak',
          join('destination', 'workspace.json'),
        ],
      },
      'sync',
      'notify',
    ]);
  });

  it('refusals over unreadable files commit nothing and keep their diagnostics', async () => {
    seed('index.json', '{broken');
    seed(join('source', 'workspace.json'), '{broken');
    seed(join('destination', 'workspace.json'), {
      version: 1,
      type: 'multi-repo',
      repos: [],
      temporary: true,
    });

    await expect(
      promoteCompositionWorkspace({
        source: 'temporary_promote',
        workspaceId: 'destination',
        name: 'Permanent',
        sourceRepoPath: '/source',
      }),
    ).rejects.toMatchObject({ reason: 'index-unavailable' });
    await expect(
      indexTemporaryCompositionWorkspace(temporaryCreate()),
    ).rejects.toMatchObject({ reason: 'index-unavailable' });
    await expect(
      undoCompositionRepositories({
        source: 'workspace_combine',
        workspaceId: 'source',
        repositories: [],
      }),
    ).rejects.toMatchObject({ reason: 'configuration-unavailable' });
    // Swallowed, as before.
    await cleanupCompositionDestination({
      source: 'workspace_combine',
      workspaceId: 'destination',
    });

    expect(mockEvents).toEqual([
      // Refused by the decision before the index writer: no diagnostic.
      'decision:composition.promote',
      'decision:composition.temporary.index',
      'decision:composition.repositories.undo',
      'diagnostic:workspace_config_write_refused',
      // The removal asks to write, so the index writer refuses and reports.
      'decision:composition.destination.cleanup',
      'diagnostic:workspace_index_write_refused',
    ]);
  });

  it('a repeated removal and restore commit only their first application', async () => {
    seedList('source', [moved, other]);
    const remove = (): Promise<unknown> =>
      removeCompositionWorktree({
        source: 'existing_worktree_join',
        workspaceId: 'source',
        worktree: moved,
      });
    const restore = (): Promise<void> =>
      restoreCompositionWorktrees({
        source: 'existing_worktree_join',
        workspaceId: 'source',
        rows: [moved],
        order: ['moved', 'other'],
      });

    await remove();
    await remove();
    await restore();
    await restore();

    const advance = ['worktrees:source', 'worktree:source/moved'];
    expect(mockEvents).toEqual([
      'decision:composition.row.remove',
      listCommit(LIST_WRITE, 'source', advance),
      ...REMOVED,
      'decision:composition.row.remove',
      'decision:composition.rows.restore',
      listCommit(LIST_WRITE, 'source', advance),
      ...UPDATED,
      // A restore filters its rows past the tombstones into a new list, so
      // an unchanged list still syncs and notifies without a commit, as before.
      'decision:composition.rows.restore',
      ...UPDATED,
    ]);
  });
});
