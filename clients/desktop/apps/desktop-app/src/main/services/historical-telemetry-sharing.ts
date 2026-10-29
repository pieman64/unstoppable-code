import type {
  DataSharingOptInHistoryEntry,
  TelemetrySharingPreferences,
  TelemetrySharingVisibility,
} from '@canopy/desktop-shared/types';
import { TELEMETRY_SHARING_SCOPES } from '@canopy/desktop-shared/types';
const AUDIENCE_ORDER: Record<TelemetrySharingVisibility, number> = {
  off: 0,
  private: 1,
  team: 2,
  organization: 3,
};

/** Consent broadens future work only. Current restrictions can still narrow it. */
export function capTelemetrySharingToConsentHistory(
  current: TelemetrySharingPreferences,
  history: readonly DataSharingOptInHistoryEntry[],
  capturedAt: string,
): TelemetrySharingPreferences {
  const next = { ...current };
  const at = Date.parse(capturedAt);
  for (const entry of history) {
    if (Number.isFinite(at) && at >= Date.parse(entry.enabledAt)) continue;
    for (const scope of TELEMETRY_SHARING_SCOPES) {
      if (AUDIENCE_ORDER[entry.sharing[scope]] < AUDIENCE_ORDER[next[scope]])
        next[scope] = entry.sharing[scope];
    }
  }
  return next;
}
