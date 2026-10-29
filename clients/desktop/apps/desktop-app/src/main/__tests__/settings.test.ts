import type {
  AgentProviderAuthStatus,
  CanopyServerStatus,
  GitHubCliStatus,
  LinearTicketSearchResult,
  SecureStorageFailure,
} from '@canopy/desktop-shared/types';

jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));
jest.mock('node:fs/promises');
jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): string => 'linux',
}));
jest.mock('electron', () => ({
  app: { isReady: (): boolean => true },
  safeStorage: {
    getSelectedStorageBackend: jest.fn(() => 'gnome_libsecret'),
    isEncryptionAvailable: jest.fn(),
    encryptString: jest.fn(),
    decryptString: jest.fn(),
  },
}));
jest.mock('../lib/atomic-file', () => ({
  writeFileAtomically: jest.fn(),
  renameWithRetry: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getCanopyCloudAccountFilePath: jest.fn(
    () => '/mock/userData/canopy-cloud-account.enc',
  ),
  getLegacyCanopyCloudAccountFilePath: jest.fn(
    () => '/mock/userData/secure/canopy-cloud-account.enc',
  ),
  getInternalLegacySharedCanopyCloudAccountFilePath: jest.fn(() => null),
  getGitHubPatFilePath: jest.fn(() => '/mock/userData/github-pat.enc'),
  getInternalLegacySharedGitHubPatFilePath: jest.fn(() => null),
  getLegacyGitHubPatFilePath: jest.fn(
    () => '/mock/userData/secure/github-pat.enc',
  ),
  getLinearTokenFilePath: jest.fn(() => '/mock/userData/linear-token.enc'),
  getInternalLegacySharedLinearTokenFilePath: jest.fn(() => null),
  getLegacyLinearTokenFilePath: jest.fn(
    () => '/mock/userData/secure/linear-token.enc',
  ),
  getPreferencesFilePath: jest.fn(() => '/mock/userData/preferences.json'),
}));
const mockPurgeSharedContainerReplicas = jest.fn(() => Promise.resolve());
const mockReconcileSharedContainerOrganizationSnapshot = jest.fn(
  async (
    _organizationIds: readonly string[],
    afterCleanup?: () => Promise<unknown>,
  ): Promise<unknown> => afterCleanup?.(),
);
const mockWithSharedContainerReplicaPurgeFence = jest.fn(
  async (operation: () => Promise<unknown>): Promise<unknown> => {
    await mockPurgeSharedContainerReplicas();
    return operation();
  },
);
jest.mock('../shared-containers/reconciliation-service', () => ({
  getSharedContainerReconciliationService: (): {
    purgeAll: () => Promise<void>;
    withReplicaPurgeFence: (
      operation: () => Promise<unknown>,
    ) => Promise<unknown>;
    reconcileOrganizationSnapshot: (
      organizationIds: readonly string[],
      afterCleanup?: () => Promise<unknown>,
    ) => Promise<unknown>;
  } => ({
    purgeAll: mockPurgeSharedContainerReplicas,
    withReplicaPurgeFence: mockWithSharedContainerReplicaPurgeFence,
    reconcileOrganizationSnapshot:
      mockReconcileSharedContainerOrganizationSnapshot,
  }),
}));
jest.mock('../canopy-cloud/config', () => ({
  CanopyCloudConfigError: class CanopyCloudConfigError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'CanopyCloudConfigError';
    }
  },
  getCanopyCloudBaseUrl: jest.fn(() => 'https://cloud.example.test'),
}));
const mockRevokeCurrentOAuthDesktopKey = jest.fn();
const mockRequestCanopyCloudJson = jest.fn();
const mockResolveAiCreditsScopeOwner = jest.fn<Promise<undefined>, [unknown]>();
jest.mock('../agents/work-owner', () => ({
  resolveAiCreditsScopeOwner: (scope: unknown): Promise<undefined> =>
    mockResolveAiCreditsScopeOwner(scope),
}));
class mockCanopyCloudClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(status === undefined ? message : `HTTP ${status}: ${message}`);
    this.name = 'CanopyCloudClientError';
  }
}
jest.mock('../canopy-cloud/client', () => ({
  CanopyCloudClientError: mockCanopyCloudClientError,
  requestCanopyCloudJson: mockRequestCanopyCloudJson,
  revokeCurrentOAuthDesktopKey: mockRevokeCurrentOAuthDesktopKey,
}));
const mockStartCanopyCloudOAuthLogin = jest.fn();
const mockCancelCanopyCloudOAuthLogin = jest.fn();
jest.mock('../canopy-cloud/oauth-login', () => ({
  startCanopyCloudOAuthLogin: mockStartCanopyCloudOAuthLogin,
  cancelCanopyCloudOAuthLogin: mockCancelCanopyCloudOAuthLogin,
}));
const mockRebindLedgerGuestScopes = jest.fn<Promise<void>, [string, string]>(
  () => Promise.resolve(),
);
jest.mock('../ledger/sync-host', () => ({
  rebindLedgerGuestScopes: mockRebindLedgerGuestScopes,
}));
interface LinearAuthModule {
  invalidateLinearTokenCache: () => void;
  resolveLinearToken: () => Promise<string>;
}
const mockInvalidateLinearTokenCache = jest.fn();
jest.mock('../lib/linear-auth', () => {
  const actual = jest.requireActual<LinearAuthModule>('../lib/linear-auth');
  return {
    ...actual,
    invalidateLinearTokenCache: (): void => {
      actual.invalidateLinearTokenCache();
      mockInvalidateLinearTokenCache();
    },
  };
});
const mockResolveGitHubToken = jest
  .fn<Promise<string>, []>()
  .mockResolvedValue('');
const mockResumeAfterGitHub = jest.fn().mockResolvedValue([]);
jest.mock('../lib/auth-failure-resume', () => ({
  resumeChatsAfterGitHubLogin: mockResumeAfterGitHub,
}));
const mockInvalidateTokenCache = jest.fn();
interface GitHubAuthModule {
  invalidateTokenCache: () => void;
  loadStoredPat: () => Promise<string>;
}
jest.mock('../lib/github-auth', () => {
  const actual = jest.requireActual<GitHubAuthModule>('../lib/github-auth');
  return {
    ...actual,
    resolveGitHubToken: mockResolveGitHubToken,
    invalidateTokenCache: (): void => {
      actual.invalidateTokenCache();
      mockInvalidateTokenCache();
    },
  };
});
const mockInitializeGitHubPatEnvRuntime = jest.fn();
const mockInvalidateGitHubPatEnvCache = jest.fn();
jest.mock('../lib/github-pat-env', () => ({
  initializeGitHubPatEnvRuntime: mockInitializeGitHubPatEnvRuntime,
  invalidateGitHubPatEnvCache: mockInvalidateGitHubPatEnvCache,
}));
const mockResetGitHubBrokerCredentials = jest.fn();
jest.mock('../lib/github-broker', () => ({
  getGitHubBroker: jest.fn(() => ({
    resetCredentials: mockResetGitHubBrokerCredentials,
  })),
}));
const mockInvalidateGitHubRepoListCache = jest.fn();
jest.mock('../lib/github-repo-listing', () => ({
  invalidateGitHubRepoListCache: mockInvalidateGitHubRepoListCache,
}));
const mockSummarizeProviderCarryover = jest.fn<Promise<unknown>, [unknown]>();
jest.mock('../plugins/provider-carryover', () => ({
  summarizeProviderCarryover: (provider: unknown): Promise<unknown> =>
    mockSummarizeProviderCarryover(provider),
}));
const mockInvalidatePullRequestListingCache = jest.fn();
jest.mock('../lib/github-pr-listing', () => ({
  invalidatePullRequestListingCache: mockInvalidatePullRequestListingCache,
}));
const mockedGetEnhancedEnv = jest.fn<Record<string, string>, []>(() => ({
  PATH: '/mock/bin',
}));
jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/mock/bin/claude'),
  getBundledCodexBinaryPath: jest.fn(() => '/mock/bin/codex'),
  getBundledGhBinaryPath: jest.fn(() => '/mock/bin/gh'),
  getEnhancedEnv: (): Record<string, string> => mockedGetEnhancedEnv(),
  registerSecretsEnvInjector: jest.fn(),
}));
const mockCodexReadAccount = jest.fn();
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
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    admin: (): { request: typeof mockCodexAdminRequest } => ({
      request: mockCodexAdminRequest,
    }),
  })),
}));
jest.mock('@linear/sdk', () => ({
  LinearClient: jest.fn(),
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));
const mockRefreshFeatureFlagContext = jest.fn().mockResolvedValue(undefined);
const mockIsFeatureEnabled = jest.fn((): boolean => false);
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: jest.fn(() => ({
    refreshContext: mockRefreshFeatureFlagContext,
    isEnabled: mockIsFeatureEnabled,
  })),
}));
const mockGuestMintBarrierRelease = jest.fn();
const mockPauseGuestMintsForRealSignIn = jest.fn(() => ({
  activeGuestMint: null as Promise<unknown> | null,
  release: mockGuestMintBarrierRelease,
}));
const mockRequestGuestLinkTicket = jest.fn();
jest.mock('../canopy-cloud/guest-auth', () => ({
  mintGuest: jest.fn(),
  pauseGuestMintsForRealSignIn: mockPauseGuestMintsForRealSignIn,
  requestGuestLinkTicket: mockRequestGuestLinkTicket,
}));
const mockProbeMobileActivation = jest.fn();
const mockInvalidateMobileActivationCache = jest.fn();
jest.mock('../canopy-cloud/mobile-activation', () => ({
  probeMobileActivation: mockProbeMobileActivation,
  invalidateMobileActivationCache: mockInvalidateMobileActivationCache,
}));
const mockApplyEnforcedSettings = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/org-enforced-settings', () => ({
  applyEnforcedSettings: mockApplyEnforcedSettings,
}));
const mockInvalidateProviderAuthSessions = jest.fn<Promise<void>, unknown[]>();
jest.mock('../agents/session-manager', () => ({
  invalidateProviderAuthSessions: (...args: unknown[]): Promise<void> =>
    mockInvalidateProviderAuthSessions(...args),
}));
// A failing auth probe fires a fire-and-forget diagnostic through the real
// observability service (which schedules a debounced flush timer) and
// electron-log. Left unmocked, that timer and the async log writes outlive this
// test file and bleed into whichever suite the worker runs next, surfacing as a
// flaky, empty-bodied failure there. Stub both so probe-failure diagnostics
// stay inert, matching provider-auth-state.test.ts.
const mockRecordAppDiagnostic = jest.fn();
interface SavedGatewayCredential {
  organizationId: string;
  apiKey: string;
  baseUrlAtSave: string;
  lastValidatedAt?: string;
  lastError?: string;
}

const mockSaveModelGatewayCredential = jest.fn<
  Promise<void>,
  [SavedGatewayCredential]
>();
const mockLoadModelGatewayCredential = jest.fn<Promise<null>, [string]>();
const mockIsModelGatewayCredentialStorageAvailable = jest.fn(() => true);
class MockGatewayCredentialStorageUnavailableError extends Error {}

jest.mock('../lib/model-gateway-credential-store', () => ({
  GatewayCredentialStorageUnavailableError:
    MockGatewayCredentialStorageUnavailableError,
  loadModelGatewayCredential: (organizationId: string): Promise<null> =>
    mockLoadModelGatewayCredential(organizationId),
  saveModelGatewayCredential: (input: SavedGatewayCredential): Promise<void> =>
    mockSaveModelGatewayCredential(input),
  isModelGatewayCredentialStorageAvailable: (): boolean =>
    mockIsModelGatewayCredentialStorageAvailable(),
}));

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: mockRecordAppDiagnostic,
  })),
}));
jest.mock('electron-log/main.js', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { safeStorage } from 'electron';
import { registerIpcHandler } from '../ipc/register';
import { getCanopyCloudBaseUrl } from '../canopy-cloud/config';
import {
  invalidateCanopyCloudAccountCache,
  subscribeCanopyCloudAccountChanges,
  subscribeCanopyCloudAccountConfirmations,
} from '../lib/canopy-cloud-account-store';
import { invalidateLinearTokenCache } from '../lib/linear-auth';
import { renameWithRetry, writeFileAtomically } from '../lib/atomic-file';
import { mintGuest } from '../canopy-cloud/guest-auth';
import {
  checkGitHubCliStatus,
  loadCanopyCloudAiCredits,
  loadNativeAiCreditsAvailability,
  loadOrgAiCreditsSpendable,
  registerSettingsHandlers,
  reprobeAndApplyCanopyCloudEnforcedSettings,
} from '../ipc/settings';
import {
  getUnstoppableDomainsAiCreditsManageUrl,
  getUnstoppableDomainsAiCreditsPurchaseUrl,
} from '../unstoppable-domains/config';
import {
  buildClaudeAuthStatusFromPayload,
  checkClaudeAuthStatusObserved as checkClaudeAuthStatus,
  checkCodexAuthStatusObserved as checkCodexAuthStatus,
  resetProviderAuthStateForTests,
} from '../auth/provider-auth-state';

const mockedExecFile = jest.mocked(execFile);
const mockedReadFile = jest.mocked(readFile);
const mockedWriteFile = jest.mocked(writeFile);
const mockedMkdir = jest.mocked(mkdir);
const mockedRm = jest.mocked(rm);
const mockedAccess = jest.mocked(access);
const mockedRename = jest.mocked(rename);
const mockedWriteFileAtomically = jest.mocked(writeFileAtomically);
const mockedMintGuest = jest.mocked(mintGuest);
// A minimal valid guest-mint result for the disconnect→guest-fallback tests.
// Typed off the real `mintGuest` return so it stays correct without casts.
const GUEST_MINT_RESULT: Awaited<ReturnType<typeof mintGuest>> = {
  status: {
    authenticated: true,
    capabilities: ['account-v1'],
    missingCapabilities: [],
    account: {
      id: 'guest-account-1',
      name: 'Guest',
      email: 'guest@example.test',
      role: 'ADMIN',
    },
    organizations: [],
    teams: [],
    error: null,
  },
  account: {
    hasApiKey: true,
    authMode: 'guest',
    credentialSource: 'guest',
    serverApiKeyId: 'guest-key-1',
    capabilities: ['account-v1'],
    storageAvailable: true,
  },
};

/* eslint-disable @typescript-eslint/unbound-method */
const mockedIsEncryptionAvailable = jest.mocked(
  safeStorage.isEncryptionAvailable,
);
const mockedBackend = jest.mocked(safeStorage.getSelectedStorageBackend);
const mockedEncryptString = jest.mocked(safeStorage.encryptString);
const mockedDecryptString = jest.mocked(safeStorage.decryptString);
/* eslint-enable @typescript-eslint/unbound-method */
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedGetCanopyCloudBaseUrl = jest.mocked(getCanopyCloudBaseUrl);

const originalFetch = global.fetch;
const mockedFetch: jest.MockedFunction<typeof fetch> = jest.fn();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function missingFileError(): Error & { code: 'ENOENT' } {
  return Object.assign(new Error('missing'), { code: 'ENOENT' as const });
}

function errnoError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function getLinearClientMock(): jest.Mock {
  const linearSdkModule: unknown = jest.requireMock('@linear/sdk');
  if (
    !isRecord(linearSdkModule) ||
    !jest.isMockFunction(linearSdkModule.LinearClient)
  ) {
    throw new Error('Expected @linear/sdk LinearClient mock');
  }

  return linearSdkModule.LinearClient;
}

const mockedLinearClient = getLinearClientMock();

type ExecFileCallback = (
  error: Error | null,
  result: { stdout: string; stderr: string },
) => void;

type HandlerFn = (...args: unknown[]) => Promise<unknown>;
type HandlerRegistration = [channel: string, handler: HandlerFn];

let ghStatusHandler: HandlerFn;
let claudeStatusHandler: HandlerFn;
let codexStatusHandler: HandlerFn;
let loadPatHandler: HandlerFn;
let savePatHandler: HandlerFn;
let refreshGitHubCredentialsHandler: HandlerFn;
let loadLinearHandler: HandlerFn;
let saveLinearHandler: HandlerFn;
let validateLinearHandler: HandlerFn;
let loadCanopyCloudAccountHandler: HandlerFn;
let loadCanopyCloudAiCreditsHandler: HandlerFn;
let loadCanopyCloudMobileActivationHandler: HandlerFn;
let loadCanopyCloudApiKeyHandler: HandlerFn;
let saveCanopyCloudApiKeyHandler: HandlerFn;
let clearCanopyCloudApiKeyHandler: HandlerFn;
let startCanopyCloudOAuthLoginHandler: HandlerFn;
let cancelCanopyCloudOAuthLoginHandler: HandlerFn;
let disconnectCanopyCloudAccountHandler: HandlerFn;
let resetUnreadableCanopyCloudAccountHandler: HandlerFn;
let validateCanopyCloudApiKeyHandler: HandlerFn;
let searchLinearHandler: HandlerFn;
let loadModelGatewayCredentialHandler: HandlerFn;
let saveModelGatewayCredentialHandler: HandlerFn;

function isHandlerRegistration(
  value: ReadonlyArray<unknown>,
  channel: string,
): value is HandlerRegistration {
  return value[0] === channel && typeof value[1] === 'function';
}

function getRegisteredHandler(
  calls: ReadonlyArray<ReadonlyArray<unknown>>,
  channel: string,
): HandlerFn {
  const match = calls.find((value) => isHandlerRegistration(value, channel));

  if (match === undefined) {
    throw new Error(`Missing IPC handler registration for ${channel}`);
  }

  return match[1];
}

function mockExecFileResult(
  error: Error | null,
  stdout: string,
  stderr: string,
): void {
  mockedExecFile.mockImplementation(((
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb?: ExecFileCallback,
  ) => {
    cb?.(error, { stdout, stderr });
  }) as typeof execFile);
}

function mockExecFileByCommand(
  handler: (
    cmd: string,
    args: string[],
  ) => { error: Error | null; stdout: string; stderr: string },
): void {
  mockedExecFile.mockImplementation(((
    cmd: string,
    args: string[],
    _opts: unknown,
    cb?: ExecFileCallback,
  ) => {
    const result = handler(cmd, args);
    cb?.(result.error, { stdout: result.stdout, stderr: result.stderr });
  }) as typeof execFile);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveAiCreditsScopeOwner.mockResolvedValue(undefined);
  resetProviderAuthStateForTests();
  invalidateCanopyCloudAccountCache();
  invalidateLinearTokenCache();
  mockInvalidateLinearTokenCache.mockClear();
  global.fetch = mockedFetch as unknown as typeof fetch;
  mockedGetCanopyCloudBaseUrl.mockReturnValue('https://cloud.example.test');
  mockedIsEncryptionAvailable.mockReturnValue(true);
  mockedBackend.mockReturnValue('gnome_libsecret');
  mockedEncryptString.mockImplementation((text: string) =>
    Buffer.from(text, 'utf8'),
  );
  mockedDecryptString.mockImplementation((encrypted: Buffer) =>
    encrypted.toString('utf8'),
  );
  mockedReadFile.mockRejectedValue(
    Object.assign(new Error('missing'), { code: 'ENOENT' }),
  );
  mockedRm.mockResolvedValue(undefined);
  mockedMkdir.mockResolvedValue(undefined);
  mockedWriteFile.mockResolvedValue(undefined);
  mockedWriteFileAtomically.mockImplementation(
    async (targetPath, data, options): Promise<void> => {
      if (options?.encoding) {
        await writeFile(targetPath, data, options.encoding);
      } else {
        await writeFile(targetPath, data);
      }
    },
  );
  mockedAccess.mockRejectedValue(missingFileError());
  mockedRename.mockResolvedValue(undefined);
  // Guest-mode fallback on disconnect is opt-in per test: default the flag off
  // and clear the mint mock so it never leaks a resolved value across tests.
  mockIsFeatureEnabled.mockReturnValue(false);
  mockedMintGuest.mockReset();
  mockGuestMintBarrierRelease.mockReset();
  mockPauseGuestMintsForRealSignIn.mockReturnValue({
    activeGuestMint: null,
    release: mockGuestMintBarrierRelease,
  });
  mockRequestGuestLinkTicket.mockReset();
  mockRequestCanopyCloudJson.mockReset();
  mockProbeMobileActivation.mockResolvedValue({
    resolved: true,
    hasMobileActivation: false,
  });
  mockInvalidateMobileActivationCache.mockReset();
  mockRevokeCurrentOAuthDesktopKey.mockResolvedValue(undefined);
  mockLoadModelGatewayCredential.mockResolvedValue(null);
  mockIsModelGatewayCredentialStorageAvailable.mockReturnValue(true);
  mockInvalidateProviderAuthSessions.mockResolvedValue();
  mockStartCanopyCloudOAuthLogin.mockResolvedValue({
    status: {
      authenticated: true,
      capabilities: ['account-v1'],
      missingCapabilities: [],
      account: {
        id: 'account-1',
        name: 'Cloud Admin',
        email: 'admin@example.test',
        role: 'ADMIN',
      },
      organizations: [],
      teams: [],
      error: null,
    },
    account: {
      hasApiKey: true,
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      serverApiKeyId: 'key-1',
      capabilities: ['account-v1'],
      storageAvailable: true,
    },
  });
  mockCodexReadAccount.mockResolvedValue({
    account: {
      type: 'chatgpt',
      email: 'codex@example.com',
      planType: 'pro',
    },
    requiresOpenaiAuth: true,
  });

  registerSettingsHandlers();

  const calls = mockedRegisterIpcHandler.mock.calls;
  claudeStatusHandler = getRegisteredHandler(
    calls,
    'settings:claude-auth-status',
  );
  codexStatusHandler = getRegisteredHandler(
    calls,
    'settings:codex-auth-status',
  );
  ghStatusHandler = getRegisteredHandler(calls, 'settings:github-cli-status');
  loadPatHandler = getRegisteredHandler(calls, 'settings:load-github-pat');
  savePatHandler = getRegisteredHandler(calls, 'settings:save-github-pat');
  refreshGitHubCredentialsHandler = getRegisteredHandler(
    calls,
    'settings:refresh-github-credentials',
  );
  loadLinearHandler = getRegisteredHandler(calls, 'settings:load-linear-token');
  saveLinearHandler = getRegisteredHandler(calls, 'settings:save-linear-token');
  validateLinearHandler = getRegisteredHandler(
    calls,
    'settings:validate-linear-token',
  );
  searchLinearHandler = getRegisteredHandler(
    calls,
    'settings:search-linear-issues',
  );
  saveModelGatewayCredentialHandler = getRegisteredHandler(
    calls,
    'model-gateway:save-credential',
  );
  loadModelGatewayCredentialHandler = getRegisteredHandler(
    calls,
    'model-gateway:load-credential',
  );
  loadCanopyCloudAccountHandler = getRegisteredHandler(
    calls,
    'settings:load-canopy-cloud-account',
  );
  loadCanopyCloudAiCreditsHandler = getRegisteredHandler(
    calls,
    'settings:load-canopy-cloud-ai-credits',
  );
  loadCanopyCloudMobileActivationHandler = getRegisteredHandler(
    calls,
    'canopy-cloud:mobile-activation-load',
  );
  loadCanopyCloudApiKeyHandler = getRegisteredHandler(
    calls,
    'settings:load-canopy-cloud-api-key',
  );
  saveCanopyCloudApiKeyHandler = getRegisteredHandler(
    calls,
    'settings:save-canopy-cloud-api-key',
  );
  clearCanopyCloudApiKeyHandler = getRegisteredHandler(
    calls,
    'settings:clear-canopy-cloud-api-key',
  );
  startCanopyCloudOAuthLoginHandler = getRegisteredHandler(
    calls,
    'settings:start-canopy-cloud-oauth-login',
  );
  cancelCanopyCloudOAuthLoginHandler = getRegisteredHandler(
    calls,
    'settings:cancel-canopy-cloud-oauth-login',
  );
  disconnectCanopyCloudAccountHandler = getRegisteredHandler(
    calls,
    'settings:disconnect-canopy-cloud-account',
  );
  resetUnreadableCanopyCloudAccountHandler = getRegisteredHandler(
    calls,
    'settings:reset-unreadable-canopy-cloud-account',
  );
  validateCanopyCloudApiKeyHandler = getRegisteredHandler(
    calls,
    'settings:validate-canopy-cloud-api-key',
  );
});

