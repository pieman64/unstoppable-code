import type {
  AgentProviderAuthStatus,
  GitHubCliStatus,
  LinearStatus,
} from '@canopy/desktop-shared/types';

/**
 * Connection states surfaced by the unified provider list on the Home
 * onboarding card (CAN-2411). Deliberately four coarse states: the card is a
 * glanceable checklist, not a diagnostics panel.
 *
 * Also consumed by the persistent sidebar onboarding checklist (CAN-788),
 * which adds the Linear mapper below.
 */
export type ProviderConnectionState =
  | 'checking'
  | 'connected'
  | 'not-connected'
  | 'needs-attention';

export const PROVIDER_CONNECTION_STATE_LABELS: Record<
  ProviderConnectionState,
  string
> = {
  checking: 'Checking',
  connected: 'Connected',
  'not-connected': 'Not connected',
  'needs-attention': 'Needs attention',
};

/**
 * Claude/Codex status mapping. `probeFailed` means the probe could not
 * determine the real state — presenting that as "Not connected" would tell a
 * signed-in user they are signed out, so it maps to "Needs attention", as
 * does any probe error.
 */
export function agentProviderConnectionState(
  status: AgentProviderAuthStatus | null,
): ProviderConnectionState {
  if (status === null) {
    return 'checking';
  }
  if (status.authenticated) {
    return 'connected';
  }
  if (status.probeFailed === true || status.error !== null) {
    return 'needs-attention';
  }
  return 'not-connected';
}

/**
 * GitHub is connected through either the gh CLI credential store or a saved
 * Personal Access Token, so both probes must resolve before the row can claim
 * "Not connected". `patConfigured === null` means the PAT read is still in
 * flight.
 */
export function gitHubConnectionState(
  status: GitHubCliStatus | null,
  patConfigured: boolean | null,
): ProviderConnectionState {
  if (status === null) {
    return 'checking';
  }
  if (status.authenticated) {
    return 'connected';
  }
  if (patConfigured === null) {
    return 'checking';
  }
  if (patConfigured) {
    return 'connected';
  }
  if (status.error !== null) {
    return 'needs-attention';
  }
  return 'not-connected';
}

/**
 * Linear mapping for the sidebar checklist (CAN-788), fed by
 * `useLinearAvailability()`. A null status is ambiguous on its own — it
 * means "validation in flight" when a token exists but "no token saved"
 * forever otherwise — so the token-read state disambiguates: unresolved
 * read → checking; resolved with no token → not connected; token present
 * but unvalidated → checking. A validation error is "Needs attention" so a
 * briefly unreachable API is not presented as signed out.
 */
export function linearConnectionState(availability: {
  status: LinearStatus | null;
  available: boolean;
  tokenLoaded: boolean;
  tokenPresent: boolean;
}): ProviderConnectionState {
  if (availability.available) {
    return 'connected';
  }
  if (!availability.tokenLoaded) {
    return 'checking';
  }
  if (!availability.tokenPresent) {
    return 'not-connected';
  }
  if (availability.status === null) {
    return 'checking';
  }
  if (availability.status.error !== null) {
    return 'needs-attention';
  }
  return 'not-connected';
}
