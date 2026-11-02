/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { CopilotAccount } from '@canopy/desktop-shared/types';
import type * as CopilotRuntimeMetadata from '@canopy/desktop-shared/node/copilot/runtime-metadata';
import type {
  DeviceFlowOptions,
  DeviceFlowOutcome,
  DeviceFlowStart,
} from '@canopy/desktop-shared/node/copilot/device-flow';
import type * as CurrentBrand from '@canopy/brand/current';
import type {
  CopilotCredential,
  CopilotCredentialDelete,
  CopilotCredentialRead,
  CopilotCredentialReplace,
  CopilotCredentialRevision,
  CopilotGrant,
} from '../copilot/credential-store';
import type { GitHubTokenProvider, SessionConfig } from '@github/copilot-sdk';
import {
  requestSessionToken,
  sessionToken,
  SessionTokenRead,
  turnRequest,
} from './helpers/copilot-session-token';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
interface TestRuntime {
  identity: { runtimeId: string; pid: number; started: number };
  isClosed(): boolean;
  client: {
    rpc: {
      models: { list: jest.Mock };
      account: { getQuota: jest.Mock };
    };
    createSession: jest.Mock<Promise<never>, [SessionConfig]>;
    resumeSession: jest.Mock<Promise<never>, [string, SessionConfig]>;
  };
  exited: Promise<void>;
  close: jest.Mock<Promise<void>, []>;
}
function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const HOUR = 60 * 60 * 1000;
const account: CopilotAccount = {
  host: 'https://github.com',
  login: 'octocat',
};
const other: CopilotAccount = { host: 'https://github.com', login: 'hubot' };
function credentialFor(
  login: string,
  overrides: Partial<CopilotCredential> = {},
): CopilotCredential {
  return {
    version: 1,
    clientId: 'Iv23test',
    host: 'https://github.com',
    login,
    id: login === 'octocat' ? '1' : '2',
    accessToken: `ghu_${login}`,
    accessTokenExpiresAt: new Date(Date.now() + 6 * HOUR).toISOString(),
    refreshToken: `ghr_${login}`,
    refreshTokenExpiresAt: new Date(Date.now() + 1000 * HOUR).toISOString(),
    entryId: (login === 'octocat' ? 'a' : 'b').repeat(32),
    revision: 1,
    ...overrides,
  };
}
const storedAt = (expected: { entryId: string; revision?: number }) =>
  store.read.status === 'present' &&
  store.read.credential.entryId === expected.entryId &&
  (expected.revision === undefined ||
    store.read.credential.revision === expected.revision);
const store: {
  read: CopilotCredentialRead;
  saved: CopilotCredential[];
  cleared: number;
  available: boolean;
  onSave?: () => void;
  /** Fails the next create before or after its entry is installed. */
  failCreate?: 'before-install' | 'after-install';
  /** Fails deletes after removing the entry, as a failed directory sync does. */
  failDelete?: boolean;
} = {
  read: { status: 'absent' },
  saved: [],
  cleared: 0,
  available: true,
};
const mockPreferences: {
  copilotEnabled: boolean;
  copilotAccount: CopilotAccount | undefined;
} = {
  copilotEnabled: false,
  copilotAccount: undefined,
};
const mockReadCredential = jest.fn(() => Promise.resolve(store.read));
const mockModels = jest.fn(() =>
  Promise.resolve({
    models: [
      { id: 'available', name: 'Available', policy: { state: 'enabled' } },
      { id: 'disabled', name: 'Disabled', policy: { state: 'disabled' } },
    ],
  }),
);
const mockQuota = jest.fn(() =>
  Promise.resolve({
    quotaSnapshots: {
      chat: { remainingPercentage: 75, isUnlimitedEntitlement: false },
    },
  }),
);
const mockVerify = jest.fn(() => Promise.resolve('/fixture/copilot'));
let mockSupported = true;
const mockInstall = jest.fn(() => Promise.resolve('/fixture/copilot'));
const mockStart = jest.fn<Promise<TestRuntime>, [{ signal: AbortSignal }]>();
const mockReap = jest.fn<Promise<void>, []>(() => Promise.resolve());
const mockStartFlow = jest.fn<Promise<unknown>, unknown[]>();
const mockPollFlow = jest.fn<
  Promise<DeviceFlowOutcome>,
  [options: DeviceFlowOptions, start: DeviceFlowStart, signal: AbortSignal]
>();
const mockRefresh = jest.fn<Promise<unknown>, unknown[]>();
const mockIdentity = jest.fn(() =>
  Promise.resolve({ data: { login: 'octocat', id: 1 } }),
);

jest.mock('@canopy/desktop-shared/node/copilot/runtime-metadata', () => {
  const actual = jest.requireActual<typeof CopilotRuntimeMetadata>(
    '@canopy/desktop-shared/node/copilot/runtime-metadata',
  );
  return {
    ...actual,
    getCopilotRuntimeArtifact: () =>
      mockSupported
        ? actual.getCopilotRuntimeArtifact('darwin', 'arm64')
        : undefined,
  };
});
jest.mock('@canopy/brand/current', () => {
  const actual = jest.requireActual<typeof CurrentBrand>(
    '@canopy/brand/current',
  );
  return {
    ...actual,
    BRAND: { ...actual.BRAND, copilot: { gitHubAppClientId: 'Iv23test' } },
  };
});
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: () => ({ onSnapshotChanged: jest.fn() }),
}));
jest.mock('../copilot/feature-flag', () => ({
  assertCopilotHarnessEnabled: jest.fn(),
  isCopilotHarnessEnabled: () => true,
}));
jest.mock('../copilot/runtime-installer', () => ({
  CopilotRuntimeInstaller: jest.fn(() => ({
    isInstalled: () => Promise.resolve(true),
    get verify() {
      return mockVerify;
    },
    get install() {
      return mockInstall;
    },
  })),
}));
const mockInvalidateAvailability = jest.fn<void, []>();
jest.mock('../copilot/runtime-availability', () => ({
  beginCopilotAvailabilityProbe: () => jest.fn(),
  invalidateCopilotRuntimeAvailability: (): void => {
    mockInvalidateAvailability();
  },
}));
jest.mock('../lib/e2e-gate', () => ({ isE2eBuild: () => false }));
jest.mock('../pipelines/config-paths', () => ({ getEnhancedEnv: () => ({}) }));
jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getCopilotRuntimeRootDir: () => '/fixture/runtime',
  getCopilotRuntimeReceiptsDir: () => '/fixture/receipts',
  getCopilotRuntimeStateDir: () => '/fixture/state',
}));
jest.mock('@canopy/desktop-shared/node/copilot/process-receipts', () => ({
  reapCopilotProcessReceipts: () => mockReap(),
}));
jest.mock('@canopy/desktop-shared/node/copilot/runtime', () => ({
  startCopilotRuntime: (options: { signal: AbortSignal }) => mockStart(options),
}));
jest.mock('@canopy/desktop-shared/node/copilot/device-flow', () => ({
  startDeviceFlow: (...args: unknown[]) => mockStartFlow(...args),
  pollDeviceFlow: (
    options: DeviceFlowOptions,
    start: DeviceFlowStart,
    signal: AbortSignal,
  ): Promise<DeviceFlowOutcome> => mockPollFlow(options, start, signal),
  refreshDeviceGrant: (...args: unknown[]) => mockRefresh(...args),
  DeviceFlowRefreshRejectedError: class extends Error {},
}));
jest.mock('../lib/github-octokit-loader', () => ({
  loadOctokitConstructor: () =>
    class {
      rest = { users: { getAuthenticated: mockIdentity } };
    },
}));
jest.mock('../lib/github-octokit-options', () => ({
  resolveOctokitClientOptions: (auth: string) => ({ auth }),
}));
let mockEntries = 0;
jest.mock('../copilot/credential-store', () => ({
  isCopilotCredentialStorageAvailable: () => store.available,
  get readCopilotCredential() {
    return mockReadCredential;
  },
  createCopilotCredential: (grant: CopilotGrant) => {
    const failure = store.failCreate;
    store.failCreate = undefined;
    if (failure === 'before-install')
      return Promise.reject(new Error('ENOSPC: no space left on device'));
    mockEntries += 1;
    const credential: CopilotCredential = {
      version: 1,
      ...grant,
      entryId: mockEntries.toString(16).padStart(32, 'c'),
      revision: 1,
    };
    store.saved.push(credential);
    store.read = { status: 'present', credential };
    store.onSave?.();
    if (failure === 'after-install')
      return Promise.reject(new Error('EIO: directory sync failed'));
    return Promise.resolve(credential);
  },
  replaceCopilotCredential: (
    from: CopilotCredentialRevision,
    grant: CopilotGrant,
  ): Promise<CopilotCredentialReplace> => {
    if (!storedAt(from)) return Promise.resolve({ status: 'conflict' });
    const credential: CopilotCredential = {
      version: 1,
      ...grant,
      entryId: from.entryId,
      revision: from.revision + 1,
    };
    store.saved.push(credential);
    store.read = { status: 'present', credential };
    return Promise.resolve({ status: 'written', credential });
  },
  deleteCopilotCredential: (expected: {
    entryId: string;
    revision?: number;
  }): Promise<CopilotCredentialDelete> => {
    if (store.read.status === 'unreadable')
      return Promise.resolve({ status: 'unreadable' });
    if (!storedAt(expected)) return Promise.resolve({ status: 'conflict' });
    store.cleared += 1;
    store.read = { status: 'absent' };
    if (store.failDelete)
      return Promise.reject(new Error('EIO: directory sync failed'));
    return Promise.resolve({ status: 'deleted' });
  },
  clearCopilotCredential: () => {
    store.cleared += 1;
    store.read = { status: 'absent' };
    return Promise.resolve();
  },
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: () => Promise.resolve({ ...mockPreferences }),
  updatePreferencesFile: (
    update: (
      current: typeof mockPreferences,
    ) => Partial<typeof mockPreferences>,
  ) => {
    Object.assign(mockPreferences, update(mockPreferences));
    return Promise.resolve();
  },
}));

