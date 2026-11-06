import type { AiGatewayConnectionResult } from '@canopy/protocol/model-gateway/discovery';
import type { KnownSettingsError } from '../errors';
import { ORGANIZATION_LAPSED_ERROR } from '../organization/organization-known-errors';

export const AI_GATEWAY_ERROR_SCOPE = 'settings.ai-gateway';

/**
 * The scope changed under the page (a revision or a promoted Personal
 * organization), so the save was refused rather than applied to stale data.
 */
export const AI_GATEWAY_STALE_COPY =
  'This gateway changed since you opened it. Reload the page and try again.';

export const AI_GATEWAY_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  { status: 409, copy: AI_GATEWAY_STALE_COPY },
  ORGANIZATION_LAPSED_ERROR,
];

/** Copy for a Connect that reached the server but didn't connect. */
export function connectionFailureCopy(
  status: Exclude<AiGatewayConnectionResult['status'], 'connected'>,
  keepsKeys: boolean,
): string {
  switch (status) {
    case 'unauthorized':
      return "Your gateway didn't accept that API key.";
    case 'unreachable':
      return keepsKeys
        ? "Couldn't reach your gateway. Check the URL and your connection."
        : "Couldn't reach your gateway. It needs a public HTTPS URL.";
    case 'invalid_url':
      return 'Enter a valid HTTPS gateway URL.';
    case 'key_required':
      return 'Enter your API key.';
  }
}

/** `sk-…abcd`: enough of a key to recognize it, never the whole key. */
export function maskedKeySuffix(key: string): string | null {
  const trimmed = key.trim();
  if (trimmed.length < 8) return null;
  const prefix = /^[a-z]{2,4}-/i.exec(trimmed)?.[0] ?? '';
  return `${prefix}…${trimmed.slice(-4)}`;
}
