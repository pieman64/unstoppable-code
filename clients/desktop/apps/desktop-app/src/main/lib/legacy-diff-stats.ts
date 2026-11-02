// The `worktree:diff-stats` and `worktree:diff-stats-batch` compatibility
// projection (CAN-4103). The untracked share is rebuilt from the engine's
// `-z` listing as the legacy `ls-files` printed it: quoted per the
// repository's `core.quotePath`, newline-separated, trimmed and cut at 200
// names, so names Git quoted or runGit trimmed still count as unreadable. The
// tracked totals are the legacy `--shortstat`'s. It sums the same per-file
// counts as `--numstat` but pairs files by the repository's `diff.renames`,
// so the engine's numstat sum stands in for it only when no pairing could
// differ; otherwise the projection reads it (recorded debt).
import type { DiffStats } from '@canopy/desktop-shared/types';
import {
  parseGitNameStatusZ,
  parseGitNumstatZ,
  parseGitPathListZ,
  type GitChangeSetSample,
  type GitReadOutcome,
} from '@canopy/core-runtime/node/git';
import { parseDiffShortstat } from './git';
import {
  legacyEstimate,
  legacyOutput,
  quoteGitPath,
} from './legacy-changed-files';
import { MAX_UNTRACKED_FILES } from './untracked-line-estimate';

/** The legacy-only reads beside one `<base>..WORKTREE` sample. */
export interface LegacyDiffStatsReads {
  /**
   * `git diff <base> --shortstat`, trimmed as runGit returns it; read only
   * when the sample's counts cannot stand in for it.
   */
  readonly shortstat: () => Promise<GitReadOutcome>;
  /**
   * The `core.quotePath` the listing applied; `null` when Git refused the
   * configuration, so the listing failed.
   */
  readonly quotePath: boolean | null;
}

/** `getDiffStatsAgainst(repoPath, base)` from that sample and its reads. */
export async function legacyDiffStats(
  repoPath: string,
  sample: GitChangeSetSample,
  { shortstat, quotePath }: LegacyDiffStatsReads,
): Promise<DiffStats> {
  const totals = sampleShortstatTotals(sample) ?? (await readTotals(shortstat));
  const untrackedOutput =
    quotePath === null
      ? ''
      : legacyOutput(sample.untracked, (stdout) =>
          parseGitPathListZ(stdout).map((path) =>
            quoteGitPath(path, quotePath),
          ),
        );
  if (!untrackedOutput) return totals;
  const files = untrackedOutput
    .split('\n')
    .filter(Boolean)
    .slice(0, MAX_UNTRACKED_FILES);
  const estimates = await legacyEstimate(sample)(repoPath, files);
  return {
    insertions: estimates.reduce(
      (total, estimate) => total + estimate.insertions,
      totals.insertions,
    ),
    deletions: totals.deletions,
  };
}

async function readTotals(
  shortstat: LegacyDiffStatsReads['shortstat'],
): Promise<DiffStats> {
  const outcome = await shortstat();
  if (!outcome.ok) throw outcome.error;
  return parseDiffShortstat(outcome.stdout);
}

/**
 * Whether the engine's `-M -C` pairing of these changes might differ from the
 * legacy `--shortstat`'s, which follows `diff.renames`: a rename or copy, or
 * an add beside a delete that `-M` alone might pair (the copy sources can push
 * `-M -C` past `diff.renameLimit`).
 */
export function nameStatusNeedsShortstat(stdout: string): boolean {
  let added = false;
  let deleted = false;
  for (const { code } of parseGitNameStatusZ(stdout)) {
    if (code.startsWith('R') || code.startsWith('C')) return true;
    added ||= code.startsWith('A');
    deleted ||= code.startsWith('D');
  }
  return added && deleted;
}

/** The legacy `--shortstat` totals from the sample, when it can supply them. */
function sampleShortstatTotals(sample: GitChangeSetSample): DiffStats | null {
  const { nameStatus, numstat } = sample;
  if (!nameStatus.ok || !numstat.ok) return null;
  if (nameStatusNeedsShortstat(nameStatus.stdout)) return null;
  let insertions = 0;
  let deletions = 0;
  // Binary files read `-`, which `--shortstat` also leaves uncounted.
  for (const record of parseGitNumstatZ(numstat.stdout)) {
    // A pair name-status did not show: the checkout changed between reads.
    if (record.previousPath !== undefined) return null;
    insertions += Number.parseInt(record.added, 10) || 0;
    deletions += Number.parseInt(record.deleted, 10) || 0;
  }
  return { insertions, deletions };
}

/** Whether a listing names a path `core.quotePath` quotes differently. */
export function untrackedListingNeedsQuotePath(stdout: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[^\u0000-\u007f]/.test(stdout);
}
