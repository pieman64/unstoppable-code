import type { WorktreeRowPrStatus } from '../components/WorktreeRow';

type KnownPr = {
  state: WorktreeRowPrStatus['state'];
  prNumber?: number;
  prUrl?: string;
  title?: string;
};

/** Preserve terminal PR facts when no repository has an active PR. */
export function deriveTerminalPrBadgeStatus(
  statuses: readonly (KnownPr | null)[],
  isMultiRepo: boolean,
): WorktreeRowPrStatus | undefined {
  const known = statuses.filter((status) => status !== null);
  if (
    known.length === 0 ||
    known.some((status) => status.state === 'open' || status.state === 'draft')
  )
    return undefined;
  const state = known.every((status) => status.state === 'merged')
    ? 'merged'
    : 'closed';
  const first = known.find((status) => status.state === state) ?? known[0];
  const label = isMultiRepo
    ? `${known.length} ${known.length === 1 ? 'PR' : 'PRs'}`
    : first.prNumber === undefined
      ? 'Pull request'
      : `PR #${first.prNumber}`;
  return {
    state,
    label,
    title: isMultiRepo ? label : first.title,
    ...(isMultiRepo ? {} : { url: first.prUrl }),
  };
}
