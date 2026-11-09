import type { DataSharingOptInRefusal } from '@canopy/desktop-shared/types';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import {
  resolveTelemetryEnforcementByOrganization,
  type TelemetryEnforcement,
} from '@canopy/desktop-shared/lib/telemetry-enforcement';
import {
  readCanopyCloudAccountWithStatus,
  toPublicCanopyCloudAccountState,
  type CanopyCloudAccountEntry,
} from './canopy-cloud-account-store';

export class DataSharingOptInError extends Error {
  constructor(readonly reason: DataSharingOptInRefusal) {
    super(reason);
  }
}
/**
 * A conclusive, uncached account read with an account and a non-empty API key.
 * Shared by the organization and personal variants so an inconclusive read is
 * classified identically for both.
 */
async function readOptInAccountEntry(): Promise<CanopyCloudAccountEntry> {
  const result = await readCanopyCloudAccountWithStatus({ cache: false });
  if (
    result.status !== 'ok' ||
    !result.entry?.account ||
    !result.entry.apiKey.trim()
  ) {
    throw new DataSharingOptInError('account-unavailable');
  }
  return result.entry;
}

/**
 * Authority for the personal (`private`, "Just me") opt-in. Personal work has
 * no organization, so no membership or enforcement check applies.
 */
export async function requireDataSharingPersonalOptInAuthority(): Promise<void> {
  await readOptInAccountEntry();
}

export async function requireDataSharingOptInAuthority(
  organizationId: string,
): Promise<TelemetryEnforcement> {
  const entry = await readOptInAccountEntry();
  const account = toPublicCanopyCloudAccountState(entry);
  if (
    !account.organizations?.some(
      (org) => normalizeUuid(org.id) === organizationId,
    )
  ) {
    throw new DataSharingOptInError('not-member');
  }
  // An absent snapshot is unavailable, not an empty restrictions list.
  if (
    entry.enforcedSettings === undefined ||
    entry.telemetryEnforcementUnavailable === true
  ) {
    throw new DataSharingOptInError('enforcement-unavailable');
  }
  const enforcement =
    resolveTelemetryEnforcementByOrganization(account).get(
      organizationId,
    )?.enforcement;
  // An authoritative empty list means the org has no enforced policies.
  return (
    enforcement ?? {
      required: {
        metadata: false,
        plans: false,
        summaries: false,
        transcripts: false,
      },
      prohibited: {
        metadata: false,
        plans: false,
        summaries: false,
        transcripts: false,
      },
    }
  );
}
