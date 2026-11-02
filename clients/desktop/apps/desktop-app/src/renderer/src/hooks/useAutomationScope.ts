import { useResourceContext } from '@canopy/ui-app/capability';
import { useMemo } from 'react';
import type {
  AppAdvisorWatcherSummary,
  AutomationAction,
  ScheduledActivity,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import type { SharedAutomationSummary } from '@canopy/protocol/automations';
import {
  parseWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  linkedPersonalWorkspaceIdsForContext,
  useLinkedPersonalWorkspacesStore,
} from '@/stores/linkedPersonalWorkspacesStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  automationRunsInLabel,
  indexProjectsById,
  isAccountInWorkspaceContext,
  isAutomationInContext,
  isSharedAutomationInContext,
  isWatcherInContext,
  isWorkspaceInContext,
  workspaceContextLabel,
  workspaceOwnerContext,
} from '@/lib/automationContextScope';

export interface AutomationScope {
  /** `undefined` while org projects are off or the context hasn't loaded. */
  context: WorkspaceContext | undefined;
  inContext: (activity: {
    action: AutomationAction;
    executionContext?: string;
  }) => boolean;
  watcherInContext: (
    watcher: Pick<AppAdvisorWatcherSummary, 'destination'>,
  ) => boolean;
  shareInContext: (summary: Pick<SharedAutomationSummary, 'owner'>) => boolean;
  /** Label for the selected context; `null` when unscoped. */
  contextLabel: string | null;
  /** `Runs in {context}` for an automation's row; `null` when unscoped. */
  runsInLabel: (
    activity: Pick<ScheduledActivity, 'enabled' | 'executionContext'>,
  ) => string | null;
  /**
   * `Personal` or the organization name of an automation owner: a saved
   * `executionContext`, or the selected context (Personal when unscoped)
   * for a new automation.
   */
  ownerLabel: (executionContext: string | undefined) => string;
  /** Label for the context a workspace belongs to. */
  labelForWorkspace: (workspace: Pick<SidebarItem, 'id' | 'owner'>) => string;
  /** Whether the account may run in the context a workspace belongs to. */
  memberOfWorkspace: (workspace: Pick<SidebarItem, 'id' | 'owner'>) => boolean;
  /** Projects in the selected context, for pickers. */
  projectsInContext: SidebarItem[];
}

interface AutomationScopeInputs {
  context: WorkspaceContext | undefined;
  projects: SidebarItem[];
  linkedIds: readonly string[];
  organizations: readonly { id: string; name: string }[];
  personalOrganizationId: string | null;
}

function buildAutomationScope({
  context,
  projects,
  linkedIds,
  organizations,
  personalOrganizationId,
}: AutomationScopeInputs): AutomationScope {
  const projectsById = indexProjectsById(projects);
  const linked = new Set(linkedIds);
  return {
    context,
    inContext: (activity) =>
      isAutomationInContext(activity, projectsById, context, linked),
    watcherInContext: (watcher) =>
      isWatcherInContext(watcher, projectsById, context, linked),
    shareInContext: (summary) =>
      isSharedAutomationInContext(summary, context, personalOrganizationId),
    contextLabel: context
      ? workspaceContextLabel(context, organizations)
      : null,
    runsInLabel: (activity) =>
      context ? automationRunsInLabel(activity, organizations) : null,
    ownerLabel: (executionContext) =>
      workspaceContextLabel(
        (executionContext !== undefined
          ? parseWorkspaceContext(executionContext)
          : null) ??
          context ?? { kind: 'personal' },
        organizations,
      ),
    labelForWorkspace: (workspace) =>
      workspaceContextLabel(workspaceOwnerContext(workspace), organizations),
    memberOfWorkspace: (workspace) =>
      isAccountInWorkspaceContext(workspace, organizations),
    projectsInContext:
      context === undefined
        ? projects
        : projects.filter((project) =>
            isWorkspaceInContext(project, context, linked),
          ),
  };
}

/** Scope automation lists and pickers to the sidebar's Personal/organization context (CAN-3448). */
export function useAutomationScope(): AutomationScope {
  const context = useSidebarScopingContext();
  const { personalOrganizationId } = useResourceContext();
  const projects = useProjectsStore((state) => state.projects);
  const linkedIds = useLinkedPersonalWorkspacesStore((state) =>
    linkedPersonalWorkspaceIdsForContext(state, context),
  );
  const organizations = useWorkspaceContextStore(
    (state) => state.state.organizations,
  );
  return useMemo(
    () =>
      buildAutomationScope({
        context,
        projects,
        linkedIds,
        organizations,
        personalOrganizationId,
      }),
    [context, projects, linkedIds, organizations, personalOrganizationId],
  );
}
