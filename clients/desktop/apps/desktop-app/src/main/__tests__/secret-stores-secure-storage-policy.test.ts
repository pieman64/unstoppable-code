/**
 * CAN-3209 consumer integration: only Electron, filesystem, and unrelated
 * orchestration are faked. The policy, CAN-3187 wrapper, migration, and stores
 * run together. These fixtures are synthetic; this is not native keyring proof.
 */
import type {
  EnvironmentConfigData,
  ResolveEnvironmentRequest,
  SecureStorageFailure,
} from '@canopy/desktop-shared/types';

const mockFiles = new Map<string, Buffer>();
const mockReadErrors = new Map<string, Error>();
let mockBackend = 'gnome_libsecret';
let mockPlatform = 'linux';
let mockAvailable = true;
let mockDecryptFails = false;
const mockNativeDiagnostic = 'FAKE native diagnostic containing fixture-secret';
const mockEncrypt = jest.fn(
  (text: string): Buffer =>
    Buffer.from(`fake-native-v1:${Buffer.from(text).toString('base64')}`),
);
const mockDecrypt = jest.fn((data: Buffer): string => {
  if (mockDecryptFails) throw new Error(mockNativeDiagnostic);
  const text = data.toString('utf8');
  if (!text.startsWith('fake-native-v1:'))
    throw new Error(mockNativeDiagnostic);
  return Buffer.from(text.slice('fake-native-v1:'.length), 'base64').toString(
    'utf8',
  );
});
const mockProbe = jest.fn((): boolean => mockAvailable);
const mockElectron: { app: unknown; safeStorage?: unknown } = {
  app: { isReady: (): boolean => true },
};
jest.mock('electron', () => mockElectron);
jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): string => mockPlatform,
}));

function mockErrno(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
function mockRead(path: string, encoding?: unknown): Buffer | string {
  const error = mockReadErrors.get(path);
  if (error) throw error;
  const data = mockFiles.get(path);
  if (!data) throw mockErrno('ENOENT');
  return encoding ? data.toString('utf8') : Buffer.from(data);
}
/** Match async filesystem rejection semantics without unawaited async mocks. */
function mockPromise<T>(operation: () => T): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error('Unexpected fixture failure'),
    );
  }
}
const mockRemove = jest.fn(
  (path: string): Promise<void> =>
    mockPromise((): void => {
      mockFiles.delete(path);
    }),
);
const mockRename = jest.fn(
  (source: string, target: string): Promise<void> =>
    mockPromise((): void => {
      const data = mockFiles.get(source);
      if (!data) throw mockErrno('ENOENT');
      mockFiles.set(target, Buffer.from(data));
      mockFiles.delete(source);
    }),
);
const mockWrite = jest.fn(
  (
    path: string,
    data: string | Uint8Array,
    options?: { overwrite?: boolean; mode?: number; encoding?: string },
  ): Promise<void> =>
    mockPromise((): void => {
      if (options?.overwrite === false && mockFiles.has(path))
        throw mockErrno('EEXIST');
      mockFiles.set(
        path,
        typeof data === 'string' ? Buffer.from(data) : Buffer.from(data),
      );
    }),
);
jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(
    (path: string, encoding?: unknown): Promise<Buffer | string> =>
      mockPromise((): Buffer | string => mockRead(path, encoding)),
  ),
  access: jest.fn(
    (path: string): Promise<void> =>
      mockPromise((): void => {
        mockRead(path);
      }),
  ),
  mkdir: jest.fn((): Promise<void> => Promise.resolve()),
  chmod: jest.fn((): Promise<void> => Promise.resolve()),
  rm: mockRemove,
  unlink: mockRemove,
  rename: mockRename,
  writeFile: mockWrite,
}));
jest.mock('node:fs', () => ({
  readFileSync: jest.fn((path: string, encoding?: unknown): Buffer | string =>
    mockRead(path, encoding),
  ),
  statSync: jest.fn((path: string): { mtimeMs: number } => {
    mockRead(path);
    return { mtimeMs: 123456 };
  }),
}));
jest.mock('../lib/atomic-file', () => ({
  writeFileAtomically: mockWrite,
  renameWithRetry: mockRename,
}));
jest.mock('../lib/paths', () => ({
  getCanopyCloudAccountFilePath: (): string => '/fake/cloud.enc',
  getLegacyCanopyCloudAccountFilePath: (): string => '/fake/legacy/cloud.enc',
  getInternalLegacySharedCanopyCloudAccountFilePath: (): string =>
    '/fake/shared-legacy/cloud.enc',
  getGitHubPatFilePath: (): string => '/fake/pat.enc',
  getLegacyGitHubPatFilePath: (): string => '/fake/legacy/pat.enc',
  getInternalLegacySharedGitHubPatFilePath: (): string =>
    '/fake/shared-legacy/pat.enc',
  getLinearTokenFilePath: (): string => '/fake/linear.enc',
  getLegacyLinearTokenFilePath: (): string => '/fake/legacy/linear.enc',
  getInternalLegacySharedLinearTokenFilePath: (): string =>
    '/fake/shared-legacy/linear.enc',
  getMcpOAuthTokenStorePath: (): string => '/fake/mcp.json',
  getLegacyMcpOAuthTokenStorePath: (): string => '/fake/legacy/mcp.json',
  getInternalLegacySharedMcpOAuthTokenStorePath: (): string =>
    '/fake/shared-legacy/mcp.json',
  getCopilotCredentialFilePath: (): string => '/fake/copilot.enc',
  getAccountProxyCredentialStorePath: (): string => '/fake/proxy.json',
  getModelGatewayCredentialStorePath: (): string => '/fake/gateway.json',
  getLegacyModelGatewayCredentialStorePath: (): string =>
    '/fake/legacy/gateway.json',
  getInternalLegacySharedModelGatewayCredentialStorePath: (): string =>
    '/fake/shared-legacy/gateway.json',
  getSharedContainerRunEnvFilePath: (): string => '/fake/container-env.json',
}));
jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getEnvironmentConfigFilePath: (): string => '/fake/environments.json',
  getLegacyEnvironmentConfigFilePath: (): string =>
    '/fake/legacy/environments.json',
  getInternalLegacySharedEnvironmentConfigFilePath: (): string =>
    '/fake/shared-legacy/environments.json',
  getUserEnvironmentFilePath: (): string => '/fake/user-environment.json',
}));
const mockWarn = jest.fn();
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: mockWarn,
}));
const mockPurge = jest.fn((): Promise<void> => Promise.resolve());
jest.mock('../shared-containers/reconciliation-service', () => ({
  getSharedContainerReconciliationService: (): {
    withReplicaPurgeFence(operation: () => Promise<unknown>): Promise<unknown>;
  } => ({
    withReplicaPurgeFence: async (
      operation: () => Promise<unknown>,
    ): Promise<unknown> => {
      await mockPurge();
      return operation();
    },
  }),
}));
jest.mock('../canopy-cloud/config', () => ({
  CanopyCloudConfigError: class extends Error {},
  getCanopyCloudBaseUrl: (): string => 'https://cloud.example.test',
}));
jest.mock('../lib/e2e-gate', () => ({ isE2eBuild: (): boolean => false }));
const mockSecretsInjector = jest.fn<void, [() => Record<string, string>]>();
const mockEnvironmentInjector = jest.fn<
  void,
  [(context?: ResolveEnvironmentRequest) => Record<string, string>]
