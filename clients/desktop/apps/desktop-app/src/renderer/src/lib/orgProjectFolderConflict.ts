import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import type { OrgProjectsStoreState } from '@canopy/app-state';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type {
  SidebarItem,
  WorkspaceContext,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

/**
 * A Personal → Existing folder pick that exactly matches a local checkout an
 * organization owns (CAN-3648). It names the binding only; it grants nothing.
 */
export interface OrgFolderConflict {
  readonly workspaceId: string;
  readonly owner: WorkspaceOwnerBinding;
}

interface OrgFolderConflictTarget {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly projectId: string;
  readonly projectName: string;
}

/**
 * What the dialog may offer. Organization names come only from current
 * membership, and project names only from a usable catalog entry, so denied
 * and unknown outcomes never carry a project name or id.
 */
export type OrgFolderConflictResolution =
  | ({ readonly status: 'ready' } & OrgFolderConflictTarget)
  | ({ readonly status: 'unfinished' } & OrgFolderConflictTarget)
  | {
      readonly status: 'denied';
      readonly reason: 'feature-disabled' | 'not-member' | 'unavailable';
      /** Present only for a current member. */
      readonly organizationName: string | null;
    }
  | { readonly status: 'unknown' }
  | { readonly status: 'superseded' };

type OrgFolderConflictStore = {
  getState: () => Pick<
    OrgProjectsStoreState,
    'accountEpoch' | 'snapshots' | 'errors' | 'load' | 'loading'
  >;
};

interface ResolveOptions {
  /** The caller's own request guard (dialog alive, folder unchanged). */
  readonly isCurrent: () => boolean;
  /** Ask the host to re-query instead of joining a load already in flight. */
  readonly refresh?: boolean;
}

function boundTo(conflict: OrgFolderConflict): (item: SidebarItem) => boolean {
  return (item): boolean =>
    item.id === conflict.workspaceId &&
    item.owner?.type === 'organization' &&
    item.owner.organizationId === conflict.owner.organizationId &&
    item.owner.projectId === conflict.owner.projectId &&
    item.owner.instanceId === conflict.owner.instanceId &&
    item.owner.bindingGeneration === conflict.owner.bindingGeneration;
}

/**
 * Decides whether the organization project behind a conflicting folder can be
 * opened. Store state is read live after every await; cached catalog data is
 * never treated as authorization.
 */
export async function resolveOrgFolderConflict(
  conflict: OrgFolderConflict,
  store: OrgFolderConflictStore,
  options: ResolveOptions,
): Promise<OrgFolderConflictResolution> {
  const contextEpoch = useWorkspaceContextStore.getState().accountEpoch;
  const catalogEpoch = store.getState().accountEpoch;
  const current = (): boolean =>
    options.isCurrent() &&
    useWorkspaceContextStore.getState().accountEpoch === contextEpoch &&
    store.getState().accountEpoch === catalogEpoch;
  const { organizationId, projectId } = conflict.owner;
  try {
    if (!current()) return { status: 'superseded' };
    if (
      !useFeatureFlagsStore
        .getState()
        .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key)
    )
      return {
        status: 'denied',
        reason: 'feature-disabled',
        organizationName: null,
      };
    if (!useWorkspaceContextStore.getState().hydrated) {
      await useWorkspaceContextStore.getState().hydrate();
      if (!current()) return { status: 'superseded' };
    }
    const membership = (): string | null =>
      useWorkspaceContextStore
        .getState()
        .state.organizations.find((item) => item.id === organizationId)?.name ??
      null;
    const accessFailure = (): OrgFolderConflictResolution | null => {
      if (
        !useFeatureFlagsStore
          .getState()
          .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key)
      )
        return {
          status: 'denied',
          reason: 'feature-disabled',
          organizationName: null,
        };
      if (membership() === null)
        return {
          status: 'denied',
          reason: 'not-member',
          organizationName: null,
        };
      return null;
    };
    const access = accessFailure();
    if (access !== null) return access;

    const context: WorkspaceContext = { kind: 'organization', organizationId };
    await store
      .getState()
      .load(context, options.refresh === true ? { refresh: true } : undefined);
    if (!current()) return { status: 'superseded' };
    const key = serializeWorkspaceContext(context);
    const readProject = (): OrgProjectSummary | undefined =>
      store
        .getState()
        .snapshots[
          key
        ]?.projects.find((item) => item.id === projectId && item.organizationId === organizationId);
    const catalogFailure = (): OrgFolderConflictResolution | null => {
      const access = accessFailure();
      if (access !== null) return access;
      if (
        store.getState().loading[key] === true ||
        store.getState().errors[key] !== undefined ||
        store.getState().snapshots[key] === undefined
      )
        return { status: 'unknown' };
      const project = readProject();
      if (
        project === undefined ||
        project.state !== 'ACTIVE' ||
        !project.capabilities.use
      )
        return {
          status: 'denied',
          reason: 'unavailable',
          organizationName: membership(),
        };
      return null;
    };
    const failure = catalogFailure();
    if (failure !== null) return failure;

    const bound = boundTo(conflict);
    const sameProject = (): SidebarItem[] =>
      useProjectsStore
        .getState()
        .projects.filter(
          (item) =>
            item.owner?.type === 'organization' &&
            item.owner.organizationId === organizationId &&
            item.owner.projectId === projectId,
        );
    // A missing or ambiguous row can be stale renderer state. Reload once,
    // then refuse any remaining ambiguity rather than choosing a target.
    if (sameProject().length !== 1 || !sameProject().some(bound)) {
      await useProjectsStore.getState().loadProjects({ silent: true });
      if (!current()) return { status: 'superseded' };
    }
    const candidates = sameProject();
    if (candidates.length !== 1 || !candidates.some(bound))
      return { status: 'unknown' };

    // Workspace loading can also deliver catalog/access updates. Authorize and
    // read readiness again from live state after the last asynchronous step.
    const finalFailure = catalogFailure();
    if (finalFailure !== null) return finalFailure;
    const project = readProject();
    const organizationName = membership();
    if (project === undefined || organizationName === null)
      return { status: 'unknown' };
    const target: OrgFolderConflictTarget = {
      organizationId,
      organizationName,
      projectId,
      projectName: project.name,
    };
    if (project.instance === null) return { status: 'unfinished', ...target };
    if (project.instance.id !== conflict.owner.instanceId)
      return { status: 'unknown' };
    return project.instance.state === 'READY'
      ? { status: 'ready', ...target }
      : { status: 'unfinished', ...target };
  } catch {
    return current() ? { status: 'unknown' } : { status: 'superseded' };
  }
}
