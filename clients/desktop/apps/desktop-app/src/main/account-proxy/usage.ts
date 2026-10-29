import {
  parseClaudeUsageDetails,
  parseCodexWhamUsage,
} from '@canopy/desktop-shared/lib/provider-usage-parsers';
import type {
  ProviderRateLimitSnapshot,
  ProviderUsageErrorInfo,
} from '@canopy/desktop-shared/types';
import type { AccountProxyUsageSnapshot } from '@canopy/desktop-shared/types/account-proxy';
import { claudePlanTypeFromOAuthProfile } from '@canopy/desktop-shared/lib/account-proxy-claude-plan';

/** A credential that can be read for live account-proxy quota usage. */
export interface AccountProxyUsageInventoryEntry {
  readonly connectionId: string;
  readonly authIndex: string;
  readonly provider: 'claude' | 'codex';
  /** Non-secret fingerprint binding this credential's identity fields. */
  readonly identity: string;
  readonly passiveUsage?: AccountProxyUsageSnapshot;
  readonly planType?: string;
}

/** Result of one provider usage request made through CLIProxyAPI. */
export type AccountProxyUsageReadResult =
  | {
      readonly status: 'success';
      readonly rateLimits: ProviderRateLimitSnapshot[];
      readonly planType?: string;
    }
  | {
      readonly status: 'failure';
      readonly errorInfo: ProviderUsageErrorInfo;
      readonly retryAfter?: string | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function retryAfterFromHeader(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const [name, headerValue] of Object.entries(value)) {
    if (name.toLowerCase() !== 'retry-after') continue;
    if (typeof headerValue === 'string') return headerValue;
    if (Array.isArray(headerValue) && typeof headerValue[0] === 'string') {
      return headerValue[0];
    }
  }
  return null;
}

function parseProviderBody(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Keep only the two non-secret plan hints, never profile identity fields. */
export function parseClaudeOAuthProfilePlanType(
  envelope: unknown,
): string | null {
  if (!isRecord(envelope) || envelope.status_code !== 200) return null;
  const body = parseProviderBody(envelope.body);
  if (!isRecord(body) || !isRecord(body.organization)) return null;
  return claudePlanTypeFromOAuthProfile(
    readString(body.organization, 'organization_type'),
    readString(body.organization, 'rate_limit_tier'),
  );
}

function failed(
  kind: ProviderUsageErrorInfo['kind'],
  retryAfter?: string | null,
): AccountProxyUsageReadResult {
  return {
    status: 'failure',
    errorInfo: { kind },
    ...(retryAfter === undefined ? {} : { retryAfter }),
  };
}

/**
 * Normalize the nested response from `/requests/api-call` without exposing
 * proxy/provider response text to callers.
 */
export function parseAccountProxyUsageResponse(
  provider: AccountProxyUsageInventoryEntry['provider'],
  envelope: unknown,
  planType?: string,
): AccountProxyUsageReadResult {
  if (!isRecord(envelope)) return failed('service');
  const statusCode = envelope.status_code;
  if (typeof statusCode !== 'number' || !Number.isInteger(statusCode)) {
    return failed('service');
  }

  if (statusCode === 401) return failed('auth');
  if (statusCode === 429) {
    return failed('rate_limited', retryAfterFromHeader(envelope.header));
  }
  if (statusCode < 200 || statusCode >= 300) return failed('service');

  const body = parseProviderBody(envelope.body);
  if (!isRecord(body)) return failed('service');

  if (provider === 'claude') {
    const rateLimitTier = readString(body, 'rate_limit_tier') ?? planType;
    return {
      status: 'success',
      rateLimits: parseClaudeUsageDetails(body, rateLimitTier).rateLimits,
    };
  }

  return { status: 'success', rateLimits: parseCodexWhamUsage(body) };
}
