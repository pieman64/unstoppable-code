import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentProviderAuthStatus } from '@canopy/desktop-shared/types';

const mockInvalidateProviderAuthSessions = jest.fn();
const mockExecFile = jest.fn();
const mockCodexReadAccount = jest.fn();
const mockSuspendWorkersForExternalAuthChange = jest.fn();
const mockCodexAdminRequest = jest.fn<unknown, [string, unknown?]>(
  (method, params) => {
    if (method !== 'account/read') {
      throw new Error(`Unexpected Codex admin request: ${method}`);
    }
    return mockCodexReadAccount(
      (params as { refreshToken?: boolean } | undefined)?.refreshToken,
    );
  },
);
const mockGetEnhancedEnv = jest.fn(() => ({ PATH: '/mock/bin' }));
const mockReadClaudeOauthCredentials = jest.fn();
const mockFetchMockControlPlaneRecord = jest.fn();
const mockGetMockLlmOrigin = jest.fn((): string | null => null);

jest.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/mock/bin/claude'),
  getEnhancedEnv: mockGetEnhancedEnv,
}));

jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    admin: (): {
      request: typeof mockCodexAdminRequest;
      suspendWorkersForExternalAuthChange: typeof mockSuspendWorkersForExternalAuthChange;
    } => ({
      request: mockCodexAdminRequest,
      suspendWorkersForExternalAuthChange:
        mockSuspendWorkersForExternalAuthChange,
    }),
  })),
}));

jest.mock('../lib/e2e-mock-control-plane', () => ({
  fetchMockControlPlaneRecord: mockFetchMockControlPlaneRecord,
  getMockLlmOrigin: mockGetMockLlmOrigin,
}));

jest.mock('../agents/session-manager', () => ({
  invalidateProviderAuthSessions: mockInvalidateProviderAuthSessions,
}));

jest.mock('../auth/claude-oauth-credentials', () => ({
  readClaudeOauthCredentials: mockReadClaudeOauthCredentials,
}));

const mockRecordAppDiagnostic = jest.fn();
const mockLogMainProcessWarn = jest.fn();
const mockLogMainProcessInfo = jest.fn();

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: mockRecordAppDiagnostic,
  })),
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessInfo: mockLogMainProcessInfo,
  logMainProcessWarn: mockLogMainProcessWarn,
}));

const mockInvalidateCodexSpeedCatalog = jest.fn();
jest.mock('../model-routing/codex-account-models', () => ({
  invalidateCodexSpeedCatalog: mockInvalidateCodexSpeedCatalog,
}));

// The cached managed-runtime preflight the Portal availability peeks read.
// `undefined` mirrors a process that has never checked the runtime.
let mockCursorRuntimeAvailability: boolean | undefined;
jest.mock('../cursor/runtime-availability', () => ({
  peekCursorRuntimeAvailability: (): boolean | undefined =>
    mockCursorRuntimeAvailability,
}));

import {
  buildClaudeAuthStatusFromPayload,
  acceptVerifiedCodexAccount,
  checkClaudeAuthStatusObserved,
  checkCodexAuthStatusObserved,
  deriveProviderAccountKey,
  ensureProviderAuthBaselineForSession,
  fingerprintCodexRecoveryIdentity,
  getCachedClaudeAuthStatusObserved,
  getCachedCodexAuthStatusObserved,
  isProviderNativelyAuthenticated,
  isProviderNativelyAuthenticatedForRouting,
  markProviderAuthSessionCreatedWithoutBaseline,
  observeProviderAuthStatus,
  peekFreshProviderNativeAuthAvailability,
  peekPortalProviderAvailability,
  peekProviderAccountIdentity,
  peekProviderBillingAccountKind,
  peekProviderNativeAuthAvailability,
  resetProviderAuthStateForTests,
  shouldPrewarmCodexNativeAuthAtStartup,
  subscribeConfirmedProviderAuth,
  type ConfirmedProviderAuthEvent,
} from '../auth/provider-auth-state';

test('managed sign-in rejects a fresh confirmed signed-out account', async () => {
  await expect(
    acceptVerifiedCodexAccount({
      account: null,
      requiresOpenaiAuth: true,
    }),
  ).rejects.toThrow('Could not verify Codex authentication');
});

type ExecFileCallback = (
  error: Error | null,
  result: { stdout: string; stderr: string },
) => void;

function status(
  authenticated: boolean,
  accountLabel: string | null,
  detail: string | null = null,
): AgentProviderAuthStatus {
  return {
    authenticated,
    accountLabel,
    detail,
    error: authenticated ? null : 'not authenticated',
  };
}

function mockExecFileResult(
  error: Error | null,
  stdout: string,
  stderr = '',
): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb?: ExecFileCallback) => {
      cb?.(error, { stdout, stderr });
    },
  );
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  Object.assign(globalThis, { __CANOPY_E2E__: false });
  jest.clearAllMocks();
  resetProviderAuthStateForTests();
  mockCursorRuntimeAvailability = undefined;
  mockInvalidateProviderAuthSessions.mockResolvedValue(undefined);
  mockSuspendWorkersForExternalAuthChange.mockResolvedValue(1);
  mockGetEnhancedEnv.mockReturnValue({ PATH: '/mock/bin' });
  mockGetMockLlmOrigin.mockReturnValue(null);
  mockReadClaudeOauthCredentials.mockResolvedValue(null);
  mockCodexReadAccount.mockResolvedValue({
    account: {
      type: 'chatgpt',
      email: 'codex@example.com',
      planType: 'pro',
    },
    requiresOpenaiAuth: true,
  });
});

