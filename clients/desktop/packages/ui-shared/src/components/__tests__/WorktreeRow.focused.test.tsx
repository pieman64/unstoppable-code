/**
 * The focused status model for sidebar rows (early access). The leading slot
 * holds one status: an orange dot when the row needs the user, a red dot for
 * an unseen failure, a loader while anything runs, a blue dot for unread, and
 * a grey dot otherwise. The trailing side is left to the age and the hover
 * actions. Housekeeping badges stay out of the row, and routine metadata is
 * plain.
 */
import { renderToString } from 'react-dom/server';
import {
  WorktreeRow,
  type WorktreeRowMergeQueuePhase,
  type WorktreeRowProps,
} from '../WorktreeRow';
import { SpinnerStyleProvider } from '../spinner-style';

function focused(props: Partial<WorktreeRowProps> = {}): string {
  return renderToString(
    <WorktreeRow
      branchLabel="feature/focus"
      branchName="feature/focus"
      worktreeId="dev-focus"
      uiStatus="idle"
      textScale="sidebar"
      statusModel="focused"
      {...props}
    />,
  );
}

function count(html: string, testId: string): number {
  return html.split(`data-testid="${testId}"`).length - 1;
}

/** The leading status's `data-row-status`, or null when absent. */
function leadingStatus(html: string): string | null {
  return /data-row-status="([a-z-]+)"/.exec(html)?.[1] ?? null;
}