>();
jest.mock('../pipelines/config-paths', () => ({
  registerSecretsEnvInjector: mockSecretsInjector,
  registerUserEnvironmentInjector: mockEnvironmentInjector,
  getBundledGhBinaryPath: (): string => '/fake/gh',
  getEnhancedEnv: (): Record<string, string> => ({}),
}));

// Settings is an IPC projection with many unrelated integrations. Do not mock
// the save/read helpers, secret policy, classifier, or migration it exercises.
jest.mock('../agents/work-owner', () => ({}));
jest.mock('../plugins/provider-carryover', () => ({}));
jest.mock('../lib/github-broker', () => ({
  getGitHubBroker: (): { resetCredentials(): void } => ({
    resetCredentials: jest.fn(),
  }),
}));
jest.mock('../lib/github-permissions', () => ({}));
jest.mock('../lib/github-repo-listing', () => ({
  invalidateGitHubRepoListCache: jest.fn(),
}));
jest.mock('../lib/github-pr-listing', () => ({
  invalidatePullRequestListingCache: jest.fn(),
}));
jest.mock('../lib/github-pr-read-model', () => ({
  resetGitHubPullRequestReadModel: jest.fn(),
}));
jest.mock('../lib/github-merge-queue-read-model', () => ({
  resetGitHubMergeQueueReadModel: jest.fn(),
}));
jest.mock('../shared-containers/organization-snapshot-transition', () => ({}));
jest.mock('../canopy-cloud/authenticated-portal', () => ({}));
jest.mock('../unstoppable-domains/config', () => ({}));
jest.mock('../canopy-cloud/client', () => ({}));
jest.mock('../canopy-cloud/entitlements', () => ({}));
jest.mock('../canopy-cloud/digest-preferences', () => ({}));
jest.mock('../canopy-cloud/mobile-activation', () => ({}));
jest.mock('../services/org-enforced-settings', () => ({}));
jest.mock('../ledger/sync-host', () => ({}));
jest.mock('../lib/preferences-store', () => ({}));
const mockRefreshContext = jest.fn((): Promise<void> => Promise.resolve());
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): { refreshContext(): Promise<void> } => ({
    refreshContext: mockRefreshContext,
  }),
}));
jest.mock('../lib/e2e-mock-control-plane', () => ({}));
jest.mock('../auth/provider-auth-state', () => ({}));
jest.mock('../agents/user-supplied-credential', () => ({}));
jest.mock('../lib/github-pr-reconcile', () => ({
  invalidateReconcileViewerCache: jest.fn(),
}));
type Handler = (...args: unknown[]) => unknown;
const mockHandlers = new Map<string, Handler>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    mockHandlers.set(channel, handler);
  },
}));

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { createDefaultEnvironmentConfig } from '@canopy/desktop-shared/lib/user-environment';
import {
  getSecretStoragePolicy,
  getSecureStorageFailure,
} from '../lib/secure-storage-policy';
import { getSafeStorageStatus } from '../lib/safe-storage';
import {
  invalidateCanopyCloudAccountCache,
  loadCanopyCloudAccount,
  loadCanopyCloudAccountPublicState,
  readCanopyCloudAccountWithStatus,
  resetUnreadableCanopyCloudAccount,
  saveCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from '../lib/canopy-cloud-account-store';
import {
  invalidateTokenCache,
  readStoredPatWithStatus,
} from '../lib/github-auth';
import {
  invalidateLinearTokenCache,
  readStoredLinearTokenWithStatus,
  resolveLinearToken,
} from '../lib/linear-auth';
import { registerSettingsHandlers } from '../ipc/settings';
import {
  getMcpOAuthToken,
  saveMcpOAuthToken,
  setMcpOAuthTokensChangedListener,
  type McpOAuthTokenRecord,
} from '../mcp/oauth-token-store';
import {
  readCopilotCredential,
  saveCopilotCredential,
  type CopilotCredential,
} from '../copilot/credential-store';
import {
  loadAccountProxyCredentials,
  saveAccountProxyCredentials,
  markAccountProxyKeyRejected,
  resetAccountProxyCredentialStoreForTests,
} from '../lib/account-proxy-credential-store';
import {
  loadModelGatewayCredential,
  saveModelGatewayCredential,
  markModelGatewayCredentialRejected,
  resetModelGatewayCredentialStoreForTests,
} from '../lib/model-gateway-credential-store';
import {
  readEnvironmentConfig,
  writeEnvironmentConfig,
} from '../lib/user-environment-store';
import {
  readSharedContainerRunEnvironment,
  writeSharedContainerRunEnvironment,
} from '../shared-containers/run-env-store';
import { RemoteAccessStore } from '../remote-control/remote-access-store';
import {
  exportDeviceKeyPair,
  generateDeviceKeyPair,
} from '../remote-control/crypto/device-key';
import {
  initializeGitHubPatEnvRuntime,
  invalidateGitHubPatEnvCache,
} from '../lib/github-pat-env';
import {
  initializeUserEnvironmentRuntime,
  invalidateUserEnvironmentInjectionCache,
} from '../lib/user-environment-runtime';

const DATE = '2026-10-01T12:00:00.000Z';
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET = 'fixture-secret-old';
const REPLACEMENT = 'fixture-secret-new';
const cloud: CanopyCloudAccountEntry = {
  apiKey: SECRET,
  capabilities: ['account-v1', 'organizations-v1'],
  account: {
    id: 'fake-account',
    name: 'Fixture User',
    email: 'fixture@example.test',
    role: 'ADMIN',
  },
  organizations: [],
  enforcedSettings: [
    {
      organizationId: ORG,
      organizationName: 'Fixture Organization',
      policies: [
        {
          kind: 'model-gateway',
          baseUrl: 'https://gateway.example.test',
          models: [],
          enforced: true,
          promptCachePassthrough: true,
        },
      ],
    },
  ],
  createdAt: DATE,
  updatedAt: DATE,
};
const mcp: McpOAuthTokenRecord = {
  serverId: 'fixture-server',
  configId: 'fixture-config',
  accessToken: SECRET,
  refreshToken: 'fixture-refresh-old',
  upstreamUrl: 'https://mcp.example.test/',
  tokenType: 'Bearer',
  updatedAt: DATE,
};
const copilot: CopilotCredential = {
  version: 1,
  clientId: 'fake-client',
  host: 'github.com',
  login: 'fixture-user',
  id: '12345',
  accessToken: SECRET,
  refreshToken: 'fixture-refresh-old',
  accessTokenExpiresAt: '2026-11-01T12:00:00.000Z',
  refreshTokenExpiresAt: '2027-10-01T12:00:00.000Z',
};
function environment(secret: string): EnvironmentConfigData {
  const config = createDefaultEnvironmentConfig(DATE);
  config.environments[0].variables = [{ key: 'FIXTURE_SECRET', value: secret }];
  return config;
}
function remoteStore(): RemoteAccessStore {
  return new RemoteAccessStore({
    settingsPath: '/fake/remote.json',
    identityPath: '/fake/identity',
    secretStorage: getSecretStoragePolicy(),
  });
}
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return mockPromise((): unknown => {
    const handler = mockHandlers.get(channel);
    if (!handler) throw new Error(`Missing fixture IPC handler: ${channel}`);
    return handler({}, ...args);
  });
}
async function failureOf(
  operation: () => unknown,
): Promise<SecureStorageFailure> {
  let result: unknown;
  try {
    result = await operation();
  } catch (error) {
    const failure = getSecureStorageFailure(error);
    expect(failure).not.toBeNull();
    if (failure) return failure;
    throw error;
  }
  const failure = getSecureStorageFailure(result);
  if (failure) {
    expect(result).toMatchObject({ success: false });
    return failure;
  }
  throw new Error('Expected typed storage refusal');
}
function isFixtureRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fixtureRecord(path: string, key: string): Record<string, unknown> {
  const bytes = mockFiles.get(path);
  if (!bytes) throw new Error(`Missing JSON fixture: ${path}`);
  const parsed: unknown = JSON.parse(bytes.toString());
  if (!isFixtureRecord(parsed) || !isFixtureRecord(parsed.records)) {
    throw new Error('Invalid fixture records');
  }
  const record = parsed.records[key];
  if (!isFixtureRecord(record)) throw new Error('Missing fixture record');
  return record;
}
function snapshot(): [string, Buffer][] {
  const entries: [string, Buffer][] = Array.from(mockFiles.entries());
  return entries
    .sort(([a], [b]): number => a.localeCompare(b))
    .map(([path, bytes]): [string, Buffer] => [path, Buffer.from(bytes)]);
}
function expectNoMutation(before: [string, Buffer][]): void {
  expect(snapshot()).toEqual(before);
  expect(mockWrite).not.toHaveBeenCalled();
  expect(mockRemove).not.toHaveBeenCalled();
  expect(mockRename).not.toHaveBeenCalled();
}
function clearEffects(): void {
  mockEncrypt.mockClear();
  mockDecrypt.mockClear();
  mockWrite.mockClear();
  mockRemove.mockClear();
  mockRename.mockClear();
  mockWarn.mockClear();
  mockPurge.mockClear();
  mockRefreshContext.mockClear();
}

