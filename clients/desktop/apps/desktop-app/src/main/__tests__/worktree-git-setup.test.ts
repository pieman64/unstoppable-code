import {
  beginWorktreeGitSetup,
  claimWorktreeGitSetup,
  endWorktreeGitSetup,
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
});
