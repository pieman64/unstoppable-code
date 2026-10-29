import type { SidebarItem } from '@canopy/desktop-shared/types';
import type { SlashCommandTriggerCharacter } from '@/hooks/useSlashCommands';
import { hasMultipleWorkspaces } from '@/lib/workspaceChoice';

export function getHomeSlashTriggerCharacters(
  isCodexProvider: boolean,
): readonly SlashCommandTriggerCharacter[] {
  return isCodexProvider ? ['/', '$'] : ['/'];
}

/**
 * True when there are no CODE workspaces (single-repo / multi-repo). Cowork
 * workspaces deliberately do not count: `ensureDefaultCoworkWorkspace`
 * (apps/desktop-app/src/main/lib/cowork-workspace-crud.ts) guarantees the
 * default Cowork entry always exists once the sidebar has hydrated, so a
 * predicate that counted cowork would never be true in practice.
 *
 * Drives first-run detection on the Overview page and mirrors
 * `WorktreeManager`'s `hasAnyRepositories` — the same "zero code workspaces"
 * condition the Code tab's zero-workspace empty state has always keyed on.
 * (The workspace-add onboarding anchor now lives on the sidebar Workspaces
 * "+" control, not a Home-surface CTA.)
 *
 * This is intentionally NOT the composer-enable gate: a cowork-only install
 * must still get a fully functional composer targeting the cowork workspace
 * (see {@link hasNoSelectableWorkspaces}).
 */
export function hasNoCodeWorkspaces(projects: readonly SidebarItem[]): boolean {
  return !projects.some((project) => project.type !== 'cowork');
}

/**
 * Keeps the shared Overview grid from reserving a recommendation cell after a
 * genuinely empty Code-workspace inventory has hydrated. Before hydration the
 * slot remains mounted so its loading shell prevents layout pop-in.
 */
export function shouldRenderWorkspaceReadiness(
  projects: readonly SidebarItem[],
  hasHydratedProjects: boolean,
): boolean {
  return !hasHydratedProjects || !hasNoCodeWorkspaces(projects);
}

/**
 * True when there is no selectable send target of ANY kind — code or cowork.
 * Gates disabling the Home composer (editor readOnly, controls/send
 * disabled): cowork is a fully supported send target (`dispatchHomeSend`'s
 * cowork route), so only a genuinely empty workspace list disables input.
 *
 * In practice this state is transient-to-unreachable (the default Cowork
 * workspace is auto-created — see {@link hasNoCodeWorkspaces}), but the
 * guard is kept so the composer degrades safely during initial hydration or
 * if that invariant ever changes.
 */
export function hasNoSelectableWorkspaces(
  projects: readonly SidebarItem[],
): boolean {
  return projects.length === 0;
}

/**
 * True when a workspace selector can change the current target. Every sidebar
 * workspace is selectable (cowork and code alike), matching WorkspaceDropdown.
 * A sole entry stops being a choice once it is selected; the unselected
 * hydration/seed transition keeps the selector visible until selection lands.
 */
export function hasWorkspaceChoice(
  entries: readonly SidebarItem[],
  selectedWorkspaceId: string | null,
): boolean {
  return (
    hasMultipleWorkspaces(entries) ||
    (entries.length === 1 && entries[0]?.id !== selectedWorkspaceId)
  );
}

export function homeWorkspaceSelectedState(
  workspaceId: string | null,
): 'true' | 'false' {
  return workspaceId !== null ? 'true' : 'false';
}

/**
 * Margin below the Home headline and above the composer stack top (project
 * selector overhang or composer box). Matches the 64px below-composer gap.
 */
export function homeHeadingComposerGap(): 'mb-16' {
  return 'mb-16';
}