interface StoreCase {
  name: string;
  path: string;
  save(secret: string): Promise<unknown>;
  read(): Promise<{ value?: string | null; failure?: SecureStorageFailure }>;
  prepare?(): Promise<unknown>;
}
const stores: StoreCase[] = [
  {
    name: 'cloud account',
    path: '/fake/cloud.enc',
    save: (apiKey): ReturnType<StoreCase['save']> =>
      saveCanopyCloudAccount({ ...cloud, apiKey }),
    read: async (): ReturnType<StoreCase['read']> => {
      const result = await readCanopyCloudAccountWithStatus({ cache: false });
      if (result.status === 'ok')
        return { value: result.entry?.apiKey ?? null };
      if (result.secureStorageFailure)
        return { failure: result.secureStorageFailure };
      throw result.error;
    },
  },
  {
    name: 'PAT IPC / status read',
    path: '/fake/pat.enc',
    save: (secret): ReturnType<StoreCase['save']> =>
      invoke(IPC_CHANNELS.settingsSaveGitHubPat, secret),
    read: async (): ReturnType<StoreCase['read']> => {
      const result = await readStoredPatWithStatus();
      if (result.status === 'ok') return { value: result.value };
      if (result.status === 'storage-error') return { failure: result.failure };
      throw result.error;
    },
  },
  {
    name: 'Linear IPC / status read',
    path: '/fake/linear.enc',
    save: (secret): ReturnType<StoreCase['save']> =>
      invoke(IPC_CHANNELS.settingsSaveLinearToken, secret),
    read: async (): ReturnType<StoreCase['read']> => {
      const result = await readStoredLinearTokenWithStatus();
      if (result.status === 'ok') return { value: result.value };
      if (result.status === 'storage-error') return { failure: result.failure };
      throw result.error;
    },
  },
  {
    name: 'MCP OAuth',
    path: '/fake/mcp.json',
    save: (accessToken): ReturnType<StoreCase['save']> =>
      saveMcpOAuthToken({ ...mcp, accessToken }),
    read: async (): ReturnType<StoreCase['read']> => ({
      value:
        (await getMcpOAuthToken(mcp.serverId, mcp.configId))?.accessToken ??
        null,
    }),
  },
  {
    name: 'Copilot',
    path: '/fake/copilot.enc',
    save: (accessToken): ReturnType<StoreCase['save']> =>
      saveCopilotCredential({ ...copilot, accessToken }),
    read: async (): ReturnType<StoreCase['read']> => {
      const result = await readCopilotCredential();
      if (result.status === 'present')
        return { value: result.credential.accessToken };
      if (result.status === 'unreadable' && result.secureStorageFailure)
        return { failure: result.secureStorageFailure };
      return { value: null };
    },
  },
  {
    name: 'account proxy',
    path: '/fake/proxy.json',
    save: (managementKey): ReturnType<StoreCase['save']> =>
      saveAccountProxyCredentials('fixture-connection', {
        managementKey,
        clientKey: 'fixture-client-key',
      }),
    read: async (): ReturnType<StoreCase['read']> => ({
      value:
        (await loadAccountProxyCredentials('fixture-connection'))
          ?.managementKey ?? null,
    }),
  },
  {
    name: 'model gateway',
    path: '/fake/gateway.json',
    prepare: (): Promise<unknown> => saveCanopyCloudAccount(cloud),
    save: (apiKey): ReturnType<StoreCase['save']> =>
      saveModelGatewayCredential({
        organizationId: ORG,
        apiKey,
        baseUrlAtSave: 'https://gateway.example.test',
      }),
    read: async (): ReturnType<StoreCase['read']> => ({
      value: (await loadModelGatewayCredential(ORG))?.apiKey ?? null,
    }),
  },
  {
    name: 'environments',
    path: '/fake/environments.json',
    save: (secret): ReturnType<StoreCase['save']> =>
      writeEnvironmentConfig(environment(secret)),
    read: async (): ReturnType<StoreCase['read']> => ({
      value:
        (await readEnvironmentConfig()).data.environments[0].variables[0]
          ?.value ?? null,
    }),
  },
  {
    name: 'shared-container environment',
    path: '/fake/container-env.json',
    save: (secret): ReturnType<StoreCase['save']> =>
      writeSharedContainerRunEnvironment('fixture-container', [
        { key: 'FIXTURE_SECRET', value: secret },
      ]),
    read: async (): ReturnType<StoreCase['read']> => ({
      value:
        (await readSharedContainerRunEnvironment('fixture-container'))[0]
          ?.value ?? null,
    }),
  },
];
async function readFailure(store: StoreCase): Promise<SecureStorageFailure> {
  let result: Awaited<ReturnType<StoreCase['read']>>;
  try {
    result = await store.read();
  } catch (error) {
    const failure = getSecureStorageFailure(error);
    expect(failure).not.toBeNull();
    if (failure) return failure;
    throw error;
  }
  expect(result.failure).toBeDefined();
  if (result.failure) return result.failure;
  throw new Error(`Expected ${store.name} storage failure, not absence`);
}

