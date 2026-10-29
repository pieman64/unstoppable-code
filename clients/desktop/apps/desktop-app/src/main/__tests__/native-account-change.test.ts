import type {
  AgentProviderAuthStatus,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import type {
  ConfirmedProviderAuthEvent,
  ProviderAccountConnectSource,
} from '../auth/provider-auth-state';

type PreferencesUpdater = (
  latest: Partial<PreferencesData>,
) => Partial<PreferencesData> | null | Promise<Partial<PreferencesData> | null>;

let stored: Partial<PreferencesData> = {};
const mockReadPreferencesFile = jest.fn(
  (): Promise<Partial<PreferencesData>> => Promise.resolve(stored),
);
const mockUpdatePreferencesFile = jest.fn(
  async (updater: PreferencesUpdater): Promise<Partial<PreferencesData>> => {
    const patch = await updater(stored);
    if (patch) stored = { ...stored, ...patch };
    return stored;
  },
);
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<Partial<PreferencesData>> =>
    mockReadPreferencesFile(),
  updatePreferencesFile: (
    updater: PreferencesUpdater,
  ): Promise<Partial<PreferencesData>> => mockUpdatePreferencesFile(updater),
}));

const mockBroadcastPreferencesChanged = jest.fn((): void => undefined);
jest.mock('../lib/preferences-broadcast', () => ({
  broadcastPreferencesChanged: (): void => mockBroadcastPreferencesChanged(),
}));

const mockClearProviderQuotaReached = jest.fn(
  (provider: string): void => void provider,
);
jest.mock('../agents/ai-credits-quota-state', () => ({
  clearProviderQuotaReached: (provider: string): void =>
    mockClearProviderQuotaReached(provider),
}));

const mockClearContextCache = jest.fn((): void => undefined);
const mockClearModeCache = jest.fn((): void => undefined);
function clearRoutingCaches(): void {
  mockClearContextCache();
  mockClearModeCache();
}

const mockLogWarn = jest.fn((...args: unknown[]): void => void args);
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: (...args: unknown[]): void => mockLogWarn(...args),
}));

import {
  getNativeAccountChangedAt,
  nativeAccountChangeTestSeams,
  startNativeAccountChangeTracking,
} from '../agents/native-account-change';

type Listener = (event: ConfirmedProviderAuthEvent) => void;

function status(
  overrides: Partial<AgentProviderAuthStatus> = {},
): AgentProviderAuthStatus {
  return {
    authenticated: true,
    accountLabel: null,
    detail: null,
    error: null,
    ...overrides,
  };
}

function signedIn(
  provider: 'claude' | 'codex',
  accountEmail: string | null,
  connectSource: ProviderAccountConnectSource = 'in_app',
  accountLabel: string | null = null,
): ConfirmedProviderAuthEvent {
  return {
    provider,
    status: status({ accountEmail, accountLabel }),
    fingerprint: `${provider}:${accountEmail ?? accountLabel ?? 'none'}`,
    connectSource,
  };
}

function start(): { emit: Listener; dispose: () => void } {
  const listeners = new Set<Listener>();
  const dispose = startNativeAccountChangeTracking({
    clearRoutingCaches,
    subscribe: (listener) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  });
  return {
    emit: (event): void => listeners.forEach((listener) => listener(event)),
    dispose,
  };
}

