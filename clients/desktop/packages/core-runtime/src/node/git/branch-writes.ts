import {
  occupiedGitWorktreeBranches,
  parseGitWorktreeListPorcelain,
} from './branch-list';

/**
 * The Git reads and effects one checkout's branch checkout and creation run,
 * each named by the command the desktop runs for it. Hosts supply their own
 * runners and environments; the effects are never aborted once started. Any
 * member may reject with {@link GitBranchWriteInterrupted}, which the policy
 * never reads as an answer.
 */
export interface GitBranchWritePort {
  /** `status --porcelain --untracked-files=normal` printed anything. */
  hasUncommittedChanges(this: void): Promise<boolean>;
  /**
   * `worktree list --porcelain` in the main repository root. Any rejection
   * other than {@link GitBranchWriteInterrupted} reads as no occupied branch.
   */
  readWorktreeList(
    this: void,
  ): Promise<{ output: string; checkoutPath: string }>;
  /** `show-ref --verify --quiet refs/heads/<branch>` exited 0. */
  localBranchExists(this: void, branch: string): Promise<boolean>;
  /** `show-ref --verify --quiet refs/remotes/origin/<branch>` exited 0. */
  remoteBranchExists(this: void, branch: string): Promise<boolean>;
  /**
   * `fetch --no-tags origin refs/heads/<branch>:refs/remotes/origin/<branch>`,
   * non-interactive and bounded; rejects when Git fails.
   */
  fetchRemoteBranch(this: void, branch: string): Promise<void>;
  /** `check-ref-format --branch <name>` exited 0. */
  isValidBranchName(this: void, name: string): Promise<boolean>;
  /** Stdout of `for-each-ref --format=%(refname) refs/heads/<name>/`. */
  listLocalBranchesUnder(this: void, name: string): Promise<string>;
  /** `rev-parse --abbrev-ref HEAD`. */
  currentBranch(this: void): Promise<string>;
  /** Effect: `checkout <branch>`. */
  checkout(this: void, branch: string): Promise<void>;
  /** Effect: `checkout -b <name> <startPoint>`. */
  checkoutNewBranch(
    this: void,
    name: string,
    startPoint: string,
  ): Promise<void>;
  /** Effect: `branch -m <name>`, renaming the current branch. */
  renameCurrentBranch(this: void, name: string): Promise<void>;
}

/**
 * The Git read and effects one recorded repository's branch delete runs,
 * each named by the command the desktop runs for it. Effects are never
 * aborted once started; any member may reject with
 * {@link GitBranchWriteInterrupted}.
 */
export interface GitBranchDeletePort {
  /**
   * `worktree list --porcelain` in the repository, as
   * {@link parseGitCheckedOutBranches} reads it; rejects when Git fails.
   */
  listCheckedOutBranches(this: void): Promise<ReadonlyMap<string, string>>;
  /** Effect: `branch -d <branch>`, or `branch -D <branch>` when `force`. */
  deleteBranch(this: void, branch: string, force: boolean): Promise<void>;
  /** Effect: `update-ref -d refs/heads/<branch> <tip>`. */
  deleteBranchRef(this: void, branch: string, tip: string): Promise<void>;
}

export type GitBranchWriteRefusalReason =
  | 'uncommitted-changes'
  | 'branch-occupied'
  | 'branch-not-found'
  | 'invalid-name'
  | 'invalid-start-point'
  | 'name-unavailable'
  | 'checked-out'
  | 'head-changed';

/**
 * A refusal before any effect, carrying the desktop's message unchanged so
 * its compatibility projections answer as before. It keeps the name `Error`:
 * Electron's IPC rejection prints it ahead of the message.
 */
export class GitBranchWriteRefusal extends Error {
  public readonly reason: GitBranchWriteRefusalReason;
  /** The message a protocol caller sees: never a host path. */
  public readonly publicMessage: string;

  public constructor(
    reason: GitBranchWriteRefusalReason,
    message: string,
    publicMessage: string = message,
  ) {
    super(message);
    this.reason = reason;
    this.publicMessage = publicMessage;
  }
}

/**
 * A port read or probe that did not complete because the request was
 * cancelled or the host is unavailable. Unlike a failed Git answer, it is
 * never read as "no" or skipped as best effort: the change stops before any
 * later effect.
 */
export class GitBranchWriteInterrupted extends Error {
  public readonly reason: 'cancelled' | 'unavailable';
  /** The host's own failure, kept for diagnostics. */
  public readonly hostCause: unknown;

  public constructor(
    reason: 'cancelled' | 'unavailable',
    message: string,
    hostCause?: unknown,
  ) {
    super(message);
    this.name = 'GitBranchWriteInterrupted';
    this.reason = reason;
    this.hostCause = hostCause;
  }
}

/** Rethrows an interruption; any other failure is the caller's best effort. */
function rethrowInterrupted(error: unknown): void {
  if (error instanceof GitBranchWriteInterrupted) throw error;
}

