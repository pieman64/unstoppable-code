import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { WorktreeRow } from '@canopy/ui-shared/components';
import type { PortalSessionShellState } from '@canopy/protocol/portal';
import {
  derivePrBadgeStatus,
  firstVisibleWorkspaceId,
  hasAllKnownPrsMerged,
  orderWorktreesForSidebar,
  visibleWorkspaceCount,
  workspaceColor,
  workspaceKind,
} from '../sidebar-model';

type PrSnapshot = NonNullable<Parameters<typeof derivePrBadgeStatus>[0]>;
type PrStatus = NonNullable<PrSnapshot['repos'][number]['status']>;

const makePrSnapshot = (
  repos: readonly {
    readonly repoId: string;
    readonly status: Partial<PrStatus> | null;
  }[],
): PrSnapshot => ({
  repos: repos.map(({ repoId, status }) => ({
    repoId,
    repoName: repoId,
    status:
      status === null
        ? null
        : {
            state: 'open',
            prNumber: 42,
            prUrl: `https://github.com/example/${repoId}/pull/42`,
            title: 'PR',
            checkStatus: 'passing',
            reviewStatus: 'approved',
            hasConflicts: false,
            commentCount: 0,
            updatedAt: '2026-10-06T00:00:00.000Z',
            ...status,
          },
  })),
  lastCheckedAt: '2026-10-06T00:00:00.000Z',
});

function snapshot(): PortalSessionShellState {
  return {
    workspaces: [
      { localId: 'hidden', name: 'Hidden', type: 'single-repo', hidden: true },
      { localId: 'second', name: 'Second', type: 'multi-repo', order: 2 },
      { localId: 'first', name: 'First', type: 'single-repo', order: 1 },
      { localId: 'cowork', name: 'Cowork', type: 'cowork' },
    ],
    worktrees: [],
    chatProjects: [],
    standaloneChats: [],
    scriptDescriptors: [],
    scriptRuns: [],
    hookDescriptors: [],
    hookRuns: [],
    plans: [],
    pipelines: [],
    pipelineRuns: [],
    chatMessages: [],
    chatSummaries: [],
    terminalSessions: [],
    terminalBuffers: {},
    changedFiles: {},
    diffSnapshots: {},
    prStatuses: {},
    fileRoots: [],
    fileTree: {},
    filePreviews: {},
    refreshing: false,
    connectionStatus: 'active',
  };
}

// REG-2819. Both selectors gate on LAYOUT: they answer "is there a workspace
// with rows to select", and a cloud workspace has rows despite classifying as
// `cowork`. Keyed to `type` these would drop cloud out of the count and out of
// default selection — a regression invisible until a cloud-only session.
describe('layout-gated project visibility', () => {
  function withCloud(): PortalSessionShellState {
    return {
      ...snapshot(),
      workspaces: [
        {
          localId: 'cloud',
          name: 'Cloud',
          type: 'cowork',
          layout: 'tree',
          backend: 'cloud',
          order: 0,
        },
        { localId: 'desktop-cowork', name: 'Cowork', type: 'cowork', order: 3 },
      ],
    };
  }

  it('counts a tree-layout cloud project and skips the flat one', () => {
    expect(visibleWorkspaceCount(withCloud())).toBe(1);
  });

  it('selects the cloud project by default, never the flat one', () => {
    expect(firstVisibleWorkspaceId(withCloud())).toBe('cloud');
  });

  it('still reports the cowork kind badge for a cloud project', () => {
    expect(
      workspaceKind({
        localId: 'cloud',
        name: 'Cloud',
        type: 'cowork',
        backend: 'cloud',
      }),
    ).toBe('cowork');
  });
});

