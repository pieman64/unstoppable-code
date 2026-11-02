import type { PreferencesData } from '@canopy/desktop-shared/types';

const mockRequestCanopyCloudJson = jest.fn<Promise<unknown>, unknown[]>();
const mockSyncCuratedPluginsForRefresh = jest.fn(() => Promise.resolve(null));
const mockLoadCanopyCloudAccount = jest.fn<Promise<unknown>, []>();
const mockReadPreferencesFile = jest.fn<Promise<PreferencesData>, []>();
let accountListener: ((account: unknown) => void) | null = null;
const mockUnsubscribe = jest.fn();

jest.mock('../canopy-cloud/client', () => ({
  get requestCanopyCloudJson(): typeof mockRequestCanopyCloudJson {
    return mockRequestCanopyCloudJson;
  },
}));
jest.mock('../plugins/plugin-service', () => ({
  get syncCuratedPluginsForRefresh(): typeof mockSyncCuratedPluginsForRefresh {
    return mockSyncCuratedPluginsForRefresh;
  },
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  get loadCanopyCloudAccount(): typeof mockLoadCanopyCloudAccount {
    return mockLoadCanopyCloudAccount;
  },
  subscribeCanopyCloudAccountChanges: jest.fn(
    (listener: (account: unknown) => void): (() => void) => {
      accountListener = listener;
      return mockUnsubscribe;
    },
  ),
}));
jest.mock('../lib/preferences-store', () => ({
  get readPreferencesFile(): typeof mockReadPreferencesFile {
    return mockReadPreferencesFile;
  },
}));

import { DEFAULT_PREFERENCES } from '../lib/preferences-store';

import {
  buildOnboardingProfilePatch,
  startOnboardingProfileSync,
  syncOnboardingProfilePreferences,
} from '../services/onboarding-profile-sync-service';

