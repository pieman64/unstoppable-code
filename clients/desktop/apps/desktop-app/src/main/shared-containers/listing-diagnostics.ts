import { CanopyCloudClientError } from '../canopy-cloud/client';
import { getObservabilityService } from '../observability';
import { DIRECT_SHARED_CONTAINER_SCOPE_KEY } from './owner-scope';

/**
 * How long a single organization's billing-block diagnostic suppresses repeats.
 *
 * `loadSharedWithMe` runs on every replica `null` broadcast, every failed
 * dismiss, and every account resync, and a lapsed organization is queried on
 * each one — so without a window a persistently lapsed account writes an
 * unbounded stream of identical entries into app-events, crowding out unrelated
 * diagnostics within the retention period. One entry per organization per
 * window is enough to triage a condition that, by definition, is not changing.
 */
const BLOCKED_DIAGNOSTIC_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

const lastRecordedByOrganization = new Map<string, number>();
const lastUnavailableRecordedByOrganization = new Map<string, number>();

/**
 * Clear the dedupe window. Exported for tests only: the map is module state, so
 * one spec recording a diagnostic would otherwise suppress the next spec's.
 */
export function resetSharedContainerListingBlockedDedupe(): void {
  lastRecordedByOrganization.clear();
}

export function resetSharedContainerListingUnavailableDedupe(): void {
  lastUnavailableRecordedByOrganization.clear();
}

/**
 * Record the app diagnostic for a shared-container listing the server refused
 * on billing grounds (CAN-2551).
 *
 * Deliberately an APP diagnostic, not a session one: a "shared with me"
 * listing is account/organization-wide and has no worktree or chat in scope,
 * and app-events must never carry a worktree id.
 *
 * Self-guarding, modelled on `recordTelemetryEnforcementReadFailure`: the
 * caller converts a benign refusal into an empty response, so a failure to
 * write the diagnostic must never be what turns that refusal back into a
 * thrown error.
 *
 * Deduplicated per organization over `BLOCKED_DIAGNOSTIC_DEDUPE_WINDOW_MS`.
 *
 * Triage: ripgrep for `shared_container_listing_blocked` under the data root's
 * `agent-observability/diagnostics/app-events/` directory (`~/.canopy` in
 * production, `~/.canopy-dev` in development).
 */
export function recordSharedContainerListingBlocked(
  /** Absent for the organization-independent direct-share listing. */
  organizationId: string | undefined,
  error: unknown,
): void {
  const dedupeKey = organizationId ?? DIRECT_SHARED_CONTAINER_SCOPE_KEY;
  const now = Date.now();
  const lastRecorded = lastRecordedByOrganization.get(dedupeKey);
  if (
    lastRecorded !== undefined &&
    now - lastRecorded < BLOCKED_DIAGNOSTIC_DEDUPE_WINDOW_MS
  ) {
    return;
  }
  try {
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'shared_container_listing_blocked',
      reason: 'shared-with-me listing refused by org billing',
      ...(organizationId !== undefined
        ? { sharedContainerOrganizationId: organizationId }
        : {}),
      // The transport/server CLASSIFICATION, never `error.message`. A
      // `CanopyCloudClientError` message is the server's human-readable `error`
      // string — prose the server is free to reword, and which can embed
      // organization names. This lands in global app-events, and `status` plus
      // `serverCode` are both strictly more diagnostic and free of server text.
      error:
        error instanceof CanopyCloudClientError
          ? `${error.status ?? 'no-status'}/${error.serverCode ?? 'no-code'}`
          : error instanceof Error
            ? error.name
            : 'unknown',
    });
    // Stamped only AFTER a successful write. Stamping before the attempt would
    // let a transient observability failure cost the full window, so the next
    // listing could not retry and the window would mean "attempted 5 minutes
    // ago" rather than "recorded 5 minutes ago".
    lastRecordedByOrganization.set(dedupeKey, now);
  } catch {
    // Best-effort by construction.
  }
}

/**
 * Record one compact app diagnostic for a retryable Cloud listing outage.
 * Server prose is deliberately excluded because it is neither stable nor safe
 * attribution. The transport and server codes are enough for one-grep triage.
 */
export function recordSharedContainerListingUnavailable(
  /** Absent for the organization-independent direct-share listing. */
  organizationId: string | undefined,
  error: unknown,
): void {
  const dedupeKey = organizationId ?? DIRECT_SHARED_CONTAINER_SCOPE_KEY;
  const now = Date.now();
  const lastRecorded = lastUnavailableRecordedByOrganization.get(dedupeKey);
  if (
    lastRecorded !== undefined &&
    now - lastRecorded < BLOCKED_DIAGNOSTIC_DEDUPE_WINDOW_MS
  ) {
    return;
  }

  try {
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'shared_container_listing_unavailable',
      reason: 'shared-with-me listing temporarily unavailable',
      ...(organizationId !== undefined
        ? { sharedContainerOrganizationId: organizationId }
        : {}),
      error:
        error instanceof CanopyCloudClientError
          ? `${error.status ?? 'no-status'}/${error.serverCode ?? error.code}`
          : error instanceof Error
            ? error.name
            : 'unknown',
    });
    lastUnavailableRecordedByOrganization.set(dedupeKey, now);
  } catch {
    // Best-effort by construction.
  }
}
