// W6d1 (CAN-4410): the composition records through the record decision
// port. Each scenario runs the real record functions on real files.
//
// - The writer calls are pinned at the storage writers as they were before
//   the port: options, whether a call ran inside another writer's updater
//   (nesting keeps the inner read under the outer lock) and how it settled.
// - A fake port records each decision as JSON. Replaying the recorded
//   decisions through the in-process port writes the same bytes and returns
//   the same outcomes, and every record write goes through the port.
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
let mockFailPath: string | undefined;
jest.mock('../atomic-file', () => {
  const actual = jest.requireActual<typeof AtomicFile>('../atomic-file');
  return {
    ...actual,
    writeFileAtomically: async (
      ...args: Parameters<typeof actual.writeFileAtomically>
    ): Promise<void> => {
      if (args[0] === mockFailPath) {
        mockFailPath = undefined;
        throw new Error('disk full');
      }
      await actual.writeFileAtomically(...args);
    },
  };
});

type MockPortCall =
  | {
      entry: 'applyWorktreeListUpdate';
      args: [string, WorktreeListUpdateDecision, WorktreeListPreconditions];
    }
  | {
      entry: 'applyWorktreeListRemoval';
      args: [
        string,
        WorktreeListRemovalDecision,
        WorktreeListRemovalPreconditions,
      ];
    }
  | {
      entry: 'applyWorkspaceManifestDecision';
      args: [string, WorkspaceManifestDecision];
    }
  | { entry: 'applyWorkspaceIndexDecision'; args: [WorkspaceIndexDecision] }
  | {
      entry: 'applyWorkspaceIndexRemoval';
      args: [string, WorkspaceIndexRemovalDecision];
    };
const mockPort: {
  /** `replay` applies the queued recorded call in place of the live one. */
  mode: 'record' | 'replay';
  calls: MockPortCall[];
  queue: MockPortCall[];
  /** Port calls in flight. */
  depth: number;
} = { mode: 'record', calls: [], queue: [], depth: 0 };

jest.mock('../workspace-record-decision-port', () => {
  const actual = jest.requireActual<typeof Port>(
    '../workspace-record-decision-port',
  );
  async function apply(live: MockPortCall): Promise<unknown> {
    // Recorded as JSON, so a replay proves the decision is plain data.
    const asData = JSON.parse(JSON.stringify(live)) as MockPortCall;
    let call = asData;
    if (mockPort.mode === 'record') mockPort.calls.push(asData);
    else {
      const recorded = mockPort.queue.shift();
      expect(asData).toEqual(recorded);
      if (recorded) call = recorded;
    }
    mockPort.depth += 1;
    try {
      switch (call.entry) {
        case 'applyWorktreeListUpdate':
          return await actual.applyWorktreeListUpdate(...call.args);
        case 'applyWorktreeListRemoval':
          return await actual.applyWorktreeListRemoval(...call.args);
        case 'applyWorkspaceManifestDecision':
          return await actual.applyWorkspaceManifestDecision(...call.args);
        case 'applyWorkspaceIndexDecision':
          return await actual.applyWorkspaceIndexDecision(...call.args);
        case 'applyWorkspaceIndexRemoval':
          return await actual.applyWorkspaceIndexRemoval(...call.args);
      }
    } finally {
      mockPort.depth -= 1;
    }
  }
  return {
    ...actual,
    applyWorktreeListUpdate: (
      ...args: [string, WorktreeListUpdateDecision, WorktreeListPreconditions]
    ): Promise<unknown> => apply({ entry: 'applyWorktreeListUpdate', args }),
    applyWorktreeListRemoval: (
      ...args: [
        string,
        WorktreeListRemovalDecision,
        WorktreeListRemovalPreconditions,
      ]
    ): Promise<unknown> => apply({ entry: 'applyWorktreeListRemoval', args }),
    applyWorkspaceManifestDecision: (
      ...args: [string, WorkspaceManifestDecision]
    ): Promise<unknown> =>
      apply({ entry: 'applyWorkspaceManifestDecision', args }),
    applyWorkspaceIndexDecision: (
      ...args: [WorkspaceIndexDecision]
    ): Promise<unknown> =>
      apply({ entry: 'applyWorkspaceIndexDecision', args }),
    applyWorkspaceIndexRemoval: (
      ...args: [string, WorkspaceIndexRemovalDecision]
    ): Promise<unknown> => apply({ entry: 'applyWorkspaceIndexRemoval', args }),
  };
});

import '../../../__tests__/worktree-replica-compatibility';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  WorktreeCompatibilitySymlink,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import type * as FsPromises from 'node:fs/promises';
import type * as AtomicFile from '../atomic-file';
import {
  getWorkspaceConfigPath,
  getWorkspaceDir,
  getWorkspaceIndexFilePath,
  getWorkspaceWorktreesFilePath,
} from '../paths';
import * as sidebarItems from '../sidebar-items';
import * as persistence from '../workspace-persistence';
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
  type JoinedWorktreeRecord,
  type RemovedCompositionRows,
} from '../workspace-composition-records';
import type * as Port from '../workspace-record-decision-port';
import type * as WorktreePort from '../worktree-record-decision-port';
import type * as OwnershipPort from '../workspace-ownership-decision-port';
import type * as CoworkPort from '../cowork-record-decision-port';
import type * as CreationPort from '../workspace-creation-decision-port';
import type * as BranchRenamePort from '../worktree-branch-rename-decision-port';
import type * as RestorePort from '../archived-container-restore-decision-port';
import type * as WorktreeCreationPort from '../worktree-creation-decision-port';
import type * as ArchiveRecordPort from '../worktree-archive-record-decision-port';
import type {
  W5RecordDecisionPort,
  WorkspaceIndexDecision,
  WorkspaceIndexRemovalDecision,
  WorkspaceManifestDecision,
  WorktreeListPreconditions,
  WorktreeListRemovalDecision,
  WorktreeListRemovalPreconditions,
  WorktreeListUpdateDecision,
} from '../worktree-record-decisions';

