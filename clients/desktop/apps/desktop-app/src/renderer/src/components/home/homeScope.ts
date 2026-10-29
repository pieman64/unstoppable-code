import { useEffect, useMemo } from 'react';
import {
  defaultCoworkWorkspaceIdForContext,
  isDefaultCoworkWorkspaceId,
  type SidebarItem,
  type WorkspaceContext,
} from '@canopy/desktop-shared/types';
import { isWorkspaceInContext } from '@/lib/automationContextScope';
import {
  getSidebarScopingContext,
  useSidebarScopingContext,
} from '@/components/sidebar/useSidebarScopingContext';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  linkedPersonalWorkspaceIdsForContext,
  useLinkedPersonalWorkspacesStore,
} from '@/stores/linkedPersonalWorkspacesStore';
import { hasWorkspaceChoice } from './homeGating';

/**
 * The Home composer's view of the Personal/organization context: the projects
 * it may offer and target, by the sidebar's rule (CAN-3448).
 */
export interface HomeScope {
  /** The context's catch-all ("just a chat"): its Chats workspace. */
  defaultCoworkId: string;
  /** Projects in the selected context, in store order. */
  projects: SidebarItem[];
  isInScope(workspaceId: string): boolean;
  /**
   * True only for a selection known to belong elsewhere: a loaded project from
   * another context, or another context's Chats. An id the store has not
   * loaded yet (a project just added) is not judged.
   */
  isOutOfScope(workspaceId: string): boolean;
  /**
   * Where Home seeds a missing selection: the first workspace in scope in
   * store order, which may be the context's Chats, else the context's Chats.
   * `null` only when unscoped with no projects loaded. A selection left in
   * another context lands by `resolveHomeContextRebind` instead.
   */
  fallbackWorkspaceId: string | null;
  /** Nothing to choose but the context's Chats (no project in scope). */
  onlyDefaultChats: boolean;
}

/**
 * An `undefined` context (org projects off, or not hydrated yet) scopes
 * nothing. The context's own Chats workspace is always in scope, even before
 * an organization's has been provisioned: sending there creates it.
 */
export function resolveHomeScope(
  context: WorkspaceContext | undefined,
  projects: SidebarItem[],
  linkedPersonalIds: readonly string[],
): HomeScope {
  const defaultCoworkId = defaultCoworkWorkspaceIdForContext(context);
  const linked = new Set(linkedPersonalIds);
  const scoped =
    context === undefined
      ? projects
      : projects.filter((project) =>
          isWorkspaceInContext(project, context, linked),
        );
  const scopedIds = new Set(scoped.map((project) => project.id));
  const knownIds = new Set(projects.map((project) => project.id));
  const isInScope = (workspaceId: string): boolean =>
    context === undefined ||
    workspaceId === defaultCoworkId ||
    scopedIds.has(workspaceId);
  return {
    defaultCoworkId,
    projects: scoped,
    isInScope,
    isOutOfScope: (workspaceId): boolean =>
      !isInScope(workspaceId) &&
      (knownIds.has(workspaceId) || isDefaultCoworkWorkspaceId(workspaceId)),
    fallbackWorkspaceId:
      scoped[0]?.id ?? (context === undefined ? null : defaultCoworkId),
    onlyDefaultChats: scoped.every((project) =>
      isDefaultCoworkWorkspaceId(project.id),
    ),
  };
}

/** Where a context change lands Home's composer. */
export interface HomeContextRebind {
  workspaceId: string | null;
}

/**
 * Where Home's composer lands when its target is not in the selected context:
 * the first project the picker lists, in sidebar order, else the context's
 * Chats. A context's Chats is never that first project, wherever it sorts: the
 * picker leaves it unlisted, so landing there by order leaves the chip on
 * "Choose project".
 */
export function resolveHomeContextRebind(
  scope: Pick<HomeScope, 'projects' | 'fallbackWorkspaceId'>,
): HomeContextRebind {
  const project = scope.projects
    .filter((candidate) => !isDefaultCoworkWorkspaceId(candidate.id))
    .sort((left, right) => left.order - right.order)[0];
  if (project) {
    return {
      workspaceId: project.id,
    };
  }
  // No listed project leaves only the context's Chats in scope, provisioned
  // or not, and that is what the scope falls back to.
  return scope.fallbackWorkspaceId !== null
    ? {
        workspaceId: scope.fallbackWorkspaceId,
      }
    : {
        workspaceId: null,
      };
}

