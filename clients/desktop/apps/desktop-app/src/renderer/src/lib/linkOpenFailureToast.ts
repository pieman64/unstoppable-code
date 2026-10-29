// ---------------------------------------------------------------------------
// Link context menu "Open in browser" failure toast (CAN-2632)
// ---------------------------------------------------------------------------
//
// The user chose the built-in browser explicitly, so a failed placement never
// falls back to the system browser on its own. This toast explains the
// failure and offers the external browser as the one-step alternative.

import { useGitHubStore } from '@/stores/githubStore';

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    // Not parseable here; the raw string still names the destination.
    return url;
  }
}

/** Safe to call from any renderer surface. */
export function showLinkOpenFailureToast(url: string): void {
  useGitHubStore
    .getState()
    .addToast(
      `${hostLabel(url)} didn't open in the built-in browser.`,
      'warning',
      undefined,
      {
        title: "Couldn't open the link in the browser",
        action: {
          label: 'Open in external browser',
          onClick: (): void => {
            void window.api.browser
              .openExternal({ url })
              .catch(() => undefined);
          },
        },
        forceInApp: true,
      },
    );
}
