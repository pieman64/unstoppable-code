import {
  beginWorktreeGitSetup,
  claimWorktreeGitSetup,
  endWorktreeGitSetup,
  settleWorktreeGitSetup,
  waitForWorktreeGitSetup,
  type WorktreeGitSetupOutcome,
} from '../lib/worktree-git-setup';

let next = 0;
function worktree(): [string, string] {
  next += 1;
  return ['ws-setup', `wt-setup-${next}`];
}

describe('worktree Git setup outcomes', () => {
  it('forgets a setup that settles ready', () => {
    const [workspaceId, worktreeId] = worktree();
    const settle = beginWorktreeGitSetup(workspaceId, worktreeId);
    settle('ready');
    expect(claimWorktreeGitSetup(workspaceId, worktreeId)).toBeUndefined();
  });

  it.each(['failed', 'cancelled'] as const)(
    'keeps a setup that settled %s until the first send claims it',
    async (outcome) => {
      const [workspaceId, worktreeId] = worktree();
      const settle = beginWorktreeGitSetup(workspaceId, worktreeId);
      settle(outcome);

      await expect(
        claimWorktreeGitSetup(workspaceId, worktreeId),
      ).resolves.toBe(outcome);
      expect(claimWorktreeGitSetup(workspaceId, worktreeId)).toBeUndefined();
    },
  );

  it.each(['failed', 'cancelled'] as const)(
    'forgets a setup that settles %s once a send claimed it while it ran',
    async (outcome) => {
      const [workspaceId, worktreeId] = worktree();
      const settle = beginWorktreeGitSetup(workspaceId, worktreeId);
      const claimed = claimWorktreeGitSetup(workspaceId, worktreeId);
      expect(claimWorktreeGitSetup(workspaceId, worktreeId)).toBe(claimed);

      settle(outcome);

      await expect(claimed).resolves.toBe(outcome);
      expect(claimWorktreeGitSetup(workspaceId, worktreeId)).toBeUndefined();
    },
  );

  it.each([
    ['after', true],
    ['before', false],
  ] as const)(
    'forgets a failed setup when its worktree is torn down %s it settles',
    (_case, settledFirst) => {
      const [workspaceId, worktreeId] = worktree();
      const settle = beginWorktreeGitSetup(workspaceId, worktreeId);
      if (settledFirst) settle('failed');
      endWorktreeGitSetup(workspaceId, worktreeId);
      if (!settledFirst) settle('failed');
      expect(claimWorktreeGitSetup(workspaceId, worktreeId)).toBeUndefined();
    },
  );

  it('settles a setup exactly once', async () => {
    const [workspaceId, worktreeId] = worktree();
    const settle = beginWorktreeGitSetup(workspaceId, worktreeId);
    settle('failed');
    settle('ready');
    await expect(claimWorktreeGitSetup(workspaceId, worktreeId)).resolves.toBe(
      'failed',
    );
  });

  it('keeps the outcome of a newer setup of the same worktree', async () => {
    const [workspaceId, worktreeId] = worktree();
    const settleFirst = beginWorktreeGitSetup(workspaceId, worktreeId);
    const settleSecond = beginWorktreeGitSetup(workspaceId, worktreeId);
    settleFirst('ready');
    settleSecond('failed');
    await expect(claimWorktreeGitSetup(workspaceId, worktreeId)).resolves.toBe(
      'failed',
    );
  });

  it.each(['ready', 'cancelled'] as const)(
    'settles a pending setup %s from outside its Phase B, as a repair does',
    async (outcome) => {
      const [workspaceId, worktreeId] = worktree();
      beginWorktreeGitSetup(workspaceId, worktreeId);
      const claimed = claimWorktreeGitSetup(workspaceId, worktreeId);

      settleWorktreeGitSetup(workspaceId, worktreeId, outcome);

      await expect(claimed).resolves.toBe(outcome);
      expect(claimWorktreeGitSetup(workspaceId, worktreeId)).toBeUndefined();
    },
  );

  it('ignores a cancel once Phase B settled the setup', async () => {
    const [workspaceId, worktreeId] = worktree();
    const settle = beginWorktreeGitSetup(workspaceId, worktreeId);
    settle('failed');
    settleWorktreeGitSetup(workspaceId, worktreeId, 'cancelled');
    await expect(claimWorktreeGitSetup(workspaceId, worktreeId)).resolves.toBe(
      'failed',
    );
  });

  it.each(['failed', 'cancelled'] as const)(
    'forgets a setup that ended %s once a repair readies the worktree',
    async (outcome) => {
      const [workspaceId, worktreeId] = worktree();
      const settle = beginWorktreeGitSetup(workspaceId, worktreeId);
      const waited = waitForWorktreeGitSetup(workspaceId, worktreeId);
      settle(outcome);

      settleWorktreeGitSetup(workspaceId, worktreeId, 'ready');

      // Whoever already waited saw how setup ended; a send or launch into
      // the repaired worktree has nothing left to wait for.
      await expect(waited).resolves.toBe(outcome);
      expect(claimWorktreeGitSetup(workspaceId, worktreeId)).toBeUndefined();
      expect(waitForWorktreeGitSetup(workspaceId, worktreeId)).toBeUndefined();
    },
  );

  it('settles a still-pending setup cancelled when its worktree is torn down', async () => {
    const [workspaceId, worktreeId] = worktree();
    beginWorktreeGitSetup(workspaceId, worktreeId);
    const claimed = claimWorktreeGitSetup(workspaceId, worktreeId);

    endWorktreeGitSetup(workspaceId, worktreeId);

    await expect(claimed).resolves.toBe('cancelled');
    expect(claimWorktreeGitSetup(workspaceId, worktreeId)).toBeUndefined();
  });

  it('waits for a setup without claiming it', async () => {
    const [workspaceId, worktreeId] = worktree();
    const settle = beginWorktreeGitSetup(workspaceId, worktreeId);
    const waited = waitForWorktreeGitSetup(workspaceId, worktreeId);

    settle('failed');

    await expect(waited).resolves.toBe('failed');
    // The send that follows still claims the outcome and ends with it.
    await expect(claimWorktreeGitSetup(workspaceId, worktreeId)).resolves.toBe(
      'failed',
    );
    expect(waitForWorktreeGitSetup(workspaceId, worktreeId)).toBeUndefined();
  });

  it('settles every waiter on one worktree setup', async () => {
    const [workspaceId, worktreeId] = worktree();
    const settle = beginWorktreeGitSetup(workspaceId, worktreeId);
    const waiters = [
      claimWorktreeGitSetup(workspaceId, worktreeId),
      claimWorktreeGitSetup(workspaceId, worktreeId),
      waitForWorktreeGitSetup(workspaceId, worktreeId),
    ].filter(
      (waiter): waiter is Promise<WorktreeGitSetupOutcome> =>
        waiter !== undefined,
    );

    settle('ready');

    await expect(Promise.all(waiters)).resolves.toEqual([
      'ready',
      'ready',
      'ready',
    ]);
  });
});