/** What the context-change effect knows when it decides whether to rebind. */
export interface HomeContextRebindInput {
  /** The context this surface last saw; `null` on its first scoped run. */
  previousContextKey: string | null;
  contextKey: string;
  workspaceId: string | null;
  /** The selection is in the selected context. */
  stillVisible: boolean;
  /** Personal to an organization, with a Personal project still selected. */
  enteredOrganizationWithPersonalSelection: boolean;
  hasDraft: boolean;
  draftBelongsToOtherContext: boolean;
}

/**
 * Whether Home must move its composer into the selected context.
 * While the context is unchanged (or this surface has not seen one yet), an
 * empty selection is the seed's to fill: projects can load before the first
 * seed lands, and nothing was selected, so there is no selection to rebind.
 * A draft typed meanwhile stays: the editor accepts input before any project
 * loads, and only a draft owned by another context is cleared.
 */
export function shouldRebindHomeToContext(
  input: HomeContextRebindInput,
): boolean {
  const contextUnchanged =
    input.previousContextKey === null ||
    input.previousContextKey === input.contextKey;
  if (
    contextUnchanged &&
    (input.stillVisible || input.workspaceId === null) &&
    !input.draftBelongsToOtherContext
  )
    return false;
  return (
    input.draftBelongsToOtherContext ||
    !input.stillVisible ||
    input.enteredOrganizationWithPersonalSelection
  );
}

/**
 * Whether Home shows its project picker. Shared by the picker and the context
 * row that hosts it, so the row is never left rendering an empty band. It
 * shows when there is a choice to make, and when the context's Chats is the
 * only target, so the chip says where the chat will go and offers
 * "New project".
 */
export function shouldShowHomeWorkspacePicker(
  scope: Pick<HomeScope, 'projects' | 'onlyDefaultChats'>,
  workspaceId: string | null,
): boolean {
  return (
    hasWorkspaceChoice(scope.projects, workspaceId) || scope.onlyDefaultChats
  );
}

export function useHomeScope(): HomeScope {
  const context = useSidebarScopingContext();
  const projects = useProjectsStore((state) => state.projects);
  const linkedIds = useLinkedPersonalWorkspacesStore((state) =>
    linkedPersonalWorkspaceIdsForContext(state, context),
  );
  return useMemo(
    () => resolveHomeScope(context, projects, linkedIds),
    [context, projects, linkedIds],
  );
}

/**
 * Re-target Home when its selection is left in another context without the
 * context-switch effect having moved it. `rebindSelection` receives the same
 * target a context switch uses. `readCurrentWorkspaceId` reads the live
 * selection: an effect that ran earlier in the same commit may already have
 * moved it into scope, and the rendered `workspaceId` would then be stale.
 */
export function useKeepHomeSelectionInScope(
  workspaceId: string | null,
  rebindSelection: (rebind: HomeContextRebind) => void,
  readCurrentWorkspaceId?: () => string | null,
): void {
  const scope = useHomeScope();
  useEffect(() => {
    const currentWorkspaceId = readCurrentWorkspaceId
      ? readCurrentWorkspaceId()
      : workspaceId;
    if (currentWorkspaceId === null || !scope.isOutOfScope(currentWorkspaceId))
      return;
    const rebind = resolveHomeContextRebind(scope);
    if (rebind.workspaceId !== null) {
      rebindSelection(rebind);
    }
  }, [workspaceId, scope, rebindSelection, readCurrentWorkspaceId]);
}

/**
 * Whether Home should (re)try seeding its selection: nothing is selected and
 * no attempt has run against this many projects. An attempt made before the
 * projects store loaded found nothing, so a new project count retries it.
 */
export function shouldAttemptHomeSeed(
  workspaceId: string | null,
  lastAttemptProjectCount: number | null,
  projectCount: number,
): boolean {
  return workspaceId === null && lastAttemptProjectCount !== projectCount;
}

/** The same scope read outside React, for async seeding. */
export function getHomeScope(): HomeScope {
  const context = getSidebarScopingContext();
  return resolveHomeScope(
    context,
    useProjectsStore.getState().projects,
    linkedPersonalWorkspaceIdsForContext(
      useLinkedPersonalWorkspacesStore.getState(),
      context,
    ),
  );
}