beforeAll(async () => {
  mockElectron.safeStorage = {
    isEncryptionAvailable: mockProbe,
    getSelectedStorageBackend: (): string => mockBackend,
    encryptString: mockEncrypt,
    decryptString: mockDecrypt,
  };
  registerSettingsHandlers();
  initializeGitHubPatEnvRuntime();
  initializeUserEnvironmentRuntime();
  // Let real migration warmers finish before fixtures or effect counters reset.
  await new Promise<void>((resolve) => setImmediate(resolve));
});
beforeEach(() => {
  mockFiles.clear();
  mockReadErrors.clear();
  mockBackend = 'gnome_libsecret';
  mockPlatform = 'linux';
  mockAvailable = true;
  mockDecryptFails = false;
  mockProbe.mockImplementation(() => mockAvailable);
  mockEncrypt.mockImplementation((text) =>
    Buffer.from(`fake-native-v1:${Buffer.from(text).toString('base64')}`),
  );
  mockElectron.safeStorage = {
    isEncryptionAvailable: mockProbe,
    getSelectedStorageBackend: (): string => mockBackend,
    encryptString: mockEncrypt,
    decryptString: mockDecrypt,
  };
  invalidateCanopyCloudAccountCache();
  invalidateTokenCache();
  invalidateLinearTokenCache();
  invalidateGitHubPatEnvCache();
  invalidateUserEnvironmentInjectionCache();
  resetAccountProxyCredentialStoreForTests();
  resetModelGatewayCredentialStoreForTests();
  setMcpOAuthTokensChangedListener(null);
  clearEffects();
});

const denied = [
  {
    name: 'locked',
    backend: 'gnome_libsecret',
    available: false,
    state: 'locked',
  },
  {
    name: 'missing native storage',
    backend: 'gnome_libsecret',
    available: false,
    state: 'unavailable',
    missing: true,
  },
  {
    name: 'unavailable libsecret',
    backend: 'unknown',
    available: false,
    state: 'unavailable',
  },
];

describe.each(stores)('$name through real policy + native wrapper', (store) => {
  it('secure writes use native ciphertext and owner-only persistence', async () => {
    await store.prepare?.();
    await store.save(SECRET);
    expect(mockFiles.get(store.path)).toBeDefined();
    expect(mockFiles.get(store.path)?.toString()).not.toContain(SECRET);
    expect(mockWrite).toHaveBeenCalledWith(
      store.path,
      expect.anything(),
      expect.objectContaining({ mode: 0o600 }),
    );
    expect(mockEncrypt).toHaveBeenCalled();
    await expect(store.read()).resolves.toEqual({ value: SECRET });
  });

  it.each(denied)(
    'retains every exact byte when $name refuses replacement',
    async (backend) => {
      await store.prepare?.();
      await store.save(SECRET);
      // A historical source must not be deleted merely because the save fails.
      mockFiles.set(
        '/fake/legacy/unrelated.enc',
        Buffer.from('fake-legacy-byte-fixture'),
      );
      const before = snapshot();
      clearEffects();
      mockBackend = backend.backend;
      mockAvailable = backend.available;
      if (backend.missing) delete mockElectron.safeStorage;
      expect(getSafeStorageStatus().state).toBe(backend.state);
      const failure = await failureOf(() => store.save(REPLACEMENT));
      expect(failure).toMatchObject({
        version: 1,
        state: backend.state,
        retryable: true,
      });
      expectNoMutation(before);
      expect(mockEncrypt).not.toHaveBeenCalled();
      expect(mockRefreshContext).not.toHaveBeenCalled();
      mockBackend = 'gnome_libsecret';
      mockAvailable = true;
      mockElectron.safeStorage = {
        isEncryptionAvailable: mockProbe,
        getSelectedStorageBackend: (): string => mockBackend,
        encryptString: mockEncrypt,
        decryptString: mockDecrypt,
      };
      await expect(store.read()).resolves.toEqual({ value: SECRET });
      await store.save(REPLACEMENT);
      await expect(store.read()).resolves.toEqual({ value: REPLACEMENT });
    },
  );

  it('reads historical ciphertext with a read-only native facade without rewriting it', async () => {
    await store.prepare?.();
    await store.save(SECRET);
    const before = snapshot();
    clearEffects();
    mockElectron.safeStorage = {
      isEncryptionAvailable: mockProbe,
      decryptString: mockDecrypt,
    };
    await expect(store.read()).resolves.toEqual({ value: SECRET });
    expect(mockDecrypt).toHaveBeenCalled();
    expect(mockEncrypt).not.toHaveBeenCalled();
    expectNoMutation(before);
  });

  it.each([
    'locked',
    'unavailable',
    'unavailable-libsecret',
    'native-decrypt-failure',
  ])(
    'retains ciphertext on %s read failure and retries without restart',
    async (mode) => {
      await store.prepare?.();
      await store.save(SECRET);
      const before = snapshot();
      clearEffects();
      if (mode === 'locked') mockAvailable = false;
      else if (mode === 'unavailable') delete mockElectron.safeStorage;
      else if (mode === 'unavailable-libsecret') {
        mockBackend = 'unknown';
        mockAvailable = false;
      } else mockDecryptFails = true;
      const failure = await readFailure(store);
      expect(failure).toMatchObject({
        version: 1,
        operation: 'read',
        retryable: mode !== 'native-decrypt-failure',
      });
      expectNoMutation(before);
      expect(mockPurge).not.toHaveBeenCalled();
      mockAvailable = true;
      mockDecryptFails = false;
      mockBackend = 'gnome_libsecret';
      mockElectron.safeStorage = {
        isEncryptionAvailable: mockProbe,
        getSelectedStorageBackend: (): string => mockBackend,
        encryptString: mockEncrypt,
        decryptString: mockDecrypt,
      };
      await expect(store.read()).resolves.toEqual({ value: SECRET });
      expectNoMutation(before);
    },
  );

  it('retains ciphertext when native encryption throws and redacts diagnostics', async () => {
    await store.prepare?.();
    await store.save(SECRET);
    const before = snapshot();
    clearEffects();
    mockEncrypt.mockImplementation(() => {
      throw new Error(mockNativeDiagnostic);
    });
    const failure = await failureOf(() => store.save(REPLACEMENT));
    expect(failure).toMatchObject({
      version: 1,
      code: 'SECURE_STORAGE_ENCRYPT_FAILED',
      operation: 'write',
      retryable: true,
    });
    expect(JSON.parse(JSON.stringify(failure))).toEqual(failure);
    expect(JSON.stringify(failure)).not.toContain('fixture-secret');
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain(
      mockNativeDiagnostic,
    );
    expectNoMutation(before);
  });
});

