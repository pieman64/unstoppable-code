import type {
  ShareAudience,
  ShareOrganizationAccess,
} from '@canopy/protocol/sharing';
import type { ShareTarget } from '@canopy/ui-shared/components';

/** Account facts the selected-destination check reads. */
export interface ShareDestinationAccessAccount {
  readonly organizationAccess?: readonly ShareOrganizationAccess[];
  readonly freeAccess?: boolean;
}

/**
 * What the dialog knows about the selected destination before uploading.
 * Advisory only: the server decides every share, so `unknown` never blocks.
 */
export type ShareDestinationAccess =
  | { readonly status: 'none' }
  | { readonly status: 'unknown'; readonly organizationId?: string }
  | { readonly status: 'entitled'; readonly organizationId: string }
  | {
      readonly status: 'lapsed';
      readonly organizationId: string;
      readonly organizationName?: string;
      /** `undefined` when the host does not report the account's role. */
      readonly canChoosePlan?: boolean;
    };

/**
 * The selected destination's known access. The governing organization is the
 * selected organization, or the selected team's own organization; it is never
 * inferred from membership order. A team whose organization the account facts
 * omit, a host that reports no facts, and free access all resolve to a state
 * that does not block.
 */
export function resolveSelectedDestinationAccess(
  account: ShareDestinationAccessAccount | null,
  scope: ShareAudience | null,
  selectedTeam: ShareTarget | null,
  selectedOrg: ShareTarget | null,
): ShareDestinationAccess {
  const organizationId =
    scope === 'organization'
      ? selectedOrg?.id
      : scope === 'team'
        ? selectedTeam?.organizationId
        : undefined;
  if (scope !== 'team' && scope !== 'organization') return { status: 'none' };
  if (organizationId === undefined) return { status: 'unknown' };
  if (account?.freeAccess === true) {
    return { status: 'entitled', organizationId };
  }
  const fact = account?.organizationAccess?.find(
    (entry) => entry.organizationId === organizationId,
  );
  if (fact?.teamsEntitled === true) {
    return { status: 'entitled', organizationId };
  }
  if (fact?.teamsEntitled === false) {
    const organizationName =
      fact.organizationName ??
      (scope === 'organization' ? selectedOrg?.name : undefined);
    return {
      status: 'lapsed',
      organizationId,
      ...(organizationName !== undefined ? { organizationName } : {}),
      ...(fact.canChoosePlan !== undefined
        ? { canChoosePlan: fact.canChoosePlan }
        : {}),
    };
  }
  return { status: 'unknown', organizationId };
}
