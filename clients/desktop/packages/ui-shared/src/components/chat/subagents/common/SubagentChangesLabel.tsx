import type { JSX } from 'react';
import { subagentChangesAccessibleLabel } from '../subagent-copy';

export interface SubagentChangesLabelProps {
  readonly additions: number;
  readonly deletions: number;
}

/** `+12 -3` in the diff colors, with a spoken equivalent. */
export function SubagentChangesLabel({
  additions,
  deletions,
}: SubagentChangesLabelProps): JSX.Element {
  return (
    <span
      className="shrink-0 font-mono tabular-nums"
      aria-label={subagentChangesAccessibleLabel(additions, deletions)}
    >
      <span className="fg-success" aria-hidden>
        +{additions}
      </span>{' '}
      <span className="fg-destructive" aria-hidden>
        -{deletions}
      </span>
    </span>
  );
}