describe('complete-record atomicity and non-destructive metadata', () => {
  it.each(['MCP', 'account proxy', 'environments'])(
    'retains the whole %s file if its second encrypted field fails',
    async (name) => {
      const store = stores.find(
        (entry) => entry.name === (name === 'MCP' ? 'MCP OAuth' : name),
      );
      if (!store) throw new Error('Missing atomicity fixture');
      await store.save(SECRET);
      if (name === 'MCP')
        await saveMcpOAuthToken({
          ...mcp,
          serverId: 'unrelated-server',
          accessToken: 'unrelated-fake-token',
        });
      if (name === 'account proxy')
        await saveAccountProxyCredentials('unrelated-connection', {
          managementKey: 'unrelated-fake-key',
          clientKey: null,
        });
      const before = snapshot();
      clearEffects();
      const changed = jest.fn();
      setMcpOAuthTokensChangedListener(changed);
      mockEncrypt
        .mockImplementationOnce((text) =>
          Buffer.from(`fake-native-v1:${Buffer.from(text).toString('base64')}`),
        )
        .mockImplementationOnce(() => {
          throw new Error(mockNativeDiagnostic);
        });
      await expect(
        failureOf(() => store.save(REPLACEMENT)),
      ).resolves.toMatchObject({
        code: 'SECURE_STORAGE_ENCRYPT_FAILED',
        operation: 'write',
      });
      expect(mockEncrypt).toHaveBeenCalledTimes(2);
      expectNoMutation(before);
      expect(changed).not.toHaveBeenCalled();
      await store.save(REPLACEMENT);
      await expect(store.read()).resolves.toEqual({ value: REPLACEMENT });
    },
  );

  it('MCP second-field read failure never clears or notifies a credential', async () => {
    await saveMcpOAuthToken(mcp);
    const before = snapshot();
    clearEffects();
    const changed = jest.fn();
    setMcpOAuthTokensChangedListener(changed);
    mockDecrypt
      .mockImplementationOnce((data) =>
        Buffer.from(
          data.toString().slice('fake-native-v1:'.length),
          'base64',
        ).toString(),
      )
      .mockImplementationOnce(() => {
        throw new Error(mockNativeDiagnostic);
      });
    await expect(
      failureOf(() => getMcpOAuthToken(mcp.serverId, mcp.configId)),
    ).resolves.toMatchObject({ code: 'SECURE_STORAGE_DECRYPT_FAILED' });
    expectNoMutation(before);
    expect(changed).not.toHaveBeenCalled();
    await expect(
      getMcpOAuthToken(mcp.serverId, mcp.configId),
    ).resolves.toMatchObject(mcp);
  });

  it('proxy metadata preserves ciphertext and bound-token failure aborts persistence', async () => {
    await saveAccountProxyCredentials('fixture-connection', {
      managementKey: SECRET,
      clientKey: 'fake-client-key',
    });
    const original = fixtureRecord('/fake/proxy.json', 'fixture-connection');
    clearEffects();
    await markAccountProxyKeyRejected(
      'fixture-connection',
      { code: 'unauthorized', at: 123 },
      SECRET,
    );
    const updated = fixtureRecord('/fake/proxy.json', 'fixture-connection');
    expect(updated.encryptedManagementKeyBase64).toBe(
      original.encryptedManagementKeyBase64,
    );
    expect(updated.encryptedClientKeyBase64).toBe(
      original.encryptedClientKeyBase64,
    );
    expect(mockEncrypt).not.toHaveBeenCalled();
    const before = snapshot();
    clearEffects();
    mockDecryptFails = true;
    await failureOf(() =>
      markAccountProxyKeyRejected(
        'fixture-connection',
        { code: 'blocked', at: 124 },
        SECRET,
      ),
    );
    expectNoMutation(before);
  });

  it('gateway rejection metadata never re-encrypts or changes the bound credential', async () => {
    await saveCanopyCloudAccount(cloud);
    await saveModelGatewayCredential({
      organizationId: ORG,
      apiKey: SECRET,
      baseUrlAtSave: 'https://gateway.example.test',
    });
    const original = fixtureRecord(
      '/fake/gateway.json',
      JSON.stringify(['fake-account', ORG]),
    );
    clearEffects();
    expect(
      await markModelGatewayCredentialRejected(ORG, 'Fixture HTTP 401'),
    ).toBe(true);
    const key = JSON.stringify(['fake-account', ORG]);
    const updated = fixtureRecord('/fake/gateway.json', key);
    expect(updated.encryptedApiKeyBase64).toBe(original.encryptedApiKeyBase64);
    expect(mockEncrypt).not.toHaveBeenCalled();
  });

  it.each([
    'account proxy',
    'MCP OAuth',
    'model gateway',
    'shared-container environment',
  ])(
    'does not substitute an empty %s store for parse/version/I/O failure',
    async (name) => {
      const store = stores.find((entry) => entry.name === name);
      if (!store) throw new Error('Missing malformed-store fixture');
      await store.prepare?.();
      for (const raw of [
        '{invalid-fixture-json',
        '{"version":99,"records":{},"containers":{}}',
      ]) {
        mockFiles.set(store.path, Buffer.from(raw));
        const before = snapshot();
        clearEffects();
        await expect(store.save(REPLACEMENT)).rejects.toThrow();
        expectNoMutation(before);
      }
      mockReadErrors.set(store.path, mockErrno('EACCES'));
      const before = snapshot();
      clearEffects();
      await expect(store.save(REPLACEMENT)).rejects.toThrow();
      expectNoMutation(before);
    },
  );
});

