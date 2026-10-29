/**
 * Renderer-wide notifications for "an external integration's credentials just
 * changed".
 *
 * Settings opens as an overlay above the still-mounted page tree (see
 * `App.tsx` — `SettingsOverlay` is a sibling of `<main>`, not an `activePage`),
 * so a surface that reads a credential once in a mount-only effect never
 * observes a key connected afterwards. Anything that gates UI on Linear or
 * GitHub connectivity must re-read on these events instead of trusting its
 * mount-time snapshot.
 *
 * Mirrors the existing `CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT` pattern.
 */

export const LINEAR_CONNECTION_CHANGED_EVENT =
  'canopy:linear-connection-changed';

export const GITHUB_CONNECTION_CHANGED_EVENT =
  'canopy:github-connection-changed';

export const MODEL_GATEWAY_CREDENTIAL_CHANGED_EVENT =
  'canopy:model-gateway-credential-changed';

/** Announce that the stored Linear API key was written (connected or cleared). */
export function notifyLinearConnectionChanged(): void {
  window.dispatchEvent(new Event(LINEAR_CONNECTION_CHANGED_EVENT));
}

/** Announce that GitHub auth changed (PAT written/cleared, or a gh CLI login). */
export function notifyGitHubConnectionChanged(): void {
  window.dispatchEvent(new Event(GITHUB_CONNECTION_CHANGED_EVENT));
}

/** Announce that an organization gateway credential was written or cleared. */
export function notifyModelGatewayCredentialChanged(): void {
  window.dispatchEvent(new Event(MODEL_GATEWAY_CREDENTIAL_CHANGED_EVENT));
}

/**
 * Subscribe to one of the connection-changed events for the life of the
 * calling effect. Returns the unsubscribe function so callers can use it
 * directly as a `useEffect` cleanup.
 */
export function subscribeToConnectionChange(
  eventName: string,
  onChange: () => void,
): () => void {
  window.addEventListener(eventName, onChange);
  return (): void => {
    window.removeEventListener(eventName, onChange);
  };
}
