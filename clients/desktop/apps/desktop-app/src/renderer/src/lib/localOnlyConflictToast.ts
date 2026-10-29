// ---------------------------------------------------------------------------
// "Only allow local sites" conflict toast (CAN-2305)
// ---------------------------------------------------------------------------
//
// A link the built-in browser is not allowed to load opens in the system
// browser instead. Without this the restriction reads as a link that simply
// did nothing, which is the silent failure the ticket names. Shared by the
// main-pushed `app-link-local-only-conflict` event and the App Advisor
// `browser.open` branch that rejects a URL under the same restriction.

import { useGitHubStore } from '@/stores/githubStore';
import { useBrowserStore } from '@/stores/browserStore';
import { brandText } from '@/lib/brand';

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    // Not parseable here; the raw string still names the destination.
    return url;
  }
}

/** Turns "Only allow local sites" off and reconciles with the saved value. */
function allowAllSites(): void {
  useBrowserStore.getState().setLocalServersOnly(false);
  void window.api
    .savePreferences({ inAppBrowserLocalServersOnly: false })
    .then((preferences) => {
      useBrowserStore
        .getState()
        .setLocalServersOnly(preferences.inAppBrowserLocalServersOnly === true);
    })
    .catch(() => {
      useBrowserStore.getState().setLocalServersOnly(true);
    });
}

/**
 * Explains a link that was forced out to the system browser, and offers the
 * one-step fix. Safe to call from any renderer surface.
 */
export function raiseLocalOnlyConflictToast(url: string): void {
  useGitHubStore
    .getState()
    .addToast(
      `${hostLabel(url)} opened in your system browser. ${brandText.appName} only allows local sites in its built-in browser.`,
      'warning',
      undefined,
      {
        title: 'Opened outside the built-in browser',
        action: { label: 'Allow all sites', onClick: allowAllSites },
        forceInApp: true,
      },
    );
}