import * as grantAuthority from '../copilot/grant-authority';
import {
  COPILOT_INSTALL_TIMEOUT_MS,
  COPILOT_SETUP_TIMEOUT_MS,
  assertCopilotModelAvailable,
  connectCopilot,
  copilotConnectionStatus,
  disconnectCopilot,
  getCopilotAccountGeneration,
  listCopilotModels,
  openManagedCopilotRuntime,
  readCopilotAccount,
  readCopilotAccountUsage,
  resetCopilotShutdownForTests,
  revokeCopilotRuntimes,
  shutdownCopilotRuntimes,
} from '../copilot/connection';
import { readCopilotUsageSummary } from '../copilot/account-usage';
import {
  CopilotCredentialUnreadableError,
  CopilotSignInExpiredError,
} from '../copilot/credential-broker';

describe('Copilot connection', () => {
  const runtimes: Array<{
    runtime: TestRuntime;
    parent: Deferred;
    cleanup: Deferred;
  }> = [];
  function makeRuntime(cleanup = deferred()) {
    const parent = deferred();
    const runtime: TestRuntime = {
      identity: {
        runtimeId: `runtime-${runtimes.length}`,
        pid: 123,
        started: runtimes.length,
      },
      isClosed: () => false,
      client: {
        rpc: { models: { list: mockModels }, account: { getQuota: mockQuota } },
        createSession: jest.fn((config: SessionConfig) =>
          requestSessionToken(config),
        ),
        resumeSession: jest.fn((sessionId: string, config: SessionConfig) =>
          requestSessionToken(config, { sessionId }),
        ),
      },
      exited: parent.promise,
      close: jest.fn(async () => {
        parent.resolve();
        await cleanup.promise;
      }),
    };
    const fixture = { runtime, parent, cleanup };
    runtimes.push(fixture);
    return fixture;
  }
  const grant = () => ({
    status: 'granted' as const,
    grant: {
      accessToken: 'ghu_octocat',
      accessTokenExpiresAt: new Date(Date.now() + 8 * HOUR).toISOString(),
      refreshToken: 'ghr_octocat',
      refreshTokenExpiresAt: new Date(Date.now() + 1000 * HOUR).toISOString(),
    },
  });
  const flowStart = () => ({
    deviceCode: 'dc',
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    intervalMs: 5000,
  });
  const connected = () => {
    mockPreferences.copilotEnabled = true;
    mockPreferences.copilotAccount = account;
    store.read = { status: 'present', credential: credentialFor('octocat') };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSupported = true;
    mockVerify.mockImplementation(() => Promise.resolve('/fixture/copilot'));
    store.read = { status: 'absent' };
    store.saved = [];
    store.cleared = 0;
    store.available = true;
    store.onSave = undefined;
    store.failCreate = undefined;
    store.failDelete = undefined;
    mockPreferences.copilotEnabled = false;
    mockPreferences.copilotAccount = undefined;
    mockInstall.mockImplementation(() => Promise.resolve('/fixture/copilot'));
    mockStartFlow.mockImplementation(() => Promise.resolve(flowStart()));
    mockPollFlow.mockImplementation(() => Promise.resolve(grant()));
    mockIdentity.mockImplementation(() =>
      Promise.resolve({ data: { login: 'octocat', id: 1 } }),
    );
    mockStart.mockImplementation(({ signal }) => {
      const fixture = makeRuntime();
      fixture.cleanup.resolve();
      signal.addEventListener('abort', fixture.parent.resolve, {
        once: true,
      });
      return Promise.resolve(fixture.runtime);
    });
  });
  afterEach(async () => {
    mockSupported = true;
    for (const fixture of runtimes) {
      fixture.cleanup.resolve();
      fixture.parent.resolve();
    }
    // Each test seeds its own entry; ending the account epoch keeps one
    // test's grant authority from serving the next.
    await disconnectCopilot();
    runtimes.length = 0;
  });

  it('B1 refuses a closed recipient before presenting the grant', async () => {
    connected();
    const runtime = await openManagedCopilotRuntime({
      signal: new AbortController().signal,
    });
    await runtime.close();
    store.read = {
      status: 'present',
      credential: credentialFor('octocat', {
        accessTokenExpiresAt: new Date(Date.now() + HOUR / 2).toISOString(),
      }),
    };
    mockRefresh.mockResolvedValue(grant().grant);
    await expect(sessionToken(runtime)).rejects.toThrow(
      'Copilot connection was revoked.',
    );
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('P2 refuses delivery after revoke while retaining the rotated successor', async () => {
    connected();
    const runtime = await openManagedCopilotRuntime({
      signal: new AbortController().signal,
    });
    store.read = {
      status: 'present',
      credential: credentialFor('octocat', {
        accessTokenExpiresAt: new Date(Date.now() + HOUR / 2).toISOString(),
      }),
    };
    const started = deferred();
    const release = deferred();
    mockRefresh.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return grant().grant;
    });
    const pending = sessionToken(runtime);
    const rejected = expect(pending).rejects.toThrow();
    await started.promise;
    await revokeCopilotRuntimes();
    release.resolve();
    await rejected;
    // Admission rejects the delivery, not the authority's durable rotation.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.saved).toHaveLength(1);
  });

  it('L4 verifies runtime capability before any refresh presentation', async () => {
    connected();
    store.read = {
      status: 'present',
      credential: credentialFor('octocat', {
        accessTokenExpiresAt: new Date(Date.now() + HOUR / 2).toISOString(),
      }),
    };
    mockRefresh.mockResolvedValue(grant().grant);
    mockVerify.mockRejectedValue(new Error('verification failed'));
    await expect(
      openManagedCopilotRuntime({ signal: new AbortController().signal }),
    ).rejects.toThrow('verification failed');
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
    expect(store.saved).toHaveLength(0);
  });

  it('D22 unsupported Linux capability refuses setup before flow, spawn or write', async () => {
    mockSupported = false;
    await expect(
      connectCopilot(new AbortController().signal, () => undefined, true),
    ).rejects.toThrow();
    expect(mockStartFlow).not.toHaveBeenCalled();
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
    expect(store.cleared).toBe(0);
  });

  it('D22 unsupported reads and Disconnect cannot adopt or write a stored grant', async () => {
    connected();
    mockSupported = false;
    await expect(copilotConnectionStatus()).resolves.toMatchObject({
      supported: false,
      enabled: false,
      account: null,
    });
    await expect(
      listCopilotModels(new AbortController().signal),
    ).resolves.toEqual([]);
    await expect(disconnectCopilot()).rejects.toThrow();
    await expect(
      readCopilotAccountUsage(new AbortController().signal),
    ).rejects.toThrow();
    expect(mockReadCredential).not.toHaveBeenCalled();
    expect(mockPreferences).toEqual({
      copilotEnabled: true,
      copilotAccount: account,
    });
    expect(store.saved).toHaveLength(0);
    expect(store.cleared).toBe(0);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('L4 a rejected SDK handshake never presents a grant', async () => {
    connected();
    store.read = {
      status: 'present',
      credential: credentialFor('octocat', {
        accessTokenExpiresAt: new Date(Date.now() + HOUR / 2).toISOString(),
      }),
    };
    mockStart.mockRejectedValueOnce(new Error('unsupported CLI version'));
    await expect(
      openManagedCopilotRuntime({ signal: new AbortController().signal }),
    ).rejects.toThrow('unsupported CLI version');
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(store.saved).toHaveLength(0);
  });

  /** The fake SDK client of the most recently started runtime. */
  function latestClient(): TestRuntime['client'] {
    const latest = runtimes[runtimes.length - 1];
    if (!latest) throw new Error('No runtime has started.');
    return latest.runtime.client;
  }
  function provider(config: SessionConfig): GitHubTokenProvider {
    if (!config.gitHubTokenProvider)
      throw new Error('The session has no token provider.');
    return config.gitHubTokenProvider;
  }
  async function provided(
    request: ReturnType<GitHubTokenProvider>,
  ): Promise<string> {
    try {
      const result = await request;
      return result.kind === 'token' ? `token:${result.accessToken}` : 'none';
    } catch (error) {
      return `refused:${error instanceof Error ? error.message : String(error)}`;
    }
  }

  it('hands consumers a frozen, results-only recipient handle', async () => {
    connected();
    const runtime = await openManagedCopilotRuntime({
      signal: new AbortController().signal,
    });
    expect(Object.keys(runtime).sort()).toEqual([
      'account',
      'close',
      'generation',
      'getQuota',
      'listModels',
      'runTurn',
    ]);
    expect(Object.isFrozen(runtime)).toBe(true);
    for (const member of [
      'client',
      'auth',
      'admit',
      'token',
      'tokenProvider',
      'tokenProviderForSession',
      'authForOperation',
      'identity',
      'exited',
    ])
      expect(member in runtime).toBe(false);
    await runtime.close();
  });

  it.each([
    { purpose: 'session', refused: ['getQuota'] },
    { purpose: 'models', refused: ['runTurn', 'getQuota'] },
    { purpose: 'quota', refused: ['runTurn', 'listModels'] },
    { purpose: 'setup-probe', refused: ['runTurn', 'listModels', 'getQuota'] },
  ] as const)(
    'a $purpose handle refuses $refused before any token delivery',
    async ({ purpose, refused }) => {
      connected();
      const runtime = await openManagedCopilotRuntime({
        signal: new AbortController().signal,
        purpose,
      });
      const signal = new AbortController().signal;
      for (const operation of refused)
        await expect(
          operation === 'runTurn'
            ? runtime.runTurn(turnRequest())
            : runtime[operation](signal),
        ).rejects.toThrow('Copilot lease purpose is not admitted.');
      expect(mockModels).not.toHaveBeenCalled();
      expect(mockQuota).not.toHaveBeenCalled();
      expect(latestClient().createSession).not.toHaveBeenCalled();
      await runtime.close();
    },
  );

  it('prebinds resume, revokes the replaced session lease and adopts only once on create', async () => {
    connected();
    const runtime = await openManagedCopilotRuntime({
      signal: new AbortController().signal,
    });
    const client = latestClient();
    const outcomes: string[] = [];
    let resumed: GitHubTokenProvider | undefined;
    client.resumeSession.mockImplementationOnce(async (_id, config) => {
      const current = provider(config);
      resumed = current;
      outcomes.push(
        await provided(
          current({
            host: account.host,
            sessionId: 'other',
            reason: 'initial',
          }),
        ),
        await provided(
          current({
            host: account.host,
            sessionId: 'saved',
            reason: 'initial',
          }),
        ),
      );
      throw new Error('Session not found');
    });
    client.createSession.mockImplementationOnce(async (config) => {
      const created = provider(config);
      outcomes.push(
        resumed
          ? await provided(
              resumed({
                host: account.host,
                sessionId: 'saved',
                reason: 'refresh',
              }),
            )
          : 'missing resume provider',
        await provided(
          created({ host: account.host, sessionId: 'new', reason: 'initial' }),
        ),
        await provided(
          created({
            host: account.host,
            sessionId: 'other',
            reason: 'refresh',
          }),
        ),
      );
      throw new SessionTokenRead('');
    });
    const onSessionUnavailable = jest.fn();
    await expect(
      runtime.runTurn(
        turnRequest({ sessionId: 'saved', onSessionUnavailable }),
      ),
    ).rejects.toBeInstanceOf(SessionTokenRead);
    expect(client.resumeSession).toHaveBeenCalledWith(
      'saved',
      expect.anything(),
    );
    expect(onSessionUnavailable).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([
      'refused:Copilot session audience changed.',
      'token:ghu_octocat',
      'refused:Copilot lease is not admitted.',
      'token:ghu_octocat',
      'refused:Copilot session audience changed.',
    ]);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('replacing a session lease refuses an already pending callback before presentation', async () => {
    connected();
    const runtime = await openManagedCopilotRuntime({
      signal: new AbortController().signal,
    });
    store.read = {
      status: 'present',
      credential: credentialFor('octocat', {
        accessTokenExpiresAt: new Date(Date.now() + HOUR / 2).toISOString(),
      }),
    };
    const started = deferred();
    const release = deferred();
    mockReadCredential.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return store.read;
    });
    const client = latestClient();
    let pending: Promise<string> = Promise.resolve('not requested');
    let previous = 'not settled';
    client.resumeSession.mockImplementationOnce(async (_id, config) => {
      pending = provided(
        provider(config)({
          host: account.host,
          sessionId: 'saved',
          reason: 'refresh',
        }),
      );
      await started.promise;
      throw new Error('Session not found');
    });
    client.createSession.mockImplementationOnce(async () => {
      // The replacement lease exists before the SDK sees the new config;
      // the turn, and so the recipient, is still open here.
      release.resolve();
      previous = await pending;
      throw new SessionTokenRead('');
    });
    await expect(
      runtime.runTurn(
        turnRequest({ sessionId: 'saved', onSessionUnavailable: jest.fn() }),
      ),
    ).rejects.toBeInstanceOf(SessionTokenRead);
    expect(previous).toBe('refused:Copilot lease is not admitted.');
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('session model reads use a fresh one-shot lease each and refuse results after account replacement', async () => {
    connected();
    const runtime = await openManagedCopilotRuntime({
      signal: new AbortController().signal,
    });
    const signal = new AbortController().signal;
    const ids = async (): Promise<string[]> =>
      (await runtime.listModels(signal)).map((model) => model.id);
    await expect(ids()).resolves.toEqual(['copilot:available']);
    // A reused one-shot lease would refuse this second read.
    await expect(ids()).resolves.toEqual(['copilot:available']);
    expect(mockModels.mock.calls).toEqual([
      [{ gitHubToken: 'ghu_octocat' }],
      [{ gitHubToken: 'ghu_octocat' }],
    ]);
    mockModels.mockImplementationOnce(() => {
      store.read = {
        status: 'present',
        credential: credentialFor('octocat', { entryId: 'replacement' }),
      };
      return Promise.resolve({
        models: [{ id: 'stale', name: 'Stale', policy: { state: 'enabled' } }],
      });
    });
    await expect(ids()).rejects.toThrow('Copilot connection was revoked.');
    expect(mockRefresh).not.toHaveBeenCalled();
    await runtime.close();
  });

  it.each(['models', 'quota'] as const)(
    'a %s handle reads once on its one-shot lease',
    async (purpose) => {
      connected();
      const runtime = await openManagedCopilotRuntime({
        signal: new AbortController().signal,
        purpose,
      });
      const signal = new AbortController().signal;
      const read = (): Promise<unknown> =>
        purpose === 'models'
          ? runtime.listModels(signal)
          : runtime.getQuota(signal);
      await expect(read()).resolves.toBeDefined();
      await expect(read()).rejects.toThrow(
        'Copilot operation token was already delivered.',
      );
      expect(
        (purpose === 'models' ? mockModels : mockQuota).mock.calls,
      ).toEqual([[{ gitHubToken: 'ghu_octocat' }]]);
      await runtime.close();
    },
  );

  it.each([
    'Missing conversation',
    'Session not found',
    'Session not found: saved',
    'Request session.resume failed with message: Failed to load session events: Session not found: saved',
  ])(
    'recovers a missing conversation through the handle on a fresh lease: %s',
    async (message) => {
      connected();
      const runtime = await openManagedCopilotRuntime({
        signal: new AbortController().signal,
      });
      const client = latestClient();
      client.resumeSession.mockRejectedValueOnce(new Error(message));
      const onSessionUnavailable = jest.fn();
      await expect(
        sessionToken(runtime, { sessionId: 'saved', onSessionUnavailable }),
      ).resolves.toBe('ghu_octocat');
      expect(onSessionUnavailable).toHaveBeenCalledTimes(1);
      expect(client.createSession).toHaveBeenCalledTimes(1);
    },
  );

  it('T5 refuses model results after revoke, not just tokens', async () => {
    connected();
    const started = deferred();
    const release = deferred();
    mockModels.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return {
        models: [{ id: 'stale', name: 'Stale', policy: { state: 'enabled' } }],
      };
    });
    const pending = listCopilotModels(new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow();
    await started.promise;
    await revokeCopilotRuntimes();
    release.resolve();
    await rejected;
  });

  describe.each(['unreadable', 'absent'] as const)(
    'model admission with %s credentials',
    (status) => {
      const failure: CopilotCredentialRead =
        status === 'unreadable'
          ? {
              status,
              secureStorageFailure: {
                version: 1,
                code: 'SECURE_STORAGE_READ_UNAVAILABLE',
                operation: 'read',
                state: 'locked',
                backend: 'keychain',
                retryable: true,
              },
            }
          : { status };
      const expected =
        failure.status === 'unreadable'
          ? {
              constructor: CopilotCredentialUnreadableError,
              secureStorageFailure: failure.secureStorageFailure,
            }
          : { constructor: CopilotSignInExpiredError };

      it.each(['initial', 'cached'] as const)(
        'preserves the binding error on %s discovery without a new runtime',
        async (stage) => {
          connected();
          const signal = new AbortController().signal;
          if (stage === 'cached') await listCopilotModels(signal);
          // Status succeeds; the credential fails at the following epoch read.
          mockReadCredential
            .mockResolvedValueOnce(store.read)
            .mockResolvedValueOnce(failure);
          await expect(listCopilotModels(signal)).rejects.toMatchObject(
            expected,
          );
          expect(mockModels).toHaveBeenCalledTimes(stage === 'cached' ? 1 : 0);
          expect(mockStart).toHaveBeenCalledTimes(stage === 'cached' ? 1 : 0);
          expect(mockRefresh).not.toHaveBeenCalled();
          expect(store.saved).toHaveLength(0);
          expect(store.cleared).toBe(0);
        },
      );

      it('preserves the result-admission error and closes the runtime', async () => {
        connected();
        mockModels.mockImplementationOnce(() => {
          store.read = failure;
          return Promise.resolve({ models: [] });
        });
        await expect(
          listCopilotModels(new AbortController().signal),
        ).rejects.toMatchObject(expected);
        expect(mockModels).toHaveBeenCalledTimes(1);
        expect(runtimes[0].runtime.close).toHaveBeenCalledTimes(1);
        expect(mockRefresh).not.toHaveBeenCalled();
        expect(store.saved).toHaveLength(0);
        expect(store.cleared).toBe(0);
      });

      it('preserves the final binding error for every joined discovery caller', async () => {
        connected();
        const closing = deferred();
        const cleanup = deferred();
        mockStart.mockImplementationOnce(() => {
          const fixture = makeRuntime(cleanup);
          fixture.runtime.close.mockImplementation(async () => {
            closing.resolve();
            await cleanup.promise;
            fixture.parent.resolve();
          });
          return Promise.resolve(fixture.runtime);
        });
        const signal = new AbortController().signal;
        const first = listCopilotModels(signal);
        const joined = listCopilotModels(signal);
        const rejected = Promise.all([
          expect(first).rejects.toMatchObject(expected),
          expect(joined).rejects.toMatchObject(expected),
        ]);
        await closing.promise;
        store.read = failure;
        cleanup.resolve();
        await rejected;
        expect(mockModels).toHaveBeenCalledTimes(1);
        expect(mockStart).toHaveBeenCalledTimes(1);
        expect(mockRefresh).not.toHaveBeenCalled();
        expect(store.saved).toHaveLength(0);
        expect(store.cleared).toBe(0);
      });

      it.each(['initial', 'final'] as const)(
        'prioritizes generation revocation during a failed %s binding read',
        async (stage) => {
          connected();
          const failAfterRevoke = async (): Promise<CopilotCredentialRead> => {
            await revokeCopilotRuntimes();
            return failure;
          };
          if (stage === 'initial') {
            mockReadCredential
              .mockResolvedValueOnce(store.read)
              .mockImplementationOnce(failAfterRevoke);
          } else {
            mockStart.mockImplementationOnce(() => {
              const fixture = makeRuntime();
              fixture.runtime.close.mockImplementation(() => {
                fixture.parent.resolve();
                // Arm only the final caller admission, after runtime admission.
                mockReadCredential.mockImplementationOnce(failAfterRevoke);
                return Promise.resolve();
              });
              return Promise.resolve(fixture.runtime);
            });
          }
          await expect(
            listCopilotModels(new AbortController().signal),
          ).rejects.toMatchObject({
            constructor: Error,
            message: 'Copilot connection was revoked.',
          });
          expect(mockModels).toHaveBeenCalledTimes(stage === 'initial' ? 0 : 1);
          expect(mockRefresh).not.toHaveBeenCalled();
          expect(store.saved).toHaveLength(0);
          expect(store.cleared).toBe(0);
        },
      );
    },
  );

  it('T6 every joined discovery caller checks its delivery stamp; the next call is fresh', async () => {
    connected();
    const closing = deferred();
    const cleanup = deferred();
    mockStart.mockImplementationOnce(() => {
      const fixture = makeRuntime(cleanup);
      fixture.runtime.close.mockImplementation(async () => {
        closing.resolve();
        await cleanup.promise;
        fixture.parent.resolve();
      });
      return Promise.resolve(fixture.runtime);
    });
    const first = listCopilotModels(new AbortController().signal);
    const second = listCopilotModels(new AbortController().signal);
    const rejected = Promise.all([
      expect(first).rejects.toThrow(),
      expect(second).rejects.toThrow(),
    ]);
    await closing.promise;
    const revoke = revokeCopilotRuntimes();
    cleanup.resolve();
    await revoke;
    await rejected;
    await expect(
      listCopilotModels(new AbortController().signal),
    ).resolves.toHaveLength(1);
    expect(mockModels).toHaveBeenCalledTimes(2);
  });

  it.each(['entry', 'id'] as const)(
    'cached models refuse a changed %s without a generation bump',
    async (field) => {
      connected();
      const signal = new AbortController().signal;
      await listCopilotModels(signal);
      const generation = getCopilotAccountGeneration();
      store.read = {
        status: 'present',
        credential: credentialFor(
          'octocat',
          field === 'entry' ? { entryId: 'replacement' } : { id: '2' },
        ),
      };
      await expect(listCopilotModels(signal)).rejects.toThrow();
      expect(getCopilotAccountGeneration()).toBe(generation);
      await expect(listCopilotModels(signal)).resolves.toHaveLength(1);
      expect(mockModels).toHaveBeenCalledTimes(2);
    },
  );

  describe.each(['account', 'entry', 'id'] as const)(
    'overlapping model discovery after %s replacement',
    (replacement) => {
      it.each([
        ['cleanup', 'old-first'],
        ['cleanup', 'new-first'],
        ['rpc', 'old-first'],
        ['rpc', 'new-first'],
      ] as const)(
        'isolates joined callers and cache with old %s pending and %s completion',
        async (pending, completion) => {
          connected();
          const generation = getCopilotAccountGeneration();
          const oldStarted = deferred();
          const oldReply = deferred();
          const oldClosing = deferred();
          const oldCleanup = deferred();
          const currentStarted = deferred();
          const currentReply = deferred();
          const currentClosing = deferred();
          const currentCleanup = deferred();
          const signal = new AbortController().signal;
          const oldModels = [
            { id: 'old', name: 'Old', policy: { state: 'enabled' } },
          ];
          const currentModels = [
            { id: 'current', name: 'Current', policy: { state: 'enabled' } },
          ];
          mockModels
            .mockImplementationOnce(async () => {
              oldStarted.resolve();
              await oldReply.promise;
              return { models: oldModels };
            })
            .mockImplementationOnce(async () => {
              currentStarted.resolve();
              await currentReply.promise;
              return { models: currentModels };
            });
          for (const [closing, cleanup] of [
            [oldClosing, oldCleanup],
            [currentClosing, currentCleanup],
          ] as const) {
            mockStart.mockImplementationOnce(() => {
              const fixture = makeRuntime(cleanup);
              fixture.runtime.close.mockImplementation(async () => {
                closing.resolve();
                await cleanup.promise;
                fixture.parent.resolve();
              });
              return Promise.resolve(fixture.runtime);
            });
          }
          const oldFirst = listCopilotModels(signal);
          const oldJoined = listCopilotModels(signal);
          const stale = Promise.all([
            expect(oldFirst).rejects.toThrow('Copilot connection was revoked.'),
            expect(oldJoined).rejects.toThrow(
              'Copilot connection was revoked.',
            ),
          ]);
          await oldStarted.promise;
          if (pending === 'cleanup') {
            // Publish the old cache before replacement, but hold delivery.
            oldReply.resolve();
            await oldClosing.promise;
          }
          expect(mockModels).toHaveBeenCalledTimes(1);
          store.read = {
            status: 'present',
            credential:
              replacement === 'account'
                ? credentialFor('hubot')
                : credentialFor(
                    'octocat',
                    replacement === 'entry'
                      ? { entryId: 'replacement' }
                      : { id: '2' },
                  ),
          };
          if (replacement === 'account') mockPreferences.copilotAccount = other;
          else {
            // A same-pin replacement is detected by the old authority's read.
            await expect(listCopilotModels(signal)).rejects.toThrow(
              'Copilot connection was revoked.',
            );
          }
          const currentFirst = listCopilotModels(signal);
          const currentJoined = listCopilotModels(signal);
          await currentStarted.promise;
          expect(mockModels).toHaveBeenCalledTimes(2);
          let lateJoined: Promise<Awaited<typeof currentFirst>> | undefined;
          if (completion === 'old-first') {
            oldReply.resolve();
            await oldClosing.promise;
            oldCleanup.resolve();
            await stale;
            // Old completion must not clear the new epoch's pending operation.
            lateJoined = listCopilotModels(signal);
          }
          currentReply.resolve();
          await currentClosing.promise;
          currentCleanup.resolve();
          const currentResults = await Promise.all([
            currentFirst,
            currentJoined,
            ...(lateJoined ? [lateJoined] : []),
          ]);
          for (const models of currentResults)
            expect(models.map((model) => model.id)).toEqual([
              'copilot:current',
            ]);
          if (completion === 'new-first') {
            oldReply.resolve();
            await oldClosing.promise;
            oldCleanup.resolve();
            await stale;
          }
          // A late old delivery must neither overwrite nor clear the new cache.
          await expect(listCopilotModels(signal)).resolves.toEqual(
            currentResults[0],
          );
          expect(mockModels).toHaveBeenCalledTimes(2);
          expect(mockStart).toHaveBeenCalledTimes(2);
          expect(getCopilotAccountGeneration()).toBe(generation);
        },
      );
    },
  );

  it.each(['revoke', 'account', 'delete'] as const)(
    'T7 refuses quota results after %s',
    async (change) => {
      connected();
      const started = deferred();
      const release = deferred();
      mockQuota.mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        return {
          quotaSnapshots: {
            chat: { remainingPercentage: 75, isUnlimitedEntitlement: false },
          },
        };
      });
      const pending = readCopilotAccountUsage(new AbortController().signal);
      const rejected = expect(pending).rejects.toThrow();
      await started.promise;
      if (change === 'revoke') await revokeCopilotRuntimes();
      else if (change === 'delete') store.read = { status: 'absent' };
      else
        store.read = {
          status: 'present',
          credential: credentialFor('octocat', {
            entryId: 'new-entry',
            id: '2',
          }),
        };
      release.resolve();
      await rejected;
    },
  );

  it('does not count recovery from an unreadable credential as a new connection', async () => {
    const events = await import('../lib/provider-connection-events');
    events.resetProviderConnectionEventsForTests();
    const connection = jest.fn();
    const stop = events.subscribeProviderConnections(connection);
    connected();
    await copilotConnectionStatus();
    connection.mockClear();
    store.read = { status: 'unreadable' };
    await copilotConnectionStatus();
    connected();
    await copilotConnectionStatus();
    expect(connection).not.toHaveBeenCalled();
    stop();
  });

  async function delayedStatusRead() {
    const started = deferred();
    const release = deferred();
    const snapshot = store.read;
    mockReadCredential.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return snapshot;
    });
    const pending = copilotConnectionStatus();
    await started.promise;
    return { pending, release };
  }

  it('does not restore a signed-out analytics baseline from a delayed status read during failed account change', async () => {
    const events = await import('../lib/provider-connection-events');
    events.resetProviderConnectionEventsForTests();
    const connection = jest.fn();
    const stop = events.subscribeProviderConnections(connection);
    const installing = deferred();
    const resume = deferred();
    let delayed: Awaited<ReturnType<typeof delayedStatusRead>> | undefined;
    try {
      connected();
      await copilotConnectionStatus();
      mockInstall.mockImplementationOnce(async () => {
        installing.resolve();
        await resume.promise;
        return '/fixture/copilot';
      });
      mockPollFlow.mockResolvedValueOnce({ status: 'declined' });
      const setup = connectCopilot(
        new AbortController().signal,
        () => undefined,
        true,
      );
      const declined = expect(setup).rejects.toThrow(
        'GitHub sign-in was declined.',
      );
      await installing.promise;
      // This read begins after setup's runtime revocation, before sign-out.
      delayed = await delayedStatusRead();
      resume.resolve();
      await declined;
      expect(store.read).toEqual({ status: 'absent' });
      connection.mockClear();
      delayed.release.resolve();
      const status = await delayed.pending;
      expect(connection).not.toHaveBeenCalled();
      const replay = jest.fn();
      events.subscribeProviderConnections(replay)();
      expect(replay).not.toHaveBeenCalled();
      expect(status).toMatchObject({
        enabled: false,
        account: null,
        phase: 'idle',
      });
    } finally {
      resume.resolve();
      delayed?.release.resolve();
      await delayed?.pending;
      stop();
    }
  });

  it.each(['revoke', 'disconnect', 'shutdown'] as const)(
    'does not publish a delayed status read after %s',
    async (change) => {
      const events = await import('../lib/provider-connection-events');
      events.resetProviderConnectionEventsForTests();
      const connection = jest.fn();
      const stop = events.subscribeProviderConnections(connection);
      connected();
      const delayed = await delayedStatusRead();
      try {
        if (change === 'disconnect') await disconnectCopilot();
        else if (change === 'shutdown') await shutdownCopilotRuntimes();
        else await revokeCopilotRuntimes();
        delayed.release.resolve();
        const status = await delayed.pending;
        expect(connection).not.toHaveBeenCalled();
        const replay = jest.fn();
        events.subscribeProviderConnections(replay)();
        expect(replay).not.toHaveBeenCalled();
        expect(status).toMatchObject({
          enabled: false,
          account: null,
          phase: 'idle',
        });
        if (change === 'revoke') {
          // A runtime revoke does not sign out: a fresh read still counts.
          await expect(copilotConnectionStatus()).resolves.toMatchObject({
            enabled: true,
            account,
          });
          expect(connection).toHaveBeenCalledTimes(1);
        }
      } finally {
        delayed.release.resolve();
        await delayed.pending;
        resetCopilotShutdownForTests();
        stop();
      }
    },
  );

  it('does not replace a committed account baseline with an older delayed status read', async () => {
    const events = await import('../lib/provider-connection-events');
    events.resetProviderConnectionEventsForTests();
    const connection = jest.fn();
    const stop = events.subscribeProviderConnections(connection);
    connected();
    await copilotConnectionStatus();
    const delayed = await delayedStatusRead();
    try {
      mockIdentity.mockResolvedValueOnce({ data: { login: 'hubot', id: 2 } });
      await expect(
        connectCopilot(new AbortController().signal, () => undefined, true),
      ).resolves.toMatchObject({ enabled: true, account: other });
      connection.mockClear();
      delayed.release.resolve();
      const status = await delayed.pending;
      expect(connection).not.toHaveBeenCalled();
      expect(status).toMatchObject({ enabled: false, account: null });
      await expect(copilotConnectionStatus()).resolves.toMatchObject({
        enabled: true,
        account: other,
      });
      expect(connection).not.toHaveBeenCalled();
    } finally {
      delayed.release.resolve();
      await delayed.pending;
      stop();
    }
  });

  it('does not publish a delayed status read after a rejected refresh clears the grant', async () => {
    const events = await import('../lib/provider-connection-events');
    events.resetProviderConnectionEventsForTests();
    const connection = jest.fn();
    const stop = events.subscribeProviderConnections(connection);
    rejectNextRefresh();
    const delayed = await delayedStatusRead();
    try {
      await expect(
        openManagedCopilotRuntime({ signal: new AbortController().signal }),
      ).rejects.toThrow(
        'Copilot sign-in expired. Reconnect Copilot in Settings.',
      );
      expect(store.read).toEqual({ status: 'absent' });
      delayed.release.resolve();
      const status = await delayed.pending;
      expect(connection).not.toHaveBeenCalled();
      const replay = jest.fn();
      events.subscribeProviderConnections(replay)();
      expect(replay).not.toHaveBeenCalled();
      expect(status).toMatchObject({
        enabled: false,
        account: null,
        phase: 'idle',
      });
      // A real new grant for the same account remains an in-app reconnection.
      await expect(
        connectCopilot(new AbortController().signal, () => undefined),
      ).resolves.toMatchObject({ enabled: true, account });
      expect(connection).toHaveBeenCalledTimes(1);
      expect(connection).toHaveBeenCalledWith({
        provider: 'copilot',
        connectionMethod: 'native_login',
        connectSource: 'in_app',
      });
      await copilotConnectionStatus();
      expect(connection).toHaveBeenCalledTimes(1);
    } finally {
      delayed.release.resolve();
      await delayed.pending;
      stop();
    }
  });

  it('counts a committed same-account reconnection after an expired grant', async () => {
    const events = await import('../lib/provider-connection-events');
    events.resetProviderConnectionEventsForTests();
    const connection = jest.fn();
    const stop = events.subscribeProviderConnections(connection);
    connected();
    await copilotConnectionStatus();
    connection.mockClear();
    store.read = {
      status: 'present',
      credential: credentialFor('octocat', {
        refreshTokenExpiresAt: new Date(Date.now() - HOUR).toISOString(),
      }),
    };
    await connectCopilot(new AbortController().signal, () => undefined);
    expect(connection).toHaveBeenCalledTimes(1);
    expect(connection).toHaveBeenCalledWith({
      provider: 'copilot',
      connectionMethod: 'native_login',
      connectSource: 'in_app',
    });
    stop();
  });

  it('is not connected when the preference is set but no credential exists', async () => {
    mockPreferences.copilotEnabled = true;
    mockPreferences.copilotAccount = account;
    await expect(copilotConnectionStatus()).resolves.toMatchObject({
      enabled: false,
      phase: 'idle',
      account: null,
    });
  });

  it('retries failed startup recovery before admitting a consumer, sharing each attempt', async () => {
    connected();
    await jest.isolateModulesAsync(async () => {
      const connection = await import('../copilot/connection');
      const first = deferred();
      mockReap.mockImplementationOnce(async () => {
        await first.promise;
        throw new Error('temporary process inspection failure');
      });
      const recovery = connection.recoverCopilotAtStartup();
      expect(connection.recoverCopilotAtStartup()).toBe(recovery);
      const blocked = connection.openManagedCopilotRuntime({
        signal: new AbortController().signal,
      });
      const failedRecovery = expect(recovery).rejects.toThrow('temporary');
      const failedOpen = expect(blocked).rejects.toThrow('temporary');
      first.resolve();
      await Promise.all([failedRecovery, failedOpen]);
      expect(mockStart).not.toHaveBeenCalled();
      expect(mockReap).toHaveBeenCalledTimes(1);

      const retry = deferred();
      mockReap.mockImplementationOnce(() => retry.promise);
      const opening = connection.openManagedCopilotRuntime({
        signal: new AbortController().signal,
      });
      const recovering = connection.recoverCopilotAtStartup();
      expect(connection.recoverCopilotAtStartup()).toBe(recovering);
      expect(mockStart).not.toHaveBeenCalled();
      retry.resolve();
      const runtime = await opening;
      await recovering;
      expect(mockReap).toHaveBeenCalledTimes(2);
      // Successful recovery must stay cached: repeating the reaper could kill
      // receipts belonging to a runtime admitted during this boot.
      await Promise.all([
        connection.recoverCopilotAtStartup(),
        connection.recoverCopilotAtStartup(),
      ]);
      expect(mockReap).toHaveBeenCalledTimes(2);
      await runtime.close();
    });
  });

  it('is not connected when the credential cannot be read', async () => {
    connected();
    store.read = { status: 'unreadable' };
    await expect(copilotConnectionStatus()).resolves.toMatchObject({
      enabled: false,
    });
    expect(store.cleared).toBe(0);
  });

  it.each(['fresh', 'expired'] as const)(
    'reads only the account with a %s access token (T11)',
    async (access) => {
      connected();
      store.read = {
        status: 'present',
        credential: credentialFor('octocat', {
          accessTokenExpiresAt: new Date(
            Date.now() + (access === 'fresh' ? HOUR : -HOUR),
          ).toISOString(),
        }),
      };
      const mint = jest.spyOn(grantAuthority, 'copilotGrantAuthority');
      try {
        await expect(readCopilotAccount()).resolves.toEqual(account);
        expect(mint).not.toHaveBeenCalled();
        expect(mockRefresh).not.toHaveBeenCalled();
        expect(mockStart).not.toHaveBeenCalled();
        expect(mockIdentity).not.toHaveBeenCalled();
        expect(store.saved).toEqual([]);
        expect(store.cleared).toBe(0);
      } finally {
        mint.mockRestore();
      }
    },
  );

  it.each([
    'absent',
    'unreadable',
    'expired-grant',
    'different-account',
  ] as const)(
    'refuses an account-only read for %s without a runtime fallback',
    async (state) => {
      connected();
      if (state === 'absent' || state === 'unreadable')
        store.read = { status: state };
      else
        store.read = {
          status: 'present',
          credential: credentialFor(
            state === 'different-account' ? 'hubot' : 'octocat',
            state === 'expired-grant'
              ? {
                  refreshTokenExpiresAt: new Date(
                    Date.now() - HOUR,
                  ).toISOString(),
                }
              : {},
          ),
        };
      await expect(readCopilotAccount()).resolves.toBeNull();
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(mockStart).not.toHaveBeenCalled();
      expect(store.saved).toEqual([]);
      expect(store.cleared).toBe(0);
    },
  );

  it('connects through the device flow, checks identity and Copilot access, then pins', async () => {
    const events = await import('../lib/provider-connection-events');
    events.resetProviderConnectionEventsForTests();
    const connection = jest.fn();
    const stop = events.subscribeProviderConnections(connection);
    const phases: string[] = [];
    const progress = jest.fn((status: { phase: string; userCode?: string }) => {
      phases.push(status.phase);
    });
    await expect(
      connectCopilot(new AbortController().signal, progress),
    ).resolves.toMatchObject({ enabled: true, phase: 'connected', account });
    expect(connection).toHaveBeenCalledWith({
      provider: 'copilot',
      connectionMethod: 'native_login',
      connectSource: 'in_app',
    });
    stop();
    expect(mockStartFlow).toHaveBeenCalledWith(
      { clientId: 'Iv23test', baseUrl: undefined },
      expect.any(AbortSignal),
    );
    expect(phases).toContain('authorizing');
    expect(phases).toContain('checking');
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'authorizing',
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
      }),
    );
    expect(mockIdentity).toHaveBeenCalledTimes(1);
    expect(mockModels).toHaveBeenCalledWith({ gitHubToken: 'ghu_octocat' });
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toMatchObject({
      login: 'octocat',
      id: '1',
      clientId: 'Iv23test',
    });
    expect(mockPreferences).toEqual({
      copilotEnabled: true,
      copilotAccount: account,
    });
  });

  it('never saves when the user declines or the code expires', async () => {
    mockPollFlow.mockResolvedValueOnce({ status: 'declined' });
    await expect(
      connectCopilot(new AbortController().signal, () => undefined),
    ).rejects.toThrow('GitHub sign-in was declined.');
    mockPollFlow.mockResolvedValueOnce({ status: 'expired' });
    await expect(
      connectCopilot(new AbortController().signal, () => undefined),
    ).rejects.toThrow('The GitHub code expired. Connect again.');
    expect(store.saved).toHaveLength(0);
    expect(mockPreferences.copilotEnabled).toBe(false);
  });

  it('never saves when the account has no Copilot access', async () => {
    mockModels.mockRejectedValueOnce(new Error('403'));
    await expect(
      connectCopilot(new AbortController().signal, () => undefined),
    ).rejects.toThrow("This GitHub account doesn't have Copilot access.");
    expect(store.saved).toHaveLength(0);
  });

  it('proves access on the setup probe without interpreting the catalog', async () => {
    // Catalog validation belongs to model discovery; the probe proves access.
    const unnamedModel = {
      id: 'unnamed',
      name: '',
      policy: { state: '' },
    };
    Reflect.deleteProperty(unnamedModel, 'name');
    Reflect.deleteProperty(unnamedModel, 'policy');
    mockModels.mockResolvedValueOnce({ models: [unnamedModel] });
    await expect(
      connectCopilot(new AbortController().signal, () => undefined),
    ).resolves.toMatchObject({ phase: 'connected', account });
    expect(mockModels).toHaveBeenCalledTimes(1);
    expect(store.saved).toHaveLength(1);
  });

  const POLICY_REFUSAL =
    'Request models.list failed with message: GenericFailure, {"kind":"http","status":403,"statusText":"Forbidden","body":"unauthorized: not authorized to use this Copilot feature\\n","hasRequestId":true}';
  const POLICY =
    "An organization policy blocks Copilot CLI for this GitHub account. Ask an organization owner to enable Copilot CLI in the organization's Copilot policies, then connect again.";

  it('names the organization policy when the Copilot service refuses the access probe', async () => {
    mockModels.mockRejectedValueOnce(new Error(POLICY_REFUSAL));
    await expect(
      connectCopilot(new AbortController().signal, () => undefined),
    ).rejects.toThrow(POLICY);
    expect(store.saved).toHaveLength(0);
  });

  it('reports the organization policy refusal from model discovery by name', async () => {
    connected();
    mockModels.mockRejectedValueOnce(new Error(POLICY_REFUSAL));
    await expect(
      listCopilotModels(new AbortController().signal),
    ).rejects.toMatchObject({ name: 'CopilotPolicyError', message: POLICY });
  });

  it('refuses to connect without encryption', async () => {
    store.available = false;
    await expect(
      connectCopilot(new AbortController().signal, () => undefined),
    ).rejects.toThrow("Couldn't store the Copilot sign-in on this device.");
    expect(mockStartFlow).not.toHaveBeenCalled();
  });

  it('stops polling and saves nothing when cancelled', async () => {
    const controller = new AbortController();
    mockPollFlow.mockImplementationOnce(
      (...args) =>
        new Promise<never>((...executorArgs) => {
          const signal = args[2];
          const reject = executorArgs[1];
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
          controller.abort();
        }),
    );
    await expect(
      connectCopilot(controller.signal, () => undefined),
    ).rejects.toThrow();
    expect(store.saved).toHaveLength(0);
    expect(mockPreferences.copilotEnabled).toBe(false);
  });

  it('change account signs out before starting a new device flow', async () => {
    connected();
    mockIdentity.mockResolvedValueOnce({ data: { login: 'hubot', id: 2 } });
    mockPollFlow.mockResolvedValueOnce({
      ...grant(),
      grant: {
        ...grant().grant,
        accessToken: 'ghu_hubot',
        refreshToken: 'ghr_hubot',
      },
    });
    await expect(
      connectCopilot(new AbortController().signal, () => undefined, true),
    ).resolves.toMatchObject({ account: other });
    expect(store.cleared).toBe(1);
    expect(store.saved[0]).toMatchObject({ login: 'hubot' });
  });

  it('disconnect removes the credential and disables the connection', async () => {
    connected();
    await disconnectCopilot();
    expect(store.cleared).toBe(1);
    expect(mockPreferences).toEqual({
      copilotEnabled: false,
      copilotAccount: undefined,
    });
    await expect(copilotConnectionStatus()).resolves.toMatchObject({
      enabled: false,
    });
  });

  it('asks to connect in Settings, wherever the release puts Copilot setup', async () => {
    await expect(
      openManagedCopilotRuntime({ signal: new AbortController().signal }),
    ).rejects.toThrow(new Error('Connect GitHub Copilot in Settings.'));
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('opens a managed runtime only with a pinned, readable credential', async () => {
    connected();
    const runtime = await openManagedCopilotRuntime({
      signal: new AbortController().signal,
    });
    expect(runtime.account).toEqual(account);
    await expect(sessionToken(runtime)).resolves.toBe('ghu_octocat');
    await runtime.close();
    store.read = { status: 'absent' };
    await expect(
      openManagedCopilotRuntime({ signal: new AbortController().signal }),
    ).rejects.toThrow(
      'Copilot sign-in expired. Reconnect Copilot in Settings.',
    );
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("refreshes once when two consumers open runtimes in the token's last hour", async () => {
    mockPreferences.copilotEnabled = true;
    mockPreferences.copilotAccount = account;
    store.read = {
      status: 'present',
      credential: credentialFor('octocat', {
        accessTokenExpiresAt: new Date(Date.now() + HOUR / 2).toISOString(),
      }),
    };
    mockRefresh.mockImplementation(() =>
      Promise.resolve({
        accessToken: 'ghu_rotated',
        accessTokenExpiresAt: new Date(Date.now() + 8 * HOUR).toISOString(),
        refreshToken: 'ghr_rotated',
        refreshTokenExpiresAt: new Date(Date.now() + 1000 * HOUR).toISOString(),
      }),
    );
    const runtimes = await Promise.all([
      openManagedCopilotRuntime({ signal: new AbortController().signal }),
      openManagedCopilotRuntime({ signal: new AbortController().signal }),
    ]);
    try {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      await expect(sessionToken(runtimes[1])).resolves.toBe('ghu_rotated');
    } finally {
      await Promise.all(runtimes.map((runtime) => runtime.close()));
    }
  });

  it('reports an expired code when polling is cut off after the code lifetime', async () => {
    mockStartFlow.mockResolvedValueOnce({
      ...flowStart(),
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    mockPollFlow.mockRejectedValueOnce(
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      }),
    );
    await expect(
      connectCopilot(new AbortController().signal, () => undefined),
    ).rejects.toThrow('The GitHub code expired. Connect again.');
    expect(store.saved).toHaveLength(0);
    // GitHub's code lives 15 minutes from issue, after the download; the
    // overall cap must cover a bounded install plus the whole code lifetime.
    expect(COPILOT_SETUP_TIMEOUT_MS).toBeGreaterThanOrEqual(
      COPILOT_INSTALL_TIMEOUT_MS + 15 * 60_000 + 60_000,
    );
  });

  it('is not connected when the refresh token has expired', async () => {
    connected();
    store.read = {
      status: 'present',
      credential: credentialFor('octocat', {
        accessTokenExpiresAt: new Date(Date.now() - HOUR).toISOString(),
        refreshTokenExpiresAt: new Date(Date.now() - 1).toISOString(),
      }),
    };
    await expect(copilotConnectionStatus()).resolves.toMatchObject({
      enabled: false,
      account: null,
    });
    // A dead credential must not let Connect skip the device flow.
    await connectCopilot(new AbortController().signal, () => undefined);
    expect(mockStartFlow).toHaveBeenCalledTimes(1);
  });

  it('invalidates runtime availability when a rejected refresh clears the credential', async () => {
    connected();
    store.read = {
      status: 'present',
      credential: credentialFor('octocat', {
        accessTokenExpiresAt: new Date(Date.now() + HOUR / 2).toISOString(),
      }),
    };
    const { DeviceFlowRefreshRejectedError } = jest.requireMock<{
      DeviceFlowRefreshRejectedError: new (message: string) => Error;
    }>('@canopy/desktop-shared/node/copilot/device-flow');
    mockRefresh.mockRejectedValueOnce(
      new DeviceFlowRefreshRejectedError('bad_refresh_token'),
    );
    mockInvalidateAvailability.mockClear();
    await expect(
      openManagedCopilotRuntime({ signal: new AbortController().signal }),
    ).rejects.toThrow(
      'Copilot sign-in expired. Reconnect Copilot in Settings.',
    );
    expect(store.cleared).toBe(1);
    expect(mockInvalidateAvailability).toHaveBeenCalled();
  });

  const rejectNextRefresh = () => {
    connected();
    store.read = {
      status: 'present',
      credential: credentialFor('octocat', {
        accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    };
    const { DeviceFlowRefreshRejectedError } = jest.requireMock<{
      DeviceFlowRefreshRejectedError: new (message: string) => Error;
    }>('@canopy/desktop-shared/node/copilot/device-flow');
    mockRefresh.mockRejectedValueOnce(
      new DeviceFlowRefreshRejectedError('bad_refresh_token'),
    );
  };

  const EXPIRED = 'Copilot sign-in expired. Reconnect Copilot in Settings.';

  it('reports an expiry the background quota probe found on every model request', async () => {
    rejectNextRefresh();
    await expect(
      readCopilotUsageSummary(new AbortController().signal),
    ).resolves.toMatchObject({
      authState: 'unauthenticated',
      errorInfo: { kind: 'auth' },
    });
    expect(store.cleared).toBe(1);
    await expect(
      listCopilotModels(new AbortController().signal),
    ).rejects.toThrow(EXPIRED);
    await expect(
      listCopilotModels(new AbortController().signal),
    ).rejects.toThrow(EXPIRED);
    // A send validates its model first; it must name the expiry, not an
    // unavailable model.
    await expect(
      assertCopilotModelAvailable('copilot:available'),
    ).rejects.toThrow(EXPIRED);
    await expect(copilotConnectionStatus()).resolves.toMatchObject({
      enabled: false,
    });
  });

  it('reports the expiry to a model request racing the background probe', async () => {
    rejectNextRefresh();
    const [summary, models] = await Promise.allSettled([
      readCopilotUsageSummary(new AbortController().signal),
      listCopilotModels(new AbortController().signal),
    ]);
    expect(summary).toMatchObject({
      status: 'fulfilled',
      value: { authState: 'unauthenticated' },
    });
    expect(models.status).toBe('rejected');
    expect(
      models.status === 'rejected' ? String(models.reason) : models.value,
    ).toContain(EXPIRED);
    await expect(
      listCopilotModels(new AbortController().signal),
    ).rejects.toThrow(EXPIRED);
  });

  it('reports a lapsed refresh token as expired without refreshing', async () => {
    connected();
    store.read = {
      status: 'present',
      credential: credentialFor('octocat', {
        accessTokenExpiresAt: new Date(Date.now() - HOUR).toISOString(),
        refreshTokenExpiresAt: new Date(Date.now() - 1).toISOString(),
      }),
    };
    await expect(
      listCopilotModels(new AbortController().signal),
    ).rejects.toThrow(EXPIRED);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('reports no expiry once the account is disconnected', async () => {
    rejectNextRefresh();
    await readCopilotUsageSummary(new AbortController().signal);
    await disconnectCopilot();
    await expect(
      listCopilotModels(new AbortController().signal),
    ).resolves.toEqual([]);
  });

  it('reports no expiry while the account is being connected again', async () => {
    rejectNextRefresh();
    await readCopilotUsageSummary(new AbortController().signal);
    const installing = deferred();
    const resume = deferred();
    mockInstall.mockImplementationOnce(async () => {
      installing.resolve();
      await resume.promise;
      return '/fixture/copilot';
    });
    const setup = connectCopilot(new AbortController().signal, () => undefined);
    await installing.promise;
    try {
      await expect(
        listCopilotModels(new AbortController().signal),
      ).resolves.toEqual([]);
    } finally {
      resume.resolve();
      await setup;
    }
    await expect(
      listCopilotModels(new AbortController().signal),
    ).resolves.toEqual([expect.objectContaining({ id: 'copilot:available' })]);
  });

  it('keeps an unreadable credential apart from an expired sign-in', async () => {
    connected();
    store.read = { status: 'unreadable' };
    await expect(
      listCopilotModels(new AbortController().signal),
    ).resolves.toEqual([]);
  });

  it('removes a grant saved by a setup that is cancelled before it is pinned', async () => {
    const controller = new AbortController();
    store.onSave = () => controller.abort();
    await expect(
      connectCopilot(controller.signal, () => undefined),
    ).rejects.toThrow();
    expect(store.saved).toHaveLength(1);
    expect(store.read).toEqual({ status: 'absent' });
    expect(mockPreferences).toEqual({
      copilotEnabled: false,
      copilotAccount: undefined,
    });
  });

  it('removes a grant it saved but can no longer read when setup is cancelled before the pin', async () => {
    const controller = new AbortController();
    store.onSave = () => {
      store.read = { status: 'unreadable' };
      controller.abort();
    };
    await expect(
      connectCopilot(controller.signal, () => undefined),
    ).rejects.toThrow();
    expect(store.read).toEqual({ status: 'absent' });
    expect(store.cleared).toBe(1);
  });

  const reconnectingAfterExpiry = () => {
    mockPreferences.copilotEnabled = true;
    mockPreferences.copilotAccount = account;
  };

  it('removes a grant whose save failed after it was installed', async () => {
    reconnectingAfterExpiry();
    store.failCreate = 'after-install';
    await expect(
      connectCopilot(new AbortController().signal, () => undefined),
    ).rejects.toThrow('EIO: directory sync failed');
    expect(store.saved).toHaveLength(1);
    expect(store.read).toEqual({ status: 'absent' });
    expect(store.cleared).toBe(1);
    expect(mockPreferences).toEqual({
      copilotEnabled: false,
      copilotAccount: undefined,
    });
    await expect(copilotConnectionStatus()).resolves.toMatchObject({
      enabled: false,
      account: null,
    });
  });

  it('leaves the stored grant alone when a save fails before it is installed', async () => {
    reconnectingAfterExpiry();
    const previous = credentialFor('hubot');
    store.read = { status: 'present', credential: previous };
    store.failCreate = 'before-install';
    await expect(
      connectCopilot(new AbortController().signal, () => undefined),
    ).rejects.toThrow('ENOSPC: no space left on device');
    expect(store.read).toEqual({ status: 'present', credential: previous });
    expect(store.cleared).toBe(0);
    expect(mockPreferences).toEqual({
      copilotEnabled: true,
      copilotAccount: account,
    });
  });

  it('still reports the expiry after a reconnect whose save failed before it was installed', async () => {
    reconnectingAfterExpiry();
    store.failCreate = 'before-install';
    await expect(
      connectCopilot(new AbortController().signal, () => undefined),
    ).rejects.toThrow('ENOSPC: no space left on device');
    await expect(
      listCopilotModels(new AbortController().signal),
    ).rejects.toThrow(EXPIRED);
  });

  it('unpins the setup when removing a grant whose save failed also fails', async () => {
    reconnectingAfterExpiry();
    store.failCreate = 'after-install';
    store.failDelete = true;
    await expect(
      connectCopilot(new AbortController().signal, () => undefined),
    ).rejects.toThrow('EIO: directory sync failed');
    expect(store.cleared).toBe(1);
    expect(mockPreferences).toEqual({
      copilotEnabled: false,
      copilotAccount: undefined,
    });
  });

  it('keeps a grant it cannot tell from an earlier one inert after a failed save', async () => {
    reconnectingAfterExpiry();
    store.failCreate = 'after-install';
    store.onSave = () => {
      store.read = { status: 'unreadable' };
    };
    await expect(
      connectCopilot(new AbortController().signal, () => undefined),
    ).rejects.toThrow('EIO: directory sync failed');
    // An unreadable entry may predate this setup, so it is not deleted.
    expect(store.cleared).toBe(0);
    expect(mockPreferences.copilotEnabled).toBe(false);
    store.read = { status: 'present', credential: store.saved[0] };
    await expect(copilotConnectionStatus()).resolves.toMatchObject({
      enabled: false,
    });
  });

  it('reports a retryable error when the Copilot access check fails on the network', async () => {
    mockModels.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(
      connectCopilot(new AbortController().signal, () => undefined),
    ).rejects.toThrow(
      "Couldn't check Copilot access. Check your connection and try again.",
    );
    expect(store.saved).toHaveLength(0);
  });

  it('does not write the credential back when a refresh completes after disconnect', async () => {
    connected();
    store.read = {
      status: 'present',
      credential: credentialFor('octocat', {
        accessTokenExpiresAt: new Date(Date.now() + HOUR / 2).toISOString(),
      }),
    };
    let finish: (grant: unknown) => void = () => undefined;
    mockRefresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const opening = openManagedCopilotRuntime({
      signal: new AbortController().signal,
    });
    await Promise.resolve();
    await disconnectCopilot();
    finish({
      accessToken: 'ghu_rotated',
      accessTokenExpiresAt: new Date(Date.now() + 8 * HOUR).toISOString(),
      refreshToken: 'ghr_rotated',
      refreshTokenExpiresAt: new Date(Date.now() + 1000 * HOUR).toISOString(),
    });
    await expect(opening).rejects.toThrow();
    expect(store.saved).toHaveLength(0);
    expect(store.read).toEqual({ status: 'absent' });
  });

  it('fails closed when the stored identity does not match the pin', async () => {
    connected();
    store.read = { status: 'present', credential: credentialFor('hubot') };
    await expect(
      openManagedCopilotRuntime({ signal: new AbortController().signal }),
    ).rejects.toThrow(
      'Copilot sign-in changed. Reconnect the account you want to use in Settings.',
    );
  });

  it('passes the app token to model discovery and usage', async () => {
    connected();
    await expect(
      listCopilotModels(new AbortController().signal),
    ).resolves.toEqual([expect.objectContaining({ id: 'copilot:available' })]);
    expect(mockModels).toHaveBeenCalledWith({ gitHubToken: 'ghu_octocat' });
    await expect(
      readCopilotAccountUsage(new AbortController().signal),
    ).resolves.toMatchObject({
      account,
      limits: [expect.objectContaining({ id: 'chat', usedPercent: 25 })],
    });
    expect(mockQuota).toHaveBeenCalledWith({ gitHubToken: 'ghu_octocat' });
  });

  it('accepts only models enabled for the connected account', async () => {
    connected();
    await expect(
      assertCopilotModelAvailable('copilot:available'),
    ).resolves.toMatchObject({ id: 'copilot:available' });
    await expect(
      assertCopilotModelAvailable('copilot:disabled'),
    ).rejects.toThrow(/unavailable/);
  });

  it('blocks new managed runtimes throughout setup', async () => {
    connected();
    const installing = deferred();
    const resume = deferred();
    mockInstall.mockImplementationOnce(async () => {
      installing.resolve();
      await resume.promise;
      return '/fixture/copilot';
    });
    const setup = connectCopilot(
      new AbortController().signal,
      () => undefined,
      true,
    );
    await installing.promise;
    try {
      const attempt = openManagedCopilotRuntime({
        signal: new AbortController().signal,
      });
      void attempt.then(
        (runtime) => runtime.close(),
        () => undefined,
      );
      await expect(attempt).rejects.toThrow(/setup|changing|connection/i);
    } finally {
      resume.resolve();
      await setup;
    }
  });

  it('advances the generation when a replacement account is committed', async () => {
    connected();
    const before = getCopilotAccountGeneration();
    await connectCopilot(new AbortController().signal, () => undefined, true);
    expect(getCopilotAccountGeneration()).toBeGreaterThan(before);
  });
});
