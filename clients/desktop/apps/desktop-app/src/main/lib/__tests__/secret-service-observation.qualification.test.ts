// CAN-6087: Linux keeps the Secret Service state in memory. While it is
// secure, account reads, cloud requests and status launch no gdbus probe,
// ever. While it is negative, any operation re-checks at most every 5 s, so
// sign-in recovers after an unlock without Retry. A failed decrypt re-checks
// once; a shown secure storage notice re-checks (throttled); Retry re-checks,
// supersedes an overlapping shown check, and recovers through the CAN-5422
// helper without a restart. The notice reaches main through the
// secure-storage:recheck IPC handler.
import type * as StoreModule from '../canopy-cloud-account-store';
import type * as PolicyModule from '../secure-storage-policy';
import type * as ElectronModule from 'electron';

// Several cases load the full Settings IPC graph after jest.resetModules(),
// and the traffic cases run 27,000 reads; loaded CI runners need more than
// Jest's 5 s default.
jest.setTimeout(30_000);

type ProviderState = 'secure' | 'unavailable' | 'locked';

let mockProviderState: ProviderState = 'secure';
const mockProbes = { sync: 0, async: 0 };
const mockHelper = { probes: 0, decrypts: 0 };
// When set, asynchronous probes wait for the test to answer them.
let mockDeferredProbes: ((state: ProviderState) => void)[] | null = null;

jest.mock('@canopy/core-platform/host-platform', () => ({
  ...jest.requireActual<object>('@canopy/core-platform/host-platform'),
  hostOperatingSystem: (): string => 'linux',
}));

jest.mock('../../canopy-cloud/config', () => ({
  ...jest.requireActual<object>('../../canopy-cloud/config'),
  getCanopyCloudBaseUrl: (): string => 'https://cloud.example.test',
}));

jest.mock('../linux-secret-service', () => ({
  getLinuxSecretServiceState: (): ProviderState => {
    mockProbes.sync += 1;
    return mockProviderState;
  },
  getLinuxSecretServiceStateAsync: (): Promise<ProviderState> => {
    mockProbes.async += 1;
    const deferred = mockDeferredProbes;
    if (!deferred) return Promise.resolve(mockProviderState);
    return new Promise((resolve) => deferred.push(resolve));
  },
}));

// The isolated native helper (CAN-5422), using the mock's UTF-8 cipher.
jest.mock('../linux-safe-storage-recovery', () => ({
  probeLinuxSafeStorageRecovery: (): boolean => {
    mockHelper.probes += 1;
    return mockProviderState === 'secure';
  },
  encryptWithLinuxSafeStorageRecovery: (text: string): Buffer =>
    Buffer.from(text, 'utf8'),
  decryptWithLinuxSafeStorageRecovery: (encrypted: Buffer): string => {
    mockHelper.decrypts += 1;
    return encrypted.toString('utf8');
  },
}));

// The real Settings sign-in owner; HTTP and unrelated enforcement are injected.
jest.mock('../../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../github-pat-env', () => ({
  initializeGitHubPatEnvRuntime: jest.fn(),
}));
jest.mock('../../services/org-enforced-settings', () => ({
  applyEnforcedSettings: jest.fn(),
}));
jest.mock('../../shared-containers/organization-snapshot-transition', () => ({
  organizationSnapshotTransition:
    (): ((persist: () => Promise<unknown>) => Promise<unknown>) =>
    (persist: () => Promise<unknown>): Promise<unknown> =>
      persist(),
}));
jest.mock('../../shared-containers/reconciliation-service', () => ({
  getSharedContainerReconciliationService: (): object => ({
    withReplicaPurgeFence: (
      persist: () => Promise<unknown>,
    ): Promise<unknown> => persist(),
  }),
}));

const ACCOUNT_CACHE_TTL_MS = 5_000;
const NEGATIVE_RECHECK_MS = 5_000;
const SHOWN_RECHECK_MS = 30_000;
const CANDIDATE = 'sk-candidate-0123456789abcdef';
const capabilities = [
  'pipelines-crud-v1',
  'account-v1',
  'organizations-v1',
  'teams-v1',
];

let clock = 1_000_000;
let store: typeof StoreModule;
let policy: typeof PolicyModule;
let electron: typeof ElectronModule;

