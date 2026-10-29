import type { DataSharingOptInFeature } from '@canopy/protocol/canopy-server';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type {
  CanopyCloudAccountPublicState,
  PreferencesData,
  TelemetryScopeKey,
  TelemetrySharingPreferences,
} from '@canopy/desktop-shared/types';
import { TELEMETRY_SHARING_SCOPES } from '@canopy/desktop-shared/types';
import { isConclusiveAccountRead } from '@canopy/desktop-shared/lib/canopy-cloud-account-read';
import {
  resolveEffectiveTelemetrySharing,
  resolveTelemetryEnforcementByOrganization,
  type TelemetryEnforcement,
} from '@canopy/desktop-shared/lib/telemetry-enforcement';
import { normalizeUuid } from '@canopy/desktop-shared/lib/workspace-owner';
import { DATA_SHARING_OPT_IN_SCOPES } from '@canopy/ui-shared/lib/data-sharing-features';
import { findOrganizationName } from '@/lib/organizationName';
import { sharesWithOrganization } from './telemetry-sharing';

/** One async input to the resolver; `error` is never treated as empty data. */
export type OptInLoad<T> =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; value: T };

export interface DataSharingOptInDisclosure {
  organizationId: string;
  organizationName: string;
  /** Required kinds the action sets to organization visibility. */
  allowedScopes: TelemetryScopeKey[];
  /** Required kinds the organization's policy keeps back. */
  skippedScopes: TelemetryScopeKey[];
  /** Unchanged kinds that start reaching an organization as a consequence. */
  additionalScopes: TelemetryScopeKey[];
}

/**
 * The personal ("Just me") offer for work with no organization: the action
 * raises each required kind stored Off to `private` and nothing else.
 */
export interface DataSharingOptInPersonalDisclosure {
  organizationId: null;
  /** Required kinds the action raises from Off to Just me. */
  allowedScopes: TelemetryScopeKey[];
}

export type DataSharingOptInResolution =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'managed'; organizationId: string; organizationName: string }
  | {
      kind: 'shared';
      audience: 'organization';
      organizationId: string;
      organizationName: string;
    }
  | { kind: 'shared'; audience: 'personal'; organizationId: null }
  | { kind: 'dismissed' }
  | ({
      kind: 'needs-opt-in';
      audience: 'organization';
    } & DataSharingOptInDisclosure)
  | ({
      kind: 'needs-opt-in';
      audience: 'personal';
    } & DataSharingOptInPersonalDisclosure);

export interface ResolveDataSharingOptInInput {
  feature: DataSharingOptInFeature;
  organizationId: string | null;
  account: OptInLoad<CanopyCloudAccountPublicState>;
  preferences: OptInLoad<
    Pick<PreferencesData, 'telemetrySharing' | 'dataSharingOptInHints'>
  >;
  /**
   * Passive hints honor a saved dismissal; deliberate links and blocking
   * recovery flows do not.
   */
  passive: boolean;
  /** Reapply a committed action after runtime failure, with fresh disclosure. */
  reviewShared?: boolean;
}

const NO_ENFORCEMENT: TelemetryEnforcement = {
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
};

/**
 * Whether a kind of work actually reaches an organization under these
 * effective settings, using the delivery rules: plans route independently,
 * everything else rides metadata, and recaps and chats ride only when they
 * were chosen for the same audience as metadata.
 */
export function scopeReachesOrganization(
  effective: TelemetrySharingPreferences,
  scope: TelemetryScopeKey,
): boolean {
  if (scope === 'plans') return sharesWithOrganization(effective.plans);
  if (!sharesWithOrganization(effective.metadata)) return false;
  if (scope === 'metadata') return true;
  return effective[scope] === effective.metadata;
}

function withOrganizationVisibility(
  sharing: TelemetrySharingPreferences,
  scopes: readonly TelemetryScopeKey[],
): TelemetrySharingPreferences {
  const next = { ...sharing };
  for (const scope of scopes) next[scope] = 'organization';
  return next;
}

/**
 * Kinds outside the request that start sharing once the request is saved,
 * under any organization's policy (the settings are global) or none.
 */
function consequentialScopes(
  sharing: TelemetrySharingPreferences,
  allowedScopes: readonly TelemetryScopeKey[],
  requiredScopes: readonly TelemetryScopeKey[],
  enforcements: readonly TelemetryEnforcement[],
): TelemetryScopeKey[] {
  const next = withOrganizationVisibility(sharing, allowedScopes);
  return TELEMETRY_SHARING_SCOPES.filter(
    (scope) =>
      !requiredScopes.includes(scope) &&
      enforcements.some(
        (enforcement) =>
          !scopeReachesOrganization(
            resolveEffectiveTelemetrySharing(sharing, enforcement),
            scope,
          ) &&
          scopeReachesOrganization(
            resolveEffectiveTelemetrySharing(next, enforcement),
            scope,
          ),
      ),
  );
}

/** True when the account read can authorize an explicit sharing choice. */
function accountIsAuthoritative(
  account: CanopyCloudAccountPublicState,
): boolean {
  return (
    isConclusiveAccountRead(account) &&
    account.hasApiKey &&
    account.account !== undefined &&
    account.enforcedSettings !== undefined &&
    account.telemetryEnforcementUnavailable !== true
  );
}

/**
 * True when the account read can authorize a personal sharing choice: a
 * conclusive read with an account and an API key. Personal work has no
 * organization policy to wait on.
 */
function accountCanOptInPersonally(
  account: CanopyCloudAccountPublicState,
): boolean {
  return (
    isConclusiveAccountRead(account) &&
    account.hasApiKey &&
    account.account !== undefined
  );
}

/**
 * Personal work (`organizationId: null`) can opt in only for shared projects,
 * which register through the viewer's own target. The offer raises each
 * required kind stored Off to Just me; anything already shared stands.
 */
