import type { AccountProxySignInProvider } from '@canopy/desktop-shared/types/account-proxy';

/** A provider page a sign-in opens, with the proxy's state for it. */
export interface AccountProxySignInPageRequest {
  readonly provider: AccountProxySignInProvider;
  readonly url: string;
  readonly state: string;
}

/** What the browser sent back to the computer that opened the page. */
export interface AccountProxySignInCallback {
  readonly state: string;
  readonly code: string | null;
  readonly error: string | null;
}

/**
 * The computer controlling this one, for a sign-in started from its window:
 * it opens the provider page in its own browser and catches the redirect on
 * its own loopback port, then sends the callback back here.
 */
export interface AccountProxyRemoteSignInTarget {
  readonly controllerDeviceId: string;
  /** Opens the page there and listens for its callback. */
  open(page: AccountProxySignInPageRequest): Promise<void>;
  /** Stops listening there. */
  end(state: string): void;
  /** Called once when the session to that computer closes. */
  onClosed(listener: () => void): () => void;
}

export type AccountProxyRemoteSignInProvider = (sender: {
  id: number;
}) => AccountProxyRemoteSignInTarget | null;

let provider: AccountProxyRemoteSignInProvider | null = null;

export function setAccountProxyRemoteSignInProvider(
  next: AccountProxyRemoteSignInProvider | null,
): void {
  provider = next;
}

/** The controlling computer behind a remote window's call; null otherwise. */
export function accountProxyRemoteSignInFor(sender: {
  id: number;
}): AccountProxyRemoteSignInTarget | null {
  return provider?.(sender) ?? null;
}
