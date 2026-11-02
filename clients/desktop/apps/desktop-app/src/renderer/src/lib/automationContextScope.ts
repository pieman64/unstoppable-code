import { isResourceOwnerInContext } from '@canopy/ui-app/capability';
import {
  APP_ADVISOR_PROJECT_ID,
  type AppAdvisorWatcherSummary,
  type AutomationAction,
  type ScheduledActivity,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import type { SharedAutomationSummary } from '@canopy/protocol/automations';
import {
  parseWorkspaceContext,
  serializeWorkspaceContext,
  type WorkspaceContext,
  type WorkspaceContextOrganization,
} from '@canopy/protocol/workspace-context';
import { workspaceOwnerMatchesContext } from '@canopy/desktop-shared/lib/workspace-owner';
import {
  automationRunsInMessage,
  workspaceContextDisplayLabel,
} from '@canopy/desktop-shared/lib/automation-context-copy';
import { isGlobalPipelineAutomationAction } from '@canopy/desktop-shared/lib/automation-pipeline-target';
import { automationActionWorkspaceId } from '@/components/panels/automations/automations-panel-data';

/**
 * Personal/organization scoping for automation surfaces (CAN-3448). Every
 * predicate follows the sidebar's rule and treats an `undefined` context
 * (org projects off, or the context not hydrated yet) as "no scoping".
 */

type ScopedWorkspace = Pick<SidebarItem, 'id' | 'owner'>;

/**
 * The sidebar's rule: the workspace's owner matches the context, and an
 * organization also admits Personal checkouts linked to its catalog.
 */
export function isWorkspaceInContext(
  workspace: ScopedWorkspace,
  context: WorkspaceContext | undefined,
  linkedPersonalIds: ReadonlySet<string>,
): boolean {
  return (
    workspaceOwnerMatchesContext(workspace.owner, context) ||
    (context?.kind === 'organization' &&
      workspace.owner === undefined &&
      linkedPersonalIds.has(workspace.id))
  );
}

/**
 * Whether a workspace-targeted item belongs in the selected context. App
 * Advisor shows everywhere, and a target that no longer exists stays visible
 * so the user can still reach and delete it.
 */
function isTargetWorkspaceInContext(
  workspaceId: string | undefined,
  projectsById: ReadonlyMap<string, ScopedWorkspace>,
  context: WorkspaceContext | undefined,
  linkedPersonalIds: ReadonlySet<string>,
): boolean {
  if (context === undefined) return true;
  if (workspaceId === undefined || workspaceId === APP_ADVISOR_PROJECT_ID)
    return true;
  const workspace = projectsById.get(workspaceId);
  if (!workspace) return true;
  return isWorkspaceInContext(workspace, context, linkedPersonalIds);
}

/**
 * Whether an automation belongs in the selected context. A pipeline with no
 * project is filed under its saved owner (absent reads as Personal), never by
 * its inert `workspaceId` or the App Advisor "show everywhere" rule; main's
 * `automationInContext` applies the same rule.
 */
export function isAutomationInContext(
  activity: { action: AutomationAction; executionContext?: string },
  projectsById: ReadonlyMap<string, ScopedWorkspace>,
  context: WorkspaceContext | undefined,
  linkedPersonalIds: ReadonlySet<string>,
): boolean {
  if (context === undefined) return true;
  if (isGlobalPipelineAutomationAction(activity.action))
    return (
      (activity.executionContext ?? 'personal') ===
      serializeWorkspaceContext(context)
    );
  return isTargetWorkspaceInContext(
    automationActionWorkspaceId(activity.action),
    projectsById,
    context,
    linkedPersonalIds,
  );
}

export function isWatcherInContext(
  watcher: Pick<AppAdvisorWatcherSummary, 'destination'>,
  projectsById: ReadonlyMap<string, ScopedWorkspace>,
  context: WorkspaceContext | undefined,
  linkedPersonalIds: ReadonlySet<string>,
): boolean {
  return isTargetWorkspaceInContext(
    watcher.destination.projectId,
    projectsById,
    context,
    linkedPersonalIds,
  );
}

/**
 * Shared automations by publisher: system shares show everywhere, a person's
 * shares across contexts, the current Personal organization under Personal,
 * and other organization or team shares under their organization.
 */
export function isSharedAutomationInContext(
  summary: Pick<SharedAutomationSummary, 'owner'>,
  context: WorkspaceContext | undefined,
  personalOrganizationId: string | null = null,
): boolean {
  return isResourceOwnerInContext(
    summary.owner,
    context,
    personalOrganizationId,
  );
}

/** `Personal`, or the organization's name (`your organization` when unknown). */
export function workspaceContextLabel(
  context: WorkspaceContext,
  organizations: readonly Pick<WorkspaceContextOrganization, 'id' | 'name'>[],
  unknownOrganizationLabel?: string,
): string {
  return workspaceContextDisplayLabel(
    context,
    organizations,
    unknownOrganizationLabel,
  );
}

/**
 * Where an automation runs, for its row (CAN-3543): the context it is bound
 * to, which can differ from where its project is now. An automation on with
 * no binding predates them and runs as Personal; one that is off and was
 * never bound has no context until it is turned on.
 */
export function automationRunsInLabel(
  activity: Pick<ScheduledActivity, 'enabled' | 'executionContext'>,
  organizations: readonly Pick<WorkspaceContextOrganization, 'id' | 'name'>[],
): string | null {
  const context: WorkspaceContext | null =
    activity.executionContext === undefined
      ? activity.enabled
        ? { kind: 'personal' }
        : null
      : parseWorkspaceContext(activity.executionContext);
  return context
    ? automationRunsInMessage(workspaceContextLabel(context, organizations))
    : null;
}

/** Whether the account may run in the context that owns `workspace`. */
export function isAccountInWorkspaceContext(
  workspace: ScopedWorkspace,
  organizations: readonly Pick<WorkspaceContextOrganization, 'id'>[],
): boolean {
  const { owner } = workspace;
  return (
    owner === undefined ||
    organizations.some(
      (organization) => organization.id === owner.organizationId,
    )
  );
}

/**
 * The context a workspace belongs to, for naming it in copy. A Personal
 * checkout is Personal even when it's linked to an organization's catalog.
 */
export function workspaceOwnerContext(
  workspace: ScopedWorkspace,
): WorkspaceContext {
  return workspace.owner === undefined
    ? { kind: 'personal' }
    : { kind: 'organization', organizationId: workspace.owner.organizationId };
}

export function indexProjectsById<T extends ScopedWorkspace>(
  projects: readonly T[],
): ReadonlyMap<string, T> {
  return new Map(projects.map((project) => [project.id, project]));
}
