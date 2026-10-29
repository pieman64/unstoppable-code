import type { PreferencesData } from '@canopy/desktop-shared/types';
import { BRAND } from '@canopy/brand/current';
import type { OnboardingProfilePatch } from '@canopy/protocol/plugin-catalog';
import { requestCanopyCloudJson } from '../canopy-cloud/client';
import {
  loadCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import { readPreferencesFile } from '../lib/preferences-store';

const ONBOARDING_PROFILE_PATH = `/api/v1/${BRAND.web.apiNamespace}/account/onboarding-profile`;
const ONBOARDING_PROFILE_TIMEOUT_MS = 5_000;

function hasOwn(
  value: Partial<PreferencesData>,
  key: keyof PreferencesData,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Projects normalized local preferences onto the web account PATCH contract.
 * A save transmits only the onboarding group it touched; startup reconciliation
 * passes the complete preferences object and therefore uploads every locally
 * known answer without clearing fields this installation has never seen.
 */
export function buildOnboardingProfilePatch(
  preferences: PreferencesData,
  changedPreferences: Partial<PreferencesData> = preferences,
): OnboardingProfilePatch {
  const patch: OnboardingProfilePatch = {};
  const roleChanged =
    hasOwn(changedPreferences, 'profileRoles') ||
    hasOwn(changedPreferences, 'profileRole') ||
    hasOwn(changedPreferences, 'profileRoleDetail');
  if (roleChanged) {
    patch.profileRole = preferences.profileRole ?? null;
    patch.profileRoles =
      preferences.profileRoles ??
      (preferences.profileRole ? [preferences.profileRole] : []);
    patch.profileRoleDetail =
      (preferences.profileRoles?.includes('other') ?? false) ||
      preferences.profileRole === 'other'
        ? (preferences.profileRoleDetail ?? null)
        : null;
  }

  const attributionChanged =
    hasOwn(changedPreferences, 'attributionSource') ||
    hasOwn(changedPreferences, 'attributionSourceDetail');
  if (attributionChanged) {
    patch.attributionSource = preferences.attributionSource ?? null;
    patch.attributionSourceDetail =
      preferences.attributionSource === 'other'
        ? (preferences.attributionSourceDetail ?? null)
        : null;
  }

  return patch;
}

async function refreshCuratedRecommendations(): Promise<void> {
  try {
    const { syncCuratedPluginsForRefresh } =
      await import('../plugins/plugin-service');
    await syncCuratedPluginsForRefresh({
      force: true,
      providerNudge: 'background',
    });
  } catch (error) {
    // Profile persistence succeeded. A catalog refresh is only a best-effort
    // reaction; the normal refresh scheduler will retry later.
    // eslint-disable-next-line no-console
    console.warn('Failed to refresh curated plugin recommendations:', error);
  }
}

/**
 * Persists changed onboarding answers to the authenticated cloud account.
 * Transport failures are intentionally left to the caller: preference IPC
 * catches them so the already-committed local save remains successful, while
 * startup reconciliation records and swallows them independently.
 */
export async function syncOnboardingProfilePreferences(
  preferences: PreferencesData,
  changedPreferences: Partial<PreferencesData> = preferences,
): Promise<void> {
  const patch = buildOnboardingProfilePatch(preferences, changedPreferences);
  if (Object.keys(patch).length === 0) return;

  await requestCanopyCloudJson(ONBOARDING_PROFILE_PATH, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    timeoutMs: ONBOARDING_PROFILE_TIMEOUT_MS,
  });

  if ('profileRole' in patch) {
    await refreshCuratedRecommendations();
  }
}

async function reconcileCurrentProfile(): Promise<void> {
  try {
    const preferences = await readPreferencesFile();
    await syncOnboardingProfilePreferences(preferences);
  } catch (error) {
    // Cloud may be unavailable during startup or account transitions. Local
    // preferences remain authoritative until the next save/startup retry.
    // eslint-disable-next-line no-console
    console.warn('Failed to sync onboarding profile to the cloud:', error);
  }
}

/**
 * Uploads existing local answers for the current account and repeats the
 * reconciliation whenever the connected cloud account changes (including the
 * guest-to-user transition). Never delays startup.
 */
export function startOnboardingProfileSync(): () => void {
  let disposed = false;
  let lastApiKey: string | null = null;

  const reconcileAccount = (account: { apiKey?: string } | null): void => {
    const apiKey = account?.apiKey?.trim() ?? '';
    if (disposed) return;
    if (apiKey.length === 0) {
      // A later reconnect may reuse the same credential. Reset the dedupe key
      // so answers saved while signed out get another reconciliation attempt.
      lastApiKey = null;
      return;
    }
    if (apiKey === lastApiKey) return;
    lastApiKey = apiKey;
    void reconcileCurrentProfile();
  };

  const unsubscribe = subscribeCanopyCloudAccountChanges(reconcileAccount);
  void loadCanopyCloudAccount()
    .then(reconcileAccount)
    .catch((): void => {
      // Account loading is best-effort; a later account-change event retries.
    });

  return (): void => {
    disposed = true;
    unsubscribe();
  };
}