/** The message a compare-and-swap head mismatch carries (docs/ux-writing.md). */
export const GIT_BRANCH_HEAD_CHANGED_MESSAGE =
  'The branch changed since this was shown. Check the latest status and try again.';

export interface GitBranchWriteOptions {
  /** Refuse unless this branch is checked out right before the effect. */
  readonly expectedBranch?: string;
}

/** `<name>-<n>`, keeping the whole name within 100 characters. */
export function appendBranchSuffix(
  branchName: string,
  suffixNumber: number,
): string {
  const suffix = `-${suffixNumber}`;
  const maxBaseLength = Math.max(1, 100 - suffix.length);
  return `${branchName.slice(0, maxBaseLength)}${suffix}`;
}

/** `a`, `a/b` for `a/b/c`: the names a branch's directories would shadow. */
export function parentBranchNames(branchName: string): string[] {
  const branchSegments = branchName.split('/').filter(Boolean);
  const names: string[] = [];
  let prefix = '';
  for (const segment of branchSegments.slice(0, -1)) {
    prefix = prefix.length > 0 ? `${prefix}/${segment}` : segment;
    names.push(prefix);
  }
  return names;
}

/** The reads that decide whether a new branch name is free. */
export interface GitBranchNameReads {
  localBranchExists(this: void, branch: string): Promise<boolean>;
  listLocalBranchesUnder(this: void, name: string): Promise<string>;
}

/**
 * Whether `branchName` collides with a branch hierarchy: a branch under
 * `<name>/` exists, or a parent name is itself a branch. Git stores refs as
 * files and directories, so a name cannot be both.
 */
export async function hasGitBranchRefConflict(
  reads: GitBranchNameReads,
  branchName: string,
): Promise<boolean> {
  try {
    if ((await reads.listLocalBranchesUnder(branchName)).length > 0)
      return true;
  } catch (error) {
    // Best effort. Fall through to the parent checks.
    rethrowInterrupted(error);
  }
  for (const parent of parentBranchNames(branchName))
    if (await reads.localBranchExists(parent)) return true;
  return false;
}

/** Whether no local branch has `branchName` and no hierarchy shadows it. */
export async function isGitBranchNameFree(
  reads: GitBranchNameReads,
  branchName: string,
): Promise<boolean> {
  return (
    !(await reads.localBranchExists(branchName)) &&
    !(await hasGitBranchRefConflict(reads, branchName))
  );
}

/**
 * `branchName` when it is free, else the first free `-2`…`-100` suffix, else
 * `branchName` unchanged (Git then reports the collision).
 */
export async function selectAvailableGitBranchName(
  reads: GitBranchNameReads,
  branchName: string,
): Promise<string> {
  if (await isGitBranchNameFree(reads, branchName)) return branchName;
  for (let index = 2; index <= 100; index++) {
    const candidate = appendBranchSuffix(branchName, index);
    if (await reads.localBranchExists(candidate)) continue;
    if (await hasGitBranchRefConflict(reads, candidate)) continue;
    return candidate;
  }
  return branchName;
}

async function occupiedBranches(
  port: GitBranchWritePort,
): Promise<ReadonlySet<string>> {
  try {
    const { output, checkoutPath } = await port.readWorktreeList();
    return occupiedGitWorktreeBranches(
      parseGitWorktreeListPorcelain(output),
      checkoutPath,
    );
  } catch (error) {
    rethrowInterrupted(error);
    return new Set<string>();
  }
}

async function assertExpectedHead(
  port: GitBranchWritePort,
  options: GitBranchWriteOptions,
): Promise<void> {
  if (
    options.expectedBranch !== undefined &&
    (await port.currentBranch()) !== options.expectedBranch
  )
    throw new GitBranchWriteRefusal(
      'head-changed',
      GIT_BRANCH_HEAD_CHANGED_MESSAGE,
    );
}

/**
 * Checks out `branch` in a clean checkout: the local branch, else a new branch
 * tracking `origin/<branch>`, fetching that one branch first when the checkout
 * has no remote-tracking ref for it. A branch another worktree holds is
 * refused. The expected head is checked right before the effect.
 */
export async function checkoutGitBranch(
  port: GitBranchWritePort,
  branch: string,
  options: GitBranchWriteOptions = {},
): Promise<void> {
  if (await port.hasUncommittedChanges())
    throw new GitBranchWriteRefusal(
      'uncommitted-changes',
      'Cannot switch branches with uncommitted changes',
    );
  if ((await occupiedBranches(port)).has(branch))
    throw new GitBranchWriteRefusal(
      'branch-occupied',
      `Branch "${branch}" is already checked out in another worktree`,
    );
  if (await port.localBranchExists(branch)) {
    await assertExpectedHead(port, options);
    await port.checkout(branch);
    return;
  }
  const remote =
    (await port.remoteBranchExists(branch)) ||
    (await port.fetchRemoteBranch(branch).then(
      () => port.remoteBranchExists(branch),
      (error: unknown) => {
        rethrowInterrupted(error);
        return false;
      },
    ));
  if (remote) {
    await assertExpectedHead(port, options);
    await port.checkoutNewBranch(branch, `origin/${branch}`);
    return;
  }
  throw new GitBranchWriteRefusal(
    'branch-not-found',
    `Branch "${branch}" was not found`,
  );
}

