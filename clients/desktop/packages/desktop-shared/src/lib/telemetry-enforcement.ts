// ---------------------------------------------------------------------------
// Pure org-enforced telemetry-sync resolution.
//
// Reads the generic `enforcedSettings` policies mirrored onto the cloud-account
// state, filters to the `telemetry-sync` policy kind, and resolves each scope
// per organization. No I/O, no Electron, so it stays usable from both the
// main-process applier and the renderer lock UI and passes
// `npm run check:electron-boundary`.
//
// Enforcement is TWO-WAY. Each org states, per scope, one of three things:
//   - required   — the member must upload it at `organization` visibility
//   - prohibited — the member may not upload it at ANY visibility, including
//                  their own private cloud account
//   - unset      — the member's choice (today's behavior for every scope)
//
// Within one org, prohibition beats requirement, so the resolved maps are
// always disjoint and a scope is never both. Policies from separate orgs are
// never merged for runtime enforcement.
//
// A future enforced-policy kind gets its own resolver here; the account
// plumbing (`enforcedSettings`) is shared.
// ---------------------------------------------------------------------------

import {
  ORG_PROJECT_ACTIVITY_KINDS,
  type OrgProjectActivityKind,
} from '@canopy/protocol/org-projects';
import type {
  CanopyCloudAccountPublicState,
  OrgProhibitableUsageDataKey,
  TelemetryScopeKey,
  TelemetrySharingPreferences,
  TelemetrySharingVisibility,
} from '../types';
import {
  ORG_PROHIBITABLE_USAGE_DATA_KEYS,
  TELEMETRY_SHARING_SCOPES,
} from '../types';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';

export interface EnforcedTelemetryScopes {
  transcripts: boolean;
  plans: boolean;
  metadata: boolean;
  summaries: boolean;
}

/** Resolved two-way enforcement for the signed-in account. */
export interface TelemetryEnforcement {
  /** Scopes pinned to `'organization'`. */
  required: EnforcedTelemetryScopes;
  /** Scopes pinned to `'off'` — never uploaded anywhere. */
  prohibited: EnforcedTelemetryScopes;
}

export interface OrgTelemetryEnforcement {
  organizationName: string;
  enforcement: TelemetryEnforcement;
}

function emptyScopes(): EnforcedTelemetryScopes {
  return {
    transcripts: false,
    plans: false,
    metadata: false,
    summaries: false,
  };
}

/** True when no scope in the map is set. */
export function isEmptyEnforcedScopes(
  scopes: EnforcedTelemetryScopes,
): boolean {
  return TELEMETRY_SHARING_SCOPES.every((scope) => !scopes[scope]);
}

/**
 * Resolve the legacy account-wide union. This exists only so the one-time
 * telemetry-pin migration can recognize values written by the old applier.
 * OR the prohibitions, OR the requirements, then subtract the prohibitions
 * from the requirements so the two maps are disjoint.
 *
 * Reads each flag with a strict `=== true`. Never test these with `!== true`:
 * under the three-state model an absent/`undefined` scope means "unset"
 * (member's choice), and treating it as prohibited would black out an org's
 * dashboards while treating it as required would force sharing nobody asked
 * for.
 */
export function resolveAccountWideTelemetryEnforcement(
  account: CanopyCloudAccountPublicState | null,
): TelemetryEnforcement {
  const required = emptyScopes();
  const prohibited = emptyScopes();

  const settings = account?.enforcedSettings;
  if (!settings) {
    return { required, prohibited };
  }

  for (const org of settings) {
    for (const policy of org.policies) {
      if (policy.kind !== 'telemetry-sync') {
        continue;
      }
      for (const scope of TELEMETRY_SHARING_SCOPES) {
        if (policy.scopes[scope] === true) {
          required[scope] = true;
        }
        if (policy.prohibitedScopes?.[scope] === true) {
          prohibited[scope] = true;
        }
      }
    }
  }

  // This is intentionally the legacy account-wide merge used only by the pin
  // migration. Runtime enforcement resolves one organization at a time.
  for (const scope of TELEMETRY_SHARING_SCOPES) {
    if (prohibited[scope]) {
      required[scope] = false;
    }
  }

  return { required, prohibited };
}

/** Resolve telemetry policy independently for each organization. */
export function resolveTelemetryEnforcementByOrganization(
  account: CanopyCloudAccountPublicState | null,
): ReadonlyMap<string, OrgTelemetryEnforcement> {
  const byOrg = new Map<string, OrgTelemetryEnforcement>();

  for (const org of account?.enforcedSettings ?? []) {
    const organizationId = normalizeUuid(org.organizationId);
    if (!organizationId) continue;

    const existing = byOrg.get(organizationId);
    const required = existing
      ? { ...existing.enforcement.required }
      : emptyScopes();
    const prohibited = existing
      ? { ...existing.enforcement.prohibited }
      : emptyScopes();

    for (const policy of org.policies) {
      if (policy.kind !== 'telemetry-sync') continue;
      for (const scope of TELEMETRY_SHARING_SCOPES) {
        if (policy.scopes[scope] === true) required[scope] = true;
        if (policy.prohibitedScopes?.[scope] === true) {
          prohibited[scope] = true;
        }
      }
    }

    for (const scope of TELEMETRY_SHARING_SCOPES) {
      if (prohibited[scope]) required[scope] = false;
    }

    byOrg.set(organizationId, {
      organizationName: org.organizationName,
      enforcement: { required, prohibited },
    });
  }

  return byOrg;
}

