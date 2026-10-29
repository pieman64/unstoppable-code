import type { PinnedHttpAddress } from './pinned-http-fetch';

const E2E_MCP_OAUTH_FIXTURE_ENV =
  'CANOPY_E2E_MCP_OAUTH_FIXTURE_BASE_URL' as const;

declare global {
  // Main-process evidence consumed by the Electron regression spec. This is
  // populated only in an explicit E2E build with the fixture redirect enabled.
  var __CANOPY_E2E_MCP_OAUTH_AUTHORIZATION_URL__: string | undefined;
}

function getE2eMcpOAuthFixtureBaseUrl(): string | null {
  if (__CANOPY_E2E__) {
    const value = process.env[E2E_MCP_OAUTH_FIXTURE_ENV]?.trim();
    return value ? value.replace(/\/+$/, '') : null;
  }
  return null;
}

/**
 * Route an OAuth HTTP request through a local Electron fixture while retaining
 * the original URL for every production security and origin-policy check.
 */
export function resolveE2eMcpOAuthFixtureUrl(url: URL): URL | null {
  const baseUrl = getE2eMcpOAuthFixtureBaseUrl();
  if (!baseUrl) return null;
  const fixtureUrl = new URL('/__e2e/mcp-oauth', baseUrl);
  fixtureUrl.searchParams.set('target', url.toString());
  return fixtureUrl;
}

/** Avoid live DNS in the E2E fixture after the original URL passes validation. */
export function resolveE2eMcpOAuthPublicAddresses():
  | PinnedHttpAddress[]
  | null {
  return getE2eMcpOAuthFixtureBaseUrl()
    ? [{ address: '8.8.8.8', family: 4 }]
    : null;
}

/** Record and suppress the real browser launch for the deterministic spec. */
export function recordE2eMcpOAuthAuthorizationLaunch(url: string): boolean {
  if (!getE2eMcpOAuthFixtureBaseUrl()) return false;
  globalThis.__CANOPY_E2E_MCP_OAUTH_AUTHORIZATION_URL__ = url;
  return true;
}
