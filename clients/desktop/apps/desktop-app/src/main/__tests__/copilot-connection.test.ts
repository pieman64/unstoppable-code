/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { CopilotAccount } from '@canopy/desktop-shared/types';
import type * as CopilotRuntimeMetadata from '@canopy/desktop-shared/node/copilot/runtime-metadata';
import type * as CurrentBrand from '@canopy/brand/current';
import type {
  CopilotCredential,
  CopilotCredentialRead,
} from '../copilot/credential-store';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
interface TestRuntime {
  client: {
    rpc: {
      models: { list: jest.Mock };
      account: { getQuota: jest.Mock };
    };
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
    ...overrides,
  };
}
const store: {
  read: CopilotCredentialRead;
  saved: CopilotCredential[];
  cleared: number;
  available: boolean;
  onSave?: () => void;
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
const mockInstall = jest.fn(() => Promise.resolve('/fixture/copilot'));
const mockStart = jest.fn<Promise<TestRuntime>, [{ signal: AbortSignal }]>();
const mockStartFlow = jest.fn<Promise<unknown>, unknown[]>();
const mockPollFlow = jest.fn<Promise<unknown>, unknown[]>();
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
      actual.getCopilotRuntimeArtifact('darwin', 'arm64'),
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
    verify: () => Promise.resolve('/fixture/copilot'),
    install: mockInstall,
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
  getCopilotRuntimeStateDir: () => '/fixture/state',
}));
jest.mock('@canopy/desktop-shared/node/copilot/runtime', () => ({
  startCopilotRuntime: (options: { signal: AbortSignal }) => mockStart(options),
}));
jest.mock('@canopy/desktop-shared/node/copilot/device-flow', () => ({
  startDeviceFlow: (...args: unknown[]) => mockStartFlow(...args),
  pollDeviceFlow: (...args: unknown[]) => mockPollFlow(...args),
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
jest.mock('../copilot/credential-store', () => ({
  isCopilotCredentialStorageAvailable: () => store.available,
  readCopilotCredential: () => Promise.resolve(store.read),
  saveCopilotCredential: (credential: CopilotCredential) => {
    store.saved.push(credential);
    store.read = { status: 'present', credential };
    store.onSave?.();
    return Promise.resolve();
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
  readCopilotAccountUsage,
  revokeCopilotRuntimes,
} from '../copilot/connection';
import { readCopilotUsageSummary } from '../copilot/account-usage';

describe('Copilot connection', () => {
  const runtimes: Array<{
    runtime: TestRuntime;
    parent: Deferred;
    cleanup: Deferred;
  }> = [];
  function makeRuntime(cleanup = deferred()) {
    const parent = deferred();
    const runtime: TestRuntime = {
      client: {
        rpc: { models: { list: mockModels }, account: { getQuota: mockQuota } },
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
    store.read = { status: 'absent' };
    store.saved = [];
    store.cleared = 0;
    store.available = true;
    store.onSave = undefined;
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
    for (const fixture of runtimes) {
      fixture.cleanup.resolve();
      fixture.parent.resolve();
    }
    await revokeCopilotRuntimes();
    runtimes.length = 0;
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

  it('is not connected when the credential cannot be read', async () => {
    connected();
    store.read = { status: 'unreadable' };
    await expect(copilotConnectionStatus()).resolves.toMatchObject({
      enabled: false,
    });
    expect(store.cleared).toBe(0);
  });

  it('connects through the device flow, checks identity and Copilot access, then pins', async () => {
    const phases: string[] = [];
    const progress = jest.fn((status: { phase: string; userCode?: string }) => {
      phases.push(status.phase);
    });
    await expect(
      connectCopilot(new AbortController().signal, progress),
    ).resolves.toMatchObject({ enabled: true, phase: 'connected', account });
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
      (_options: unknown, _start: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
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

  it('opens a managed runtime only with a pinned, readable credential', async () => {
    connected();
    const runtime = await openManagedCopilotRuntime({
      signal: new AbortController().signal,
    });
    expect(runtime.account).toEqual(account);
    await expect(
      runtime.auth.token(new AbortController().signal),
    ).resolves.toBe('ghu_octocat');
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
      await expect(
        runtimes[1].auth.token(new AbortController().signal),
      ).resolves.toBe('ghu_rotated');
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