/** Which org-prohibitable usage-data flows one organization turns off. */
export type UsageDataProhibitions = Record<
  OrgProhibitableUsageDataKey,
  boolean
>;

export interface OrgUsageDataProhibition {
  organizationName: string;
  prohibited: UsageDataProhibitions;
}

export function emptyUsageDataProhibitions(): UsageDataProhibitions {
  return {
    productAnalytics: false,
    sessionReplay: false,
    errorReports: false,
    activeUseSignal: false,
    featureFlagIdentity: false,
  };
}

/**
 * Resolve the `usage-data` policy independently for each organization.
 * Organizations without the policy are absent from the map. Flags are read as
 * `=== true` and OR-ed across duplicate entries, so a prohibition only ever
 * narrows.
 */
export function resolveUsageDataProhibitionByOrganization(
  account: CanopyCloudAccountPublicState | null,
): ReadonlyMap<string, OrgUsageDataProhibition> {
  const byOrg = new Map<string, OrgUsageDataProhibition>();

  for (const org of account?.enforcedSettings ?? []) {
    const organizationId = normalizeUuid(org.organizationId);
    if (!organizationId) continue;

    for (const policy of org.policies) {
      if (policy.kind !== 'usage-data') continue;
      const existing = byOrg.get(organizationId);
      const prohibited = existing
        ? { ...existing.prohibited }
        : emptyUsageDataProhibitions();
      for (const key of ORG_PROHIBITABLE_USAGE_DATA_KEYS) {
        if (policy.prohibited[key] === true) prohibited[key] = true;
      }
      byOrg.set(organizationId, {
        organizationName: org.organizationName,
        prohibited,
      });
    }
  }

  return byOrg;
}

/** Return one organization's policy, or empty enforcement for ungoverned work. */
export function enforcementForOrganization(
  byOrg: ReadonlyMap<string, OrgTelemetryEnforcement>,
  orgId: string | null,
): TelemetryEnforcement {
  const normalizedId = normalizeUuid(orgId);
  const match = normalizedId ? byOrg.get(normalizedId) : undefined;
  return (
    match?.enforcement ?? {
      required: emptyScopes(),
      prohibited: emptyScopes(),
    }
  );
}

/**
 * Pin each enforced scope to its enforced value: required ⇒ `'organization'`,
 * prohibited ⇒ `'off'`. Scopes no org has an opinion on pass through untouched,
 * so de-enforcement or sign-out unlocks the control and leaves the member's
 * current value intact.
 *
 * Returns the same reference when nothing is enforced.
 */
export function applyTelemetryEnforcement(
  sharing: TelemetrySharingPreferences,
  enforcement: TelemetryEnforcement,
): TelemetrySharingPreferences {
  if (
    isEmptyEnforcedScopes(enforcement.required) &&
    isEmptyEnforcedScopes(enforcement.prohibited)
  ) {
    return sharing;
  }
  const next: TelemetrySharingPreferences = { ...sharing };
  for (const scope of TELEMETRY_SHARING_SCOPES) {
    const pinned = enforcedValueForScope(enforcement, scope);
    if (pinned !== null) {
      next[scope] = pinned;
    }
  }
  return next;
}

/**
 * The member's sharing for work one organization governs: its policy pinned
 * over the member's values. Transcript and summary bodies ride
 * metadata-owned rows, so a requirement for either raises metadata to the
 * same organization scope; a metadata prohibition still wins.
 */
export function resolveEffectiveTelemetrySharing(
  sharing: TelemetrySharingPreferences,
  enforcement: TelemetryEnforcement,
): TelemetrySharingPreferences {
  const effective = applyTelemetryEnforcement(sharing, enforcement);
  if (
    !enforcement.prohibited.metadata &&
    (enforcement.required.transcripts || enforcement.required.summaries)
  ) {
    return { ...effective, metadata: 'organization' };
  }
  return effective;
}

/**
 * Whether the member's already-uploaded private activity for an organization
 * project may move to that organization (CAN-3517), from their effective
 * sharing for it. Only an `organization` choice for metadata shares it; Just
 * me, Off and a legacy team choice keep it private, since that privacy may
 * have been chosen. Each other kind not shared with the organization is
 * withheld: the server refuses a move that would carry it.
 */
export function resolveActivityRepairSharing(
  effective: TelemetrySharingPreferences,
): { share: false } | { share: true; withheldKinds: OrgProjectActivityKind[] } {
  if (effective.metadata !== 'organization') return { share: false };
  return {
    share: true,
    withheldKinds: ORG_PROJECT_ACTIVITY_KINDS.filter(
      (kind) => effective[kind] !== 'organization',
    ),
  };
}

/**
 * The value a scope is pinned to, or `null` when no org has an opinion on it.
 * Shared by the applier and the renderer lock map so both agree on precedence.
 */
export function enforcedValueForScope(
  enforcement: TelemetryEnforcement,
  scope: TelemetryScopeKey,
): TelemetrySharingVisibility | null {
  if (enforcement.prohibited[scope]) {
    return 'off';
  }
  if (enforcement.required[scope]) {
    return 'organization';
  }
  return null;
}
