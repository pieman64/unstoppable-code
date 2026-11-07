import type { JSX } from 'react';
import { SidebarProjectVisibilityMenuItems as SharedVisibilityItems } from '@canopy/ui-shared/components';
import { ProjectIcon } from '../shared/ProjectIcon';
import type { SidebarWorkspaceFilterOption } from './sidebarWorkspacesDerivation';

export interface SidebarProjectVisibilityMenuItemsProps {
  options: SidebarWorkspaceFilterOption[];
  hiddenWorkspaceIds: string[];
  onChange: (hiddenWorkspaceIds: string[]) => void;
}

export function SidebarProjectVisibilityMenuItems({
  options,
  hiddenWorkspaceIds,
  onChange,
}: SidebarProjectVisibilityMenuItemsProps): JSX.Element | null {
  return (
    <SharedVisibilityItems
      hiddenWorkspaceIds={hiddenWorkspaceIds}
      onChange={onChange}
      options={options.map((option) => ({
        ...option,
        icon: (
          <ProjectIcon
            kind={option.kind}
            color={option.color}
            temporary={option.temporary}
            repoPath={option.repoPath}
            size="sm"
          />
        ),
      }))}
    />
  );
}
