// The D9 record scenarios (W6-0, CAN-4401): each runs the record functions,
// which build their decisions and apply them through the record port. Shared
// by the in-process port suite and the daemon record port parity (W6g).
import {
  WORKSPACE_ROOT_REPO_ID,
  type WorktreeChatBadgesSummary,
  type WorktreeData,
  type WorktreeHealthIssue,
} from '@canopy/desktop-shared/types';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import { observeWorktreeGit } from '../../worktree-git-observations';
import {
  recordWorktreeActivity,
  recordWorktreeChatBadges,
} from '../../worktree-observer-records';
import {
  reconcileWorktreeRecovery,
  recordWorktreeDiscovery,
  recordWorktreeHealth,
} from '../../worktree-repair';

export const WORKSPACE_ID = 'project';
export const CREATED_AT = '2026-10-01T00:00:00.000Z';
export const NOW = new Date('2026-10-17T08:30:00.000Z');

export function row(
  id: string,
  extra: Partial<WorktreeData> = {},
): WorktreeData {
  return { id, branchName: `branch-${id}`, createdAt: CREATED_AT, ...extra };
}

export function badges(
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

export function prStatus(
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
              checkDetails: [],
              reviewStatus: 'none',
              reviewers: [],
              hasConflicts: false,
              commentCount: 0,
              updatedAt: lastCheckedAt,
            },
    })),
    lastCheckedAt,
  };
}

export function issue(
  extra: Partial<WorktreeHealthIssue> = {},
): WorktreeHealthIssue {
  return {
    status: 'broken',
    code: 'missing-worktree-path',
    message: 'Worktree directory does not exist.',
    checkedAt: '2026-10-03T00:00:00.000Z',
    worktreePath: '/worktrees/a',
    ...extra,
  };
}

export const target = { workspaceId: WORKSPACE_ID, worktreeId: 'a' };
export const creation = {
  operationId: 'op-1',
  state: 'recovery-required' as const,
  phase: 'source-root-repair' as const,
  checkouts: [{ repositoryPath: '/repos/r0', checkoutPath: '/worktrees/a' }],
};

export interface Scenario {
  name: string;
  /** The seeded list; null leaves `worktrees.json` absent. */
  seed: WorktreeData[] | null;
  run: () => Promise<unknown>;
}

export const SCENARIOS: Scenario[] = [
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
