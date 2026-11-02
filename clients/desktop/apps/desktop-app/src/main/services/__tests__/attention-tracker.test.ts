/**
 * Behavior coverage for the desktop attention tracker (CAN-3195).
 *
 * The tracker is what turns "a turn ended" into "a HUMAN is the blocker", so
 * the cases that matter are the suppressions: a prompt answered at the desk,
 * a duplicate block, and a clear for something that was never sent.
 */

const recordAttention = jest.fn<Promise<void>, unknown[]>();
const flushWorktreeNow = jest.fn<Promise<void>, unknown[]>();

jest.mock('../telemetry-sync-service', () => ({
  getTelemetrySyncService: (): {
    recordAttention: typeof recordAttention;
    flushWorktreeNow: typeof flushWorktreeNow;
  } => ({ recordAttention, flushWorktreeNow }),
}));

import {
  ATTENTION_GRACE_MS,
  getAttentionTracker,
  resetAttentionTrackerForTests,
} from '../attention-tracker';

describe('AttentionTracker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    recordAttention.mockReset().mockResolvedValue(undefined);
    flushWorktreeNow.mockReset().mockResolvedValue(undefined);
    resetAttentionTrackerForTests();
  });

  afterEach(() => {
    resetAttentionTrackerForTests();
    jest.useRealTimers();
  });

  const signal = {
    projectId: 'p1',
    worktreeId: 'wt1',
    chatId: 'c1',
    state: 'needs_input' as const,
    reason: 'tool_approval' as const,
    detail: 'git push --force',
  };

  async function advancePastGrace(): Promise<void> {
    jest.advanceTimersByTime(ATTENTION_GRACE_MS);
    // Let the async publish chain settle.
    await Promise.resolve();
    await Promise.resolve();
  }

  it('syncs a block only after the grace window, then flushes explicitly', async () => {
    getAttentionTracker().mark(signal);
    // Nothing may reach telemetry inside the grace window: the whole point is
    // that a prompt answered at the desk never becomes a push.
    expect(recordAttention).not.toHaveBeenCalled();

    await advancePastGrace();

    expect(recordAttention).toHaveBeenCalledWith(
      'p1',
      'wt1',
      'c1',
      'needs_input',
      'tool_approval',
      expect.objectContaining({ detail: 'git push --force' }),
    );
    // The telemetry debounce re-arms on every enqueue, so a busy worktree
    // could defer this indefinitely. The explicit flush is load-bearing.
    expect(flushWorktreeNow).toHaveBeenCalledWith('p1', 'wt1');
  });

  it('answering inside the grace window sends nothing at all', async () => {
    const tracker = getAttentionTracker();
    tracker.mark(signal);
    jest.advanceTimersByTime(ATTENTION_GRACE_MS - 1);
    tracker.clear('p1', 'wt1', 'c1');

    await advancePastGrace();

    // Not even a `clear`: the server never saw a block, so a transition out of
    // one would be a lie about state it does not hold.
    expect(recordAttention).not.toHaveBeenCalled();
    expect(flushWorktreeNow).not.toHaveBeenCalled();
  });

  it('sends a clear once the block has actually synced', async () => {
    const tracker = getAttentionTracker();
    tracker.mark(signal);
    await advancePastGrace();
    recordAttention.mockClear();
    flushWorktreeNow.mockClear();

    tracker.clear('p1', 'wt1', 'c1');
    await Promise.resolve();
    await Promise.resolve();

    expect(recordAttention).toHaveBeenCalledWith(
      'p1',
      'wt1',
      'c1',
      'clear',
      'tool_approval',
      expect.anything(),
    );
    expect(flushWorktreeNow).toHaveBeenCalledWith('p1', 'wt1');
  });

  it('compensates when a block clears while its telemetry write is in flight', async () => {
    let finishBlock: (() => void) | undefined;
    recordAttention.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishBlock = resolve;
        }),
    );
    const tracker = getAttentionTracker();
    tracker.mark(signal);
    await advancePastGrace();

    expect(recordAttention).toHaveBeenCalledTimes(1);
    expect(flushWorktreeNow).not.toHaveBeenCalled();

    // The user resolves the prompt after its blocking state started writing,
    // but before that write can be marked published or explicitly flushed.
    tracker.clear('p1', 'wt1', 'c1');
    finishBlock?.();
    await tracker.drain();

    expect(recordAttention).toHaveBeenNthCalledWith(
      2,
      'p1',
      'wt1',
      'c1',
      'clear',
      'tool_approval',
      expect.anything(),
    );
    // The only flush happens after the compensating clear has replaced the
    // stale block in the telemetry queue.
    expect(flushWorktreeNow).toHaveBeenCalledTimes(1);
    expect(flushWorktreeNow).toHaveBeenCalledWith('p1', 'wt1');
  });

  it('does not let a stale publication clear an already-eligible replacement', async () => {
    let finishFirstBlock: (() => void) | undefined;
    recordAttention.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirstBlock = resolve;
        }),
    );
    const tracker = getAttentionTracker();
    tracker.mark({ ...signal, sourceId: 'approval-a' });
    await advancePastGrace();

    tracker.mark({
      ...signal,
      sourceId: 'question-b',
      reason: 'ask_user',
      detail: 'Which database?',
    });
    await advancePastGrace();
    finishFirstBlock?.();
    await tracker.drain();

    expect(recordAttention).toHaveBeenLastCalledWith(
      'p1',
      'wt1',
      'c1',
      'needs_input',
      'ask_user',
      expect.objectContaining({ detail: 'Which database?' }),
    );
    expect(flushWorktreeNow).toHaveBeenLastCalledWith('p1', 'wt1');
  });

  it('restores an older blocker when its in-flight replacement resolves', async () => {
    const tracker = getAttentionTracker();
    tracker.mark({ ...signal, sourceId: 'approval-a' });
    await advancePastGrace();
    await tracker.drain();

    let finishReplacement: (() => void) | undefined;
    recordAttention.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishReplacement = resolve;
        }),
    );
    tracker.mark({
      ...signal,
      sourceId: 'question-b',
      reason: 'ask_user',
      detail: 'Which database?',
    });
    await advancePastGrace();

    tracker.clear('p1', 'wt1', 'c1', 'question-b');
    finishReplacement?.();
    await tracker.drain();

    expect(recordAttention).toHaveBeenLastCalledWith(
      'p1',
      'wt1',
      'c1',
      'needs_input',
      'tool_approval',
      expect.objectContaining({ detail: 'git push --force' }),
    );
    expect(tracker.isTracked('p1', 'wt1', 'c1')).toBe(true);
  });

  it('lets shutdown wait for an in-flight clear flush', async () => {
    let finishClear: (() => void) | undefined;
    const tracker = getAttentionTracker();
    tracker.mark(signal);
    await advancePastGrace();
    recordAttention.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClear = resolve;
        }),
    );
    flushWorktreeNow.mockClear();

    tracker.clear('p1', 'wt1', 'c1');
    const drain = tracker.drain();
    await Promise.resolve();
    expect(flushWorktreeNow).not.toHaveBeenCalled();

    finishClear?.();
    await drain;
    expect(flushWorktreeNow).toHaveBeenCalledWith('p1', 'wt1');
  });

  it('publishes the current state after one source cycles through reasons', async () => {
    const tracker = getAttentionTracker();
    tracker.mark({ ...signal, sourceId: 'pipeline-status' });
    await advancePastGrace();

    tracker.mark({
      ...signal,
      sourceId: 'pipeline-status',
      state: 'blocked',
      reason: 'auth_required',
      detail: undefined,
    });
    await advancePastGrace();

    tracker.mark({ ...signal, sourceId: 'pipeline-status' });
    await advancePastGrace();

    expect(recordAttention).toHaveBeenLastCalledWith(
      'p1',
      'wt1',
      'c1',
      'needs_input',
      'tool_approval',
      expect.objectContaining({ detail: 'git push --force' }),
    );
  });

  it('does not restart the clock for a repeat of the same block', async () => {
    const tracker = getAttentionTracker();
    tracker.mark(signal);
    jest.advanceTimersByTime(ATTENTION_GRACE_MS - 1000);
    // A re-rendered prompt or a retried approval for the same reason is the
    // same block; re-arming here would let a noisy caller defer the push
    // forever.
    tracker.mark(signal);
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(recordAttention).toHaveBeenCalledTimes(1);
  });

  it('updates changing detail without restarting the transition clock', async () => {
    const tracker = getAttentionTracker();
    tracker.mark({ ...signal, sourceId: 'pipeline-status' });
    jest.advanceTimersByTime(ATTENTION_GRACE_MS - 1000);

    tracker.mark({
      ...signal,
      sourceId: 'pipeline-status',
      detail: 'Waiting at a newer checkpoint',
    });
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(recordAttention).toHaveBeenCalledTimes(1);
    expect(recordAttention).toHaveBeenCalledWith(
      'p1',
      'wt1',
      'c1',
      'needs_input',
      'tool_approval',
      expect.objectContaining({ detail: 'Waiting at a newer checkpoint' }),
    );
  });

  it('treats a change of reason as a new block', async () => {
    const tracker = getAttentionTracker();
    tracker.mark(signal);
    await advancePastGrace();
    recordAttention.mockClear();

    tracker.mark({ ...signal, state: 'blocked', reason: 'usage_limit' });
    await advancePastGrace();

    expect(recordAttention).toHaveBeenCalledWith(
      'p1',
      'wt1',
      'c1',
      'blocked',
      'usage_limit',
      expect.anything(),
    );
  });

  it('does not clear a newer blocker when an older source resolves', async () => {
    const tracker = getAttentionTracker();
    tracker.mark({ ...signal, sourceId: 'approval-1' });
    tracker.mark({
      ...signal,
      sourceId: 'question-2',
      reason: 'ask_user',
      detail: 'Which database?',
    });

    // Use the desired four-argument API through a narrow test cast so this
    // regression fails on behavior before the production signature changes.
    tracker.clear('p1', 'wt1', 'c1', 'approval-1');
    await advancePastGrace();

    expect(tracker.isTracked('p1', 'wt1', 'c1')).toBe(true);
    expect(recordAttention).toHaveBeenCalledWith(
      'p1',
      'wt1',
      'c1',
      'needs_input',
      'ask_user',
      expect.objectContaining({ detail: 'Which database?' }),
    );
  });

  it('ignores surfaces with no worktree identity', async () => {
    // App Advisor / plan-explore chats have no worktree on the telemetry wire
    // and no deep link to route a push to; sending a blank id would create an
    // unroutable notification.
    getAttentionTracker().mark({ ...signal, worktreeId: '' });
    await advancePastGrace();
    expect(recordAttention).not.toHaveBeenCalled();
  });

  it('never rejects when telemetry fails', async () => {
    recordAttention.mockRejectedValue(new Error('offline'));
    getAttentionTracker().mark(signal);
    await expect(advancePastGrace()).resolves.toBeUndefined();
  });
});
