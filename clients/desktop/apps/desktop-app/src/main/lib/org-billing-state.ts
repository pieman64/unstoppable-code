// ---------------------------------------------------------------------------
// Main-process access to per-org billing state (CAN-2311).
//
// The pure predicates live in
// `@canopy/desktop-shared/lib/org-billing-state-parsing`; this module is the
// thin Node-side reader that pulls the last persisted (encrypted) cloud account
// off disk so every org-backed feature can ask "has THIS org lapsed?" without
// a network round-trip on a hot path.
//
// Reading the persisted snapshot rather than probing is deliberate, and matches
// `telemetry-enforcement-state`: it closes the window between app start and the
// first account re-probe, and it keeps the gate answerable offline.
//
// Two invariants that must not regress:
//
//  1. EVERY gate is keyed by org id. There is no global "the user is lapsed"
//     switch — a member of one lapsed org and one healthy org keeps full
//     org-backed function through the healthy one.
//  2. Unknown ⇒ NOT lapsed. A signed-out user, a decrypt failure, an older
//     server that never sent `orgBillingStates`, or an org missing from the
//     list all resolve to "not lapsed". The server-side guard is the
//     authoritative half; this local half exists to explain and short-circuit,
//     never to invent a lockout.
// ---------------------------------------------------------------------------

import type { CanopyOrgBillingState } from '@canopy/protocol/canopy-server';
import {
  isOrgTeamsLapsed,
  lapsedOrgNames,
} from '@canopy/desktop-shared/lib/org-billing-state-parsing';
import { loadCanopyCloudAccount } from './canopy-cloud-account-store';

/**
 * Read the per-org billing state off the persisted cloud account. Never throws;
 * resolves to an empty list (⇒ nothing lapsed) on any failure.
 */
export async function loadStoredOrgBillingStates(): Promise<
  CanopyOrgBillingState[]
> {
  try {
    return (await loadCanopyCloudAccount())?.orgBillingStates ?? [];
  } catch {
    // Fail-open: see invariant 2 in the header.
    return [];
  }
}

/**
 * Whether one specific organization has lost the `teams` capability. The single
 * question every per-org gate asks.
 */
export async function isOrganizationTeamsLapsed(
  organizationId: string,
): Promise<boolean> {
  return isOrgTeamsLapsed(await loadStoredOrgBillingStates(), organizationId);
}

/**
 * Names of the lapsed orgs among `organizationIds`, for copy that has to say
 * WHICH org is blocked instead of failing generically.
 */
export async function resolveLapsedOrganizationNames(
  organizationIds: readonly string[],
): Promise<string[]> {
  return lapsedOrgNames(await loadStoredOrgBillingStates(), organizationIds);
}
