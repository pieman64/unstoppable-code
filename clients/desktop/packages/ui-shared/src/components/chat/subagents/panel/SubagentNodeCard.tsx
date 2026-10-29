import { memo, type JSX } from 'react';
import type { SubagentNode } from '@canopy/agent-transcript';
import {
  subagentStatusDetail,
  subagentWorkspaceShortLabel,
} from '../subagent-copy';
import type { SubagentChangeTotals } from '../types';
import { SubagentChangesLabel } from '../common/SubagentChangesLabel';
import { SubagentHarnessMark } from '../common/SubagentHarnessMark';
import {
  SubagentStatusGlyph,
  subagentStatusInk,
} from '../common/SubagentStatusGlyph';

/** Props for the non-interactive canvas/list card that represents one task. */
export interface SubagentNodeCardProps {
  /** The normalized subagent represented by this card. */
  readonly node: SubagentNode;
  /** Whether the inspector currently describes this task. */
  readonly selected?: boolean;
  /** Whether workspace and change metadata is available on this surface. */
  readonly showWorkspaceDetails?: boolean;
  /** Optional, already-authorized worktree totals. */
  readonly changeTotals?: SubagentChangeTotals;
}

function cardShell(selected: boolean): string {
  return `flex h-full w-full min-w-0 flex-col justify-center gap-1 rounded-lg border bg-card px-2.5 py-1.5 text-left ${selected ? 'border-line-accent ring-2 ring-line-accent/30' : ''}`;
}

/** Pure display for a task card. Clicks belong to the diagram wrapper. */
export const SubagentNodeCard = memo(function SubagentNodeCard({
  node,
  selected = false,
  showWorkspaceDetails = true,
  changeTotals,
}: SubagentNodeCardProps): JSX.Element {
  const provider = subagentWorkspaceShortLabel(node);
  const workspace = showWorkspaceDetails ? provider : null;

  return (
    <div className={cardShell(selected)}>
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <SubagentStatusGlyph status={node.status} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium fg-primary">
          {node.title}
        </span>
      </span>
      <span className="flex w-full min-w-0 items-center gap-1.5 text-2xs">
        <span
          className={`min-w-0 flex-1 truncate ${subagentStatusInk(node.status)}`}
        >
          {subagentStatusDetail(node)}
        </span>
        {showWorkspaceDetails && changeTotals ? (
          <span className="inline-flex shrink-0 items-center gap-1">
            <SubagentChangesLabel
              additions={changeTotals.additions}
              deletions={changeTotals.deletions}
            />
          </span>
        ) : null}
      </span>
      <span className="flex w-full min-w-0 items-center gap-1.5 text-2xs fg-secondary">
        <SubagentHarnessMark harnessId={node.harnessId} />
        <span className="min-w-0 truncate">{node.modelLabel ?? ''}</span>
        {workspace ? (
          <span className="ml-auto shrink-0 truncate fg-tertiary">
            {workspace}
          </span>
        ) : null}
      </span>
    </div>
  );
});

SubagentNodeCard.displayName = 'SubagentNodeCard';