// The in-process implementation, across its nine modules, satisfies the
// port interface.
const port: W5RecordDecisionPort = {
  ...jest.requireActual<typeof WorktreePort>(
    '../worktree-record-decision-port',
  ),
  ...jest.requireActual<typeof Port>('../workspace-record-decision-port'),
  ...jest.requireActual<typeof OwnershipPort>(
    '../workspace-ownership-decision-port',
  ),
  ...jest.requireActual<typeof CoworkPort>('../cowork-record-decision-port'),
  ...jest.requireActual<typeof CreationPort>(
    '../workspace-creation-decision-port',
  ),
  ...jest.requireActual<typeof BranchRenamePort>(
    '../worktree-branch-rename-decision-port',
  ),
  ...jest.requireActual<typeof RestorePort>(
    '../archived-container-restore-decision-port',
  ),
  ...jest.requireActual<typeof WorktreeCreationPort>(
    '../worktree-creation-decision-port',
  ),
  ...jest.requireActual<typeof ArchiveRecordPort>(
    '../worktree-archive-record-decision-port',
  ),
};

const CREATED_AT = '2026-10-01T00:00:00.000Z';
const NEWER = '2026-10-02T00:00:00.000Z';
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

function link(name: string): WorktreeCompatibilitySymlink {
  return {
    path: `/links/${name}`,
    targetPath: `/targets/${name}`,
    reason: 'adhoc-multi-repo-transition',
    sourceWorkspaceId: 'origin',
    sourceWorktreeId: 'origin-row',
    createdAt: CREATED_AT,
  };
}

interface Ids {
  source: string;
  destination: string;
}
let count = 0;
function freshIds(): Ids {
  count += 1;
  return { source: `source-${count}`, destination: `destination-${count}` };
}

async function seedList(workspaceId: string, rows: unknown[]): Promise<void> {
  const file = getWorkspaceWorktreesFilePath(workspaceId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ version: 1, worktrees: rows, futureListField: true }),
  );
}
async function seedManifest(
  workspaceId: string,
  manifest: Record<string, unknown> | string,
): Promise<void> {
  const file = getWorkspaceConfigPath(workspaceId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    typeof manifest === 'string'
      ? manifest
      : JSON.stringify({ version: 1, ...manifest }),
  );
}
async function seedIndex(entries: unknown[] | string): Promise<void> {
  const file = getWorkspaceIndexFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    typeof entries === 'string'
      ? entries
      : JSON.stringify({
          version: 1,
          workspaces: entries,
          futureIndexField: 1,
        }),
  );
}
function indexEntry(
  id: string,
  order: number,
  type = 'multi-repo',
): Record<string, unknown> {
  return { id, name: id, type, color: '#123456', collapsed: false, order };
}

const transition = (ids: Ids): JoinedWorktreeRecord['transition'] => ({
  sourceWorkspaceId: ids.source,
  sourceWorktreeId: moved.id,
  sourceRepoIds: ['original'],
  createdAt: CREATED_AT,
});
function joinRecord(ids: Ids): JoinedWorktreeRecord {
  return {
    source: 'existing_worktree_join',
    workspaceId: ids.destination,
    worktreeId: moved.id,
    sourceWorktree: { ...moved, trackedBaseBranch: 'main' },
    consumedWorktrees: [{ ...other, seenPipelineExecutionIds: ['p1'] }],
    repoIdRewrites: { original: 'joined' },
    compatibilitySymlinks: [link('a')],
    transition: transition(ids),
    joinedTrackedBranches: { joined: 'develop' },
  };
}
function temporaryWorkspace(
  ids: Ids,
): Parameters<typeof createTemporaryCompositionRecords>[0] {
  return {
    source: 'temporary_workspace_create',
    workspace: {
      type: 'multi-repo',
      id: ids.destination,
      name: 'Temporary',
      color: '#123456',
      repos: [{ id: 'r', name: 'R', repoPath: '/repo' }],
      worktrees: [],
      collapsed: false,
      order: 0,
      temporary: true,
      temporarySourceWorkspaceIds: [ids.source],
      temporaryRepoIdentityKeys: ['path:repo'],
    },
  };
}
const promotion = (
  ids: Ids,
): Parameters<typeof promoteCompositionWorkspace>[0] => ({
  source: 'temporary_promote',
  workspaceId: ids.destination,
  name: '  Permanent  ',
  sourceRepoPath: '/source',
});
async function competingEdit(workspaceId: string): Promise<void> {
  await persistence.updateWorkspaceWorktrees(workspaceId, (rows) => [
    { ...other, id: 'competing' },
    ...rows.map((row) => ({ ...row, label: 'Competing label' })),
  ]);
}

interface CompositionScenario {
  name: string;
  seed: (ids: Ids) => Promise<void>;
  run: (ids: Ids) => Promise<unknown>;
  /** The writer calls the run makes today. */
  writes: WriterCall[];
  /** Asserts the files the run leaves, as before the port. */
  after?: (ids: Ids) => Promise<void>;
}

async function fileJson(file: string): Promise<unknown> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  return value;
}
async function expectList(workspaceId: string, rows: unknown[]): Promise<void> {
  expect(await fileJson(getWorkspaceWorktreesFilePath(workspaceId))).toEqual({
    version: 1,
    worktrees: rows,
    futureListField: true,
  });
}

const EXISTING = { requireAuthoritativeRead: true, requireExistingList: true };
const REMOVAL = { ...EXISTING, markRemovedAfterWrite: true };
const list = (
  target: keyof Ids,
  settled = 'ok',
  options: unknown = EXISTING,
  depth = 0,
): WriterCall => ({ writer: 'list.update', target, options, depth, settled });
const removal = (target: keyof Ids, settled = 'ok'): WriterCall => ({
  writer: 'list.remove',
  target,
  options: REMOVAL,
  depth: 0,
  settled,
});
/** A test's own edit between record calls, outside the port. */
const competing = (target: keyof Ids): WriterCall => ({
  writer: 'list.update',
  target,
  depth: 0,
  settled: 'ok',
  competing: true,
});
const manifest = (
  target: keyof Ids,
  settled = 'ok',
  options: unknown = undefined,
  depth = 0,
): WriterCall => ({
  writer: 'manifest.update',
  target,
  options,
  depth,
  settled,
});
const index = (settled = 'ok', depth = 0): WriterCall => ({
  writer: 'index.update',
  depth,
  settled,
});
const REFUSED = (reason: string): string =>
  `CompositionRecordRefusedError:${reason}`;

