import type {
  PrMergeQueueStatus,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import {
  deriveDesktopRowAttention,
  deriveDesktopRowPr,
  divergentRepoBranchLabel,
  type DesktopWorktreeRowLiveKeys,
} from '../desktopWorktreeRowOverrides';
import { deriveWorktreeSplitRowStatus } from '../../worktree/worktreeSplitRowStatus';

const KEY = 'project/worktree';

function keys(
  partial: Partial<DesktopWorktreeRowLiveKeys> = {},
): DesktopWorktreeRowLiveKeys {
  return {
    statusByKey: new Map([[KEY, 'idle']]),
    streaming: new Set(),
    awaitingApproval: new Set(),
    pendingQuestion: new Set(),
    toolApproval: new Set(),
    unread: new Set(),
    pipelineRunning: new Set(),
    pipelineUnseen: new Set(),
    pipelineUnseenFailed: new Set(),
    pipelinePaused: new Set(),
    backgroundTasks: new Map(),
    ...partial,
  };
}

describe('deriveDesktopRowAttention', () => {
  it('leaves a row the store does not know to its snapshot', () => {
    expect(
      deriveDesktopRowAttention(
        keys({ statusByKey: new Map() }),
        KEY,
        true,
        false,
      ),
    ).toBeNull();
  });

  it('reads every attention fact from the live key sets', () => {
    expect(
      deriveDesktopRowAttention(
        keys({
          statusByKey: new Map([[KEY, 'working']]),
          streaming: new Set([KEY]),
          awaitingApproval: new Set([KEY]),
          pendingQuestion: new Set([KEY]),
          toolApproval: new Set([KEY]),
          unread: new Set([KEY]),
        }),
        KEY,
        false,
        false,
      ),
    ).toEqual({
      uiStatus: 'working',
      runtimeState: undefined,
      isStreaming: true,
      awaitingApproval: true,
      hasPendingQuestion: true,
      hasPendingToolApproval: true,
      hasUnread: true,
      pipelineStatus: undefined,
      backgroundTasks: 0,
    });
  });

  it('reads the row’s background task count from the live keys', () => {
    expect(
      deriveDesktopRowAttention(
        keys({ backgroundTasks: new Map([[KEY, 3]]) }),
        KEY,
        false,
        false,
      )?.backgroundTasks,
    ).toBe(3);
  });

  it('clears what the live sets no longer carry, and folds in plan-chat unread', () => {
    expect(
      deriveDesktopRowAttention(
        keys({ statusByKey: new Map([[KEY, 'done']]) }),
        KEY,
        true,
        false,
      ),
    ).toEqual({
      uiStatus: 'done',
      runtimeState: 'done',
      isStreaming: false,
      awaitingApproval: false,
      hasPendingQuestion: false,
      hasPendingToolApproval: false,
      hasUnread: true,
      pipelineStatus: undefined,
      backgroundTasks: 0,
    });
  });

  it('carries the renderer-owned unseen pipeline results main cannot see', () => {
    const status = (partial: Partial<DesktopWorktreeRowLiveKeys>): unknown =>
      deriveDesktopRowAttention(keys(partial), KEY, false, false)
        ?.pipelineStatus;
    expect(status({ pipelineUnseen: new Set([KEY]) })).toBe('unseen');
    expect(
      status({
        pipelineUnseen: new Set([KEY]),
        pipelineUnseenFailed: new Set([KEY]),
      }),
    ).toBe('unseen-failure');
    // A paused run is blocked on the user and outranks a plain unseen result.
    expect(
      status({
        pipelineUnseen: new Set([KEY]),
        pipelinePaused: new Set([KEY]),
      }),
    ).toBe('paused');
    expect(
      status({
        pipelineRunning: new Set([KEY]),
        pipelineUnseenFailed: new Set([KEY]),
      }),
    ).toBe('running');
  });

  // CAN-3053 attempt-3 finding 2: the snapshot's own "done" fallback
  // (`isWorktreeDone`) must win over a stricter live status once either
  // source calls a row done — `snapshotDone` is that signal.
  it('forces done when the snapshot says done, even though the live status disagrees', () => {
    expect(
      deriveDesktopRowAttention(
        keys({ statusByKey: new Map([[KEY, 'working']]) }),
        KEY,
        false,
        true,
      ),
    ).toEqual({
      uiStatus: 'done',
      runtimeState: 'done',
      isStreaming: false,
      awaitingApproval: false,
      hasPendingQuestion: false,
      hasPendingToolApproval: false,
      hasUnread: false,
      pipelineStatus: undefined,
      backgroundTasks: 0,
    });
  });

  it('does not force done when neither the live status nor the snapshot says so', () => {
    expect(
      deriveDesktopRowAttention(
        keys({ statusByKey: new Map([[KEY, 'idle']]) }),
        KEY,
        false,
        false,
      ),
    ).toMatchObject({ uiStatus: 'idle', runtimeState: undefined });
  });
});

describe('deriveWorktreeSplitRowStatus', () => {
  const idle = {
    splitLocked: false,
    sessionOpen: false,
    planning: false,
    splitting: false,
    planPresent: false,
    completed: false,
    runningLine: null,
  };

  it('shows nothing without a lock or an open session', () => {
    expect(
      deriveWorktreeSplitRowStatus({ ...idle, planPresent: true }),
    ).toEqual({ splitStatus: undefined, splitStatusMessage: undefined });
  });

  it.each([
    [{ planning: true }, 'active', 'Analyzing the PR diff'],
    [
      { splitting: true, runningLine: 'Carving (2/4)' },
      'active',
      'Carving (2/4)',
    ],
    [{ splitting: true }, 'active', 'Preparing the split'],
    [{ planPresent: true }, 'review', 'Waiting for your plan approval'],
    [{ completed: true, planPresent: true }, 'done', 'All child PRs created'],
  ] as const)('%j → %s', (facts, status, message) => {
    expect(
      deriveWorktreeSplitRowStatus({ ...idle, splitLocked: true, ...facts }),
    ).toEqual({ splitStatus: status, splitStatusMessage: message });
  });

  it('keeps the badge while only the presentation session is open', () => {
    expect(
      deriveWorktreeSplitRowStatus({
        ...idle,
        sessionOpen: true,
        completed: true,
      }).splitStatus,
    ).toBe('done');
  });
});

describe('deriveDesktopRowPr', () => {
  const status = (
    state: 'open' | 'merged',
    extra: { body?: string; mergeQueue?: PrMergeQueueStatus } = {},
  ): WorktreePrStatus => ({
    lastCheckedAt: '2026-01-01T00:00:00.000Z',
    repos: [
      {
        repoId: 'repo',
        repoName: 'repo',
        status: {
          state,
          prNumber: 42,
          prUrl: 'https://example.test/pr/42',
          title: 'Ship it',
          checkStatus: 'passing',
          checkDetails: [],
          reviewStatus: 'approved',
          reviewers: [],
          hasConflicts: false,
          commentCount: 0,
          updatedAt: '2026-01-01T00:00:00.000Z',
          ...extra,
        },
      },
    ],
  });

  it('keeps the snapshot until the live store has looked the worktree up', () => {
    // `toStrictEqual`, not `toEqual`: the override mechanism works by KEY
    // PRESENCE (`{...overrides}` keeps the snapshot when a key is absent,
    // clears it when the key is present but `undefined`). `toEqual` ignores
    // undefined-valued properties, so it can't tell "no opinion" (this case,
    // an empty object) apart from "opinion: clear it" (the next test, an
    // object with `lastKnownPrStatus: undefined` present) — a regression that
    // conflated the two would slip past `toEqual` silently.
    const result = deriveDesktopRowPr(undefined, false, true);
    expect(result).toStrictEqual({});
    expect('lastKnownPrStatus' in result).toBe(false);
  });

  it('clears the badge on a confirmed no-PR status', () => {
    const result = deriveDesktopRowPr(null, false, false);
    expect(result).toStrictEqual({
      lastKnownPrStatus: undefined,
      doneLabel: 'Done',
    });
    // The key must be PRESENT (even though its value is `undefined`) so the
    // override spread actually clears a stale snapshot PR badge rather than
    // leaving it untouched — `toStrictEqual` alone already enforces this,
    // but the explicit check documents exactly what would break.
    expect('lastKnownPrStatus' in result).toBe(true);
  });

  it('carries the PR body into the badge tooltip and approval state', () => {
    const { lastKnownPrStatus } = deriveDesktopRowPr(
      status('open', { body: 'Why this change' }),
      false,
      false,
    );
    expect(lastKnownPrStatus).toMatchObject({
      label: 'PR #42',
      description: 'Why this change',
      reviewStatus: 'approved',
    });
  });

  it('carries the merge queue state into the badge', () => {
    expect(
      deriveDesktopRowPr(
        status('open', {
          mergeQueue: { required: true, inQueue: true, position: 3 },
        }),
        false,
        false,
      ).lastKnownPrStatus,
    ).toMatchObject({ inMergeQueue: true, mergeQueuePosition: 3 });
    const notQueued = deriveDesktopRowPr(
      status('open', { mergeQueue: { required: true, inQueue: false } }),
      false,
      false,
    ).lastKnownPrStatus;
    expect(notQueued).not.toHaveProperty('inMergeQueue');
    expect(notQueued).not.toHaveProperty('mergeQueuePosition');
  });

  it('follows a PR through the merge queue lifecycle to merged', () => {
    const row = (
      state: 'open' | 'merged',
      mergeQueue?: PrMergeQueueStatus,
    ): ReturnType<typeof deriveDesktopRowPr> =>
      deriveDesktopRowPr(
        status(state, mergeQueue ? { mergeQueue } : {}),
        false,
        true,
      );

    expect(row('open').lastKnownPrStatus).not.toHaveProperty('inMergeQueue');

    expect(
      row('open', {
        required: true,
        inQueue: true,
        position: 2,
        phase: 'awaiting_checks',
      }).lastKnownPrStatus,
    ).toMatchObject({
      inMergeQueue: true,
      mergeQueuePosition: 2,
      mergeQueuePhase: 'awaiting_checks',
    });

    expect(
      row('open', {
        required: true,
        inQueue: true,
        position: 1,
        phase: 'mergeable',
      }).lastKnownPrStatus,
    ).toMatchObject({
      inMergeQueue: true,
      mergeQueuePosition: 1,
      mergeQueuePhase: 'mergeable',
    });

    const stale = row('open', {
      required: true,
      inQueue: true,
    }).lastKnownPrStatus;
    expect(stale).toMatchObject({ inMergeQueue: true });
    expect(stale).not.toHaveProperty('mergeQueuePosition');
    expect(stale).not.toHaveProperty('mergeQueuePhase');

    const removed = row('open', {
      required: true,
      inQueue: false,
      phase: 'mergeable',
    });
    expect(removed.lastKnownPrStatus).toMatchObject({
      state: 'open',
      label: 'PR #42',
    });
    expect(removed.lastKnownPrStatus).not.toHaveProperty('inMergeQueue');
    expect(removed.lastKnownPrStatus).not.toHaveProperty('mergeQueuePhase');
    expect(removed.doneLabel).toBe('Done');

    expect(
      row('open', {
        required: true,
        inQueue: true,
        position: 3,
        phase: 'queued',
      }).lastKnownPrStatus,
    ).toMatchObject({
      inMergeQueue: true,
      mergeQueuePosition: 3,
      mergeQueuePhase: 'queued',
    });

    const unavailable = row('open').lastKnownPrStatus;
    expect(unavailable).toMatchObject({ state: 'open', label: 'PR #42' });
    expect(unavailable).not.toHaveProperty('inMergeQueue');

    const merged = row('merged', {
      required: true,
      inQueue: true,
      position: 1,
      phase: 'mergeable',
    });
    // A merged PR keeps its own badge, so the row can say Merged; it leaves
    // the merge queue behind.
    expect(merged.lastKnownPrStatus).toMatchObject({
      state: 'merged',
      label: 'PR #42',
    });
    expect(merged.lastKnownPrStatus).not.toHaveProperty('inMergeQueue');
    expect(merged.lastKnownPrStatus).not.toHaveProperty('mergeQueuePhase');
    expect(merged.doneLabel).toBe('PR merged');
  });

  it('labels a done row "PR merged" only once a merged status is confirmed', () => {
    expect(deriveDesktopRowPr(status('merged'), false, true).doneLabel).toBe(
      'PR merged',
    );
    expect(deriveDesktopRowPr(status('merged'), false, false).doneLabel).toBe(
      'Done',
    );
    expect(deriveDesktopRowPr(status('open'), false, true).doneLabel).toBe(
      'Done',
    );
  });
});

describe('divergentRepoBranchLabel', () => {
  it('names a multi-repo row whose repos sit on different branches', () => {
    expect(
      divergentRepoBranchLabel([{ branch: 'main' }, { branch: 'feature/web' }]),
    ).toBe('Multiple branches');
  });

  it('defers to the snapshot branch when the repos agree or are unknown', () => {
    expect(
      divergentRepoBranchLabel([{ branch: 'main' }, { branch: 'main' }]),
    ).toBeUndefined();
    expect(divergentRepoBranchLabel([])).toBeUndefined();
    expect(divergentRepoBranchLabel(undefined)).toBeUndefined();
  });
});
