import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { registeredHostedSettingsClient } from '@/client/hosted-settings-client-registry';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { resolveHostedSettingsHref } from './hosted-settings-location';

const HOSTED_SETTINGS_FLAG_KEY =
  CLIENT_FEATURE_FLAGS.canopyDesktopHostedSettings.key;

/**
 * The hosted settings client this window may use, or `null` when hosted
 * account and organization settings are unavailable here.
 *
 * Hosted settings need the `canopy-desktop-hosted-settings` rollout flag,
 * the capability (main's settings bridge is exposed), and a window that
 * shows this computer: a remote-control window has the preload bridge too,
 * but main blocks the settings channels there.
 */
export function useHostedSettingsClient(): AccountOrganizationSettingsClient | null {
  const localWindow = useRemoteControlStore(
    (store) => store.context.mode === 'local',
  );
  const rolledOut = useFeatureFlagsStore((state) =>
    state.isEnabled(HOSTED_SETTINGS_FLAG_KEY),
  );
  return localWindow && rolledOut ? capableSettingsClient() : null;
}

function capableSettingsClient(): AccountOrganizationSettingsClient | null {
  return registeredHostedSettingsClient();
}

/** {@link useHostedSettingsAvailable} for event handlers outside React. */
export function hostedSettingsOpenable(): boolean {
  return (
    useRemoteControlStore.getState().context.mode === 'local' &&
    useFeatureFlagsStore.getState().isEnabled(HOSTED_SETTINGS_FLAG_KEY) &&
    capableSettingsClient() !== null
  );
}

/** Whether hosted account and organization settings open in this window. */
export function useHostedSettingsAvailable(): boolean {
  return useHostedSettingsClient() !== null;
}

/**
 * Open a web settings path (`/account/billing?plan=pro`,
 * `/organization/<id>/settings?tab=billing`) inside Settings, keeping its
 * query and fragment as page state. Returns `false`, opening nothing, when
 * the path is not an account or organization settings page.
 */
export function openHostedSettingsPath(
  path: string,
  options: { readonly replace?: boolean } = {},
): boolean {
  const target = resolveHostedSettingsHref(path, '', '/');
  if (target.kind !== 'settings') return false;
  const { route, search, hash } = target.location;
  useNavigationStore.getState().openAccountOrganizationSettings(route, {
    search,
    hash,
    ...(options.replace === true ? { replace: true } : {}),
  });
  return true;
}