const SCENARIOS: CompositionScenario[] = [
  {
    name: 'join record appends a destination row',
    seed: (ids) => seedList(ids.destination, [other]),
    run: (ids) => recordJoinedWorktree(joinRecord(ids)),
    writes: [list('destination')],
  },
  {
    name: 'join record extends a reservation',
    seed: (ids) =>
      seedList(ids.destination, [
        other,
        {
          ...moved,
          label: 'Reserved',
          trackedRepoBaseBranches: { kept: 'x' },
          compatibilitySymlinks: [link('old')],
          futureRowField: true,
        },
      ]),
    run: (ids) => recordJoinedWorktree(joinRecord(ids)),
    writes: [list('destination')],
  },
  {
    name: 'join record retry keeps the recorded row',
    seed: (ids) =>
      seedList(ids.destination, [
        { ...moved, adhocTransitionSource: transition(ids), label: 'Kept' },
      ]),
    run: (ids) => recordJoinedWorktree(joinRecord(ids)),
    writes: [list('destination')],
  },
  {
    name: 'join record refuses a different transition',
    seed: (ids) =>
      seedList(ids.destination, [
        {
          ...moved,
          adhocTransitionSource: { ...transition(ids), sourceWorktreeId: 'x' },
        },
      ]),
    run: (ids) => recordJoinedWorktree(joinRecord(ids)),
    writes: [list('destination', REFUSED('identity-changed'))],
  },
  {
    name: 'join record refuses another incarnation',
    seed: (ids) => seedList(ids.destination, [{ ...moved, createdAt: NEWER }]),
    run: (ids) => recordJoinedWorktree(joinRecord(ids)),
    writes: [list('destination', REFUSED('identity-changed'))],
  },
  {
    name: 'join record refuses a missing list',
    seed: () => Promise.resolve(),
    run: (ids) => recordJoinedWorktree(joinRecord(ids)),
    writes: [list('destination', 'WorktreeRegistryUnreadableError')],
  },
  {
    name: 'join undo of an extended reservation keeps competing edits',
    seed: (ids) =>
      seedList(ids.destination, [
        { ...moved, label: 'Reserved', trackedRepoBaseBranches: { k: 'v' } },
      ]),
    run: async (ids): Promise<void> => {
      const outcome = await recordJoinedWorktree(joinRecord(ids));
      await competingEdit(ids.destination);
      if (outcome.undo) await undoJoinedWorktree(outcome.undo);
    },
    writes: [
      list('destination'),
      competing('destination'),
      list('destination'),
    ],
    after: (ids) =>
      expectList(ids.destination, [
        { ...other, id: 'competing' },
        {
          ...moved,
          label: 'Competing label',
          trackedRepoBaseBranches: { k: 'v' },
        },
      ]),
  },
  {
    name: 'join undo of an extension whose fields a competing edit changed',
    seed: (ids) => seedList(ids.destination, [{ ...moved, label: 'Reserved' }]),
    run: async (ids): Promise<void> => {
      const outcome = await recordJoinedWorktree(joinRecord(ids));
      await persistence.updateWorkspaceWorktrees(ids.destination, (rows) =>
        rows.map((row) => ({
          ...row,
          setupPhase: 'git-pending',
          trackedRepoBaseBranches: {
            ...row.trackedRepoBaseBranches,
            joined: 'competing',
          },
          compatibilitySymlinks: [
            ...(row.compatibilitySymlinks ?? []),
            link('c'),
          ],
        })),
      );
      if (outcome.undo) await undoJoinedWorktree(outcome.undo);
    },
    writes: [
      list('destination'),
      competing('destination'),
      list('destination'),
    ],
    after: (ids) =>
      expectList(ids.destination, [
        {
          ...moved,
          label: 'Reserved',
          setupPhase: 'git-pending',
          trackedRepoBaseBranches: { joined: 'competing' },
          compatibilitySymlinks: [link('c')],
        },
      ]),
  },
  {
    name: 'join undo of an appended row removes only that incarnation',
    seed: (ids) => seedList(ids.destination, [other]),
    run: async (ids): Promise<void> => {
      const outcome = await recordJoinedWorktree(joinRecord(ids));
      if (outcome.undo) await undoJoinedWorktree(outcome.undo);
    },
    writes: [list('destination'), removal('destination')],
  },
  {
    name: 'join undo finds no row to undo',
    seed: (ids) => seedList(ids.destination, [other]),
    run: (ids) =>
      undoJoinedWorktree({
        source: 'existing_worktree_join',
        workspaceId: ids.destination,
        worktree: moved,
        before: moved,
        written: { ...moved, label: 'Written' },
      }),
    writes: [list('destination')],
  },
  {
    name: 'removal and restore keep a competing row and order',
    seed: (ids) =>
      seedList(ids.source, [
        { ...other, id: 'first' },
        { ...moved, futureRowField: 'restore' },
        { ...other, id: 'last' },
      ]),
    run: async (ids): Promise<unknown> => {
      const removed = await removeCompositionWorktree({
        source: 'existing_worktree_join',
        workspaceId: ids.source,
        worktree: moved,
      });
      await competingEdit(ids.source);
      await restoreCompositionWorktrees({
        source: 'existing_worktree_join',
        workspaceId: ids.source,
        ...removed,
      });
      return removed;
    },
    writes: [
      removal('source'),
      competing('source'),
      list('source', 'ok', { ...EXISTING, restoreWorktrees: ['moved'] }),
    ],
    after: (ids) =>
      expectList(ids.source, [
        { ...other, id: 'competing' },
        { ...other, id: 'first', label: 'Competing label' },
        { ...moved, futureRowField: 'restore' },
        { ...other, id: 'last', label: 'Competing label' },
      ]),
  },
  {
    name: 'restore skips an anchor row that left since the removal',
    seed: (ids) =>
      seedList(ids.source, [moved, { ...other, id: 'anchor' }, other]),
    run: async (ids): Promise<void> => {
      const removed = await removeCompositionWorktree({
        source: 'existing_worktree_join',
        workspaceId: ids.source,
        worktree: moved,
      });
      await persistence.updateWorkspaceWorktrees(ids.source, (rows) => [
        ...rows.filter((row) => row.id !== 'anchor'),
        { ...other, id: 'appended' },
      ]);
      await restoreCompositionWorktrees({
        source: 'existing_worktree_join',
        workspaceId: ids.source,
        ...removed,
      });
    },
    writes: [
      removal('source'),
      competing('source'),
      list('source', 'ok', { ...EXISTING, restoreWorktrees: ['moved'] }),
    ],
    after: (ids) =>
      expectList(ids.source, [moved, other, { ...other, id: 'appended' }]),
  },
  {
    name: 'restore without an order appends the row',
    seed: (ids) => seedList(ids.source, [other]),
    run: (ids) =>
      restoreCompositionWorktrees({
        source: 'existing_worktree_join',
        workspaceId: ids.source,
        rows: [moved],
      }),
    writes: [
      list('source', 'ok', { ...EXISTING, restoreWorktrees: ['moved'] }),
    ],
  },
  {
    name: 'restore of a present row writes nothing',
    seed: (ids) => seedList(ids.source, [moved, other]),
    run: (ids) =>
      restoreCompositionWorktrees({
        source: 'existing_worktree_join',
        workspaceId: ids.source,
        rows: [moved],
        order: ['moved', 'other'],
      }),
    writes: [
      list('source', 'ok', { ...EXISTING, restoreWorktrees: ['moved'] }),
    ],
  },
  {
    name: 'restore refuses a later incarnation',
    seed: (ids) => seedList(ids.source, [{ ...moved, createdAt: NEWER }]),
    run: (ids) =>
      restoreCompositionWorktrees({
        source: 'existing_worktree_join',
        workspaceId: ids.source,
        rows: [moved],
      }),
    writes: [
      list('source', REFUSED('identity-changed'), {
        ...EXISTING,
        restoreWorktrees: ['moved'],
      }),
    ],
  },
  {
    name: 'removal of an absent row writes nothing',
    seed: (ids) => seedList(ids.source, [other]),
    run: (ids) =>
      removeCompositionWorktree({
        source: 'existing_worktree_join',
        workspaceId: ids.source,
        worktree: moved,
      }),
    writes: [removal('source')],
  },
  {
    name: 'removal refuses another incarnation',
    seed: (ids) =>
      seedList(ids.source, [other, { ...moved, createdAt: NEWER }]),
    run: (ids) =>
      removeCompositionWorktree({
        source: 'existing_worktree_join',
        workspaceId: ids.source,
        worktree: moved,
      }),
    writes: [removal('source', REFUSED('identity-changed'))],
  },
  {
    name: 'removal refuses an unreadable list',
    seed: async (ids): Promise<void> => {
      await seedList(ids.source, []);
      await writeFile(getWorkspaceWorktreesFilePath(ids.source), '{broken');
    },
    run: (ids) =>
      removeCompositionWorktree({
        source: 'existing_worktree_join',
        workspaceId: ids.source,
        worktree: moved,
      }),
    writes: [removal('source', 'WorktreeRegistryUnreadableError')],
  },
  {
    name: 'source record and undo keep competing values',
    seed: (ids) =>
      seedList(ids.source, [
        {
          ...moved,
          trackedRepoBaseBranches: { original: 'main', replaced: 'old' },
          compatibilitySymlinks: [link('old')],
        },
        other,
      ]),
    run: async (ids): Promise<unknown> => {
      const undo = await recordCompositionSource({
        source: 'existing_worktree_join',
        workspaceId: ids.source,
        worktree: moved,
        trackedBranches: { joined: 'base', replaced: 'new' },
        compatibilitySymlinks: [link('old'), link('new')],
        transition: transition(ids),
      });
      await persistence.updateWorkspaceWorktrees(ids.source, (rows) =>
        rows.map((row) =>
          row.id === moved.id
            ? {
                ...row,
                label: 'Later',
                trackedRepoBaseBranches: {
                  ...row.trackedRepoBaseBranches,
                  joined: 'later',
                },
              }
            : row,
        ),
      );
      await undoCompositionSource(undo);
      return undo;
    },
    writes: [list('source'), competing('source'), list('source')],
    after: (ids) =>
      expectList(ids.source, [
        {
          ...moved,
          trackedRepoBaseBranches: {
            original: 'main',
            replaced: 'old',
            joined: 'later',
          },
          compatibilitySymlinks: [link('old')],
          label: 'Later',
        },
        other,
      ]),
  },
  {
    name: 'source undo after a competing transition keeps it',
    seed: (ids) => seedList(ids.source, [moved]),
    run: async (ids): Promise<void> => {
      const undo = await recordCompositionSource({
        source: 'existing_worktree_join',
        workspaceId: ids.source,
        worktree: moved,
        compatibilitySymlinks: [],
        transition: transition(ids),
      });
      await persistence.updateWorkspaceWorktrees(ids.source, (rows) =>
        rows.map((row) => ({
          ...row,
          adhocTransitionSource: { ...transition(ids), createdAt: NEWER },
        })),
      );
      await undoCompositionSource(undo);
    },
    writes: [list('source'), competing('source'), list('source')],
    after: (ids) =>
      expectList(ids.source, [
        {
          ...moved,
          adhocTransitionSource: { ...transition(ids), createdAt: NEWER },
        },
      ]),
  },
  {
    name: 'source record refuses a missing row',
    seed: (ids) => seedList(ids.source, [other]),
    run: (ids) =>
      recordCompositionSource({
        source: 'existing_worktree_join',
        workspaceId: ids.source,
        worktree: moved,
        compatibilitySymlinks: [],
        transition: transition(ids),
      }),
    writes: [list('source', REFUSED('not-found'))],
  },
  {
    name: 'repository undo removes only its own entries',
    seed: (ids) =>
      seedManifest(ids.source, {
        type: 'multi-repo',
        repos: [
          { id: 'original', name: 'O', repoPath: '/original' },
          { id: 'added', name: 'A', repoPath: '/added' },
          { id: 'added', name: 'A', repoPath: '/moved' },
        ],
        futureManifestField: true,
      }),
    run: (ids) =>
      undoCompositionRepositories({
        source: 'existing_worktree_join',
        workspaceId: ids.source,
        repositories: [{ id: 'added', name: 'A', repoPath: '/added' }],
      }),
    writes: [manifest('source', 'ok', { shouldWrite: 'fn:Boolean' })],
    after: async (ids) =>
      expect(await fileJson(getWorkspaceConfigPath(ids.source))).toEqual({
        version: 1,
        type: 'multi-repo',
        repos: [
          { id: 'original', name: 'O', repoPath: '/original' },
          { id: 'added', name: 'A', repoPath: '/moved' },
        ],
        alwaysShow: true,
        futureManifestField: true,
      }),
  },
  {
    name: 'repository undo with nothing to remove writes nothing',
    seed: (ids) =>
      seedManifest(ids.source, {
        type: 'multi-repo',
        repos: [{ id: 'original', name: 'O', repoPath: '/original' }],
      }),
    run: (ids) =>
      undoCompositionRepositories({
        source: 'workspace_combine',
        workspaceId: ids.source,
        repositories: [],
      }),
    writes: [manifest('source', 'ok', { shouldWrite: 'fn:Boolean' })],
  },
  {
    name: 'repository undo refuses an absent manifest',
    seed: () => Promise.resolve(),
    run: (ids) =>
      undoCompositionRepositories({
        source: 'workspace_combine',
        workspaceId: ids.source,
        repositories: [],
      }),
    writes: [
      manifest('source', REFUSED('not-found'), { shouldWrite: 'fn:Boolean' }),
    ],
  },
  {
    name: 'repository undo refuses an unreadable manifest',
    seed: (ids) => seedManifest(ids.source, '{broken'),
    run: (ids) =>
      undoCompositionRepositories({
        source: 'workspace_combine',
        workspaceId: ids.source,
        repositories: [],
      }),
    writes: [
      manifest('source', 'WorkspaceConfigUnreadableError', {
        shouldWrite: 'fn:Boolean',
      }),
    ],
  },
  {
    name: 'temporary create seeds the manifest inside the list write',
    seed: () => Promise.resolve(),
    run: (ids) => createTemporaryCompositionRecords(temporaryWorkspace(ids)),
    writes: [
      list('destination', 'ok', { requireAuthoritativeRead: true }),
      manifest('destination', 'ok', undefined, 1),
    ],
  },
  {
    name: 'temporary create refuses an existing list before the manifest',
    seed: (ids) => seedList(ids.destination, []),
    run: (ids) => createTemporaryCompositionRecords(temporaryWorkspace(ids)),
    writes: [
      list('destination', REFUSED('identity-changed'), {
        requireAuthoritativeRead: true,
      }),
    ],
  },
  {
    name: 'temporary create refuses an existing manifest inside the list write',
    seed: (ids) => seedManifest(ids.destination, { type: 'multi-repo' }),
    run: (ids) => createTemporaryCompositionRecords(temporaryWorkspace(ids)),
    writes: [
      list('destination', REFUSED('identity-changed'), {
        requireAuthoritativeRead: true,
      }),
      manifest('destination', REFUSED('identity-changed'), undefined, 1),
    ],
  },
  {
    name: 'temporary create refuses an unreadable manifest inside the list write',
    seed: (ids) => seedManifest(ids.destination, '{broken'),
    run: (ids) => createTemporaryCompositionRecords(temporaryWorkspace(ids)),
    writes: [
      list('destination', REFUSED('configuration-unavailable'), {
        requireAuthoritativeRead: true,
      }),
      manifest('destination', 'WorkspaceConfigUnreadableError', undefined, 1),
    ],
  },
  {
    name: 'temporary index appends the entry',
    seed: (ids) => seedIndex([indexEntry(ids.source, 0, 'single-repo')]),
    run: (ids) => indexTemporaryCompositionWorkspace(temporaryWorkspace(ids)),
    writes: [index()],
  },
  {
    name: 'temporary index creates an absent index',
    seed: () => Promise.resolve(),
    run: (ids) => indexTemporaryCompositionWorkspace(temporaryWorkspace(ids)),
    writes: [index()],
  },
  {
    name: 'temporary index refuses an existing entry',
    seed: (ids) => seedIndex([indexEntry(ids.destination, 0)]),
    run: (ids) => indexTemporaryCompositionWorkspace(temporaryWorkspace(ids)),
    writes: [index(REFUSED('identity-changed'))],
  },
  {
    name: 'temporary index refuses a partial index',
    seed: (ids) => seedIndex([indexEntry(ids.source, 0), { id: 7 }]),
    run: (ids) => indexTemporaryCompositionWorkspace(temporaryWorkspace(ids)),
    writes: [index(REFUSED('index-unavailable'))],
  },
  {
    name: 'temporary index refuses an unreadable index',
    seed: () => seedIndex('{broken'),
    run: (ids) => indexTemporaryCompositionWorkspace(temporaryWorkspace(ids)),
    writes: [index(REFUSED('index-unavailable'))],
  },
  {
    name: 'destination cleanup removes the entry and the directory',
    seed: async (ids): Promise<void> => {
      await seedIndex([
        indexEntry(ids.source, 0),
        indexEntry(ids.destination, 1),
        indexEntry('later', 2),
      ]);
      await seedManifest(ids.destination, { type: 'multi-repo' });
      await seedList(ids.destination, [moved]);
    },
    run: (ids) =>
      cleanupCompositionDestination({
        source: 'workspace_combine',
        workspaceId: ids.destination,
      }),
    writes: [
      {
        writer: 'index.remove',
        target: 'destination',
        depth: 0,
        settled: 'ok',
      },
      index('ok', 1),
    ],
  },
  {
    name: 'destination cleanup without an entry still removes the directory',
    seed: async (ids): Promise<void> => {
      await seedIndex([indexEntry(ids.source, 0)]);
      await seedList(ids.destination, [moved]);
    },
    run: (ids) =>
      cleanupCompositionDestination({
        source: 'temporary_workspace_create',
        workspaceId: ids.destination,
      }),
    writes: [
      {
        writer: 'index.remove',
        target: 'destination',
        depth: 0,
        settled: 'ok',
      },
      index('ok', 1),
    ],
  },
  {
    name: 'destination cleanup swallows an unreadable index',
    seed: async (ids): Promise<void> => {
      await seedIndex('{broken');
      await seedList(ids.destination, [moved]);
    },
    run: (ids) =>
      cleanupCompositionDestination({
        source: 'existing_worktree_join',
        workspaceId: ids.destination,
      }),
    writes: [
      {
        writer: 'index.remove',
        target: 'destination',
        depth: 0,
        settled: 'WorkspaceIndexUnreadableError',
      },
      index('WorkspaceIndexUnreadableError', 1),
    ],
  },
  {
    name: 'promotion renames the entry inside the manifest write',
    seed: async (ids): Promise<void> => {
      await seedIndex([indexEntry(ids.destination, 0), indexEntry('x', 1)]);
      await seedManifest(ids.destination, {
        type: 'multi-repo',
        repos: [],
        temporary: true,
        temporarySourceWorkspaceIds: [ids.source],
        temporaryRepoIdentityKeys: ['k'],
        alwaysShow: true,
      });
    },
    run: (ids) => promoteCompositionWorkspace(promotion(ids)),
    writes: [manifest('destination'), index('ok', 1)],
  },
  {
    name: 'promotion refuses a non-temporary manifest before the index',
    seed: async (ids): Promise<void> => {
      await seedIndex([indexEntry(ids.destination, 0)]);
      await seedManifest(ids.destination, { type: 'multi-repo', repos: [] });
    },
    run: (ids) => promoteCompositionWorkspace(promotion(ids)),
    writes: [manifest('destination', REFUSED('not-temporary'))],
  },
  {
    name: 'promotion refuses a single-repo manifest',
    seed: async (ids): Promise<void> => {
      await seedIndex([indexEntry(ids.destination, 0)]);
      await seedManifest(ids.destination, { type: 'single-repo', repos: [] });
    },
    run: (ids) => promoteCompositionWorkspace(promotion(ids)),
    writes: [manifest('destination', REFUSED('not-found'))],
  },
  {
    name: 'promotion refuses an absent manifest',
    seed: (ids) => seedIndex([indexEntry(ids.destination, 0)]),
    run: (ids) => promoteCompositionWorkspace(promotion(ids)),
    writes: [manifest('destination', REFUSED('not-found'))],
  },
  {
    name: 'promotion refuses a missing index entry inside the manifest write',
    seed: async (ids): Promise<void> => {
      await seedIndex([indexEntry(ids.destination, 0, 'single-repo')]);
      await seedManifest(ids.destination, {
        type: 'multi-repo',
        repos: [],
        temporary: true,
      });
    },
    run: (ids) => promoteCompositionWorkspace(promotion(ids)),
    writes: [
      manifest('destination', REFUSED('not-found')),
      index(REFUSED('not-found'), 1),
    ],
  },
  {
    name: 'promotion refuses an unreadable index inside the manifest write',
    seed: async (ids): Promise<void> => {
      await seedIndex('{broken');
      await seedManifest(ids.destination, {
        type: 'multi-repo',
        repos: [],
        temporary: true,
      });
    },
    run: (ids) => promoteCompositionWorkspace(promotion(ids)),
    writes: [
      manifest('destination', REFUSED('index-unavailable')),
      index(REFUSED('index-unavailable'), 1),
    ],
  },
  {
    name: 'promotion accepts a partial index',
    seed: async (ids): Promise<void> => {
      await seedIndex([indexEntry(ids.destination, 0), { id: 7 }]);
      await seedManifest(ids.destination, {
        type: 'multi-repo',
        repos: [],
        temporary: true,
      });
    },
    run: (ids) => promoteCompositionWorkspace(promotion(ids)),
    writes: [manifest('destination'), index('ok', 1)],
  },
];

