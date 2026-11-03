export type WorktreeGitSetupOutcome = 'ready' | 'cancelled' | 'failed';

interface WorktreeGitSetup {
  readonly outcome: Promise<WorktreeGitSetupOutcome>;
  readonly settle: (outcome: WorktreeGitSetupOutcome) => void;
  settled?: WorktreeGitSetupOutcome;
  claimed: boolean;
  tornDown: boolean;
}

const setups = new Map<string, WorktreeGitSetup>();

function setupKey(workspaceId: string, worktreeId: string): string {
  return `${workspaceId}\u0000${worktreeId}`;
}

function forgetIfDone(key: string, setup: WorktreeGitSetup): void {
  if (
    setups.get(key) === setup &&
    setup.settled !== undefined &&
    (setup.settled === 'ready' || setup.claimed || setup.tornDown)
  ) {
    setups.delete(key);
  }
}

/**
 * Records a worktree whose Git setup runs after its reservation is
 * returned. The returned function settles it exactly once. A setup that
 * fails or is cancelled is kept until a send claims it or the worktree is
 * torn down; one that is ready is forgotten.
 */
export function beginWorktreeGitSetup(
  workspaceId: string,
  worktreeId: string,
): (outcome: WorktreeGitSetupOutcome) => void {
  const key = setupKey(workspaceId, worktreeId);
  let resolve: (outcome: WorktreeGitSetupOutcome) => void = () => undefined;
  const outcome = new Promise<WorktreeGitSetupOutcome>((done) => {
    resolve = done;
  });
  const setup: WorktreeGitSetup = {
    outcome,
    settle: (settled) => {
      if (setup.settled !== undefined) return;
      setup.settled = settled;
      forgetIfDone(key, setup);
      resolve(settled);
    },
    claimed: false,
    tornDown: false,
  };
  setups.set(key, setup);
  return setup.settle;
}

/**
 * Settles the worktree's current Git setup when something other than its
 * deferred Phase B decides the outcome, such as a needs-repair detour that
 * the user completes. A no-op when no setup is pending, except that a repair
 * readying a worktree whose setup already ended unready forgets that
 * outcome: the repaired worktree has nothing left for a send to wait on.
 */
export function settleWorktreeGitSetup(
  workspaceId: string,
  worktreeId: string,
  outcome: WorktreeGitSetupOutcome,
): void {
  const key = setupKey(workspaceId, worktreeId);
  const setup = setups.get(key);
  if (!setup) return;
  if (setup.settled !== undefined) {
    if (outcome === 'ready') setups.delete(key);
    return;
  }
  setup.settle(outcome);
}

/**
 * The outcome of a worktree's Git setup that something must wait for
 * without ending it, such as a terminal launch that a send may follow.
 * Unlike {@link claimWorktreeGitSetup} it leaves a failed or cancelled
 * outcome for the send to claim. Undefined when there is none.
 */
export function waitForWorktreeGitSetup(
  workspaceId: string,
  worktreeId: string,
): Promise<WorktreeGitSetupOutcome> | undefined {
  return setups.get(setupKey(workspaceId, worktreeId))?.outcome;
}

/**
 * The outcome of a worktree's Git setup that a send must wait for and end
 * with: one still running in this process, or one that failed or was
 * cancelled and that no send has claimed yet. Undefined when there is none.
 * Synchronous.
 */
export function claimWorktreeGitSetup(
  workspaceId: string,
  worktreeId: string,
): Promise<WorktreeGitSetupOutcome> | undefined {
  const key = setupKey(workspaceId, worktreeId);
  const setup = setups.get(key);
  if (!setup) return undefined;
  setup.claimed = true;
  forgetIfDone(key, setup);
  return setup.outcome;
}

/**
 * Forgets the worktree's Git setup when it is torn down. A setup still
 * pending, such as one waiting on a repair the user dismissed, settles
 * cancelled so nothing waits on it forever.
 */
export function endWorktreeGitSetup(
  workspaceId: string,
  worktreeId: string,
): void {
  const key = setupKey(workspaceId, worktreeId);
  const setup = setups.get(key);
  if (!setup) return;
  setup.tornDown = true;
  setup.settle('cancelled');
  forgetIfDone(key, setup);
}
