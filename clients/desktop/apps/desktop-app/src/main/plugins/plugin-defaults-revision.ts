import { STANDALONE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';

/**
 * Monotonic in-memory revisions of the inherited default-plugin layers: one
 * for the global layer (`PreferencesData.globalPluginSelections`) and one per
 * workspace for its `defaultPluginSelections`. Sessions record the combined
 * revision they were created under so a later defaults change makes them
 * recreate on their next turn. In-memory only: provider sessions never
 * outlive the process.
 */
let globalRevision = 0;
const projectRevisions = new Map<string, number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of Array.from(listeners)) listener();
}

/**
 * The workspace whose `defaultPluginSelections` a chat inherits. Legacy
 * standalone-chat targets carry the cowork id in `worktreeId`, and legacy
 * chat-project ids map to their migrated cowork workspace.
 */
export function pluginDefaultsWorkspaceId(target: {
  projectId: string;
  worktreeId: string;
}): string {
  return resolveCoworkWorkspaceId(
    target.projectId === STANDALONE_CHAT_PROJECT_ID
      ? target.worktreeId
      : target.projectId,
  );
}

export function bumpGlobalPluginDefaultsRevision(): void {
  globalRevision += 1;
  notify();
}

export function bumpProjectPluginDefaultsRevision(workspaceId: string): void {
  projectRevisions.set(
    workspaceId,
    (projectRevisions.get(workspaceId) ?? 0) + 1,
  );
  notify();
}

export function subscribePluginDefaultsRevision(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getGlobalPluginDefaultsRevision(): number {
  return globalRevision;
}

export function getProjectPluginDefaultsRevision(workspaceId: string): number {
  return projectRevisions.get(workspaceId) ?? 0;
}

/**
 * Combined revision of everything a chat inherits. Both components only
 * grow, so their sum changes exactly when either layer changes.
 */
export function getInheritedPluginDefaultsRevision(target: {
  projectId: string;
  worktreeId: string;
}): number {
  return (
    globalRevision +
    getProjectPluginDefaultsRevision(pluginDefaultsWorkspaceId(target))
  );
}