afterAll(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// registerSettingsHandlers
// ---------------------------------------------------------------------------
describe('registerSettingsHandlers', () => {
  it('registers all handlers', () => {
    expect(mockedRegisterIpcHandler).toHaveBeenCalledTimes(39);
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:load-cloud-release-notes',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:provider-carryover',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).not.toHaveBeenCalledWith(
      'telemetry-sharing:notice-consume',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:claude-auth-status',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:load-cloud-digest-preferences',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:save-cloud-digest-preferences',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:load-install-update-email-preference',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:save-install-update-email-preference',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:open-authenticated-portal-page',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:load-native-ai-credits-availability',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:start-canopy-guest-session',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:codex-auth-status',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:github-cli-status',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:github-permissions',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:load-github-pat',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:save-github-pat',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:refresh-github-credentials',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:load-linear-token',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:save-linear-token',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:validate-linear-token',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'model-gateway:load-credential',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'model-gateway:save-credential',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'model-gateway:validate-credential',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:search-linear-issues',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:load-canopy-cloud-account',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:load-canopy-cloud-ai-credits',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:load-canopy-cloud-entitlements',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'canopy-cloud:mobile-activation-load',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:get-canopy-cloud-base-url',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:refresh-canopy-cloud-enforced-settings',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:load-canopy-cloud-api-key',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:save-canopy-cloud-api-key',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:clear-canopy-cloud-api-key',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:start-canopy-cloud-oauth-login',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:cancel-canopy-cloud-oauth-login',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:disconnect-canopy-cloud-account',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:reset-unreadable-canopy-cloud-account',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'settings:validate-canopy-cloud-api-key',
      expect.any(Function),
    );
  });

  it('relays the mobile activation probe through IPC', async () => {
    mockProbeMobileActivation.mockResolvedValue({
      resolved: true,
      hasMobileActivation: true,
    });

    await expect(
      loadCanopyCloudMobileActivationHandler({}, { forceRefresh: true }),
    ).resolves.toEqual({
      resolved: true,
      hasMobileActivation: true,
    });
    expect(mockProbeMobileActivation).toHaveBeenCalledWith({
      forceRefresh: true,
    });
  });
});

// ---------------------------------------------------------------------------
// checkClaudeAuthStatus (exported function)
// ---------------------------------------------------------------------------
describe('checkClaudeAuthStatus', () => {
  it('returns authenticated with account details when Claude succeeds', async () => {
    mockExecFileResult(
      null,
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        email: 'user@example.com',
        subscriptionType: 'max',
      }),
      '',
    );

    const result = await checkClaudeAuthStatus();

    expect(mockedExecFile).toHaveBeenCalledWith(
      '/mock/bin/claude',
      ['auth', 'status', '--json'],
      expect.objectContaining({ env: { PATH: '/mock/bin' } }),
      expect.any(Function),
    );
    expect(result).toEqual({
      authenticated: true,
      accountLabel: 'user@example.com',
      detail: 'claude.ai (max)',
      error: null,
      accountEmail: 'user@example.com',
      planType: 'max',
      accountKind: 'subscription',
    });
  });

  it('returns unauthenticated when Claude reports logged out', async () => {
    mockExecFileResult(null, JSON.stringify({ loggedIn: false }), '');

    const result = await checkClaudeAuthStatus();

    expect(result).toEqual({
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: 'Claude is not authenticated.',
      accountEmail: null,
      planType: null,
      accountKind: 'unknown',
    });
  });
});

// ---------------------------------------------------------------------------
// buildClaudeAuthStatusFromPayload (pure helper extracted for the E2E auth seam)
// ---------------------------------------------------------------------------
describe('buildClaudeAuthStatusFromPayload', () => {
  it('maps an authed payload to account label + detail', () => {
    expect(
      buildClaudeAuthStatusFromPayload({
        loggedIn: true,
        authMethod: 'oauth',
        email: 'tester@example.com',
        subscriptionType: 'max',
      }),
    ).toEqual({
      authenticated: true,
      accountLabel: 'tester@example.com',
      detail: 'oauth (max)',
      error: null,
      accountEmail: 'tester@example.com',
      planType: 'max',
      accountKind: 'subscription',
    });
  });

  it('falls back to orgName and reports the unauthenticated error', () => {
    expect(
      buildClaudeAuthStatusFromPayload({ loggedIn: false, orgName: 'Acme' }),
    ).toEqual({
      authenticated: false,
      accountLabel: 'Acme',
      detail: null,
      error: 'Claude is not authenticated.',
      accountEmail: null,
      planType: null,
      accountKind: 'unknown',
    });
  });
});

