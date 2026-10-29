// Request shapes the loopback broker accepts for Claude and Codex harness
// children, shared by every route that sends their model traffic somewhere
// other than the native provider: AI Credits, organization gateways, and the
// account proxy.

/** What a harness child sends the broker; the broker swaps in the real key. */
export const LOOPBACK_BROKER_AUTH_TOKEN = 'canopy-loopback-broker';

/** Claude SDK request headers a brokered route passes upstream. */
export const CLAUDE_BROKER_FORWARD_HEADERS = [
  'anthropic-beta',
  'anthropic-version',
  'user-agent',
  'x-stainless-arch',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-timeout',
] as const;
export const CLAUDE_BROKER_ALLOWED_PATHS = [
  '/v1/messages',
  '/v1/messages/count_tokens',
] as const;
export const CLAUDE_BROKER_ALLOWED_QUERIES = ['beta=true'] as const;
export const CODEX_BROKER_ALLOWED_PATHS = ['/responses'] as const;
