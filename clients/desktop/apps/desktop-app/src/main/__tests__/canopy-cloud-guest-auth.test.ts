jest.mock('electron', () => ({
  app: { getVersion: jest.fn(() => '1.2.3') },
}));

const mockRequestPublicJson = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../canopy-cloud/client', () => ({
  requestCanopyCloudJson: jest.fn(),
  requestCanopyCloudPublicJson: (...args: unknown[]): Promise<unknown> =>
    mockRequestPublicJson(...args),
}));

const mockLoadAccount = jest.fn<Promise<unknown>, unknown[]>();
const mockSaveAccount = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (...args: unknown[]): Promise<unknown> =>
    mockLoadAccount(...args),
  saveCanopyCloudAccount: (...args: unknown[]): Promise<unknown> =>
    mockSaveAccount(...args),
  toPublicCanopyCloudAccountState: (
    entry: Record<string, unknown> | null,
  ): Record<string, unknown> => ({
    hasApiKey: !!entry?.apiKey,
    authMode: entry?.authMode ?? null,
    credentialSource: entry?.credentialSource ?? null,
    capabilities: entry?.capabilities ?? [],
    account: entry?.account,
    organizations: entry?.organizations ?? [],
    teams: entry?.teams ?? [],
    enforcedSettings: entry?.enforcedSettings ?? [],
    orgBillingStates: entry?.orgBillingStates ?? [],
    storageAvailable: true,
  }),
}));

const mockPurgeSharedContainerReplicas = jest.fn<Promise<void>, []>();
const mockWithSharedContainerReplicaPurgeFence = jest.fn(
  async (operation: () => Promise<unknown>): Promise<unknown> => {
    await mockPurgeSharedContainerReplicas();
    return operation();
  },
);
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../shared-containers/reconciliation-service', () => ({
  getSharedContainerReconciliationService: (): {
    withReplicaPurgeFence: (
      operation: () => Promise<unknown>,
    ) => Promise<unknown>;
  } => ({
    withReplicaPurgeFence: mockWithSharedContainerReplicaPurgeFence,
  }),
}));

jest.mock('../portal/portal-state-store', () => ({
  readPortalStateStore: jest.fn(
    (): Promise<{ clientDeviceId: string }> =>
      Promise.resolve({ clientDeviceId: 'device-1' }),
  ),
}));

const mockApplyEnforcedSettings = jest.fn<Promise<void>, unknown[]>();
jest.mock('../services/org-enforced-settings', () => ({
  applyEnforcedSettings: (...args: unknown[]): Promise<void> =>
    mockApplyEnforcedSettings(...args),
}));

import {
  mintGuest,
  pauseGuestMintsForRealSignIn,
} from '../canopy-cloud/guest-auth';

const guestResponse = {
  token: 'csk_guest',
  userApiKey: { id: 'guest-key-1' },
  account: {
    id: 'guest-account-1',
    name: 'Guest',
    email: 'guest@example.test',
    role: 'ADMIN',
  },
  capabilities: ['account-v1'],
  organizations: [],
  teams: [],
  enforcedSettings: [],
  orgBillingStates: [],
};

const realAccount = {
  apiKey: 'csk_real',
  authMode: 'oauth' as const,
  credentialSource: 'oauth_desktop' as const,
  capabilities: ['account-v1'],
  account: {
    id: 'account-1',
    name: 'Real User',
    email: 'real@example.test',
    role: 'ADMIN' as const,
  },
  organizations: [],
  teams: [],
  enforcedSettings: [],
  orgBillingStates: [],
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
};

describe('guest mint / real sign-in lifecycle coordination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadAccount.mockResolvedValue(null);
    mockSaveAccount.mockImplementation(
      (entry: unknown): Promise<unknown> => Promise.resolve(entry),
    );
    mockPurgeSharedContainerReplicas.mockResolvedValue(undefined);
    mockApplyEnforcedSettings.mockResolvedValue(undefined);
  });

  it('purges an orphaned replica root before persisting the first guest identity', async () => {
    const events: string[] = [];
    mockPurgeSharedContainerReplicas.mockImplementation(() => {
      events.push('purge-replica-root');
      return Promise.resolve();
    });
    mockSaveAccount.mockImplementation(
      async (entry: unknown, withIdentityTransition: unknown) => {
        expect(withIdentityTransition).toEqual(expect.any(Function));
        return (
          withIdentityTransition as (
            persist: () => Promise<unknown>,
          ) => Promise<unknown>
        )(() => {
          events.push('persist-guest');
          return Promise.resolve(entry);
        });
      },
    );
    mockRequestPublicJson.mockResolvedValueOnce(guestResponse);

    await expect(mintGuest()).resolves.toMatchObject({
      account: { credentialSource: 'guest' },
    });

    expect(events).toEqual(['purge-replica-root', 'persist-guest']);
    expect(mockWithSharedContainerReplicaPurgeFence).toHaveBeenCalledTimes(1);
  });

  it('exposes a guest mint that started before the real-sign-in barrier', async () => {
    let resolveGuest!: (value: typeof guestResponse) => void;
    mockRequestPublicJson.mockReturnValue(
      new Promise<typeof guestResponse>((resolve) => {
        resolveGuest = resolve;
      }),
    );

    const mint = mintGuest();
    const barrier = pauseGuestMintsForRealSignIn();

    expect(barrier.activeGuestMint).toBe(mint);
    resolveGuest(guestResponse);
    await expect(barrier.activeGuestMint).resolves.toMatchObject({
      account: { credentialSource: 'guest' },
    });
    barrier.release();
    await mint;
  });

  it('holds a later guest mint until real sign-in releases, then reuses its account', async () => {
    const barrier = pauseGuestMintsForRealSignIn();
    mockLoadAccount.mockResolvedValue(realAccount);

    const mint = mintGuest();
    await Promise.resolve();
    expect(mockRequestPublicJson).not.toHaveBeenCalled();

    barrier.release();
    await expect(mint).resolves.toMatchObject({
      account: { credentialSource: 'oauth_desktop' },
    });
    expect(mockRequestPublicJson).not.toHaveBeenCalled();
    expect(mockSaveAccount).not.toHaveBeenCalled();
  });

  it('keeps later mints blocked until every concurrent sign-in releases', async () => {
    const firstBarrier = pauseGuestMintsForRealSignIn();
    const secondBarrier = pauseGuestMintsForRealSignIn();
    const mint = mintGuest();

    firstBarrier.release();
    firstBarrier.release();
    await Promise.resolve();
    expect(mockLoadAccount).not.toHaveBeenCalled();
    expect(mockRequestPublicJson).not.toHaveBeenCalled();

    mockLoadAccount.mockResolvedValue(realAccount);
    secondBarrier.release();
    await expect(mint).resolves.toMatchObject({
      account: { credentialSource: 'oauth_desktop' },
    });
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(mockRequestPublicJson).not.toHaveBeenCalled();
  });

  it('recovers after an active guest mint rejects', async () => {
    const failure = new Error('guest network failed');
    mockRequestPublicJson.mockRejectedValueOnce(failure);

    const failedMint = mintGuest();
    const barrier = pauseGuestMintsForRealSignIn();
    await expect(barrier.activeGuestMint).rejects.toBe(failure);
    await expect(failedMint).rejects.toBe(failure);
    barrier.release();

    mockRequestPublicJson.mockResolvedValueOnce(guestResponse);
    await expect(mintGuest()).resolves.toMatchObject({
      account: { credentialSource: 'guest' },
    });
    expect(mockRequestPublicJson).toHaveBeenCalledTimes(2);
  });
});
