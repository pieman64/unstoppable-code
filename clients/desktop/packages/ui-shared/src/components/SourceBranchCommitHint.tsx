import type { JSX } from 'react';
import { SOURCE_NO_COMMITS_HINT } from '../lib/worktree-failure-copy';

/** Advisory source state, shared by ordinary and first-run import rows. */
export function SourceBranchCommitHint({
  headUnborn,
  testId,
  leadingSeparator = false,
  className,
}: {
  headUnborn?: boolean;
  testId?: string;
  leadingSeparator?: boolean;
  className?: string;
}): JSX.Element | null {
  if (headUnborn !== true) return null;
  return (
    <span className={className} data-testid={testId}>
      {leadingSeparator ? '· ' : ''}
      {SOURCE_NO_COMMITS_HINT}
    </span>
  );
}