describe('observeProviderAuthStatus', () => {
  it('seeds first confirmed Claude fingerprint with no active sessions', async () => {
    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(true, 'a@example.com', 'max'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'test',
    );

    expect(mockInvalidateProviderAuthSessions).not.toHaveBeenCalled();
  });

  it('defers active-turn interruption when reconciling the first confirmed Claude fingerprint after a session was created without a baseline', async () => {
    markProviderAuthSessionCreatedWithoutBaseline('claude');

    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(true, 'a@example.com', 'max'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'test',
    );

    expect(mockInvalidateProviderAuthSessions).toHaveBeenCalledWith(
      'claude',
      'test',
      { activeTurnPolicy: 'preserve', preservePreparingTurns: true },
    );
  });

  it('requires two matching observations before invalidating a changed confirmed Claude fingerprint', async () => {
    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(true, 'a@example.com', 'max'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'seed',
    );
    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(true, 'b@example.com', 'max'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'changed-first-observation',
    );
    expect(mockInvalidateProviderAuthSessions).not.toHaveBeenCalled();

    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(true, 'b@example.com', 'max'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'changed-confirmed',
    );

    expect(mockInvalidateProviderAuthSessions).toHaveBeenCalledTimes(1);
    expect(mockInvalidateProviderAuthSessions).toHaveBeenCalledWith(
      'claude',
      'changed-confirmed',
      { activeTurnPolicy: 'preserve', preservePreparingTurns: true },
    );
  });

  it('does not invalidate when only plan/detail metadata changes for the same account', async () => {
    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(true, 'a@example.com', 'max'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'seed',
    );
    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(true, 'a@example.com', 'team'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'plan-changed-1',
    );
    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(true, 'a@example.com', 'team'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'plan-changed-2',
    );

    expect(mockInvalidateProviderAuthSessions).not.toHaveBeenCalled();
  });

  it('cancels an unconfirmed transition when the next observation returns to the baseline', async () => {
    await observeProviderAuthStatus(
      {
        provider: 'codex',
        status: status(true, 'a@example.com', 'plus'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'seed',
    );
    await observeProviderAuthStatus(
      {
        provider: 'codex',
        status: status(false, null),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'transient-logout',
    );
    await observeProviderAuthStatus(
      {
        provider: 'codex',
        status: status(true, 'a@example.com', 'plus'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'recovered',
    );

    expect(mockInvalidateProviderAuthSessions).not.toHaveBeenCalled();
  });

  it('does not let an unknown Claude observation alter the stored fingerprint', async () => {
    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(true, 'a@example.com', 'max'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'seed',
    );
    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(false, null),
        confidence: 'unknown',
        fingerprint: null,
      },
      'unknown',
    );
    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(true, 'a@example.com', 'max'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'same',
    );

    expect(mockInvalidateProviderAuthSessions).not.toHaveBeenCalled();
  });

  it('seeds first confirmed Codex fingerprint without invalidation', async () => {
    await observeProviderAuthStatus(
      {
        provider: 'codex',
        status: status(true, 'codex@example.com', 'pro'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'test',
    );

    expect(mockInvalidateProviderAuthSessions).not.toHaveBeenCalled();
  });

  it('invalidates a twice-confirmed changed Codex fingerprint but not the same one', async () => {
    await observeProviderAuthStatus(
      {
        provider: 'codex',
        status: status(true, 'codex@example.com', 'pro'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'seed',
    );
    await observeProviderAuthStatus(
      {
        provider: 'codex',
        status: status(true, 'other@example.com', 'pro'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'changed-first-observation',
    );
    await observeProviderAuthStatus(
      {
        provider: 'codex',
        status: status(true, 'other@example.com', 'pro'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'changed-confirmed',
    );

    expect(mockInvalidateProviderAuthSessions).toHaveBeenCalledTimes(1);
    expect(mockInvalidateProviderAuthSessions).toHaveBeenCalledWith(
      'codex',
      'changed-confirmed',
      { activeTurnPolicy: 'preserve', preservePreparingTurns: true },
    );
  });

  it('invalidates Codex API-key auth when the effective env API key hash changes', async () => {
    const codexHome = mkdtempSync(path.join(tmpdir(), 'codex-env-key-'));
    mockCodexReadAccount.mockResolvedValue({
      account: { type: 'apiKey' },
      requiresOpenaiAuth: true,
    });
    mockGetEnhancedEnv.mockReturnValueOnce({
      PATH: '/mock/bin',
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: 'first-key',
    });

    try {
      await checkCodexAuthStatusObserved('seed');

      mockGetEnhancedEnv
        .mockReturnValueOnce({
          PATH: '/mock/bin',
          CODEX_HOME: codexHome,
          OPENAI_API_KEY: 'second-key',
        })
        .mockReturnValueOnce({
          PATH: '/mock/bin',
          CODEX_HOME: codexHome,
          OPENAI_API_KEY: 'second-key',
        });

      await checkCodexAuthStatusObserved('changed');
      await checkCodexAuthStatusObserved('changed-confirmed');

      expect(mockInvalidateProviderAuthSessions).toHaveBeenCalledWith(
        'codex',
        'changed-confirmed',
        { activeTurnPolicy: 'preserve', preservePreparingTurns: true },
      );
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('anchors API-key recovery identity to canonical credentials when environment hydration changes', () => {
    const codexHome = mkdtempSync(path.join(tmpdir(), 'codex-recovery-id-'));
    try {
      writeFileSync(
        path.join(codexHome, 'auth.json'),
        `${JSON.stringify({ apiKey: 'canonical-key' })}\n`,
      );
      const apiKeyStatus: AgentProviderAuthStatus = {
        authenticated: true,
        accountLabel: 'API key',
        detail: null,
        error: null,
        accountKind: 'api_key',
      };
      mockGetEnhancedEnv.mockReturnValue({
        PATH: '/mock/bin',
        CODEX_HOME: codexHome,
      });
      const beforeHydration = fingerprintCodexRecoveryIdentity(apiKeyStatus);

      mockGetEnhancedEnv.mockReturnValue({
        PATH: '/mock/bin',
        CODEX_HOME: codexHome,
        OPENAI_API_KEY: 'late-environment-key',
      });

      expect(fingerprintCodexRecoveryIdentity(apiKeyStatus)).toBe(
        beforeHydration,
      );
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('uses the verified account identity when subscription credentials are keyring-backed', () => {
    const codexHome = mkdtempSync(path.join(tmpdir(), 'codex-keyring-id-'));
    try {
      mockGetEnhancedEnv.mockReturnValue({
        PATH: '/mock/bin',
        CODEX_HOME: codexHome,
      });
      const keyringStatus: AgentProviderAuthStatus = {
        authenticated: true,
        accountLabel: 'keyring@example.com',
        accountEmail: 'keyring@example.com',
        detail: 'ChatGPT Plus',
        error: null,
        accountKind: 'subscription',
      };

      expect(fingerprintCodexRecoveryIdentity(keyringStatus)).toBe(
        'credential:subscription:auth:subscription:keyring@example.com',
      );
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('rejects keyring recovery when the provider exposes no stable account identity', () => {
    const codexHome = mkdtempSync(path.join(tmpdir(), 'codex-keyring-empty-'));
    try {
      mockGetEnhancedEnv.mockReturnValue({
        PATH: '/mock/bin',
        CODEX_HOME: codexHome,
      });
      const anonymousStatus: AgentProviderAuthStatus = {
        authenticated: true,
        accountLabel: null,
        accountEmail: null,
        detail: 'ChatGPT Plus',
        error: null,
        accountKind: 'subscription',
      };

      expect(fingerprintCodexRecoveryIdentity(anonymousStatus)).toBeNull();
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('can force invalidation for same-account Codex auth after a successful auth terminal flow', async () => {
    await checkCodexAuthStatusObserved('seed');
    await checkCodexAuthStatusObserved('auth-terminal-exit', {
      forceAuthenticatedInvalidation: true,
    });

    expect(mockInvalidateProviderAuthSessions).toHaveBeenCalledWith(
      'codex',
      'auth-terminal-exit',
      { activeTurnPolicy: 'interrupt' },
    );
  });

  it('cuts over Codex workers before probing after a successful external login', async () => {
    await checkCodexAuthStatusObserved('seed');
    const cutoverOrder: string[] = [];
    mockSuspendWorkersForExternalAuthChange.mockImplementationOnce(() => {
      cutoverOrder.push('suspend');
      return Promise.resolve(1);
    });
    mockCodexReadAccount.mockImplementationOnce(() => {
      cutoverOrder.push('read');
      return Promise.resolve({
        account: {
          type: 'chatgpt',
          email: 'new-codex@example.com',
          planType: 'plus',
        },
        requiresOpenaiAuth: true,
      });
    });

    const result = await checkCodexAuthStatusObserved('auth-terminal-exit', {
      forceAuthenticatedInvalidation: true,
      prepareExplicitTransitionBeforeProbe: true,
    });

    expect(mockInvalidateProviderAuthSessions).toHaveBeenCalledTimes(1);
    expect(mockInvalidateProviderAuthSessions).toHaveBeenCalledWith(
      'codex',
      'auth-terminal-exit',
      { activeTurnPolicy: 'interrupt' },
    );
    expect(mockSuspendWorkersForExternalAuthChange).toHaveBeenCalledTimes(1);
    expect(cutoverOrder).toEqual(['suspend', 'read']);
    expect(result.accountEmail).toBe('new-codex@example.com');
  });

  it('observes a failed explicit Codex worker cutover as an unknown probe', async () => {
    await checkCodexAuthStatusObserved('seed');
    mockSuspendWorkersForExternalAuthChange.mockRejectedValueOnce(
      new Error('worker suspension failed'),
    );

    const result = await checkCodexAuthStatusObserved('auth-terminal-exit', {
      forceAuthenticatedInvalidation: true,
      prepareExplicitTransitionBeforeProbe: true,
    });

    expect(mockCodexAdminRequest).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        authenticated: true,
        accountEmail: 'codex@example.com',
        probeFailed: true,
      }),
    );
  });

  it('does not invalidate on unknown Codex observations', async () => {
    await observeProviderAuthStatus(
      {
        provider: 'codex',
        status: status(false, null),
        confidence: 'unknown',
        fingerprint: null,
      },
      'unknown',
    );

    expect(mockInvalidateProviderAuthSessions).not.toHaveBeenCalled();
  });

  it('serializes distinct back-to-back invalidations for one provider', async () => {
    const releases: Array<() => void> = [];
    let activeInvalidations = 0;
    let maxActiveInvalidations = 0;
    mockInvalidateProviderAuthSessions.mockImplementation(async () => {
      activeInvalidations += 1;
      maxActiveInvalidations = Math.max(
        maxActiveInvalidations,
        activeInvalidations,
      );
      await new Promise<void>((resolve) => releases.push(resolve));
      activeInvalidations -= 1;
    });

    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(true, 'a@example.com', 'max'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'seed',
    );

    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(true, 'b@example.com', 'max'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'first-change-observed',
    );
    const first = observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(true, 'b@example.com', 'max'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'first-change-confirmed',
    );
    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(true, 'c@example.com', 'max'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'second-change-observed',
    );
    const second = observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(true, 'c@example.com', 'max'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'second-change-confirmed',
    );

    await flushPromises();
    expect(mockInvalidateProviderAuthSessions).toHaveBeenCalledTimes(1);
    releases.shift()?.();
    await flushPromises();
    expect(mockInvalidateProviderAuthSessions).toHaveBeenCalledTimes(2);
    releases.shift()?.();
    await Promise.all([first, second]);

    expect(maxActiveInvalidations).toBe(1);
    expect(mockInvalidateProviderAuthSessions.mock.calls).toEqual([
      [
        'claude',
        'first-change-confirmed',
        { activeTurnPolicy: 'preserve', preservePreparingTurns: true },
      ],
      [
        'claude',
        'second-change-confirmed',
        { activeTurnPolicy: 'preserve', preservePreparingTurns: true },
      ],
    ]);
  });
});

describe('checkClaudeAuthStatusObserved', () => {
  it('can force invalidation for same-account Claude auth after a successful auth terminal flow', async () => {
    mockExecFileResult(
      null,
      JSON.stringify({
        loggedIn: true,
        email: 'claude@example.com',
        authMethod: 'oauth',
      }),
    );

    await checkClaudeAuthStatusObserved('seed');
    await checkClaudeAuthStatusObserved('auth-terminal-exit', {
      forceAuthenticatedInvalidation: true,
    });

    expect(mockInvalidateProviderAuthSessions).toHaveBeenCalledWith(
      'claude',
      'auth-terminal-exit',
      { activeTurnPolicy: 'interrupt' },
    );
  });

  it('does not force invalidation for unauthenticated Claude status', async () => {
    mockExecFileResult(
      null,
      JSON.stringify({
        loggedIn: false,
      }),
    );

    await checkClaudeAuthStatusObserved('seed');
    await checkClaudeAuthStatusObserved('auth-terminal-exit', {
      forceAuthenticatedInvalidation: true,
    });

    expect(mockInvalidateProviderAuthSessions).not.toHaveBeenCalled();
  });

  it('prefers the OAuth rateLimitTier over the coarse subscriptionType for planType', async () => {
    mockExecFileResult(
      null,
      JSON.stringify({
        loggedIn: true,
        email: 'claude@example.com',
        authMethod: 'claude.ai',
        subscriptionType: 'max',
      }),
    );
    mockReadClaudeOauthCredentials.mockResolvedValue({
      accessToken: 'token',
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    });

    const result = await checkClaudeAuthStatusObserved('seed');

    expect(result.planType).toBe('default_claude_max_20x');
  });

  it('falls back to subscriptionType when no rateLimitTier is available', async () => {
    mockExecFileResult(
      null,
      JSON.stringify({
        loggedIn: true,
        email: 'claude@example.com',
        authMethod: 'claude.ai',
        subscriptionType: 'max',
      }),
    );
    mockReadClaudeOauthCredentials.mockResolvedValue(null);

    const result = await checkClaudeAuthStatusObserved('seed');

    expect(result.planType).toBe('max');
  });

  it('maps a team seat with the premium rate bucket to team-premium', async () => {
    mockExecFileResult(
      null,
      JSON.stringify({
        loggedIn: true,
        email: 'dev@company.com',
        authMethod: 'claude.ai',
        orgName: 'Company',
        subscriptionType: 'team',
      }),
    );
    // A premium team seat reports `default_claude_max_5x` in its rate bucket.
    // It must not be read as a personal Max plan; it is a premium team seat.
    mockReadClaudeOauthCredentials.mockResolvedValue({
      accessToken: 'token',
      subscriptionType: 'team',
      rateLimitTier: 'default_claude_max_5x',
    });

    const result = await checkClaudeAuthStatusObserved('seed');

    expect(result.planType).toBe('team-premium');
  });

  it('treats any other team rate bucket as a standard team seat', async () => {
    mockExecFileResult(
      null,
      JSON.stringify({
        loggedIn: true,
        email: 'dev@company.com',
        authMethod: 'claude.ai',
        orgName: 'Company',
        subscriptionType: 'team',
      }),
    );
    mockReadClaudeOauthCredentials.mockResolvedValue({
      accessToken: 'token',
      subscriptionType: 'team',
      rateLimitTier: 'default_claude_team_standard',
    });

    const result = await checkClaudeAuthStatusObserved('seed');

    expect(result.planType).toBe('team');
  });

  it('falls back to a standard team seat when the rate bucket is unavailable', async () => {
    mockExecFileResult(
      null,
      JSON.stringify({
        loggedIn: true,
        email: 'dev@company.com',
        authMethod: 'claude.ai',
        orgName: 'Company',
        subscriptionType: 'team',
      }),
    );
    mockReadClaudeOauthCredentials.mockResolvedValue(null);

    const result = await checkClaudeAuthStatusObserved('seed');

    expect(result.planType).toBe('team');
  });
});

describe('provider auth probe failure semantics', () => {
  it('marks a throwing Claude probe probeFailed without clobbering a prior confirmed login', async () => {
    // Seed a confirmed authenticated status.
    mockExecFileResult(
      null,
      JSON.stringify({
        loggedIn: true,
        email: 'claude@example.com',
        authMethod: 'claude.ai',
        subscriptionType: 'pro',
      }),
    );
    const seeded = await checkClaudeAuthStatusObserved('seed');
    expect(seeded.authenticated).toBe(true);
    expect(seeded.probeFailed).toBeUndefined();

    // Now the probe throws — it must NOT read as a confirmed logout and must
    // preserve the last-known-good identity.
    mockExecFileResult(new Error('cli failed'), '');
    const result = await checkClaudeAuthStatusObserved('probe-failed');

    expect(result.probeFailed).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.accountEmail).toBe('claude@example.com');
    expect(result.planType).toBe('pro');
    // A probe failure must never invalidate live sessions.
    expect(mockInvalidateProviderAuthSessions).not.toHaveBeenCalled();
    // The money-adjacent failure is recorded as a diagnostic.
    expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'provider_auth_probe_failed' }),
    );
    expect(mockLogMainProcessWarn).toHaveBeenCalledWith(
      'provider-auth: claude auth probe failed (retainedConfirmed=true)',
      'cli failed',
    );
  });

  it('retains the confirmed identity across consecutive Claude probe failures', async () => {
    // Seed a confirmed authenticated status.
    mockExecFileResult(
      null,
      JSON.stringify({
        loggedIn: true,
        email: 'claude@example.com',
        authMethod: 'claude.ai',
        subscriptionType: 'pro',
      }),
    );
    await checkClaudeAuthStatusObserved('seed');

    // Simulate a sustained outage: the probe throws on every subsequent read.
    mockExecFileResult(new Error('cli failed'), '');
    const first = await checkClaudeAuthStatusObserved('probe-failed-1');
    const second = await checkClaudeAuthStatusObserved('probe-failed-2');
    const third = await checkClaudeAuthStatusObserved('probe-failed-3');

    // Regression guard: the retained identity must survive the SECOND and
    // later consecutive failures, not just the first. Reading the working cache
    // (already `probeFailed`) would blank these out from the second failure on.
    for (const result of [first, second, third]) {
      expect(result.probeFailed).toBe(true);
      expect(result.authenticated).toBe(true);
      expect(result.accountEmail).toBe('claude@example.com');
      expect(result.planType).toBe('pro');
    }
    expect(mockInvalidateProviderAuthSessions).not.toHaveBeenCalled();
  });

  it('caches a cold-start Claude probe failure as an unknown, not a logout', async () => {
    mockExecFileResult(new Error('cli failed'), '');
    const result = await checkClaudeAuthStatusObserved('cold-probe-failed');

    expect(result.probeFailed).toBe(true);
    expect(result.authenticated).toBe(false);
  });

  it('confirmed logout is not treated as a probe failure', async () => {
    // CONTRACT REGRESSION GUARD: a genuine logout is a *successful* probe
    // response with `loggedIn: false`. It must resolve to a
    // confirmed signed-out status (`authenticated: false`, `probeFailed`
    // absent) so AI-credit routing sees a real logout. `claude auth status
    // --json` currently reports this payload with exit 1; that real CLI
    // behavior has its own regression below.
    mockExecFileResult(null, JSON.stringify({ loggedIn: false }));

    const result = await checkClaudeAuthStatusObserved('confirmed-logout');

    expect(result.authenticated).toBe(false);
    expect(result.probeFailed).toBeUndefined();
    // A confirmed logout is not a probe failure, so no diagnostic is recorded.
    expect(mockRecordAppDiagnostic).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'provider_auth_probe_failed' }),
    );
  });

  it('treats the Claude CLI signed-out exit code as a confirmed logout', async () => {
    const signedOutPayload = JSON.stringify({
      loggedIn: false,
      authMethod: 'none',
      apiProvider: 'firstParty',
    });
    const signedOutExit = Object.assign(
      new Error('Command failed with exit code 1'),
      {
        code: 1,
        stdout: signedOutPayload,
        stderr: '',
      },
    );
    mockExecFileResult(signedOutExit, signedOutPayload);

    const result = await checkClaudeAuthStatusObserved(
      'confirmed-logout-nonzero-exit',
    );

    expect(result.authenticated).toBe(false);
    expect(result.probeFailed).toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockRecordAppDiagnostic).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'provider_auth_probe_failed' }),
    );
  });

  it('retries a non-ENOENT Claude probe failure exactly once', async () => {
    mockExecFileResult(new Error('transient spawn failure'), '');

    const result = await checkClaudeAuthStatusObserved('retry');

    expect(result.probeFailed).toBe(true);
    // One initial attempt + one retry.
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  // The unwrap must cover BOTH attempts. A transient first failure followed by
  // Claude CLI's normal signed-out exit 1 is still an authoritative logout; if
  // only attempt 1 were unwrapped, that ordering would degrade to `probeFailed`,
  // the user would be treated as natively authenticated, and the raw
  // `Please run /login` this path exists to prevent would come back (ECW-9091).
  it('treats a signed-out exit on the RETRY as a confirmed logout', async () => {
    const signedOutPayload = JSON.stringify({
      loggedIn: false,
      authMethod: 'none',
      apiProvider: 'firstParty',
    });
    const signedOutExit = Object.assign(
      new Error('Command failed with exit code 1'),
      { code: 1, stdout: signedOutPayload, stderr: '' },
    );
    let attempt = 0;
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb?: ExecFileCallback,
      ) => {
        attempt += 1;
        if (attempt === 1) {
          cb?.(new Error('transient spawn failure'), {
            stdout: '',
            stderr: '',
          });
          return;
        }
        cb?.(signedOutExit, { stdout: signedOutPayload, stderr: '' });
      },
    );

    const result = await checkClaudeAuthStatusObserved(
      'retry-confirmed-logout',
    );

    expect(result.authenticated).toBe(false);
    expect(result.probeFailed).toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  // Unlike Codex — where a custom `model_provider` produces a successful-but-
  // indeterminate read that must NOT be treated as a logout — every third-party
  // Claude configuration reports `loggedIn: true` and exits 0. These payloads
  // are copied verbatim from the bundled binary run with an empty
  // `CLAUDE_CONFIG_DIR`. Pinning them here means a future CLI change that starts
  // reporting `loggedIn: false` for a third-party provider fails a test rather
  // than silently rerouting that user's spend onto AI Credits (their own
  // provider would not merely be bypassed but suppressed, since
  // `buildClaudeProxyEnv` blanks `ANTHROPIC_API_KEY` and overrides
  // `ANTHROPIC_BASE_URL`).
  it.each([
    ['bedrock', { authMethod: 'third_party', apiProvider: 'bedrock' }],
    ['vertex', { authMethod: 'third_party', apiProvider: 'vertex' }],
    [
      'api key',
      {
        authMethod: 'api_key',
        apiProvider: 'firstParty',
        apiKeySource: 'ANTHROPIC_API_KEY',
      },
    ],
  ])(
    'treats a non-OAuth Claude configuration (%s) as authenticated',
    async (_label, payload) => {
      mockExecFileResult(null, JSON.stringify({ loggedIn: true, ...payload }));

      const result = await checkClaudeAuthStatusObserved('third-party');

      expect(result.authenticated).toBe(true);
      expect(result.probeFailed).toBeUndefined();
    },
  );

  it('does not retry an ENOENT Claude probe failure', async () => {
    const enoent = new Error('spawn claude ENOENT');
    mockExecFileResult(enoent, '');

    const result = await checkClaudeAuthStatusObserved('enoent');

    expect(result.probeFailed).toBe(true);
    expect(result.error).toBe('Claude CLI is not installed.');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('isProviderNativelyAuthenticated is true for a probeFailed Claude status', async () => {
    mockExecFileResult(new Error('cli failed'), '');

    await expect(
      isProviderNativelyAuthenticated('claude', 'ai-credits-routing'),
    ).resolves.toBe(true);
  });
});

describe('getCachedClaudeAuthStatusObserved', () => {
  it('reuses a fresh Claude auth status until forced to refresh', async () => {
    mockExecFileResult(
      null,
      JSON.stringify({
        loggedIn: true,
        email: 'first@example.com',
        authMethod: 'oauth',
      }),
    );

    const first = await getCachedClaudeAuthStatusObserved('first');
    const second = await getCachedClaudeAuthStatusObserved('second');

    expect(first.accountLabel).toBe('first@example.com');
    expect(second.accountLabel).toBe('first@example.com');
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    mockExecFileResult(
      null,
      JSON.stringify({
        loggedIn: false,
      }),
    );

    const refreshed = await getCachedClaudeAuthStatusObserved('forced', {
      forceRefresh: true,
    });

    expect(refreshed.authenticated).toBe(false);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});

describe('Codex speed catalog invalidation on auth transitions', () => {
  function codexStatus(email: string): AgentProviderAuthStatus {
    return {
      ...status(true, email, 'pro'),
      accountEmail: email,
      accountKind: 'subscription',
    };
  }

  function observeCodex(email: string, reason: string): Promise<void> {
    return observeProviderAuthStatus(
      {
        provider: 'codex',
        status: codexStatus(email),
        confidence: 'confirmed',
        fingerprint: `auth:subscription:${email}`,
      },
      reason,
    );
  }

  it('invalidates after a confirmed passive Codex account transition only', async () => {
    await observeCodex('a@example.com', 'seed');
    await observeCodex('a@example.com', 'same');
    await observeCodex('b@example.com', 'first-sighting');
    await observeProviderAuthStatus(
      {
        provider: 'codex',
        status: codexStatus('b@example.com'),
        confidence: 'unknown',
        fingerprint: null,
      },
      'inconclusive',
    );
    expect(mockInvalidateCodexSpeedCatalog).not.toHaveBeenCalled();

    await observeCodex('b@example.com', 'first-sighting');
    await observeCodex('b@example.com', 'confirmed');

    expect(mockInvalidateCodexSpeedCatalog).toHaveBeenCalledTimes(1);
    expect(mockInvalidateCodexSpeedCatalog).toHaveBeenCalledWith(
      'auth-transition',
    );
    // The catalog restarts only after the old sessions were invalidated.
    expect(
      mockInvalidateCodexSpeedCatalog.mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      mockInvalidateProviderAuthSessions.mock.invocationCallOrder[0],
    );
  });

  it('does not touch the Codex catalog for Claude transitions', async () => {
    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(true, 'a@example.com', 'max'),
        confidence: 'confirmed',
        fingerprint: null,
        forceInvalidation: true,
      },
      'claude-login',
    );

    expect(mockInvalidateProviderAuthSessions).toHaveBeenCalled();
    expect(mockInvalidateCodexSpeedCatalog).not.toHaveBeenCalled();
  });

  it('invalidates again once an external sign-in has retired the old workers', async () => {
    await checkCodexAuthStatusObserved('external-login', {
      forceAuthenticatedInvalidation: true,
      prepareExplicitTransitionBeforeProbe: true,
    });

    const suspendedAt =
      mockSuspendWorkersForExternalAuthChange.mock.invocationCallOrder[0];
    expect(suspendedAt).toBeDefined();
    expect(
      Math.max(...mockInvalidateCodexSpeedCatalog.mock.invocationCallOrder),
    ).toBeGreaterThan(suspendedAt);
  });

  it('invalidates when a managed sign-in commits a verified account', async () => {
    await acceptVerifiedCodexAccount({
      account: { type: 'chatgpt', email: 'new@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
    });

    expect(mockInvalidateCodexSpeedCatalog).toHaveBeenCalledWith(
      'auth-transition',
    );
  });
});

describe('checkCodexAuthStatusObserved', () => {
  it('uses only the build-gated mock account in E2E and never opens the shared runtime', async () => {
    Object.assign(globalThis, { __CANOPY_E2E__: true });
    mockGetMockLlmOrigin.mockReturnValue('http://mock.test');
    mockFetchMockControlPlaneRecord.mockResolvedValue({
      account: {
        type: 'chatgpt',
        email: 'e2e@example.test',
        planType: 'plus',
      },
      requiresOpenaiAuth: true,
    });

    const result = await checkCodexAuthStatusObserved('settings-status');

    expect(mockFetchMockControlPlaneRecord).toHaveBeenCalledWith(
      'http://mock.test',
      '/__mock/codex/account',
    );
    expect(mockCodexAdminRequest).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        authenticated: true,
        accountLabel: 'e2e@example.test',
      }),
    );
  });

  it('fails closed in E2E when the auth mock is not configured', async () => {
    Object.assign(globalThis, { __CANOPY_E2E__: true });

    const result = await checkCodexAuthStatusObserved('settings-status');

    expect(mockCodexAdminRequest).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        authenticated: false,
        error: 'Could not verify Codex authentication.',
        probeFailed: true,
      }),
    );
  });

  it('uses the shared runtime service and forces a fresh account read', async () => {
    const result = await checkCodexAuthStatusObserved('settings-status');

    expect(mockCodexAdminRequest).toHaveBeenCalledWith('account/read', {
      refreshToken: false,
    });
    expect(mockCodexReadAccount).toHaveBeenCalledWith(false);
    expect(result).toEqual({
      authenticated: true,
      accountLabel: 'codex@example.com',
      detail: 'pro',
      error: null,
      accountEmail: 'codex@example.com',
      planType: 'pro',
      accountKind: 'subscription',
      authFingerprint: 'auth:subscription:codex@example.com',
    });
  });

  it('preserves an app-server account-read failure as unknown without probing host credentials through the CLI', async () => {
    mockCodexReadAccount.mockRejectedValueOnce(new Error('read failed'));
    mockExecFileResult(null, 'Logged in using ChatGPT');

    const result = await checkCodexAuthStatusObserved('auth-terminal-exit');

    expect(result).toEqual(
      expect.objectContaining({
        authenticated: false,
        error: 'Could not verify Codex authentication.',
        probeFailed: true,
      }),
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('treats app-server and CLI failures as unknown for invalidation', async () => {
    mockCodexReadAccount.mockRejectedValue(new Error('read failed'));
    mockExecFileResult(new Error('cli failed'), '');

    const result = await checkCodexAuthStatusObserved('settings-status');

    expect(mockInvalidateProviderAuthSessions).not.toHaveBeenCalled();
    expect(result).toEqual({
      authenticated: false,
      accountLabel: null,
      detail: null,
      // A probe failure is inconclusive, so the user-visible message must read
      // as a verification failure, not a confirmed signed-out state.
      error: 'Could not verify Codex authentication.',
      probeFailed: true,
    });
  });

  it('retains the confirmed identity across consecutive Codex probe failures', async () => {
    // Seed a confirmed authenticated status (default mock resolves a login).
    const seeded = await checkCodexAuthStatusObserved('seed');
    expect(seeded.authenticated).toBe(true);
    expect(seeded.probeFailed).toBeUndefined();

    // Simulate a sustained outage: both the app-server read and the CLI
    // fallback throw on every subsequent read.
    mockCodexReadAccount.mockRejectedValue(new Error('read failed'));
    mockExecFileResult(new Error('cli failed'), '');
    const first = await checkCodexAuthStatusObserved('probe-failed-1');
    const second = await checkCodexAuthStatusObserved('probe-failed-2');
    const third = await checkCodexAuthStatusObserved('probe-failed-3');

    // Regression guard (mirrors the Claude path): the retained identity must
    // survive the SECOND and later consecutive failures, not just the first.
    for (const result of [first, second, third]) {
      expect(result.probeFailed).toBe(true);
      expect(result.authenticated).toBe(true);
      expect(result.accountEmail).toBe('codex@example.com');
      expect(result.planType).toBe('pro');
    }
    expect(mockInvalidateProviderAuthSessions).not.toHaveBeenCalled();
  });
});

describe('getCachedCodexAuthStatusObserved', () => {
  it('reuses a fresh Codex auth status and dedupes concurrent callers', async () => {
    let resolveRead: ((value: unknown) => void) | undefined;
    mockCodexReadAccount.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );

    // Two concurrent cold callers must share one in-flight app-server read.
    const firstPromise = getCachedCodexAuthStatusObserved('first');
    const secondPromise = getCachedCodexAuthStatusObserved('second');
    resolveRead?.({
      account: { type: 'chatgpt', email: 'codex@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
    });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.accountLabel).toBe('codex@example.com');
    expect(second).toEqual(first);
    expect(mockCodexAdminRequest).toHaveBeenCalledTimes(1);

    // A warm cache read does not spawn another app-server.
    const third = await getCachedCodexAuthStatusObserved('third');
    expect(third).toEqual(first);
    expect(mockCodexAdminRequest).toHaveBeenCalledTimes(1);
  });

  it('spawns a fresh read when forced to refresh', async () => {
    await getCachedCodexAuthStatusObserved('seed');
    expect(mockCodexAdminRequest).toHaveBeenCalledTimes(1);

    await getCachedCodexAuthStatusObserved('forced', { forceRefresh: true });
    expect(mockCodexAdminRequest).toHaveBeenCalledTimes(2);
  });
});

describe('isProviderNativelyAuthenticated', () => {
  // Several cases below pin `Date.now` to exercise TTL behavior. Without this,
  // the frozen clock leaks into the remaining tests in this block (and the
  // first test of the next), making every cache trivially fresh and quietly
  // turning neighboring TTL assertions vacuous.
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is true for a Codex ChatGPT login (via cached status)', async () => {
    await expect(
      isProviderNativelyAuthenticated('codex', 'ai-credits-routing'),
    ).resolves.toBe(true);
  });

  it('treats a Codex API key as native auth', async () => {
    mockCodexReadAccount.mockResolvedValue({
      account: { type: 'apiKey' },
      requiresOpenaiAuth: true,
    });

    await expect(
      isProviderNativelyAuthenticated('codex', 'ai-credits-routing'),
    ).resolves.toBe(true);
  });

  it('is false when Codex is confirmed unauthenticated', async () => {
    // A genuine logout: the app-server resolves with no account (no throw), so
    // the status is a *confirmed* signed-out, not a failed probe.
    mockCodexReadAccount.mockResolvedValue({
      account: null,
      requiresOpenaiAuth: true,
    });

    await expect(
      isProviderNativelyAuthenticated('codex', 'ai-credits-routing'),
    ).resolves.toBe(false);
  });

  it('is true when the Codex probe fails (unknown, not signed out)', async () => {
    mockCodexReadAccount.mockRejectedValue(new Error('read failed'));
    mockExecFileResult(new Error('cli failed'), '');

    await expect(
      isProviderNativelyAuthenticated('codex', 'ai-credits-routing'),
    ).resolves.toBe(true);
  });

  // ECW-9091 regression. `{ account: null, requiresOpenaiAuth: false }` is a
  // *successful* read that is nonetheless INDETERMINATE: it is what a custom
  // `model_provider` (Azure / self-hosted / proxy) reports, and
  // `buildCodexAccountUsageSummary` models it as `authState: 'unknown'`. It must
  // never be read as a confirmed logout, because a confirmed logout now
  // force-routes onto the user's AI Credits in EVERY mode — silently billing a
  // user who has a perfectly good provider of their own.
  it('is true when Codex reports an indeterminate account (custom model_provider)', async () => {
    mockCodexReadAccount.mockResolvedValue({
      account: null,
      requiresOpenaiAuth: false,
    });

    await expect(
      isProviderNativelyAuthenticated('codex', 'ai-credits-routing'),
    ).resolves.toBe(true);
  });

  it('flags the indeterminate Codex status as probeFailed, not signed out', async () => {
    mockCodexReadAccount.mockResolvedValue({
      account: null,
      requiresOpenaiAuth: false,
    });

    const status = await checkCodexAuthStatusObserved('test');
    expect(status.authenticated).toBe(false);
    expect(status.probeFailed).toBe(true);

    // Consumers that must not assert "signed out" from an unknown: the Portal
    // availability peek omits the key entirely.
    expect(peekProviderNativeAuthAvailability().codex).toBeUndefined();
  });

  it('keeps the confirmed-logout Codex status unflagged', async () => {
    mockCodexReadAccount.mockResolvedValue({
      account: null,
      requiresOpenaiAuth: true,
    });

    const status = await checkCodexAuthStatusObserved('test');
    expect(status.authenticated).toBe(false);
    expect(status.probeFailed).toBeUndefined();
    expect(peekProviderNativeAuthAvailability().codex).toBe(false);
  });

  // The indeterminate state is PERMANENT for a custom `model_provider` account,
  // so it must not inherit the probe-failure retry TTL — that would re-probe
  // ~10x more often forever to re-learn an answer that never changes. A thrown
  // probe is transient and keeps the short retry TTL.
  it('does not apply the retry TTL to a stable indeterminate Codex status', async () => {
    mockCodexReadAccount.mockResolvedValue({
      account: null,
      requiresOpenaiAuth: false,
    });

    const first = await getCachedCodexAuthStatusObserved('first');
    expect(first.probeRetryable).toBe(false);
    mockCodexReadAccount.mockClear();

    // Past PROBE_FAILURE_TTL_MS (3s) but inside the normal TTL: still cached.
    const start = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(start + 5_000);
    await getCachedCodexAuthStatusObserved('second');
    expect(mockCodexReadAccount).not.toHaveBeenCalled();
  });

  it('still applies the retry TTL to a thrown Codex probe', async () => {
    mockCodexReadAccount.mockRejectedValue(new Error('read failed'));

    const first = await getCachedCodexAuthStatusObserved('first');
    expect(first.probeFailed).toBe(true);
    expect(first.probeRetryable).not.toBe(false);
    mockCodexReadAccount.mockClear();

    const start = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(start + 5_000);
    await getCachedCodexAuthStatusObserved('second');
    expect(mockCodexReadAccount).toHaveBeenCalled();
  });

  it('reads Claude native auth through its cached status', async () => {
    mockExecFileResult(
      null,
      JSON.stringify({
        loggedIn: true,
        email: 'claude@example.com',
        authMethod: 'oauth',
      }),
    );

    await expect(
      isProviderNativelyAuthenticated('claude', 'ai-credits-routing'),
    ).resolves.toBe(true);
  });

  it('is false when Claude is not logged in', async () => {
    mockExecFileResult(null, JSON.stringify({ loggedIn: false }));

    await expect(
      isProviderNativelyAuthenticated('claude', 'ai-credits-routing'),
    ).resolves.toBe(false);
  });
});

// ECW-9091: routing-decision variant with an asymmetric stale-cache fast path.
// "Stay native" is the common case and the safe direction to be stale about;
// the money-moving direction (spending the user's credits) always revalidates.
describe('isProviderNativelyAuthenticatedForRouting', () => {
  const AUTHED_PAYLOAD = JSON.stringify({
    loggedIn: true,
    email: 'claude@example.com',
    authMethod: 'oauth',
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('falls through to the authoritative probe on a cold cache, then serves it warm', async () => {
    mockExecFileResult(null, AUTHED_PAYLOAD);

    // Cold: no cached entry, so the authoritative probe runs.
    await expect(
      isProviderNativelyAuthenticatedForRouting('claude', 'ai-credits-routing'),
    ).resolves.toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    // Warm + authenticated: served from cache with no further probe.
    await expect(
      isProviderNativelyAuthenticatedForRouting('claude', 'ai-credits-routing'),
    ).resolves.toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('never serves a cached signed-out state from the fast path', async () => {
    mockExecFileResult(null, JSON.stringify({ loggedIn: false }));

    await expect(
      isProviderNativelyAuthenticatedForRouting('claude', 'ai-credits-routing'),
    ).resolves.toBe(false);
    await expect(
      isProviderNativelyAuthenticatedForRouting('claude', 'ai-credits-routing'),
    ).resolves.toBe(false);
  });

  it('does not serve a probeFailed entry from the fast path', async () => {
    // Seed a confirmed login, then a probe failure. The failure entry retains
    // `authenticated: true` (fail-closed), so only the `probeFailed` guard
    // stops the fast path from serving it.
    mockExecFileResult(null, AUTHED_PAYLOAD);
    await getCachedClaudeAuthStatusObserved('seed');
    mockExecFileResult(new Error('cli failed'), '');
    await getCachedClaudeAuthStatusObserved('fail', { forceRefresh: true });

    // Past the 3s probe-failure TTL but well inside the 5min stale window.
    const start = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(start + 10_000);
    mockExecFileResult(null, JSON.stringify({ loggedIn: false }));

    // A fast-path hit would wrongly return `true` from the retained identity.
    await expect(
      isProviderNativelyAuthenticatedForRouting('claude', 'ai-credits-routing'),
    ).resolves.toBe(false);
  });

  it('serves a stale authenticated entry past the TTL and revalidates in the background', async () => {
    mockExecFileResult(null, AUTHED_PAYLOAD);
    await getCachedClaudeAuthStatusObserved('seed');
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    // 60s: past the 30s TTL, inside the 5min stale window.
    const start = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(start + 60_000);
    mockExecFileResult(null, JSON.stringify({ loggedIn: false }));

    await expect(
      isProviderNativelyAuthenticatedForRouting('claude', 'ai-credits-routing'),
    ).resolves.toBe(true);

    // The background revalidation was scheduled, not awaited.
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    // Once it lands, the newly-confirmed logout is what routing sees.
    await expect(
      isProviderNativelyAuthenticatedForRouting('claude', 'ai-credits-routing'),
    ).resolves.toBe(false);
  });

  it('falls through to the authoritative probe beyond the stale window', async () => {
    mockExecFileResult(null, AUTHED_PAYLOAD);
    await getCachedClaudeAuthStatusObserved('seed');

    // 6min: beyond the 5min stale window, so no stale serve.
    const start = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(start + 360_000);
    mockExecFileResult(null, JSON.stringify({ loggedIn: false }));

    await expect(
      isProviderNativelyAuthenticatedForRouting('claude', 'ai-credits-routing'),
    ).resolves.toBe(false);
  });
});

describe('ensureProviderAuthBaselineForSession', () => {
  it('seeds a confirmed provider fingerprint before session creation', async () => {
    mockExecFileResult(
      null,
      JSON.stringify({
        loggedIn: true,
        email: 'claude@example.com',
        authMethod: 'oauth',
      }),
    );

    await expect(
      ensureProviderAuthBaselineForSession('claude', 'session-create'),
    ).resolves.toBe(true);

    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(true, 'claude@example.com', 'oauth'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'settings-status',
    );

    expect(mockInvalidateProviderAuthSessions).not.toHaveBeenCalled();
  });

  it('marks a provider baseline as unknown when seeding fails', async () => {
    mockExecFileResult(new Error('cli failed'), '');

    await expect(
      ensureProviderAuthBaselineForSession('claude', 'session-create'),
    ).resolves.toBe(false);

    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(true, 'claude@example.com', 'oauth'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'settings-status',
    );

    expect(mockInvalidateProviderAuthSessions).toHaveBeenCalledWith(
      'claude',
      'settings-status',
      { activeTurnPolicy: 'preserve', preservePreparingTurns: true },
    );
  });

  // A successful-but-INDETERMINATE probe records nothing (`observeProviderAuthStatus`
  // short-circuits on `'unknown'`), so it must take the same escape hatch as a
  // thrown probe. Otherwise a later real `codex login` seeds the fingerprint as
  // a FIRST observation, enqueues no invalidation, and the live session keeps
  // running against the pre-login state.
  it('marks the baseline unknown when the Codex probe is indeterminate', async () => {
    mockCodexReadAccount.mockResolvedValue({
      account: null,
      requiresOpenaiAuth: false,
    });

    await expect(
      ensureProviderAuthBaselineForSession('codex', 'session-create'),
    ).resolves.toBe(false);

    // The user then really logs in.
    await observeProviderAuthStatus(
      {
        provider: 'codex',
        status: status(true, 'codex@example.com', 'pro'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      'settings-status',
    );

    expect(mockInvalidateProviderAuthSessions).toHaveBeenCalledWith(
      'codex',
      'settings-status',
      { activeTurnPolicy: 'preserve', preservePreparingTurns: true },
    );
  });

  // An indeterminate probe records nothing, so the `lastConfirmedFingerprints`
  // fast path can never engage for this provider. A custom Codex
  // `model_provider` is a PERMANENT state, so without a cooldown every
  // `getOrCreateSession` / `sessionMatchesOptions` /
  // `canPreserveSessionCapabilitySnapshot` would pay a fresh UNCACHED
  // `account/read` — an app-server round trip on essentially every message send.
  it('does not re-probe a stable-indeterminate Codex baseline within the TTL', async () => {
    mockCodexReadAccount.mockResolvedValue({
      account: null,
      requiresOpenaiAuth: false,
    });
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);

    try {
      await expect(
        ensureProviderAuthBaselineForSession('codex', 'session-create'),
      ).resolves.toBe(false);
      expect(mockCodexReadAccount).toHaveBeenCalledTimes(1);

      // Subsequent session checks inside the window reuse the cooldown.
      nowSpy.mockReturnValue(1_000 + 29_999);
      await expect(
        ensureProviderAuthBaselineForSession('codex', 'session-match'),
      ).resolves.toBe(false);
      await expect(
        ensureProviderAuthBaselineForSession('codex', 'capability-snapshot'),
      ).resolves.toBe(false);
      expect(mockCodexReadAccount).toHaveBeenCalledTimes(1);

      // Once the window lapses the state can still reconverge on its own, so a
      // user who fixes their config is picked up without a restart.
      nowSpy.mockReturnValue(1_000 + 30_000);
      await expect(
        ensureProviderAuthBaselineForSession('codex', 'session-create'),
      ).resolves.toBe(false);
      expect(mockCodexReadAccount).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  // A THROWN probe is genuinely transient, so it keeps retrying on every check
  // — the cooldown above must not bleed into this path.
  it('still re-probes after a thrown baseline probe', async () => {
    mockExecFileResult(new Error('cli failed'), '');
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);

    try {
      await expect(
        ensureProviderAuthBaselineForSession('claude', 'session-create'),
      ).resolves.toBe(false);
      const callsAfterFirst = mockExecFile.mock.calls.length;

      await expect(
        ensureProviderAuthBaselineForSession('claude', 'session-match'),
      ).resolves.toBe(false);
      expect(mockExecFile.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    } finally {
      nowSpy.mockRestore();
    }
  });

  // The cooldown must not outlive the condition that set it.
  it('clears the indeterminate cooldown once a confirmed probe lands', async () => {
    mockCodexReadAccount.mockResolvedValue({
      account: null,
      requiresOpenaiAuth: false,
    });
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);

    try {
      await expect(
        ensureProviderAuthBaselineForSession('codex', 'session-create'),
      ).resolves.toBe(false);

      // The user logs in; the next probe past the window is confirmed.
      nowSpy.mockReturnValue(1_000 + 30_000);
      mockCodexReadAccount.mockResolvedValue({
        account: { email: 'codex@example.com', planType: 'pro' },
        requiresOpenaiAuth: true,
      });
      await expect(
        ensureProviderAuthBaselineForSession('codex', 'session-create'),
      ).resolves.toBe(true);

      // Now the confirmed-fingerprint fast path carries it, with no re-probe.
      const callsAfterConfirm = mockCodexReadAccount.mock.calls.length;
      await expect(
        ensureProviderAuthBaselineForSession('codex', 'session-match'),
      ).resolves.toBe(true);
      expect(mockCodexReadAccount).toHaveBeenCalledTimes(callsAfterConfirm);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('still seeds a real baseline for a confirmed Codex logout', async () => {
    mockCodexReadAccount.mockResolvedValue({
      account: null,
      requiresOpenaiAuth: true,
    });

    await expect(
      ensureProviderAuthBaselineForSession('codex', 'session-create'),
    ).resolves.toBe(true);
  });
});

describe('buildClaudeAuthStatusFromPayload structured identity', () => {
  it('populates account fields for a subscription login', () => {
    const result = buildClaudeAuthStatusFromPayload({
      loggedIn: true,
      email: 'Dev@Example.com',
      subscriptionType: 'max',
      authMethod: 'claude.ai',
    });
    expect(result.accountEmail).toBe('Dev@Example.com');
    expect(result.planType).toBe('max');
    expect(result.accountKind).toBe('subscription');
  });

  it('marks an API-key login as api_key with no email', () => {
    const result = buildClaudeAuthStatusFromPayload({
      loggedIn: true,
      email: 'ignored@example.com',
      authMethod: 'API key',
    });
    expect(result.accountKind).toBe('api_key');
    expect(result.planType).toBeNull();
  });

  it('marks an unauthenticated payload as unknown with null identity', () => {
    const result = buildClaudeAuthStatusFromPayload({ loggedIn: false });
    expect(result.accountKind).toBe('unknown');
    expect(result.accountEmail).toBeNull();
    expect(result.planType).toBeNull();
  });
});

describe('deriveProviderAccountKey', () => {
  it('derives a normalized key for a subscription login with an email', () => {
    expect(
      deriveProviderAccountKey('claude', {
        authenticated: true,
        accountLabel: 'Dev@Example.com',
        detail: null,
        error: null,
        accountEmail: '  Dev@Example.com ',
        planType: 'max',
        accountKind: 'subscription',
      }),
    ).toBe('claude:dev@example.com');
  });

  it('returns null for API-key, Bedrock, unauthenticated, and email-less statuses', () => {
    const base: AgentProviderAuthStatus = {
      authenticated: true,
      accountLabel: null,
      detail: null,
      error: null,
      accountEmail: 'x@example.com',
      planType: null,
      accountKind: 'subscription',
    };
    expect(
      deriveProviderAccountKey('codex', { ...base, accountKind: 'api_key' }),
    ).toBeNull();
    expect(
      deriveProviderAccountKey('codex', { ...base, accountKind: 'bedrock' }),
    ).toBeNull();
    expect(
      deriveProviderAccountKey('codex', { ...base, authenticated: false }),
    ).toBeNull();
    expect(
      deriveProviderAccountKey('codex', { ...base, accountEmail: null }),
    ).toBeNull();
  });
});

describe('peekProviderAccountIdentity', () => {
  it('returns null before any auth status has been observed', () => {
    expect(peekProviderAccountIdentity('claude')).toBeNull();
    expect(peekProviderAccountIdentity('codex')).toBeNull();
  });

  it('reads the cached subscription identity after an observed status', async () => {
    await checkCodexAuthStatusObserved('settings-status');
    expect(peekProviderAccountIdentity('codex')).toEqual({
      providerAccountKey: 'codex:codex@example.com',
      accountEmail: 'codex@example.com',
      planType: 'pro',
    });
  });

  it('returns null when the cached status is an API key', async () => {
    mockCodexReadAccount.mockResolvedValueOnce({
      account: { type: 'apiKey' },
      requiresOpenaiAuth: false,
    });
    await checkCodexAuthStatusObserved('settings-status');
    expect(peekProviderAccountIdentity('codex')).toBeNull();
  });
});

describe('peekProviderBillingAccountKind', () => {
  it('reads unknown before any auth status has been observed', () => {
    expect(peekProviderBillingAccountKind('claude')).toBe('unknown');
    expect(peekProviderBillingAccountKind('codex')).toBe('unknown');
  });

  it('reads the cached subscription kind after an observed status', async () => {
    await checkCodexAuthStatusObserved('settings-status');
    expect(peekProviderBillingAccountKind('codex')).toBe('subscription');
  });

  it('reads an API key login without probing the provider again', async () => {
    mockCodexReadAccount.mockResolvedValueOnce({
      account: { type: 'apiKey' },
      requiresOpenaiAuth: false,
    });
    await checkCodexAuthStatusObserved('settings-status');
    const probesBefore = mockCodexReadAccount.mock.calls.length;

    expect(peekProviderBillingAccountKind('codex')).toBe('api_key');
    expect(mockCodexReadAccount.mock.calls.length).toBe(probesBefore);
  });
});

describe('shouldPrewarmCodexNativeAuthAtStartup', () => {
  it('stays lazy for a first-ever launch with no recorded lane', () => {
    expect(shouldPrewarmCodexNativeAuthAtStartup({})).toBe(false);
  });

  it.each(['claude-native', 'ai-credits', 'ollama'] as const)(
    'stays lazy for a %s user',
    (lane) => {
      expect(
        shouldPrewarmCodexNativeAuthAtStartup({
          lastResolvedDefaultLaneByScope: { chat: lane, worktree: lane },
        }),
      ).toBe(false);
    },
  );

  it('warms when either scope last resolved to the Codex lane', () => {
    expect(
      shouldPrewarmCodexNativeAuthAtStartup({
        lastResolvedDefaultLaneByScope: {
          chat: 'claude-native',
          worktree: 'codex-native',
        },
      }),
    ).toBe(true);
    expect(
      shouldPrewarmCodexNativeAuthAtStartup({
        lastResolvedDefaultLaneByScope: { chat: 'codex-native' },
      }),
    ).toBe(true);
  });

  it('honors the legacy scope-agnostic lane', () => {
    expect(
      shouldPrewarmCodexNativeAuthAtStartup({
        lastResolvedDefaultLane: 'codex-native',
      }),
    ).toBe(true);
  });
});

describe('Portal Cursor runtime availability projection', () => {
  it('omits the cursor key until the runtime preflight has run once', () => {
    expect(peekPortalProviderAvailability()).not.toHaveProperty('cursor');
  });

  it.each([true, false])(
    'projects the cached runtime availability %s on the portal peek only',
    (available) => {
      mockCursorRuntimeAvailability = available;
      expect(peekPortalProviderAvailability()).toMatchObject({
        ollama: true,
        cursor: available,
      });
      // The native peeks are read by provider-keyed billing code that treats
      // `false` as a confirmed logout, and by the App Advisor and Cowork
      // projections, whose pickers must never advertise Cursor.
      expect(peekProviderNativeAuthAvailability()).not.toHaveProperty('cursor');
      expect(peekFreshProviderNativeAuthAvailability()).not.toHaveProperty(
        'cursor',
      );
    },
  );
});

describe('subscribeConfirmedProviderAuth', () => {
  const confirmed = (
    provider: 'claude' | 'codex',
    account: string | null,
    reason: string,
  ): Promise<void> =>
    observeProviderAuthStatus(
      {
        provider,
        status: status(account !== null, account, 'max'),
        confidence: 'confirmed',
        fingerprint: null,
      },
      reason,
    );

  it('tells listeners when a provider is first confirmed signed in', async () => {
    const events: ConfirmedProviderAuthEvent[] = [];
    const unsubscribe = subscribeConfirmedProviderAuth((event) => {
      events.push(event);
    });
    try {
      await confirmed('claude', 'a@example.com', 'seed');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        provider: 'claude',
        fingerprint: 'auth:unknown:a@example.com',
        status: { authenticated: true, accountLabel: 'a@example.com' },
      });
    } finally {
      unsubscribe();
    }
  });

  it('stays quiet for a signed-out or inconclusive observation', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeConfirmedProviderAuth(listener);
    try {
      await confirmed('claude', null, 'signed-out');
      await observeProviderAuthStatus(
        {
          provider: 'codex',
          status: status(true, 'c@example.com', 'plus'),
          confidence: 'unknown',
          fingerprint: null,
        },
        'inconclusive',
      );
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('does not repeat an unchanged account', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeConfirmedProviderAuth(listener);
    try {
      await confirmed('claude', 'a@example.com', 'seed');
      await confirmed('claude', 'a@example.com', 'again');
      await confirmed('claude', 'a@example.com', 'and-again');
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('tells listeners once a changed account is confirmed, not on its first sighting', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeConfirmedProviderAuth(listener);
    try {
      await confirmed('claude', 'a@example.com', 'seed');
      await confirmed('claude', 'b@example.com', 'changed-first-observation');
      expect(listener).toHaveBeenCalledTimes(1);
      await confirmed('claude', 'b@example.com', 'changed-confirmed');
      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          provider: 'claude',
          fingerprint: 'auth:unknown:b@example.com',
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  it('tells listeners right away on an explicit sign-in', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeConfirmedProviderAuth(listener);
    try {
      await confirmed('claude', 'a@example.com', 'seed');
      await observeProviderAuthStatus(
        {
          provider: 'claude',
          status: status(true, 'b@example.com', 'max'),
          confidence: 'confirmed',
          fingerprint: null,
          forceInvalidation: true,
        },
        'login-modal',
      );
      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          provider: 'claude',
          fingerprint: 'auth:unknown:b@example.com',
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  it('tells listeners when a managed Codex sign-in is accepted', async () => {
    const events: ConfirmedProviderAuthEvent[] = [];
    const unsubscribe = subscribeConfirmedProviderAuth((event) => {
      events.push(event);
    });
    try {
      await acceptVerifiedCodexAccount({
        account: {
          type: 'chatgpt',
          email: 'codex@example.com',
          planType: 'pro',
        },
        requiresOpenaiAuth: true,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        provider: 'codex',
        status: { authenticated: true },
      });
      expect(events[0].fingerprint).toMatch(/^auth:/);
    } finally {
      unsubscribe();
    }
  });

  it('keeps observing when a listener throws', async () => {
    const broken = jest.fn(() => {
      throw new Error('listener exploded');
    });
    const healthy = jest.fn();
    const unsubscribeBroken = subscribeConfirmedProviderAuth(broken);
    const unsubscribeHealthy = subscribeConfirmedProviderAuth(healthy);
    try {
      await expect(
        confirmed('claude', 'a@example.com', 'seed'),
      ).resolves.toBeUndefined();
      expect(healthy).toHaveBeenCalledTimes(1);
      expect(mockLogMainProcessWarn).toHaveBeenCalledWith(
        expect.stringContaining('provider-auth: listener failed'),
        expect.anything(),
      );
    } finally {
      unsubscribeBroken();
      unsubscribeHealthy();
    }
  });

  it('stops telling a listener after it unsubscribes', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeConfirmedProviderAuth(listener);
    unsubscribe();
    await confirmed('claude', 'a@example.com', 'seed');
    expect(listener).not.toHaveBeenCalled();
  });

  // The startup prewarm can confirm an account before anything subscribes;
  // a late subscriber still hears about it, once, and not again on repeats.
  it('replays each provider already confirmed signed in to a listener that subscribes later', async () => {
    await confirmed('claude', 'a@example.com', 'prewarm');
    await confirmed('codex', 'c@example.com', 'prewarm');
    const events: ConfirmedProviderAuthEvent[] = [];
    const unsubscribe = subscribeConfirmedProviderAuth((event) => {
      events.push(event);
    });
    try {
      expect(events.map((event) => event.fingerprint)).toEqual([
        'auth:unknown:a@example.com',
        'auth:unknown:c@example.com',
      ]);
      await confirmed('claude', 'a@example.com', 'poll');
      expect(events).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });

  it('does not replay a provider whose last confirmed status is signed out', async () => {
    await confirmed('claude', 'a@example.com', 'seed');
    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: status(false, null, null),
        confidence: 'confirmed',
        fingerprint: null,
        forceInvalidation: true,
      },
      'sign-out',
    );
    const listener = jest.fn();
    const unsubscribe = subscribeConfirmedProviderAuth(listener);
    try {
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  describe('connectSource', () => {
    const forcedSignIn = (
      provider: 'claude' | 'codex',
      account: string,
    ): Promise<void> =>
      observeProviderAuthStatus(
        {
          provider,
          status: status(true, account, 'max'),
          confidence: 'confirmed',
          fingerprint: null,
          forceInvalidation: true,
        },
        'auth-terminal-exit',
      );

    it('reports the first confirmed sign-in this launch as at_startup', async () => {
      const events: ConfirmedProviderAuthEvent[] = [];
      const unsubscribe = subscribeConfirmedProviderAuth((event) => {
        events.push(event);
      });
      try {
        await confirmed('claude', 'a@example.com', 'native-auth-prewarm');
        await confirmed('codex', 'c@example.com', 'native-auth-prewarm');
        expect(events.map((event) => event.connectSource)).toEqual([
          'at_startup',
          'at_startup',
        ]);
      } finally {
        unsubscribe();
      }
    });

    it('reports a sign-in through the app as in_app, even as the first check', async () => {
      const events: ConfirmedProviderAuthEvent[] = [];
      const unsubscribe = subscribeConfirmedProviderAuth((event) => {
        events.push(event);
      });
      try {
        await forcedSignIn('claude', 'a@example.com');
        await confirmed('codex', null, 'native-auth-prewarm');
        await forcedSignIn('codex', 'c@example.com');
        expect(
          events.map(({ provider, connectSource }) => ({
            provider,
            connectSource,
          })),
        ).toEqual([
          { provider: 'claude', connectSource: 'in_app' },
          { provider: 'codex', connectSource: 'in_app' },
        ]);
      } finally {
        unsubscribe();
      }
    });

    // A new Codex user has no startup check, so the auth terminal's sign-in
    // is the first confirmed Codex observation of the launch.
    it('reports a Codex auth-terminal sign-in as in_app when it is the first check', async () => {
      const events: ConfirmedProviderAuthEvent[] = [];
      const unsubscribe = subscribeConfirmedProviderAuth((event) => {
        events.push(event);
      });
      try {
        await checkCodexAuthStatusObserved('auth-terminal-exit', {
          forceAuthenticatedInvalidation: true,
          prepareExplicitTransitionBeforeProbe: true,
        });
        expect(
          events.map(({ provider, connectSource }) => ({
            provider,
            connectSource,
          })),
        ).toEqual([{ provider: 'codex', connectSource: 'in_app' }]);
      } finally {
        unsubscribe();
      }
    });

    it('reports a managed Codex sign-in as in_app', async () => {
      const events: ConfirmedProviderAuthEvent[] = [];
      const unsubscribe = subscribeConfirmedProviderAuth((event) => {
        events.push(event);
      });
      try {
        await acceptVerifiedCodexAccount({
          account: {
            type: 'chatgpt',
            email: 'codex@example.com',
            planType: 'pro',
          },
          requiresOpenaiAuth: true,
        });
        expect(events.map((event) => event.connectSource)).toEqual(['in_app']);
      } finally {
        unsubscribe();
      }
    });

    it('reports a confirmed change made outside the app as external_change', async () => {
      const events: ConfirmedProviderAuthEvent[] = [];
      const unsubscribe = subscribeConfirmedProviderAuth((event) => {
        events.push(event);
      });
      try {
        await confirmed('claude', null, 'native-auth-prewarm');
        await confirmed('claude', 'a@example.com', 'poll');
        await confirmed('claude', 'a@example.com', 'poll-confirmed');
        await confirmed('claude', 'b@example.com', 'poll');
        await confirmed('claude', 'b@example.com', 'poll-confirmed');
        await confirmed('claude', 'b@example.com', 'poll-repeat');
        expect(events.map((event) => event.connectSource)).toEqual([
          'external_change',
          'external_change',
        ]);
      } finally {
        unsubscribe();
      }
    });

    it('replays a startup confirmation with its original connectSource', async () => {
      await confirmed('claude', 'a@example.com', 'native-auth-prewarm');
      const events: ConfirmedProviderAuthEvent[] = [];
      const unsubscribe = subscribeConfirmedProviderAuth((event) => {
        events.push(event);
      });
      try {
        expect(events.map((event) => event.connectSource)).toEqual([
          'at_startup',
        ]);
      } finally {
        unsubscribe();
      }
    });
  });

  it('logs a listener that throws during replay and still returns its unsubscribe', async () => {
    await confirmed('claude', 'a@example.com', 'seed');
    const unsubscribe = subscribeConfirmedProviderAuth(() => {
      throw new Error('replay boom');
    });
    try {
      expect(mockLogMainProcessWarn).toHaveBeenCalledWith(
        'provider-auth: listener failed for claude sign-in',
        'replay boom',
      );
    } finally {
      unsubscribe();
    }
  });
});
