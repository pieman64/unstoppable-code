// W6b: host routing and ordered plain-data decisions through a fake creation
// port. The fake applies the pure decisions and writes the list plainly, so the
// host's own reads see them; this is not unmodified product lifecycle evidence.
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as DecisionApply from '../worktree-record-decision-apply';
import type * as Persistence from '../workspace-persistence';
import type * as Selection from '../worktree-creation-selection';
import type * as Paths from '../paths';
import type * as Fs from 'node:fs';
import type {
  ReservedWorktreeTarget,
  WorktreeCreationPromoteDecision,
  WorktreeCreationReservationDecision,
  WorktreeCreationReservationPreconditions,
  WorktreeCreationReservationRemovalDecision,
  WorktreeCreationSetupDecision,
  WorktreeRecordTarget,
} from '../worktree-record-decisions';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';

const mockEvents: unknown[] = [];
function mockRecord(entry: unknown): void {
  mockEvents.push(JSON.parse(JSON.stringify(entry)));
}
jest.mock('../worktree-creation-decision-port', () => {
  const pure = jest.requireActual<typeof DecisionApply>(
    '../worktree-record-decision-apply',
  );
  const persistence = jest.requireActual<typeof Persistence>(
    '../workspace-persistence',
  );
  const { refuseWorktreeCreation } = jest.requireActual<typeof Selection>(
    '../worktree-creation-selection',
  );
  const { getWorkspaceWorktreesFilePath } =
    jest.requireActual<typeof Paths>('../paths');
  const { writeFileSync: write } = jest.requireActual<typeof Fs>('node:fs');
  // A plain write: no lock, commit, reconciliation or tombstones.
  const persist = (workspaceId: string, worktrees: unknown[]): void =>
    write(
      getWorkspaceWorktreesFilePath(workspaceId),
      JSON.stringify({ version: 1, worktrees }),
    );
  const refuse = (
    refusal: DecisionApply.WorktreeCreationRecordRefusal,
  ): never =>
    refusal.reason === 'checkout-reserved'
      ? refuseWorktreeCreation(
          refusal.reason,
          'Checkout path is already in use',
        )
      : refuseWorktreeCreation(refusal.reason, refusal.branchName);
  return {
    applyWorktreeCreationReservation: jest.fn(
      async (
        workspaceId: string,
        decision: WorktreeCreationReservationDecision,
        preconditions: WorktreeCreationReservationPreconditions,
      ) => {
        mockRecord({ workspaceId, decision, preconditions });
        const rows = await persistence.readWorkspaceWorktrees(workspaceId);
        const pass = pure.applyWorktreeCreationReservationTo(rows, decision);
        if ('refusal' in pass) return refuse(pass.refusal);
        persist(workspaceId, pass.worktrees);
        return { status: pass.status };
      },
    ),
    applyReservedWorktreeRecord: jest.fn(
      async (
        target: ReservedWorktreeTarget,
        decision: WorktreeCreationSetupDecision,
      ) => {
        mockRecord({ target, decision });
        const rows = await persistence.readWorkspaceWorktrees(
          target.workspaceId,
        );
        const pass = pure.applyReservedWorktreeRecordTo(
          rows,
          { id: target.worktreeId, createdAt: target.createdAt },
          decision,
        );
        if ('refusal' in pass) return refuse(pass.refusal);
        persist(target.workspaceId, pass.worktrees);
        return pass.updated;
      },
    ),
    applyWorktreeSetupRecord: jest.fn(
      async (
        target: WorktreeRecordTarget,
        decision: WorktreeCreationPromoteDecision,
      ) => {
        mockRecord({
          target: {
            workspaceId: target.workspaceId,
            worktreeId: target.worktreeId,
          },
          decision,
        });
        const rows = await persistence.readWorkspaceWorktrees(
          target.workspaceId,
        );
        persist(
          target.workspaceId,
          rows.map((row) =>
            row.id === target.worktreeId
              ? pure.applyWorktreeCreationSetupTo(row, decision)
              : row,
          ),
        );
        return rows.some((row) => row.id === target.worktreeId);
      },
    ),
    applyReservedWorktreeRemoval: jest.fn(
      (
        target: ReservedWorktreeTarget,
        decision: WorktreeCreationReservationRemovalDecision,
      ) => {
        mockRecord({ target, decision });
        throw new Error('Unexpected reserved row removal');
      },
    ),
  };
});
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
  recordWorktreeCrudTelemetry: jest.fn(),
}));

