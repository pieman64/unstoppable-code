import type { JSX } from 'react';
import {
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuItemTrailing,
  DropdownMenuLabel,
} from '@canopy/ui-shared/components';
import { CheckIcon } from '@canopy/ui-shared/icons/AppIcons';
import { ProjectIcon } from '../shared/ProjectIcon';
import type { SidebarWorkspaceFilterOption } from './sidebarWorkspacesDerivation';

export interface SidebarProjectVisibilityMenuItemsProps {
  /** Every project the section can show, in sidebar order. */
  options: SidebarWorkspaceFilterOption[];
  /** Ids currently hidden from the section. */
  hiddenWorkspaceIds: string[];
  onChange: (hiddenWorkspaceIds: string[]) => void;
}

/**
 * The "Show projects" group inside the Projects header menu.
 *
 * Project visibility used to live behind its own "…" beside the section's
 * overflow menu, which put two identical triggers a few pixels apart. It is
 * now one group in the single header menu, the way the Chats header already
 * gathers its actions. Rows are checkboxes rather than commands: the menu
 * stays open while several projects are toggled (the host sets
 * `closeOnSelect={false}`). The group renders only when there is more than
 * one project to choose between.
 */
export function SidebarProjectVisibilityMenuItems({
  options,
  hiddenWorkspaceIds,
  onChange,
}: SidebarProjectVisibilityMenuItemsProps): JSX.Element | null {
  // With a single project there is nothing to choose between, and hiding the
  // only row would strand it in the collapsed hidden group.
  if (options.length < 2) return null;
  const hidden = new Set(hiddenWorkspaceIds);

  const toggle = (workspaceId: string): void => {
    const next = new Set(hidden);
    if (next.has(workspaceId)) next.delete(workspaceId);
    else next.add(workspaceId);
    onChange(Array.from(next));
  };

  return (
    <>
      <DropdownMenuDivider />
      <DropdownMenuLabel>Show projects</DropdownMenuLabel>
      {options.map((option) => {
        const visible = !hidden.has(option.id);
        return (
          <DropdownMenuItem
            key={option.id}
            role="menuitemcheckbox"
            aria-checked={visible}
            data-testid={`sidebar-projects-show-${option.id}`}
            onClick={(): void => toggle(option.id)}
          >
            <DropdownMenuItemIcon
              data-testid={`sidebar-projects-show-check-${option.id}`}
            >
              {visible ? <CheckIcon /> : null}
            </DropdownMenuItemIcon>
            <DropdownMenuItemIcon
              data-testid={`sidebar-projects-show-icon-${option.id}`}
            >
              <ProjectIcon
                kind={option.kind}
                color={option.color}
                temporary={option.temporary}
                repoPath={option.repoPath}
                size="sm"
              />
            </DropdownMenuItemIcon>
            <span
              className="min-w-0 flex-1 truncate"
              data-testid={`sidebar-projects-show-label-${option.id}`}
            >
              {option.name}
            </span>
            <DropdownMenuItemTrailing
              data-testid={`sidebar-projects-show-count-${option.id}`}
            >
              {option.worktreeCount}
            </DropdownMenuItemTrailing>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
