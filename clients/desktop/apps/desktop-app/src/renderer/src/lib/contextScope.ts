import {
  APP_ADVISOR_PROJECT_ID,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  isSameWorkspaceContext,
  parseWorkspaceContext,
} from '@canopy/protocol/workspace-context';
import { getSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import {
  linkedPersonalWorkspaceIdsForContext,
  useLinkedPersonalWorkspacesStore,
} from '@/stores/linkedPersonalWorkspacesStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  isWorkspaceInContext,
  workspaceOwnerContext,
} from './automationContextScope';

/**
 * Navigation-context scoping for list, default, and search surfaces outside
 * the sidebar (CAN-3461). Every helper applies the sidebar's rule through
 * {@link isWorkspaceInContext} and treats an `undefined` context (org
 * projects off, or the context not hydrated yet) as "no scoping", so the
 * legacy all-workspace behavior is unchanged while the rollout is off.
 * Navigation context is never authorization: these only filter and default.
 */

type ScopedWorkspace = Pick<SidebarItem, 'id' | 'owner'>;

/** The workspaces in `context`, preserving input order. */
export function scopeWorkspacesToContext<T extends ScopedWorkspace>(
  workspaces: readonly T[],
  context: WorkspaceContext | undefined,
  linkedPersonalIds: readonly string[],
): T[] {
  if (context === undefined) return [...workspaces];
  const linked = new Set(linkedPersonalIds);
  return workspaces.filter((workspace) =>
    isWorkspaceInContext(workspace, context, linked),
  );
}

/**
 * Whether `workspaceId` belongs to `context`. App Advisor is explicitly
 * global. Other ids with no loaded workspace fail closed: their owner cannot
 * be proven, so their titles and navigation targets must not cross contexts.
 */
export function isWorkspaceIdInContext(
  workspaceId: string,
  workspaces: readonly ScopedWorkspace[],
  context: WorkspaceContext | undefined,
  linkedPersonalIds: readonly string[],
): boolean {
  if (context === undefined) return true;
  const workspace = workspaces.find((item) => item.id === workspaceId);
  if (workspace === undefined) return workspaceId === APP_ADVISOR_PROJECT_ID;
  return isWorkspaceInContext(workspace, context, new Set(linkedPersonalIds));
}

/** Non-reactive form of {@link isWorkspaceIdInContext} over live store state. */
export function isWorkspaceIdInScopingContext(workspaceId: string): boolean {
  const context = getSidebarScopingContext();
  return isWorkspaceIdInContext(
    workspaceId,
    useProjectsStore.getState().projects,
    context,
    linkedPersonalWorkspaceIdsForContext(
      useLinkedPersonalWorkspacesStore.getState(),
      context,
    ),
  );
}

/**
 * Whether the active policy owner may rewrite a chat tab. Unlike sidebar
 * visibility, a linked Personal workspace does not transfer a started tab to
 * the selected organization: its captured execution context remains the work
 * owner for the life of that session. Legacy started tabs without a capture
 * are Personal; only pristine tabs may follow the current navigation context.
 */
export function isChatTabInScopingContext(
  workspaceId: string,
  executionContext: string | undefined,
  hasConversationContent: boolean,
): boolean {
  const context = getSidebarScopingContext();
  if (context === undefined) return true;
  const workspace = useProjectsStore
    .getState()
    .projects.find((item) => item.id === workspaceId);
  if (workspace === undefined) return workspaceId === APP_ADVISOR_PROJECT_ID;
  if (workspace.owner?.type === 'organization') {
    return (
      context.kind === 'organization' &&
      context.organizationId === workspace.owner.organizationId
    );
  }
  if (executionContext !== undefined) {
    const captured = parseWorkspaceContext(executionContext);
    return captured !== null && isSameWorkspaceContext(captured, context);
  }
  if (hasConversationContent) return context.kind === 'personal';
  return isWorkspaceIdInContext(
    workspaceId,
    useProjectsStore.getState().projects,
    context,
    linkedPersonalWorkspaceIdsForContext(
      useLinkedPersonalWorkspacesStore.getState(),
      context,
    ),
  );
}

/**
 * Before opening an entry that belongs to another context (an Overview row,
 * a notification, an audit entry), switch to that entry's context first, the
 * same way the org-project deep link lands in its organization. Resolves
 * `true` once the workspace is in the selected context (immediately when it
 * already was, or when scoping is off), and `false` when the switch was
 * rejected so the caller does not open a row the sidebar is hiding.
 */
export async function switchContextForWorkspace(
  workspaceId: string,
): Promise<boolean> {
  if (isWorkspaceIdInScopingContext(workspaceId)) return true;
  const workspace = useProjectsStore
    .getState()
    .projects.find((item) => item.id === workspaceId);
  if (workspace === undefined) return false;
  try {
    await useWorkspaceContextStore
      .getState()
      .setContext(workspaceOwnerContext(workspace));
  } catch {
    return false;
  }
  return isWorkspaceIdInScopingContext(workspaceId);
}

/**
 * Run `open` in `workspaceId`'s context: synchronously when the workspace is
 * already in the selected context (or scoping is off), otherwise after
 * {@link switchContextForWorkspace} lands. A rejected switch opens nothing.
 */
export function openInWorkspaceContext(
  workspaceId: string,
  open: () => void,
): void {
  if (isWorkspaceIdInScopingContext(workspaceId)) {
    open();
    return;
  }
  void switchContextForWorkspace(workspaceId).then((ready): void => {
    if (ready) open();
  });
}
