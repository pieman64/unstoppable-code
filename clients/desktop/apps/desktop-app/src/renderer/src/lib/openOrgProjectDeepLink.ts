import {
  useOrgProjectsStoreApi,
  type OrgProjectsStoreState,
} from '@canopy/app-state';
import { useEffect } from 'react';
import type { OrgProjectDeepLinkOpenEvent } from '@canopy/protocol/org-projects';
import type {
  SidebarItem,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { useProjectsStore } from '@/stores/projectsStore';

import { resolveOrgFolderConflict } from './orgProjectFolderConflict';

let generation = 0;

/** `superseded` is silent: a newer open, account, or context owns the UI. */
export type OrgProjectOpenOutcome = 'opened' | 'unavailable' | 'superseded';

export interface OrgProjectOpenTarget {
  readonly organizationId: string;
  readonly projectId: string;
  /** `null` asks the catalog to set the project up on this device. */
  readonly workspaceId: string | null;
  /**
   * Opens only this exact local binding, and only while the catalog reports
   * its instance `READY` from a successful load (CAN-3648). Without it, the
   * deep-link rules apply unchanged.
   */
  readonly expectedBinding?: WorkspaceOwnerBinding;
  /**
   * `workspaceId` is a Personal checkout linked to the project (CAN-3469),
   * which the organization's sidebar shows in place of a bound one.
   */
  readonly linkedPersonal?: boolean;
}

type OrgProjectOpenStore = {
  getState: () => Pick<
    OrgProjectsStoreState,
    | 'accountEpoch'
    | 'snapshots'
    | 'load'
    | 'requestSetup'
    | 'errors'
    | 'loading'
  >;
};

/**
 * The canonical open of an organization project in the current organization
 * context. Membership, project usability, the bound-workspace lookup (with one
 * reload), and the account/generation guards live here so every caller shares
 * them. Callers own any failure message.
 */
export async function openOrgProject(
  target: OrgProjectOpenTarget,
  store: OrgProjectOpenStore,
): Promise<OrgProjectOpenOutcome> {
  generation += 1;
  const ticket = generation;
  const epoch = store.getState().accountEpoch;
  const initialContext = useWorkspaceContextStore.getState();
  const contextEpoch = initialContext.accountEpoch;
  const hydrationGeneration = initialContext.appliedGeneration;
  let contextRevision: number | undefined = initialContext.hydrated
    ? initialContext.state.revision
    : undefined;
  const superseded = (): boolean =>
    ticket !== generation ||
    epoch !== store.getState().accountEpoch ||
    contextEpoch !== useWorkspaceContextStore.getState().accountEpoch ||
    (contextRevision !== undefined &&
      contextRevision !== useWorkspaceContextStore.getState().state.revision) ||
    !inTargetContext();
  const inTargetContext = (): boolean => {
    const context = useWorkspaceContextStore.getState().state.context;
    return (
      context.kind === 'organization' &&
      context.organizationId === target.organizationId
    );
  };
  try {
    await useWorkspaceContextStore.getState().hydrate();
    // Initial hydration may establish a revision. Once hydrated, compare the
    // revision so a duplicate broadcast of the committed switch is harmless.
    if (
      (!initialContext.hydrated &&
        hydrationGeneration !==
          useWorkspaceContextStore.getState().appliedGeneration) ||
      superseded()
    )
      return 'superseded';
    contextRevision = useWorkspaceContextStore.getState().state.revision;
    const context = useWorkspaceContextStore.getState().state.context;
    if (
      context.kind !== 'organization' ||
      context.organizationId !== target.organizationId
    )
      return 'superseded';
    const expected = target.expectedBinding;
    if (expected !== undefined) {
      if (
        target.workspaceId === null ||
        expected.organizationId !== target.organizationId ||
        expected.projectId !== target.projectId
      )
        return 'unavailable';
      const resolution = await resolveOrgFolderConflict(
        { workspaceId: target.workspaceId, owner: expected },
        store,
        { isCurrent: (): boolean => !superseded(), refresh: true },
      );
      if (resolution.status === 'superseded' || superseded())
        return 'superseded';
      if (resolution.status !== 'ready') return 'unavailable';
      useHomeComposerStore.getState().selectWorkspace(target.workspaceId);
      useNavigationStore.getState().navigate('home');
      return 'opened';
    }
    await store.getState().load(context);
    if (superseded()) return 'superseded';
    if (
      !useWorkspaceContextStore
        .getState()
        .state.organizations.some((item) => item.id === target.organizationId)
    )
      return 'unavailable';
    const key = `org:${target.organizationId}`;
    const project = store
      .getState()
      .snapshots[
        key
      ]?.projects.find((item) => item.id === target.projectId && item.organizationId === target.organizationId && item.state === 'ACTIVE' && item.capabilities.use);
    if (
      project === undefined ||
      (target.workspaceId === null && project.listed === false)
    )
      return 'unavailable';
    if (target.workspaceId !== null) {
      const bound = (item: SidebarItem): boolean =>
        item.id === target.workspaceId &&
        (target.linkedPersonal === true
          ? item.owner === undefined
          : item.owner?.type === 'organization' &&
            item.owner.organizationId === target.organizationId &&
            item.owner.projectId === target.projectId);
      let workspace = useProjectsStore.getState().projects.find(bound);
      if (workspace === undefined) {
        // Main resolved this id from the on-disk sidebar index, so the row
        // exists; a cold deep-link launch can still beat the renderer's first
        // workspace load. Re-read once before calling the project missing.
        await useProjectsStore.getState().loadProjects({ silent: true });
        if (superseded() || !inTargetContext()) return 'superseded';
        workspace = useProjectsStore.getState().projects.find(bound);
      }
      if (
        workspace === undefined ||
        !useWorkspaceContextStore
          .getState()
          .state.organizations.some((item) => item.id === target.organizationId)
      )
        return 'unavailable';
      useHomeComposerStore.getState().selectWorkspace(workspace.id);
      useNavigationStore.getState().navigate('home');
    } else {
      useNavigationStore.getState().navigate('home');
      store.getState().requestSetup(target.organizationId, target.projectId);
    }
    return 'opened';
  } catch {
    return superseded() ? 'superseded' : 'unavailable';
  }
}

/** Async handoff is owned by the stores, not a route component's lifetime. */
export async function openOrgProjectDeepLink(
  event: OrgProjectDeepLinkOpenEvent,
  store: OrgProjectOpenStore,
): Promise<void> {
  if (event.ok === false) {
    // A refused link still supersedes an earlier open in flight.
    generation += 1;
    useGitHubStore.getState().addToast('Project not available', 'error');
    return;
  }
  const outcome = await openOrgProject(
    {
      organizationId: event.organizationId,
      projectId: event.projectId,
      workspaceId: event.workspaceId,
    },
    store,
  );
  if (outcome === 'unavailable')
    useGitHubStore.getState().addToast('Project not available', 'error');
}

export function OrgProjectDeepLinkBridge(): null {
  const store = useOrgProjectsStoreApi();
  useEffect(
    () =>
      window.api.onDeepLinkOrgProjectOpen((event): void => {
        void openOrgProjectDeepLink(event, store);
      }),
    [store],
  );
  return null;
}
