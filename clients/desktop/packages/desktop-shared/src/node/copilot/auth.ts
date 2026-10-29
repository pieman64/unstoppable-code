import type { GetAuthStatusResponse } from '@github/copilot-sdk';
import type { CopilotAccount } from '../../types/copilot-connection';

/** Never silently bill an ambient token, gh CLI account, or an unselected identity. */
export function copilotAccountFromStatus(
  status: GetAuthStatusResponse,
): CopilotAccount | null {
  if (
    !status.isAuthenticated ||
    status.authType !== 'user' ||
    !status.login ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(status.login)
  )
    return null;
  try {
    const url = new URL(status.host ?? '');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !(url.hostname === 'github.com' || url.hostname.endsWith('.ghe.com'))
    )
      return null;
    return { host: url.origin, login: status.login };
  } catch {
    return null;
  }
}

export function sameCopilotAccount(
  actual: CopilotAccount | null,
  expected: CopilotAccount | undefined,
): boolean {
  return (
    !!actual &&
    !!expected &&
    actual.host === expected.host &&
    actual.login === expected.login
  );
}