// ---------------------------------------------------------------------------
// writer instrumentation
// ---------------------------------------------------------------------------

interface WriterCall {
  writer:
    | 'list.update'
    | 'list.remove'
    | 'manifest.update'
    | 'index.update'
    | 'index.remove';
  target?: keyof Ids;
  options?: unknown;
  depth: number;
  settled: string;
  competing?: true;
  /** Whether a port call was in flight. */
  viaPort?: boolean;
}

/** A call as the scenarios pin it: without how the test observed it. */
function pinnedCall({
  writer,
  target,
  options,
  depth,
  settled,
}: WriterCall): WriterCall {
  return { writer, target, options, depth, settled };
}

function settledAs(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const reason =
    'reason' in error && typeof error.reason === 'string'
      ? `:${error.reason}`
      : '';
  return `${error.name}${reason}`;
}

/** Options as data: functions by name, restorable rows by id. */
function optionsAsData(options: unknown): unknown {
  if (options === undefined) return undefined;
  return JSON.parse(
    JSON.stringify(options, (key, value: unknown) => {
      if (typeof value === 'function') return `fn:${value.name}`;
      if (key === 'restoreWorktrees' && Array.isArray(value))
        return value.map((row: unknown) =>
          typeof row === 'object' && row !== null && 'id' in row ? row.id : row,
        );
      return value;
    }),
  );
}

