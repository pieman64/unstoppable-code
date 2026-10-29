import type { SidebarItemsFile } from '@canopy/desktop-shared/types';

export function getSidebarItemsPreserveWorkspaceIds(
  sidebarItems: Pick<SidebarItemsFile, 'warnings' | 'preservedWorkspaceIds'>,
): string[] {
  return Array.from(
    new Set([
      ...(sidebarItems.preservedWorkspaceIds ?? []),
      ...(sidebarItems.warnings ?? []).map((warning) => warning.workspaceId),
    ]),
  );
}
