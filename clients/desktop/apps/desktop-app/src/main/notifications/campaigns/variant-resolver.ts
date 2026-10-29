import type {
  ActivationCampaignId,
  CampaignSuppressionReason,
  ProfileRoleId,
} from '@canopy/desktop-shared/types';
import { probeEntitlementsSummary } from '../../canopy-cloud/entitlements';
import { readPreferencesFile } from '../../lib/preferences-store';
import { DEFAULT_VARIANT_KEY } from './campaign-config';

/**
 * Copy-variant resolution for activation campaigns (CAN-2438).
 *
 * A `null` key is a real outcome, not an error path: campaign 2 deliberately
 * has no neutral branch, so a user it cannot address is skipped rather than
 * sent generic copy. The accompanying reason keeps that distinguishable in the
 * funnel — "never answered the role question" and "answered with a role we do
 * not branch on" call for different product responses.
 */
export type VariantResolution =
  | { variantKey: string }
  | { variantKey: null; reason: CampaignSuppressionReason };

/**
 * Approved role mapping. `designer`, `founder`, `data-analytics`, `student`,
 * and `other` are deliberately absent: they map cleanly to neither branch, and
 * guessing would put the wrong pitch in front of them.
 */
const ROLE_VARIANTS: Partial<Record<ProfileRoleId, string>> = {
  'software-engineer': 'developer',
  'engineering-leader': 'developer',
  'product-manager': 'business',
  'marketing-sales': 'business',
  marketing: 'business',
  sales: 'business',
  operations: 'business',
  support: 'business',
  'operations-support': 'business',
};

/**
 * Campaign 1 promises a free month only when the account demonstrably has one.
 * The ticket is explicit — "do not show an offer the account cannot claim" —
 * so an unresolved probe (offline, auth failure, 5xx) falls back to generic
 * copy rather than guessing. `probeEntitlementsSummary` never throws and
 * returns `{ resolved: false }` on any transient failure.
 *
 * Reading `trial.active` matches the campaign's own wording, which tells the
 * user the month is *ready* — i.e. already theirs. It is deliberately not an
 * attempt to infer claim eligibility from billing state, which would be a
 * guess about semantics this module does not own.
 *
 * Free app access has no trial to offer: every feature is already unlocked,
 * so the "free month" copy would frame the app as a trial (CAN-3926). The
 * server reports no trial then; the explicit check keeps that true even if a
 * response carries both.
 */
async function resolveFirstTaskVariant(): Promise<VariantResolution> {
  const probe = await probeEntitlementsSummary();
  if (!probe.resolved || probe.freeAccess) {
    return { variantKey: DEFAULT_VARIANT_KEY };
  }
  return {
    variantKey: probe.trial?.active === true ? 'offer' : DEFAULT_VARIANT_KEY,
  };
}

async function resolveRoleVariant(): Promise<VariantResolution> {
  const preferences = await readPreferencesFile();
  const role = preferences.profileRole;
  if (role === undefined) {
    return { variantKey: null, reason: 'role-unknown' };
  }
  const variantKey = ROLE_VARIANTS[role];
  if (variantKey === undefined) {
    return { variantKey: null, reason: 'role-not-mapped' };
  }
  return { variantKey };
}

export async function resolveCampaignVariantKey(
  campaignId: ActivationCampaignId,
): Promise<VariantResolution> {
  try {
    switch (campaignId) {
      case 'activation-first-task':
        return await resolveFirstTaskVariant();
      case 'activation-role-branch':
        return await resolveRoleVariant();
      case 'activation-marketplace':
      case 'activation-mobile':
        return { variantKey: DEFAULT_VARIANT_KEY };
    }
  } catch {
    // Never let a resolver failure become a send with the wrong copy.
    return { variantKey: null, reason: 'variant-unavailable' };
  }
}
