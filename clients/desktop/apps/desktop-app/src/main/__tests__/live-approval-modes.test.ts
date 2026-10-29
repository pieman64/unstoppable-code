import {
  beginApprovalModeTransition,
  boundingApprovalMode,
  clampToLiveApprovalMode,
  clearLiveApprovalMode,
  reachableApprovalMode,
  setLiveApprovalMode,
  withApprovalModeOperation,
} from '../approvals/live-approval-modes';

describe('live approval modes', () => {
  afterEach(() => {
    clearLiveApprovalMode('project', 'worktree', 'chat');
  });

  it('prevents a stale full-access send from overriding a live downgrade', () => {
    setLiveApprovalMode('project', 'worktree', 'chat', 'ask');

    expect(
      clampToLiveApprovalMode('project', 'worktree', 'chat', 'full-access'),
    ).toBe('ask');
  });

  it('preserves a more restrictive requested mode', () => {
    setLiveApprovalMode('project', 'worktree', 'chat', 'auto');

    expect(clampToLiveApprovalMode('project', 'worktree', 'chat', 'ask')).toBe(
      'ask',
    );
  });

  it('bounds a chat by its live restriction and a pending switch, whichever is stricter', () => {
    expect(boundingApprovalMode('project', 'worktree', 'chat', 'auto')).toBe(
      'auto',
    );
    setLiveApprovalMode('project', 'worktree', 'chat', 'ask');
    expect(boundingApprovalMode('project', 'worktree', 'chat', 'auto')).toBe(
      'ask',
    );
    clearLiveApprovalMode('project', 'worktree', 'chat');
    beginApprovalModeTransition('project', 'worktree', 'chat', 'ask');
    expect(
      boundingApprovalMode('project', 'worktree', 'chat', 'full-access'),
    ).toBe('ask');
    beginApprovalModeTransition('project', 'worktree', 'chat', 'full-access');
    expect(boundingApprovalMode('project', 'worktree', 'chat', 'auto')).toBe(
      'auto',
    );
  });

  it("reaches the looser of a chat's mode and its pending switch", () => {
    expect(reachableApprovalMode('project', 'worktree', 'chat', 'ask')).toBe(
      'ask',
    );
    beginApprovalModeTransition('project', 'worktree', 'chat', 'full-access');
    expect(reachableApprovalMode('project', 'worktree', 'chat', 'ask')).toBe(
      'full-access',
    );
    beginApprovalModeTransition('project', 'worktree', 'chat', 'ask');
    expect(reachableApprovalMode('project', 'worktree', 'chat', 'auto')).toBe(
      'auto',
    );
  });

  it('serializes operations for the same chat', async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withApprovalModeOperation(
      'project',
      'worktree',
      'chat',
      async () => {
        order.push('first-start');
        await firstPaused;
        order.push('first-end');
      },
    );
    const second = withApprovalModeOperation(
      'project',
      'worktree',
      'chat',
      () => {
        order.push('second');
        return Promise.resolve();
      },
    );

    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });
});