describe('WorktreeRow focused status model', () => {
  it('shows a grey dot on an idle row', () => {
    expect(leadingStatus(focused())).toBe('idle');
    expect(focused()).toContain('bg-fg-quaternary/50');
  });

  it.each<[string, Partial<WorktreeRowProps>]>([
    ['question', { hasPendingQuestion: true }],
    ['tool approval', { hasPendingToolApproval: true }],
    ['plan review', { awaitingApproval: true }],
    ['paused pipeline', { pipelineStatus: 'paused' }],
    ['split review', { splitStatus: 'review' }],
  ])('shows the orange needs-you dot for a %s', (_name, props) => {
    const html = focused(props);
    expect(leadingStatus(html)).toBe('needs-input');
    expect(html).toContain('bg-fg-warning');
  });

  it('puts needs-you ahead of a running agent', () => {
    expect(
      leadingStatus(focused({ hasPendingQuestion: true, isStreaming: true })),
    ).toBe('needs-input');
  });

  it('shows a red dot for an unseen pipeline failure', () => {
    const html = focused({ pipelineStatus: 'unseen-failure' });
    expect(leadingStatus(html)).toBe('failed');
    expect(html).toContain('bg-fg-destructive');
  });

  it.each<[string, Partial<WorktreeRowProps>]>([
    ['streaming agent', { isStreaming: true }],
    ['working row', { uiStatus: 'working' }],
    ['running pipeline', { pipelineStatus: 'running' }],
    ['carving split', { splitStatus: 'active' }],
    ['running hook', { hookStatus: 'running' }],
    ['code graph build', { graphBuildStatus: 'building' }],
    ['PR being created', { isCreatingPr: true }],
    ['setup', { setupPhase: 'running-setup' }],
    ['teardown', { setupPhase: 'running-teardown' }],
  ])('shows the loader for a %s', (_name, props) => {
    expect(leadingStatus(focused(props))).toBe('working');
  });

  it('draws the loader in the Labs spinner style', () => {
    const dots = focused({ isStreaming: true });
    expect(dots).toContain('animate-thinking-dot');
    expect(dots).not.toContain('data-spinner="comet"');
    const comet = renderToString(
      <SpinnerStyleProvider value="comet">
        <WorktreeRow
          branchLabel="feature/focus"
          branchName="feature/focus"
          worktreeId="dev-focus"
          uiStatus="idle"
          textScale="sidebar"
          statusModel="focused"
          isStreaming
        />
      </SpinnerStyleProvider>,
    );
    expect(comet).toContain('data-spinner="comet"');
    expect(comet).toContain('width:12px');
    expect(comet).not.toContain('animate-thinking-dot');
  });

  it('puts a running agent ahead of unread', () => {
    expect(leadingStatus(focused({ isStreaming: true, hasUnread: true }))).toBe(
      'working',
    );
  });

  it('shows a blue dot for unread and an unseen pipeline success', () => {
    expect(leadingStatus(focused({ hasUnread: true }))).toBe('unread');
    expect(leadingStatus(focused({ pipelineStatus: 'unseen' }))).toBe('unread');
  });

  it('leaves the trailing side free of status', () => {
    const html = focused({
      isStreaming: true,
      hasUnread: true,
      hasPendingQuestion: true,
    });
    expect(count(html, 'worktree-row-classic-streaming-spinner')).toBe(0);
    expect(count(html, 'worktree-row-unread')).toBe(0);
    expect(count(html, 'worktree-row-question')).toBe(0);
  });

  it('keeps housekeeping badges out of the row', () => {
    const html = focused({
      terminalStatus: 'unseen-failure',
      scriptStatus: 'running',
      hookStatus: 'running',
      graphBuildStatus: 'building',
      hasIdleWatcherChats: true,
      hasScheduledMessages: true,
      isDiscovering: true,
    });
    for (const testId of [
      'worktree-row-terminal-badge',
      'worktree-row-script-badge',
      'worktree-row-hook-badge',
      'worktree-row-graph-badge',
      'worktree-row-watchers',
      'worktree-row-scheduled-messages',
    ]) {
      expect(count(html, testId)).toBe(0);
    }
    expect(html).not.toContain('Discovering environment');
  });

  it.each([
    [undefined, undefined],
    [{ state: 'open' }, 'worktree-row-open-pr'],
    [{ state: 'draft' }, 'worktree-row-draft'],
    [{ state: 'open', hasConflicts: true }, 'worktree-row-conflicts'],
    [{ state: 'open', inMergeQueue: true }, 'worktree-row-merge-queue'],
  ] satisfies [WorktreeRowProps['lastKnownPrStatus'], string | undefined][])(
    'keeps Done distinct from the PR state %j',
    (lastKnownPrStatus, expectedIndicator) => {
      const html = focused({
        uiStatus: 'done',
        runtimeState: 'done',
        lastKnownPrStatus,
      });
      expect(leadingStatus(html)).toBe('idle');
      expect(count(html, 'worktree-row-merged')).toBe(0);
      if (expectedIndicator) expect(count(html, expectedIndicator)).toBe(1);
      expect(html).not.toContain('>Done<');
    },
  );

  it.each([
    {
      state: 'open',
      checkStatus: 'passing',
      reviewStatus: 'changes_requested',
    },
    { state: 'open', checkStatus: 'passing', ciStatus: 'failing' },
    { state: 'open', checkStatus: 'passing', ciStatus: 'pending' },
    { state: 'draft', checkStatus: 'passing' },
  ] satisfies WorktreeRowProps['lastKnownPrStatus'][])(
    'does not show PR success for a blocked or draft PR %j',
    (lastKnownPrStatus) => {
      const html = focused({ lastKnownPrStatus });
      expect(count(html, 'worktree-row-checks-passing')).toBe(0);
      if (lastKnownPrStatus.state === 'open') {
        expect(count(html, 'worktree-row-open-pr')).toBe(1);
        if (lastKnownPrStatus.ciStatus !== 'pending') {
          expect(
            /<span[^>]*data-testid="worktree-row-open-pr"[^>]*>/.exec(
              html,
            )?.[0],
          ).toContain('fg-destructive');
        }
      }
    },
  );

  it.each([
    { state: 'open', checkStatus: 'failing', ciStatus: 'passing' },
    { state: 'open', reviewStatus: 'approved' },
    { state: 'open', isMergeReady: true },
  ] satisfies WorktreeRowProps['lastKnownPrStatus'][])(
    'matches the tooltip success indicator for %j',
    (lastKnownPrStatus) => {
      expect(
        count(focused({ lastKnownPrStatus }), 'worktree-row-checks-passing'),
      ).toBe(1);
    },
  );

  it.each([
    [
      'Approved',
      { state: 'open', checkStatus: 'none', reviewStatus: 'approved' },
    ],
    [
      'Ready to merge',
      { state: 'open', checkStatus: 'none', isMergeReady: true },
    ],
    ['Checks passing', { state: 'open', checkStatus: 'passing' }],
  ] satisfies [string, WorktreeRowProps['lastKnownPrStatus']][])(
    'announces the actual reason for PR success: %s',
    (label, lastKnownPrStatus) => {
      const html = focused({ lastKnownPrStatus });
      const glyph =
        /<span[^>]*data-testid="worktree-row-checks-passing"[^>]*>/.exec(
          html,
        )?.[0];
      expect(glyph).toContain(`aria-label="${label}"`);
    },
  );

  it('shows the merged icon for a merged PR, before the age', () => {
    const html = focused({
      lastKnownPrStatus: { state: 'merged', label: 'PR #9' },
      lastActivityAt: Date.now() - 3_600_000,
    });
    expect(count(html, 'worktree-row-merged')).toBe(1);
    expect(html.indexOf('worktree-row-merged')).toBeLessThan(
      html.indexOf('worktree-row-age'),
    );
  });

  it.each([false, true])(
    'shows the closed PR glyph before the age (done=%s)',
    (done) => {
      const html = focused({
        uiStatus: done ? 'done' : 'idle',
        lastKnownPrStatus: {
          state: 'closed',
          label: 'PR #9',
          checkStatus: 'passing',
        },
        lastActivityAt: Date.now() - 60_000,
      });
      const marker = /<span[^>]*data-testid="worktree-row-closed"[^>]*>/.exec(
        html,
      )?.[0];
      expect(marker).toContain('fg-destructive');
      expect(marker).toContain('h-4 w-4');
      expect(marker).toContain('aria-label="Closed pull request"');
      expect(count(html, 'worktree-row-closed')).toBe(1);
      expect(count(html, 'worktree-row-merged')).toBe(0);
      expect(count(html, 'worktree-row-checks-passing')).toBe(0);
      expect(html.indexOf('worktree-row-closed')).toBeLessThan(
        html.indexOf('worktree-row-age'),
      );
    },
  );

  it('shows an open PR in the standard trailing slot before the age', () => {
    const html = focused({
      lastKnownPrStatus: { state: 'open', label: 'PR #9' },
      lastActivityAt: Date.now() - 60_000,
    });
    const marker = /<span[^>]*data-testid="worktree-row-open-pr"[^>]*>/.exec(
      html,
    )?.[0];
    expect(marker).toContain('fg-quaternary');
    expect(marker).toContain('h-4 w-4');
    expect(marker).toContain('aria-label="Open pull request"');
    expect(html.indexOf('worktree-row-open-pr')).toBeLessThan(
      html.indexOf('worktree-row-age'),
    );
    expect(html).toContain('data-glyph="git-pull-request"');
  });

  it.each([
    { state: 'draft' },
    { state: 'merged' },
    { state: 'closed' },
    { state: 'open', hasConflicts: true },
    { state: 'open', inMergeQueue: true },
    { state: 'open', checkStatus: 'passing' },
  ] satisfies WorktreeRowProps['lastKnownPrStatus'][])(
    'keeps the specific PR indicator instead of a generic open icon for %j',
    (lastKnownPrStatus) => {
      expect(
        count(focused({ lastKnownPrStatus }), 'worktree-row-open-pr'),
      ).toBe(0);
    },
  );

  it('shows the draft icon for a draft PR, before the age', () => {
    const html = focused({
      lastKnownPrStatus: { state: 'draft', label: 'PR #7' },
      lastActivityAt: Date.now() - 60_000,
    });
    expect(count(html, 'worktree-row-draft')).toBe(1);
    expect(count(html, 'worktree-row-merged')).toBe(0);
    expect(html.indexOf('worktree-row-draft')).toBeLessThan(
      html.indexOf('worktree-row-age'),
    );
    expect(
      count(
        focused({ lastKnownPrStatus: { state: 'open', label: 'PR #8' } }),
        'worktree-row-draft',
      ),
    ).toBe(0);
  });

  it('draws the branch-style glyphs a step smaller than the check, in the same slot', () => {
    const glyph = (html: string, testId: string): string =>
      new RegExp(`<span[^>]*data-testid="${testId}"[^>]*>\\s*<svg[^>]*>`).exec(
        html,
      )?.[0] ?? '';
    const merged = glyph(
      focused({ lastKnownPrStatus: { state: 'merged', label: 'PR #9' } }),
      'worktree-row-merged',
    );
    const draft = glyph(
      focused({ lastKnownPrStatus: { state: 'draft', label: 'PR #7' } }),
      'worktree-row-draft',
    );
    for (const html of [merged, draft]) {
      expect(html).toContain('h-4 w-4');
      expect(html).toMatch(/width:\s?14px/);
      expect(html).toMatch(/height:\s?14px/);
    }
  });

  it('uses the same centered trailing slot for check and pin icons', () => {
    const html = focused({
      pinnedToTop: true,
      lastKnownPrStatus: { state: 'open', checkStatus: 'passing' },
    });
    for (const id of ['checks-passing', 'pinned']) {
      const marker = new RegExp(
        `<span[^>]*data-testid="worktree-row-${id}"[^>]*>`,
      ).exec(html)?.[0];
      expect(marker).toContain('h-4 w-4');
      expect(marker).toContain('items-center justify-center box-content');
    }
  });

  it('shows a green check when CI checks pass, before the age', () => {
    const html = focused({
      lastKnownPrStatus: {
        state: 'open',
        label: 'PR #3',
        checkStatus: 'passing',
      },
      lastActivityAt: Date.now() - 60_000,
    });
    const check =
      /<span[^>]*data-testid="worktree-row-checks-passing"[^>]*>/.exec(
        html,
      )?.[0];
    expect(check).toContain('fg-success');
    expect(html.indexOf('worktree-row-checks-passing')).toBeLessThan(
      html.indexOf('worktree-row-age'),
    );
    for (const checkStatus of ['failing', 'pending'] as const) {
      expect(
        count(
          focused({
            lastKnownPrStatus: { state: 'open', label: 'PR #3', checkStatus },
          }),
          'worktree-row-checks-passing',
        ),
      ).toBe(0);
    }
    expect(
      count(
        focused({
          lastKnownPrStatus: {
            state: 'merged',
            label: 'PR #3',
            checkStatus: 'passing',
          },
        }),
        'worktree-row-checks-passing',
      ),
    ).toBe(0);
  });

  it.each([false, true])(
    'shows conflicts in the trailing icon slot (queued=%s)',
    (inMergeQueue) => {
      const html = focused({
        lastKnownPrStatus: {
          state: 'open',
          hasConflicts: true,
          checkStatus: 'passing',
          inMergeQueue,
        },
        lastActivityAt: Date.now() - 60_000,
      });
      const marker =
        /<span[^>]*data-testid="worktree-row-conflicts"[^>]*>/.exec(html)?.[0];
      expect(marker).toContain('fg-destructive');
      expect(marker).toContain('h-4 w-4');
      expect(marker).toContain('aria-label="Merge conflicts"');
      expect(html.indexOf('worktree-row-conflicts')).toBeLessThan(
        html.indexOf('worktree-row-age'),
      );
      expect(count(html, 'worktree-row-merge-queue')).toBe(0);
      expect(count(html, 'worktree-row-checks-passing')).toBe(0);
    },
  );

  describe('merge queue', () => {
    function queueMarker(html: string): string | undefined {
      return /<span[^>]*data-testid="worktree-row-merge-queue"[^>]*>/.exec(
        html,
      )?.[0];
    }

    it('shows a pending queue glyph instead of the green check, before the age', () => {
      const html = focused({
        lastKnownPrStatus: {
          state: 'open',
          label: 'PR #3',
          checkStatus: 'passing',
          reviewStatus: 'approved',
          isMergeReady: true,
          inMergeQueue: true,
          mergeQueuePosition: 2,
        },
        lastActivityAt: Date.now() - 60_000,
      });
      const marker = queueMarker(html);
      expect(marker).toContain('fg-warning');
      expect(marker).toContain('h-4 w-4');
      expect(marker).toContain('items-center justify-center box-content');
      const queueGlyph =
        /data-testid="worktree-row-merge-queue"[^>]*>(<svg[^>]*>)/.exec(
          html,
        )?.[1];
      expect(queueGlyph).toMatch(/width:\s?14px/);
      expect(queueGlyph).toMatch(/height:\s?14px/);
      expect(marker).toContain('aria-label="In merge queue, position 2"');
      expect(count(html, 'worktree-row-checks-passing')).toBe(0);
      expect(html).not.toContain('Checks passing');
      expect(html.indexOf('worktree-row-merge-queue')).toBeLessThan(
        html.indexOf('worktree-row-age'),
      );
    });

    it('reads as queued without a known position or phase', () => {
      const marker = queueMarker(
        focused({
          lastKnownPrStatus: {
            state: 'open',
            label: 'PR #3',
            checkStatus: 'passing',
            inMergeQueue: true,
          },
        }),
      );
      expect(marker).toContain('aria-label="In merge queue"');
      expect(
        queueMarker(
          focused({
            lastKnownPrStatus: {
              state: 'open',
              label: 'PR #3',
              inMergeQueue: true,
              mergeQueuePhase: 'unknown',
            },
          }),
        ),
      ).toContain('aria-label="In merge queue"');
    });

    it.each<[WorktreeRowMergeQueuePhase, string]>([
      ['queued', 'In merge queue, position 2. Waiting in queue'],
      ['awaiting_checks', 'In merge queue, position 2. Awaiting queue checks'],
      ['mergeable', 'In merge queue, position 2. Queue checks passed'],
      ['locked', 'In merge queue, position 2. Locked for merge'],
      [
        'unmergeable',
        'In merge queue, position 2. Can&#x27;t merge from queue',
      ],
    ])(
      'names the known %s phase for keyboard and screen readers',
      (mergeQueuePhase, name) => {
        const marker = queueMarker(
          focused({
            lastKnownPrStatus: {
              state: 'open',
              label: 'PR #3',
              inMergeQueue: true,
              mergeQueuePosition: 2,
              mergeQueuePhase,
            },
          }),
        );
        expect(marker).toContain(`aria-label="${name}"`);
      },
    );

    it.each(['passing', 'pending', 'failing', 'none'] as const)(
      'stays queued with %s PR checks',
      (checkStatus) => {
        const html = focused({
          lastKnownPrStatus: {
            state: 'open',
            label: 'PR #3',
            checkStatus,
            inMergeQueue: true,
          },
        });
        expect(count(html, 'worktree-row-merge-queue')).toBe(1);
        expect(count(html, 'worktree-row-checks-passing')).toBe(0);
      },
    );

    it.each(['mergeable', 'locked'] as const)(
      'does not read a %s queue phase as merged',
      (mergeQueuePhase) => {
        const html = focused({
          lastKnownPrStatus: {
            state: 'open',
            label: 'PR #3',
            checkStatus: 'passing',
            inMergeQueue: true,
            mergeQueuePhase,
          },
        });
        expect(count(html, 'worktree-row-merge-queue')).toBe(1);
        expect(count(html, 'worktree-row-merged')).toBe(0);
      },
    );

    it('lets conflicts outrank the queue without a green check', () => {
      const html = focused({
        lastKnownPrStatus: {
          state: 'open',
          label: 'PR #3',
          checkStatus: 'passing',
          hasConflicts: true,
          inMergeQueue: true,
        },
      });
      expect(count(html, 'worktree-row-merge-queue')).toBe(0);
      expect(count(html, 'worktree-row-checks-passing')).toBe(0);
    });

    it('returns to the green check once the PR leaves the queue', () => {
      const html = focused({
        lastKnownPrStatus: {
          state: 'open',
          label: 'PR #3',
          checkStatus: 'passing',
          inMergeQueue: false,
        },
      });
      expect(count(html, 'worktree-row-merge-queue')).toBe(0);
      expect(count(html, 'worktree-row-checks-passing')).toBe(1);
    });

    it('drops stale queue flags on terminal and draft PRs but preserves a queued Done worktree', () => {
      const queued = {
        label: 'PR #3',
        checkStatus: 'passing',
        inMergeQueue: true,
        mergeQueuePosition: 1,
      } as const;
      const merged = focused({
        lastKnownPrStatus: { ...queued, state: 'merged' },
      });
      expect(count(merged, 'worktree-row-merge-queue')).toBe(0);
      expect(count(merged, 'worktree-row-merged')).toBe(1);
      const done = focused({
        uiStatus: 'done',
        runtimeState: 'done',
        lastKnownPrStatus: { ...queued, state: 'open' },
      });
      expect(count(done, 'worktree-row-merge-queue')).toBe(1);
      expect(count(done, 'worktree-row-merged')).toBe(0);
      const draft = focused({
        lastKnownPrStatus: { ...queued, state: 'draft' },
      });
      expect(count(draft, 'worktree-row-merge-queue')).toBe(0);
      expect(count(draft, 'worktree-row-draft')).toBe(1);
      const closed = focused({
        lastKnownPrStatus: { ...queued, state: 'closed' },
      });
      expect(count(closed, 'worktree-row-merge-queue')).toBe(0);
    });

    it('hides with the age while the hover actions show', () => {
      const html = focused({
        lastKnownPrStatus: {
          state: 'open',
          label: 'PR #3',
          inMergeQueue: true,
        },
        actionChipSlot: <span />,
      });
      const meta =
        /<span[^>]*data-testid="worktree-row-trailing-meta"[^>]*>/.exec(
          html,
        )?.[0];
      expect(meta).toContain('group-hover/sidebar-item:hidden');
      expect(count(html, 'worktree-row-merge-queue')).toBe(1);
    });
  });

  it('shows the pin icon for a pinned row, before the age', () => {
    const html = focused({
      pinnedToTop: true,
      lastActivityAt: Date.now() - 60_000,
    });
    expect(count(html, 'worktree-row-pinned')).toBe(1);
    expect(html.indexOf('worktree-row-pinned')).toBeLessThan(
      html.indexOf('worktree-row-age'),
    );
    expect(count(focused(), 'worktree-row-pinned')).toBe(0);
  });

  it('hides the pin and merged icons with the age on hover', () => {
    const html = focused({
      pinnedToTop: true,
      runtimeState: 'done',
      actionChipSlot: <span />,
    });
    const meta =
      /<span[^>]*data-testid="worktree-row-trailing-meta"[^>]*>/.exec(
        html,
      )?.[0];
    expect(meta).toContain('group-hover/sidebar-item:hidden');
  });

  it('drops the PR label, depth, shared and run indicators', () => {
    const html = focused({
      lastKnownPrStatus: {
        state: 'open',
        label: 'PR #2',
        checkStatus: 'failing',
      },
      diffStats: { insertions: 12, deletions: 4 },
      sharedWithTeammates: true,
      nestedChildDepth: 1,
      depthBadge: {
        depth: 2,
        topMost: { branchName: 'main', animalName: 'dev-owl' },
      },
      runStatusSlot: <span data-testid="host-run-status" />,
    });
    for (const testId of [
      'worktree-row-pr-badge',
      'worktree-row-shared-badge',
      'worktree-row-nested-child-depth',
      'host-run-status',
    ]) {
      expect(count(html, testId)).toBe(0);
    }
  });

  it('shows the diff stats right after the worktree name', () => {
    const html = focused({ diffStats: { insertions: 12, deletions: 4 } });
    expect(count(html, 'worktree-row-subtitle-diff')).toBe(1);
    expect(count(html, 'diff-stats-badge')).toBe(1);
    const nameAt = html.indexOf('dev-focus');
    const diffAt = html.indexOf('data-testid="worktree-row-subtitle-diff"');
    expect(nameAt).toBeGreaterThan(-1);
    expect(diffAt).toBeGreaterThan(nameAt);
    const text = html.replace(/<!-- -->/g, '');
    expect(text).toContain('+12');
    expect(text).toContain('-4');
    expect(count(html, 'worktree-row-trailing-diff')).toBe(0);
  });

  it('omits the diff stats without changes or once done', () => {
    expect(
      count(
        focused({ diffStats: { insertions: 0, deletions: 0 } }),
        'diff-stats-badge',
      ),
    ).toBe(0);
    expect(
      count(
        focused({
          diffStats: { insertions: 3, deletions: 1 },
          runtimeState: 'done',
        }),
        'diff-stats-badge',
      ),
    ).toBe(0);
  });

  it('keeps the broken-worktree warning', () => {
    const html = focused({
      healthIssue: { status: 'broken', reason: 'Checkout missing' },
    });
    expect(html).toContain('Worktree issue - click for details');
  });

  it('leaves the classic model unchanged by default', () => {
    const html = renderToString(
      <WorktreeRow
        branchLabel="feature/classic"
        branchName="feature/classic"
        uiStatus="idle"
        textScale="sidebar"
        hasPendingQuestion
        terminalStatus="running"
      />,
    );
    expect(count(html, 'worktree-row-question-glyph')).toBe(1);
    expect(count(html, 'worktree-row-question')).toBe(1);
    expect(count(html, 'worktree-row-terminal-badge')).toBe(1);
    expect(leadingStatus(html)).toBeNull();
  });
});
