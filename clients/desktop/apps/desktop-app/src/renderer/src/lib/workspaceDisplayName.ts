import type { SidebarItem } from '@canopy/desktop-shared/types';

export const FALLBACK_WORKSPACE_DISPLAY_NAME = 'Untitled project';

function normalizeDisplayName(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : FALLBACK_WORKSPACE_DISPLAY_NAME;
}

/**
 * Build a derived display name from a list of repo names, used for the
 * sidebar label of a temporary adhoc multi-repo workspace. Formatting:
 *
 * - 0 repos → `Temporary project`
 * - 1 repo  → the single repo name
 * - 2 repos → `Repo A & Repo B`
 * - 3+ repos → `Repo A, Repo B & Repo C`
 *
 * Names are not truncated here; that is the renderer's responsibility via
 * CSS overflow handling.
 */
export function formatRepoListName(repoNames: readonly string[]): string {
  const displayNames = repoNames
    .map((name) => (typeof name === 'string' ? name.trim() : ''))
    .filter((name) => name.length > 0);

  if (displayNames.length === 0) {
    return 'Temporary project';
  }
  if (displayNames.length === 1) {
    return displayNames[0];
  }
  if (displayNames.length === 2) {
    return `${displayNames[0]} & ${displayNames[1]}`;
  }
  const head = displayNames.slice(0, displayNames.length - 1).join(', ');
  const tail = displayNames[displayNames.length - 1];
  return `${head} & ${tail}`;
}

/**
 * Resolve the user-facing display name for a sidebar item. Temporary
 * multi-repo workspaces derive their label from the underlying repo names;
 * every other workspace keeps its stored `name`. The workspace id is never
 * affected — callers must continue to use `item.id` for keying / lookups.
 */
export function getWorkspaceDisplayName(item: SidebarItem): string {
  if (item.type === 'multi-repo' && item.temporary === true) {
    return formatRepoListName(item.repos.map((repo) => repo.name));
  }
  return normalizeDisplayName(item.name);
}
