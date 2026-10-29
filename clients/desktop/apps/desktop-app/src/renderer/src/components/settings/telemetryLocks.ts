import type {
  CanopyCloudAccountPublicState,
  TelemetryScopeKey,
  WorkspaceContext,
} from '@canopy/desktop-shared/types';
import { TELEMETRY_SHARING_SCOPES } from '@canopy/desktop-shared/types';
import {
  enforcedValueForScope,
  resolveTelemetryEnforcementByOrganization,
} from '@canopy/desktop-shared/lib/telemetry-enforcement';
import { normalizeUuid } from '@canopy/desktop-shared/lib/workspace-owner';

/**
 * The value an enforced scope is pinned to. Org enforcement is two-way, so a
 * lock is not simply "on": a required scope is pinned UP to `organization` and a
 * prohibited scope is pinned DOWN to `off`. The lock therefore has to carry its
 * value — a boolean map would silently render a prohibited scope as
 * organization-shared, the exact inverse of what the org asked for.
 */
export type TelemetryLockValue = 'organization' | 'off';

export type TelemetryLockMap = Record<
  TelemetryScopeKey,
  TelemetryLockValue | null
>;

/** Lock map with nothing enforced. Shared default for unlinked/unenforced state. */
export const NO_LOCKS: TelemetryLockMap = {
  transcripts: null,
  plans: null,
  metadata: null,
  summaries: null,
};

export interface TelemetryLockState {
  /** Per-scope org enforcement: `organization` = required, `off` = prohibited, `null` = member's choice. */
  locked: TelemetryLockMap;
  /** Tooltip for a REQUIRED scope, naming the selected org. Undefined when nothing is required. */
  lockTooltip: string | undefined;
  /** Tooltip for a PROHIBITED scope, naming the selected org. Undefined when nothing is prohibited. */
  blockedTooltip: string | undefined;
}

/**
 * Resolve the per-scope lock map plus the tooltips naming the enforcing org for
 * the SELECTED workspace context. Shared by every telemetry-sharing surface
 * (Settings → Privacy, the sidebar Cloud sync modal, and the sign-in opt-in) so
 * enforcement renders identically wherever the controls appear.
 *
 * Locks are display only (CAN-3459). An org's rules govern that org's work, and
 * main applies them per queued item against the org that owns the work; they
 * are never written into the saved preference. Settings therefore shows the
 * selected org's policy, and Personal shows no locks at all — policies from
 * separate orgs are never merged here.
 */
export function resolveTelemetryLocks(
  account: CanopyCloudAccountPublicState | null,
  context: WorkspaceContext,
): TelemetryLockState {
  if (context.kind !== 'organization') {
    return {
      locked: { ...NO_LOCKS },
      lockTooltip: undefined,
      blockedTooltip: undefined,
    };
  }
  // The by-org map is keyed by the normalized (lower-case) external id, so the
  // lookup normalizes too: an upper-case id on either side still matches.
  const organizationId = normalizeUuid(context.organizationId);
  const entry = organizationId
    ? resolveTelemetryEnforcementByOrganization(account).get(organizationId)
    : undefined;
  if (!entry) {
    return {
      locked: { ...NO_LOCKS },
      lockTooltip: undefined,
      blockedTooltip: undefined,
    };
  }

  const locked: TelemetryLockMap = { ...NO_LOCKS };
  for (const scope of TELEMETRY_SHARING_SCOPES) {
    // `enforcedValueForScope` is typed against the full visibility vocabulary
    // but only ever pins to the two enforceable ends. Narrowing explicitly (over
    // asserting the type) means a widened return lands as "unlocked" here and
    // fails this check, rather than putting a value the selector cannot pin into
    // the lock map.
    const pinned = enforcedValueForScope(entry.enforcement, scope);
    if (pinned === 'organization' || pinned === 'off') {
      locked[scope] = pinned;
    }
  }

  // Within one org prohibition already beats requirement, so each tooltip is
  // emitted exactly when that org still holds a lock of its kind.
  const requires = TELEMETRY_SHARING_SCOPES.some(
    (scope) => locked[scope] === 'organization',
  );
  const prohibits = TELEMETRY_SHARING_SCOPES.some(
    (scope) => locked[scope] === 'off',
  );
  const name = entry.organizationName;

  return {
    locked,
    lockTooltip: requires
      ? `Managed by ${name}. Contact an admin to change.`
      : undefined,
    blockedTooltip: prohibits
      ? `Blocked by ${name}. Its work stays on your machine.`
      : undefined,
  };
}