function resetCounts(): void {
  mockProbes.sync = 0;
  mockProbes.async = 0;
  mockHelper.probes = 0;
  mockHelper.decrypts = 0;
}

async function loadModules(): Promise<void> {
  jest.resetModules();
  store = await import('../canopy-cloud-account-store');
  policy = await import('../secure-storage-policy');
  electron = await import('electron');
}

async function registerSettings(): Promise<void> {
  const { registerSettingsHandlers } = await import('../../ipc/settings');
  registerSettingsHandlers({
    dispatcher: {
      query: (): Promise<never> =>
        Promise.reject(new Error('Unexpected dispatch')),
      instruction: (): Promise<never> =>
        Promise.reject(new Error('Unexpected dispatch')),
    },
    resolveCaller: () => {
      throw new Error('Unexpected caller');
    },
  });
}

/** The notice's IPC path: the registered secure-storage:recheck handler. */
async function invokeRecheckHandler(request: unknown): Promise<unknown> {
  const { registerIpcHandler } = await import('../../ipc/register');
  const { IPC_CHANNELS } = await import('@canopy/desktop-shared/types');
  await registerSettings();
  const registration = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.secureStorageRecheck,
    );
  if (!registration) throw new Error('Missing secure-storage:recheck handler');
  return Reflect.apply(registration[1], undefined, [{}, request]);
}

/** A new session that starts with the keyring locked, then is unlocked. */
async function startLockedThenUnlock(): Promise<void> {
  mockProviderState = 'locked';
  await loadModules();
  resetCounts();
  expect((await store.readCanopyCloudAccountWithStatus()).status).toBe(
    'unavailable',
  );
  expect(mockProbes).toEqual({ sync: 1, async: 0 });
  mockProviderState = 'secure';
  clock += 1_000;
  // Inside the negative re-check window, reads keep the remembered state.
  expect((await store.readCanopyCloudAccountWithStatus()).status).toBe(
    'unavailable',
  );
  expect(mockProbes).toEqual({ sync: 1, async: 0 });
}

function entry(apiKey: string): StoreModule.CanopyCloudAccountEntry {
  return {
    apiKey,
    authMode: 'api_key',
    credentialSource: 'manual',
    capabilities: [],
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
  };
}

