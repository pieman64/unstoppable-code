export type WorktreeGitSetupOutcome = 'ready' | 'cancelled' | 'failed';

interface WorktreeGitSetup {
  readonly outcome: Promise<WorktreeGitSetupOutcome>;
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
  const setup: WorktreeGitSetup = {
    outcome: new Promise<WorktreeGitSetupOutcome>((done) => {
      resolve = done;
    }),
    claimed: false,
    tornDown: false,
  };
  setups.set(key, setup);
  return (outcome) => {
    if (setup.settled !== undefined) return;
    setup.settled = outcome;
    forgetIfDone(key, setup);
    resolve(outcome);
  };
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

export function endWorktreeGitSetup(
  workspaceId: string,
  worktreeId: string,
): void {
  const key = setupKey(workspaceId, worktreeId);
  const setup = setups.get(key);
  if (!setup) return;
  setup.tornDown = true;
  forgetIfDone(key, setup);
}