import * as git from '../git';
import { readWorkspaceWorktrees } from '../workspace-persistence';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { createWorktreeFromSelection } from '../worktree-creation';
import { applyReservedWorktreeRemoval } from '../worktree-creation-decision-port';

jest.setTimeout(60_000);
const realCreateWorktree = git.createWorktree;
let dir: string;
let root: string;
let repo: string;
let originalDataDir: string | undefined;
const createdAt: unknown = expect.any(String);
const id: unknown = expect.any(String);

beforeEach(() => {
  ({ dir, root, repo } = createW5BoundaryFixture());
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  jest.clearAllMocks();
  mockEvents.length = 0;
  const create = git.createWorktree;
  jest.spyOn(git, 'createWorktree').mockImplementation(async (...args) => {
    mockEvents.push('git');
    return create(...args);
  });
  const createFrom = git.createWorktreeFromStartPoint;
  jest
    .spyOn(git, 'createWorktreeFromStartPoint')
    .mockImplementation(async (...args) => {
      mockEvents.push('git');
      return createFrom(...args);
    });
});
afterEach(() => {
  jest.restoreAllMocks();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

function useMultiRepoWorkspace(sourceRepoPath?: string): void {
  writeFileSync(
    join(root, 'a', 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath,
      repos: sourceRepoPath ? [] : [{ id: 'app', name: 'App', repoPath: repo }],
    }),
  );
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: [
        { id: 'a', name: 'Multi', type: 'multi-repo', color: 'blue', order: 0 },
      ],
    }),
  );
  __resetSidebarItemsStateForTests();
}
function reservedRow(branchName: unknown): unknown {
  const creation: unknown = expect.objectContaining({
    state: 'pending',
    phase: 'reserved',
  });
  return expect.objectContaining({
    id,
    branchName,
    createdAt,
    setupPhase: 'git-pending',
    creation,
  });
}
function reservation(branchName: unknown, expectedRevision?: number): unknown {
  return {
    workspaceId: 'a',
    decision: {
      kind: 'worktree.create.reserve',
      worktree: reservedRow(branchName),
    },
    preconditions: expectedRevision === undefined ? {} : { expectedRevision },
  };
}
const reserved = { workspaceId: 'a', worktreeId: id, createdAt };
function phase(
  value: string | undefined,
  recoveryRequired = false,
  healthIssue?: unknown,
): unknown {
  return {
    target: reserved,
    decision: {
      kind: 'worktree.create.phase',
      ...(value ? { phase: value } : {}),
      recoveryRequired,
      ...(healthIssue ? { healthIssue } : {}),
    },
  };
}
function promote(
  decision: Record<string, unknown>,
  enforced: boolean,
): unknown {
  return {
    target: enforced ? reserved : { workspaceId: 'a', worktreeId: id },
    decision: { kind: 'worktree.create.promote', ...decision },
  };
}

it('decides a synchronous single-repository create in its commit order', async () => {
  const outcome = await createWorktreeFromSelection({
    workspaceId: 'a',
    workspaceKind: 'single-repo',
    branch: { kind: 'new', branchName: 'sync' },
    base: { kind: 'repository-default' },
    allowBaseBranchNetwork: false,
    seedPanelLayoutMode: false,
    expectedRevision: 0,
  });
  expect(outcome).toMatchObject({ status: 'created' });
  expect(mockEvents).toEqual([
    reservation('sync', 0),
    phase('git-setup'),
    'git',
    promote({ workspaceKind: 'single-repo', branchName: 'sync' }, false),
  ]);
  const rows = await readWorkspaceWorktrees('a');
  expect(rows).toHaveLength(1);
  const [promoted] = rows;
  expect(promoted).toMatchObject({
    branchName: 'sync',
    setupPhase: 'git-ready',
    creation: { state: 'complete' },
  });
});