beforeEach(async () => {
  clock = 1_000_000;
  mockProviderState = 'secure';
  mockDeferredProbes = null;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  jest.spyOn(Date, 'now').mockImplementation(() => 1_800_000_000_000 + clock);
  await loadModules();
  await store.clearCanopyCloudAccount();
  await store.saveCanopyCloudAccount(entry('csk_observation'));
  expect((await store.readCanopyCloudAccountWithStatus()).status).toBe('ok');
  resetCounts();
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('serves repeated account reads, cloud credentials and status without launching a probe', async () => {
  for (let i = 0; i < 20; i += 1) {
    expect((await store.readCanopyCloudAccountWithStatus()).status).toBe('ok');
    await expect(store.getCanopyCloudCredentials()).resolves.toMatchObject({
      apiKey: 'csk_observation',
    });
    const state = await store.loadCanopyCloudAccountPublicState();
    expect(state.storageAvailable).toBe(true);
    // Every other round misses the account cache and decrypts again.
    clock += ACCOUNT_CACHE_TTL_MS / 2;
  }
  expect(mockProbes).toEqual({ sync: 0, async: 0 });
});

it('launches nothing across ten minutes of cloud traffic while secure', async () => {
  // The profiled rate: 45 account reads per second.
  for (let tick = 0; tick < 45 * 600; tick += 1) {
    clock += 1_000 / 45;
    if (tick % 3 === 0) await store.getCanopyCloudCredentials();
    else if (tick % 3 === 1) await store.readCanopyCloudAccountWithStatus();
    else await store.loadCanopyCloudAccountPublicState();
  }
  expect(mockProbes).toEqual({ sync: 0, async: 0 });
});

it('answers synchronous policy callers from memory, and does not watch for a mid-session lock', () => {
  mockProviderState = 'locked';
  for (let minute = 0; minute < 10; minute += 1) {
    clock += 60_000;
    expect(policy.getSecretStoragePolicy().getStatus().state).toBe('secure');
    policy.getSecretStoragePolicy().assertCanRead();
    expect(policy.getSecretStoragePolicy().isWriteAvailable()).toBe(true);
  }
  // A non-goal: Chromium keeps encrypting with the key it holds, so nothing
  // fails and nothing re-checks until a failure or a shown notice.
  expect(mockProbes).toEqual({ sync: 0, async: 0 });
});

it('re-checks a negative state at most every five seconds under 45 reads a second', async () => {
  await startLockedThenUnlock();
  mockProviderState = 'locked';
  resetCounts();
  for (let tick = 0; tick < 45 * 60; tick += 1) {
    clock += 1_000 / 45;
    if (tick % 3 === 0)
      await expect(store.getCanopyCloudCredentials()).rejects.toThrow();
    else if (tick % 3 === 1)
      expect((await store.readCanopyCloudAccountWithStatus()).status).toBe(
        'unavailable',
      );
    else await store.loadCanopyCloudAccountPublicState();
  }
  expect(mockProbes.async).toBe(0);
  expect(mockProbes.sync).toBeGreaterThan(0);
  expect(mockProbes.sync).toBeLessThanOrEqual(60_000 / NEGATIVE_RECHECK_MS);
});

it('re-checks once after a decrypt fails on a keyring locked mid-session, then refuses from memory', async () => {
  mockProviderState = 'locked';
  // Until something fails or a re-check runs, the remembered state stands.
  expect((await store.readCanopyCloudAccountWithStatus()).status).toBe('ok');
  expect(mockProbes).toEqual({ sync: 0, async: 0 });

  jest.spyOn(electron.safeStorage, 'decryptString').mockImplementation(() => {
    throw new Error('native decrypt failed');
  });
  clock += ACCOUNT_CACHE_TTL_MS;
  const failed = await store.readCanopyCloudAccountWithStatus();
  expect(failed).toMatchObject({
    status: 'unavailable',
    secureStorageFailure: {
      operation: 'read',
      state: 'locked',
      retryable: true,
    },
  });
  expect(mockProbes).toEqual({ sync: 1, async: 0 });

  const publicState = await store.loadCanopyCloudAccountPublicState();
  expect(publicState).toMatchObject({
    read: 'unavailable',
    storageAvailable: false,
    secureStorageStatus: { state: 'locked', writeAvailable: false },
  });
  await expect(store.getCanopyCloudCredentials()).rejects.toThrow();
  for (let i = 0; i < 10; i += 1) {
    clock += 400;
    expect((await store.readCanopyCloudAccountWithStatus()).status).toBe(
      'unavailable',
    );
  }
  // Inside the window the remembered lock refuses reads before they decrypt.
  expect(mockProbes).toEqual({ sync: 1, async: 0 });
  clock += NEGATIVE_RECHECK_MS;
  await store.readCanopyCloudAccountWithStatus();
  expect(mockProbes).toEqual({ sync: 2, async: 0 });
});

it('signs in through the Settings owner after an unlock, without Retry, once the window passes', async () => {
  await startLockedThenUnlock();
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(
    (url): Promise<Response> =>
      Promise.resolve(
        typeof url === 'string' && url.includes('/.well-known/')
          ? Response.json({ capabilities })
          : Response.json({
              account: {
                id: 'account-one',
                name: 'Test account',
                email: 'test@example.test',
                role: 'DEVELOPER',
              },
              capabilities,
              organizations: [],
              teams: [],
            }),
      ),
  );
  try {
    const { saveCanopyCloudApiKeyForWindow } =
      await import('../../ipc/settings');
    await registerSettings();

    // Still inside the window: the pre-read refuses from memory.
    const refused = await saveCanopyCloudApiKeyForWindow({ apiKey: CANDIDATE });
    expect(refused).toMatchObject({
      status: { authenticated: false },
      account: { read: 'unavailable', hasApiKey: false },
    });
    expect(mockProbes).toEqual({ sync: 1, async: 0 });

    clock += NEGATIVE_RECHECK_MS;
    const saved = await saveCanopyCloudApiKeyForWindow({ apiKey: CANDIDATE });
    expect(saved).toMatchObject({
      status: { authenticated: true },
      account: { hasApiKey: true, account: { id: 'account-one' } },
    });
    expect(mockProbes).toEqual({ sync: 2, async: 0 });
    // The parent's native init was not trusted: the helper carried it.
    expect(mockHelper.probes).toBe(1);
    await expect(store.getCanopyCloudCredentials()).resolves.toMatchObject({
      apiKey: CANDIDATE,
    });
  } finally {
    fetchMock.mockRestore();
  }
});

it('recovers on Retry after an unlock, through the helper, without a restart', async () => {
  // Chromium's in-process initialization is not trusted after a locked
  // start, so recovery must use the helper.
  await startLockedThenUnlock();
  const nativeDecrypt = jest.spyOn(electron.safeStorage, 'decryptString');

  await expect(invokeRecheckHandler({ trigger: 'retry' })).resolves.toEqual({
    changed: true,
  });
  expect(mockProbes).toEqual({ sync: 1, async: 1 });
  const recovered = await store.readCanopyCloudAccountWithStatus();
  expect(recovered).toMatchObject({
    status: 'ok',
    entry: { apiKey: 'csk_observation' },
  });
  expect(mockHelper.probes).toBe(1);
  expect(mockHelper.decrypts).toBe(1);
  expect(nativeDecrypt).not.toHaveBeenCalled();
  expect(mockProbes).toEqual({ sync: 1, async: 1 });
});

it('re-checks once when a notice is shown, throttled, while Retry stays unthrottled', async () => {
  await startLockedThenUnlock();

  // Re-renders and other panels showing the notice share one check.
  await expect(invokeRecheckHandler({ trigger: 'shown' })).resolves.toEqual({
    changed: true,
  });
  await expect(invokeRecheckHandler({ trigger: 'shown' })).resolves.toEqual({
    changed: false,
  });
  // A malformed request is the throttled kind, never an unthrottled Retry.
  await expect(invokeRecheckHandler(undefined)).resolves.toEqual({
    changed: false,
  });
  expect(mockProbes).toEqual({ sync: 1, async: 1 });
  expect((await store.readCanopyCloudAccountWithStatus()).status).toBe('ok');

  // Retry inside the window still checks.
  await expect(invokeRecheckHandler({ trigger: 'retry' })).resolves.toEqual({
    changed: false,
  });
  expect(mockProbes).toEqual({ sync: 1, async: 2 });

  clock += SHOWN_RECHECK_MS;
  await expect(invokeRecheckHandler({ trigger: 'shown' })).resolves.toEqual({
    changed: false,
  });
  expect(mockProbes).toEqual({ sync: 1, async: 3 });
});

it('a Retry that finds the keyring still locked keeps the notice reload off the synchronous probe', async () => {
  await startLockedThenUnlock();
  mockProviderState = 'locked';
  await expect(invokeRecheckHandler({ trigger: 'retry' })).resolves.toEqual({
    changed: false,
  });
  expect(mockProbes).toEqual({ sync: 1, async: 1 });

  // The notice reloads right after Retry resolves.
  const reload = await store.readCanopyCloudAccountWithStatus();
  expect(reload).toMatchObject({
    status: 'unavailable',
    secureStorageFailure: { state: 'locked', retryable: true },
  });
  expect(mockProbes).toEqual({ sync: 1, async: 1 });

  clock += NEGATIVE_RECHECK_MS - 1;
  await store.readCanopyCloudAccountWithStatus();
  expect(mockProbes).toEqual({ sync: 1, async: 1 });
  clock += 1;
  await store.readCanopyCloudAccountWithStatus();
  expect(mockProbes).toEqual({ sync: 2, async: 1 });
});

it.each([
  ['the older shown check answers first', [0, 1]],
  ['Retry answers first', [1, 0]],
])(
  'a Retry overlapping a shown check wins when %s',
  async (_order, answerOrder) => {
    await startLockedThenUnlock();
    const deferred: ((state: ProviderState) => void)[] = [];
    mockDeferredProbes = deferred;

    const shown = policy.recheckSecretStorage('shown');
    const retry = policy.recheckSecretStorage('retry');
    expect(deferred).toHaveLength(2);
    // The shown check observed the keyring before the unlock settled.
    const answers: ProviderState[] = ['locked', 'secure'];
    for (const index of answerOrder) {
      deferred[index]?.(answers[index] ?? 'unavailable');
      await Promise.resolve();
    }
    await shown;
    await expect(retry).resolves.toBe(true);
    mockDeferredProbes = null;

    expect(policy.getSecretStoragePolicy().getStatus().state).toBe('secure');
    expect((await store.readCanopyCloudAccountWithStatus()).status).toBe('ok');
    expect(mockProbes).toEqual({ sync: 1, async: 2 });
  },
);
