// W6-0 (CAN-4401): the in-process record decision port. A fake port records
// the decisions the six record functions build; replaying them through the
// in-process port on a copy of the data root must write the same
// `worktrees.json` bytes, and return the same outcomes, as the record
// functions writing directly. Runs the real workspace persistence module.
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));

type MockPortCall =
  | { entry: 'row'; args: [WorktreeRecordTarget, WorktreeRowDecision] }
  | { entry: 'list'; args: [string, WorktreeListDecision] };
const mockPortCalls: MockPortCall[] = [];
const mockPortOutcomes: unknown[] = [];
let mockRecordOnly = false;

jest.mock('../worktree-record-decision-port', () => {
  const actual = jest.requireActual<typeof Port>(
    '../worktree-record-decision-port',
  );
  const record = async (
    call: MockPortCall,
    apply: () => Promise<unknown>,
  ): Promise<unknown> => {
    // Recorded as JSON, so a replay proves the decision is plain data.
    mockPortCalls.push(JSON.parse(JSON.stringify(call)) as MockPortCall);
    if (mockRecordOnly) return undefined;
    const outcome = await apply();
    mockPortOutcomes.push(outcome);
    return outcome;
  };
  return {
    applyWorktreeRowDecision: (
      target: WorktreeRecordTarget,
      decision: WorktreeRowDecision,
    ): Promise<unknown> =>
      record({ entry: 'row', args: [target, decision] }, () =>
        actual.applyWorktreeRowDecision(target, decision),
      ),
    applyWorktreeListDecision: (
      workspaceId: string,
      decision: WorktreeListDecision,
    ): Promise<unknown> =>
      record({ entry: 'list', args: [workspaceId, decision] }, () =>
        actual.applyWorktreeListDecision(workspaceId, decision),
      ),
  };
});

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WORKSPACE_ROOT_REPO_ID,
  type WorktreeChatBadgesSummary,
  type WorktreeData,
  type WorktreeHealthIssue,
} from '@canopy/desktop-shared/types';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import { getWorkspaceWorktreesFilePath } from '../paths';
import * as persistence from '../workspace-persistence';
import { registerWorkspaceTypes } from '../workspace-registry';
import { observeWorktreeGit } from '../worktree-git-observations';
import {
  recordWorktreeActivity,
  recordWorktreeChatBadges,
} from '../worktree-observer-records';
import type * as Port from '../worktree-record-decision-port';
import type {
  W5RecordDecisionPort,
  WorktreeListDecision,
  WorktreeRecordTarget,
  WorktreeRowDecision,
} from '../worktree-record-decisions';
import {
  reconcileWorktreeRecovery,
  recordWorktreeDiscovery,
  recordWorktreeHealth,
} from '../worktree-repair';

// This module implements the port's row and list members; the rest are in
// `workspace-record-decision-port.ts`.
const port: Pick<
  W5RecordDecisionPort,
  'applyWorktreeRowDecision' | 'applyWorktreeListDecision'
> = jest.requireActual<typeof Port>('../worktree-record-decision-port');

const WORKSPACE_ID = 'project';
const CREATED_AT = '2026-10-01T00:00:00.000Z';
const NOW = new Date('2026-10-17T08:30:00.000Z');

function row(id: string, extra: Partial<WorktreeData> = {}): WorktreeData {
  return { id, branchName: `branch-${id}`, createdAt: CREATED_AT, ...extra };
}