/**
 * Creates `name` at `startPoint` and checks it out in a clean checkout. The
 * name must pass `check-ref-format --branch`; a taken name gets the first
 * free suffix. Returns the name created.
 */
export async function createGitBranch(
  port: GitBranchWritePort,
  name: string,
  startPoint: string,
  options: GitBranchWriteOptions = {},
): Promise<string> {
  if (await port.hasUncommittedChanges())
    throw new GitBranchWriteRefusal(
      'uncommitted-changes',
      'Cannot create a branch with uncommitted changes',
    );
  if (!(await port.isValidBranchName(name)))
    throw new GitBranchWriteRefusal(
      'invalid-name',
      `Invalid branch name: "${name}"`,
    );
  const resolved = await selectAvailableGitBranchName(port, name);
  await assertExpectedHead(port, options);
  await port.checkoutNewBranch(resolved, startPoint);
  return resolved;
}

/**
 * The trimmed new name and start point the desktop's create dialog sends,
 * refused as before when empty or option-like. `remote` starts at
 * `origin/<branch>`.
 */
export function gitBranchCreateRequest(
  name: string,
  startPoint: { readonly branch: string; readonly remote: boolean },
): { name: string; startPoint: string } {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.startsWith('-'))
    throw new GitBranchWriteRefusal('invalid-name', 'Invalid new branch name');
  const base = startPoint.branch.trim();
  if (!base || base.startsWith('-'))
    throw new GitBranchWriteRefusal(
      'invalid-start-point',
      'Invalid base branch',
    );
  return {
    name: trimmedName,
    startPoint: startPoint.remote ? `origin/${base}` : base,
  };
}

/**
 * Renames the checkout's current branch to `name`: the name must pass
 * `check-ref-format --branch` and be free, and the expected head is checked
 * right before the effect. Uncommitted changes do not block it.
 */
export async function renameGitBranch(
  port: GitBranchWritePort,
  name: string,
  options: GitBranchWriteOptions = {},
): Promise<void> {
  if (!(await port.isValidBranchName(name)))
    throw new GitBranchWriteRefusal(
      'invalid-name',
      `Invalid branch name: "${name}"`,
    );
  if (!(await isGitBranchNameFree(port, name)))
    throw new GitBranchWriteRefusal(
      'name-unavailable',
      `Branch name "${name}" is already in use`,
    );
  await assertExpectedHead(port, options);
  await port.renameCurrentBranch(name);
}

/**
 * Each branch `worktree list --porcelain` shows checked out, with the
 * worktree path that lists it last: the desktop's reading, unchanged.
 */
export function parseGitCheckedOutBranches(
  output: string,
): Map<string, string> {
  const result = new Map<string, string>();
  let currentPath: string | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim();
      continue;
    }
    if (line.startsWith('branch refs/heads/') && currentPath)
      result.set(line.slice('branch refs/heads/'.length).trim(), currentPath);
  }
  return result;
}

/** How {@link deleteGitBranch} deletes, as `worker.git.branch.delete` names it. */
export type GitBranchDeletion =
  | { readonly kind: 'merged' }
  | { readonly kind: 'force' }
  | { readonly kind: 'tip'; readonly tip: string };

/**
 * Deletes local branch `branch`. `merged` and `force` run `branch -d` and
 * `branch -D`, which Git refuses for a checked-out branch itself. `tip`
 * refuses a branch any worktree has checked out, then deletes the ref only
 * while it still points at `tip`. Git's own refusals reject as Git errors.
 */
export async function deleteGitBranch(
  port: GitBranchDeletePort,
  branch: string,
  deletion: GitBranchDeletion,
): Promise<void> {
  if (deletion.kind !== 'tip') {
    await port.deleteBranch(branch, deletion.kind === 'force');
    return;
  }
  const checkedOutPath = (await port.listCheckedOutBranches()).get(branch);
  if (checkedOutPath)
    throw new GitBranchWriteRefusal(
      'checked-out',
      `Cannot delete branch "${branch}" because it is checked out at ${checkedOutPath}`,
      `Branch "${branch}" is checked out in a worktree.`,
    );
  await port.deleteBranchRef(branch, deletion.tip);
}

/** A branch name a delete may run with: never empty, an option, or NUL-bearing. */
export function gitBranchDeleteName(branch: string): string {
  if (!branch || branch.startsWith('-') || branch.includes('\0'))
    throw new GitBranchWriteRefusal('invalid-name', 'Invalid branch name');
  return branch;
}
