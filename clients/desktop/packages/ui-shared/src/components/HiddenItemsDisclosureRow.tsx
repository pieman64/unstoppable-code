import type { JSX } from 'react';
import { ChevronDownMediumIcon } from '../icons/AppIcons';
import { WorkspaceSectionHeader } from './WorkspaceSectionHeader';

export interface HiddenItemsDisclosureRowProps {
  readonly label: string;
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly dataTestId?: string;
  readonly touchTarget?: boolean;
}

/**
 * Hidden workspace/worktree disclosure using the same row primitive as every
 * workspace header. This keeps its icon slot, typography, hover surface, and
 * trailing counter aligned with the surrounding project rows.
 */
export function HiddenItemsDisclosureRow({
  label,
  count,
  expanded,
  onToggle,
  dataTestId,
  touchTarget = false,
}: HiddenItemsDisclosureRowProps): JSX.Element {
  return (
    <WorkspaceSectionHeader
      name={label}
      workspaceType="single-repo"
      worktreeCount={count}
      textScale="sidebar"
      collapsed={!expanded}
      canToggleCollapse={count > 0}
      disableDrag
      showCollapseChevron={false}
      onToggleCollapse={onToggle}
      primaryButtonDataAttrs={
        dataTestId ? { 'data-testid': dataTestId } : undefined
      }
      touchTarget={touchTarget}
      dragHandleSlot={
        <span
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center fg-secondary"
          aria-hidden="true"
          data-hidden-items-disclosure-icon=""
        >
          <ChevronDownMediumIcon
            size={16}
            className={expanded ? undefined : '-rotate-90'}
          />
        </span>
      }
    />
  );
}
