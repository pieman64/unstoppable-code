import type { JSX } from 'react';
import { subagentRunDividerLabel } from '../subagent-copy';

export interface SubagentRunDividerProps {
  readonly runGeneration: number;
}

/** Marks the beginning of a later run of the same subagent. */
export function SubagentRunDivider({
  runGeneration,
}: SubagentRunDividerProps): JSX.Element {
  return (
    <div className="flex items-center gap-3 text-2xs fg-tertiary">
      <span className="h-px flex-1 bg-line-base" />
      {subagentRunDividerLabel(runGeneration)}
      <span className="h-px flex-1 bg-line-base" />
    </div>
  );
}
