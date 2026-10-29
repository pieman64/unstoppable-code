import { create } from 'zustand';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';

/**
 * Personal checkouts linked to the selected organization's catalog
 * (CAN-3448). The sidebar derives these ids and publishes them here so
 * surfaces outside the sidebar (Automations, the command palette, App
 * Advisor) apply the same scoping rule. Until the sidebar publishes, the list
 * is empty and scoping falls back to the owner-only rule, which only means a
 * linked checkout shows under Personal until the ids arrive.
 *
 * `projectIds` are the catalog projects those checkouts link to (CAN-3469).
 * A linked project is on this computer, so the Add project dialog offers no
 * Add for it. Every linked project is listed, including one whose checkout
 * the sidebar skipped because another checkout already stands for it.
 *
 * `resolvedOrganizationId` names the organization whose links have been
 * answered for the current account, or is `null` while they are still
 * unknown. Links arrive asynchronously, so until then an empty `projectIds`
 * means "not known yet", not "nothing is linked": the dialog keeps Add
 * unavailable so it cannot set up a second checkout of a repository that is
 * already here.
 */
export interface LinkedPersonalWorkspacesState {
  ids: readonly string[];
  organizationId: string | null;
  projectIds: readonly string[];
  resolvedOrganizationId: string | null;
  setIds: (ids: readonly string[], organizationId: string | null) => void;
  setProjectIds: (
    projectIds: readonly string[],
    resolvedOrganizationId: string | null,
  ) => void;
}

const EMPTY_IDS: readonly string[] = [];

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function linkedPersonalWorkspaceIdsForContext(
  state: Pick<LinkedPersonalWorkspacesState, 'ids' | 'organizationId'>,
  context: WorkspaceContext | undefined,
): readonly string[] {
  return context?.kind === 'organization' &&
    state.organizationId === context.organizationId
    ? state.ids
    : EMPTY_IDS;
}

export const useLinkedPersonalWorkspacesStore =
  create<LinkedPersonalWorkspacesState>((set, get) => ({
    ids: EMPTY_IDS,
    organizationId: null,
    projectIds: EMPTY_IDS,
    resolvedOrganizationId: null,
    setIds: (ids, organizationId): void => {
      const current = get();
      if (
        current.organizationId === organizationId &&
        sameIds(current.ids, ids)
      ) {
        return;
      }
      set({
        ids: ids.length === 0 ? EMPTY_IDS : [...ids],
        organizationId,
      });
    },
    setProjectIds: (projectIds, resolvedOrganizationId): void => {
      const current = get();
      if (
        sameIds(current.projectIds, projectIds) &&
        current.resolvedOrganizationId === resolvedOrganizationId
      )
        return;
      set({
        projectIds: projectIds.length === 0 ? EMPTY_IDS : [...projectIds],
        resolvedOrganizationId,
      });
    },
  }));
