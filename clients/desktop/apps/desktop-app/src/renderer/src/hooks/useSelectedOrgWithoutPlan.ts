import { useMemo } from 'react';
import type { CanopyOrgBillingState } from '@canopy/protocol/canopy-server';
import type {
  WorkspaceContext,
  WorkspaceContextOrganization,
} from '@canopy/protocol/workspace-context';
import { isOrgTeamsLapsed } from '@canopy/desktop-shared/lib/org-billing-state-parsing';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { useSharedContainersStore } from '@/stores/sharedContainersStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

/** The selected organization when it has no active plan. */
export interface SelectedOrgWithoutPlan {
  organizationId: string;
  organizationName: string;
  /**
   * Only an OWNER can buy: every purchase action on the organization's web
   * billing page is owner-gated, so an ADMIN sent there would find nothing to
   * do. Everyone else is told to ask an owner.
   */
  canChoosePlan: boolean;
}

/**
 * The selected organization, when it has lost the `teams` capability
 * (`teamsEntitled: false`). Organization projects and Chats require it, so
 * surfaces that would otherwise look empty or usable explain the plan instead.
 * Unknown billing state is never read as "no plan" (see `isOrgTeamsLapsed`).
 */
export function resolveSelectedOrgWithoutPlan(
  context: WorkspaceContext | undefined,
  organizations: readonly Pick<
    WorkspaceContextOrganization,
    'id' | 'name' | 'role'
  >[],
  billingStates: readonly CanopyOrgBillingState[],
): SelectedOrgWithoutPlan | null {
  if (context?.kind !== 'organization') return null;
  if (!isOrgTeamsLapsed(billingStates, context.organizationId)) return null;
  const organization = organizations.find(
    (candidate) => candidate.id === context.organizationId,
  );
  return {
    organizationId: context.organizationId,
    organizationName: organization?.name ?? 'This organization',
    canChoosePlan: organization?.role === 'OWNER',
  };
}

export function useSelectedOrgWithoutPlan(): SelectedOrgWithoutPlan | null {
  const context = useSidebarScopingContext();
  const organizations = useWorkspaceContextStore(
    (store) => store.state.organizations,
  );
  const billingStates = useSharedContainersStore(
    (store) => store.orgBillingStates,
  );
  return useMemo(
    () => resolveSelectedOrgWithoutPlan(context, organizations, billingStates),
    [context, organizations, billingStates],
  );
}
