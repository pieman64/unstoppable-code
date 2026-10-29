import { timingSafeEqual } from 'node:crypto';
import type { AccountProxySignInProvider } from '@canopy/desktop-shared/types/account-proxy';

/** How long a sign-in waits for the browser before it fails. */
export const ACCOUNT_PROXY_SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/** The proxy's sign-in state, as CLIProxyAPI generates it. */
export const ACCOUNT_PROXY_SIGN_IN_STATE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** Compares two sign-in states in constant time. */
export function sameAccountProxySignInState(
  left: string,
  right: string,
): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The provider pages a sign-in may open, by provider. */
const SIGN_IN_HOSTS: Readonly<
  Record<AccountProxySignInProvider, readonly string[]>
> = {
  claude: ['claude.ai'],
  codex: ['auth.openai.com'],
};

/**
 * The provider page `url`, when it is an https page on that provider's own
 * sign-in host; null for anything else, whatever the proxy answered.
 */
export function accountProxySignInPage(
  provider: AccountProxySignInProvider,
  url: string,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    !SIGN_IN_HOSTS[provider].includes(parsed.hostname)
  ) {
    return null;
  }
  return parsed.href;
}