it('decides a deferred single-repository create against its reserved incarnation', async () => {
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  await createWorktreeFromSelection({
    workspaceId: 'a',
    workspaceKind: 'single-repo',
    branch: { kind: 'new', branchName: 'deferred' },
    base: { kind: 'branch', baseBranch: 'main' },
    deferGitSetup: true,
    allowBaseBranchNetwork: false,
    seedPanelLayoutMode: false,
    onGitSetupSettled: settle,
  });
  await settled;
  expect(mockEvents).toEqual([
    reservation('deferred'),
    phase('git-setup'),
    'git',
    promote(
      {
        workspaceKind: 'single-repo',
        branchName: 'deferred',
        trackedBaseBranch: 'main',
      },
      true,
    ),
  ]);
});

it('records a failed Git effect as recovery-required with its health issue', async () => {
  jest.mocked(git.createWorktree).mockImplementationOnce(() => {
    mockEvents.push('git');
    return Promise.reject(new Error('Git interrupted'));
  });
  await expect(
    createWorktreeFromSelection({
      workspaceId: 'a',
      workspaceKind: 'single-repo',
      branch: { kind: 'new', branchName: 'failed' },
      base: { kind: 'repository-default' },
      allowBaseBranchNetwork: false,
      seedPanelLayoutMode: false,
    }),
  ).rejects.toThrow('Git interrupted');
  expect(mockEvents).toEqual([
    reservation('failed'),
    phase('git-setup'),
    'git',
    phase(
      undefined,
      true,
      expect.objectContaining({
        status: 'broken',
        gitError: 'Git interrupted',
      }),
    ),
  ]);
  const rows = await readWorkspaceWorktrees('a');
  expect(rows).toHaveLength(1);
  const [retained] = rows;
  expect(retained).toMatchObject({
    setupPhase: 'git-pending',
    creation: { state: 'recovery-required', phase: 'git-setup' },
  });
});

it('decides a multi-repository create through both setup phases and its promotion', async () => {
  useMultiRepoWorkspace();
  await createWorktreeFromSelection({
    workspaceId: 'a',
    workspaceKind: 'multi-repo',
    branch: { kind: 'new', branchName: 'multi' },
    base: { kind: 'repository-default' },
    allowBaseBranchNetwork: false,
    seedPanelLayoutMode: false,
  });
  expect(mockEvents).toEqual([
    reservation('multi'),
    phase('git-setup'),
    phase('git-setup'),
    'git',
    promote({ workspaceKind: 'multi-repo', branchName: 'multi' }, false),
  ]);
});

it('retains a needs-repair root with a recovery phase and no promotion', async () => {
  useMultiRepoWorkspace(repo);
  const outcome = await createWorktreeFromSelection({
    workspaceId: 'a',
    workspaceKind: 'multi-repo',
    branch: { kind: 'new', branchName: 'repair' },
    base: { kind: 'repository-default' },
    includedRepoIds: [],
    surfaceNeedsRepairInResponse: true,
    allowBaseBranchNetwork: false,
    seedPanelLayoutMode: false,
  });
  expect(outcome).toMatchObject({ status: 'needs-repair' });
  expect(mockEvents).toEqual([
    reservation('repair'),
    phase('git-setup'),
    'git',
    phase('source-root-repair', true),
  ]);
});

it('records a reconciled root branch, the approved repair and the promotion in order', async () => {
  useMultiRepoWorkspace(repo);
  // Git reports a different branch than the reserved default name.
  jest
    .mocked(git.createWorktree)
    .mockImplementationOnce(async (repoPath, worktreePath) => {
      mockEvents.push('git');
      return realCreateWorktree(repoPath, worktreePath, 'reconciled');
    });
  await createWorktreeFromSelection({
    workspaceId: 'a',
    workspaceKind: 'multi-repo',
    branch: { kind: 'default' },
    base: { kind: 'repository-default' },
    includedRepoIds: [],
    repairWorkspaceRoot: true,
    allowBaseBranchNetwork: false,
    seedPanelLayoutMode: false,
  });
  expect(mockEvents).toEqual([
    reservation(id),
    phase('git-setup'),
    'git',
    {
      target: reserved,
      decision: { kind: 'worktree.create.branch', branchName: 'reconciled' },
    },
    phase('source-root-repair'),
    phase('git-setup'),
    promote({ workspaceKind: 'multi-repo', branchName: 'reconciled' }, false),
  ]);
  expect(applyReservedWorktreeRemoval).not.toHaveBeenCalled();
  expect(
    execFileSync('git', ['-C', repo, 'branch', '--list', 'reconciled'], {
      encoding: 'utf8',
    }),
  ).toContain('reconciled');
});
