import type { ApprovalRule } from '@canopy/desktop-shared/types';
import {
  beginApprovalModeTransition,
  boundingApprovalMode,
  callerBoundingApprovalMode,
  callerBoundingSessionApprovalRules,
  clampToLiveApprovalMode,
  clearLiveApprovalMode,
  reachableApprovalMode,
  setAppliedApprovalReader,
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

  it("bounds a calling chat also by its live session's applied mode, which never widens the bound", () => {
    let applied: 'ask' | 'auto' | 'full-access' | undefined;
    setAppliedApprovalReader(() => ({ mode: applied, rules: undefined }));
    try {
      setLiveApprovalMode('project', 'worktree', 'chat', 'full-access');
      expect(
        callerBoundingApprovalMode(
          'project',
          'worktree',
          'chat',
          'full-access',
        ),
      ).toBe('full-access');
      applied = 'ask';
      expect(
        callerBoundingApprovalMode(
          'project',
          'worktree',
          'chat',
          'full-access',
        ),
      ).toBe('ask');
      // The registry, a pending switch and the policy's mode still bound it.
      applied = 'full-access';
      setLiveApprovalMode('project', 'worktree', 'chat', 'auto');
      expect(
        callerBoundingApprovalMode(
          'project',
          'worktree',
          'chat',
          'full-access',
        ),
      ).toBe('auto');
      beginApprovalModeTransition('project', 'worktree', 'chat', 'ask');
      expect(
        callerBoundingApprovalMode(
          'project',
          'worktree',
          'chat',
          'full-access',
        ),
      ).toBe('ask');
      clearLiveApprovalMode('project', 'worktree', 'chat');
      expect(
        callerBoundingApprovalMode('project', 'worktree', 'chat', 'auto'),
      ).toBe('auto');
      // The chat's own bound, used when its turn starts, ignores the session.
      applied = 'ask';
      expect(boundingApprovalMode('project', 'worktree', 'chat', 'auto')).toBe(
        'auto',
      );
    } finally {
      setAppliedApprovalReader(() => undefined);
    }
  });

  it("narrows a calling chat's session rules to the ones its live session applies, never widening them", () => {
    const rule = (
      behavior: ApprovalRule['behavior'],
      pattern: string,
      id = `${behavior}-${pattern}`,
    ): ApprovalRule => ({
      id,
      behavior,
      target: { kind: 'command', pattern },
      createdAt: '2026-10-23T00:00:00.000Z',
      origin: 'prompt',
    });
    const tests = rule('allow', 'npm test');
    const publish = rule('allow', 'npm publish');
    const deny = rule('deny', 'rm -rf dist');
    let applied: readonly ApprovalRule[] | undefined;
    setAppliedApprovalReader(() => ({ mode: undefined, rules: applied }));
    const bound = (): readonly ApprovalRule[] =>
      callerBoundingSessionApprovalRules('project', 'worktree', 'chat', [
        tests,
        publish,
      ]);
    try {
      // Unknown: the chat's rules.
      expect(bound()).toEqual([tests, publish]);
      // Only the grants both hold, and the deny rules of either.
      applied = [{ ...tests, id: 'same-effect' }, rule('allow', 'ls'), deny];
      expect(bound()).toEqual([tests, deny]);
      applied = [];
      expect(bound()).toEqual([]);
    } finally {
      setAppliedApprovalReader(() => undefined);
    }
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
