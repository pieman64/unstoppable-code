// ---------------------------------------------------------------------------
// Main-process access to the org-enforced telemetry policy.
//
// The pure resolution lives in
// `@canopy/desktop-shared/lib/telemetry-enforcement`; this module is the thin
// Node-side reader that pulls the last persisted (encrypted) cloud account off
// disk and resolves it, plus the org-name attribution the UI needs to say WHO
// blocked a scope.
//
// Reading the persisted account rather than waiting for a network probe is
// deliberate: it closes the fail-open window between app start and the first
// `reprobeAndApplyCanopyCloudEnforcedSettings()` pass, during which a
// prohibited scope would otherwise upload freely.
//
// A confirmed signed-out read resolves to "nothing enforced". A decrypt failure
// or unavailable safeStorage remains distinguishable and throws so each policy
// boundary can fail closed for organization-governed work while allowing work
// known to be Personal. Callers record a `telemetry_enforcement_read_failed`
// diagnostic at the boundary they block.
// ---------------------------------------------------------------------------

import {
  resolveTelemetryEnforcementByOrganization,
  type OrgTelemetryEnforcement,
} from '@canopy/desktop-shared/lib/telemetry-enforcement';
import { getObservabilityService } from '../observability';
import {
  readCanopyCloudAccountWithStatus,
  toPublicCanopyCloudAccountState,
} from './canopy-cloud-account-store';

export type StoredTelemetryEnforcementByOrganization = ReadonlyMap<
  string,
  OrgTelemetryEnforcement
>;

export function emptyTelemetryEnforcementByOrganization(): StoredTelemetryEnforcementByOrganization {
  return new Map();
}

/**
 * Record the app diagnostic for a failed enforcement read.
 *
 * Deliberately an APP diagnostic, not a session one: the enforced policy is an
 * account-wide property with no worktree or chat in scope, and app-events must
 * never carry a worktree id.
 *
 * Shared with the other best-effort readers of this state (run-share
 * eligibility) so every silent fall-through to "nothing enforced" lands under
 * one triage kind. Self-guarding: a diagnostics failure must not turn a
 * degraded read into a thrown one.
 */
export function recordTelemetryEnforcementReadFailure(
  reason: string,
  error: unknown,
): void {
  try {
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'telemetry_enforcement_read_failed',
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // Best-effort by construction.
  }
}

/**
 * Read the persisted cloud account and resolve the org-enforced telemetry
 * policy from it. A confirmed signed-out read returns an empty map; a degraded
 * secure-storage read throws so callers cannot mistake it for sign-out.
 */
export async function loadStoredTelemetryEnforcementByOrganization(): Promise<StoredTelemetryEnforcementByOrganization> {
  const result = await readCanopyCloudAccountWithStatus();
  if (result.status === 'unavailable') {
    throw new Error('Secure account storage is unavailable.');
  }
  if (result.status === 'error') {
    throw result.error;
  }
  if (result.entry?.telemetryEnforcementUnavailable === true) {
    throw new Error('Organization telemetry policy is unavailable.');
  }
  const account = toPublicCanopyCloudAccountState(result.entry);
  return resolveTelemetryEnforcementByOrganization(account);
}
