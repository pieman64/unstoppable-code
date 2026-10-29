/** @jest-environment jsdom */

/**
 * The worktree row's hover preview card: after a short hover it shows the
 * row's full title, age, project, branch with its base, and pull
 * request, which the truncated row cannot. The pointer can rest on it to copy.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';
import {
  WorktreeRow,
  WorktreeRowActionChip,
  type WorktreeRowProps,
} from '../WorktreeRow';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const HOUR = 3_600_000;
const PREVIEW_DELAY_MS = 500;

describe('WorktreeRow hover preview', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.UTC(2026, 9, 6, 12, 0, 0) });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    jest.useRealTimers();
  });

  function renderRow(props: Partial<WorktreeRowProps> = {}): HTMLElement {
    act(() =>
      root.render(
        <WorktreeRow
          branchLabel="Set PR issue follow-up automation"
          branchName="dzzzgnr/pr-follow-up"
          worktreeId="tdh7"
          uiStatus="idle"
          textScale="sidebar"
          dataTestId="worktree-row"
          {...props}
        />,
      ),
    );
    const row = container.querySelector<HTMLElement>(
      '[data-testid="worktree-row"]',
    );
    if (!row) throw new Error('row not rendered');
    return row;
  }

  function hover(target: Element): void {
    act(() => {
      target.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
  }

  function preview(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>(
      '[data-testid="worktree-row-preview"]',
    );
  }

  it('opens after a short hover with the row details', () => {
    const row = renderRow({
      hoverPreview: {
        projectName: 'Canopy',
        projectIcon: <span data-testid="project-glyph" />,
        baseBranch: 'develop',
      },
      lastActivityAt: Date.now() - 26 * HOUR,
      hasUnread: true,
      lastKnownPrStatus: {
        state: 'open',
        label: 'PR #4229',
        title: 'Restore UI whitespace',
      },
    });

    hover(row);
    expect(preview()).toBeNull();
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));

    const card = preview();
    expect(card?.textContent).toContain('Set PR issue follow-up automation');
    expect(card?.textContent).toContain('1d');
    expect(card?.textContent).toContain('Canopy');
    // A divider sets the title apart from the detail lines under it.
    const divider = card?.querySelector(
      '[data-testid="worktree-row-preview-divider"]',
    );
    expect(divider?.nextElementSibling?.getAttribute('data-testid')).toBe(
      'worktree-row-preview-project',
    );
    expect(divider?.previousElementSibling?.textContent).toContain(
      'Set PR issue follow-up automation',
    );
    // The project line carries the project's own glyph, not a folder.
    expect(
      card?.querySelector(
        '[data-testid="worktree-row-preview-project"] [data-testid="project-glyph"]',
      ),
    ).not.toBeNull();
    // The branch line names the branch, not the worktree's generated name;
    // the branch it was created from is its own line.
    const branch = card?.querySelector(
      '[data-testid="worktree-row-preview-branch"]',
    );
    expect(branch?.textContent).toContain('dzzzgnr/pr-follow-up');
    expect(branch?.textContent).not.toContain('develop');
    expect(
      card?.querySelector('[data-testid="worktree-row-preview-base"]')
        ?.textContent,
    ).toBe('from develop');
    expect(card?.textContent).not.toContain('tdh7');
    expect(card?.textContent).toContain('Restore UI whitespace');
    expect(
      card?.querySelector('[data-testid="worktree-row-preview-unread"]'),
    ).toBeNull();
  });

  it.each<[Partial<WorktreeRowProps>, string, string]>([
    [{ hasPendingQuestion: true }, 'question', 'fg-warning'],
    [{ hasPendingToolApproval: true }, 'approval', 'fg-warning'],
    [{ awaitingApproval: true, statusModel: 'focused' }, 'plan', 'fg-warning'],
    [{ awaitingApproval: true, statusModel: 'classic' }, 'plan', 'fg-blue'],
    [{ uiStatus: 'planning' }, 'planning', 'fg-warning'],
    [{ hasIdleWatcherChats: true }, 'watchers', 'fg-blue'],
    [{ hasScheduledMessages: true }, 'scheduled', 'fg-blue'],
    [
      { pipelineStatus: 'paused', statusModel: 'focused' },
      'pipeline',
      'fg-warning',
    ],
    [
      { pipelineStatus: 'unseen', statusModel: 'focused' },
      'pipeline',
      'fg-blue',
    ],
    [
      { pipelineStatus: 'unseen-failure', statusModel: 'focused' },
      'pipeline',
      'fg-destructive-strong',
    ],
    [{ pipelineStatus: 'unseen' }, 'pipeline', 'fg-success'],
    [{ pipelineStatus: 'unseen-failure' }, 'pipeline', 'fg-destructive'],
    [{ splitStatus: 'review' }, 'split', 'fg-warning'],
    [{ uiStatus: 'done' }, 'done', 'fg-purple'],
  ])('keeps the %s preview icon on its sidebar color', (props, id, color) => {
    hover(renderRow({ ...props, hoverPreview: {} }));
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    const line = preview()?.querySelector(
      `[data-testid="worktree-row-preview-status-${id}"]`,
    );
    // The shared icon slot holds the icon in its colored span.
    const slot = line?.firstElementChild;
    expect(slot?.classList.contains('w-4')).toBe(true);
    expect(slot?.firstElementChild?.classList.contains(color)).toBe(true);
    expect(
      line?.lastElementChild?.firstElementChild?.classList.contains(
        'fg-secondary',
      ),
    ).toBe(true);
  });

  it('uses one fixed preview card width for short and long previews', () => {
    for (const branchLabel of [
      'Fix',
      'A very long worktree title '.repeat(8),
    ]) {
      hover(renderRow({ branchLabel, hoverPreview: {} }));
      act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
      const classes = preview()?.classList;
      expect(classes?.contains('w-70')).toBe(true);
      expect(classes?.contains('w-max')).toBe(false);
      expect(classes?.contains('w-80')).toBe(false);
    }
  });

  it.each<[Partial<WorktreeRowProps>, string]>([
    [{ hasPendingQuestion: true }, 'Question waiting'],
    [{ hasPendingToolApproval: true }, 'Approval needed'],
    [{ awaitingApproval: true }, 'Review plan'],
    [{ uiStatus: 'planning' }, 'Planning'],
    [{ pipelineStatus: 'running' }, 'Pipeline running'],
    [{ pipelineStatus: 'paused' }, 'Pipeline paused'],
    [{ pipelineStatus: 'unseen' }, 'Pipeline completed'],
    [{ pipelineStatus: 'unseen-failure' }, 'Pipeline failed'],
    [{ terminalStatus: 'running' }, 'Terminal running'],
    [{ terminalStatus: 'unseen' }, 'Terminal completed'],
    [{ terminalStatus: 'unseen-failure' }, 'Terminal failed'],
    [{ scriptStatus: 'running' }, 'Scripts running'],
    [{ hookStatus: 'running' }, 'Hooks running'],
    [{ graphBuildStatus: 'building' }, 'Updating project graph'],
    [{ splitStatus: 'active' }, 'Split PR in progress'],
    [{ splitStatus: 'review' }, 'Split PR awaiting plan approval'],
    [{ splitStatus: 'done' }, 'Split PR complete'],
    [{ hasIdleWatcherChats: true }, 'Watchers active'],
    [{ hasScheduledMessages: true }, 'Scheduled messages'],
    [{ isDiscovering: true }, 'Discovering environment'],
    [{ setupPhase: 'git-pending' }, 'Setting up'],
    [{ setupPhase: 'running-setup' }, 'Running setup'],
    [{ setupPhase: 'running-teardown' }, 'Running teardown'],
    [{ setupPhase: 'running-archive' }, 'Archiving'],
    [{ hasMismatch: true }, 'Worktree issue'],
    [
      { healthIssue: { status: 'broken', reason: 'Checkout is missing' } },
      'Checkout is missing',
    ],
    [{ runtimeState: 'done', doneLabel: 'PR merged' }, 'PR merged'],
    [{ runtimeState: 'archived' }, 'Archived'],
    [{ uiStatus: 'done' }, 'Done'],
    [{ pinnedToTop: true }, 'Pinned'],
    [{ sharedWithTeammates: true }, 'Shared with teammates'],
    [{ isCreatingPr: true }, 'Creating pull request'],
    [{ prMergingSlot: <span /> }, 'Merging pull request'],
    [{ lastKnownPrStatus: { state: 'merged' } }, 'Merged'],
    [{ lastKnownPrStatus: { state: 'closed' } }, 'Closed'],
    [
      { lastKnownPrStatus: { state: 'closed' }, uiStatus: 'done' },
      'Closed · Done',
    ],
    [
      {
        lastKnownPrStatus: { state: 'closed' },
        runtimeState: 'done',
        doneLabel: 'Wrapped up',
      },
      'Closed · Wrapped up',
    ],
    [
      {
        lastKnownPrStatus: {
          state: 'open',
          checkStatus: 'failing',
          hasConflicts: true,
        },
      },
      'Merge conflicts',
    ],
    [
      {
        lastKnownPrStatus: { state: 'open', reviewStatus: 'changes_requested' },
      },
      'Changes requested',
    ],
    [
      { lastKnownPrStatus: { state: 'open', reviewStatus: 'approved' } },
      'Approved',
    ],
    [
      { lastKnownPrStatus: { state: 'open', isMergeReady: true } },
      'Ready to merge',
    ],
    [
      { lastKnownPrStatus: { state: 'open', unresolvedCommentCount: 2 } },
      '2 unresolved comments',
    ],
  ])('explains active row indicators %j', (props, label) => {
    hover(renderRow({ ...props, statusModel: 'focused', hoverPreview: {} }));
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    expect(preview()?.textContent).toContain(label);
  });

  it('shows the draft icon beside the PR without repeating its state below', () => {
    hover(
      renderRow({
        hoverPreview: {},
        hasPendingQuestion: true,
        lastKnownPrStatus: { state: 'draft', title: 'Restore UI whitespace' },
      }),
    );
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    const card = preview();
    const pr = card?.querySelector('[data-testid="worktree-row-preview-pr"]');
    expect(pr?.textContent).toBe('Restore UI whitespace');
    expect(pr?.querySelector('svg')).not.toBeNull();
    expect(card?.textContent).toContain('Question waiting');
    expect(
      card?.querySelector(
        '[data-testid="worktree-row-preview-status-pr-state"]',
      ),
    ).toBeNull();
  });

  it('shows running checks on the PR glyph instead of a separate status row', () => {
    hover(
      renderRow({
        hoverPreview: {},
        hasPendingQuestion: true,
        lastKnownPrStatus: {
          state: 'open',
          title: 'Restore UI whitespace',
          ciStatus: 'pending',
        },
      }),
    );
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    const card = preview();
    const pr = card?.querySelector('[data-testid="worktree-row-preview-pr"]');
    expect(pr?.querySelector('svg')).not.toBeNull();
    expect(
      pr?.querySelector(
        '[data-testid="worktree-row-preview-pr-checks-running"]',
      ),
    ).not.toBeNull();
    expect(
      card?.querySelector('[data-testid="worktree-row-preview-status-checks"]'),
    ).toBeNull();
    expect(card?.textContent).toContain('Question waiting');
  });

  it.each(['failing', 'passing'] as const)(
    'shows %s checks in the PR icon without a duplicate status row',
    (ciStatus) => {
      hover(
        renderRow({
          hoverPreview: {},
          lastKnownPrStatus: {
            state: 'open',
            ciStatus,
            title: 'Restore UI whitespace',
          },
        }),
      );
      act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
      const card = preview();
      expect(
        card?.querySelector(
          '[data-testid="worktree-row-preview-status-checks"]',
        ),
      ).toBeNull();
      const glyph = card?.querySelector(
        '[data-testid="worktree-row-preview-pr"] svg',
      );
      expect(glyph?.getAttribute('data-glyph')).toBe(
        ciStatus === 'failing' ? 'git-pull-request-closed' : 'circle-check',
      );
      const passedBadge = card?.querySelector(
        '[data-testid="worktree-row-preview-pr-checks-passing"]',
      );
      if (ciStatus === 'passing') {
        expect(passedBadge?.className).toContain('fg-success');
        expect(passedBadge?.querySelector('svg')).not.toBeNull();
      } else {
        expect(passedBadge).toBeNull();
      }
    },
  );

  it('places merge conflicts beneath the PR title without a separate indicator row', () => {
    hover(
      renderRow({
        hoverPreview: {},
        lastKnownPrStatus: {
          state: 'open',
          title: 'Restore UI whitespace',
          hasConflicts: true,
          inMergeQueue: true,
        },
      }),
    );
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    const card = preview();
    const pr = card?.querySelector('[data-testid="worktree-row-preview-pr"]');
    expect(pr?.textContent).toBe('Restore UI whitespaceMerge conflicts');
    expect(pr?.querySelector('.text-2xs')?.textContent).toBe('Merge conflicts');
    expect(
      card?.querySelector(
        '[data-testid="worktree-row-preview-status-conflicts"]',
      ),
    ).toBeNull();
  });

  it('places Merged beneath the PR title without a separate status row', () => {
    hover(
      renderRow({
        hoverPreview: {},
        lastKnownPrStatus: {
          state: 'merged',
          title: 'Restore UI whitespace',
          inMergeQueue: true,
        },
      }),
    );
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    const card = preview();
    const pr = card?.querySelector('[data-testid="worktree-row-preview-pr"]');
    expect(pr?.textContent).toBe('Restore UI whitespaceMerged');
    expect(pr?.querySelector('.text-2xs')?.textContent).toBe('Merged');
    expect(
      card?.querySelector(
        '[data-testid="worktree-row-preview-status-pr-state"]',
      ),
    ).toBeNull();
  });

  it('does not present a repoless cloud task ID as a branch', () => {
    hover(
      renderRow({
        hoverPreview: { projectName: 'Cloud project' },
        branchName: undefined,
        worktreeId: 'cloud:task:internal-id',
        worktreeIdSlot: null,
      }),
    );
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    const card = preview();
    expect(card).not.toBeNull();
    expect(
      card?.querySelector('[data-testid="worktree-row-preview-branch"]'),
    ).toBeNull();
    expect(card?.textContent).not.toContain('cloud:task:internal-id');
  });

  it('keeps a real branch when the row hides its worktree identity', () => {
    hover(renderRow({ hoverPreview: {}, worktreeIdSlot: null }));
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    expect(
      preview()?.querySelector('[data-testid="worktree-row-preview-branch"]')
        ?.textContent,
    ).toBe('dzzzgnr/pr-follow-up');
  });

  it.each(['open', 'draft'] as const)(
    'uses the same quiet neutral ink for %s PR and branch glyphs',
    (state) => {
      hover(
        renderRow({
          hoverPreview: { baseBranch: 'develop' },
          lastKnownPrStatus: { state, title: 'Restore UI whitespace' },
        }),
      );
      act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
      const card = preview();
      const glyph = card?.querySelector(
        '[data-testid="worktree-row-preview-pr"] svg',
      );
      expect(glyph?.parentElement?.className).toContain('fg-tertiary');
      expect(glyph?.parentElement?.className).not.toContain('fg-secondary');
    },
  );

  it.each<[Partial<WorktreeRowProps>, string]>([
    [
      { lastKnownPrStatus: { state: 'open', reviewStatus: 'approved' } },
      'Approved',
    ],
    [
      { lastKnownPrStatus: { state: 'open', isMergeReady: true } },
      'Ready to merge',
    ],
    [
      {
        lastKnownPrStatus: {
          state: 'open',
          reviewStatus: 'approved',
          isMergeReady: true,
        },
        uiStatus: 'done',
      },
      'Approved · Ready to merge · Done',
    ],
    [{ lastKnownPrStatus: { state: 'open' }, runtimeState: 'done' }, 'Done'],
    [
      {
        lastKnownPrStatus: { state: 'open', reviewStatus: 'changes_requested' },
      },
      'Changes requested',
    ],
    [
      { lastKnownPrStatus: { state: 'open', unresolvedCommentCount: 2 } },
      '2 unresolved comments',
    ],
    [{ lastKnownPrStatus: { state: 'closed' } }, 'Closed'],
    [
      { lastKnownPrStatus: { state: 'closed' }, uiStatus: 'done' },
      'Closed · Done',
    ],
    [
      {
        lastKnownPrStatus: { state: 'closed' },
        runtimeState: 'done',
        doneLabel: 'Wrapped up',
      },
      'Closed · Wrapped up',
    ],
  ])('groups PR details below its title: %j', (props, expected) => {
    hover(renderRow({ ...props, hoverPreview: {}, hasUnread: true }));
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    const card = preview();
    expect(
      card?.querySelector('[data-testid="worktree-row-preview-pr"] .text-2xs')
        ?.textContent,
    ).toBe(expected);
    if (
      props.lastKnownPrStatus?.reviewStatus === 'approved' ||
      props.lastKnownPrStatus?.isMergeReady
    ) {
      expect(
        card?.querySelector(
          '[data-testid="worktree-row-preview-pr-checks-passing"]',
        ),
      ).not.toBeNull();
    } else if (
      props.runtimeState === 'done' &&
      props.lastKnownPrStatus?.state === 'open'
    ) {
      expect(
        card?.querySelector('[data-testid="worktree-row-preview-pr-done"]'),
      ).not.toBeNull();
    }
    for (const id of [
      'merge-ready',
      'review',
      'comments',
      'pr-state',
      'done',
      'unread',
    ]) {
      expect(
        card?.querySelector(
          `[data-testid="worktree-row-preview-status-${id}"]`,
        ),
      ).toBeNull();
    }
    expect(
      card?.querySelector('[data-testid="worktree-row-preview-unread"]'),
    ).toBeNull();
  });

  it('keeps unread state on the sidebar without adding it to the tooltip', () => {
    hover(renderRow({ hoverPreview: {}, hasUnread: true, uiStatus: 'unread' }));
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    expect(preview()?.textContent).not.toContain('Unread');
    expect(preview()?.querySelector('[aria-label="Unread"]')).toBeNull();
  });

  it('omits generic chat and run activity instead of claiming background agents', () => {
    for (const props of [
      { isStreaming: true, uiStatus: 'working' },
      { uiStatus: 'working' },
      { uiStatus: 'working', pipelineStatus: 'running' },
      { uiStatus: 'working', isRunningRun: true },
    ] satisfies Partial<WorktreeRowProps>[]) {
      hover(renderRow({ ...props, hoverPreview: {} }));
      act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
      expect(preview()?.textContent).not.toContain('Agents running');
      for (const id of ['agents', 'working', 'run']) {
        expect(
          preview()?.querySelector(
            `[data-testid="worktree-row-preview-status-${id}"]`,
          ),
        ).toBeNull();
      }
    }
  });

  it('does not mistake a paused pipeline for a plan review', () => {
    hover(
      renderRow({
        uiStatus: 'planning',
        pipelineStatus: 'paused',
        hoverPreview: {},
      }),
    );
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    expect(preview()?.textContent).toContain('Pipeline paused');
    expect(preview()?.textContent).not.toContain('Review plan');
    expect(preview()?.textContent).not.toContain('Planning');
  });

  it('lists overlapping indicators and updates them while the card is open', () => {
    hover(
      renderRow({
        hoverPreview: {},
        isStreaming: true,
        hasPendingQuestion: true,
        terminalStatus: 'unseen-failure',
        hasScheduledMessages: true,
        lastKnownPrStatus: { state: 'merged' },
      }),
    );
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    for (const label of [
      'Question waiting',
      'Terminal failed',
      'Scheduled messages',
      'Merged',
    ]) {
      expect(preview()?.textContent).toContain(label);
    }
    renderRow({ hoverPreview: {} });
    expect(preview()?.textContent).not.toContain('Agents running');
    expect(preview()?.textContent).not.toContain('Merged');
  });

  it('adds the merge queue position and phase under a queued pull request', () => {
    const row = renderRow({
      statusModel: 'focused',
      hoverPreview: { projectName: 'Canopy' },
      lastKnownPrStatus: {
        state: 'open',
        label: 'PR #4229',
        title: 'Restore UI whitespace',
        checkStatus: 'passing',
        inMergeQueue: true,
        mergeQueuePosition: 2,
        mergeQueuePhase: 'awaiting_checks',
      },
    });
    hover(row);
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));

    const line = preview()?.querySelector(
      '[data-testid="worktree-row-preview-pr"]',
    );
    expect(line?.textContent).toContain('Restore UI whitespace');
    expect(line?.textContent).toContain(
      'In merge queue (#2) · Awaiting queue checks',
    );
  });

  it('keeps the queue detail truthful without a position or phase, and drops it once dequeued', () => {
    const queued = renderRow({
      hoverPreview: { projectName: 'Canopy' },
      lastKnownPrStatus: {
        state: 'open',
        label: 'PR #4229',
        inMergeQueue: true,
        mergeQueuePhase: 'unknown',
      },
    });
    hover(queued);
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    const line = preview()?.querySelector(
      '[data-testid="worktree-row-preview-pr"]',
    );
    expect(line?.textContent).toBe('PR #4229In merge queue');

    const dequeued = renderRow({
      hoverPreview: { projectName: 'Canopy' },
      lastKnownPrStatus: { state: 'open', label: 'PR #4229' },
    });
    hover(dequeued);
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    expect(
      preview()?.querySelector('[data-testid="worktree-row-preview-pr"]')
        ?.textContent,
    ).toBe('PR #4229');
  });

  it('shows the line changes on their own line under the title, only when there are some', () => {
    const row = renderRow({
      hoverPreview: { projectName: 'Canopy' },
      lastActivityAt: Date.now() - 26 * HOUR,
      diffStats: { insertions: 1234, deletions: 5 },
    });
    hover(row);
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));

    const diff = preview()?.querySelector(
      '[data-testid="worktree-row-preview-diff"]',
    );
    // Exact counts: the card has room the row's condensed badge lacks.
    expect(diff?.textContent).toBe('+1,234-5');
    expect(diff?.querySelector('.fg-success')?.textContent).toBe('+1,234');
    expect(diff?.querySelector('.fg-destructive')?.textContent).toBe('-5');
    // Under the title, so a long title keeps the card's width; the age
    // stays beside the title.
    expect(diff?.previousElementSibling?.textContent).toBe(
      'Set PR issue follow-up automation',
    );
    expect(
      diff?.previousElementSibling?.classList.contains(REPLAY_MASK_CLASS),
    ).toBe(true);
    expect(diff?.closest(`.${REPLAY_MASK_CLASS}`)).toBeNull();
    expect(diff?.parentElement?.nextElementSibling?.textContent).toBe('1d');

    act(() => root.unmount());
    root = createRoot(container);
    const clean = renderRow({
      hoverPreview: { projectName: 'Canopy' },
      lastActivityAt: Date.now() - 26 * HOUR,
      diffStats: { insertions: 0, deletions: 0 },
    });
    hover(clean);
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    expect(
      preview()?.querySelector('[data-testid="worktree-row-preview-diff"]'),
    ).toBeNull();
  });

  it('does not open without a preview', () => {
    const row = renderRow();

    hover(row);
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));

    expect(preview()).toBeNull();
  });

  it('opens while the pointer is on one of the row controls', () => {
    renderRow({
      hoverPreview: { projectName: 'Canopy' },
      actionChipSlot: <button type="button">Archive</button>,
    });

    const button = container.querySelector('button');
    if (!button) throw new Error('button not rendered');
    hover(button);
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));

    expect(preview()).not.toBeNull();
  });

  it('stays open under the pointer so its text can be selected', () => {
    const row = renderRow({ hoverPreview: { projectName: 'Canopy' } });

    hover(row);
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    const card = preview();
    if (!card) throw new Error('preview not open');
    expect(card.className).toContain('pointer-events-auto');

    act(() => {
      row.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: card }),
      );
      card.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, relatedTarget: row }),
      );
    });
    act(() => jest.advanceTimersByTime(1_000));

    expect(preview()).not.toBeNull();
  });

  it('stays open while the pointer crosses a row control to the card', () => {
    const row = renderRow({
      hoverPreview: { projectName: 'Canopy' },
      actionChipSlot: <button type="button">Archive</button>,
    });

    hover(row);
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    const card = preview();
    const button = container.querySelector('button');
    if (!card || !button) throw new Error('preview or button missing');

    // A quick pass over Archive on the way out keeps the card.
    hover(button);
    act(() => jest.advanceTimersByTime(50));
    act(() => {
      button.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: card }),
      );
      card.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, relatedTarget: button }),
      );
    });
    act(() => jest.advanceTimersByTime(1_000));
    expect(preview()).not.toBeNull();
  });

  it('does not open after the pointer leaves before the delay', () => {
    const row = renderRow({ hoverPreview: { projectName: 'Canopy' } });

    hover(row);
    act(() => jest.advanceTimersByTime(200));
    act(() => {
      row.dispatchEvent(
        new MouseEvent('mouseout', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    act(() => jest.advanceTimersByTime(1_000));

    expect(preview()).toBeNull();
  });

  it('stays open while the pointer rests on a row control', () => {
    const row = renderRow({
      hoverPreview: { projectName: 'Canopy' },
      actionChipSlot: <button type="button">Archive</button>,
    });

    hover(row);
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    expect(preview()).not.toBeNull();
    const button = container.querySelector('button');
    if (!button) throw new Error('button not rendered');
    hover(button);
    act(() => jest.advanceTimersByTime(1_000));

    expect(preview()).not.toBeNull();
  });

  it('closes when the row is pressed', () => {
    const row = renderRow({ hoverPreview: { projectName: 'Canopy' } });

    hover(row);
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    expect(preview()).not.toBeNull();
    act(() => {
      row.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });

    expect(preview()).toBeNull();
  });

  it('stays hidden while the row menu is open, even when the pointer comes back', () => {
    const props: Partial<WorktreeRowProps> = {
      hoverPreview: { projectName: 'Canopy' },
    };
    const row = renderRow(props);
    hover(row);
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    expect(preview()).not.toBeNull();

    // Right-click opens the menu; the pointer then leaves the row for the
    // menu and comes back over the row while the menu is still up.
    renderRow({
      ...props,
      actionChipSlot: (
        <WorktreeRowActionChip menuOpen>
          <button type="button">Actions</button>
        </WorktreeRowActionChip>
      ),
    });
    expect(preview()).toBeNull();
    act(() => {
      row.dispatchEvent(
        new MouseEvent('mouseout', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    hover(row);
    act(() => jest.advanceTimersByTime(PREVIEW_DELAY_MS));
    expect(preview()).toBeNull();
  });

  it('lights the row only while a pointer-placed menu is open', () => {
    const rowSurface = (
      menuOpen: boolean,
      marksRowWhileOpen: boolean,
    ): Element | null => {
      renderRow({
        actionChipSlot: (
          <WorktreeRowActionChip
            menuOpen={menuOpen}
            marksRowWhileOpen={marksRowWhileOpen}
          >
            <button type="button">Actions</button>
          </WorktreeRowActionChip>
        ),
      });
      return container.querySelector('[data-row-menu-open]');
    };
    expect(rowSurface(true, false)).toBeNull();
    expect(rowSurface(false, true)).toBeNull();
    expect(rowSurface(true, true)).not.toBeNull();
  });

  it('leaves the title and subtitle without a native tooltip, since the card shows them', () => {
    const row = renderRow({ hoverPreview: { projectName: 'Canopy' } });

    expect(row.querySelectorAll('[title]')).toHaveLength(0);
  });

  it('keeps the native tooltips on a row without a card', () => {
    const row = renderRow();

    expect(
      row
        .querySelector('[data-testid="worktree-row-title"]')
        ?.getAttribute('title'),
    ).toBe('dzzzgnr/pr-follow-up');
  });

  it('leaves Enter on the row to the row', () => {
    const row = renderRow({ hoverPreview: { projectName: 'Canopy' } });

    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      row.dispatchEvent(enter);
    });

    expect(enter.defaultPrevented).toBe(false);
    expect(preview()).toBeNull();
  });
});
