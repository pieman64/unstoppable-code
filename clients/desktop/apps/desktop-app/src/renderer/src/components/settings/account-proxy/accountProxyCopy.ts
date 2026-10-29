// User-facing text for the account proxy settings (CAN-4019). Main returns
// error codes only, so every sentence the user reads lives here.

import { subscriptionLabelForPlanType } from '@canopy/protocol/telemetry';
import {
  accountProxyAccountsForHarness,
  type AccountProxyHarness,
} from '@canopy/desktop-shared/lib/account-proxy';
import type {
  AccountProxyAccount,
  AccountProxyErrorCode,
  AccountProxyLimit,
  AccountProxyStatus,
} from '@canopy/desktop-shared/types/account-proxy';

export const ACCOUNT_PROXY_PAGE_DESCRIPTION =
  'Run agents through CLIProxyAPI, which shares several provider accounts.';

/**
 * The name of the proxy's Settings page. Copy that points the user to the
 * page uses it; copy about the proxy itself says "account proxy".
 */
export const ACCOUNT_PROXY_SETTINGS_TITLE = 'Multi-account proxy';

/** Marks an account, or its limits, as reached through the account proxy. */
export const ACCOUNT_PROXY_VIA_LABEL = 'Via account proxy';

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
  gemini: 'Gemini',
  'gemini-cli': 'Gemini CLI',
  vertex: 'Vertex AI',
  kimi: 'Kimi',
  xai: 'xAI',
  openai: 'OpenAI-compatible',
  qwen: 'Qwen',
  iflow: 'iFlow',
};

export function accountProxyProviderLabel(provider: string): string {
  return (
    PROVIDER_LABELS[provider] ??
    provider.charAt(0).toUpperCase() + provider.slice(1)
  );
}

/** The subscription name when known, `API key` for config keys. */
export function accountProxyPlanLabel(account: AccountProxyAccount): string {
  if (account.source === 'api-key') return 'API key';
  if (account.provider === 'claude' || account.provider === 'codex') {
    const label = subscriptionLabelForPlanType(
      account.provider,
      account.planType,
    );
    if (label) return label;
  }
  return accountProxyProviderLabel(account.provider);
}

const LIMIT_LABELS: Readonly<Record<AccountProxyLimit['id'], string>> = {
  'five-hour': '5-hour limit',
  weekly: 'Weekly limit',
};

export function accountProxyLimitLabel(limit: AccountProxyLimit): string {
  return LIMIT_LABELS[limit.id];
}

export function accountProxyClock(at: number): string {
  const date = new Date(at);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleString(undefined, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      });
}

/**
 * One line under an account: plan, then limits or why it can't be used.
 * `withLimits: false` leaves the limits to a usage view shown beside it.
 */
export function accountProxyAccountDescription(
  account: AccountProxyAccount,
  options: { readonly withLimits?: boolean } = {},
): string {
  const plan = accountProxyPlanLabel(account);
  switch (account.status) {
    case 'disabled':
      return `${plan} · Turned off. Requests skip this account.`;
    case 'cooling':
      return account.availableAt !== null
        ? `${plan} · Usage limit reached. Back at ${accountProxyClock(account.availableAt)}.`
        : `${plan} · Usage limit reached.`;
    case 'error':
      return /expired|unauthori[sz]ed|invalid_grant|token/i.test(
        account.statusMessage ?? '',
      )
        ? 'Sign-in expired. Sign in again on the server to use this account.'
        : `${plan} · The proxy can't use this account right now.`;
    case 'pending':
      return `${plan} · Finishing sign-in on the server.`;
    case 'refreshing':
    case 'active': {
      if (options.withLimits === false) return plan;
      const limits = account.limits
        .map(
          (limit) => `${accountProxyLimitLabel(limit)} ${limit.usedPercent}%`,
        )
        .join(' · ');
      return limits ? `${plan} · ${limits}` : plan;
    }
  }
}

/** A short state beside an account: its plan, or why it can't serve now. */
export function accountProxyAccountState(account: AccountProxyAccount): string {
  switch (account.status) {
    case 'disabled':
      return 'Turned off';
    case 'cooling':
      return account.availableAt !== null
        ? `Back at ${accountProxyClock(account.availableAt)}`
        : 'Usage limit reached';
    case 'error':
      return "Can't be used right now";
    case 'pending':
      return 'Finishing sign-in';
    case 'refreshing':
    case 'active':
      return accountProxyPlanLabel(account);
  }
}

/**
 * Why no account proxy account can be shown for a harness whose work the
 * proxy serves, or null when its accounts can be listed.
 */
export function accountProxyPoolNotice(
  status: AccountProxyStatus | null,
  harness: AccountProxyHarness,
): string | null {
  if (status === null) return 'Checking the account proxy…';
  if (status.state !== 'connected' || status.error) {
    return `Limits are unavailable. Check Settings > ${ACCOUNT_PROXY_SETTINGS_TITLE}.`;
  }
  if (accountProxyAccountsForHarness(status.accounts, harness).length === 0) {
    return `Add a ${accountProxyProviderLabel(harness)} account to the account proxy.`;
  }
  return null;
}

/** Where an error belongs on the setup form. */
export type AccountProxyErrorField = 'url' | 'key' | 'connection';

export function accountProxyErrorField(
  code: AccountProxyErrorCode,
): AccountProxyErrorField {
  switch (code) {
    case 'invalid-url':
    case 'insecure-url':
    case 'unreachable':
    case 'not-proxy':
      return 'url';
    case 'unauthorized':
    case 'blocked':
      return 'key';
    default:
      return 'connection';
  }
}

export function accountProxyErrorMessage(
  code: AccountProxyErrorCode,
  options: { readonly host?: string; readonly version?: string } = {},
): string {
  const host = options.host ?? 'the server';
  switch (code) {
    case 'invalid-url':
      return 'Enter the server address, such as https://proxy.example.com.';
    case 'insecure-url':
      return 'Use an https:// address. Plain http:// is only allowed for this device.';
    case 'unreachable':
      return `Couldn't reach ${host}. Check the address and that the server is running.`;
    case 'not-proxy':
      return `${host} answered, but it isn't a CLIProxyAPI server.`;
    case 'too-old':
      return options.version
        ? `This server runs version ${options.version}. Update it to version 8 or later to connect.`
        : 'Update the server to version 8 or later to connect.';
    case 'unauthorized':
      return "That key didn't work. After 5 wrong keys the server blocks this device for 30 minutes.";
    case 'blocked':
      return 'The server blocked this device after too many wrong keys. Try again in 30 minutes.';
    case 'management-disabled':
      return 'The server has no management key set. Set one in its config to connect.';
    case 'remote-management-disabled':
      return 'The server only accepts management from its own machine. Turn on remote management in its config to connect.';
    case 'storage-unavailable':
      return "This device can't store the key securely. Sign in to your desktop keychain and try again.";
    case 'local-unsupported':
      return "The proxy isn't available for this device. Connect to a server instead.";
    case 'local-failed':
      return "The proxy on this device didn't start. Try again.";
    case 'unexpected':
      return 'Something went wrong talking to the server. Try again.';
  }
}

export function accountProxyHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
