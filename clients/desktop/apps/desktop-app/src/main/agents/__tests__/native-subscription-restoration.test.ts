import type { PreferencesData } from '@canopy/desktop-shared/types';

type PreferencesUpdater = (
  latest: Partial<PreferencesData>,
) => Partial<PreferencesData> | null | Promise<Partial<PreferencesData> | null>;

let stored: Partial<PreferencesData> = {};
let afterWrite: (() => void) | undefined;
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<Partial<PreferencesData>> =>
    Promise.resolve(stored),
  updatePreferencesFile: async (
    updater: PreferencesUpdater,
  ): Promise<Partial<PreferencesData>> => {
    const patch = await updater(stored);
    if (patch) {
      stored = { ...stored, ...patch };
      const callback = afterWrite;
      afterWrite = undefined;
      callback?.();
    }
    return stored;
  },
}));

const mockBroadcastPreferencesChanged = jest.fn();
jest.mock('../../lib/preferences-broadcast', () => ({
  broadcastPreferencesChanged: (): void => {
    mockBroadcastPreferencesChanged();
  },
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

import {
  getNativeSubscriptionRestoredAt,
  nativeAccountChangeTestSeams,
  recordNativeSubscriptionRestored,
} from '../native-account-change';
import {
  clearAllProviderQuotaReached,
  isProviderQuotaReached,
  markProviderQuotaReached,
} from '../ai-credits-quota-state';

describe('native subscription restoration', () => {
  beforeEach(() => {
    stored = {};
    afterWrite = undefined;
    mockBroadcastPreferencesChanged.mockClear();
    nativeAccountChangeTestSeams.reset();
    clearAllProviderQuotaReached();
  });

  it('records a fetch-start watermark even without a prior quota latch', async () => {
    const startedAt = Date.now();
    await expect(
      recordNativeSubscriptionRestored(
        'claude',
        'user@example.com',
        startedAt,
        () => true,
      ),
    ).resolves.toBe(true);
    expect(getNativeSubscriptionRestoredAt('claude')).toBe(startedAt);
    expect(stored.nativeProviderAccounts?.claude).toEqual({
      accountKey: 'user@example.com',
      subscriptionRestoredAt: startedAt,
    });
    expect(mockBroadcastPreferencesChanged).toHaveBeenCalledTimes(1);
  });

  it('does not adopt a response for a different confirmed account', async () => {
    stored.nativeProviderAccounts = {
      claude: { accountKey: 'new@example.com' },
    };
    await expect(
      recordNativeSubscriptionRestored(
        'claude',
        'old@example.com',
        Date.now(),
        () => true,
      ),
    ).resolves.toBe(false);
    expect(getNativeSubscriptionRestoredAt('claude')).toBeUndefined();
    expect(stored.nativeProviderAccounts.claude?.accountKey).toBe(
      'new@example.com',
    );
    expect(mockBroadcastPreferencesChanged).not.toHaveBeenCalled();
  });

  it('preserves a newer live rejection and never writes an older watermark', async () => {
    const startedAt = Date.now() - 1;
    markProviderQuotaReached('claude');
    await expect(
      recordNativeSubscriptionRestored(
        'claude',
        'user@example.com',
        startedAt,
        () => true,
      ),
    ).resolves.toBe(false);
    expect(isProviderQuotaReached('claude')).toBe(true);
    expect(stored.nativeProviderAccounts).toBeUndefined();
  });

  it('rolls back its own watermark when a rejection arrives during persistence', async () => {
    const startedAt = Date.now() - 1;
    afterWrite = (): void => {
      markProviderQuotaReached('claude');
    };
    await expect(
      recordNativeSubscriptionRestored(
        'claude',
        'user@example.com',
        startedAt,
        () => true,
      ),
    ).resolves.toBe(false);
    expect(isProviderQuotaReached('claude')).toBe(true);
    expect(getNativeSubscriptionRestoredAt('claude')).toBeUndefined();
    expect(
      stored.nativeProviderAccounts?.claude?.subscriptionRestoredAt,
    ).toBeUndefined();
    expect(mockBroadcastPreferencesChanged).not.toHaveBeenCalled();
  });

  it('preserves the prior recovery when a pending observation is superseded', async () => {
    const priorRestoredAt = Date.now() - 100;
    await recordNativeSubscriptionRestored(
      'claude',
      'user@example.com',
      priorRestoredAt,
      () => true,
    );
    mockBroadcastPreferencesChanged.mockClear();
    markProviderQuotaReached('claude');
    const startedAt = Date.now() + 1;
    let current = true;
    afterWrite = (): void => {
      current = false;
    };
    await expect(
      recordNativeSubscriptionRestored(
        'claude',
        'user@example.com',
        startedAt,
        () => current,
      ),
    ).resolves.toBe(false);
    expect(isProviderQuotaReached('claude')).toBe(true);
    expect(getNativeSubscriptionRestoredAt('claude')).toBe(priorRestoredAt);
    expect(stored.nativeProviderAccounts?.claude?.subscriptionRestoredAt).toBe(
      priorRestoredAt,
    );
    expect(mockBroadcastPreferencesChanged).not.toHaveBeenCalled();
  });

  it('does not write recovery from a superseded usage observation', async () => {
    await expect(
      recordNativeSubscriptionRestored(
        'claude',
        'user@example.com',
        Date.now(),
        () => false,
      ),
    ).resolves.toBe(false);
    expect(stored.nativeProviderAccounts).toBeUndefined();
    expect(mockBroadcastPreferencesChanged).not.toHaveBeenCalled();
  });

  it('clears an older no-reset automatic quota without touching another provider', async () => {
    markProviderQuotaReached('claude');
    markProviderQuotaReached('codex');
    const startedAt = Date.now() + 1;
    await expect(
      recordNativeSubscriptionRestored(
        'claude',
        'user@example.com',
        startedAt,
        () => true,
      ),
    ).resolves.toBe(true);
    expect(isProviderQuotaReached('claude')).toBe(false);
    expect(isProviderQuotaReached('codex')).toBe(true);
  });
});