function instrumentWriters(ids: Ids): WriterCall[] {
  const calls: WriterCall[] = [];
  let depth = 0;
  const label = (workspaceId: string): keyof Ids | undefined =>
    workspaceId === ids.source
      ? 'source'
      : workspaceId === ids.destination
        ? 'destination'
        : undefined;
  async function track<T>(
    call: Omit<WriterCall, 'depth' | 'settled'>,
    write: () => Promise<T>,
  ): Promise<T> {
    const entry: WriterCall = {
      ...call,
      depth,
      settled: 'pending',
      viaPort: mockPort.depth > 0,
    };
    calls.push(entry);
    depth += 1;
    try {
      const result = await write();
      entry.settled = 'ok';
      return result;
    } catch (error) {
      entry.settled = settledAs(error);
      throw error;
    } finally {
      depth -= 1;
    }
  }

  const updateList = persistence.updateWorkspaceWorktrees;
  jest
    .spyOn(persistence, 'updateWorkspaceWorktrees')
    .mockImplementation((workspaceId, updater, options) =>
      track(
        {
          writer: 'list.update',
          target: label(workspaceId),
          options: optionsAsData(options),
        },
        () => updateList(workspaceId, updater, options),
      ),
    );
  const removeRows = persistence.removeWorkspaceWorktrees;
  jest
    .spyOn(persistence, 'removeWorkspaceWorktrees')
    .mockImplementation((workspaceId, shouldRemove, order, expected, options) =>
      track(
        {
          writer: 'list.remove',
          target: label(workspaceId),
          options: optionsAsData({ order, expected, ...options }),
        },
        () => removeRows(workspaceId, shouldRemove, order, expected, options),
      ),
    );
  const updateManifest = persistence.updateWorkspaceConfig;
  jest
    .spyOn(persistence, 'updateWorkspaceConfig')
    .mockImplementation((workspaceId, update, options) =>
      track(
        {
          writer: 'manifest.update',
          target: label(workspaceId),
          options: optionsAsData(options),
        },
        () => updateManifest(workspaceId, update, options),
      ),
    );
  const repository = sidebarItems.getWorkspaceIndexRepository();
  const updateIndex = repository.update.bind(repository);
  jest.spyOn(repository, 'update').mockImplementation(function trackIndexUpdate<
    T,
  >(change: Parameters<typeof updateIndex<T>>[0]): Promise<T> {
    return track({ writer: 'index.update' }, () => updateIndex(change));
  });
  const removeEntry = sidebarItems.removeWorkspaceIndexEntry;
  jest
    .spyOn(sidebarItems, 'removeWorkspaceIndexEntry')
    .mockImplementation((workspaceId) =>
      track({ writer: 'index.remove', target: label(workspaceId) }, () =>
        removeEntry(workspaceId),
      ),
    );
  return calls;
}