describe('native account change tracking (CAN-4200)', () => {
  beforeEach(() => {
    stored = {};
    nativeAccountChangeTestSeams.reset();
    jest.clearAllMocks();
  });

  it('stores the first observed account as a baseline without a change', async () => {
    const { emit, dispose } = start();
    emit(signedIn('claude', 'A@Example.com'));
    await nativeAccountChangeTestSeams.whenIdle();
    expect(stored.nativeProviderAccounts).toEqual({
      claude: { accountKey: 'a@example.com' },
    });
    expect(getNativeAccountChangedAt('claude')).toBeUndefined();
    expect(mockBroadcastPreferencesChanged).not.toHaveBeenCalled();
    expect(mockClearProviderQuotaReached).not.toHaveBeenCalled();
    dispose();
  });

  it('records a different account as a change and clears quota and caches', async () => {
    jest.useFakeTimers({ now: 5_000 });
    try {
      stored = {
        nativeProviderAccounts: { claude: { accountKey: 'a@example.com' } },
      };
      let changedAtAtBroadcast: number | undefined;
      mockBroadcastPreferencesChanged.mockImplementation(() => {
        changedAtAtBroadcast = getNativeAccountChangedAt('claude');
      });
      const { emit, dispose } = start();
      emit(signedIn('claude', 'b@example.com'));
      await nativeAccountChangeTestSeams.whenIdle();
      expect(stored.nativeProviderAccounts).toEqual({
        claude: { accountKey: 'b@example.com', changedAt: 5_000 },
      });
      expect(getNativeAccountChangedAt('claude')).toBe(5_000);
      expect(changedAtAtBroadcast).toBe(5_000);
      expect(mockBroadcastPreferencesChanged).toHaveBeenCalledTimes(1);
      expect(mockClearProviderQuotaReached).toHaveBeenCalledWith('claude');
      expect(mockClearContextCache).toHaveBeenCalledTimes(1);
      expect(mockClearModeCache).toHaveBeenCalledTimes(1);
      expect(getNativeAccountChangedAt('codex')).toBeUndefined();
      dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('stamps the change with the time the sign-in was observed, not when it was written', async () => {
    jest.useFakeTimers({ now: 5_000 });
    try {
      stored = {
        nativeProviderAccounts: { claude: { accountKey: 'a@example.com' } },
      };
      const { emit, dispose } = start();
      emit(signedIn('claude', 'b@example.com'));
      // A "Use AI Credits" click can land before the queued write runs.
      jest.setSystemTime(9_000);
      await nativeAccountChangeTestSeams.whenIdle();
      expect(getNativeAccountChangedAt('claude')).toBe(5_000);
      expect(stored.nativeProviderAccounts).toEqual({
        claude: { accountKey: 'b@example.com', changedAt: 5_000 },
      });
      dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('treats the same account as a no-op and keeps its change time', async () => {
    stored = {
      nativeProviderAccounts: {
        codex: { accountKey: 'a@example.com', changedAt: 42 },
      },
    };
    const { emit, dispose } = start();
    emit(signedIn('codex', ' a@example.com '));
    await nativeAccountChangeTestSeams.whenIdle();
    expect(stored.nativeProviderAccounts).toEqual({
      codex: { accountKey: 'a@example.com', changedAt: 42 },
    });
    expect(getNativeAccountChangedAt('codex')).toBe(42);
    expect(mockBroadcastPreferencesChanged).not.toHaveBeenCalled();
    expect(mockClearProviderQuotaReached).not.toHaveBeenCalled();
    dispose();
  });

  it('counts a different account confirmed at startup as a change', async () => {
    stored = {
      nativeProviderAccounts: { codex: { accountKey: 'old@example.com' } },
    };
    const { emit, dispose } = start();
    emit(signedIn('codex', 'new@example.com', 'at_startup'));
    await nativeAccountChangeTestSeams.whenIdle();
    expect(getNativeAccountChangedAt('codex')).toEqual(expect.any(Number));
    expect(mockClearProviderQuotaReached).toHaveBeenCalledWith('codex');
    dispose();
  });

  it('falls back to the account label and records nothing without an identity', async () => {
    const { emit, dispose } = start();
    emit(signedIn('claude', null, 'in_app', ' Team plan '));
    emit(signedIn('codex', null));
    await nativeAccountChangeTestSeams.whenIdle();
    expect(stored.nativeProviderAccounts).toEqual({
      claude: { accountKey: 'Team plan' },
    });
    dispose();
  });

  it('serializes a replay and a live observation for one provider', async () => {
    stored = {
      nativeProviderAccounts: { claude: { accountKey: 'a@example.com' } },
    };
    const { emit, dispose } = start();
    emit(signedIn('claude', 'b@example.com', 'at_startup'));
    emit(signedIn('claude', 'b@example.com', 'external_change'));
    await nativeAccountChangeTestSeams.whenIdle();
    expect(mockUpdatePreferencesFile).toHaveBeenCalledTimes(2);
    // The second observation sees the first one's write and is a no-op.
    expect(mockBroadcastPreferencesChanged).toHaveBeenCalledTimes(1);
    expect(mockClearProviderQuotaReached).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('logs a failed write without throwing to the subscriber', async () => {
    mockUpdatePreferencesFile.mockRejectedValueOnce(new Error('disk full'));
    const { emit, dispose } = start();
    expect(() => emit(signedIn('claude', 'a@example.com'))).not.toThrow();
    await nativeAccountChangeTestSeams.whenIdle();
    expect(mockLogWarn).toHaveBeenCalledWith(
      'native-account-change: failed to record claude account',
      'disk full',
    );
    // The chain recovers for the next observation.
    emit(signedIn('claude', 'a@example.com'));
    await nativeAccountChangeTestSeams.whenIdle();
    expect(stored.nativeProviderAccounts).toEqual({
      claude: { accountKey: 'a@example.com' },
    });
    dispose();
  });

  it('seeds the change time from preferences on start', async () => {
    stored = {
      nativeProviderAccounts: {
        claude: { accountKey: 'a@example.com', changedAt: 77 },
      },
    };
    const { dispose } = start();
    await nativeAccountChangeTestSeams.whenIdle();
    expect(getNativeAccountChangedAt('claude')).toBe(77);
    expect(getNativeAccountChangedAt('codex')).toBeUndefined();
    dispose();
  });

  it('stops observing after dispose', async () => {
    const listeners = new Set<Listener>();
    const dispose = startNativeAccountChangeTracking({
      clearRoutingCaches,
      subscribe: (listener) => {
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      },
    });
    dispose();
    expect(listeners.size).toBe(0);
    await nativeAccountChangeTestSeams.whenIdle();
  });
});
