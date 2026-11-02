import type {
  WorktreeDiscardDescription,
  WorktreeDiscardGitCleanup,
} from '@canopy/desktop-shared/types';

/**
 * CAN-5334: the one ruling on Git residue. The description and the executor
 * both map per-source facts through `gitCleanupOutcomeOf`; the description
 * predicts the facts from the same read-only observation the executor makes,
 * so it never lists less than the cleanup it predicts leaves. Runtime changes
 * it cannot predict surface in the result.
 */

/** What a discard knows about the snapshot refs its staged descriptor names. */
export type GitRefEvidence =
  /** Read: it names refs for exactly these repositories. */
  | { state: 'read'; repoIds: readonly string[] }
  /** No descriptor: the container holds no snapshot refs. */
  | { state: 'absent' }
  /** Unreadable, or removed before its refs were deleted: any may remain. */
  | { state: 'unknown' };

/**
 * One repository's cleanup. `refs-unlisted`: its registrations were removed
 * where the source is now, but the unreadable descriptor could not name its
 * refs or say whether it recorded another repository.
 */
export type GitCleanupOutcome =
  | 'cleaned'
  | 'refs-unlisted'
  | 'skipped'
  | 'failed';

export const GIT_CLEANUP_OUTCOMES: readonly GitCleanupOutcome[] = [
  'cleaned',
  'refs-unlisted',
  'skipped',
  'failed',
];

export type GitResidue = WorktreeDiscardDescription['mayRemain'][number];

/** What a read-only look at one source shows, before any cleanup. */
export interface GitSourceObservation {
  /** Available at the Git common directory it was classified with. */
  reachable: boolean;
  /**
   * Every repository the descriptor records for this source under its own
   * snapshot ref is the one there now: the same Git common directory, holding
   * the recorded snapshot commit. Vacuously true when it records none.
   */
  recordedHere: boolean;
  /**
   * This repository registered this worktree: it holds Git's entry for one of
   * the worktree's checkout paths, or an earlier attempt of this discard
   * verified removing one here.
   */
  registered: boolean;
  /** Refs the descriptor names for this source. */
  refsNamed: number;
  /**
   * Of those, the ones that are not the snapshot ref the host derives for
   * this worktree and source: never read or deleted (review r8).
   */
  refsForeign: number;
  /** Of the others, the ones absent or at their recorded commit. */
  refsDeletable: number;
  /** A Git command failed while looking. */
  gitFailed: boolean;
}

/** What one source's cleanup observed and did. */
export interface GitCleanupFacts extends Omit<
  GitSourceObservation,
  'refsDeletable'
> {
  /** The registration removal ran to completion and left no entry for them. */
  registrationsRemoved: boolean;
  /** Named refs verified absent after the cleanup. */
  refsDeleted: number;
}

/** The cleanup only runs Git where the source is the recorded repository. */
export function gitCleanupRuns(observed: GitSourceObservation): boolean {
  return observed.reachable && observed.recordedHere && !observed.gitFailed;
}

/** The facts before the cleanup changes anything. */
export function gitCleanupFactsBefore(
  observed: GitSourceObservation,
): GitCleanupFacts {
  return {
    reachable: observed.reachable,
    recordedHere: observed.recordedHere,
    registered: observed.registered,
    refsNamed: observed.refsNamed,
    refsForeign: observed.refsForeign,
    gitFailed: observed.gitFailed,
    registrationsRemoved: false,
    refsDeleted: 0,
  };
}

/** A description's prediction: every mutating Git command succeeds. */
export function predictedGitCleanupFacts(
  observed: GitSourceObservation,
): GitCleanupFacts {
  const before = gitCleanupFactsBefore(observed);
  return gitCleanupRuns(observed)
    ? {
        ...before,
        registrationsRemoved: true,
        refsDeleted: observed.refsDeletable,
      }
    : before;
}

/**
 * The one mapping from facts to an outcome, for the description and the
 * executor alike. `cleaned` only when the descriptor was readable, this
 * repository is shown to be the worktree's, and every ref the descriptor
 * named was this worktree's own and verified deleted in it.
 */
export function gitCleanupOutcomeOf(
  evidence: GitRefEvidence,
  facts: GitCleanupFacts,
): GitCleanupOutcome {
  if (facts.gitFailed) return 'failed';
  if (!facts.reachable || !facts.recordedHere) return 'skipped';
  if (!facts.registrationsRemoved || facts.refsForeign > 0) return 'failed';
  if (evidence.state === 'unknown') return 'refs-unlisted';
  // Recording no repository for it, the descriptor ties nothing: only an
  // observed registration shows the worktree's metadata was here.
  if (facts.refsNamed === 0 && !facts.registered) return 'skipped';
  return facts.refsDeleted >= facts.refsNamed ? 'cleaned' : 'failed';
}

/** `cleaned` only when the refs the descriptor named were deleted. */
export function publicGitCleanupStatus(
  outcome: GitCleanupOutcome,
): WorktreeDiscardGitCleanup['status'] {
  return outcome === 'refs-unlisted' ? 'failed' : outcome;
}

/** What one repository may keep after `outcome`. */
export function gitResidueAfter(
  outcome: GitCleanupOutcome,
  evidence: GitRefEvidence,
  repoId: string,
): GitResidue[] {
  const ref: GitResidue = { kind: 'git-ref', repoId };
  const namesRef =
    evidence.state === 'unknown' ||
    (evidence.state === 'read' && evidence.repoIds.includes(repoId));
  switch (outcome) {
    case 'cleaned':
      return [];
    // The unreadable descriptor could not name its refs, nor say whether it
    // recorded another repository, whose registration may remain too.
    case 'refs-unlisted':
      return [{ kind: 'git-registration', repoId }, ref];
    case 'skipped':
    case 'failed':
      return [{ kind: 'git-registration', repoId }, ...(namesRef ? [ref] : [])];
  }
}

/**
 * The description's `mayRemain`: per source, a finished cleanup's recorded
 * outcome (a repository it did not record counts as `failed`), else the
 * predicted one.
 */
export function gitResidueOf(
  sources: readonly { repoId: string; facts: GitCleanupFacts }[],
  evidence: GitRefEvidence,
  recorded?: ReadonlyMap<string, GitCleanupOutcome>,
): GitResidue[] {
  return sources.flatMap((source) =>
    gitResidueAfter(
      recorded
        ? (recorded.get(source.repoId) ?? 'failed')
        : gitCleanupOutcomeOf(evidence, source.facts),
      evidence,
      source.repoId,
    ),
  );
}

/** The result warning for a repository whose cleanup did not finish. */
export function gitCleanupWarning(
  outcome: GitCleanupOutcome,
  repoId: string,
): string | null {
  return publicGitCleanupStatus(outcome) === 'failed'
    ? `Git metadata cleanup for repository ${repoId} did not finish; its registrations or refs may remain.`
    : null;
}