function resolvePersonalDataSharingOptIn(
  feature: DataSharingOptInFeature,
  account: CanopyCloudAccountPublicState,
  preferences: Pick<
    PreferencesData,
    'telemetrySharing' | 'dataSharingOptInHints'
  >,
  passive: boolean,
  reviewShared: boolean,
): DataSharingOptInResolution {
  if (feature !== 'shared-projects' || !accountCanOptInPersonally(account)) {
    return { kind: 'unavailable' };
  }
  const allowedScopes = [...DATA_SHARING_OPT_IN_SCOPES[feature]];
  const missing = allowedScopes.filter(
    (scope) => preferences.telemetrySharing[scope] === 'off',
  );
  if (missing.length === 0 && !reviewShared) {
    return { kind: 'shared', audience: 'personal', organizationId: null };
  }
  if (passive && preferences.dataSharingOptInHints?.[feature]) {
    return { kind: 'dismissed' };
  }
  return {
    kind: 'needs-opt-in',
    audience: 'personal',
    organizationId: null,
    allowedScopes,
  };
}

/**
 * Resolve the viewer's opt-in state for one feature and organization from the
 * authoritative desktop preferences and account policy. Order matters:
 * loading, unavailable, managed, shared, dismissed, then the offer. A `null`
 * organization resolves the personal audience (shared projects only).
 */
export function resolveDataSharingOptIn({
  feature,
  organizationId,
  account,
  preferences,
  passive,
  reviewShared = false,
}: ResolveDataSharingOptInInput): DataSharingOptInResolution {
  if (account.status === 'loading' || preferences.status === 'loading') {
    return { kind: 'loading' };
  }
  if (account.status === 'error' || preferences.status === 'error') {
    return { kind: 'unavailable' };
  }
  if (organizationId === null) {
    return resolvePersonalDataSharingOptIn(
      feature,
      account.value,
      preferences.value,
      passive,
      reviewShared,
    );
  }
  const orgId = normalizeUuid(organizationId);
  if (!orgId || !accountIsAuthoritative(account.value)) {
    return { kind: 'unavailable' };
  }
  const organizationName = findOrganizationName(
    account.value.organizations,
    orgId,
  );
  if (organizationName === null) return { kind: 'unavailable' };

  const byOrg = resolveTelemetryEnforcementByOrganization(account.value);
  const enforcement = byOrg.get(orgId)?.enforcement ?? NO_ENFORCEMENT;
  if (enforcement.prohibited.metadata) {
    return { kind: 'managed', organizationId: orgId, organizationName };
  }

  const required = DATA_SHARING_OPT_IN_SCOPES[feature];
  const allowedScopes = required.filter(
    (scope) => !enforcement.prohibited[scope],
  );
  const skippedScopes = required.filter(
    (scope) => enforcement.prohibited[scope],
  );
  const sharing = preferences.value.telemetrySharing;
  const effective = resolveEffectiveTelemetrySharing(sharing, enforcement);
  const missing = allowedScopes.filter(
    (scope) => !scopeReachesOrganization(effective, scope),
  );
  if (missing.length === 0 && !reviewShared) {
    // Anything still missing is policy-only: explain it, never offer it.
    return skippedScopes.length > 0
      ? { kind: 'managed', organizationId: orgId, organizationName }
      : {
          kind: 'shared',
          audience: 'organization',
          organizationId: orgId,
          organizationName,
        };
  }

  if (passive && preferences.value.dataSharingOptInHints?.[feature]) {
    return { kind: 'dismissed' };
  }

  const enforcements = [
    enforcement,
    NO_ENFORCEMENT,
    ...Array.from(byOrg.values(), (entry) => entry.enforcement),
  ];
  return {
    kind: 'needs-opt-in',
    audience: 'organization',
    organizationId: orgId,
    organizationName,
    allowedScopes,
    skippedScopes,
    additionalScopes: consequentialScopes(
      sharing,
      allowedScopes,
      required,
      enforcements,
    ),
  };
}

/**
 * A stable fingerprint of what the viewer was shown. A different fingerprint
 * at submission means the consent is stale and must be shown again.
 */
export function dataSharingOptInDisclosureKey(
  resolution: DataSharingOptInResolution,
): string {
  if (resolution.kind !== 'needs-opt-in') return resolution.kind;
  if (resolution.audience === 'personal') {
    return ['personal', resolution.allowedScopes.join(',')].join('|');
  }
  return [
    resolution.organizationId,
    resolution.organizationName,
    resolution.allowedScopes.join(','),
    resolution.skippedScopes.join(','),
    resolution.additionalScopes.join(','),
  ].join('|');
}

/**
 * The organization a memory sharing hint is about: the selected workspace
 * context when it is eligible, else the only eligible organization. Several
 * eligible organizations and no explicit selection produce no hint; collection
 * order never picks one.
 */
export function resolveOrgMemoryOptInOrganization(
  eligibleOrganizationIds: readonly string[],
  context: WorkspaceContext,
): string | null {
  const eligible = eligibleOrganizationIds.map((id) => id.toLowerCase());
  if (context.kind === 'organization') {
    const selected = context.organizationId.toLowerCase();
    if (eligible.includes(selected)) return selected;
  }
  return eligible.length === 1 ? (eligible[0] ?? null) : null;
}

/** The organization name a resolution carries, or empty when it has none. */
export function optInOrganizationName(
  resolution: DataSharingOptInResolution,
): string {
  if (resolution.kind === 'managed') return resolution.organizationName;
  if (resolution.kind === 'needs-opt-in' || resolution.kind === 'shared') {
    return resolution.audience === 'organization'
      ? resolution.organizationName
      : '';
  }
  return '';
}
