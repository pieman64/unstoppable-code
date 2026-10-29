import type { SidebarItem } from '@canopy/desktop-shared/types';

/** Workspace choice offered by the shared-automation install wizard. */
export interface InstallWorkspaceOption {
  id: string;
  name: string;
  type: SidebarItem['type'];
}

/**
 * Project rows → install-wizard workspace options.
 *
 * Both entry points into the wizard — the Automations page's Shared tab and
 * the public-share landing modal — must offer the identical list, so the
 * mapping lives here rather than inline at either call site.
 */
export function toInstallWorkspaceOptions(
  projects: { id: string; name: string; type: SidebarItem['type'] }[],
): InstallWorkspaceOption[] {
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    type: project.type,
  }));
}
