import type { AuthTerminalProvider } from '@canopy/desktop-shared/types';

const OSC_SEQUENCE = new RegExp(
  String.raw`\u001b\][^\u0007]*(?:\u0007|\u001b\\)`,
  'g',
);
const CSI_SEQUENCE = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, 'g');
const TERMINATED_HTTP_URL = new RegExp(
  String.raw`https?:\/\/[^\s<>"'\u0000-\u001f]+(?=[\s<>"'\u0000-\u001f])`,
  'g',
);

function stripTerminalControlSequences(value: string): string {
  return value.replace(OSC_SEQUENCE, '').replace(CSI_SEQUENCE, '');
}

function isClaudeAuthorizationUrl(url: URL): boolean {
  const allowedHost =
    url.hostname === 'claude.com' ||
    url.hostname === 'claude.ai' ||
    url.hostname === 'platform.claude.com';
  if (!allowedHost) return false;
  if (
    url.pathname === '/cai/oauth/authorize' ||
    url.pathname === '/oauth/authorize'
  ) {
    return true;
  }
  if (url.pathname !== '/login') return false;
  const returnTo = url.searchParams.get('returnTo');
  return returnTo?.startsWith('/oauth/authorize') === true;
}

function isCodexAuthorizationUrl(url: URL): boolean {
  return (
    url.hostname === 'auth.openai.com' && url.pathname === '/oauth/authorize'
  );
}

/**
 * Extract a complete provider-owned OAuth URL from accumulated PTY output.
 * A trailing delimiter is required so streaming chunks never open a partial
 * query string. GitHub keeps its existing device flow and is intentionally
 * excluded.
 */
export function findProviderAuthorizationUrl(
  provider: AuthTerminalProvider,
  output: string,
): string | null {
  if (provider === 'github') return null;
  const plainText = stripTerminalControlSequences(output);
  TERMINATED_HTTP_URL.lastIndex = 0;
  let candidate = TERMINATED_HTTP_URL.exec(plainText);
  while (candidate !== null) {
    try {
      const url = new URL(candidate[0]);
      if (
        (provider === 'claude' && isClaudeAuthorizationUrl(url)) ||
        (provider === 'codex' && isCodexAuthorizationUrl(url))
      ) {
        return url.toString();
      }
    } catch {
      // Ignore malformed terminal text and continue scanning later matches.
    }
    candidate = TERMINATED_HTTP_URL.exec(plainText);
  }
  return null;
}
