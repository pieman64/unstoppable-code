import { organizationBillingPath } from '@canopy/protocol/billing';
import {
  selectedContextOrganization,
  type WorkspaceContext,
  type WorkspaceContextOrganization,
} from '@canopy/protocol/workspace-context';

// Shared with the web portal (CAN-3926), so both hosts send AI Credits to the
// same page and show the balance that page manages. Re-exported for existing
// desktop callers.
export { resolveCreditsBillingPath } from '@canopy/protocol/billing';
export { selectedContextOrganization } from '@canopy/protocol/workspace-context';

/**
 * Which billing page the selected navigation context points at (CAN-3463).
 *
 * AI Credits spill only onto the pool of the organization that owns the work,
 * so the org a user is working in is the org whose plan matters to them. Pure:
 * callers pass the context and membership list from `workspaceContextStore`.
 */
export interface ContextBillingAction {
  readonly label: string;
  readonly path: string;
  /** The organization the action targets. */
  readonly organization: Pick<WorkspaceContextOrganization, 'id' | 'name'>;
}

/**
 * The billing action for the selected organization context, decided by the
 * user's role there:
 *
 * - OWNER → **Manage plan** on that organization.
 * - ADMIN → **View organization billing** on that organization.
 * - Anyone else, or the Personal context → `null`, so the caller falls back
 *   to the server's pick (see {@link nameOrganizationBillingLabel}).
 */
export function resolveContextBillingAction(
  context: WorkspaceContext,
  organizations: readonly WorkspaceContextOrganization[],
): ContextBillingAction | null {
  const organization = selectedContextOrganization(context, organizations);
  if (!organization) return null;
  const target = { id: organization.id, name: organization.name };
  if (organization.role === 'OWNER') {
    return {
      label: 'Manage plan',
      path: organizationBillingPath(organization.id),
      organization: target,
    };
  }
  if (organization.role === 'ADMIN') {
    return {
      label: 'View organization billing',
      path: organizationBillingPath(organization.id),
      organization: target,
    };
  }
  return null;
}

/**
 * Name the organization on a server-picked organization billing label, so a
 * member working in one org is never shown a bare "Manage plan" that opens
 * another org's billing. Labels that already name a plan are left alone.
 */
export function nameOrganizationBillingLabel(
  label: string,
  organizationName: string,
): string {
  if (label === 'Manage plan') return `Manage ${organizationName}'s plan`;
  if (label === 'View organization billing') {
    return `View ${organizationName}'s billing`;
  }
  return label;
}
