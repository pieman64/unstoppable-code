import {
  enforcedValueForScope,
  resolveAccountWideTelemetryEnforcement,
} from '@canopy/desktop-shared/lib/telemetry-enforcement';
import {
  TELEMETRY_SHARING_SCOPES,
  type CanopyCloudAccountPublicState,
  type TelemetryScopeKey,
} from '@canopy/desktop-shared/types';
import { isConclusiveAccountRead } from '@canopy/desktop-shared/lib/canopy-cloud-account-read';
import { getTelemetrySyncService } from '../services/telemetry-sync-service';
import { logMainProcessInfo } from './main-process-logging';
import { hasMigrationRun, markMigrationRun } from './migrations';
import {
  DEFAULT_PREFERENCES,
  peekPreferencesLoadError,
  readPreferencesFile,
  updatePreferencesFile,
} from './preferences-store';

export const TELEMETRY_ORG_PINS_RESET_MIGRATION_KEY =
  'telemetry_org_pins_reset';

/** Remove values the legacy account-wide applier pinned into preferences. */
export async function migrateOrgPinnedTelemetrySharing(
  account: CanopyCloudAccountPublicState | null,
): Promise<boolean> {
  if (await hasMigrationRun(TELEMETRY_ORG_PINS_RESET_MIGRATION_KEY)) {
    return false;
  }
  if (!account || !isConclusiveAccountRead(account)) return false;

  await readPreferencesFile();
  if (peekPreferencesLoadError()) return false;

  const union = resolveAccountWideTelemetryEnforcement(account);
  const resetScopes: TelemetryScopeKey[] = [];
  await updatePreferencesFile((current) => {
    const nextResetScopes: TelemetryScopeKey[] = [];
    const telemetrySharing = { ...current.telemetrySharing };
    for (const scope of TELEMETRY_SHARING_SCOPES) {
      const enforced = enforcedValueForScope(union, scope);
      const defaultValue = DEFAULT_PREFERENCES.telemetrySharing[scope];
      if (
        enforced !== null &&
        current.telemetrySharing[scope] === enforced &&
        current.telemetrySharing[scope] !== defaultValue
      ) {
        telemetrySharing[scope] = defaultValue;
        nextResetScopes.push(scope);
      }
    }
    resetScopes.splice(0, resetScopes.length, ...nextResetScopes);
    return nextResetScopes.length > 0 ? { telemetrySharing } : {};
  });
  if (resetScopes.length > 0) {
    logMainProcessInfo(
      '[telemetry] reset legacy org-pinned sharing preferences',
      { count: resetScopes.length, scopes: resetScopes },
    );
  }
  // Refresh before marking even when a previous attempt already committed the
  // reset. That makes both refresh and marker failures retryable without
  // leaving the process-lifetime service on a stale legacy value.
  await getTelemetrySyncService().refreshScopeFromPreferences();
  await markMigrationRun(TELEMETRY_ORG_PINS_RESET_MIGRATION_KEY);
  return resetScopes.length > 0;
}
