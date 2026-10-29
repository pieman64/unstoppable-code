import { useEffect } from 'react';
import {
  useOrgProjectsStoreApi,
  type OrgProjectsStoreState,
} from '@canopy/app-state';
import type {
  OrgProjectPlaceholderState,
  OrgProjectSummary,
} from '@canopy/protocol/org-projects';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { useLinkedPersonalWorkspacesStore } from '@/stores/linkedPersonalWorkspacesStore';
import { startOrgProjectSetupWithGitHubOffer } from './orgProjectConnectOffer';

// The Add project catalog's Add (CAN-3386, CAN-3469), shared by the dialog's
// rows and App Advisor's workspace.add_org_project (CAN-3592), so the
// Advisor puts a project on this computer exactly as the member's click does.

type OrganizationContext = Extract<WorkspaceContext, { kind: 'organization' }>;

/** The org projects store members Add uses. */
export type OrgProjectAddStore = {
  getState(): Pick<
    OrgProjectsStoreState,
    | 'setPreference'
    | 'requestSetup'
    | 'startSetup'
    | 'setupProgress'
    | 'accountEpoch'
  >;
  subscribe(listener: () => void): () => void;
};

/** Placeholder states in which Add has something to start. */
export function isOrgProjectAddableState(
  state: OrgProjectPlaceholderState,
): boolean {
  return (
    state === 'ready-to-set-up' ||
    state === 'choose-folder' ||
    state === 'needs-github-access'
  );
}

/**
 * Where Add sets a project up without the setup dialog: the remembered
 * folder, for a Code project that is ready to set up. `null` hands the
 * project to the setup dialog.
 */
export function orgProjectAddDestination(
  project: Pick<OrgProjectSummary, 'kind'>,
  state: OrgProjectPlaceholderState,
  folder: string,
): string | null {
  return project.kind === 'CODE' && state === 'ready-to-set-up' && folder !== ''
    ? folder
    : null;
}

export type OrgProjectAddOutcome =
  /** Listing failed; nothing was set up. */
  | { kind: 'listing-failed' }
  /** This organization's links are not answered yet; nothing was set up. */
  | { kind: 'links-unknown' }
  /** The caller cancelled; nothing was set up (the listing may stand). */
  | { kind: 'cancelled' }
  /** A linked Personal checkout already puts the project on this computer. */
  | { kind: 'linked' }
  /** The setup dialog asks the member for a folder; nothing is set up yet. */
  | { kind: 'setup-requested' }
  | { kind: 'setup-started' }
  | { kind: 'setup-failed'; message: string };

/**
 * Main's fresh answer to whether a checkout here is linked to the project,
 * or `null` when it cannot say.
 */
async function isLinkedOnThisComputer(
  projectId: string,
): Promise<boolean | null> {
  const fresh = await window.api.orgProjects
    .linksList()
    .catch((): null => null);
  if (fresh?.status !== 'resolved') return null;
  return fresh.links.some((link): boolean => link.projectId === projectId);
}

/** Start setup in the destination; a refusal is reported, not thrown. */
async function startOrgProjectSetup(
  store: OrgProjectAddStore,
  projectId: string,
  destination: string,
  offerGitHubConnect: boolean,
): Promise<OrgProjectAddOutcome> {
  try {
    if (offerGitHubConnect)
      await startOrgProjectSetupWithGitHubOffer(store, projectId, destination);
    else await store.getState().startSetup(projectId, destination);
    return { kind: 'setup-started' };
  } catch (cause: unknown) {
    return {
      kind: 'setup-failed',
      message: cause instanceof Error ? cause.message : 'Project setup failed',
    };
  }
}

/**
 * Add sets up this one project on demand: list it if it is not listed yet —
 * setup admits only listed projects. With a destination, start setup there
 * through the same command the setup dialog's Start uses; the sidebar row
 * then carries its progress. Otherwise hand the project to the sidebar's
 * setup dialog, which claims and clones nothing until the member starts it.
 */
export async function addOrgProjectToComputer(
  store: OrgProjectAddStore,
  {
    context,
    project,
    destination,
    onPending,
    onBeforeSetup,
    signal,
    offerGitHubConnect = false,
  }: {
    context: OrganizationContext;
    project: OrgProjectSummary;
    destination: string | null;
    /** Brackets each wait on main or the server. */
    onPending?: (pending: boolean) => void;
    /** Runs once Add is about to set up or ask for a folder. */
    onBeforeSetup?: () => void;
    /** Stops before each step that sets anything up. */
    signal?: AbortSignal;
    /** Offer the GitHub sign-in when the clone needs it (CAN-4466). */
    offerGitHubConnect?: boolean;
  },
): Promise<OrgProjectAddOutcome> {
  let setupDestination = destination;
  if (project.listed === false) {
    onPending?.(true);
    try {
      await store.getState().setPreference(context, project.id, 'ADDED');
    } catch {
      return { kind: 'listing-failed' };
    } finally {
      onPending?.(false);
    }
  }
  if (signal?.aborted) return { kind: 'cancelled' };
  // Listing awaited the server, and links can have arrived meanwhile.
  // Re-read them: a project that is now linked is already on this computer.
  const links = useLinkedPersonalWorkspacesStore.getState();
  if (links.resolvedOrganizationId !== context.organizationId)
    return { kind: 'links-unknown' };
  if (links.projectIds.includes(project.id)) return { kind: 'linked' };
  if (setupDestination !== null && project.kind === 'CODE') {
    // Main links a Personal checkout only to a listed project, so the store
    // cannot know yet whether a project Add just listed is already checked
    // out here. Ask main again before cloning anything: a linked project
    // starts nothing, and an unknown answer falls back to the setup dialog.
    onPending?.(true);
    const linked = await isLinkedOnThisComputer(project.id);
    onPending?.(false);
    if (linked === true) return { kind: 'linked' };
    if (linked === null) setupDestination = null;
  }
  if (signal?.aborted) return { kind: 'cancelled' };
  onBeforeSetup?.();
  if (setupDestination === null || project.kind === 'COWORK') {
    store.getState().requestSetup(context.organizationId, project.id);
    return { kind: 'setup-requested' };
  }
  return startOrgProjectSetup(
    store,
    project.id,
    setupDestination,
    offerGitHubConnect,
  );
}

// App Advisor's dispatcher runs outside React, so it reaches the provider's
// org projects store through this handle, as the deep link bridge does.
let advisorStore: OrgProjectAddStore | null = null;

export function getOrgProjectAddStore(): OrgProjectAddStore | null {
  return advisorStore;
}

export function setOrgProjectAddStoreForTests(
  store: OrgProjectAddStore | null,
): void {
  advisorStore = store;
}

export function OrgProjectAddStoreBridge(): null {
  const store = useOrgProjectsStoreApi();
  useEffect((): (() => void) => {
    advisorStore = store;
    return (): void => {
      if (advisorStore === store) advisorStore = null;
    };
  }, [store]);
  return null;
}
