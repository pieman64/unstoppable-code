import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type { DigestPreferences } from '@canopy/protocol/digests';
import type {
  DigestOnDemandRequest,
  DigestOnDemandRequestResult,
  DigestProfileFeatureResponse,
} from '@canopy/protocol/settings';

/**
 * Whose digests a control acts on. One component, two subjects: the viewer's
 * own digests or one organization's. Each owner maps onto a fixed settings
 * operation, so no control ever carries an API path.
 */
export type DigestOwner =
  | { kind: 'account' }
  | { kind: 'organization'; organizationId: string };

export const ACCOUNT_DIGEST_OWNER: DigestOwner = { kind: 'account' };

/** The share mutation body both owners accept. */
export type DigestShareUpdate =
  | { action: 'rotate' }
  | { action: 'set-sharing'; sharingEnabled: boolean };

/**
 * A share mutation result. `sharePath` is optional because the serializer
 * omits the share link for viewers who cannot manage sharing.
 */
export interface DigestShareUpdateResult {
  sharePath?: string;
  sharingEnabled: boolean;
}

/** Request an on-demand digest for the owner (`POST .../digests`). */
export function requestDigest(
  client: AccountOrganizationSettingsClient,
  owner: DigestOwner,
  range: DigestOnDemandRequest,
): Promise<DigestOnDemandRequestResult> {
  if (owner.kind === 'account') {
    return client.write('account.digests.request', {
      startDate: range.startDate,
      endDate: range.endDate,
    });
  }
  return client.write('organization.digests.request', {
    organizationId: owner.organizationId,
    startDate: range.startDate,
    endDate: range.endDate,
  });
}

/**
 * The owner's cadence preferences, unparsed: the card narrows the result
 * itself so a malformed body reads as a load failure, never as "all off".
 */
export function readDigestPreferences(
  client: AccountOrganizationSettingsClient,
  owner: DigestOwner,
): Promise<unknown> {
  if (owner.kind === 'account') {
    return client.read('account.notifications.digestPreferences.read', {});
  }
  return client.read('organization.digests.preferences', {
    organizationId: owner.organizationId,
  });
}

/** Write the complete preference object for the owner. */
export function updateDigestPreferences(
  client: AccountOrganizationSettingsClient,
  owner: DigestOwner,
  preferences: DigestPreferences,
): Promise<unknown> {
  const body = {
    daily: preferences.daily,
    weekly: preferences.weekly,
    monthly: preferences.monthly,
    weeklyAnchorDay: preferences.weeklyAnchorDay,
    monthlyAnchorDay: preferences.monthlyAnchorDay,
  };
  if (owner.kind === 'account') {
    return client.write('account.notifications.digestPreferences.update', body);
  }
  return client.write('organization.digests.preferences.update', {
    organizationId: owner.organizationId,
    ...body,
  });
}

/** Turn the anonymous share link on or off, or rotate it. */
export async function updateDigestSharing(
  client: AccountOrganizationSettingsClient,
  owner: DigestOwner,
  digestId: string,
  update: DigestShareUpdate,
): Promise<DigestShareUpdateResult> {
  if (owner.kind === 'account') {
    const result =
      update.action === 'rotate'
        ? await client.write('account.digests.share.update', {
            digestId,
            action: 'rotate',
          })
        : await client.write('account.digests.share.update', {
            digestId,
            action: 'set-sharing',
            sharingEnabled: update.sharingEnabled,
          });
    // The entry's result schema requires `sharingEnabled`; the shared
    // `AccountDigestDetail` type only marks it optional for other reads.
    return shareResult(result.sharingEnabled === true, result.sharePath);
  }
  const result =
    update.action === 'rotate'
      ? await client.write('organization.digests.sharing.update', {
          organizationId: owner.organizationId,
          digestId,
          action: 'rotate',
        })
      : await client.write('organization.digests.sharing.update', {
          organizationId: owner.organizationId,
          digestId,
          action: 'set-sharing',
          sharingEnabled: update.sharingEnabled,
        });
  return shareResult(result.sharingEnabled, result.sharePath);
}

function shareResult(
  sharingEnabled: boolean,
  sharePath: string | undefined,
): DigestShareUpdateResult {
  return sharePath === undefined
    ? { sharingEnabled }
    : { sharingEnabled, sharePath };
}

/**
 * Feature a personal digest on an organization member profile (PUT) or
 * unfeature it (DELETE). Personal digests only.
 */
export function setDigestProfileFeature(
  client: AccountOrganizationSettingsClient,
  digestId: string,
  organizationId: string,
  featured: boolean,
): Promise<DigestProfileFeatureResponse> {
  return client.write('account.digests.profileFeature.set', {
    digestId,
    organizationId,
    featured,
  });
}