describe('environment plaintext exception remains environment-only', () => {
  it('explicit native false permits new plaintext environment values, not tokens or shared-container values', async () => {
    mockAvailable = false;
    await expect(
      writeEnvironmentConfig(environment(SECRET)),
    ).resolves.toMatchObject({ ok: true, encryptionAvailable: false });
    expect(mockFiles.get('/fake/environments.json')?.toString()).toContain(
      'plaintextVariables',
    );
    expect(mockEncrypt).not.toHaveBeenCalled();
    await expect(readEnvironmentConfig()).resolves.toMatchObject({
      encryptionAvailable: false,
    });
    const before = snapshot();
    clearEffects();
    await failureOf(() => invoke(IPC_CHANNELS.settingsSaveGitHubPat, SECRET));
    await failureOf(() => invoke(IPC_CHANNELS.settingsSaveLinearToken, SECRET));
    await failureOf(() =>
      writeSharedContainerRunEnvironment('fixture-container', [
        { key: 'FIXTURE_SECRET', value: SECRET },
      ]),
    );
    expectNoMutation(before);
  });

  it('does not convert readable plaintext into a fallback if libsecret locks after the availability decision', async () => {
    mockAvailable = false;
    await writeEnvironmentConfig(environment(SECRET));
    const before = snapshot();
    clearEffects();
    mockProbe.mockReturnValueOnce(true);
    await failureOf(() => writeEnvironmentConfig(environment(REPLACEMENT)));
    expectNoMutation(before);
    expect(mockEncrypt).not.toHaveBeenCalled();
  });

  it('probe exceptions never select plaintext and preserve existing data', async () => {
    mockAvailable = false;
    await writeEnvironmentConfig(environment(SECRET));
    const before = snapshot();
    clearEffects();
    mockProbe.mockImplementation(() => {
      throw new Error(mockNativeDiagnostic);
    });
    await expect(
      failureOf(() => writeEnvironmentConfig(environment(REPLACEMENT))),
    ).resolves.toMatchObject({
      code: 'SECURE_STORAGE_PROBE_FAILED',
      operation: 'probe',
    });
    expectNoMutation(before);
  });

  it('a later encrypted environment failing to decrypt aborts the complete file save', async () => {
    await writeEnvironmentConfig(environment(SECRET));
    const before = snapshot();
    clearEffects();
    mockDecrypt
      .mockImplementationOnce((data) =>
        Buffer.from(
          data.toString().slice('fake-native-v1:'.length),
          'base64',
        ).toString(),
      )
      .mockImplementationOnce(() => {
        throw new Error(mockNativeDiagnostic);
      });
    await expect(
      failureOf(() => writeEnvironmentConfig(environment(REPLACEMENT))),
    ).resolves.toMatchObject({ code: 'SECURE_STORAGE_DECRYPT_FAILED' });
    expectNoMutation(before);
  });
});

