import { useCallback, useMemo } from 'react';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import {
  linkedPersonalWorkspaceIdsForContext,
  useLinkedPersonalWorkspacesStore,
} from '@/stores/linkedPersonalWorkspacesStore';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  isWorkspaceIdInContext,
  scopeWorkspacesToContext,
} from '@/lib/contextScope';

export interface ContextScopedWorkspaces {
  /** `undefined` while org projects are off or the context hasn't loaded. */
  context: WorkspaceContext | undefined;
  /** Every loaded workspace in the selected context, in store order. */
  workspaces: SidebarItem[];
  /** Personal checkouts linked to the selected organization's catalog. */
  linkedPersonalWorkspaceIds: readonly string[];
  /** Whether a workspace id belongs to the selected context (unknown ids do). */
  isInContext: (workspaceId: string) => boolean;
}

/**
 * The sidebar's Personal/organization scoping for surfaces outside the
 * sidebar: Home, Create Task, Overview, Notifications, Audit Trail, and Cmd+K
 * (CAN-3461). Unscoped (every workspace) while org projects are off.
 */
export function useContextScopedWorkspaces(): ContextScopedWorkspaces {
  const context = useSidebarScopingContext();
  const projects = useProjectsStore((state) => state.projects);
  const linkedIds = useLinkedPersonalWorkspacesStore((state) =>
    linkedPersonalWorkspaceIdsForContext(state, context),
  );
  const workspaces = useMemo(
    () => scopeWorkspacesToContext(projects, context, linkedIds),
    [projects, context, linkedIds],
  );
  const isInContext = useCallback(
    (workspaceId: string): boolean =>
      isWorkspaceIdInContext(workspaceId, projects, context, linkedIds),
    [projects, context, linkedIds],
  );
  return {
    context,
    workspaces,
    linkedPersonalWorkspaceIds: linkedIds,
    isInContext,
  };
}