describe('sidebar model', () => {
  it('places children from a projected web snapshot directly after their parent', () => {
    const projectedWebWorktrees: PortalSessionShellState['worktrees'] = [
      {
        localId: 'parent',
        workspaceLocalId: 'workspace',
        branch: 'parent',
        order: 1,
      },
      {
        localId: 'sibling',
        workspaceLocalId: 'workspace',
        branch: 'sibling',
        order: 2,
      },
      {
        localId: 'child',
        workspaceLocalId: 'workspace',
        branch: 'child',
        order: 3,
        branchGroupingParentWorktreeId: 'parent',
      },
    ];

    expect(
      orderWorktreesForSidebar(projectedWebWorktrees).map(
        ({ localId }) => localId,
      ),
    ).toEqual(['parent', 'child', 'sibling']);
  });

  it('keeps descendants in their own order under the top-most ancestor', () => {
    // Desktop parity: a grandchild groups under the root with the other
    // descendants and does not jump ahead of its parent's later sibling.
    const rows: PortalSessionShellState['worktrees'] = [
      { localId: 'base', workspaceLocalId: 'w', branch: 'base', order: 0 },
      {
        localId: 'child',
        workspaceLocalId: 'w',
        branch: 'child',
        order: 1,
        branchGroupingParentWorktreeId: 'base',
      },
      {
        localId: 'sibling',
        workspaceLocalId: 'w',
        branch: 'sibling',
        order: 2,
        branchGroupingParentWorktreeId: 'base',
      },
      {
        localId: 'grandchild',
        workspaceLocalId: 'w',
        branch: 'grandchild',
        order: 3,
        branchGroupingParentWorktreeId: 'child',
      },
    ];
    expect(
      orderWorktreesForSidebar(rows).map(({ localId }) => localId),
    ).toEqual(['base', 'child', 'sibling', 'grandchild']);
  });

  it('keeps each parent above its descendants when newer rows lead', () => {
    // Hosts insert new worktrees at the top of the manual order, so a chain
    // created in sequence arrives grandchild-first. Depth still wins inside a
    // group; rows at the same depth keep their own (newest-first) order.
    const rows: PortalSessionShellState['worktrees'] = [
      {
        localId: 'grandchild',
        workspaceLocalId: 'w',
        branch: 'grandchild',
        order: 0,
        branchGroupingParentWorktreeId: 'child',
      },
      {
        localId: 'sibling',
        workspaceLocalId: 'w',
        branch: 'sibling',
        order: 1,
        branchGroupingParentWorktreeId: 'base',
      },
      {
        localId: 'child',
        workspaceLocalId: 'w',
        branch: 'child',
        order: 2,
        branchGroupingParentWorktreeId: 'base',
      },
      { localId: 'base', workspaceLocalId: 'w', branch: 'base', order: 3 },
    ];
    expect(
      orderWorktreesForSidebar(rows).map(({ localId }) => localId),
    ).toEqual(['base', 'sibling', 'child', 'grandchild']);
  });

  it('uses the canonical visible ordering', () => {
    const state = snapshot();
    expect(firstVisibleWorkspaceId(state)).toBe('first');
    expect(visibleWorkspaceCount(state)).toBe(2);
  });

  it('derives stable project presentation', () => {
    const workspace = snapshot().workspaces[1];
    expect(workspaceKind(workspace)).toBe('multi-repo');
    expect(workspaceColor(workspace)).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it.each(['merged', 'closed'] as const)(
    'preserves a %s PR through the shared projection and focused row',
    (state) => {
      const badge = derivePrBadgeStatus(
        makePrSnapshot([
          {
            repoId: 'r',
            status: { state, title: 'Terminal preview', prNumber: 42 },
          },
        ]),
      );
      expect(badge).toMatchObject({
        state,
        title: 'Terminal preview',
        label: 'PR #42',
      });
      const html = renderToString(
        createElement(WorktreeRow, {
          branchLabel: 'Preview',
          uiStatus: 'done',
          statusModel: 'focused',
          textScale: 'sidebar',
          lastKnownPrStatus: badge,
        }),
      );
      expect(html).toContain(`data-testid="worktree-row-${state}"`);
    },
  );

  it('derives merged and open PR presentation', () => {
    const merged = makePrSnapshot([
      { repoId: 'r', status: { state: 'merged' } },
    ]);
    expect(hasAllKnownPrsMerged(merged)).toBe(true);
    const open = makePrSnapshot([
      {
        repoId: 'r',
        status: {
          state: 'open',
          prNumber: 42,
          title: 'Ship it',
          checkStatus: 'passing',
          reviewStatus: 'approved',
          hasConflicts: false,
        },
      },
    ]);
    expect(derivePrBadgeStatus(open)).toMatchObject({
      label: 'PR #42',
      isMergeReady: true,
    });
  });

  it('uses unresolved review threads rather than total comments for the PR badge', () => {
    const open = makePrSnapshot([
      {
        repoId: 'r',
        status: {
          state: 'open',
          prNumber: 42,
          title: 'Resolved feedback',
          checkStatus: 'passing',
          reviewStatus: 'approved',
          hasConflicts: false,
          commentCount: 1,
          unresolvedReviewThreadCount: 0,
        },
      },
    ]);

    expect(derivePrBadgeStatus(open)).toMatchObject({
      unresolvedCommentCount: 0,
    });
  });

  it('keeps pending in ciStatus while collapsing the compact check badge', () => {
    expect(
      derivePrBadgeStatus(
        makePrSnapshot([
          {
            repoId: 'r',
            status: {
              state: 'open',
              prNumber: 42,
              title: 'Pending',
              checkStatus: 'pending',
              hasConflicts: false,
            },
          },
        ]),
      ),
    ).toMatchObject({ checkStatus: 'none', ciStatus: 'pending' });
  });

  it('marks a queued PR as in the merge queue and not merge-ready', () => {
    const badge = derivePrBadgeStatus(
      makePrSnapshot([
        {
          repoId: 'r',
          status: {
            state: 'open',
            prNumber: 42,
            title: 'Queued',
            checkStatus: 'passing',
            reviewStatus: 'approved',
            hasConflicts: false,
            mergeQueue: { inQueue: true, position: 2 },
          },
        },
      ]),
    );
    expect(badge).toMatchObject({
      isMergeReady: false,
      inMergeQueue: true,
      mergeQueuePosition: 2,
    });
  });

  it('leaves the queue fields off an unqueued PR or a null position', () => {
    const status: Partial<PrStatus> = {
      state: 'open',
      prNumber: 42,
      title: 'Not queued',
      checkStatus: 'passing' as const,
      reviewStatus: 'approved' as const,
      hasConflicts: false,
    };
    const notQueued = derivePrBadgeStatus(
      makePrSnapshot([
        { repoId: 'r', status: { ...status, mergeQueue: { inQueue: false } } },
      ]),
    );
    expect(notQueued).toMatchObject({ isMergeReady: true });
    expect(notQueued).not.toHaveProperty('inMergeQueue');

    const unknownPosition = derivePrBadgeStatus(
      makePrSnapshot([
        {
          repoId: 'r',
          status: { ...status, mergeQueue: { inQueue: true, position: null } },
        },
      ]),
    );
    expect(unknownPosition).toMatchObject({ inMergeQueue: true });
    expect(unknownPosition).not.toHaveProperty('mergeQueuePosition');
  });

  it('marks a multi-repo row queued only when every open PR is queued', () => {
    type BadgeRepo = NonNullable<
      Parameters<typeof derivePrBadgeStatus>[0]
    >['repos'][number];
    const repo = (repoId: string, inQueue: boolean): BadgeRepo => ({
      repoId,
      repoName: repoId,
      status: {
        state: 'open' as const,
        prNumber: 1,
        prUrl: `https://github.com/example/${repoId}/pull/1`,
        title: repoId,
        checkStatus: 'passing' as const,
        reviewStatus: 'approved' as const,
        hasConflicts: false,
        commentCount: 0,
        updatedAt: '2026-10-06T00:00:00.000Z',
        mergeQueue: { inQueue, position: 1 },
      },
    });
    expect(
      derivePrBadgeStatus({
        repos: [repo('a', true), repo('b', true)],
        lastCheckedAt: '2026-10-06T00:00:00.000Z',
      }),
    ).toMatchObject({ inMergeQueue: true, label: '2 PRs' });
    const mixed = derivePrBadgeStatus({
      repos: [repo('a', true), repo('b', false)],
      lastCheckedAt: '2026-10-06T00:00:00.000Z',
    });
    expect(mixed).not.toHaveProperty('inMergeQueue');
    expect(mixed).not.toHaveProperty('mergeQueuePosition');
  });

  describe('merge queue phase', () => {
    type PrSnapshot = NonNullable<Parameters<typeof derivePrBadgeStatus>[0]>;
    type RepoStatus = NonNullable<PrSnapshot['repos'][number]['status']>;
    const prStatus = (overrides: Partial<RepoStatus> = {}): RepoStatus => ({
      state: 'open',
      prNumber: 42,
      prUrl: 'https://github.com/example/repo/pull/42',
      title: 'Queue me',
      checkStatus: 'passing',
      reviewStatus: 'approved',
      hasConflicts: false,
      commentCount: 0,
      updatedAt: '2026-10-06T00:00:00.000Z',
      ...overrides,
    });
    const single = (status: RepoStatus): PrSnapshot => ({
      repos: [{ repoId: 'r', repoName: 'r', status }],
      lastCheckedAt: '2026-10-06T00:00:00.000Z',
    });
    it('preserves requested review changes in multi-repo summaries', () => {
      const status = prStatus({ reviewStatus: 'changes_requested' });
      expect(
        derivePrBadgeStatus({
          repos: [
            { repoId: 'a', repoName: 'a', status: prStatus() },
            { repoId: 'b', repoName: 'b', status },
          ],
          lastCheckedAt: '2026-10-06T00:00:00.000Z',
        }),
      ).toMatchObject({
        reviewStatus: 'changes_requested',
        isMergeReady: false,
      });
    });

    const queueFields = (
      badge: ReturnType<typeof derivePrBadgeStatus>,
    ): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(badge ?? {}).filter(
          ([key]) =>
            key.startsWith('inMergeQueue') || key.startsWith('mergeQueue'),
        ),
      );

    it('maps the phase of a queued single-repo PR', () => {
      expect(
        derivePrBadgeStatus(
          single(
            prStatus({
              mergeQueue: { inQueue: true, position: 2, phase: 'locked' },
            }),
          ),
        ),
      ).toMatchObject({
        inMergeQueue: true,
        mergeQueuePosition: 2,
        mergeQueuePhase: 'locked',
      });
    });

    it('drops the phase when the PR is not queued', () => {
      expect(
        derivePrBadgeStatus(
          single(
            prStatus({
              mergeQueue: { inQueue: false, phase: 'awaiting_checks' },
            }),
          ),
        ),
      ).not.toHaveProperty('mergeQueuePhase');
    });

    it('never aggregates per-PR position or phase into a multi-repo row', () => {
      const badge = derivePrBadgeStatus({
        lastCheckedAt: '2026-10-06T00:00:00.000Z',
        repos: [
          {
            repoId: 'a',
            repoName: 'a',
            status: prStatus({
              mergeQueue: { inQueue: true, position: 1, phase: 'mergeable' },
            }),
          },
          {
            repoId: 'b',
            repoName: 'b',
            status: prStatus({
              mergeQueue: {
                inQueue: true,
                position: 4,
                phase: 'awaiting_checks',
              },
            }),
          },
        ],
      });
      expect(queueFields(badge)).toEqual({ inMergeQueue: true });
    });

    it('follows a PR through the queue lifecycle', () => {
      const sequence: Array<[string, PrSnapshot, Record<string, unknown>]> = [
        ['open, not queued', single(prStatus()), {}],
        [
          'queued, awaiting checks',
          single(
            prStatus({
              mergeQueue: {
                inQueue: true,
                position: 2,
                phase: 'awaiting_checks',
              },
            }),
          ),
          {
            inMergeQueue: true,
            mergeQueuePosition: 2,
            mergeQueuePhase: 'awaiting_checks',
          },
        ],
        [
          'queue checks passed',
          single(
            prStatus({
              mergeQueue: { inQueue: true, position: 1, phase: 'mergeable' },
            }),
          ),
          {
            inMergeQueue: true,
            mergeQueuePosition: 1,
            mergeQueuePhase: 'mergeable',
          },
        ],
        [
          'stale snapshot without phase or position',
          single(prStatus({ mergeQueue: { inQueue: true } })),
          { inMergeQueue: true },
        ],
        [
          'removed from the queue',
          single(prStatus({ mergeQueue: { inQueue: false } })),
          {},
        ],
        [
          're-enqueued',
          single(
            prStatus({
              mergeQueue: { inQueue: true, position: 3, phase: 'queued' },
            }),
          ),
          {
            inMergeQueue: true,
            mergeQueuePosition: 3,
            mergeQueuePhase: 'queued',
          },
        ],
        [
          'queue API unavailable',
          single(prStatus({ mergeQueue: undefined })),
          {},
        ],
      ];

      for (const [step, snapshot, expected] of sequence) {
        const badge = derivePrBadgeStatus(snapshot);
        expect({ step, queue: queueFields(badge) }).toEqual({
          step,
          queue: expected,
        });
        expect({ step, label: badge?.label }).toEqual({
          step,
          label: 'PR #42',
        });
      }

      // Removal leaves an ordinary, mergeable open badge.
      expect(
        derivePrBadgeStatus(
          single(prStatus({ mergeQueue: { inQueue: false } })),
        ),
      ).toMatchObject({ state: 'open', isMergeReady: true });

      // A merged PR keeps its terminal facts without a stale queue entry.
      const merged = single(
        prStatus({
          state: 'merged',
          mergeQueue: { inQueue: true, position: 1, phase: 'mergeable' },
        }),
      );
      expect(derivePrBadgeStatus(merged)).toMatchObject({
        state: 'merged',
        label: 'PR #42',
      });
      expect(derivePrBadgeStatus(merged)).not.toHaveProperty('inMergeQueue');
      expect(hasAllKnownPrsMerged(merged)).toBe(true);
    });
  });
});
