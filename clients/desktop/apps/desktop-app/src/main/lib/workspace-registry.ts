import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import type { WorkspaceType } from '@canopy/desktop-shared/types';

const workspaceTypes = new Map<string, WorkspaceType>();
const workspaceExternalPaths = new Map<string, string>();

export function getWorkspaceType(id: string): WorkspaceType | null {
  return workspaceTypes.get(id) ?? null;
}

/** The workspaces registered from the last sidebar read or write. */
export function listRegisteredWorkspaceIds(): string[] {
  return Array.from(workspaceTypes.keys());
}
export function isMultiRepoWorkspace(id: string): boolean {
  return workspaceTypes.get(id) === 'multi-repo';
}
export function isCoworkWorkspace(id: string): boolean {
  // The legacy standalone-chat sentinel is a cowork context. It is aliased
  // here (accessor-level) rather than registered, so it survives the
  // clear/rebuild that registerWorkspaceTypes performs on every sidebar
  // read/write. getWorkspaceType intentionally does NOT alias it — resolve-
  // worktree.ts relies on getWorkspaceType(sentinel) === null for its branch
  // ordering. Real cowork workspace ids (Phase 3+) resolve via the map.
  return (
    id === STANDALONE_CHAT_PROJECT_ID || workspaceTypes.get(id) === 'cowork'
  );
}

/**
 * Whether an id addresses a workspace whose chats are grouped into Work
 * Entries. App Advisor is intentionally not treated as cowork: it shares the
 * entry registry model but has different cwd, prompt, and workspace-item
 * routing rules.
 */
export function isWorkEntryWorkspace(id: string): boolean {
  return id === APP_ADVISOR_PROJECT_ID || isCoworkWorkspace(id);
}

export function registerWorkspaceTypes(
  nextWorkspaceTypes: Map<string, WorkspaceType>,
): void {
  workspaceTypes.clear();
  nextWorkspaceTypes.forEach((type, id) => {
    workspaceTypes.set(id, type);
  });
}

/**
 * Registers the general external-directory bridge (see
 * `WorkspaceConfigFile.externalPath`) for the current sidebar item set.
 * Rebuilt from the same sidebar-item read/write sites as
 * {@link registerWorkspaceTypes}, so it is cleared and repopulated on every
 * sidebar read/write rather than accumulating stale entries.
 */
export function registerWorkspaceExternalPaths(
  nextExternalPaths: Map<string, string>,
): void {
  workspaceExternalPaths.clear();
  nextExternalPaths.forEach((externalPath, id) => {
    workspaceExternalPaths.set(id, externalPath);
  });
}

/**
 * Returns the registered external directory for a workspace id, or `null`
 * when the workspace has no attached external directory (i.e. it uses its
 * managed home).
 */
export function getWorkspaceExternalPath(id: string): string | null {
  return workspaceExternalPaths.get(id) ?? null;
}
