import type { StoreApi } from 'zustand';
import type { OrgProjectsStoreState } from '@canopy/app-state';
import {
  deriveOrgProjectPlaceholderState,
  isOrgProjectCatalogSetupSupported,
  type OrgProjectSummary,
} from '@canopy/protocol/org-projects';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type {
  OrgProjectLocalSetupSlot,
  OrgProjectLocalStatus,
} from '@canopy/ui-app/settings/organization/organization-settings-slots';
import {
  addOrgProjectToComputer,
  isOrgProjectAddableState,
  orgProjectAddDestination,
  type OrgProjectAddOutcome,
} from '@/lib/orgProjectCatalogAdd';
import { deriveOrgProjectLocalStatuses } from '@/lib/orgProjectLocalState';
import { openOrgProject } from '@/lib/openOrgProjectDeepLink';
import { useGitHubStore } from '@/stores/githubStore';
import { useLinkedPersonalWorkspacesStore } from '@/stores/linkedPersonalWorkspacesStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

// Desktop's local status and Set up / Open for the organization Projects
// page. Set up and Open run in the organization's context, as they would from
// its sidebar, so both switch to it first. Settings close only once setup is
// starting or the project is open: a failure before then leaves the user on
// the page, and a setup that fails to start afterwards is reported as a toast.
// Cancelling the setup dialog leaves the user in the organization's context.

type OrganizationContext = Extract<WorkspaceContext, { kind: 'organization' }>;

export type OrgProjectSetupSlotStore = Pick<
  StoreApi<OrgProjectsStoreState>,
  'getState' | 'subscribe'
>;

/** How long Set up waits for this organization's links after a switch. */
export const ORG_PROJECT_LINKS_WAIT_MS = 5_000;

export const ORG_PROJECT_NOT_AVAILABLE_MESSAGE = 'Project not available';

const OUTCOME_MESSAGES: Record<
  Exclude<
    OrgProjectAddOutcome['kind'],
    'linked' | 'setup-requested' | 'setup-started' | 'cancelled'
  >,
  string
> = {
  'listing-failed': "Couldn't add the project to your list. Try again.",
  'links-unknown': "Couldn't check this computer for the project. Try again.",
  'setup-failed': 'Project setup failed',
};

