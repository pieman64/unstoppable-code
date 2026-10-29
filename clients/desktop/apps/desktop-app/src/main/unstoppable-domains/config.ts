/**
 * Unstoppable Domains OAuth environment configuration (CAN-839).
 *
 * The desktop app runs the UD PKCE handshake directly against the UD OAuth
 * server, so it needs the UD base URL (endpoints are then discovered from
 * `{baseUrl}/.well-known/oauth-authorization-server`). apps/web only needs the
 * user's Bearer token, so no service credential lives here.
 */

/** Supported UD environments, mirroring `ud-cli/src/lib/config.ts`. */
export const UNSTOPPABLE_DOMAINS_ENVIRONMENTS = [
  'production',
  'sandbox',
  'staging',
] as const;

export type UnstoppableDomainsEnvironment =
  (typeof UNSTOPPABLE_DOMAINS_ENVIRONMENTS)[number];

/** OAuth-server (API) base URL per environment. */
const BASE_URLS: Record<UnstoppableDomainsEnvironment, string> = {
  production: 'https://api.unstoppabledomains.com',
  sandbox: 'https://api.ud-sandbox.com',
  staging: 'https://api.ud-staging.com',
};

/**
 * User-facing UD web host per environment (no `api.` prefix), used for the AI
 * Credits products/landing page opened by the "Set up a subscription" CTA.
 *
 * Production uses the storefront domain `unstoppabledomains.com`. Staging
 * uses the dedicated `domains.ud-staging.com` storefront subdomain; sandbox
 * retains `ud-sandbox.com`. Paths and purchase query parameters are shared
 * across environments.
 */
const WEB_BASE_URLS: Record<UnstoppableDomainsEnvironment, string> = {
  production: 'https://unstoppabledomains.com',
  sandbox: 'https://ud-sandbox.com',
  staging: 'https://domains.ud-staging.com',
};

/**
 * Path of the signed-in AI Credits purchase page on the UD web host. The
 * `?purchase=1` marker tells the UD account page to auto-open the purchase flow.
 */
const AI_CREDITS_PURCHASE_PATH = '/account/ai-credits?purchase=1';

/** Path of the signed-in AI Credits management page on the UD web host. */
const AI_CREDITS_ACCOUNT_PATH = '/account/ai-credits';

/** OAuth scope required to resolve the AI-Credits billing account. */
export const UNSTOPPABLE_DOMAINS_OAUTH_SCOPE = 'ai-billing';

function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function coerceEnvironment(
  raw: string | undefined,
): UnstoppableDomainsEnvironment | null {
  const normalized = raw?.trim().toLowerCase();
  return (
    UNSTOPPABLE_DOMAINS_ENVIRONMENTS.find(
      (candidate) => candidate === normalized,
    ) ?? null
  );
}

/**
 * Per-build default environment injected by `electron.vite.config.ts` as
 * `__CANOPY_UD_OAUTH_ENV__`: `production` for production release builds,
 * `staging` for internal/staging and local dev builds. Absent in plain-Node
 * test runs, where the resolver falls back to `staging`.
 */
function getBuildTimeEnvironment(): UnstoppableDomainsEnvironment | null {
  return typeof __CANOPY_UD_OAUTH_ENV__ === 'string'
    ? coerceEnvironment(__CANOPY_UD_OAUTH_ENV__)
    : null;
}

/**
 * Resolve the UD environment. A runtime `CANOPY_UD_OAUTH_ENV` override wins so a
 * developer can flip environments without a rebuild; otherwise the per-build
 * default (`__CANOPY_UD_OAUTH_ENV__`) applies, then a safe `staging` fallback.
 * Production release builds inject `production`; everything else (local dev,
 * internal/staging builds, plain-Node tests) resolves to `staging`.
 */
export function getUnstoppableDomainsEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): UnstoppableDomainsEnvironment {
  return (
    coerceEnvironment(env.CANOPY_UD_OAUTH_ENV) ??
    getBuildTimeEnvironment() ??
    'staging'
  );
}

/**
 * Resolve the UD OAuth server base URL. A non-empty `CANOPY_UD_OAUTH_BASE_URL`
 * takes precedence (dev/testing); otherwise the per-environment default is used.
 */
export function getUnstoppableDomainsBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.CANOPY_UD_OAUTH_BASE_URL?.trim();
  if (override && override.length > 0) {
    return normalizeBaseUrl(override);
  }
  return BASE_URLS[getUnstoppableDomainsEnvironment(env)];
}

/**
 * Resolve the user-facing UD web host for the current environment (prod
 * `unstoppabledomains.com`, staging `domains.ud-staging.com`, sandbox
 * `ud-sandbox.com`).
 * Independent of the `CANOPY_UD_OAUTH_BASE_URL` API override, which targets the
 * OAuth server, not the marketing/product web host.
 */
export function getUnstoppableDomainsWebBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return WEB_BASE_URLS[getUnstoppableDomainsEnvironment(env)];
}

/**
 * Environment-aware URL of the signed-in UD AI Credits purchase page
 * (`{host}/account/ai-credits?purchase=1`) that the "Set up a subscription" /
 * "Set up AI Credits" CTAs open. The `?purchase=1` marker auto-opens the
 * purchase flow on the UD account page.
 */
export function getUnstoppableDomainsAiCreditsPurchaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${getUnstoppableDomainsWebBaseUrl(env)}${AI_CREDITS_PURCHASE_PATH}`;
}

/**
 * Environment-aware URL of the signed-in UD AI Credits management page that the
 * "Manage" CTA opens for a connected/billing account.
 */
export function getUnstoppableDomainsAiCreditsManageUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${getUnstoppableDomainsWebBaseUrl(env)}${AI_CREDITS_ACCOUNT_PATH}`;
}
