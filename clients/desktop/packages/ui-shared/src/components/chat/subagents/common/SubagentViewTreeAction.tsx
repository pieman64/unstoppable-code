import type { JSX } from 'react';
import { HeaderActionButton } from '../../../HeaderActionButton';
import { SubagentIcon } from './SubagentIcon';

export const SUBAGENT_VIEW_TREE_LABEL = 'View tree';

export interface SubagentViewTreeActionProps {
  readonly onClick: () => void;
  readonly dataTestId?: string;
}

/** Shared chat-header action for opening the current chat's subagent tree. */
export function SubagentViewTreeAction({
  onClick,
  dataTestId = 'agent-activity-view-tree',
}: SubagentViewTreeActionProps): JSX.Element {
  return (
    <HeaderActionButton
      tone="neutral"
      data-testid={dataTestId}
      onClick={onClick}
    >
      <SubagentIcon size={14} />
      {SUBAGENT_VIEW_TREE_LABEL}
    </HeaderActionButton>
  );
}
