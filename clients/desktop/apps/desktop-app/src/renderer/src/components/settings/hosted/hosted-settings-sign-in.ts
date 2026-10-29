import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CanopyApi } from '@canopy/desktop-shared/types';
import { useGitHubStore } from '@/stores/githubStore';

let signingIn = false;

/**
 * Sign in from a hosted settings recovery state, through the same OAuth
 * entry point as the account menu's Sign in. Success announces the account
 * change, which reloads hosted settings for the signed-in account. A second
 * call while one is in flight does nothing.
 */
export function startHostedSettingsSignIn(): void {
  if (signingIn) return;
  const api: Partial<CanopyApi> | undefined = window.api;
  const start = api?.startCanopyCloudOAuthLogin;
  if (typeof start !== 'function') return;
  signingIn = true;
  const addToast = useGitHubStore.getState().addToast;
  void start()
    .then((result) => {
      const authenticated =
        result.status.authenticated &&
        result.status.account != null &&
        result.status.missingCapabilities.length === 0;
      if (authenticated) {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      } else {
        addToast('Unable to complete sign-in.', 'error');
      }
    })
    .catch(() => {
      addToast('Unable to start sign-in. Check Cloud configuration.', 'error');
    })
    .finally(() => {
      signingIn = false;
    });
}