function abortError(): DOMException {
  return new DOMException('Cancelled', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function inOrganization(organizationId: string): boolean {
  const context = useWorkspaceContextStore.getState().state.context;
  return (
    context.kind === 'organization' && context.organizationId === organizationId
  );
}

/** Switches to the organization's context unless it is current. */
async function enterOrganization(
  context: OrganizationContext,
  signal: AbortSignal,
): Promise<void> {
  if (!inOrganization(context.organizationId)) {
    try {
      await useWorkspaceContextStore.getState().setContext(context);
    } catch {
      throw new Error("Couldn't switch to this organization. Try again.");
    }
  }
  throwIfAborted(signal);
  if (!inOrganization(context.organizationId))
    throw new Error("Couldn't switch to this organization. Try again.");
}

/**
 * Resolves once this organization's links are answered, or after the
 * timeout: Add then reports links it still cannot see.
 */
function waitForLinks(
  organizationId: string,
  signal: AbortSignal,
): Promise<void> {
  const resolved = (): boolean =>
    useLinkedPersonalWorkspacesStore.getState().resolvedOrganizationId ===
    organizationId;
  if (resolved()) return Promise.resolve();
  return new Promise((resolve, reject): void => {
    const finish = (): void => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      finish();
      reject(abortError());
    };
    const timer = setTimeout((): void => {
      finish();
      resolve();
    }, ORG_PROJECT_LINKS_WAIT_MS);
    const unsubscribe = useLinkedPersonalWorkspacesStore.subscribe((): void => {
      if (!resolved()) return;
      finish();
      resolve();
    });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The remembered clone folder; empty when none was chosen or it can't load. */
async function rememberedDestination(): Promise<string> {
  const preferences = await window.api
    .loadPreferences()
    .catch((): null => null);
  return preferences === null || preferences.__error !== undefined
    ? ''
    : (preferences.orgProjectDefaultDestinationRoot ?? '');
}

/**
 * Opens the Personal checkout linked to the project, which counts as Ready
 * and which the organization's sidebar shows in place of a bound one, through
 * the canonical open and its guards. Rejects before touching context or
 * Settings when nothing here is linked. Main answers links for the current
 * context, so the fresh check runs after the switch: a link gone by then
 * leaves the user in the organization with Settings open.
 */
async function openLinkedCheckout(
  store: OrgProjectSetupSlotStore,
  organizationId: string,
  projectId: string,
  signal: AbortSignal,
): Promise<void> {
  const links = useLinkedPersonalWorkspacesStore.getState();
  if (
    links.resolvedOrganizationId !== organizationId ||
    !links.projectIds.includes(projectId)
  )
    throw new Error(ORG_PROJECT_NOT_AVAILABLE_MESSAGE);
  await enterOrganization({ kind: 'organization', organizationId }, signal);
  const fresh = await window.api.orgProjects
    .linksList()
    .catch((): null => null);
  throwIfAborted(signal);
  const linked = new Set(
    fresh?.status === 'resolved'
      ? fresh.links.flatMap((link): string[] =>
          link.projectId === projectId ? [link.personalWorkspaceId] : [],
        )
      : [],
  );
  // The sidebar's representative: the first Personal checkout in stored
  // project order.
  const workspace = useProjectsStore
    .getState()
    .projects.find(
      (local): boolean => local.owner === undefined && linked.has(local.id),
    );
  if (workspace === undefined)
    throw new Error(ORG_PROJECT_NOT_AVAILABLE_MESSAGE);
  const outcome = await openOrgProject(
    {
      organizationId,
      projectId,
      workspaceId: workspace.id,
      linkedPersonal: true,
    },
    store,
  );
  if (outcome === 'superseded') throw abortError();
  if (outcome !== 'opened') throw new Error(ORG_PROJECT_NOT_AVAILABLE_MESSAGE);
  useNavigationStore.getState().closeSettings();
}

/** Same projects with the same state and message. */
function sameStatuses(
  left: ReadonlyMap<string, OrgProjectLocalStatus>,
  right: ReadonlyMap<string, OrgProjectLocalStatus>,
): boolean {
  return (
    left.size === right.size &&
    Array.from(left).every(([projectId, status]): boolean => {
      const other = right.get(projectId);
      return (
        other !== undefined &&
        other.state === status.state &&
        other.message === status.message
      );
    })
  );
}

interface CachedStatuses {
  readonly inputs: readonly unknown[];
  readonly statuses: ReadonlyMap<string, OrgProjectLocalStatus>;
}

export function createDesktopOrgProjectSetupSlot(
  store: OrgProjectSetupSlotStore,
): OrgProjectLocalSetupSlot {
  const cache = new Map<string, CachedStatuses>();
  const subscribers = new Map<string, number>();

  const getLocalStatuses = (
    organizationId: string,
  ): ReadonlyMap<string, OrgProjectLocalStatus> => {
    const { projects } = useProjectsStore.getState();
    const links = useLinkedPersonalWorkspacesStore.getState();
    const { setupProgress } = store.getState();
    const inputs = [
      projects,
      links.projectIds,
      links.resolvedOrganizationId,
      setupProgress,
    ];
    const cached = cache.get(organizationId);
    if (
      cached !== undefined &&
      cached.inputs.every((input, index): boolean => input === inputs[index])
    )
      return cached.statuses;
    const statuses = deriveOrgProjectLocalStatuses({
      organizationId,
      localProjects: projects,
      linkedProjectIds:
        links.resolvedOrganizationId === organizationId ? links.projectIds : [],
      setupProgress,
    });
    // The sidebar replaces `projects` on every load; keep the snapshot when
    // no status changed, so the page does not re-render for nothing.
    const stable =
      cached !== undefined && sameStatuses(cached.statuses, statuses)
        ? cached.statuses
        : statuses;
    cache.set(organizationId, { inputs, statuses: stable });
    return stable;
  };

  const subscribe = (
    organizationId: string,
    onChange: () => void,
  ): (() => void) => {
    subscribers.set(organizationId, (subscribers.get(organizationId) ?? 0) + 1);
    const unsubscribes = [
      useProjectsStore.subscribe(onChange),
      useLinkedPersonalWorkspacesStore.subscribe(onChange),
      store.subscribe(onChange),
    ];
    let active = true;
    return (): void => {
      if (!active) return;
      active = false;
      for (const unsubscribe of unsubscribes) unsubscribe();
      const remaining = (subscribers.get(organizationId) ?? 1) - 1;
      if (remaining > 0) {
        subscribers.set(organizationId, remaining);
        return;
      }
      subscribers.delete(organizationId);
      cache.delete(organizationId);
    };
  };

  const setUp = async (
    organizationId: string,
    project: OrgProjectSummary,
    signal: AbortSignal,
  ): Promise<void> => {
    throwIfAborted(signal);
    const state = deriveOrgProjectPlaceholderState({
      project,
      snapshotError: null,
    });
    if (
      !isOrgProjectAddableState(state) ||
      !isOrgProjectCatalogSetupSupported(project)
    )
      throw new Error("This project can't be set up on this computer.");
    const context: OrganizationContext = {
      kind: 'organization',
      organizationId,
    };
    await enterOrganization(context, signal);
    await waitForLinks(organizationId, signal);
    const folder = await rememberedDestination();
    throwIfAborted(signal);
    const outcome = await addOrgProjectToComputer(store, {
      context,
      project,
      destination: orgProjectAddDestination(project, state, folder),
      onBeforeSetup: (): void => {
        useNavigationStore.getState().closeSettings();
      },
      signal,
    });
    switch (outcome.kind) {
      case 'linked':
      case 'setup-requested':
      case 'setup-started':
        return;
      case 'cancelled':
        throw abortError();
      case 'setup-failed': {
        // Settings closed before setup started, so the page cannot show it:
        // report it as the Add project dialog does.
        const message =
          outcome.message === ''
            ? OUTCOME_MESSAGES['setup-failed']
            : outcome.message;
        useGitHubStore.getState().addToast(message, 'error');
        throw new Error(message);
      }
      default:
        throw new Error(OUTCOME_MESSAGES[outcome.kind]);
    }
  };

  const open = async (
    organizationId: string,
    project: OrgProjectSummary,
    signal: AbortSignal,
  ): Promise<void> => {
    throwIfAborted(signal);
    const workspace = useProjectsStore
      .getState()
      .projects.find(
        (local): boolean =>
          local.owner?.organizationId === organizationId &&
          local.owner.projectId === project.id,
      );
    if (workspace === undefined) {
      await openLinkedCheckout(store, organizationId, project.id, signal);
      return;
    }
    await enterOrganization({ kind: 'organization', organizationId }, signal);
    const outcome = await openOrgProject(
      { organizationId, projectId: project.id, workspaceId: workspace.id },
      store,
    );
    // A newer open, account or context owns the UI: say nothing.
    if (outcome === 'superseded') throw abortError();
    if (outcome !== 'opened')
      throw new Error(ORG_PROJECT_NOT_AVAILABLE_MESSAGE);
    // The project is already showing under Settings: close them even if the
    // page went away meanwhile.
    useNavigationStore.getState().closeSettings();
  };

  return { subscribe, getLocalStatuses, setUp, open };
}