function badges(
  overrides: Partial<WorktreeChatBadgesSummary> = {},
): WorktreeChatBadgesSummary {
  return {
    version: 2,
    unreadChats: [],
    approvalChats: [],
    needsHydration: false,
    updatedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

function prStatus(
  states: ('open' | 'draft' | 'merged' | 'closed' | null)[],
  lastCheckedAt = '2026-10-02T00:00:00.000Z',
): WorktreePrStatus {
  return {
    repos: states.map((state, index) => ({
      repoId: `r${index}`,
      repoName: `r${index}`,
      status:
        state === null
          ? null
          : {
              prNumber: index + 1,
              prUrl: `https://example.test/pr/${index + 1}`,
              state,
              title: 'PR',
              checkStatus: 'passing',
            },
    })),
    lastCheckedAt,
  };
}

function issue(extra: Partial<WorktreeHealthIssue> = {}): WorktreeHealthIssue {
  return {
    status: 'broken',
    code: 'missing-worktree-path',
    message: 'Worktree directory does not exist.',
    checkedAt: '2026-10-03T00:00:00.000Z',
    worktreePath: '/worktrees/a',
    ...extra,
  };
}

const target = { workspaceId: WORKSPACE_ID, worktreeId: 'a' };
const creation = {
  operationId: 'op-1',
  state: 'recovery-required' as const,
  phase: 'source-root-repair' as const,
  checkouts: [{ repositoryPath: '/repos/r0', checkoutPath: '/worktrees/a' }],
};

interface Scenario {
  name: string;
  /** The seeded list; null leaves `worktrees.json` absent. */
  seed: WorktreeData[] | null;
  run: () => Promise<unknown>;
}

const SCENARIOS: Scenario[] = [
  // internal.worktree.activity.record
  {
    name: 'watermark advances',
    seed: [row('a', { lastTouchedAt: '2026-10-01T00:00:00.000Z' }), row('b')],
    run: () =>
      recordWorktreeActivity({
        source: 'activity_watermark',
        ...target,
        touchedAt: '2026-10-05T14:00:00+02:00',
      }),
  },
  {
    name: 'watermark never moves backward',
    seed: [row('a', { lastTouchedAt: '2026-10-09T00:00:00.000Z' })],
    run: () =>
      recordWorktreeActivity({
        source: 'activity_watermark',
        ...target,
        touchedAt: '2026-10-05T12:00:00.000Z',
      }),
  },
  {
    name: 'watermark of an unknown worktree',
    seed: [row('b')],
    run: () =>
      recordWorktreeActivity({
        source: 'activity_watermark',
        ...target,
        touchedAt: '2026-10-05T12:00:00.000Z',
      }),
  },
  {
    name: 'watermark without a list',
    seed: null,
    run: () =>
      recordWorktreeActivity({
        source: 'activity_watermark',
        ...target,
        touchedAt: '2026-10-05T12:00:00.000Z',
      }),
  },
  {
    name: 'Auto Delete baseline advances older rows only',
    seed: [
      row('a', { lastTouchedAt: '2026-10-01T00:00:00.000Z' }),
      row('b', { lastTouchedAt: '2026-10-09T00:00:00.000Z' }),
      row('c'),
      row('d', { lastTouchedAt: 'not a date' }),
    ],
    run: () =>
      recordWorktreeActivity({
        source: 'auto_delete_baseline',
        workspaceId: WORKSPACE_ID,
        touchedAt: '2026-10-05T12:00:00.000Z',
      }),
  },
  {
    name: 'Auto Delete baseline over newer rows',
    seed: [row('a', { lastTouchedAt: '2026-10-09T00:00:00.000Z' })],
    run: () =>
      recordWorktreeActivity({
        source: 'auto_delete_baseline',
        workspaceId: WORKSPACE_ID,
        touchedAt: '2026-10-05T12:00:00.000Z',
      }),
  },
  {
    name: 'Auto Delete baseline over an empty list',
    seed: [],
    run: () =>
      recordWorktreeActivity({
        source: 'auto_delete_baseline',
        workspaceId: WORKSPACE_ID,
        touchedAt: '2026-10-05T12:00:00.000Z',
      }),
  },
  // internal.worktree.chatBadges.record
  {
    name: 'chat commit replaces badges',
    seed: [row('a', { chatBadges: badges() })],
    run: () =>
      recordWorktreeChatBadges({
        source: 'chat_commit',
        ...target,
        summary: badges({
          unreadChats: [{ chatId: 'c1', title: 'One', providerType: 'claude' }],
          chatName: 'Chat',
        }),
      }),
  },
  {
    name: 'chat commit with equivalent badges',
    seed: [row('a', { chatBadges: badges() })],
    run: () =>
      recordWorktreeChatBadges({
        source: 'chat_commit',
        ...target,
        summary: badges({ updatedAt: '2026-10-09T00:00:00.000Z' }),
      }),
  },
  {
    name: 'chat commit clears badges',
    seed: [
      row('a', {
        chatBadges: badges({
          approvalChats: [{ chatId: 'c1', title: 'One' }],
        }),
      }),
    ],
    run: () =>
      recordWorktreeChatBadges({
        source: 'chat_commit',
        ...target,
        summary: badges(),
      }),
  },
  {
    name: 'launch backfill fills, upgrades and keeps',
    seed: [
      row('a'),
      row('b', {
        chatBadges: badges({
          version: 1,
          unreadChats: [{ chatId: 'live', title: 'Live' }],
        }),
      }),
      row('c', { chatBadges: badges({ chatName: 'Kept' }) }),
    ],
    run: async () => [
      await recordWorktreeChatBadges({
        source: 'launch_backfill',
        ...target,
        summary: badges({ chatName: 'Filled' }),
      }),
      await recordWorktreeChatBadges({
        source: 'launch_backfill',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'b',
        summary: badges({ chatName: 'Named' }),
      }),
      await recordWorktreeChatBadges({
        source: 'launch_backfill',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'c',
        summary: badges({ chatName: 'Other' }),
      }),
      await recordWorktreeChatBadges({
        source: 'launch_backfill',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'missing',
        summary: badges(),
      }),
    ],
  },
  // internal.worktree.git.observe
  {
    name: 'branch changes on root, repository and single-repo checkouts',
    seed: [
      row('a', { lastKnownPrStatus: prStatus(['merged']), status: 'done' }),
      row('b', { lastKnownPrStatus: prStatus(['open']) }),
      row('c', { lastKnownPrStatus: prStatus(['open']) }),
      row('d', { branchName: 'same', lastKnownPrStatus: null }),
    ],
    run: async () => [
      await observeWorktreeGit({
        kind: 'branch',
        ...target,
        branchName: '  feature/next  ',
      }),
      await observeWorktreeGit({
        kind: 'branch',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'b',
        repoId: 'r1',
        branchName: 'child',
      }),
      await observeWorktreeGit({
        kind: 'branch',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'c',
        repoId: WORKSPACE_ROOT_REPO_ID,
        branchName: 'root',
      }),
      await observeWorktreeGit({
        kind: 'branch',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'd',
        branchName: 'same',
      }),
      await observeWorktreeGit({
        kind: 'branch',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'missing',
        branchName: 'x',
      }),
    ],
  },
  {
    name: 'pull request statuses',
    seed: [
      row('a'),
      row('b', { status: 'done' }),
      row('c', { lastKnownPrStatus: prStatus(['open']) }),
      row('d', { status: 'done' }),
    ],
    run: async () => [
      await observeWorktreeGit({
        kind: 'pr-status',
        ...target,
        status: prStatus(['merged', null]),
      }),
      await observeWorktreeGit({
        kind: 'pr-status',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'b',
        status: prStatus(['draft']),
      }),
      await observeWorktreeGit({
        kind: 'pr-status',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'c',
        status: prStatus(['open'], '2026-10-09T00:00:00.000Z'),
      }),
      await observeWorktreeGit({
        kind: 'pr-status',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'd',
        status: null,
      }),
    ],
  },
  {
    name: 'split grouping and retarget',
    seed: [row('a'), row('b', { branchGroupingOverride: 'group' })],
    run: async () => [
      await observeWorktreeGit({ kind: 'split-child-grouping', ...target }),
      await observeWorktreeGit({
        kind: 'split-child-grouping',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'b',
      }),
      await observeWorktreeGit({
        kind: 'split-original-retarget',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'b',
        branchName: ' integration ',
        trackedBaseBranch: 'main',
      }),
    ],
  },
  {
    name: 'merged base retarget',
    seed: [
      row('merged', { trackedBaseBranch: 'feature' }),
      row('a', { trackedBaseBranch: 'feature' }),
      row('b', {
        trackedRepoBaseBranches: {
          r1: 'feature',
          [WORKSPACE_ROOT_REPO_ID]: 'feature',
          other: 'feature',
        },
      }),
      row('c', { trackedBaseBranch: 'develop' }),
    ],
    run: async () => [
      await observeWorktreeGit({
        kind: 'merged-base-retarget',
        workspaceId: WORKSPACE_ID,
        repoIds: [null, 'r1', WORKSPACE_ROOT_REPO_ID],
        mergedBranchName: 'feature',
        mergedIntoBranchName: 'main',
        mergedWorktreeId: 'merged',
      }),
      await observeWorktreeGit({
        kind: 'merged-base-retarget',
        workspaceId: WORKSPACE_ID,
        repoIds: [null],
        mergedBranchName: 'develop',
        mergedIntoBranchName: 'main',
      }),
      await observeWorktreeGit({
        kind: 'merged-base-retarget',
        workspaceId: WORKSPACE_ID,
        repoIds: [null],
        mergedBranchName: 'nothing',
        mergedIntoBranchName: 'main',
      }),
    ],
  },
  // internal.worktree.health.record
  {
    name: 'health records',
    seed: [
      row('a'),
      row('b', { healthIssue: issue({ checkedAt: '2026-10-01T00:00:00Z' }) }),
      row('c', { healthIssue: issue(), splitRecoveryRequired: true }),
      row('d', { healthIssue: issue({ checkedAt: '2026-10-01T00:00:00Z' }) }),
    ],
    run: async () => [
      await recordWorktreeHealth({
        source: 'health-check',
        ...target,
        issue: issue(),
      }),
      await recordWorktreeHealth({
        source: 'diff-stats',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'b',
        issue: issue(),
      }),
      await recordWorktreeHealth({
        source: 'health-check',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'c',
        issue: null,
      }),
      await recordWorktreeHealth({
        source: 'health-check',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'd',
        issue: issue(),
      }),
      await recordWorktreeHealth({
        source: 'diff-stats',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'missing',
        issue: null,
      }),
    ],
  },
  // internal.worktree.discovery.record
  {
    name: 'discovery records',
    seed: [row('a'), row('b', { branchPromptSent: true })],
    run: async () => [
      await recordWorktreeDiscovery({
        kind: 'environment',
        ...target,
        discovery: {
          slashCommands: [{ name: 'review', description: 'Review' }],
          mcpServers: [],
          discoveredAt: '2026-10-02T00:00:00.000Z',
          providerType: 'claude',
        },
      }),
      await recordWorktreeDiscovery({
        kind: 'branch-prompt',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'b',
        sent: true,
      }),
      await recordWorktreeDiscovery({
        kind: 'branch-prompt',
        ...target,
        sent: false,
      }),
    ],
  },
  // internal.worktree.recovery.reconcile
  {
    name: 'recovery promotes, repairs and refuses other incarnations',
    seed: [
      row('a', { setupPhase: 'git-pending' }),
      row('b', { setupPhase: 'git-pending', creation }),
      row('c', { setupPhase: 'git-pending', creation }),
      row('d', { setupPhase: 'git-ready' }),
    ],
    run: async () => [
      await reconcileWorktreeRecovery({
        kind: 'promote-pending',
        ...target,
        createdAt: CREATED_AT,
        branchName: 'feature/checked-out',
      }),
      await reconcileWorktreeRecovery({
        kind: 'complete-source-root-repair',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'b',
        createdAt: CREATED_AT,
        operationId: 'op-1',
      }),
      await reconcileWorktreeRecovery({
        kind: 'complete-source-root-repair',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'c',
        createdAt: CREATED_AT,
        operationId: 'op-2',
      }),
      await reconcileWorktreeRecovery({
        kind: 'promote-pending',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'd',
        createdAt: CREATED_AT,
        branchName: 'x',
      }),
      await reconcileWorktreeRecovery({
        kind: 'promote-pending',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'd',
        createdAt: '2026-10-09T00:00:00.000Z',
        branchName: 'x',
      }),
    ],
  },
  {
    name: 'recovery exposes create and split reservations',
    seed: [
      row('a', {
        setupPhase: 'git-pending',
        creation: { ...creation, state: 'pending', phase: 'git-setup' },
      }),
      row('b', { hidden: true, setupPhase: 'git-pending' }),
      row('c', { creation: { ...creation, state: 'complete' } }),
    ],
    run: async () => [
      await reconcileWorktreeRecovery({
        kind: 'expose-create-reservation',
        ...target,
        createdAt: CREATED_AT,
        operationId: 'op-1',
        worktreePath: '/worktrees/a',
      }),
      await reconcileWorktreeRecovery({
        kind: 'expose-split-reservation',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'b',
        createdAt: CREATED_AT,
        worktreePath: '/worktrees/b',
      }),
      await reconcileWorktreeRecovery({
        kind: 'expose-create-reservation',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'c',
        createdAt: CREATED_AT,
        operationId: 'op-1',
        worktreePath: '/worktrees/c',
      }),
    ],
  },
];

describe('worktree record decision port (real fs)', () => {
  let originalDataDir: string | undefined;
  const dataDirs: string[] = [];

  async function newDataDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'canopy-record-port-'));
    dataDirs.push(dir);
    return dir;
  }

  function useDataDir(dir: string): string {
    process.env.CANOPY_DATA_DIR = dir;
    persistence.clearWorktreesSelfWriteTracking(WORKSPACE_ID);
    return getWorkspaceWorktreesFilePath(WORKSPACE_ID);
  }

  async function readBytes(file: string): Promise<string | null> {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      // fs errors come from another realm, so test the shape, not the class.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return null;
      throw error;
    }
  }

  async function replay(calls: MockPortCall[]): Promise<unknown[]> {
    const outcomes: unknown[] = [];
    for (const call of calls) {
      outcomes.push(
        call.entry === 'row'
          ? await port.applyWorktreeRowDecision(...call.args)
          : await port.applyWorktreeListDecision(...call.args),
      );
    }
    return outcomes;
  }

  beforeEach(() => {
    // Only the clock is fixed; file system timers stay real.
    jest.useFakeTimers({
      now: NOW,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    registerWorkspaceTypes(new Map([[WORKSPACE_ID, 'single-repo']]));
    originalDataDir = process.env.CANOPY_DATA_DIR;
    mockPortCalls.length = 0;
    mockPortOutcomes.length = 0;
    mockRecordOnly = false;
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    registerWorkspaceTypes(new Map());
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await Promise.all(
      dataDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('covers every decision kind', async () => {
    const kinds = new Set<string>();
    for (const scenario of SCENARIOS) {
      useDataDir(await newDataDir());
      mockRecordOnly = true;
      mockPortCalls.length = 0;
      await scenario.run();
      for (const call of mockPortCalls) kinds.add(call.args[1].kind);
    }
    expect(kinds.size).toBe(15);
  });

  it.each(SCENARIOS.map((scenario) => [scenario.name, scenario]))(
    'replays %s through the in-process port to identical bytes and outcomes',
    async (_name, scenario) => {
      const direct = await newDataDir();
      const copy = await newDataDir();
      const directFile = useDataDir(direct);
      if (scenario.seed !== null) {
        await mkdir(path.dirname(directFile), { recursive: true });
        await writeFile(
          directFile,
          JSON.stringify({ version: 1, worktrees: scenario.seed }, null, 2),
        );
      }
      await cp(direct, copy, { recursive: true });

      await scenario.run();
      const directCalls = mockPortCalls.splice(0);
      const directOutcomes = mockPortOutcomes.splice(0);
      const directBytes = await readBytes(directFile);

      const copyFile = useDataDir(copy);
      mockRecordOnly = true;
      await scenario.run();
      const recorded = mockPortCalls.splice(0);
      expect(recorded).toEqual(directCalls);
      expect(await readBytes(copyFile)).toBe(
        scenario.seed === null
          ? null
          : JSON.stringify({ version: 1, worktrees: scenario.seed }, null, 2),
      );

      const replayOutcomes = await replay(recorded);
      expect(replayOutcomes).toEqual(directOutcomes);
      expect(await readBytes(copyFile)).toBe(directBytes);
    },
  );

  describe('the outcome comes from the last pass of the updater', () => {
    function updaterRunsOn(rows: WorktreeData[]): void {
      jest
        .spyOn(persistence, 'updateWorkspaceWorktree')
        .mockImplementation((_workspaceId, _worktreeId, updater) => {
          for (const current of rows) updater(current);
          return Promise.resolve(true);
        });
    }

    it('reports a git row from its last pass', async () => {
      const last = row('a', { branchGroupingOverride: 'group' });
      updaterRunsOn([row('a'), last]);
      await expect(
        port.applyWorktreeRowDecision(target, {
          kind: 'git.split-child-grouping',
        }),
      ).resolves.toEqual({ status: 'unchanged', worktree: last });
    });

    it('reports a recovery of a replaced incarnation as not-found', async () => {
      updaterRunsOn([
        row('a', { setupPhase: 'git-pending' }),
        row('a', { createdAt: '2026-10-09T00:00:00.000Z' }),
      ]);
      await expect(
        port.applyWorktreeRowDecision(target, {
          kind: 'recovery.promote-pending',
          createdAt: CREATED_AT,
          branchName: 'feature',
        }),
      ).resolves.toEqual({ status: 'not-found', worktree: null });
    });

    it('reports a watermark and badges from their last pass', async () => {
      const last = row('a', {
        lastTouchedAt: '2026-10-09T00:00:00.000Z',
        chatBadges: badges(),
      });
      updaterRunsOn([row('a'), last]);
      await expect(
        port.applyWorktreeRowDecision(target, {
          kind: 'activity.watermark',
          touchedAt: '2026-10-05T12:00:00.000Z',
        }),
      ).resolves.toEqual({ worktrees: [last], changed: false });
      await expect(
        port.applyWorktreeRowDecision(target, {
          kind: 'chatBadges',
          source: 'launch_backfill',
          summary: badges({ chatName: 'Named' }),
        }),
      ).resolves.toEqual({ status: 'unchanged' });
    });

    it('reports a merged base retarget from its last pass', async () => {
      jest
        .spyOn(persistence, 'updateWorkspaceWorktrees')
        .mockImplementation(async (_workspaceId, updater) => {
          await updater([row('a', { trackedBaseBranch: 'feature' })]);
          return updater([row('a', { trackedBaseBranch: 'main' })]);
        });
      await expect(
        port.applyWorktreeListDecision(WORKSPACE_ID, {
          kind: 'git.merged-base-retarget',
          repoIds: [null],
          mergedBranchName: 'feature',
          mergedIntoBranchName: 'main',
        }),
      ).resolves.toEqual({ status: 'unchanged', updates: [] });
    });

    // Each family keeps its record function's outcome formula when the
    // writer's `found` and whether the updater ran disagree (as with a mocked
    // writer): git observations follow the writer's `found`; repair and
    // reconcile, badges and the watermark follow the updater.
    const hiddenRow = row('a', {
      hidden: true,
      setupPhase: 'git-pending',
      creation: { ...creation, state: 'pending', phase: 'git-setup' },
    });
    const FAMILY_DECISIONS: {
      decision: WorktreeRowDecision;
      /** The row the updater sees; defaults to `hiddenRow`. */
      current?: WorktreeData;
      foundWithoutPass: unknown;
      passWithoutFound: (next: WorktreeData) => unknown;
    }[] = [
      ...(
        [
          { kind: 'git.branch', branchName: 'next' },
          { kind: 'git.pr-status', status: prStatus(['open']) },
          { kind: 'git.split-child-grouping' },
          {
            kind: 'git.split-original-retarget',
            branchName: 'integration',
            trackedBaseBranch: 'main',
          },
        ] satisfies WorktreeRowDecision[]
      ).map((decision) => ({
        decision,
        foundWithoutPass: { status: 'unchanged', worktree: null },
        passWithoutFound: () => ({ status: 'not-found', worktree: null }),
      })),
      ...(
        [
          { kind: 'health', source: 'health-check', issue: issue() },
          {
            kind: 'discovery.environment',
            discovery: {
              slashCommands: [],
              mcpServers: [],
              discoveredAt: '2026-10-02T00:00:00.000Z',
              providerType: 'claude',
            },
          },
          { kind: 'discovery.branch-prompt', sent: true },
          {
            kind: 'recovery.expose-create-reservation',
            createdAt: CREATED_AT,
            operationId: 'op-1',
            worktreePath: '/worktrees/a',
          },
          {
            kind: 'recovery.expose-split-reservation',
            createdAt: CREATED_AT,
            worktreePath: '/worktrees/a',
          },
        ] satisfies WorktreeRowDecision[]
      ).map((decision) => ({
        decision,
        foundWithoutPass: { status: 'not-found', worktree: null },
        passWithoutFound: (next: WorktreeData) => ({
          status: 'recorded',
          worktree: next,
        }),
      })),
      ...(
        [
          {
            decision: {
              kind: 'recovery.promote-pending',
              createdAt: CREATED_AT,
              branchName: 'feature',
            },
            current: row('a', { setupPhase: 'git-pending' }),
          },
          {
            decision: {
              kind: 'recovery.complete-source-root-repair',
              createdAt: CREATED_AT,
              operationId: 'op-1',
            },
            current: row('a', { setupPhase: 'git-pending', creation }),
          },
        ] satisfies { decision: WorktreeRowDecision; current: WorktreeData }[]
      ).map((entry) => ({
        ...entry,
        foundWithoutPass: { status: 'not-found', worktree: null },
        passWithoutFound: (next: WorktreeData) => ({
          status: 'recorded',
          worktree: next,
        }),
      })),
      {
        decision: {
          kind: 'chatBadges',
          source: 'launch_backfill',
          summary: badges(),
        },
        foundWithoutPass: { status: 'not-found' },
        passWithoutFound: () => ({ status: 'recorded' }),
      },
      {
        decision: {
          kind: 'activity.watermark',
          touchedAt: '2026-10-05T12:00:00.000Z',
        },
        foundWithoutPass: { worktrees: [], changed: false },
        passWithoutFound: (next: WorktreeData) => ({
          worktrees: [next],
          changed: true,
        }),
      },
    ];

    it.each(FAMILY_DECISIONS.map((entry) => [entry.decision.kind, entry]))(
      'reports %s when the writer finds the row without running the updater',
      async (_kind, { decision, foundWithoutPass }) => {
        const write = jest
          .spyOn(persistence, 'updateWorkspaceWorktree')
          .mockResolvedValue(true);
        await expect(
          port.applyWorktreeRowDecision(target, decision),
        ).resolves.toEqual(foundWithoutPass);
        expect(write).toHaveBeenCalledTimes(1);
      },
    );

    it.each(FAMILY_DECISIONS.map((entry) => [entry.decision.kind, entry]))(
      'reports %s when the updater runs but the writer reports not found',
      async (_kind, { decision, current = hiddenRow, passWithoutFound }) => {
        let next: WorktreeData | undefined;
        jest
          .spyOn(persistence, 'updateWorkspaceWorktree')
          .mockImplementation((_workspaceId, _worktreeId, updater) => {
            next = updater(current);
            return Promise.resolve(false);
          });
        const outcome = await port.applyWorktreeRowDecision(target, decision);
        expect(next).toBeDefined();
        expect(next).not.toBe(current);
        if (next) expect(outcome).toEqual(passWithoutFound(next));
      },
    );

    it('reports a list decision the writer never applied as unchanged', async () => {
      jest.spyOn(persistence, 'updateWorkspaceWorktrees').mockResolvedValue([]);
      await expect(
        port.applyWorktreeListDecision(WORKSPACE_ID, {
          kind: 'git.merged-base-retarget',
          repoIds: [null],
          mergedBranchName: 'feature',
          mergedIntoBranchName: 'main',
        }),
      ).resolves.toEqual({ status: 'unchanged', updates: [] });
      await expect(
        port.applyWorktreeListDecision(WORKSPACE_ID, {
          kind: 'activity.auto-delete-baseline',
          touchedAt: '2026-10-05T12:00:00.000Z',
        }),
      ).resolves.toEqual({ worktrees: [], changed: false });
    });

    it('reports a recovery whose last pass is the same incarnation', async () => {
      updaterRunsOn([
        row('a', { createdAt: '2026-10-09T00:00:00.000Z' }),
        row('a', { setupPhase: 'git-pending' }),
      ]);
      await expect(
        port.applyWorktreeRowDecision(target, {
          kind: 'recovery.promote-pending',
          createdAt: CREATED_AT,
          branchName: 'feature',
        }),
      ).resolves.toMatchObject({
        status: 'recorded',
        worktree: { id: 'a', setupPhase: 'git-ready' },
      });
    });

    it('reads the clock inside each pass', async () => {
      const stamps: string[] = [];
      jest
        .spyOn(persistence, 'updateWorkspaceWorktree')
        .mockImplementation((_workspaceId, _worktreeId, updater) => {
          for (const at of ['2026-10-18T00:00:00.000Z', NOW.toISOString()]) {
            jest.setSystemTime(new Date(at));
            stamps.push(
              updater(row('a', { hidden: true })).healthIssue?.checkedAt ?? '',
            );
          }
          return Promise.resolve(true);
        });
      await port.applyWorktreeRowDecision(target, {
        kind: 'recovery.expose-split-reservation',
        createdAt: CREATED_AT,
        worktreePath: '/worktrees/a',
      });
      expect(stamps).toEqual(['2026-10-18T00:00:00.000Z', NOW.toISOString()]);
    });
  });
});