describe('status-aware caches recover with unchanged bytes and mtime', () => {
  it.each(['locked', 'unavailable', 'native-decrypt-failure'] as const)(
    'cloud public reads preserve %s classification and typed metadata without mutation',
    async (mode) => {
      await saveCanopyCloudAccount(cloud);
      const before = snapshot();
      clearEffects();
      invalidateCanopyCloudAccountCache();
      if (mode === 'locked') mockAvailable = false;
      else if (mode === 'unavailable') delete mockElectron.safeStorage;
      else mockDecryptFails = true;

      const decryptFailure = mode === 'native-decrypt-failure';
      await expect(loadCanopyCloudAccountPublicState()).resolves.toMatchObject({
        read: decryptFailure ? 'error' : 'unavailable',
        hasApiKey: false,
        storageAvailable: decryptFailure,
        secureStorageFailure: {
          version: 1,
          code: decryptFailure
            ? 'SECURE_STORAGE_DECRYPT_FAILED'
            : 'SECURE_STORAGE_READ_UNAVAILABLE',
          operation: 'read',
          state: decryptFailure ? 'secure' : mode,
          backend: mode === 'unavailable' ? null : 'gnome_libsecret',
          retryable: !decryptFailure,
        },
      });
      expectNoMutation(before);
      expect(mockPurge).not.toHaveBeenCalled();
    },
  );

  it('PAT spawn injection rechecks native availability and backend identity', async () => {
    await invoke(IPC_CHANNELS.settingsSaveGitHubPat, SECRET);
    const injector = mockSecretsInjector.mock.calls[0]?.[0];
    if (!injector) throw new Error('Expected real PAT injector');
    const before = snapshot();
    clearEffects();
    expect(injector()).toEqual({ GH_TOKEN: SECRET });
    mockAvailable = false;
    expect(injector()).toEqual({});
    mockAvailable = true;
    expect(injector()).toEqual({ GH_TOKEN: SECRET });
    mockBackend = 'unknown';
    mockAvailable = false;
    expect(injector()).toEqual({});
    mockBackend = 'gnome_libsecret';
    mockAvailable = true;
    mockDecryptFails = false;
    expect(injector()).toEqual({ GH_TOKEN: SECRET });
    expectNoMutation(before);
  });

  it('environment spawn injection does not cache unreadable data as empty configuration', async () => {
    await writeEnvironmentConfig(environment(SECRET));
    const injector = mockEnvironmentInjector.mock.calls[0]?.[0];
    if (!injector) throw new Error('Expected real environment injector');
    const before = snapshot();
    clearEffects();
    expect(injector()).toMatchObject({ FIXTURE_SECRET: SECRET });
    mockAvailable = false;
    expect(injector()).not.toHaveProperty('FIXTURE_SECRET');
    mockAvailable = true;
    expect(injector()).toMatchObject({ FIXTURE_SECRET: SECRET });
    mockBackend = 'unknown';
    mockAvailable = false;
    expect(injector()).not.toHaveProperty('FIXTURE_SECRET');
    mockBackend = 'gnome_libsecret';
    mockAvailable = true;
    mockDecryptFails = false;
    expect(injector()).toMatchObject({ FIXTURE_SECRET: SECRET });
    expectNoMutation(before);
  });

  it('cached Linear tokens do not hide a backend change or poison unlock recovery', async () => {
    await invoke(IPC_CHANNELS.settingsSaveLinearToken, SECRET);
    expect(await resolveLinearToken()).toBe(SECRET);
    const before = snapshot();
    clearEffects();
    mockAvailable = false;
    expect(await resolveLinearToken()).toBe('');
    mockAvailable = true;
    mockBackend = 'unknown';
    mockAvailable = false;
    expect(await resolveLinearToken()).toBe('');
    mockBackend = 'gnome_libsecret';
    mockAvailable = true;
    mockDecryptFails = false;
    expect(await resolveLinearToken()).toBe(SECRET);
    expectNoMutation(before);
  });

  it('cloud cached account and reset guard retain ciphertext and never purge replicas on storage failure', async () => {
    await saveCanopyCloudAccount(cloud);
    expect(await loadCanopyCloudAccount()).toMatchObject({ apiKey: SECRET });
    const changed = jest.fn();
    const unsubscribe = subscribeCanopyCloudAccountChanges(changed);
    try {
      const before = snapshot();
      clearEffects();
      mockAvailable = false;
      const result = await readCanopyCloudAccountWithStatus();
      expect(result).toMatchObject({
        status: 'unavailable',
        secureStorageFailure: { code: 'SECURE_STORAGE_READ_UNAVAILABLE' },
      });
      await failureOf(() =>
        resetUnreadableCanopyCloudAccount(async (operation) => {
          await mockPurge();
          return operation();
        }),
      );
      expectNoMutation(before);
      expect(mockPurge).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      mockAvailable = true;
      expect(await loadCanopyCloudAccount()).toMatchObject({ apiKey: SECRET });
    } finally {
      unsubscribe();
    }
  });
});

describe('remote identity through the held real policy', () => {
  it.each(denied)(
    'refuses a new Linux identity on $name without pkcs8 fallback',
    async (backend) => {
      const store = remoteStore();
      mockFiles.set(
        '/fake/remote.json',
        Buffer.from(
          '{"version":1,"allowIncoming":false,"pairedHosts":[],"pairedControllers":[]}',
        ),
      );
      const before = snapshot();
      clearEffects();
      mockBackend = backend.backend;
      mockAvailable = backend.available;
      if (backend.missing) delete mockElectron.safeStorage;
      await expect(failureOf(() => store.identity())).resolves.toMatchObject({
        code: 'SECURE_STORAGE_WRITE_REFUSED',
        state: backend.state,
        retryable: true,
      });
      expectNoMutation(before);
      expect(mockEncrypt).not.toHaveBeenCalled();
      mockAvailable = true;
      mockBackend = 'gnome_libsecret';
      mockElectron.safeStorage = {
        isEncryptionAvailable: mockProbe,
        getSelectedStorageBackend: (): string => mockBackend,
        encryptString: mockEncrypt,
        decryptString: mockDecrypt,
      };
      await store.identity();
      expect(mockFiles.get('/fake/identity')?.toString()).toMatch(
        /^safe-storage:/,
      );
      expect(mockWrite).toHaveBeenCalledWith(
        '/fake/identity',
        expect.any(String),
        { mode: 0o600 },
      );
    },
  );

  it.each([
    'locked',
    'unavailable',
    'unavailable-libsecret',
    'native-decrypt-failure',
  ])(
    'retains an existing identity on %s and retries the same instance',
    async (mode) => {
      const initial = await remoteStore().identity();
      const store = remoteStore();
      const before = snapshot();
      clearEffects();
      if (mode === 'locked') mockAvailable = false;
      else if (mode === 'unavailable') delete mockElectron.safeStorage;
      else if (mode === 'unavailable-libsecret') {
        mockBackend = 'unknown';
        mockAvailable = false;
      } else mockDecryptFails = true;
      await expect(failureOf(() => store.identity())).resolves.toMatchObject({
        version: 1,
        operation: 'read',
      });
      expectNoMutation(before);
      expect(mockEncrypt).not.toHaveBeenCalled();
      mockAvailable = true;
      mockDecryptFails = false;
      mockBackend = 'gnome_libsecret';
      mockElectron.safeStorage = {
        isEncryptionAvailable: mockProbe,
        getSelectedStorageBackend: (): string => mockBackend,
        encryptString: mockEncrypt,
        decryptString: mockDecrypt,
      };
      expect((await store.identity()).deviceId).toBe(initial.deviceId);
      expectNoMutation(before);
    },
  );

  it('reads historical encrypted identity with a read-only native facade without replacement', async () => {
    const initial = await remoteStore().identity();
    const before = snapshot();
    clearEffects();
    mockElectron.safeStorage = {
      isEncryptionAvailable: mockProbe,
      decryptString: mockDecrypt,
    };
    expect((await remoteStore().identity()).deviceId).toBe(initial.deviceId);
    expectNoMutation(before);
  });

  it('reads historical pkcs8 identities on Linux without native storage', async () => {
    const fixture = generateDeviceKeyPair();
    mockFiles.set(
      '/fake/identity',
      Buffer.from(`pkcs8:${exportDeviceKeyPair(fixture).toString('base64')}\n`),
    );
    const before = snapshot();
    clearEffects();
    delete mockElectron.safeStorage;
    expect((await remoteStore().identity()).deviceId).toBe(fixture.deviceId);
    expectNoMutation(before);
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'win32'])(
    'preserves explicit native-false fallback on %s',
    async (platform) => {
      mockPlatform = platform;
      mockAvailable = false;
      const created = await remoteStore().identity();
      expect(mockFiles.get('/fake/identity')?.toString()).toMatch(/^pkcs8:/);
      expect((await remoteStore().identity()).deviceId).toBe(created.deviceId);
      expect(mockEncrypt).not.toHaveBeenCalled();
    },
  );

  it('native encryption failure never writes a plaintext identity', async () => {
    const before = snapshot();
    clearEffects();
    mockEncrypt.mockImplementation(() => {
      throw new Error(mockNativeDiagnostic);
    });
    await expect(
      failureOf(() => remoteStore().identity()),
    ).resolves.toMatchObject({ code: 'SECURE_STORAGE_ENCRYPT_FAILED' });
    expectNoMutation(before);
  });
});

