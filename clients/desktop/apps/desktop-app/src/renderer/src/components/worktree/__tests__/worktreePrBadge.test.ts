import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { WorktreeRow } from '@canopy/ui-shared/components';
import type {
  PrMergeQueuePhase,
  PrStatusData,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import {
  deriveDesktopPrBadgeStatus,
  mergeQueueBadgeFields,
} from '../worktreePrBadge';

function prStatus(overrides: Partial<PrStatusData> = {}): PrStatusData {
  return {
    prNumber: 42,
    prUrl: 'https://github.com/example/repo/pull/42',
    state: 'open',
    title: 'Queue me',
    checkStatus: 'passing',
    checkDetails: [],
    reviewStatus: 'approved',
    reviewers: [],
    hasConflicts: false,
    commentCount: 0,
    unresolvedReviewThreadCount: 0,
    updatedAt: '2026-10-06T00:00:00.000Z',
    ...overrides,
  };
}

function worktreeStatus(statuses: PrStatusData[]): WorktreePrStatus {
  return {
    repos: statuses.map((status, index) => ({
      repoId: `repo-${index}`,
      repoName: `repo-${index}`,
      status,
    })),
    lastCheckedAt: '2026-10-06T00:00:00.000Z',
  };
}

describe('mergeQueueBadgeFields', () => {
  it('returns the queued flag and position for a queued open PR', () => {
    expect(
      mergeQueueBadgeFields({
        state: 'open',
        mergeQueue: { required: true, inQueue: true, position: 4 },
      }),
    ).toEqual({ inMergeQueue: true, mergeQueuePosition: 4 });
  });

  it('drops an unknown position', () => {
    expect(
      mergeQueueBadgeFields({
        state: 'open',
        mergeQueue: { required: true, inQueue: true, position: null },
      }),
    ).toEqual({ inMergeQueue: true });
  });

  it.each<PrMergeQueuePhase>([
    'queued',
    'awaiting_checks',
    'mergeable',
    'locked',
    'unmergeable',
    'unknown',
  ])('passes the %s phase through for a queued PR', (phase) => {
    expect(
      mergeQueueBadgeFields({
        state: 'open',
        mergeQueue: { required: true, inQueue: true, position: 2, phase },
      }),
    ).toEqual({
      inMergeQueue: true,
      mergeQueuePosition: 2,
      mergeQueuePhase: phase,
    });
  });

  it('drops the phase when the PR is not queued', () => {
    expect(
      mergeQueueBadgeFields({
        state: 'open',
        mergeQueue: { required: true, inQueue: false, phase: 'queued' },
      }),
    ).toEqual({});
  });

  it('is empty when the PR is not queued, closed, or the state is unknown', () => {
    expect(
      mergeQueueBadgeFields({
        state: 'open',
        mergeQueue: { required: true, inQueue: false },
      }),
    ).toEqual({});
    expect(
      mergeQueueBadgeFields({
        state: 'closed',
        mergeQueue: { required: true, inQueue: true },
      }),
    ).toEqual({});
    expect(mergeQueueBadgeFields({ state: 'open' })).toEqual({});
  });
});

describe('deriveDesktopPrBadgeStatus merge queue', () => {
  it.each(['merged', 'closed'] as const)(
    'preserves a %s PR through desktop projection and row rendering',
    (state) => {
      const badge = deriveDesktopPrBadgeStatus(
        worktreeStatus([prStatus({ state })]),
        false,
      );
      expect(badge).toMatchObject({
        state,
        title: 'Queue me',
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
  it('keeps a mixed terminal multi-repo summary closed rather than claiming every PR merged', () => {
    expect(
      deriveDesktopPrBadgeStatus(
        worktreeStatus([
          prStatus({ state: 'merged' }),
          prStatus({ state: 'closed' }),
        ]),
        true,
      ),
    ).toMatchObject({ state: 'closed', label: '2 PRs' });
  });

  it('preserves requested review changes in multi-repo summaries', () => {
    expect(
      deriveDesktopPrBadgeStatus(
        worktreeStatus([
          prStatus(),
          prStatus({ reviewStatus: 'changes_requested' }),
        ]),
        true,
      ),
    ).toMatchObject({ reviewStatus: 'changes_requested', isMergeReady: false });
  });

  it('marks a queued single-repo PR as queued and not merge-ready', () => {
    expect(
      deriveDesktopPrBadgeStatus(
        worktreeStatus([
          prStatus({
            mergeableState: 'blocked',
            mergeQueue: { required: true, inQueue: true, position: 1 },
          }),
        ]),
        false,
      ),
    ).toMatchObject({
      isMergeReady: false,
      inMergeQueue: true,
      mergeQueuePosition: 1,
    });
  });

  it('marks a multi-repo row queued only when every open PR is queued', () => {
    const queued = prStatus({
      mergeQueue: { required: true, inQueue: true, position: 1 },
    });
    const notQueued = prStatus({
      mergeQueue: { required: true, inQueue: false },
    });
    expect(
      deriveDesktopPrBadgeStatus(worktreeStatus([queued, queued]), true),
    ).toMatchObject({ inMergeQueue: true, label: '2 PRs' });
    expect(
      deriveDesktopPrBadgeStatus(worktreeStatus([queued, notQueued]), true),
    ).not.toHaveProperty('inMergeQueue');
  });

  it('never aggregates per-PR position or phase into a multi-repo row', () => {
    const badge = deriveDesktopPrBadgeStatus(
      worktreeStatus([
        prStatus({
          mergeQueue: {
            required: true,
            inQueue: true,
            position: 1,
            phase: 'mergeable',
          },
        }),
        prStatus({
          mergeQueue: {
            required: true,
            inQueue: true,
            position: 4,
            phase: 'awaiting_checks',
          },
        }),
      ]),
      true,
    );
    expect(badge).toMatchObject({ inMergeQueue: true, label: '2 PRs' });
    expect(badge).not.toHaveProperty('mergeQueuePosition');
    expect(badge).not.toHaveProperty('mergeQueuePhase');
  });

  it('follows a PR through the queue lifecycle', () => {
    const queueFields = (
      badge: ReturnType<typeof deriveDesktopPrBadgeStatus>,
    ): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(badge ?? {}).filter(
          ([key]) => key === 'inMergeQueue' || key.startsWith('mergeQueue'),
        ),
      );
    const sequence: Array<[string, PrStatusData, Record<string, unknown>]> = [
      [
        'open, not queued',
        prStatus({ mergeQueue: { required: true, inQueue: false } }),
        {},
      ],
      [
        'queued, awaiting checks',
        prStatus({
          mergeQueue: {
            required: true,
            inQueue: true,
            position: 2,
            phase: 'awaiting_checks',
          },
        }),
        {
          inMergeQueue: true,
          mergeQueuePosition: 2,
          mergeQueuePhase: 'awaiting_checks',
        },
      ],
      [
        'queue checks passed',
        prStatus({
          mergeQueue: {
            required: true,
            inQueue: true,
            position: 1,
            phase: 'mergeable',
          },
        }),
        {
          inMergeQueue: true,
          mergeQueuePosition: 1,
          mergeQueuePhase: 'mergeable',
        },
      ],
      [
        'stale snapshot without phase or position',
        prStatus({ mergeQueue: { required: true, inQueue: true } }),
        { inMergeQueue: true },
      ],
      [
        'removed from the queue',
        prStatus({ mergeQueue: { required: true, inQueue: false } }),
        {},
      ],
      [
        're-enqueued',
        prStatus({
          mergeQueue: {
            required: true,
            inQueue: true,
            position: 3,
            phase: 'queued',
          },
        }),
        {
          inMergeQueue: true,
          mergeQueuePosition: 3,
          mergeQueuePhase: 'queued',
        },
      ],
      ['queue API unavailable', prStatus({ mergeQueue: undefined }), {}],
    ];

    for (const [step, status, expected] of sequence) {
      const badge = deriveDesktopPrBadgeStatus(worktreeStatus([status]), false);
      expect({ step, queue: queueFields(badge) }).toEqual({
        step,
        queue: expected,
      });
      expect({ step, label: badge?.label }).toEqual({ step, label: 'PR #42' });
    }

    // Removal leaves an ordinary open badge.
    expect(
      deriveDesktopPrBadgeStatus(
        worktreeStatus([
          prStatus({ mergeQueue: { required: true, inQueue: false } }),
        ]),
        false,
      ),
    ).toMatchObject({ state: 'open', reviewStatus: 'approved' });

    // Merged facts survive without carrying stale queue fields.
    expect(
      deriveDesktopPrBadgeStatus(
        worktreeStatus([
          prStatus({
            state: 'merged',
            mergeQueue: {
              required: true,
              inQueue: true,
              position: 1,
              phase: 'mergeable',
            },
          }),
        ]),
        false,
      ),
    ).toMatchObject({ state: 'merged', label: 'PR #42' });
  });
});
