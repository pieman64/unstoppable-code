import type {
  AgentProviderAuthStatus,
  GitHubCliStatus,
  LinearStatus,
} from '@canopy/desktop-shared/types';
import {
  agentProviderConnectionState,
  gitHubConnectionState,
  linearConnectionState,
  PROVIDER_CONNECTION_STATE_LABELS,
} from '../provider-connection-status';

function agentStatus(
  overrides: Partial<AgentProviderAuthStatus>,
): AgentProviderAuthStatus {
  return {
    authenticated: false,
    accountLabel: null,
    detail: null,
    error: null,
    ...overrides,
  };
}

function ghStatus(overrides: Partial<GitHubCliStatus>): GitHubCliStatus {
  return {
    authenticated: false,
    username: null,
    error: null,
    tokenSource: null,
    envOverride: false,
    envOverrideName: null,
    hasCredentialStoreLogin: false,
    ...overrides,
  };
}

function linearStatus(overrides: Partial<LinearStatus> = {}): LinearStatus {
  return {
    authenticated: false,
    displayName: null,
    error: null,
    ...overrides,
  };
}

describe('agentProviderConnectionState', () => {
  test('null status is checking', () => {
    expect(agentProviderConnectionState(null)).toBe('checking');
  });

  test('authenticated is connected', () => {
    expect(
      agentProviderConnectionState(agentStatus({ authenticated: true })),
    ).toBe('connected');
  });

  test('confirmed signed-out is not-connected', () => {
    expect(agentProviderConnectionState(agentStatus({}))).toBe('not-connected');
  });

  test('probe failure is needs-attention, not signed-out', () => {
    expect(
      agentProviderConnectionState(
        agentStatus({ probeFailed: true, error: 'timeout' }),
      ),
    ).toBe('needs-attention');
  });

  test('an error without probeFailed is needs-attention', () => {
    expect(
      agentProviderConnectionState(agentStatus({ error: 'binary missing' })),
    ).toBe('needs-attention');
  });
});

describe('gitHubConnectionState', () => {
  test('null CLI status is checking', () => {
    expect(gitHubConnectionState(null, false)).toBe('checking');
  });

  test('CLI-authenticated is connected regardless of PAT', () => {
    expect(
      gitHubConnectionState(ghStatus({ authenticated: true }), false),
    ).toBe('connected');
  });

  test('unknown PAT state stays checking while CLI is signed out', () => {
    expect(gitHubConnectionState(ghStatus({}), null)).toBe('checking');
  });

  test('a configured PAT counts as connected', () => {
    expect(gitHubConnectionState(ghStatus({}), true)).toBe('connected');
  });

  test('CLI error without any credential is needs-attention', () => {
    expect(
      gitHubConnectionState(
        ghStatus({ error: 'GitHub CLI (gh) is not installed.' }),
        false,
      ),
    ).toBe('needs-attention');
  });

  test('signed out with no PAT is not-connected', () => {
    expect(gitHubConnectionState(ghStatus({}), false)).toBe('not-connected');
  });
});

describe('linearConnectionState', () => {
  test('unresolved persisted-token read is checking', () => {
    expect(
      linearConnectionState({
        status: null,
        available: false,
        tokenLoaded: false,
        tokenPresent: false,
      }),
    ).toBe('checking');
  });

  test('resolved read with no token is not-connected', () => {
    // A null status with no token is permanent — it must NOT read as an
    // in-flight check.
    expect(
      linearConnectionState({
        status: null,
        available: false,
        tokenLoaded: true,
        tokenPresent: false,
      }),
    ).toBe('not-connected');
  });

  test('present token still validating is checking', () => {
    expect(
      linearConnectionState({
        status: null,
        available: false,
        tokenLoaded: true,
        tokenPresent: true,
      }),
    ).toBe('checking');
  });

  test('validated token is connected', () => {
    expect(
      linearConnectionState({
        status: linearStatus({ authenticated: true }),
        available: true,
        tokenLoaded: true,
        tokenPresent: true,
      }),
    ).toBe('connected');
  });

  test('validation error is needs-attention, not signed-out', () => {
    expect(
      linearConnectionState({
        status: linearStatus({ error: 'API unreachable' }),
        available: false,
        tokenLoaded: true,
        tokenPresent: true,
      }),
    ).toBe('needs-attention');
  });

  test('rejected token is not-connected', () => {
    expect(
      linearConnectionState({
        status: linearStatus(),
        available: false,
        tokenLoaded: true,
        tokenPresent: true,
      }),
    ).toBe('not-connected');
  });
});

describe('PROVIDER_CONNECTION_STATE_LABELS', () => {
  test('covers the four ticket statuses verbatim', () => {
    expect(PROVIDER_CONNECTION_STATE_LABELS).toEqual({
      checking: 'Checking',
      connected: 'Connected',
      'not-connected': 'Not connected',
      'needs-attention': 'Needs attention',
    });
  });
});