// ---------------------------------------------------------------------------
// suites
// ---------------------------------------------------------------------------

let originalDataDir: string | undefined;
const dataDirs: string[] = [];

async function newDataDir(): Promise<string> {
  // Path tests use the canonical TMPDIR (macOS links /var to /private/var).
  const dir = await mkdtemp(
    path.join(await realpath(os.tmpdir()), 'canopy-composition-port-'),
  );
  dataDirs.push(dir);
  return dir;
}

function useDataDir(dir: string): void {
  process.env.CANOPY_DATA_DIR = dir;
  sidebarItems.__resetSidebarItemsStateForTests();
}

beforeEach(() => {
  originalDataDir = process.env.CANOPY_DATA_DIR;
});

afterEach(async () => {
  jest.restoreAllMocks();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  await Promise.all(
    dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('composition record writes', () => {
  it.each(SCENARIOS.map((scenario) => [scenario.name, scenario]))(
    '%s makes the same writer calls',
    async (_name, scenario) => {
      useDataDir(await newDataDir());
      const ids = freshIds();
      await scenario.seed(ids);
      const calls = instrumentWriters(ids);
      await scenario.run(ids).catch(() => undefined);
      expect(calls.map(pinnedCall)).toEqual(scenario.writes.map(pinnedCall));
      await scenario.after?.(ids);
    },
  );
});

/** The settled run, with this scenario's ids replaced by their names. */
async function settleNamed(ids: Ids, run: Promise<unknown>): Promise<unknown> {
  let settled: unknown;
  try {
    settled = { ok: (await run) ?? null };
  } catch (error) {
    settled = {
      error: settledAs(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return JSON.parse(named(ids, JSON.stringify(settled)));
}

function named(ids: Ids, text: string): string {
  return text
    .split(ids.destination)
    .join('<destination>')
    .split(ids.source)
    .join('<source>');
}

/** Every file under `dir`, by relative path, with the ids named. */
async function snapshotTree(
  dir: string,
  ids: Ids,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(at: string): Promise<void> {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else
        files[named(ids, path.relative(dir, full))] = named(
          ids,
          await readFile(full, 'utf8'),
        );
    }
  }
  await walk(dir);
  return files;
}

/** A recorded call for another scenario run: only the ids differ. */
function renamed(call: MockPortCall, from: Ids, to: Ids): MockPortCall {
  const text = JSON.stringify(call)
    .split(JSON.stringify(from.destination))
    .join(JSON.stringify(to.destination))
    .split(JSON.stringify(from.source))
    .join(JSON.stringify(to.source));
  return JSON.parse(text) as MockPortCall;
}

function decisionOf(
  call: MockPortCall,
):
  | WorktreeListUpdateDecision
  | WorktreeListRemovalDecision
  | WorkspaceManifestDecision
  | WorkspaceIndexDecision
  | WorkspaceIndexRemovalDecision {
  return call.entry === 'applyWorkspaceIndexDecision'
    ? call.args[0]
    : call.args[1];
}

function kindsOf(calls: MockPortCall[]): string[] {
  return calls.flatMap((call) => {
    const decision = decisionOf(call);
    const nested =
      'manifest' in decision
        ? [decision.manifest.kind]
        : 'index' in decision
          ? [decision.index.kind]
          : [];
    return [decision.kind, ...nested];
  });
}

describe('composition record decisions through a fake port', () => {
  beforeEach(() => {
    mockPort.mode = 'record';
    mockPort.calls.length = 0;
    mockPort.queue.length = 0;
  });

  it('covers every composition decision kind', async () => {
    const kinds = new Set<string>();
    for (const scenario of SCENARIOS) {
      useDataDir(await newDataDir());
      const ids = freshIds();
      await scenario.seed(ids);
      mockPort.calls.length = 0;
      await scenario.run(ids).catch(() => undefined);
      for (const kind of kindsOf(mockPort.calls)) kinds.add(kind);
    }
    expect([...kinds].sort()).toEqual([
      'composition.destination.cleanup',
      'composition.join.record',
      'composition.join.undo',
      'composition.promote',
      'composition.promote.index',
      'composition.repositories.undo',
      'composition.row.remove',
      'composition.rows.restore',
      'composition.source.record',
      'composition.source.undo',
      'composition.temporary.create',
      'composition.temporary.index',
      'composition.temporary.manifest',
    ]);
  });

  it.each(SCENARIOS.map((scenario) => [scenario.name, scenario]))(
    '%s replays its recorded decisions to the same bytes and outcomes',
    async (_name, scenario) => {
      const direct = await newDataDir();
      useDataDir(direct);
      const directIds = freshIds();
      await scenario.seed(directIds);
      const calls = instrumentWriters(directIds);
      const directOutcome = await settleNamed(
        directIds,
        scenario.run(directIds),
      );
      jest.restoreAllMocks();
      const recorded = mockPort.calls.splice(0);
      // Every record write goes through the port; only the test's own
      // competing edits do not.
      expect(calls.map((call) => call.viaPort)).toEqual(
        scenario.writes.map((write) => !write.competing),
      );
      const directTree = await snapshotTree(direct, directIds);

      // Fresh ids keep the direct run's tombstones out of the replay.
      const replay = await newDataDir();
      useDataDir(replay);
      const replayIds = freshIds();
      await scenario.seed(replayIds);
      mockPort.mode = 'replay';
      mockPort.queue = recorded.map((call) =>
        renamed(call, directIds, replayIds),
      );
      const replayOutcome = await settleNamed(
        replayIds,
        scenario.run(replayIds),
      );
      expect(mockPort.queue).toEqual([]);
      expect(replayOutcome).toEqual(directOutcome);
      expect(await snapshotTree(replay, replayIds)).toEqual(directTree);
    },
  );

  it('the in-process port applies a recorded decision without the record function', async () => {
    useDataDir(await newDataDir());
    const ids = freshIds();
    await seedList(ids.source, [other, moved]);
    await expect(
      port.applyWorktreeListRemoval(
        ids.source,
        {
          kind: 'composition.row.remove',
          worktree: { id: moved.id, createdAt: moved.createdAt },
        },
        REMOVAL,
      ),
    ).resolves.toEqual({ rows: [moved], order: ['other', 'moved'] });
    expect(await persistence.readWorkspaceWorktrees(ids.source)).toEqual([
      other,
    ]);
  });
});

describe('composition rollbacks', () => {
  const removeRow = (
    workspaceId: string,
    row: WorktreeData,
  ): Promise<RemovedCompositionRows> =>
    removeCompositionWorktree({
      source: 'existing_worktree_join',
      workspaceId,
      worktree: row,
    });

  it('a restore clears exactly the tombstones of the rows it restores', async () => {
    useDataDir(await newDataDir());
    const ids = freshIds();
    const kept = { ...other, id: 'kept' };
    const gone = { ...other, id: 'gone' };
    await seedList(ids.source, [kept, moved, gone]);
    const removed = await removeRow(ids.source, moved);
    await removeRow(ids.source, gone);
    expect(
      persistence.isWorkspaceWorktreeRecentlyRemoved(
        ids.source,
        moved.id,
        moved.createdAt,
      ),
    ).toBe(true);

    await restoreCompositionWorktrees({
      source: 'existing_worktree_join',
      workspaceId: ids.source,
      ...removed,
    });

    expect(
      persistence.isWorkspaceWorktreeRecentlyRemoved(
        ids.source,
        moved.id,
        moved.createdAt,
      ),
    ).toBe(false);
    expect(
      persistence.isWorkspaceWorktreeRecentlyRemoved(
        ids.source,
        gone.id,
        gone.createdAt,
      ),
    ).toBe(true);
    // A stale snapshot can still not resurrect the row left removed, and the
    // restored row survives later writes.
    await persistence.updateWorkspaceWorktrees(ids.source, (rows) => [
      ...rows,
      gone,
    ]);
    expect(await persistence.readWorkspaceWorktrees(ids.source)).toEqual([
      kept,
      moved,
    ]);
  });

  it('a restore keeps the tombstone of another incarnation at the same id', async () => {
    useDataDir(await newDataDir());
    const ids = freshIds();
    const older = { ...moved, createdAt: '2026-09-01T00:00:00.000Z' };
    await seedList(ids.source, [older, other]);
    await removeRow(ids.source, older);
    await seedList(ids.source, [moved, other]);
    const removed = await removeRow(ids.source, moved);

    await restoreCompositionWorktrees({
      source: 'existing_worktree_join',
      workspaceId: ids.source,
      ...removed,
    });

    expect(
      persistence.isWorkspaceWorktreeRecentlyRemoved(
        ids.source,
        moved.id,
        moved.createdAt,
      ),
    ).toBe(false);
    expect(
      persistence.isWorkspaceWorktreeRecentlyRemoved(
        ids.source,
        older.id,
        older.createdAt,
      ),
    ).toBe(true);
  });

  it('a refused or failed restore keeps the tombstone and the list', async () => {
    useDataDir(await newDataDir());
    const ids = freshIds();
    await seedList(ids.source, [moved, other]);
    const removed = await removeRow(ids.source, moved);
    const file = getWorkspaceWorktreesFilePath(ids.source);
    const before = await readFile(file, 'utf8');
    const restore = (): Promise<void> =>
      restoreCompositionWorktrees({
        source: 'existing_worktree_join',
        workspaceId: ids.source,
        ...removed,
      });

    mockFailPath = file;
    await expect(restore()).rejects.toThrow('disk full');
    await seedList(ids.source, [{ ...moved, createdAt: NEWER }, other]);
    const competingBytes = await readFile(file, 'utf8');
    await expect(restore()).rejects.toMatchObject({
      reason: 'identity-changed',
    });

    expect(before).not.toBe(competingBytes);
    expect(await readFile(file, 'utf8')).toBe(competingBytes);
    expect(
      persistence.isWorkspaceWorktreeRecentlyRemoved(
        ids.source,
        moved.id,
        moved.createdAt,
      ),
    ).toBe(true);
  });

  it('a destination cleanup swallows an index refusal and still removes the directory', async () => {
    useDataDir(await newDataDir());
    const ids = freshIds();
    await seedIndex('{broken');
    await seedList(ids.destination, [moved]);
    const indexBefore = await readFile(getWorkspaceIndexFilePath(), 'utf8');

    await expect(
      cleanupCompositionDestination({
        source: 'workspace_combine',
        workspaceId: ids.destination,
      }),
    ).resolves.toBeUndefined();

    expect(await readFile(getWorkspaceIndexFilePath(), 'utf8')).toBe(
      indexBefore,
    );
    await expect(
      readFile(getWorkspaceWorktreesFilePath(ids.destination), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a destination cleanup removes the index entry first and swallows a directory failure', async () => {
    useDataDir(await newDataDir());
    const ids = freshIds();
    await seedIndex([
      indexEntry(ids.source, 0),
      indexEntry(ids.destination, 1),
    ]);
    await seedList(ids.destination, [moved]);
    const listBefore = await readFile(
      getWorkspaceWorktreesFilePath(ids.destination),
      'utf8',
    );
    // The records' own `rm` binding resolves on this module object; only
    // the project directory's removal fails.
    const fs = jest.requireActual<typeof FsPromises>('node:fs/promises');
    const rmActual = fs.rm;
    const directory = getWorkspaceDir(ids.destination);
    const removals: string[] = [];
    jest.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (target !== directory) return rmActual(target, options);
      removals.push(target);
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });

    await expect(
      cleanupCompositionDestination({
        source: 'workspace_combine',
        workspaceId: ids.destination,
      }),
    ).resolves.toBeUndefined();

    expect(await fileJson(getWorkspaceIndexFilePath())).toMatchObject({
      workspaces: [indexEntry(ids.source, 0)],
    });
    expect(removals).toEqual([directory]);
    expect(
      await readFile(getWorkspaceWorktreesFilePath(ids.destination), 'utf8'),
    ).toBe(listBefore);
  });
});