function preferences(overrides: Partial<PreferencesData>): PreferencesData {
  return { ...DEFAULT_PREFERENCES, ...overrides };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('onboarding profile cloud sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    accountListener = null;
    mockRequestCanopyCloudJson.mockResolvedValue({});
    mockSyncCuratedPluginsForRefresh.mockResolvedValue(null);
    mockLoadCanopyCloudAccount.mockResolvedValue(null);
    mockReadPreferencesFile.mockResolvedValue(preferences({}));
  });

  it('syncs secondary-role changes even when the primary role is unchanged', async () => {
    const selected = preferences({
      profileRole: 'software-engineer',
      profileRoles: ['software-engineer', 'designer'],
    });
    await syncOnboardingProfilePreferences(selected, {
      profileRoles: selected.profileRoles,
    });
    expect(mockRequestCanopyCloudJson).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          profileRole: 'software-engineer',
          profileRoles: ['software-engineer', 'designer'],
          profileRoleDetail: null,
        }),
      }),
    );
    expect(mockSyncCuratedPluginsForRefresh).toHaveBeenCalledWith({
      force: true,
      providerNudge: 'background',
    });
  });

  it('builds a role patch from normalized preferences and clears stale detail', () => {
    expect(
      buildOnboardingProfilePatch(preferences({ profileRole: 'designer' }), {
        profileRole: 'designer',
      }),
    ).toEqual({
      profileRole: 'designer',
      profileRoles: ['designer'],
      profileRoleDetail: null,
    });
  });

  it('includes free-text detail for Other and leaves unrelated fields out', () => {
    expect(
      buildOnboardingProfilePatch(
        preferences({
          profileRole: 'other',
          profileRoleDetail: 'QA lead',
          attributionSource: 'github',
        }),
        { profileRoleDetail: 'QA lead' },
      ),
    ).toEqual({
      profileRole: 'other',
      profileRoles: ['other'],
      profileRoleDetail: 'QA lead',
    });
  });

  it('includes Other detail when Other is a secondary selected role', () => {
    expect(
      buildOnboardingProfilePatch(
        preferences({
          profileRole: 'software-engineer',
          profileRoles: ['software-engineer', 'other'],
          profileRoleDetail: 'Technical writer',
        }),
        { profileRoles: ['software-engineer', 'other'] },
      ),
    ).toEqual({
      profileRole: 'software-engineer',
      profileRoles: ['software-engineer', 'other'],
      profileRoleDetail: 'Technical writer',
    });
  });

  it('PATCHes the authenticated account and refreshes recommendation metadata', async () => {
    await syncOnboardingProfilePreferences(
      preferences({ profileRole: 'product-manager' }),
      { profileRole: 'product-manager' },
    );

    expect(mockRequestCanopyCloudJson).toHaveBeenCalledWith(
      '/api/v1/desktop-app/account/onboarding-profile',
      {
        method: 'PATCH',
        body: JSON.stringify({
          profileRole: 'product-manager',
          profileRoles: ['product-manager'],
          profileRoleDetail: null,
        }),
        timeoutMs: 5_000,
      },
    );
    expect(mockSyncCuratedPluginsForRefresh).toHaveBeenCalledWith({
      force: true,
      providerNudge: 'background',
    });
  });

  it('waits for recommendation refresh before the profile sync resolves', async () => {
    let resolveRefresh = (): void => {
      throw new Error('Refresh promise was not initialized');
    };
    const refreshPromise = new Promise<null>((resolve) => {
      resolveRefresh = (): void => {
        resolve(null);
      };
    });
    mockSyncCuratedPluginsForRefresh.mockReturnValue(refreshPromise);
    let profileSyncResolved = false;

    const profileSync = syncOnboardingProfilePreferences(
      preferences({ profileRole: 'designer' }),
      { profileRole: 'designer' },
    ).then(() => {
      profileSyncResolved = true;
    });

    while (mockSyncCuratedPluginsForRefresh.mock.calls.length === 0) {
      await Promise.resolve();
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(mockSyncCuratedPluginsForRefresh).toHaveBeenCalledWith({
      force: true,
      providerNudge: 'background',
    });
    expect(profileSyncResolved).toBe(false);

    resolveRefresh();
    await profileSync;
    expect(profileSyncResolved).toBe(true);
  });

  it('clears the cloud selection when local roles are explicitly reset', () => {
    expect(
      buildOnboardingProfilePatch(preferences({}), {
        profileRole: undefined,
        profileRoles: undefined,
      }),
    ).toEqual({ profileRole: null, profileRoles: [], profileRoleDetail: null });
  });

  it('does nothing for a preference save unrelated to onboarding', async () => {
    await syncOnboardingProfilePreferences(preferences({ theme: 'ocean' }), {
      theme: 'ocean',
    });

    expect(mockRequestCanopyCloudJson).not.toHaveBeenCalled();
    expect(mockSyncCuratedPluginsForRefresh).not.toHaveBeenCalled();
  });

  it('uploads an existing local role at startup when an account is connected', async () => {
    mockLoadCanopyCloudAccount.mockResolvedValue({ apiKey: 'csk_existing' });
    mockReadPreferencesFile.mockResolvedValue(
      preferences({ profileRole: 'software-engineer' }),
    );

    const dispose = startOnboardingProfileSync();
    await flushAsyncWork();

    expect(mockRequestCanopyCloudJson).toHaveBeenCalledWith(
      '/api/v1/desktop-app/account/onboarding-profile',
      expect.objectContaining({ method: 'PATCH' }),
    );
    dispose();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('uploads the local role when a cloud account is connected later', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      preferences({ profileRole: 'founder' }),
    );

    const dispose = startOnboardingProfileSync();
    await flushAsyncWork();
    expect(mockRequestCanopyCloudJson).not.toHaveBeenCalled();

    accountListener?.({ apiKey: 'csk_new_account' });
    await flushAsyncWork();

    expect(mockRequestCanopyCloudJson).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('retries reconciliation when the same credential reconnects', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      preferences({ profileRole: 'designer' }),
    );

    const dispose = startOnboardingProfileSync();
    await flushAsyncWork();

    accountListener?.({ apiKey: 'csk_reconnected' });
    await flushAsyncWork();
    accountListener?.(null);
    accountListener?.({ apiKey: 'csk_reconnected' });
    await flushAsyncWork();

    expect(mockRequestCanopyCloudJson).toHaveBeenCalledTimes(2);
    dispose();
  });
});