describe('legacy sources survive migration refusals and recover in place', () => {
  it.each([
    'cloud account',
    'PAT IPC / status read',
    'Linear IPC / status read',
    'MCP OAuth',
    'model gateway',
    'environments',
  ])(
    'treats wrong-identity shared %s source as empty without caching or mutation',
    async (name) => {
      const store = stores.find((entry) => entry.name === name);
      if (!store) throw new Error('Missing migration fixture');
      await store.prepare?.();
      await store.save(SECRET);
      const sourcePath = store.path.replace('/fake/', '/fake/shared-legacy/');
      const source = mockFiles.get(store.path);
      if (!source) throw new Error('Missing persisted migration fixture');
      mockFiles.set(sourcePath, Buffer.from(source));
      mockFiles.delete(store.path);
      invalidateCanopyCloudAccountCache();
      invalidateTokenCache();
      invalidateLinearTokenCache();
      const before = snapshot();
      clearEffects();
      mockDecryptFails = true;
      // Gateway authorization must still read the current cloud owner. Only
      // the shared legacy gateway ciphertext belongs to the foreign identity.
      if (name === 'model gateway') {
        mockDecrypt.mockImplementationOnce((data: Buffer) =>
          Buffer.from(
            data.toString('utf8').slice('fake-native-v1:'.length),
            'base64',
          ).toString('utf8'),
        );
      }
      await expect(store.read()).resolves.toEqual({ value: null });
      expectNoMutation(before);
      mockDecryptFails = false;
      await expect(store.read()).resolves.toEqual({ value: SECRET });
      expect(mockFiles.get(sourcePath)).toEqual(source);
      expect(mockRemove).not.toHaveBeenCalled();
    },
  );

  it.each([
    'cloud account',
    'PAT IPC / status read',
    'Linear IPC / status read',
    'MCP OAuth',
    'model gateway',
    'environments',
  ])(
    'retains %s source and retries migration on backend recovery',
    async (name) => {
      const store = stores.find((entry) => entry.name === name);
      if (!store) throw new Error('Missing migration fixture');
      await store.prepare?.();
      await store.save(SECRET);
      const sourcePath = store.path.replace('/fake/', '/fake/shared-legacy/');
      const source = mockFiles.get(store.path);
      if (!source) throw new Error('Missing persisted migration fixture');
      mockFiles.set(sourcePath, Buffer.from(source));
      mockFiles.delete(store.path);
      invalidateCanopyCloudAccountCache();
      invalidateTokenCache();
      invalidateLinearTokenCache();
      const before = snapshot();
      clearEffects();
      mockElectron.safeStorage = {
        isEncryptionAvailable: mockProbe,
        decryptString: mockDecrypt,
      };
      await expect(store.read()).resolves.toEqual({ value: SECRET });
      expectNoMutation(before);
      mockAvailable = false;
      await readFailure(store);
      expectNoMutation(before);
      mockBackend = 'gnome_libsecret';
      mockAvailable = true;
      mockElectron.safeStorage = {
        isEncryptionAvailable: mockProbe,
        getSelectedStorageBackend: (): string => mockBackend,
        encryptString: mockEncrypt,
        decryptString: mockDecrypt,
      };
      await expect(store.read()).resolves.toEqual({ value: SECRET });
      expect(mockFiles.get(sourcePath)).toEqual(source);
      expect(mockFiles.has(store.path)).toBe(true);
      expect(mockRemove).not.toHaveBeenCalled();
    },
  );
});

describe.each(stores)('$name additional native boundary cases', (store) => {
  it('distinguishes genuinely missing records from storage failure', async () => {
    await store.prepare?.();
    const before = snapshot();
    clearEffects();
    await expect(store.read()).resolves.toEqual({ value: null });
    expectNoMutation(before);
  });

  it('refuses a failed native availability probe without persisting or encrypting', async () => {
    await store.prepare?.();
    await store.save(SECRET);
    const before = snapshot();
    clearEffects();
    mockProbe.mockImplementation(() => {
      throw new Error(mockNativeDiagnostic);
    });
    await failureOf(() => store.save(REPLACEMENT));
    expectNoMutation(before);
    expect(mockEncrypt).not.toHaveBeenCalled();
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain(
      mockNativeDiagnostic,
    );
  });

  it.each(['darwin', 'win32'])(
    'keeps successful %s encryption independent of Linux backend names',
    async (platform) => {
      mockPlatform = platform;
      mockBackend = 'unknown';
      await store.prepare?.();
      await store.save(SECRET);
      expect(getSafeStorageStatus()).toEqual({
        state: 'secure',
        backend: null,
      });
      await expect(store.read()).resolves.toEqual({ value: SECRET });
      expect(mockEncrypt).toHaveBeenCalled();
      expect(mockDecrypt).toHaveBeenCalled();
    },
  );
});

it.each([
  {
    save: IPC_CHANNELS.settingsSaveGitHubPat,
    load: IPC_CHANNELS.settingsLoadGitHubPat,
    read: readStoredPatWithStatus,
  },
  {
    save: IPC_CHANNELS.settingsSaveLinearToken,
    load: IPC_CHANNELS.settingsLoadLinearToken,
    read: readStoredLinearTokenWithStatus,
  },
])(
  'preserves $load IPC failure metadata and recovers the retained secret',
  async ({ save, load, read }) => {
    await invoke(save, SECRET);
    expect(await invoke(load)).toBe(SECRET);
    const before = snapshot();
    clearEffects();
    mockAvailable = false;
    expect(await invoke(load)).toMatchObject({
      success: false,
      secureStorageFailure: {
        version: 1,
        code: 'SECURE_STORAGE_READ_UNAVAILABLE',
      },
    });
    expect(await read()).toMatchObject({
      status: 'storage-error',
      failure: { version: 1, code: 'SECURE_STORAGE_READ_UNAVAILABLE' },
    });
    expectNoMutation(before);
    mockAvailable = true;
    expect(await invoke(load)).toBe(SECRET);
    expectNoMutation(before);
  },
);