// ---------------------------------------------------------------------------
// checkCodexAuthStatus (exported function)
// ---------------------------------------------------------------------------
describe('checkCodexAuthStatus', () => {
  it('returns authenticated with Codex app-server account details', async () => {
    mockExecFileResult(null, 'Logged in using ChatGPT', '');

    const result = await checkCodexAuthStatus();

    expect(mockCodexAdminRequest).toHaveBeenCalledWith('account/read', {
      refreshToken: false,
    });
    expect(mockCodexReadAccount).toHaveBeenCalledWith(false);
    expect(mockedExecFile).not.toHaveBeenCalled();
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

  it('keeps a failed app-server account read unknown without a CLI fallback', async () => {
    mockCodexReadAccount.mockRejectedValueOnce(new Error('app-server failed'));
    mockExecFileResult(null, 'Logged in using ChatGPT', '');

    const result = await checkCodexAuthStatus();

    expect(result).toEqual({
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: 'Could not verify Codex authentication.',
      probeFailed: true,
    });
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('returns a probe-failed unknown when the Codex account read fails', async () => {
    mockCodexReadAccount.mockRejectedValueOnce(new Error('app-server failed'));
    mockExecFileResult(new Error('exit code 1'), '', '');

    const result = await checkCodexAuthStatus();

    // Both probes failed — this is an inconclusive "unknown", not a confirmed
    // logout, so it must carry `probeFailed: true` (and never invalidate). The
    // user-visible message reads as a verification failure, not a signed-out
    // state, which is reserved for a confirmed logout.
    expect(result).toEqual({
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: 'Could not verify Codex authentication.',
      probeFailed: true,
    });
  });
});

// ---------------------------------------------------------------------------
// checkGitHubCliStatus (exported function)
// ---------------------------------------------------------------------------
describe('checkGitHubCliStatus', () => {
  function ghJson(
    entries: Array<{
      active: boolean;
      login: string;
      tokenSource: string;
    }>,
  ): string {
    return JSON.stringify({
      hosts: {
        'github.com': entries.map((e) => ({
          state: 'success',
          active: e.active,
          host: 'github.com',
          login: e.login,
          tokenSource: e.tokenSource,
          gitProtocol: 'https',
        })),
      },
    });
  }

  it('passes --json hosts and surfaces the active keyring login', async () => {
    mockExecFileResult(
      null,
      ghJson([{ active: true, login: 'tirish', tokenSource: 'keyring' }]),
      '',
    );

    const result = await checkGitHubCliStatus();

    expect(mockedExecFile).toHaveBeenCalledWith(
      '/mock/bin/gh',
      ['auth', 'status', '--json', 'hosts'],
      expect.objectContaining({ env: { PATH: '/mock/bin' } }),
      expect.any(Function),
    );
    expect(result).toEqual({
      authenticated: true,
      username: 'tirish',
      error: null,
      tokenSource: 'keyring',
      envOverride: false,
      envOverrideName: null,
      hasCredentialStoreLogin: true,
    });
  });

  it('flags envOverride when the active entry is sourced from GITHUB_TOKEN', async () => {
    mockExecFileResult(
      null,
      ghJson([
        { active: true, login: 'tirish', tokenSource: 'GITHUB_TOKEN' },
        { active: false, login: 'tirish', tokenSource: 'keyring' },
      ]),
      '',
    );

    const result = await checkGitHubCliStatus();

    expect(result).toEqual({
      authenticated: true,
      username: 'tirish',
      error: null,
      tokenSource: 'GITHUB_TOKEN',
      envOverride: true,
      envOverrideName: 'GITHUB_TOKEN',
      hasCredentialStoreLogin: true,
    });
  });

  it('reports envOverride without a credential-store login when only the env entry is present', async () => {
    mockExecFileResult(
      null,
      ghJson([{ active: true, login: 'tirish', tokenSource: 'GH_TOKEN' }]),
      '',
    );

    const result = await checkGitHubCliStatus();

    expect(result.envOverride).toBe(true);
    expect(result.envOverrideName).toBe('GH_TOKEN');
    expect(result.hasCredentialStoreLogin).toBe(false);
  });

  it('returns unauthenticated when the hosts object is empty', async () => {
    mockExecFileResult(null, JSON.stringify({ hosts: {} }), '');

    const result = await checkGitHubCliStatus();

    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('GitHub CLI is not authenticated.');
    expect(result.tokenSource).toBeNull();
    expect(result.envOverride).toBe(false);
  });

  it('returns unauthenticated when gh output is not valid JSON', async () => {
    mockExecFileResult(null, 'not json', '');

    const result = await checkGitHubCliStatus();

    expect(result.authenticated).toBe(false);
    expect(result.error).toContain('Unable to parse');
  });

  it('returns not-installed when gh binary is not found (ENOENT)', async () => {
    const err = new Error('spawn gh ENOENT') as Error & { code: string };
    err.code = 'ENOENT';
    mockExecFileResult(err, '', '');

    const result = await checkGitHubCliStatus();

    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('GitHub CLI (gh) is not installed.');
  });

  it('returns not authenticated for non-ENOENT errors', async () => {
    mockExecFileResult(new Error('exit code 1'), '', '');

    const result = await checkGitHubCliStatus();

    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('GitHub CLI is not authenticated.');
  });
});

// ---------------------------------------------------------------------------
// GitHub CLI status IPC handler
// ---------------------------------------------------------------------------
describe('ghStatusHandler', () => {
  it('delegates to checkGitHubCliStatus', async () => {
    mockExecFileByCommand((cmd) => {
      if (cmd === '/mock/bin/claude') {
        return {
          error: null,
          stdout: JSON.stringify({
            loggedIn: true,
            email: 'claude@example.com',
          }),
          stderr: '',
        };
      }
      if (cmd === '/mock/bin/codex') {
        return { error: null, stdout: 'Logged in using ChatGPT', stderr: '' };
      }
      return {
        error: null,
        stdout: JSON.stringify({
          hosts: {
            'github.com': [
              {
                state: 'success',
                active: true,
                host: 'github.com',
                login: 'bob',
                tokenSource: 'keyring',
                gitProtocol: 'https',
              },
            ],
          },
        }),
        stderr: '',
      };
    });

    const result = (await ghStatusHandler()) as GitHubCliStatus;

    expect(result.authenticated).toBe(true);
    expect(result.username).toBe('bob');
  });

  it('delegates provider auth status handlers', async () => {
    mockExecFileByCommand((cmd) => {
      if (cmd === '/mock/bin/claude') {
        return {
          error: null,
          stdout: JSON.stringify({
            loggedIn: true,
            email: 'claude@example.com',
          }),
          stderr: '',
        };
      }
      if (cmd === '/mock/bin/codex') {
        return { error: null, stdout: 'Logged in using ChatGPT', stderr: '' };
      }
      return {
        error: null,
        stdout: JSON.stringify({
          hosts: {
            'github.com': [
              {
                state: 'success',
                active: true,
                host: 'github.com',
                login: 'bob',
                tokenSource: 'keyring',
                gitProtocol: 'https',
              },
            ],
          },
        }),
        stderr: '',
      };
    });

    const claude = (await claudeStatusHandler()) as AgentProviderAuthStatus;
    const codex = (await codexStatusHandler()) as AgentProviderAuthStatus;

    expect(claude.authenticated).toBe(true);
    expect(claude.accountLabel).toBe('claude@example.com');
    expect(codex.authenticated).toBe(true);
    expect(codex.accountLabel).toBe('codex@example.com');
    // An authenticated status is never annotated — the flag exists only to
    // rescue a probe-visible logout.
    expect(claude.userSuppliedCredential).toBeUndefined();
  });

  it('flags an Environments-supplied credential on a signed-out status (round-3 finding 1b)', async () => {
    // The probe runs with the Environments injector disabled, so this user
    // reads as signed out. Main already ORs the fact into lane availability;
    // shipping it to the renderer is what stops the two disagreeing.
    mockedGetEnhancedEnv.mockReturnValue({
      PATH: '/mock/bin',
      ANTHROPIC_API_KEY: 'sk-ant-from-environment',
    });
    mockExecFileByCommand((cmd) => {
      if (cmd === '/mock/bin/claude') {
        return {
          error: null,
          stdout: JSON.stringify({ loggedIn: false }),
          stderr: '',
        };
      }
      return { error: null, stdout: '', stderr: '' };
    });

    const claude = (await claudeStatusHandler({
      forceRefresh: true,
    })) as AgentProviderAuthStatus;

    expect(claude.authenticated).toBe(false);
    expect(claude.userSuppliedCredential).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadGitHubPat IPC handler
// ---------------------------------------------------------------------------
describe('loadPatHandler', () => {
  it('preserves metadata when stored credentials cannot be read', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('retained-ciphertext'));
    mockedIsEncryptionAvailable.mockReturnValue(false);

    const result = await loadPatHandler();

    expect(result).toMatchObject({
      success: false,
      secureStorageFailure: {
        code: 'SECURE_STORAGE_READ_UNAVAILABLE',
        state: 'locked',
      },
    });
    expect(mockedDecryptString).not.toHaveBeenCalled();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('reads and decrypts the PAT file', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    const encrypted = Buffer.from('encrypted-data');
    mockedReadFile.mockResolvedValue(encrypted);
    mockedDecryptString.mockReturnValue('ghp_mytoken');

    const result = await loadPatHandler();

    expect(result).toBe('ghp_mytoken');
    expect(mockedReadFile).toHaveBeenCalledWith(
      '/mock/userData/github-pat.enc',
    );
    expect(mockedDecryptString).toHaveBeenCalledWith(encrypted);
  });

  it('returns empty string when PAT file does not exist', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockedReadFile.mockRejectedValue(missingFileError());

    const result = await loadPatHandler();

    expect(result).toBe('');
  });

  it('falls back to the legacy PAT file only when the secure file is missing', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    const legacyEncrypted = Buffer.from('legacy-encrypted');
    mockedReadFile
      .mockRejectedValueOnce(missingFileError())
      .mockResolvedValueOnce(legacyEncrypted);
    mockedDecryptString.mockReturnValue('ghp_legacy');

    const result = await loadPatHandler();

    expect(result).toBe('ghp_legacy');
    expect(mockedReadFile).toHaveBeenNthCalledWith(
      1,
      '/mock/userData/github-pat.enc',
    );
    expect(mockedReadFile).toHaveBeenNthCalledWith(
      2,
      '/mock/userData/secure/github-pat.enc',
    );
  });

  it('does not fall back to the legacy PAT file when the secure file has a real read error', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockedReadFile.mockRejectedValueOnce(errnoError('EACCES'));

    const result = await loadPatHandler();

    expect(result).toEqual({
      success: false,
      error: "Couldn't read saved credentials.",
    });
    expect(mockedReadFile).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// saveGitHubPat IPC handler
// ---------------------------------------------------------------------------
describe('savePatHandler', () => {
  it('does not report successful deletion after filesystem refusal', async () => {
    mockedRm.mockRejectedValueOnce(errnoError('EACCES'));
    await expect(savePatHandler({}, '')).resolves.toEqual({
      success: false,
      error: "Couldn't save credentials.",
    });
    expect(mockInvalidateGitHubPatEnvCache).not.toHaveBeenCalled();
  });

  it('retains the canonical PAT when legacy deletion is refused', async () => {
    mockedRm.mockImplementation((path) => {
      if (path === '/mock/userData/secure/github-pat.enc') {
        return Promise.reject(errnoError('EACCES'));
      }
      return Promise.resolve();
    });

    await expect(savePatHandler({}, '')).resolves.toEqual({
      success: false,
      error: "Couldn't save credentials.",
    });
    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/userData/secure/github-pat.enc',
      { force: true },
    );
    expect(mockedRm).not.toHaveBeenCalledWith('/mock/userData/github-pat.enc');
    expect(mockInvalidateGitHubPatEnvCache).not.toHaveBeenCalled();
  });
  it.each(['gnome_libsecret', 'unknown'] as const)(
    'refuses %s without native encryption or file changes',
    async (backend) => {
      mockedBackend.mockReturnValue(backend);
      mockedIsEncryptionAvailable.mockReturnValue(false);
      await expect(savePatHandler({}, 'ghp_retained')).resolves.toMatchObject({
        success: false,
        secureStorageFailure: {
          code: 'SECURE_STORAGE_WRITE_REFUSED',
          state: backend === 'gnome_libsecret' ? 'locked' : 'unavailable',
          retryable: true,
        },
      });
      expect(mockedEncryptString).not.toHaveBeenCalled();
      expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
      expect(mockedRm).not.toHaveBeenCalled();
    },
  );

  it('rechecks write permission after asynchronous directory preparation', async () => {
    mockedMkdir.mockImplementationOnce(() => {
      mockedIsEncryptionAvailable.mockReturnValue(false);
      return Promise.resolve(undefined);
    });
    await expect(savePatHandler({}, 'ghp_retained')).resolves.toMatchObject({
      success: false,
      secureStorageFailure: { code: 'SECURE_STORAGE_WRITE_REFUSED' },
    });
    expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('retains existing files after native encryption failure', async () => {
    mockedEncryptString.mockImplementationOnce(() => {
      throw new Error('native token diagnostic');
    });
    await expect(savePatHandler({}, 'ghp_retained')).resolves.toMatchObject({
      success: false,
      secureStorageFailure: { code: 'SECURE_STORAGE_ENCRYPT_FAILED' },
    });
    expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('removes the file when token is empty', async () => {
    mockedRm.mockResolvedValue(undefined);

    await savePatHandler({}, '');

    expect(mockedRm).toHaveBeenCalledWith('/mock/userData/github-pat.enc');
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('does not throw when removing a non-existent file for empty token', async () => {
    mockedRm.mockRejectedValue(errnoError('ENOENT'));

    await expect(savePatHandler({}, '')).resolves.toEqual({ success: true });
  });

  it('rejects unavailable saves without deleting credentials or invalidating caches', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(false);

    await expect(savePatHandler({}, 'ghp_token')).resolves.toMatchObject({
      success: false,
      secureStorageFailure: { code: 'SECURE_STORAGE_WRITE_REFUSED' },
    });
    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockInvalidateTokenCache).not.toHaveBeenCalled();
    expect(mockInvalidateGitHubPatEnvCache).not.toHaveBeenCalled();

    expect(mockedEncryptString).not.toHaveBeenCalled();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('encrypts and writes the PAT when encryption is available', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    const encrypted = Buffer.from('encrypted');
    mockedEncryptString.mockReturnValue(encrypted);
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await savePatHandler({}, 'ghp_mytoken');

    expect(mockedEncryptString).toHaveBeenCalledWith('ghp_mytoken');
    expect(mockedMkdir).toHaveBeenCalledWith('/mock/userData', {
      recursive: true,
    });
    expect(mockedWriteFile).toHaveBeenCalledWith(
      '/mock/userData/github-pat.enc',
      encrypted,
    );
    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/userData/secure/github-pat.enc',
      { force: true },
    );
    expect(mockInvalidateTokenCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateGitHubPatEnvCache).toHaveBeenCalledTimes(1);
    expect(mockResetGitHubBrokerCredentials).toHaveBeenCalledTimes(1);
    expect(mockInvalidateGitHubRepoListCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidatePullRequestListingCache).toHaveBeenCalledTimes(1);
  });
});

describe('refreshGitHubCredentialsHandler', () => {
  it('resumes only after the main-process token resolves', async () => {
    mockResolveGitHubToken.mockResolvedValueOnce('token');
    await refreshGitHubCredentialsHandler();
    expect(mockResumeAfterGitHub).toHaveBeenCalledTimes(1);
    expect(mockInvalidateTokenCache.mock.invocationCallOrder[0]).toBeLessThan(
      mockResolveGitHubToken.mock.invocationCallOrder[0],
    );
  });
  it('does not resume when credentials are missing', async () => {
    mockResolveGitHubToken.mockResolvedValueOnce('');
    await refreshGitHubCredentialsHandler();
    expect(mockResumeAfterGitHub).not.toHaveBeenCalled();
  });
  it('propagates token lookup failure without claiming recovery', async () => {
    mockResolveGitHubToken.mockRejectedValueOnce(
      new Error('token unavailable'),
    );
    await expect(refreshGitHubCredentialsHandler()).rejects.toThrow(
      'token unavailable',
    );
    expect(mockResumeAfterGitHub).not.toHaveBeenCalled();
  });

  it('invalidates all main-process GitHub credential and listing caches', async () => {
    await refreshGitHubCredentialsHandler();

    expect(mockInvalidateTokenCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateGitHubPatEnvCache).toHaveBeenCalledTimes(1);
    expect(mockResetGitHubBrokerCredentials).toHaveBeenCalledTimes(1);
    expect(mockInvalidateGitHubRepoListCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidatePullRequestListingCache).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// loadLinearToken IPC handler
// ---------------------------------------------------------------------------
describe('loadLinearHandler', () => {
  it('preserves metadata when stored credentials cannot be read', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('retained-ciphertext'));
    mockedIsEncryptionAvailable.mockReturnValue(false);

    const result = await loadLinearHandler();

    expect(result).toMatchObject({
      success: false,
      secureStorageFailure: {
        code: 'SECURE_STORAGE_READ_UNAVAILABLE',
        state: 'locked',
      },
    });
    expect(mockedDecryptString).not.toHaveBeenCalled();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('reads and decrypts the Linear token file', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    const encrypted = Buffer.from('encrypted-linear');
    mockedReadFile.mockResolvedValue(encrypted);
    mockedDecryptString.mockReturnValue('lin_api_mytoken');

    const result = await loadLinearHandler();

    expect(result).toBe('lin_api_mytoken');
    expect(mockedReadFile).toHaveBeenCalledWith(
      '/mock/userData/linear-token.enc',
    );
    expect(mockedDecryptString).toHaveBeenCalledWith(encrypted);
  });

  it('returns empty string when token file does not exist', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockedReadFile.mockRejectedValue(missingFileError());

    const result = await loadLinearHandler();

    expect(result).toBe('');
  });

  it('falls back to the legacy Linear token only when the secure file is missing', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    const legacyEncrypted = Buffer.from('legacy-linear');
    mockedReadFile
      .mockRejectedValueOnce(missingFileError())
      .mockResolvedValueOnce(legacyEncrypted);
    mockedDecryptString.mockReturnValue('lin_api_legacy');

    const result = await loadLinearHandler();

    expect(result).toBe('lin_api_legacy');
    expect(mockedReadFile).toHaveBeenNthCalledWith(
      1,
      '/mock/userData/linear-token.enc',
    );
    expect(mockedReadFile).toHaveBeenNthCalledWith(
      2,
      '/mock/userData/secure/linear-token.enc',
    );
  });

  it('does not fall back to the legacy Linear token when the secure file has a real read error', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockedReadFile.mockRejectedValueOnce(errnoError('EACCES'));

    const result = await loadLinearHandler();

    expect(result).toEqual({
      success: false,
      error: "Couldn't read saved credentials.",
    });
    expect(mockedReadFile).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// saveLinearToken IPC handler
// ---------------------------------------------------------------------------
describe('saveLinearHandler', () => {
  it('does not report successful deletion after filesystem refusal', async () => {
    mockedRm.mockRejectedValueOnce(errnoError('EACCES'));
    await expect(saveLinearHandler({}, '')).resolves.toEqual({
      success: false,
      error: "Couldn't save credentials.",
    });
    expect(mockInvalidateLinearTokenCache).not.toHaveBeenCalled();
  });

  it('retains the canonical Linear token when legacy deletion is refused', async () => {
    mockedRm.mockImplementation((path) => {
      if (path === '/mock/userData/secure/linear-token.enc') {
        return Promise.reject(errnoError('EACCES'));
      }
      return Promise.resolve();
    });

    await expect(saveLinearHandler({}, '')).resolves.toEqual({
      success: false,
      error: "Couldn't save credentials.",
    });
    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/userData/secure/linear-token.enc',
      { force: true },
    );
    expect(mockedRm).not.toHaveBeenCalledWith(
      '/mock/userData/linear-token.enc',
    );
    expect(mockInvalidateLinearTokenCache).not.toHaveBeenCalled();
  });
  it.each(['gnome_libsecret', 'unknown'] as const)(
    'refuses %s without native encryption or file changes',
    async (backend) => {
      mockedBackend.mockReturnValue(backend);
      mockedIsEncryptionAvailable.mockReturnValue(false);
      await expect(
        saveLinearHandler({}, 'lin_api_retained'),
      ).resolves.toMatchObject({
        success: false,
        secureStorageFailure: {
          code: 'SECURE_STORAGE_WRITE_REFUSED',
          state: backend === 'gnome_libsecret' ? 'locked' : 'unavailable',
          retryable: true,
        },
      });
      expect(mockedEncryptString).not.toHaveBeenCalled();
      expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
      expect(mockedRm).not.toHaveBeenCalled();
    },
  );

  it('rechecks write permission after asynchronous directory preparation', async () => {
    mockedMkdir.mockImplementationOnce(() => {
      mockedIsEncryptionAvailable.mockReturnValue(false);
      return Promise.resolve(undefined);
    });
    await expect(
      saveLinearHandler({}, 'lin_api_retained'),
    ).resolves.toMatchObject({
      success: false,
      secureStorageFailure: { code: 'SECURE_STORAGE_WRITE_REFUSED' },
    });
    expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('retains existing files after native encryption failure', async () => {
    mockedEncryptString.mockImplementationOnce(() => {
      throw new Error('native token diagnostic');
    });
    await expect(
      saveLinearHandler({}, 'lin_api_retained'),
    ).resolves.toMatchObject({
      success: false,
      secureStorageFailure: { code: 'SECURE_STORAGE_ENCRYPT_FAILED' },
    });
    expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('removes the file when token is empty', async () => {
    mockedRm.mockResolvedValue(undefined);

    await saveLinearHandler({}, '');

    expect(mockedRm).toHaveBeenCalledWith('/mock/userData/linear-token.enc');
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('removes the file when token is only whitespace', async () => {
    mockedRm.mockResolvedValue(undefined);

    await saveLinearHandler({}, '  \n  ');

    expect(mockedRm).toHaveBeenCalledWith('/mock/userData/linear-token.enc');
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('does not throw when removing a non-existent file for empty token', async () => {
    mockedRm.mockRejectedValue(errnoError('ENOENT'));

    await expect(saveLinearHandler({}, '')).resolves.toEqual({ success: true });
  });

  it('rejects unavailable saves without deleting credentials or invalidating caches', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(false);

    await expect(saveLinearHandler({}, 'lin_api_token')).resolves.toMatchObject(
      {
        success: false,
        secureStorageFailure: { code: 'SECURE_STORAGE_WRITE_REFUSED' },
      },
    );
    expect(mockedRm).not.toHaveBeenCalled();

    expect(mockedEncryptString).not.toHaveBeenCalled();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('trims and encrypts the token when encryption is available', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    const encrypted = Buffer.from('encrypted');
    mockedEncryptString.mockReturnValue(encrypted);
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await saveLinearHandler({}, '  lin_api_mytoken  ');

    expect(mockedEncryptString).toHaveBeenCalledWith('lin_api_mytoken');
    expect(mockedMkdir).toHaveBeenCalledWith('/mock/userData', {
      recursive: true,
    });
    expect(mockedWriteFile).toHaveBeenCalledWith(
      '/mock/userData/linear-token.enc',
      encrypted,
    );
    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/userData/secure/linear-token.enc',
      { force: true },
    );
  });
});

// ---------------------------------------------------------------------------
// validateLinearToken IPC handler
// ---------------------------------------------------------------------------
describe('validateLinearHandler', () => {
  it('returns unauthenticated with no error for empty token', async () => {
    const result = await validateLinearHandler({}, '');

    expect(result).toEqual({
      authenticated: false,
      displayName: null,
      error: null,
    });
    expect(mockedLinearClient).not.toHaveBeenCalled();
  });

  it('returns unauthenticated with no error for whitespace-only token', async () => {
    const result = await validateLinearHandler({}, '  \n  ');

    expect(result).toEqual({
      authenticated: false,
      displayName: null,
      error: null,
    });
    expect(mockedLinearClient).not.toHaveBeenCalled();
  });

  it('returns authenticated with displayName on success', async () => {
    const mockViewer = Promise.resolve({
      displayName: 'Alice',
      name: 'Alice A',
    });
    mockedLinearClient.mockImplementation(() => ({ viewer: mockViewer }));

    const result = await validateLinearHandler({}, 'lin_api_valid');

    expect(result).toEqual({
      authenticated: true,
      displayName: 'Alice',
      error: null,
    });
    expect(mockedLinearClient).toHaveBeenCalledWith({
      apiKey: 'lin_api_valid',
    });
  });

  it('trims the token before validating', async () => {
    const mockViewer = Promise.resolve({
      displayName: 'Bob',
      name: 'Bob B',
    });
    mockedLinearClient.mockImplementation(() => ({ viewer: mockViewer }));

    await validateLinearHandler({}, '  lin_api_padded  ');

    expect(mockedLinearClient).toHaveBeenCalledWith({
      apiKey: 'lin_api_padded',
    });
  });

  it('returns error when Linear API rejects the token', async () => {
    mockedLinearClient.mockImplementation(() => {
      throw new Error('Unauthorized');
    });

    const result = await validateLinearHandler({}, 'lin_api_bad');

    expect(result).toEqual({
      authenticated: false,
      displayName: null,
      error: 'Invalid API key or unable to reach Linear.',
    });
  });
});

// ---------------------------------------------------------------------------
// searchLinearIssues IPC handler
// ---------------------------------------------------------------------------
describe('searchLinearHandler', () => {
  it('distinguishes a disconnected exact lookup from an absent issue', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    await expect(searchLinearHandler({}, 'CAN-3606')).rejects.toThrow(
      'Connect Linear',
    );
  });

  it.each(['Unauthorized', 'rate limit', 'network unavailable'])(
    'surfaces exact lookup failure %s instead of empty issue evidence',
    async (message) => {
      mockedIsEncryptionAvailable.mockReturnValue(true);
      mockedReadFile.mockResolvedValue(Buffer.from('encrypted-linear'));
      mockedDecryptString.mockReturnValue('lin_api_valid');
      mockedLinearClient.mockImplementation(() => ({
        searchIssues: jest.fn().mockRejectedValue(new Error(message)),
      }));
      const writeSpy = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        await expect(searchLinearHandler({}, 'CAN-3606')).rejects.toThrow();
      } finally {
        writeSpy.mockRestore();
      }
    },
  );

  function createSearchResult(
    index: number,
    overrides: Partial<LinearTicketSearchResult> = {},
  ): LinearTicketSearchResult {
    return {
      id: `issue-${String(index)}`,
      identifier: `ENG-${String(index)}`,
      title: `Issue ${String(index)}`,
      description: `Description ${String(index)}`,
      url: `https://linear.app/example/issue/ENG-${String(index)}`,
      priority: index,
      priorityLabel: `Priority ${String(index)}`,
      branchName: `eng-${String(index)}-issue-${String(index)}`,
      ...overrides,
    };
  }

  it('returns [] for empty and whitespace-only queries without invoking LinearClient', async () => {
    const emptyResult = await searchLinearHandler({}, '');
    const whitespaceResult = await searchLinearHandler({}, '  \n  ');

    expect(emptyResult).toEqual([]);
    expect(whitespaceResult).toEqual([]);
    expect(mockedReadFile).not.toHaveBeenCalled();
    expect(mockedLinearClient).not.toHaveBeenCalled();
  });

  it('returns [] when no Linear token is persisted', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    const result = await searchLinearHandler({}, 'ENG');

    expect(result).toEqual([]);
    expect(mockedLinearClient).not.toHaveBeenCalled();
  });

  it('constructs LinearClient with the decrypted token and maps search results', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    const encrypted = Buffer.from('encrypted-linear');
    const mappedResults = [
      createSearchResult(1, { description: null }),
      createSearchResult(2),
    ];
    const searchIssues = jest
      .fn<Promise<{ nodes: LinearTicketSearchResult[] }>, [string]>()
      .mockResolvedValue({
        nodes: mappedResults,
      });

    mockedReadFile.mockResolvedValue(encrypted);
    mockedDecryptString.mockReturnValue('lin_api_valid');
    mockedLinearClient.mockImplementation(() => ({
      searchIssues,
    }));

    const result = await searchLinearHandler({}, '  ENG-12  ');

    expect(mockedLinearClient).toHaveBeenCalledWith({
      apiKey: 'lin_api_valid',
    });
    expect(searchIssues).toHaveBeenCalledWith('ENG-12');
    expect(result).toEqual(mappedResults);
  });

  it('returns attachment URLs and marks a truncated page as incomplete', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockedReadFile.mockResolvedValue(Buffer.from('encrypted-linear'));
    mockedDecryptString.mockReturnValue('lin_api_valid');
    const attachments = jest.fn().mockResolvedValue({
      nodes: [
        {
          url: 'https://github.com/o/r/pull/7',
          sourceType: 'github',
          title: 'PR',
          id: 'attachment-1',
        },
      ],
      pageInfo: { hasNextPage: true },
    });
    mockedLinearClient.mockImplementation(() => ({
      searchIssues: jest
        .fn()
        .mockResolvedValue({ nodes: [createSearchResult(7)] }),
      issue: jest.fn().mockResolvedValue({ attachments }),
    }));

    const result = await searchLinearHandler({}, 'ENG-7');

    expect(result).toEqual([
      {
        ...createSearchResult(7),
        attachments: [
          {
            url: 'https://github.com/o/r/pull/7',
            source: 'github',
            title: 'PR',
          },
        ],
        attachmentsComplete: false,
      },
    ]);
    expect(attachments).toHaveBeenCalledWith({ first: 50 });
  });

  it.each([
    [
      { nodes: [], pageInfo: { hasNextPage: false } },
      { attachments: [], attachmentsComplete: true },
    ],
    [
      { nodes: [{ url: 'https://github.com/o/r', sourceType: null }] },
      {
        attachments: [{ url: 'https://github.com/o/r', source: null }],
        attachmentsComplete: false,
      },
    ],
    [
      { nodes: [{ url: 7 }], pageInfo: { hasNextPage: false } },
      { attachmentsComplete: false },
    ],
    [
      { nodes: [], pageInfo: { hasNextPage: 'false' } },
      { attachmentsComplete: false },
    ],
  ])(
    'preserves attachment completeness for payload %p',
    async (payload, expected) => {
      mockedIsEncryptionAvailable.mockReturnValue(true);
      mockedReadFile.mockResolvedValue(Buffer.from('encrypted-linear'));
      mockedDecryptString.mockReturnValue('lin_api_valid');
      const issue = jest.fn().mockResolvedValue({
        attachments: jest.fn().mockResolvedValue(payload),
      });
      const searchIssues = jest.fn().mockResolvedValue({
        nodes: [createSearchResult(1), createSearchResult(7)],
      });
      mockedLinearClient.mockImplementation(() => ({ searchIssues, issue }));

      const result = await searchLinearHandler({}, '  eng-7  ');

      expect(searchIssues).toHaveBeenCalledWith('ENG-7');
      expect(issue).toHaveBeenCalledTimes(1);
      expect(issue).toHaveBeenCalledWith('issue-7');
      expect(result).toContainEqual({ ...createSearchResult(7), ...expected });
      expect(result).toContainEqual(createSearchResult(1));
    },
  );

  it('leaves ordinary autocomplete as a single request', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockedReadFile.mockResolvedValue(Buffer.from('encrypted-linear'));
    mockedDecryptString.mockReturnValue('lin_api_valid');
    const issue = jest.fn();
    mockedLinearClient.mockImplementation(() => ({
      searchIssues: jest
        .fn()
        .mockResolvedValue({ nodes: [createSearchResult(7)] }),
      issue,
    }));

    expect(await searchLinearHandler({}, 'ENG')).toEqual([
      createSearchResult(7),
    ]);
    expect(issue).not.toHaveBeenCalled();
  });

  it('preserves the accessible issue when attachment lookup fails', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockedReadFile.mockResolvedValue(Buffer.from('encrypted-linear'));
    mockedDecryptString.mockReturnValue('lin_api_valid');
    const writeSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    mockedLinearClient.mockImplementation(() => ({
      searchIssues: jest
        .fn()
        .mockResolvedValue({ nodes: [createSearchResult(7)] }),
      issue: jest.fn().mockResolvedValue({
        attachments: jest.fn().mockRejectedValue(new Error('Forbidden')),
      }),
    }));

    try {
      expect(await searchLinearHandler({}, 'ENG-7')).toEqual([
        { ...createSearchResult(7), attachmentsComplete: false },
      ]);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('marks unavailable attachment APIs as unknown rather than empty evidence', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockedReadFile.mockResolvedValue(Buffer.from('encrypted-linear'));
    mockedDecryptString.mockReturnValue('lin_api_valid');
    mockedLinearClient.mockImplementation(() => ({
      searchIssues: jest
        .fn()
        .mockResolvedValue({ nodes: [createSearchResult(7)] }),
    }));

    expect(await searchLinearHandler({}, 'ENG-7')).toEqual([
      { ...createSearchResult(7), attachmentsComplete: false },
    ]);
  });

  it('caps attachment data and never claims completeness for an oversized response', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockedReadFile.mockResolvedValue(Buffer.from('encrypted-linear'));
    mockedDecryptString.mockReturnValue('lin_api_valid');
    const nodes = Array.from({ length: 51 }, (_, index) => ({
      url: `https://github.com/o/r/pull/${index + 1}`,
    }));
    mockedLinearClient.mockImplementation(() => ({
      searchIssues: jest
        .fn()
        .mockResolvedValue({ nodes: [createSearchResult(7)] }),
      issue: jest.fn().mockResolvedValue({
        attachments: jest
          .fn()
          .mockResolvedValue({ nodes, pageInfo: { hasNextPage: false } }),
      }),
    }));

    const result = await searchLinearHandler({}, 'ENG-7');
    expect(result).toEqual([
      {
        ...createSearchResult(7),
        attachments: nodes.slice(0, 50),
        attachmentsComplete: false,
      },
    ]);
  });

  it('retains an exact issue even when fuzzy neighbors fill the result limit', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockedReadFile.mockResolvedValue(Buffer.from('encrypted-linear'));
    mockedDecryptString.mockReturnValue('lin_api_valid');
    const results = Array.from({ length: 25 }, (_, index) =>
      createSearchResult(index + 1),
    );
    mockedLinearClient.mockImplementation(() => ({
      searchIssues: jest.fn().mockResolvedValue({ nodes: results }),
      issue: jest.fn().mockResolvedValue({
        attachments: jest
          .fn()
          .mockResolvedValue({ nodes: [], pageInfo: { hasNextPage: false } }),
      }),
    }));

    const result = await searchLinearHandler({}, 'ENG-25');
    expect(result).toHaveLength(20);
    expect(result).toContainEqual({
      ...createSearchResult(25),
      attachments: [],
      attachmentsComplete: true,
    });
  });

  it('caps mapped results at 20', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    const encrypted = Buffer.from('encrypted-linear');
    const results = Array.from({ length: 25 }, (_value, index) =>
      createSearchResult(index + 1),
    );
    const searchIssues = jest
      .fn<Promise<{ nodes: LinearTicketSearchResult[] }>, [string]>()
      .mockResolvedValue({
        nodes: results,
      });

    mockedReadFile.mockResolvedValue(encrypted);
    mockedDecryptString.mockReturnValue('lin_api_valid');
    mockedLinearClient.mockImplementation(() => ({
      searchIssues,
    }));

    const result = await searchLinearHandler({}, 'ENG');

    expect(result).toHaveLength(20);
    expect(result).toEqual(results.slice(0, 20));
  });

  it('returns [] when searchIssues rejects', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(true);
    const encrypted = Buffer.from('encrypted-linear');
    const writeSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const searchIssues = jest
      .fn<Promise<{ nodes: LinearTicketSearchResult[] }>, [string]>()
      .mockRejectedValue(new Error('Unauthorized'));

    mockedReadFile.mockResolvedValue(encrypted);
    mockedDecryptString.mockReturnValue('lin_api_revoked');
    mockedLinearClient.mockImplementation(() => ({
      searchIssues,
    }));

    await expect(searchLinearHandler({}, 'ENG')).resolves.toEqual([]);

    writeSpy.mockRestore();
  });
});

describe('saveModelGatewayCredentialHandler', () => {
  const input = {
    organizationId: 'org-1',
    baseUrl: 'https://gateway.acme.test/v1',
    apiKey: 'sk-live-key',
  };

  it.each(['sk-live-key', ''])(
    'reports persisted gateway key after session invalidation fails (%s)',
    async (apiKey) => {
      mockedFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      mockInvalidateProviderAuthSessions.mockRejectedValueOnce(
        new Error('session cleanup failed'),
      );

      await expect(
        saveModelGatewayCredentialHandler({}, { ...input, apiKey }),
      ).resolves.toMatchObject({ valid: apiKey.length > 0 });
      expect(mockSaveModelGatewayCredential).toHaveBeenCalledTimes(1);
      expect(mockInvalidateProviderAuthSessions).toHaveBeenCalledTimes(1);
    },
  );

  it('attaches a typed storage failure without refreshing provider sessions', async () => {
    mockedFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const secureStorageFailure: SecureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_WRITE_REFUSED',
      operation: 'write',
      state: 'locked',
      backend: 'gnome_libsecret',
      retryable: true,
    };
    mockSaveModelGatewayCredential.mockRejectedValueOnce(
      Object.assign(
        new MockGatewayCredentialStorageUnavailableError(
          'Model gateway credential storage unavailable',
        ),
        { secureStorageFailure },
      ),
    );
    await expect(saveModelGatewayCredentialHandler({}, input)).resolves.toEqual(
      {
        valid: false,
        error: 'Model gateway credential storage unavailable',
        secureStorageFailure,
      },
    );
    expect(mockInvalidateProviderAuthSessions).not.toHaveBeenCalled();
  });

  it('persists lastError only when the gateway REJECTED the key', async () => {
    mockedFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
    } as unknown as Response);

    const result = await saveModelGatewayCredentialHandler({}, input);

    expect(result).toMatchObject({ valid: false });
    expect(mockSaveModelGatewayCredential.mock.calls[0][0].lastError).toBe(
      'Gateway validation failed with HTTP 401.',
    );
    expect(mockedFetch).toHaveBeenCalledWith(
      'https://gateway.acme.test/v1/models',
      expect.any(Object),
    );
    expect(mockSaveModelGatewayCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrlAtSave: 'https://gateway.acme.test',
      }),
    );
  });

  it('does not brick routing when the probe merely could not reach the gateway', async () => {
    // `resolveOrgGatewayCredential` REFUSES to route any turn while a stored
    // record carries `lastError`. A flaky network at paste time must not
    // therefore block every future turn behind "Add a current organization
    // gateway key" — only the gateway itself gets to reject the key.
    mockedFetch.mockRejectedValue(new Error('socket hang up'));

    const result = await saveModelGatewayCredentialHandler({}, input);

    expect(result).toMatchObject({ valid: false });
    expect(
      mockSaveModelGatewayCredential.mock.calls[0][0].lastError,
    ).toBeUndefined();
  });

  it('invalidates Claude sessions after replacing or clearing the gateway key', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    } as unknown as Response);

    await saveModelGatewayCredentialHandler({}, input);
    await saveModelGatewayCredentialHandler({}, { ...input, apiKey: '' });

    expect(mockInvalidateProviderAuthSessions.mock.calls).toEqual([
      [
        'claude',
        'model-gateway-credential-changed',
        { activeTurnPolicy: 'preserve' },
      ],
      [
        'claude',
        'model-gateway-credential-changed',
        { activeTurnPolicy: 'preserve' },
      ],
    ]);
  });

  it('does not let an older validation restore a key after a newer delete', async () => {
    let finishOlderProbe: ((response: Response) => void) | undefined;
    mockedFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finishOlderProbe = resolve;
      }),
    );

    const olderSave = saveModelGatewayCredentialHandler({}, input);
    await Promise.resolve();
    const newerDelete = saveModelGatewayCredentialHandler(
      {},
      {
        ...input,
        apiKey: '',
      },
    );
    await Promise.resolve();

    expect(mockSaveModelGatewayCredential).not.toHaveBeenCalled();
    finishOlderProbe?.(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    await Promise.all([olderSave, newerDelete]);

    expect(
      mockSaveModelGatewayCredential.mock.calls.map(
        ([record]) => record.apiKey,
      ),
    ).toEqual(['sk-live-key', '']);
  });

  it('persists concurrent key rotations in IPC arrival order', async () => {
    let finishOlderProbe: ((response: Response) => void) | undefined;
    mockedFetch
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          finishOlderProbe = resolve;
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );

    const olderSave = saveModelGatewayCredentialHandler({}, input);
    await Promise.resolve();
    const newerSave = saveModelGatewayCredentialHandler(
      {},
      {
        ...input,
        apiKey: 'sk-rotated-key',
      },
    );
    await Promise.resolve();

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    finishOlderProbe?.(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    await Promise.all([olderSave, newerSave]);

    expect(
      mockSaveModelGatewayCredential.mock.calls.map(
        ([record]) => record.apiKey,
      ),
    ).toEqual(['sk-live-key', 'sk-rotated-key']);
  });
});

describe('loadModelGatewayCredentialHandler', () => {
  it('attaches only safe storage metadata to the existing read envelope', async () => {
    const secureStorageFailure: SecureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_DECRYPT_FAILED',
      operation: 'read',
      state: 'locked',
      backend: 'gnome_libsecret',
      retryable: true,
    };
    mockLoadModelGatewayCredential.mockRejectedValue(
      Object.assign(new MockGatewayCredentialStorageUnavailableError(), {
        secureStorageFailure,
      }),
    );
    await expect(
      loadModelGatewayCredentialHandler({}, 'org-1'),
    ).resolves.toMatchObject({ apiKey: '', secureStorageFailure });
    expect(mockSaveModelGatewayCredential).not.toHaveBeenCalled();
  });

  it('reports secure storage as unavailable instead of rejecting the settings read', async () => {
    mockIsModelGatewayCredentialStorageAvailable.mockReturnValue(false);
    mockLoadModelGatewayCredential.mockRejectedValue(
      new MockGatewayCredentialStorageUnavailableError(),
    );

    await expect(
      loadModelGatewayCredentialHandler({}, 'org-1'),
    ).resolves.toEqual({
      organizationId: 'org-1',
      apiKey: '',
      baseUrlAtSave: '',
      storageAvailable: false,
    });
  });
});

describe('Canopy Cloud account handlers', () => {
  function mockSuccessfulCloudProbe(
    capabilities = [
      'pipelines-crud-v1',
      'account-v1',
      'organizations-v1',
      'teams-v1',
      'portal-v1',
    ],
    accountId = 'account-1',
  ): void {
    mockedFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ capabilities }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            account: {
              id: accountId,
              name: 'Cloud Admin',
              email: 'admin@example.test',
              role: 'ADMIN',
            },
            organizations: [
              {
                id: 'org-1',
                name: 'Acme',
                createdAt: '2026-05-27T10:00:00.000Z',
                updatedAt: '2026-05-27T10:00:00.000Z',
              },
            ],
            teams: [
              {
                id: 'team-1',
                name: 'Platform',
                organization: {
                  id: 'org-1',
                  name: 'Acme',
                  createdAt: '2026-05-27T10:00:00.000Z',
                  updatedAt: '2026-05-27T10:00:00.000Z',
                },
                createdAt: '2026-05-27T10:00:00.000Z',
                updatedAt: '2026-05-27T10:00:00.000Z',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
  }

  it('loads an empty public state without contacting Canopy Cloud', async () => {
    await expect(loadCanopyCloudAccountHandler({})).resolves.toEqual({
      secureStorageStatus: {
        version: 1,
        state: 'secure',
        backend: 'gnome_libsecret',
        writeAvailable: true,
      },
      read: 'ok',
      hasApiKey: false,
      authMode: null,
      credentialSource: null,
      capabilities: [],
      organizations: [],
      teams: [],
      enforcedSettings: [],
      orgBillingStates: [],
      storageAvailable: true,
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('loads the saved Canopy Cloud API key for Accounts settings', async () => {
    mockSuccessfulCloudProbe();

    await saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_valid' });

    await expect(loadCanopyCloudApiKeyHandler({})).resolves.toBe('csk_valid');
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('maps any AI Credits 404 response to the no-UD-account state', async () => {
    mockSuccessfulCloudProbe();
    await saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_valid' });

    mockRequestCanopyCloudJson.mockImplementation((pathname: string) => {
      if (pathname === '/api/v1/ai-credits/subscription') {
        return Promise.reject(
          new mockCanopyCloudClientError(
            'http-error',
            'No UD account found for this user',
            404,
          ),
        );
      }
      if (pathname === '/api/v1/ai-credits/balance') {
        return Promise.reject(new Error('temporary balance outage'));
      }
      return Promise.reject(new Error(`Unexpected path ${pathname}`));
    });

    await expect(loadCanopyCloudAiCreditsHandler({})).resolves.toEqual({
      connected: true,
      email: 'admin@example.test',
      subscription: null,
      balance: null,
      noUdAccount: true,
      error: null,
      purchaseUrl: getUnstoppableDomainsAiCreditsPurchaseUrl(),
      manageUrl: getUnstoppableDomainsAiCreditsManageUrl(),
    });
  });

  it('sends the selected owner on balance reads and rejects another org pool', async () => {
    mockSuccessfulCloudProbe();
    await saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_valid' });
    const owner = {
      kind: 'organization',
      organizationId: '123e4567-e89b-12d3-a456-426614174000',
    } as const;
    mockRequestCanopyCloudJson.mockImplementation((pathname: string) => {
      if (pathname === '/api/v1/ai-credits/subscription') {
        return Promise.resolve(null);
      }
      if (pathname === '/api/v1/ai-credits/balance') {
        return Promise.resolve({
          email: 'admin@example.test',
          credits: 0,
          eligible: true,
          source: 'canopy',
          orgFundingAvailable: true,
          orgPool: { orgId: 'another-org', orgName: 'Another Org' },
        });
      }
      return Promise.reject(new Error(`Unexpected path ${pathname}`));
    });

    const state = await loadCanopyCloudAiCredits(owner);

    expect(mockRequestCanopyCloudJson).toHaveBeenCalledWith(
      '/api/v1/ai-credits/balance',
      {
        headers: {
          'x-canopy-work-owner': `org:${owner.organizationId}`,
        },
      },
    );
    expect(state.balance).toMatchObject({
      eligible: false,
      orgFundingAvailable: false,
      orgPool: null,
    });
  });

  it.each([
    {
      label: 'unsafe project id',
      scope: { kind: 'work', projectId: '../another-project' },
    },
    {
      label: 'chat without a worktree',
      scope: { kind: 'work', projectId: 'project-a', chatId: 'chat-a' },
    },
  ])(
    'treats an invalid AI Credits scope as wallet-only: $label',
    async ({ scope }) => {
      await loadCanopyCloudAiCreditsHandler({}, scope);

      expect(mockResolveAiCreditsScopeOwner).not.toHaveBeenCalled();
    },
  );

  it('does not return OAuth-created raw tokens through the API-key loader', async () => {
    mockedReadFile.mockResolvedValueOnce(
      Buffer.from(
        JSON.stringify({
          apiKey: 'csk_oauth_secret',
          authMode: 'oauth',
          credentialSource: 'oauth_desktop',
          serverApiKeyId: 'key-1',
          capabilities: ['account-v1'],
          createdAt: '2026-06-01T19:00:00.000Z',
          updatedAt: '2026-06-01T19:00:00.000Z',
        }),
        'utf8',
      ),
    );

    await expect(loadCanopyCloudApiKeyHandler({})).resolves.toBe('');
  });

  it('loads storage-unavailable public state without throwing', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(false);
    invalidateCanopyCloudAccountCache();

    await expect(loadCanopyCloudAccountHandler({})).resolves.toEqual({
      secureStorageStatus: {
        version: 1,
        state: 'locked',
        backend: 'gnome_libsecret',
        writeAvailable: false,
      },
      secureStorageFailure: {
        version: 1,
        code: 'SECURE_STORAGE_READ_UNAVAILABLE',
        operation: 'read',
        state: 'locked',
        backend: 'gnome_libsecret',
        retryable: true,
      },
      read: 'unavailable',
      hasApiKey: false,
      authMode: null,
      credentialSource: null,
      capabilities: [],
      organizations: [],
      teams: [],
      enforcedSettings: [],
      orgBillingStates: [],
      storageAvailable: false,
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('reports a decrypt failure as a degraded read rather than a sign-out', async () => {
    // Regression guard: the store collapses an undecryptable entry to a null
    // entry, which serializes exactly like a real sign-out. Renderer surfaces
    // that hold last-known-good state need `read` to tell them apart, so this
    // must not silently degrade back to `'ok'`.
    invalidateCanopyCloudAccountCache();
    mockedReadFile.mockResolvedValueOnce(Buffer.from('not-encrypted', 'utf8'));
    mockedDecryptString.mockImplementationOnce(() => {
      throw new Error('decrypt failed');
    });

    const result = await loadCanopyCloudAccountHandler({});

    expect(result.read).toBe('error');
    expect(result.secureStorageFailure).toMatchObject({
      code: 'SECURE_STORAGE_DECRYPT_FAILED',
      state: 'secure',
      retryable: false,
    });
    expect(result.hasApiKey).toBe(false);
    expect(result.account).toBeUndefined();
  });

  it('does not report cached credentials as available when storage becomes unavailable', async () => {
    mockSuccessfulCloudProbe();
    await saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_valid' });

    mockedIsEncryptionAvailable.mockReturnValue(false);

    await expect(loadCanopyCloudAccountHandler({})).resolves.toEqual({
      secureStorageStatus: {
        version: 1,
        state: 'locked',
        backend: 'gnome_libsecret',
        writeAvailable: false,
      },
      secureStorageFailure: {
        version: 1,
        code: 'SECURE_STORAGE_READ_UNAVAILABLE',
        operation: 'read',
        state: 'locked',
        backend: 'gnome_libsecret',
        retryable: true,
      },
      read: 'unavailable',
      hasApiKey: false,
      authMode: null,
      credentialSource: null,
      capabilities: [],
      organizations: [],
      teams: [],
      enforcedSettings: [],
      orgBillingStates: [],
      storageAvailable: false,
    });
  });

  it('reports retained credential read failure during cloud validation', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(false);
    const result = await validateCanopyCloudApiKeyHandler({}, {});
    expect(result).toMatchObject({
      authenticated: false,
      secureStorageFailure: {
        code: 'SECURE_STORAGE_READ_UNAVAILABLE',
        state: 'locked',
      },
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('preserves OAuth encryption failure across the IPC envelope', async () => {
    const failure: SecureStorageFailure = {
      version: 1,
      code: 'SECURE_STORAGE_ENCRYPT_FAILED',
      operation: 'write',
      state: 'secure',
      backend: 'gnome_libsecret',
      retryable: true,
    };
    mockStartCanopyCloudOAuthLogin.mockRejectedValueOnce(
      Object.assign(new Error('Secure storage encryption failed'), {
        secureStorageFailure: failure,
      }),
    );
    const result = await startCanopyCloudOAuthLoginHandler({});
    expect(result).toMatchObject({
      status: { authenticated: false, secureStorageFailure: failure },
      account: { secureStorageFailure: failure },
    });
    expect(mockInvalidateMobileActivationCache).not.toHaveBeenCalled();
  });

  it('refuses OAuth before browser start when secure storage is unavailable', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(false);

    const result = await startCanopyCloudOAuthLoginHandler({});

    expect(result).toMatchObject({
      status: {
        authenticated: false,
        secureStorageFailure: {
          code: 'SECURE_STORAGE_READ_UNAVAILABLE',
          operation: 'read',
        },
      },
      account: {
        secureStorageFailure: {
          code: 'SECURE_STORAGE_READ_UNAVAILABLE',
          operation: 'read',
        },
      },
    });
    expect(mockStartCanopyCloudOAuthLogin).not.toHaveBeenCalled();
    expect(mockRequestGuestLinkTicket).not.toHaveBeenCalled();
  });

  it('returns missing-api-key status when validating without input or saved key', async () => {
    const result = await validateCanopyCloudApiKeyHandler({}, {});

    expect(result).toMatchObject({
      authenticated: false,
      error: 'Canopy Cloud API key is required.',
    });
    expect(mockedGetCanopyCloudBaseUrl).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('validates a candidate key without writing secure storage', async () => {
    mockSuccessfulCloudProbe();

    const result = (await validateCanopyCloudApiKeyHandler(
      {},
      { apiKey: ' csk_valid ' },
    )) as CanopyServerStatus;

    expect(result.authenticated).toBe(true);
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(mockedFetch).toHaveBeenNthCalledWith(
      2,
      'https://cloud.example.test/api/v1/desktop-app/account',
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer csk_valid',
        },
      }),
    );
  });

  it('preserves non-retryable cloud read failure instead of throwing from manual save', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('retained-ciphertext'));
    mockedDecryptString.mockImplementation(() => {
      throw new Error('private native diagnostic');
    });
    await expect(
      saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_candidate' }),
    ).resolves.toMatchObject({
      status: {
        authenticated: false,
        secureStorageFailure: {
          code: 'SECURE_STORAGE_DECRYPT_FAILED',
          retryable: false,
        },
      },
      account: {
        read: 'error',
        secureStorageFailure: {
          code: 'SECURE_STORAGE_DECRYPT_FAILED',
          retryable: false,
        },
      },
    });
    expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('returns the existing cloud failure envelope after native encryption fails without completing save side effects', async () => {
    mockSuccessfulCloudProbe();
    mockedEncryptString.mockImplementationOnce(() => {
      throw new Error('secret native diagnostic');
    });
    const response = await saveCanopyCloudApiKeyHandler(
      {},
      { apiKey: 'csk_retained' },
    );
    expect(response).toMatchObject({
      status: {
        authenticated: false,
        error: 'Secure storage is unavailable for Canopy Cloud credentials.',
      },
      account: {
        secureStorageFailure: { code: 'SECURE_STORAGE_ENCRYPT_FAILED' },
      },
    });
    expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockInvalidateMobileActivationCache).not.toHaveBeenCalled();
    expect(mockRefreshFeatureFlagContext).not.toHaveBeenCalled();
    expect(mockApplyEnforcedSettings).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain('secret native diagnostic');
  });

  it('saves only after authentication, account, and required capabilities pass', async () => {
    mockSuccessfulCloudProbe();

    const result = await saveCanopyCloudApiKeyHandler(
      {},
      { apiKey: 'csk_valid' },
    );

    expect(result).toMatchObject({
      status: { authenticated: true, missingCapabilities: [] },
      account: {
        hasApiKey: true,
        authMode: 'api_key',
        credentialSource: 'manual',
        account: { email: 'admin@example.test' },
        storageAvailable: true,
      },
    });
    expect(
      (
        result as {
          account: { capabilities: string[] };
        }
      ).account.capabilities,
    ).toContain('portal-v1');
    expect(mockedWriteFile).toHaveBeenCalledWith(
      '/mock/userData/canopy-cloud-account.enc',
      expect.any(Buffer),
    );
    expect(JSON.parse(mockedEncryptString.mock.calls[0][0])).toMatchObject({
      apiKey: 'csk_valid',
      authMode: 'api_key',
      credentialSource: 'manual',
    });
  });

  it('purges decrypted replicas before a manual key replaces another account', async () => {
    mockSuccessfulCloudProbe(undefined, 'account-1');
    await saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_first' });
    mockPurgeSharedContainerReplicas.mockClear();
    mockWithSharedContainerReplicaPurgeFence.mockClear();
    mockSuccessfulCloudProbe(undefined, 'account-2');

    await saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_second' });

    expect(mockPurgeSharedContainerReplicas).toHaveBeenCalledTimes(1);
    expect(
      mockPurgeSharedContainerReplicas.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockedWriteFile.mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(mockWithSharedContainerReplicaPurgeFence).toHaveBeenCalledTimes(1);
  });

  it('reconciles a confirmed organization snapshot before persisting a same-account manual key', async () => {
    mockSuccessfulCloudProbe(undefined, 'account-1');
    await saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_first' });
    mockPurgeSharedContainerReplicas.mockClear();
    mockWithSharedContainerReplicaPurgeFence.mockClear();
    mockReconcileSharedContainerOrganizationSnapshot.mockClear();
    mockSuccessfulCloudProbe(undefined, 'account-1');

    await saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_second' });

    expect(
      mockReconcileSharedContainerOrganizationSnapshot,
    ).toHaveBeenCalledWith(['org-1'], expect.any(Function));
    expect(
      mockReconcileSharedContainerOrganizationSnapshot.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      mockedWriteFile.mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(mockWithSharedContainerReplicaPurgeFence).not.toHaveBeenCalled();
  });

  it('does not resurrect a manual credential when disconnect wins during validation', async () => {
    mockSuccessfulCloudProbe();
    await saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_initial' });
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);

    mockedFetch.mockReset();
    let resolveCapabilities!: (response: Response) => void;
    mockedFetch
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveCapabilities = resolve;
          }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            account: {
              id: 'account-2',
              name: 'Second Account',
              email: 'second@example.test',
              role: 'ADMIN',
            },
            organizations: [],
            teams: [],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );

    const staleSave = saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_stale' });
    for (let i = 0; i < 8 && mockedFetch.mock.calls.length === 0; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    await expect(
      disconnectCanopyCloudAccountHandler({}),
    ).resolves.toMatchObject({ hasApiKey: false });
    resolveCapabilities(
      new Response(
        JSON.stringify({
          capabilities: [
            'pipelines-crud-v1',
            'account-v1',
            'organizations-v1',
            'teams-v1',
            'portal-v1',
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await expect(staleSave).resolves.toMatchObject({
      status: { authenticated: false },
      account: { hasApiKey: false },
    });
    // The message goes through `toHaveProperty` rather than a nested
    // `expect.stringContaining` inside the object above: that matcher is typed
    // `any`, and putting one in an object literal trips `no-unsafe-assignment`.
    // Passed as an argument it is only read, never assigned.
    await expect(staleSave).resolves.toHaveProperty(
      'status.error',
      expect.stringContaining(
        'account changed while the API key was being validated',
      ),
    );
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
  });

  it('does not let a deferred account refresh undo a completed disconnect', async () => {
    mockSuccessfulCloudProbe(undefined, 'account-1');
    await saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_account_1' });
    mockReconcileSharedContainerOrganizationSnapshot.mockClear();

    mockedFetch.mockReset();
    let resolveCapabilities!: (response: Response) => void;
    mockedFetch
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveCapabilities = resolve;
          }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            account: {
              id: 'account-1',
              name: 'First Account',
              email: 'first@example.test',
              role: 'ADMIN',
            },
            organizations: [],
            teams: [],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );

    const staleRefresh = reprobeAndApplyCanopyCloudEnforcedSettings();
    for (let i = 0; i < 8 && mockedFetch.mock.calls.length === 0; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const queuedRefresh = reprobeAndApplyCanopyCloudEnforcedSettings();

    await expect(
      disconnectCanopyCloudAccountHandler({}),
    ).resolves.toMatchObject({ hasApiKey: false });
    resolveCapabilities(
      new Response(
        JSON.stringify({
          capabilities: [
            'pipelines-crud-v1',
            'account-v1',
            'organizations-v1',
            'teams-v1',
            'portal-v1',
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await expect(staleRefresh).resolves.toBe(false);
    await expect(queuedRefresh).resolves.toBe(false);
    await expect(loadCanopyCloudAccountHandler({})).resolves.toMatchObject({
      hasApiKey: false,
    });
    expect(
      mockReconcileSharedContainerOrganizationSnapshot,
    ).not.toHaveBeenCalled();
  });

  it('does not let a deferred account refresh overwrite a replacement account', async () => {
    mockSuccessfulCloudProbe(undefined, 'account-1');
    await saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_account_1' });
    mockReconcileSharedContainerOrganizationSnapshot.mockClear();

    mockedFetch.mockReset();
    let resolveStaleCapabilities!: (response: Response) => void;
    mockedFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveStaleCapabilities = resolve;
        }),
    );
    mockSuccessfulCloudProbe(undefined, 'account-2');
    mockedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          account: {
            id: 'account-1',
            name: 'First Account',
            email: 'first@example.test',
            role: 'ADMIN',
          },
          organizations: [],
          teams: [],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const staleRefresh = reprobeAndApplyCanopyCloudEnforcedSettings();
    for (let i = 0; i < 8 && mockedFetch.mock.calls.length === 0; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const queuedRefresh = reprobeAndApplyCanopyCloudEnforcedSettings();

    await saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_account_2' });
    resolveStaleCapabilities(
      new Response(
        JSON.stringify({
          capabilities: [
            'pipelines-crud-v1',
            'account-v1',
            'organizations-v1',
            'teams-v1',
            'portal-v1',
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await expect(staleRefresh).resolves.toBe(false);
    await expect(queuedRefresh).resolves.toBe(false);
    await expect(loadCanopyCloudAccountHandler({})).resolves.toMatchObject({
      hasApiKey: true,
      account: { id: 'account-2' },
    });
    expect(
      mockReconcileSharedContainerOrganizationSnapshot,
    ).not.toHaveBeenCalled();
  });

  it('does not let a manual API key overwrite a guest credential', async () => {
    mockedReadFile.mockResolvedValueOnce(
      Buffer.from(
        JSON.stringify({
          apiKey: 'csk_guest',
          authMode: 'guest',
          credentialSource: 'guest',
          capabilities: ['portal-v1'],
          account: {
            id: 'guest-account-1',
            name: 'Guest',
            email: 'guest@example.test',
            role: 'VIEWER',
          },
          createdAt: '2026-07-06T00:00:00.000Z',
          updatedAt: '2026-07-06T00:00:00.000Z',
        }),
        'utf8',
      ),
    );
    const result = await saveCanopyCloudApiKeyHandler(
      {},
      { apiKey: 'csk_manual' },
    );

    expect(result).toMatchObject({
      status: {
        authenticated: false,
        error:
          'A manual API key cannot replace a guest session. Sign in with your browser to keep your guest work.',
      },
      account: {
        authMode: 'guest',
        credentialSource: 'guest',
      },
    });
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('keeps the prior entry when save validation fails', async () => {
    mockedReadFile.mockResolvedValueOnce(
      Buffer.from(
        JSON.stringify({
          apiKey: 'csk_saved',
          capabilities: ['portal-v1'],
          createdAt: '2026-05-27T10:00:00.000Z',
          updatedAt: '2026-05-27T10:00:00.000Z',
        }),
        'utf8',
      ),
    );
    mockedFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ capabilities: ['account-v1'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const result = await saveCanopyCloudApiKeyHandler({}, { apiKey: 'bad' });

    expect(result).toMatchObject({
      status: { authenticated: false, error: 'Unauthorized' },
      account: { hasApiKey: true, capabilities: ['portal-v1'] },
    });
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('allows missing optional capabilities when saving', async () => {
    mockSuccessfulCloudProbe([
      'pipelines-crud-v1',
      'account-v1',
      'organizations-v1',
      'teams-v1',
    ]);

    await saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_valid' });

    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
  });

  it('rejects missing required capabilities without saving', async () => {
    mockSuccessfulCloudProbe(['pipelines-crud-v1', 'account-v1', 'teams-v1']);

    const result = await saveCanopyCloudApiKeyHandler(
      {},
      { apiKey: 'csk_valid' },
    );

    expect(result).toMatchObject({
      status: {
        authenticated: true,
        missingCapabilities: ['organizations-v1'],
        error:
          'Canopy Cloud is missing required capabilities: organizations-v1',
      },
      account: { hasApiKey: false },
    });
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('surfaces missing build-time base URL', async () => {
    mockedGetCanopyCloudBaseUrl.mockImplementationOnce(() => {
      throw new Error('Canopy Cloud base URL is not configured.');
    });

    const result = await validateCanopyCloudApiKeyHandler(
      {},
      { apiKey: 'csk_valid' },
    );

    expect(result).toMatchObject({
      authenticated: false,
      error: 'Canopy Cloud base URL is not configured.',
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('reports timeout errors', async () => {
    mockedFetch.mockRejectedValueOnce(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );

    const result = await validateCanopyCloudApiKeyHandler(
      {},
      { apiKey: 'csk_valid' },
    );

    expect(result).toMatchObject({
      authenticated: false,
      error: 'Canopy Cloud request timed out.',
    });
  });

  it('clears the saved key', async () => {
    const result = await clearCanopyCloudApiKeyHandler({});

    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/userData/canopy-cloud-account.enc',
      { force: true },
    );
    expect(result).toEqual({
      secureStorageStatus: {
        version: 1,
        state: 'secure',
        backend: 'gnome_libsecret',
        writeAvailable: true,
      },
      // Clearing the key is an authoritative signed-out state, not a degraded
      // read, so consumers holding last-known-good must still act on it.
      read: 'ok',
      hasApiKey: false,
      authMode: null,
      credentialSource: null,
      capabilities: [],
      organizations: [],
      teams: [],
      enforcedSettings: [],
      orgBillingStates: [],
      storageAvailable: true,
    });
  });

  it('normalizes legacy saved credentials to manual API-key mode', async () => {
    mockedReadFile.mockResolvedValueOnce(
      Buffer.from(
        JSON.stringify({
          apiKey: 'csk_legacy',
          capabilities: ['portal-v1'],
          createdAt: '2026-05-27T10:00:00.000Z',
          updatedAt: '2026-05-27T10:00:00.000Z',
        }),
        'utf8',
      ),
    );

    await expect(loadCanopyCloudAccountHandler({})).resolves.toMatchObject({
      hasApiKey: true,
      authMode: 'api_key',
      credentialSource: 'manual',
      capabilities: ['portal-v1'],
    });
  });

  it('revokes a previous OAuth desktop key after replacing it with a manual key', async () => {
    mockedReadFile.mockResolvedValueOnce(
      Buffer.from(
        JSON.stringify({
          apiKey: 'csk_old_oauth',
          authMode: 'oauth',
          credentialSource: 'oauth_desktop',
          serverApiKeyId: 'key-old',
          capabilities: ['portal-v1'],
          createdAt: '2026-05-27T10:00:00.000Z',
          updatedAt: '2026-05-27T10:00:00.000Z',
        }),
        'utf8',
      ),
    );
    mockSuccessfulCloudProbe();

    await saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_manual' });

    expect(mockRevokeCurrentOAuthDesktopKey).toHaveBeenCalledWith(
      'csk_old_oauth',
    );
    expect(mockInvalidateMobileActivationCache).toHaveBeenCalledTimes(1);
  });

  it('disconnects locally even when OAuth revocation fails', async () => {
    mockedReadFile.mockResolvedValueOnce(
      Buffer.from(
        JSON.stringify({
          apiKey: 'csk_old_oauth',
          authMode: 'oauth',
          credentialSource: 'oauth_desktop',
          serverApiKeyId: 'key-old',
          capabilities: ['portal-v1'],
          createdAt: '2026-05-27T10:00:00.000Z',
          updatedAt: '2026-05-27T10:00:00.000Z',
        }),
        'utf8',
      ),
    );
    mockRevokeCurrentOAuthDesktopKey.mockRejectedValueOnce(
      new Error('network failed'),
    );

    const result = await disconnectCanopyCloudAccountHandler({});

    expect(mockRevokeCurrentOAuthDesktopKey).toHaveBeenCalledWith(
      'csk_old_oauth',
    );
    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/userData/canopy-cloud-account.enc',
      { force: true },
    );
    expect(mockPurgeSharedContainerReplicas).toHaveBeenCalledTimes(1);
    expect(mockWithSharedContainerReplicaPurgeFence).toHaveBeenCalledTimes(1);
    expect(mockApplyEnforcedSettings).toHaveBeenCalledWith(
      expect.objectContaining({ read: 'ok', hasApiKey: false }),
    );
    expect(result).toMatchObject({ hasApiKey: false });
  });

  it.each([
    ['clear', (): ReturnType<HandlerFn> => clearCanopyCloudApiKeyHandler({})],
    [
      'disconnect',
      (): ReturnType<HandlerFn> => disconnectCanopyCloudAccountHandler({}),
    ],
  ])(
    'does not remove the canonical account or tear down after legacy %s refusal',
    async (_action, clear) => {
      mockedRm.mockImplementation((path) => {
        if (path === '/mock/userData/secure/canopy-cloud-account.enc') {
          return Promise.reject(errnoError('EACCES'));
        }
        return Promise.resolve();
      });

      await expect(clear()).rejects.toMatchObject({ code: 'EACCES' });
      expect(mockedRm).toHaveBeenCalledWith(
        '/mock/userData/secure/canopy-cloud-account.enc',
        { force: true },
      );
      expect(mockedRm).not.toHaveBeenCalledWith(
        '/mock/userData/canopy-cloud-account.enc',
        { force: true },
      );
      expect(mockRevokeCurrentOAuthDesktopKey).not.toHaveBeenCalled();
      expect(mockApplyEnforcedSettings).not.toHaveBeenCalled();
    },
  );

  it('retains cloud ciphertext and skips local teardown if storage locks during decrypt', async () => {
    mockedReadFile.mockResolvedValue(Buffer.from('retained-ciphertext'));
    mockedDecryptString.mockImplementationOnce(() => {
      mockedIsEncryptionAvailable.mockReturnValue(false);
      throw new Error('private native diagnostic');
    });
    await expect(
      resetUnreadableCanopyCloudAccountHandler({}),
    ).rejects.toMatchObject({ code: 'SECURE_STORAGE_DECRYPT_FAILED' });
    expect(mockedRename).not.toHaveBeenCalled();
    expect(mockPurgeSharedContainerReplicas).not.toHaveBeenCalled();
    expect(mockInvalidateMobileActivationCache).not.toHaveBeenCalled();
    expect(mockRefreshFeatureFlagContext).not.toHaveBeenCalled();
    expect(mockApplyEnforcedSettings).not.toHaveBeenCalled();
  });

  it.each(['invalid-data', 'native-decrypt'])(
    'resets %s account data with shared local teardown and no revocation or guest mint',
    async (failure) => {
      mockedReadFile.mockResolvedValue(Buffer.from('unreadable'));
      if (failure === 'native-decrypt') {
        mockedDecryptString.mockImplementation(() => {
          throw new Error('wrong identity');
        });
      } else
        mockedDecryptString.mockReturnValue(JSON.stringify({ apiKey: 42 }));
      mockIsFeatureEnabled.mockReturnValue(true);

      const result = await resetUnreadableCanopyCloudAccountHandler({});

      expect(result).toMatchObject({
        status: 'reset',
        account: { read: 'ok', hasApiKey: false },
      });
      expect((result as { backupFileName: string }).backupFileName).toMatch(
        /^canopy-cloud-account\.enc\.bak-/,
      );
      expect(mockPurgeSharedContainerReplicas).toHaveBeenCalledTimes(1);
      expect(mockInvalidateMobileActivationCache).toHaveBeenCalledTimes(1);
      expect(mockRefreshFeatureFlagContext).toHaveBeenCalledTimes(1);
      expect(mockApplyEnforcedSettings).toHaveBeenCalledWith(
        expect.objectContaining({ read: 'ok', hasApiKey: false }),
      );
      expect(mockRevokeCurrentOAuthDesktopKey).not.toHaveBeenCalled();
      expect(mockedMintGuest).not.toHaveBeenCalled();
    },
  );

  it('retries local teardown when the unreadable file was already removed by an earlier recovery attempt', async () => {
    mockedReadFile.mockRejectedValue(missingFileError());

    const result = await resetUnreadableCanopyCloudAccountHandler({});

    expect(result).toMatchObject({
      status: 'not-needed',
      account: { read: 'ok', hasApiKey: false },
    });
    expect(mockPurgeSharedContainerReplicas).not.toHaveBeenCalled();
    expect(mockInvalidateMobileActivationCache).toHaveBeenCalledTimes(1);
    expect(mockRefreshFeatureFlagContext).toHaveBeenCalledTimes(1);
    expect(mockApplyEnforcedSettings).toHaveBeenCalledWith(
      expect.objectContaining({ read: 'ok', hasApiKey: false }),
    );
  });

  it('does not tear down a readable account when recovery is no longer needed', async () => {
    mockedReadFile.mockResolvedValueOnce(
      Buffer.from(
        JSON.stringify({
          apiKey: 'csk_recovered_elsewhere',
          authMode: 'oauth',
          credentialSource: 'oauth_desktop',
          capabilities: ['portal-v1'],
          createdAt: '2026-05-27T10:00:00.000Z',
          updatedAt: '2026-05-27T10:00:00.000Z',
        }),
        'utf8',
      ),
    );

    const result = await resetUnreadableCanopyCloudAccountHandler({});

    expect(result).toMatchObject({
      status: 'not-needed',
      account: { read: 'ok', hasApiKey: true },
    });
    expect(mockInvalidateMobileActivationCache).not.toHaveBeenCalled();
    expect(mockRefreshFeatureFlagContext).not.toHaveBeenCalled();
    expect(mockApplyEnforcedSettings).not.toHaveBeenCalled();
  });

  it('preserves the old identity when replica purge fails before disconnect', async () => {
    mockSuccessfulCloudProbe(undefined, 'account-1');
    await saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_first' });
    mockPurgeSharedContainerReplicas.mockClear();
    mockWithSharedContainerReplicaPurgeFence.mockClear();
    const purgeFailure = new Error('replica purge failed');
    mockPurgeSharedContainerReplicas.mockRejectedValueOnce(purgeFailure);

    await expect(disconnectCanopyCloudAccountHandler({})).rejects.toBe(
      purgeFailure,
    );

    expect(mockWithSharedContainerReplicaPurgeFence).toHaveBeenCalledTimes(1);

    await expect(loadCanopyCloudAccountHandler({})).resolves.toMatchObject({
      hasApiKey: true,
      account: { id: 'account-1' },
    });
    expect(mockedRm).not.toHaveBeenCalledWith(
      '/mock/userData/canopy-cloud-account.enc',
      { force: true },
    );

    mockSuccessfulCloudProbe(undefined, 'account-2');
    await saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_second' });

    expect(mockPurgeSharedContainerReplicas).toHaveBeenCalledTimes(2);
  });

  // Path-keyed read mock so disconnect's account read and the preferences read
  // resolve by file rather than by fragile call ordering.
  const mockAccountAndPrefsReads = (prefs: Record<string, unknown>): void => {
    const accountBuf = Buffer.from(
      JSON.stringify({
        apiKey: 'csk_old_oauth',
        authMode: 'oauth',
        credentialSource: 'oauth_desktop',
        serverApiKeyId: 'key-old',
        capabilities: ['portal-v1'],
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:00:00.000Z',
      }),
      'utf8',
    );
    // Persisted preferences are a versioned `{ version, preferences }` file;
    // the wrong shape makes the store treat the read as corrupt and recover to
    // empty defaults.
    const prefsStr = JSON.stringify({ version: 1, preferences: prefs });
    mockedReadFile.mockImplementation((target): Promise<Buffer | string> => {
      const filePath = typeof target === 'string' ? target : '';
      // The encrypted account file is read as a Buffer (then decrypted);
      // preferences.json is read as a UTF-8 string.
      if (filePath.includes('canopy-cloud-account')) {
        return Promise.resolve(accountBuf);
      }
      if (filePath.endsWith('/preferences.json')) {
        return Promise.resolve(prefsStr);
      }
      return Promise.reject(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    });
  };

  it('falls back to an anonymous guest session on disconnect when guest mode is enabled and guest consent is recorded', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    mockAccountAndPrefsReads({
      guestConsentAcceptedAt: '2026-07-07T00:00:00.000Z',
      guestConsentTosVersion: '2026-07-06',
    });
    mockedMintGuest.mockResolvedValue(GUEST_MINT_RESULT);

    const result = await disconnectCanopyCloudAccountHandler({});

    expect(mockedMintGuest).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      hasApiKey: true,
      credentialSource: 'guest',
    });
  });

  it('treats the first-run legal consent as the guest-consent basis when no explicit guest consent exists', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    // No guest consent, but the blocking first-run legal consent is present.
    mockAccountAndPrefsReads({
      legalConsentAcceptedAt: '2026-07-07T12:49:31.519Z',
      legalConsentTosVersion: '2026-07-06',
    });
    mockedMintGuest.mockResolvedValue(GUEST_MINT_RESULT);

    const result = await disconnectCanopyCloudAccountHandler({});

    // The first-run legal consent is a sufficient basis, so a guest is still
    // minted even without an explicit guest consent record.
    expect(mockedMintGuest).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      hasApiKey: true,
      credentialSource: 'guest',
    });
  });

  it('leaves stored activity sharing untouched when a guest session starts', async () => {
    // A guest is a free account; plan state never rewrites sharing, so a
    // fresh guest keeps its stored Off.
    const storedSharing = {
      transcripts: 'off',
      plans: 'off',
      metadata: 'off',
      summaries: 'off',
    };
    let prefsStr = JSON.stringify({
      version: 1,
      preferences: { telemetrySharing: storedSharing },
    });
    mockedReadFile.mockImplementation((target): Promise<Buffer | string> => {
      const filePath = typeof target === 'string' ? target : '';
      if (filePath.endsWith('/preferences.json')) {
        return Promise.resolve(prefsStr);
      }
      return Promise.reject(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    });
    mockedWriteFile.mockImplementation((target, data) => {
      if (
        typeof target === 'string' &&
        target.includes('preferences.json') &&
        typeof data === 'string'
      ) {
        prefsStr = data;
      }
      return Promise.resolve();
    });
    // The preferences writer stats the target, writes a temp file, then
    // renames it into place; the temp write above already captured the body.
    jest.mocked(stat).mockRejectedValue(missingFileError());
    jest.mocked(renameWithRetry).mockResolvedValue(undefined);
    mockedMintGuest.mockResolvedValue(GUEST_MINT_RESULT);
    const startGuestSessionHandler = getRegisteredHandler(
      mockedRegisterIpcHandler.mock.calls,
      'settings:start-canopy-guest-session',
    );

    await startGuestSessionHandler(
      {},
      { acceptedAt: '2026-10-06T00:00:00.000Z', tosVersion: '2026-07-06' },
    );

    expect(mockedMintGuest).toHaveBeenCalledTimes(1);
    const saved: unknown = JSON.parse(prefsStr);
    expect(saved).toMatchObject({
      preferences: {
        guestConsentAcceptedAt: '2026-10-06T00:00:00.000Z',
        telemetrySharing: storedSharing,
      },
    });
    expect(saved).not.toHaveProperty('preferences.telemetrySharingTier');
  });

  it('stays signed out on disconnect when guest mode is disabled', async () => {
    mockIsFeatureEnabled.mockReturnValue(false);
    mockedReadFile.mockResolvedValueOnce(
      Buffer.from(
        JSON.stringify({
          apiKey: 'csk_old_oauth',
          authMode: 'oauth',
          credentialSource: 'oauth_desktop',
          serverApiKeyId: 'key-old',
          capabilities: ['portal-v1'],
          createdAt: '2026-05-27T10:00:00.000Z',
          updatedAt: '2026-05-27T10:00:00.000Z',
        }),
        'utf8',
      ),
    );

    const result = await disconnectCanopyCloudAccountHandler({});

    expect(mockedMintGuest).not.toHaveBeenCalled();
    expect(result).toMatchObject({ hasApiKey: false });
  });

  it('refuses to destroy a guest credential on disconnect and returns it unchanged', async () => {
    // Guest mode is enabled, but the stored credential is already a guest token.
    // A disconnect must be a no-op: destroying a device-scoped guest token
    // cannot be undone in the same state, so it must not clear + re-mint.
    mockIsFeatureEnabled.mockReturnValue(true);
    mockedReadFile.mockResolvedValueOnce(
      Buffer.from(
        JSON.stringify({
          apiKey: 'csk_guest_device',
          authMode: 'guest',
          credentialSource: 'guest',
          serverApiKeyId: 'guest-key-1',
          capabilities: ['account-v1'],
          createdAt: '2026-07-07T00:00:00.000Z',
          updatedAt: '2026-07-07T00:00:00.000Z',
        }),
        'utf8',
      ),
    );

    const result = await disconnectCanopyCloudAccountHandler({});

    expect(result).toMatchObject({
      hasApiKey: true,
      credentialSource: 'guest',
    });
    // No token deletion, no OAuth revocation, no guest re-mint.
    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockRevokeCurrentOAuthDesktopKey).not.toHaveBeenCalled();
    expect(mockedMintGuest).not.toHaveBeenCalled();
  });

  it('refuses to destroy a guest credential when only authMode is guest (legacy/normalized)', async () => {
    // Defense in depth: a legacy or normalized entry can carry
    // `authMode: 'guest'` while `credentialSource` normalizes to 'manual'
    // (normalizeCredentialSource defaults unknown/missing values to 'manual').
    // The disconnect guard must still no-op so the device-scoped guest token is
    // never revoked or cleared.
    mockIsFeatureEnabled.mockReturnValue(true);
    mockedReadFile.mockResolvedValueOnce(
      Buffer.from(
        JSON.stringify({
          apiKey: 'csk_guest_device',
          authMode: 'guest',
          // credentialSource intentionally omitted → normalizes to 'manual'.
          serverApiKeyId: 'guest-key-1',
          capabilities: ['account-v1'],
          createdAt: '2026-07-07T00:00:00.000Z',
          updatedAt: '2026-07-07T00:00:00.000Z',
        }),
        'utf8',
      ),
    );

    const result = await disconnectCanopyCloudAccountHandler({});

    expect(result).toMatchObject({ hasApiKey: true });
    // No token deletion, no OAuth revocation, no guest re-mint.
    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockRevokeCurrentOAuthDesktopKey).not.toHaveBeenCalled();
    expect(mockedMintGuest).not.toHaveBeenCalled();
  });

  it('delegates OAuth login and cancel handlers', async () => {
    await expect(startCanopyCloudOAuthLoginHandler({})).resolves.toMatchObject({
      status: { authenticated: true },
      account: {
        authMode: 'oauth',
        credentialSource: 'oauth_desktop',
      },
    });

    await cancelCanopyCloudOAuthLoginHandler({});

    expect(mockStartCanopyCloudOAuthLogin).toHaveBeenCalled();
    expect(mockCancelCanopyCloudOAuthLogin).toHaveBeenCalled();
  });

  it('cancels during guest preparation without opening a browser later', async () => {
    let releaseMint: () => void = () => undefined;
    const activeGuestMint = new Promise<void>((resolve) => {
      releaseMint = resolve;
    });
    const release = jest.fn();
    mockPauseGuestMintsForRealSignIn.mockReturnValueOnce({
      activeGuestMint,
      release,
    });
    const login = startCanopyCloudOAuthLoginHandler({});
    const outcome = login.then(
      () => 'signed-in',
      () => 'cancelled',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await cancelCanopyCloudOAuthLoginHandler({});
    let timer: NodeJS.Timeout | undefined;
    try {
      expect(
        await Promise.race([
          outcome,
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve('still preparing'), 1000);
          }),
        ]),
      ).toBe('cancelled');
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeout(timer);
      releaseMint();
      await outcome;
    }
    expect(mockStartCanopyCloudOAuthLogin).not.toHaveBeenCalled();
  });

  it('returns the authoritative OAuth snapshot without re-probing the account', async () => {
    mockStartCanopyCloudOAuthLogin.mockResolvedValueOnce({
      status: {
        authenticated: true,
        capabilities: ['account-v1', 'memorySearch'],
      },
      account: {
        hasApiKey: true,
        credentialSource: 'oauth_desktop',
        account: { id: 'fresh-oauth' },
      },
    });
    await expect(startCanopyCloudOAuthLoginHandler({})).resolves.toMatchObject({
      account: { account: { id: 'fresh-oauth' } },
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('does not hold a completed OAuth login behind revocation of the previous key', async () => {
    mockedReadFile.mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          apiKey: 'csk_previous_oauth',
          authMode: 'oauth',
          credentialSource: 'oauth_desktop',
          createdAt: '2026-09-10T00:00:00.000Z',
          updatedAt: '2026-09-10T00:00:00.000Z',
        }),
      ),
    );
    let releaseRevoke: () => void = () => undefined;
    mockRevokeCurrentOAuthDesktopKey.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseRevoke = resolve;
      }),
    );
    const login = startCanopyCloudOAuthLoginHandler({});
    const outcome = login.then(() => 'signed-in');
    let timer: NodeJS.Timeout | undefined;
    try {
      expect(
        await Promise.race([
          outcome,
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve('still revoking'), 1000);
          }),
        ]),
      ).toBe('signed-in');
      expect(mockRevokeCurrentOAuthDesktopKey).toHaveBeenCalledWith(
        'csk_previous_oauth',
      );
    } finally {
      clearTimeout(timer);
      releaseRevoke();
      await outcome;
    }
  });

  it('waits for an earlier guest mint before snapshotting OAuth link state', async () => {
    let resolveGuestMint!: () => void;
    const activeGuestMint = new Promise<void>((resolve) => {
      resolveGuestMint = resolve;
    });
    const release = jest.fn();
    mockPauseGuestMintsForRealSignIn.mockReturnValueOnce({
      activeGuestMint,
      release,
    });
    mockedReadFile.mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          apiKey: 'csk_guest',
          authMode: 'guest',
          credentialSource: 'guest',
          capabilities: ['account-v1'],
          account: {
            id: 'guest-account-1',
            name: 'Guest',
            email: 'guest@example.test',
            role: 'ADMIN',
          },
          createdAt: '2026-08-27T00:00:00.000Z',
          updatedAt: '2026-08-27T00:00:00.000Z',
        }),
        'utf8',
      ),
    );
    mockRequestGuestLinkTicket.mockResolvedValue('guest-link-ticket');

    const login = startCanopyCloudOAuthLoginHandler({});
    await Promise.resolve();
    await Promise.resolve();
    expect(mockStartCanopyCloudOAuthLogin).not.toHaveBeenCalled();

    resolveGuestMint();
    await expect(login).resolves.toMatchObject({
      status: { authenticated: true },
    });
    expect(mockRequestGuestLinkTicket).toHaveBeenCalledTimes(1);
    expect(mockStartCanopyCloudOAuthLogin).toHaveBeenCalledWith({
      guestLinkTicket: 'guest-link-ticket',
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("moves a merged guest's Ledger scopes to the account it became, and only then", async () => {
    mockedReadFile.mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          apiKey: 'csk_guest',
          authMode: 'guest',
          credentialSource: 'guest',
          capabilities: ['account-v1'],
          account: {
            id: 'guest-account-1',
            name: 'Guest',
            email: 'guest@example.test',
            role: 'ADMIN',
          },
          createdAt: '2026-08-27T00:00:00.000Z',
          updatedAt: '2026-08-27T00:00:00.000Z',
        }),
        'utf8',
      ),
    );
    mockRequestGuestLinkTicket.mockResolvedValue('guest-link-ticket');
    const signedIn = {
      status: { authenticated: true, capabilities: ['account-v1'] },
      account: {
        hasApiKey: true,
        credentialSource: 'oauth_desktop',
        account: { id: 'account-1' },
      },
    };
    mockStartCanopyCloudOAuthLogin.mockResolvedValueOnce({
      ...signedIn,
      guestDataMerged: false,
    });
    await startCanopyCloudOAuthLoginHandler({});
    expect(mockRebindLedgerGuestScopes).not.toHaveBeenCalled();

    // The sign-in is reported only once the rebind is recorded, so a quit
    // right after it cannot lose the guest's ID.
    let rebindRecorded!: () => void;
    mockRebindLedgerGuestScopes.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        rebindRecorded = resolve;
      }),
    );
    mockStartCanopyCloudOAuthLogin.mockResolvedValueOnce({
      ...signedIn,
      guestDataMerged: true,
    });
    let reported = false;
    const login = startCanopyCloudOAuthLoginHandler({}).then((response) => {
      reported = true;
      return response;
    });
    for (
      let i = 0;
      i < 8 && mockRebindLedgerGuestScopes.mock.calls.length === 0;
      i += 1
    ) {
      await Promise.resolve();
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockRebindLedgerGuestScopes).toHaveBeenCalledTimes(1);
    expect(mockRebindLedgerGuestScopes).toHaveBeenCalledWith(
      'guest-account-1',
      'account-1',
    );
    expect(reported).toBe(false);

    rebindRecorded();
    await login;
    expect(reported).toBe(true);
  });

  it('releases the guest-mint barrier after OAuth cancellation rejects the login', async () => {
    let rejectLogin!: (error: Error) => void;
    mockStartCanopyCloudOAuthLogin.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectLogin = reject;
      }),
    );
    const release = jest.fn();
    mockPauseGuestMintsForRealSignIn.mockReturnValueOnce({
      activeGuestMint: null,
      release,
    });

    const login = startCanopyCloudOAuthLoginHandler({});
    for (
      let i = 0;
      i < 8 && mockStartCanopyCloudOAuthLogin.mock.calls.length === 0;
      i += 1
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(mockStartCanopyCloudOAuthLogin).toHaveBeenCalledTimes(1);

    await cancelCanopyCloudOAuthLoginHandler({});
    rejectLogin(new Error('OAuth login cancelled.'));

    await expect(login).rejects.toThrow('OAuth login cancelled');
    expect(mockCancelCanopyCloudOAuthLogin).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('returns a storage-unavailable envelope on save', async () => {
    mockedIsEncryptionAvailable.mockReturnValue(false);

    const result = await saveCanopyCloudApiKeyHandler(
      {},
      { apiKey: 'csk_valid' },
    );

    expect(result).toMatchObject({
      status: {
        authenticated: false,
        error: 'Secure storage is unavailable for Canopy Cloud credentials.',
      },
      account: {
        storageAvailable: false,
        secureStorageFailure: {
          code: 'SECURE_STORAGE_READ_UNAVAILABLE',
          state: 'locked',
        },
      },
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Per-org billing gate on the org credit pool (CAN-2311).
//
// `loadOrgAiCreditsSpendable` is the single chokepoint for org credit coverage:
// `loadNativeAiCreditsAvailability` and, through it, `getAiCreditsRoutingContext`
// both compose their org signals from it. Gating here keeps the decision keyed
// to ONE org id.
// ---------------------------------------------------------------------------
describe('loadOrgAiCreditsSpendable', () => {
  const SPENDABLE = {
    hasSpendableHeadroom: true,
    hasBalanceNow: true,
    canReplenish: true,
    orgCreditPoolCapable: true,
    balanceCredits: 100,
    balanceUsd: 60,
    hasPaymentMethodOnFile: true,
    billingActive: true,
  };
  const NO_COVERAGE = {
    hasSpendableHeadroom: false,
    hasBalanceNow: false,
    canReplenish: false,
    orgCreditPoolCapable: false,
    balanceCredits: 0,
    balanceUsd: 0,
    hasPaymentMethodOnFile: false,
    billingActive: false,
  };

  function seedAccount(orgBillingStates: unknown): void {
    invalidateCanopyCloudAccountCache();
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockedReadFile.mockResolvedValue(Buffer.from('encrypted'));
    mockedDecryptString.mockReturnValue(
      JSON.stringify({
        apiKey: 'csk_test',
        capabilities: [],
        organizations: [],
        teams: [],
        orgBillingStates,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequestCanopyCloudJson.mockResolvedValue(SPENDABLE);
    seedAccount([
      {
        organizationId: 'org-lapsed',
        organizationName: 'Lapsed Co',
        teamsEntitled: false,
      },
      {
        organizationId: 'org-healthy',
        organizationName: 'Healthy Co',
        teamsEntitled: true,
      },
    ]);
  });

  afterEach(() => {
    invalidateCanopyCloudAccountCache();
  });

  // The cached lapse verdict is ADVISORY, not routing state. Short-circuiting
  // on it stranded a customer who had just restored billing: the local snapshot
  // refreshes on a ~20-minute background interval, so a paid-up org kept being
  // told it had no coverage for up to that long. The server refuses a genuinely
  // lapsed org on its own, so it is asked unconditionally.
  it('asks the server even when the cached snapshot says the org is lapsed', async () => {
    await expect(loadOrgAiCreditsSpendable('org-lapsed')).resolves.toEqual(
      SPENDABLE,
    );
    expect(mockRequestCanopyCloudJson).toHaveBeenCalled();
  });

  it('reports no coverage when the spendable request fails', async () => {
    // Offline or a server error: report no coverage rather than throwing, so
    // the "never throws" contract the callers rely on still holds.
    mockRequestCanopyCloudJson.mockRejectedValue(new Error('offline'));

    await expect(loadOrgAiCreditsSpendable('org-lapsed')).resolves.toEqual(
      NO_COVERAGE,
    );
  });

  // The load-bearing invariant: per-org, never a global kill switch.
  it('still reports the healthy org spendable while another org is lapsed', async () => {
    await expect(loadOrgAiCreditsSpendable('org-healthy')).resolves.toEqual(
      SPENDABLE,
    );
    expect(mockRequestCanopyCloudJson).toHaveBeenCalled();
  });

  it('fails open for an org with no billing state and when the key is absent', async () => {
    await expect(loadOrgAiCreditsSpendable('org-unknown')).resolves.toEqual(
      SPENDABLE,
    );

    seedAccount(undefined);
    await expect(loadOrgAiCreditsSpendable('org-lapsed')).resolves.toEqual(
      SPENDABLE,
    );
  });

  // A failed org probe returns the all-false payload, which is shaped EXACTLY
  // like a genuine "this org funds nothing" answer. `resolveAiCreditsCoverage`
  // suppresses the purchase CTA only on `inconclusive`, so without propagating
  // the failed read a healthy org member whose probe merely timed out is
  // classified self-serve and invited to buy personal credits they do not need.
  describe('consolidated availability when an org probe fails', () => {
    /**
     * `loadCanopyCloudAiCredits` requests `/api/v1/ai-credits/subscription`
     * and `/api/v1/ai-credits/balance` directly, so the resolved value IS the
     * `AiCreditsBalance` — not a wrapper carrying a `balance` key.
     */
    function balancePayload(eligible: boolean): unknown {
      return { credits: eligible ? 100 : 0, eligible, source: 'native' };
    }

    function seedAccountWithOrgs(): void {
      invalidateCanopyCloudAccountCache();
      mockedIsEncryptionAvailable.mockReturnValue(true);
      mockedReadFile.mockResolvedValue(Buffer.from('encrypted'));
      mockedDecryptString.mockReturnValue(
        JSON.stringify({
          apiKey: 'csk_test',
          capabilities: [],
          organizations: [
            {
              id: 'org-healthy',
              name: 'Healthy Co',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          teams: [],
          orgBillingStates: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
    }

    it('marks the read inconclusive rather than reporting no org coverage', async () => {
      seedAccountWithOrgs();
      // Balance call succeeds, the org spendable probe does not.
      mockRequestCanopyCloudJson.mockImplementation((path: string) =>
        path.includes('/billing/credits/spendable')
          ? Promise.reject(new Error('timeout'))
          : Promise.resolve(balancePayload(false)),
      );

      const availability = await loadNativeAiCreditsAvailability({
        kind: 'organization',
        organizationId: 'org-healthy',
      });

      expect(availability.inconclusive).toBe(true);
      expect(availability.orgSpendable).toBe(false);
    });

    it('treats an org spendable 404 as a conclusive "no coverage"', async () => {
      // The endpoint returns 404 when native billing is disabled for the org or
      // the caller is not a member — an ANSWER, not a failure, and the same
      // reading the UD-account composition already gives a 404.
      //
      // Marking it unresolved makes the whole payload `inconclusive`, which
      // suppresses the purchase CTA and shows "we couldn't check your account".
      // That state is UNCLEARABLE: every retry returns 404 again, so a user
      // with no personal credits in such an org could never reach the purchase
      // path that would actually fix them.
      seedAccountWithOrgs();
      mockRequestCanopyCloudJson.mockImplementation((path: string) =>
        path.includes('/billing/credits/spendable')
          ? Promise.reject(
              new mockCanopyCloudClientError(
                'http-error',
                'Organization not found',
                404,
              ),
            )
          : Promise.resolve(balancePayload(false)),
      );

      const availability = await loadNativeAiCreditsAvailability({
        kind: 'organization',
        organizationId: 'org-healthy',
      });

      expect(availability.inconclusive).toBeUndefined();
      expect(availability.orgSpendable).toBe(false);
      // A 404 is not a pool balance; the sidebar must not show 0.00.
      expect(availability.ownerOrganizationBalanceCredits).toBeUndefined();
    });

    it('still marks a NON-404 org probe failure inconclusive', async () => {
      // The other side of the split: a 500 or a network error genuinely means
      // "we could not ask", and must keep suppressing the purchase CTA.
      seedAccountWithOrgs();
      mockRequestCanopyCloudJson.mockImplementation((path: string) =>
        path.includes('/billing/credits/spendable')
          ? Promise.reject(
              new mockCanopyCloudClientError(
                'http-error',
                'Internal Server Error',
                500,
              ),
            )
          : Promise.resolve(balancePayload(false)),
      );

      const availability = await loadNativeAiCreditsAvailability({
        kind: 'organization',
        organizationId: 'org-healthy',
      });

      expect(availability.inconclusive).toBe(true);
    });

    it('leaves a fully resolved read conclusive', async () => {
      seedAccountWithOrgs();
      mockRequestCanopyCloudJson.mockImplementation((path: string) =>
        path.includes('/billing/credits/spendable')
          ? Promise.resolve(SPENDABLE)
          : Promise.resolve(balancePayload(false)),
      );

      const availability = await loadNativeAiCreditsAvailability({
        kind: 'organization',
        organizationId: 'org-healthy',
      });

      expect(availability.inconclusive).toBeUndefined();
      expect(availability.orgSpendable).toBe(true);
      expect(availability.ownerOrganizationBalanceCredits).toBe(
        SPENDABLE.balanceCredits,
      );
    });

    // The marker must not be so eager that it erases coverage we ALREADY
    // confirmed. `resolveAiCreditsCoverage` tests `inconclusive` before
    // `personalEligible`, so marking it here would return `canSpendCredits:
    // false` for a funded user — costing them the "switch and resume on AI
    // Credits" offer during an unrelated org outage.
    it('stays conclusive when the personal balance already covers the user', async () => {
      seedAccountWithOrgs();
      mockRequestCanopyCloudJson.mockImplementation((path: string) =>
        path.includes('/billing/credits/spendable')
          ? Promise.reject(new Error('timeout'))
          : Promise.resolve(balancePayload(true)),
      );

      const availability = await loadNativeAiCreditsAvailability({
        kind: 'organization',
        organizationId: 'org-healthy',
      });

      expect(availability.inconclusive).toBeUndefined();
      expect(availability.personalEligible).toBe(true);
    });

    // The symmetric half: the personal ledger reports a transient failure as
    // `balance: null` + a non-null `error`, which would otherwise collapse to
    // "not eligible" and show a purchase CTA to an already-funded user.
    it('marks a failed personal balance read inconclusive for an account with no orgs', async () => {
      invalidateCanopyCloudAccountCache();
      mockedIsEncryptionAvailable.mockReturnValue(true);
      mockedReadFile.mockResolvedValue(Buffer.from('encrypted'));
      mockedDecryptString.mockReturnValue(
        JSON.stringify({
          apiKey: 'csk_test',
          capabilities: [],
          organizations: [],
          teams: [],
          orgBillingStates: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
      mockRequestCanopyCloudJson.mockRejectedValue(new Error('offline'));

      const availability = await loadNativeAiCreditsAvailability();

      expect(availability.inconclusive).toBe(true);
      expect(availability.personalEligible).toBe(false);
    });
  });
});

// CAN-2311. `reprobeAndApplyCanopyCloudEnforcedSettings` reports whether PER-ORG
// BILLING STATE was genuinely refreshed from the server, which is narrower than
// "the probe ran". `TelemetrySyncService.confirmLapseWithFreshSnapshot()` uses
// that boolean as the precondition for an IRREVERSIBLE queue delete, so a probe
// against a server that never sends the field must report `false` and leave the
// cached snapshot alone.
//
// The regression these pin: normalizing an absent field to `[]` inside
// `probeCanopyCloud` makes `status.orgBillingStates` always defined, so the
// `!== undefined` check returns `true` for ANY authenticated probe and the
// guard silently does no work.
describe('reprobeAndApplyCanopyCloudEnforcedSettings — orgBillingStates presence', () => {
  const CACHED_STATES = [
    {
      organizationId: 'org-lapsed',
      organizationName: 'Lapsed Co',
      teamsEntitled: false,
    },
  ];

  function seedStoredAccount(): void {
    invalidateCanopyCloudAccountCache();
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockedReadFile.mockResolvedValue(Buffer.from('encrypted'));
    mockedDecryptString.mockReturnValue(
      JSON.stringify({
        apiKey: 'csk_test',
        capabilities: [],
        organizations: [],
        teams: [],
        orgBillingStates: CACHED_STATES,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
  }

  /** Two-call probe: capabilities, then the account payload. */
  function mockProbe(accountPayload: Record<string, unknown>): void {
    mockedFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            capabilities: [
              'pipelines-crud-v1',
              'account-v1',
              'organizations-v1',
              'teams-v1',
              'portal-v1',
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(accountPayload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
  }

  const BASE_ACCOUNT: Record<string, unknown> = {
    account: {
      id: 'account-1',
      name: 'Cloud Admin',
      email: 'admin@example.test',
      role: 'ADMIN',
    },
    organizations: [],
    teams: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedEncryptString.mockImplementation((text: string) => Buffer.from(text));
    mockedWriteFile.mockResolvedValue(undefined);
    seedStoredAccount();
  });

  afterEach(() => {
    invalidateCanopyCloudAccountCache();
  });

  it('keeps the newer membership when overlapping refreshes finish in request order', async () => {
    let finishOlder!: (response: Response) => void;
    let finishNewer!: (response: Response) => void;
    let accountCalls = 0;
    const reply = (organizations: string[]): Response =>
      new Response(
        JSON.stringify({
          ...BASE_ACCOUNT,
          organizations: organizations.map((id) => ({
            id,
            name: id,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          })),
          orgBillingStates: [],
        }),
      );
    mockedFetch.mockReset().mockImplementation(async (url) => {
      const requestUrl =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (requestUrl.includes('/.well-known/'))
        return new Response(
          JSON.stringify({
            capabilities: [
              'pipelines-crud-v1',
              'account-v1',
              'organizations-v1',
              'teams-v1',
              'portal-v1',
            ],
          }),
        );
      accountCalls += 1;
      return new Promise<Response>((resolve) => {
        if (accountCalls === 1) finishOlder = resolve;
        else finishNewer = resolve;
      });
    });
    const older = reprobeAndApplyCanopyCloudEnforcedSettings();
    for (let i = 0; i < 10 && accountCalls === 0; i += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(accountCalls).toBe(1);
    const newer = reprobeAndApplyCanopyCloudEnforcedSettings();
    const coalesced = reprobeAndApplyCanopyCloudEnforcedSettings();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(accountCalls).toBe(1);
    finishOlder(reply(['old-org']));
    await older;
    for (let i = 0; i < 10 && accountCalls < 2; i += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(accountCalls).toBe(2);
    finishNewer(reply(['old-org', 'new-org']));
    await Promise.all([newer, coalesced]);
    expect(accountCalls).toBe(2);
    await expect(loadCanopyCloudAccountHandler({})).resolves.toMatchObject({
      organizations: [{ id: 'old-org' }, { id: 'new-org' }],
    });
  });

  it('keeps the 15-second request deadline active while reading a response body', async () => {
    jest.useFakeTimers();
    try {
      mockedFetch
        .mockReset()
        .mockImplementation((_url, init): Promise<Response> => {
          const body = new ReadableStream<Uint8Array>({
            start(controller): void {
              init?.signal?.addEventListener(
                'abort',
                () =>
                  controller.error(
                    Object.assign(new Error('aborted'), { name: 'AbortError' }),
                  ),
                { once: true },
              );
            },
          });
          return Promise.resolve(new Response(body));
        });
      const pending = reprobeAndApplyCanopyCloudEnforcedSettings();
      await jest.advanceTimersByTimeAsync(15_000);
      expect(mockedFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      await expect(pending).resolves.toBe(false);
      expect(mockedWriteFile).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['disconnect', 'replacement'])(
    'does not apply stale cached enforcement after %s during an offline refresh',
    async (change) => {
      let finish!: (response: Response) => void;
      mockedFetch.mockReset().mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      );
      const pending = reprobeAndApplyCanopyCloudEnforcedSettings();
      for (let i = 0; i < 10 && mockedFetch.mock.calls.length === 0; i += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      if (change === 'disconnect')
        await disconnectCanopyCloudAccountHandler({});
      else {
        mockProbe({
          ...BASE_ACCOUNT,
          account: {
            id: 'replacement-account',
            name: 'Replacement',
            email: 'replacement@example.test',
            role: 'ADMIN',
          },
        });
        await saveCanopyCloudApiKeyHandler({}, { apiKey: 'csk_replacement' });
      }
      mockApplyEnforcedSettings.mockClear();
      finish(
        new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await expect(pending).resolves.toBe(false);
      expect(mockApplyEnforcedSettings).not.toHaveBeenCalled();
    },
  );

  it('returns false when the server response OMITS orgBillingStates', async () => {
    mockProbe({ ...BASE_ACCOUNT });

    await expect(reprobeAndApplyCanopyCloudEnforcedSettings()).resolves.toBe(
      false,
    );
  });

  it('notifies account subscribers only when a refresh changes the account', async () => {
    const listener = jest.fn();
    const confirmed = jest.fn();
    const unsubscribe = subscribeCanopyCloudAccountChanges(listener);
    const unsubscribeConfirmed =
      subscribeCanopyCloudAccountConfirmations(confirmed);
    try {
      mockProbe({ ...BASE_ACCOUNT, orgBillingStates: [] });
      await reprobeAndApplyCanopyCloudEnforcedSettings();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(confirmed).not.toHaveBeenCalled();

      // A routine refresh that returns the same account only moves updatedAt.
      mockProbe({ ...BASE_ACCOUNT, orgBillingStates: [] });
      await reprobeAndApplyCanopyCloudEnforcedSettings();
      expect(mockedWriteFile).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(confirmed).toHaveBeenCalledTimes(1);

      mockProbe({
        ...BASE_ACCOUNT,
        organizations: [
          {
            id: 'org-joined',
            name: 'Joined Co',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        orgBillingStates: [],
      });
      await reprobeAndApplyCanopyCloudEnforcedSettings();
      expect(listener).toHaveBeenCalledTimes(2);
      expect(confirmed).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      unsubscribeConfirmed();
    }
  });

  it('purges replicas excluded by a confirmed organization refresh before persisting it', async () => {
    mockedDecryptString.mockReturnValue(
      JSON.stringify({
        apiKey: 'csk_test',
        capabilities: [],
        organizations: [
          {
            id: 'org-removed',
            name: 'Removed Co',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        teams: [],
        orgBillingStates: CACHED_STATES,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    mockProbe({
      ...BASE_ACCOUNT,
      organizations: [
        {
          id: 'org-retained',
          name: 'Retained Co',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    await reprobeAndApplyCanopyCloudEnforcedSettings();

    expect(
      mockReconcileSharedContainerOrganizationSnapshot,
    ).toHaveBeenCalledWith(['org-retained'], expect.any(Function));
    expect(
      mockReconcileSharedContainerOrganizationSnapshot.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      mockedWriteFile.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  function lastPersistedAccount(): Record<string, unknown> {
    const call = mockedWriteFile.mock.calls.at(-1);
    const data = call?.[1];
    if (!Buffer.isBuffer(data)) {
      throw new Error('Expected the account to be persisted');
    }
    const parsed: unknown = JSON.parse(data.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Expected a persisted account object');
    }
    return Object.fromEntries(Object.entries(parsed));
  }

  it('still persists the refreshed account when replica cleanup fails first', async () => {
    mockProbe({
      ...BASE_ACCOUNT,
      capabilities: ['account-v1', 'org-projects-v1'],
      organizations: [
        {
          id: 'org-retained',
          name: 'Retained Co',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    mockReconcileSharedContainerOrganizationSnapshot.mockRejectedValueOnce(
      new Error('Shared-container replica root identity changed'),
    );

    await reprobeAndApplyCanopyCloudEnforcedSettings();

    const persisted = lastPersistedAccount();
    expect(persisted.capabilities).toContain('org-projects-v1');
    expect(persisted.organizations).toEqual([
      expect.objectContaining({ id: 'org-retained' }),
    ]);
    expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'shared_container_org_reconcile_deferred',
      }),
    );
  });

  it('does not persist twice when the account write itself fails', async () => {
    mockProbe({
      ...BASE_ACCOUNT,
      organizations: [
        {
          id: 'org-retained',
          name: 'Retained Co',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    mockedWriteFile.mockRejectedValueOnce(new Error('disk full'));

    await expect(reprobeAndApplyCanopyCloudEnforcedSettings()).rejects.toThrow(
      'disk full',
    );
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing fields', [{ id: 'org-without-required-fields' }]],
    [
      'empty id',
      [
        {
          id: '',
          name: 'Org',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
      ],
    ],
    [
      'non-canonical id',
      [
        {
          id: ' org-1 ',
          name: 'Org',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
      ],
    ],
    [
      'duplicate ids',
      [
        {
          id: 'org-1',
          name: 'Org',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
        {
          id: 'org-1',
          name: 'Duplicate',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
      ],
    ],
  ])(
    'does not purge replicas from a malformed organization snapshot: %s',
    async (_case, organizations) => {
      mockProbe({
        ...BASE_ACCOUNT,
        organizations,
      });

      await reprobeAndApplyCanopyCloudEnforcedSettings();

      expect(
        mockReconcileSharedContainerOrganizationSnapshot,
      ).not.toHaveBeenCalled();
    },
  );

  it('does not overwrite cached per-org state when the field is omitted', async () => {
    mockProbe({ ...BASE_ACCOUNT });

    await reprobeAndApplyCanopyCloudEnforcedSettings();

    // CLEARS the cached states, and that is deliberate — the persisted write
    // and the returned boolean answer two DIFFERENT questions on this same
    // input, so they disagree here on purpose:
    //
    //   - The GATE must fail OPEN. An authenticated server that does not send
    //     the field does not support it, so nobody is lapsed. Preserving the
    //     cached lapse would make it STICKY across a server rollback, leaving
    //     an org gated locally forever — org memory off, AI credits zeroed,
    //     sharing refused — contradicting `lib/org-billing-state.ts`'s
    //     invariant that an older server means NOT lapsed.
    //   - DELETION must fail SAFE, which is why the return value is still
    //     `false` (asserted by the test above). We learned nothing about
    //     per-org state, so nothing may be irreversibly dropped.
    //
    // Asserted on the serialized payload rather than a parsed object because
    // the distinction is exactly `[]` vs. the retained array.
    const written = mockedEncryptString.mock.calls
      .map(([text]) => text)
      .filter((text) => text.includes('orgBillingStates'));
    expect(written.length).toBeGreaterThan(0);
    for (const text of written) {
      expect(text).toContain('"orgBillingStates":[]');
      expect(text).not.toContain('org-lapsed');
    }
  });

  it('leaves the cached snapshot alone when the probe never authenticates', async () => {
    // The other half of the rule: an UNAUTHENTICATED or failed probe tells us
    // nothing about the server's support for the field, so it must not clear
    // anything. Only the authenticated-but-omitted case above is evidence that
    // the server does not send it.
    mockedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(reprobeAndApplyCanopyCloudEnforcedSettings()).resolves.toBe(
      false,
    );

    const written = mockedEncryptString.mock.calls
      .map(([text]) => text)
      .filter((text) => text.includes('"orgBillingStates":[]'));
    expect(written).toHaveLength(0);
  });

  it('returns false when the field is present but not an array', async () => {
    mockProbe({ ...BASE_ACCOUNT, orgBillingStates: 'nonsense' });

    await expect(reprobeAndApplyCanopyCloudEnforcedSettings()).resolves.toBe(
      false,
    );
  });

  it('returns true when the server DOES send orgBillingStates', async () => {
    mockProbe({
      ...BASE_ACCOUNT,
      orgBillingStates: [
        {
          organizationId: 'org-healthy',
          organizationName: 'Healthy Co',
          teamsEntitled: true,
        },
      ],
    });

    await expect(reprobeAndApplyCanopyCloudEnforcedSettings()).resolves.toBe(
      true,
    );
  });

  it('returns true for a genuinely empty array, which is a real refresh', async () => {
    // An empty list is the server saying "no org is lapsed" — materially
    // different from the field being absent, and the whole reason presence has
    // to be tracked separately from the normalized value.
    mockProbe({ ...BASE_ACCOUNT, orgBillingStates: [] });

    await expect(reprobeAndApplyCanopyCloudEnforcedSettings()).resolves.toBe(
      true,
    );
  });
});

// CAN-3457. An authenticated reprobe must replace the cached memory-org
// eligibility wholesale. Preserving a cached org the server no longer
// advertises would keep searching an org the user may no longer search.
describe('reprobeAndApplyCanopyCloudEnforcedSettings — memory org eligibility', () => {
  const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  function seedStoredAccount(): void {
    invalidateCanopyCloudAccountCache();
    mockedIsEncryptionAvailable.mockReturnValue(true);
    mockedReadFile.mockResolvedValue(Buffer.from('encrypted'));
    mockedDecryptString.mockReturnValue(
      JSON.stringify({
        apiKey: 'csk_test',
        capabilities: ['memorySearch'],
        memorySearchOrganizationExternalId: ORG_A,
        memorySearchOrganizationExternalIds: [ORG_A],
        organizations: [],
        teams: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
  }

  function mockProbe(accountPayload: Record<string, unknown>): void {
    mockedFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            capabilities: [
              'pipelines-crud-v1',
              'account-v1',
              'organizations-v1',
              'teams-v1',
              'portal-v1',
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(accountPayload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
  }

  const BASE_ACCOUNT: Record<string, unknown> = {
    account: {
      id: 'account-1',
      name: 'Cloud Admin',
      email: 'admin@example.test',
      role: 'ADMIN',
    },
    organizations: [],
    teams: [],
  };

  function lastWrittenAccount(): Record<string, unknown> {
    const written = mockedEncryptString.mock.calls
      .map(([text]) => text)
      .filter((text) => text.includes('"apiKey"'));
    const last = written.at(-1);
    if (last === undefined) throw new Error('no account write recorded');
    const parsed: unknown = JSON.parse(last);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('account write was not an object');
    }
    return Object.fromEntries(Object.entries(parsed));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedEncryptString.mockImplementation((text: string) => Buffer.from(text));
    mockedWriteFile.mockResolvedValue(undefined);
    seedStoredAccount();
  });

  afterEach(() => {
    invalidateCanopyCloudAccountCache();
  });

  it('clears a cached memory org the authenticated response no longer sends', async () => {
    mockProbe({ ...BASE_ACCOUNT });

    await reprobeAndApplyCanopyCloudEnforcedSettings();

    const saved = lastWrittenAccount();
    expect(saved).not.toHaveProperty('memorySearchOrganizationExternalId');
    expect(saved).not.toHaveProperty('memorySearchOrganizationExternalIds');
  });

  it('replaces the cached memory orgs with the advertised list', async () => {
    mockProbe({
      ...BASE_ACCOUNT,
      memorySearchOrganizationExternalId: ORG_B,
      memorySearchOrganizationExternalIds: [ORG_B.toUpperCase(), 'not-a-uuid'],
    });

    await reprobeAndApplyCanopyCloudEnforcedSettings();

    const saved = lastWrittenAccount();
    expect(saved.memorySearchOrganizationExternalId).toBe(ORG_B);
    expect(saved.memorySearchOrganizationExternalIds).toEqual([ORG_B]);
  });

  it('reads an older server’s single org as a one-entry list', async () => {
    mockProbe({ ...BASE_ACCOUNT, memorySearchOrganizationExternalId: ORG_B });

    await reprobeAndApplyCanopyCloudEnforcedSettings();

    expect(lastWrittenAccount().memorySearchOrganizationExternalIds).toEqual([
      ORG_B,
    ]);
  });

  it('keeps the cached memory orgs when the probe never authenticates', async () => {
    mockedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await reprobeAndApplyCanopyCloudEnforcedSettings();

    const written = mockedEncryptString.mock.calls
      .map(([text]) => text)
      .filter((text) => text.includes('"apiKey"'));
    expect(written).toHaveLength(0);
  });
});

describe('settings:provider-carryover', () => {
  it('answers with what a known provider carries over and refuses an unknown one', async () => {
    const handler = getRegisteredHandler(
      mockedRegisterIpcHandler.mock.calls,
      'settings:provider-carryover',
    );
    const summary = {
      provider: 'claude',
      skills: 2,
      commands: 1,
      plugins: 1,
      attention: [],
    };
    mockSummarizeProviderCarryover.mockResolvedValue(summary);
    await expect(handler({}, 'claude')).resolves.toEqual(summary);
    expect(mockSummarizeProviderCarryover).toHaveBeenCalledWith('claude');
    await expect(handler({}, 'ollama')).rejects.toThrow(
      'Unknown provider for carry-over summary.',
    );
    expect(mockSummarizeProviderCarryover).toHaveBeenCalledTimes(1);
  });
});

describe('install update email preference handlers', () => {
  const PREFERENCES_PATH = '/api/v1/account/notification-preferences';

  function loadHandler(): HandlerFn {
    return getRegisteredHandler(
      mockedRegisterIpcHandler.mock.calls,
      'settings:load-install-update-email-preference',
    );
  }

  function saveHandler(): HandlerFn {
    return getRegisteredHandler(
      mockedRegisterIpcHandler.mock.calls,
      'settings:save-install-update-email-preference',
    );
  }

  it('loads the preference from the account notification preferences', async () => {
    mockRequestCanopyCloudJson.mockResolvedValueOnce({
      pushEnabled: true,
      installUpdateEmailsEnabled: false,
    });

    await expect(loadHandler()({})).resolves.toEqual({ enabled: false });
    expect(mockRequestCanopyCloudJson).toHaveBeenCalledWith(PREFERENCES_PATH);
  });

  it('rejects instead of answering a default when the load fails', async () => {
    mockRequestCanopyCloudJson.mockRejectedValueOnce(
      new mockCanopyCloudClientError('network-error', 'offline'),
    );

    await expect(loadHandler()({})).rejects.toMatchObject({
      reason: 'unresolved',
    });
  });

  it('saves a valid preference and answers the server value', async () => {
    mockRequestCanopyCloudJson.mockResolvedValueOnce({
      pushEnabled: true,
      installUpdateEmailsEnabled: false,
    });

    await expect(saveHandler()({}, { enabled: false })).resolves.toEqual({
      enabled: false,
    });
    expect(mockRequestCanopyCloudJson).toHaveBeenCalledWith(PREFERENCES_PATH, {
      method: 'PATCH',
      body: JSON.stringify({ installUpdateEmailsEnabled: false }),
    });
  });

  it.each([
    undefined,
    null,
    'false',
    {},
    { enabled: 'false' },
    { enabled: true, extra: true },
    { installUpdateEmailsEnabled: false },
  ])(
    'rejects an invalid save payload (%p) without a request',
    async (payload) => {
      await expect(saveHandler()({}, payload)).rejects.toThrow(
        'Invalid install update email preference.',
      );
      expect(mockRequestCanopyCloudJson).not.toHaveBeenCalled();
    },
  );
});
