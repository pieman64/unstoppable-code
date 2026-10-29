/**
 * @jest-environment jsdom
 *
 * Banner-driven refresh classification (same account, another account,
 * signed out, unreadable, mid-refresh identity change) is covered end to end
 * in components/chat/__tests__/referencePreviewInvalidation.test.tsx.
 */
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  announceCanopyCloudAccountChanged,
  canopyCloudAccountIdentity,
  mayChangeCanopyCloudIdentity,
  readCanopyCloudAccountChangeReason,
  refreshAndAnnounceCanopyCloudAccount,
  refreshCanopyCloudAccountData,
} from '../canopyCloudAccountChange';

function signedIn(
  id = 'acct_1',
  overrides: Partial<CanopyCloudAccountPublicState> = {},
): CanopyCloudAccountPublicState {
  return {
    read: 'ok',
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth',
    serverApiKeyId: `key-${id}`,
    capabilities: [],
    storageAvailable: true,
    account: { id, name: 'User', email: `${id}@example.com`, role: 'ADMIN' },
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const SIGNED_OUT: CanopyCloudAccountPublicState = {
  read: 'ok',
  hasApiKey: false,
  authMode: null,
  credentialSource: null,
  capabilities: [],
  storageAvailable: true,
};

describe('canopyCloudAccountChange (CAN-4061)', () => {
  const loadCanopyCloudAccount = jest.fn<
    Promise<CanopyCloudAccountPublicState>,
    []
  >();
  const refreshCanopyCloudEnforcedSettings = jest.fn<
    Promise<CanopyCloudAccountPublicState>,
    []
  >();
  const reasons: string[] = [];
  const record = (event: Event): void => {
    reasons.push(readCanopyCloudAccountChangeReason(event));
  };

  beforeEach(() => {
    reasons.length = 0;
    loadCanopyCloudAccount.mockReset().mockResolvedValue(signedIn());
    refreshCanopyCloudEnforcedSettings
      .mockReset()
      .mockResolvedValue(signedIn());
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { loadCanopyCloudAccount, refreshCanopyCloudEnforcedSettings },
    });
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, record);
  });

  afterEach(() => {
    window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, record);
    Reflect.deleteProperty(window, 'api');
  });

  it('carries a typed reason; legacy and malformed events read as identity changes', () => {
    announceCanopyCloudAccountChanged('same-account-refresh');
    announceCanopyCloudAccountChanged('refresh-failed');
    announceCanopyCloudAccountChanged('identity');
    announceCanopyCloudAccountChanged();
    expect(reasons).toEqual([
      'same-account-refresh',
      'refresh-failed',
      'identity',
      'unknown',
    ]);

    const events = [
      new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT),
      new CustomEvent(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, { detail: 'x' }),
      new CustomEvent(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, {
        detail: { reason: 'refresh' },
      }),
      new CustomEvent(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, {
        detail: { reason: 'same-account-refresh' },
      }),
      new CustomEvent(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, {
        detail: { reason: 'refresh-failed' },
      }),
    ];
    expect(events.map(mayChangeCanopyCloudIdentity)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it('derives identity only from authoritative reads', () => {
    expect(canopyCloudAccountIdentity(null)).toBeNull();
    expect(
      canopyCloudAccountIdentity({ ...signedIn(), read: 'unavailable' }),
    ).toBeNull();
    expect(
      canopyCloudAccountIdentity(
        signedIn('acct_1', { account: undefined, serverApiKeyId: undefined }),
      ),
    ).toBeNull();
    // Refreshable account data is not identity.
    expect(
      canopyCloudAccountIdentity(
        signedIn('acct_1', {
          capabilities: ['teams-v1'],
          updatedAt: '2026-10-13T00:00:00.000Z',
          orgBillingStates: [
            {
              organizationId: 'org-1',
              organizationName: 'Acme',
              teamsEntitled: false,
            },
          ],
        }),
      ),
    ).toBe(canopyCloudAccountIdentity(signedIn()));

    const identities = new Set([
      canopyCloudAccountIdentity(SIGNED_OUT),
      canopyCloudAccountIdentity(signedIn()),
      canopyCloudAccountIdentity(signedIn('acct_2')),
      canopyCloudAccountIdentity(signedIn('acct_1', { serverApiKeyId: 'k2' })),
      canopyCloudAccountIdentity(
        signedIn('acct_1', { authMode: 'guest', credentialSource: 'guest' }),
      ),
      // Same account, new sign-in session.
      canopyCloudAccountIdentity(
        signedIn('acct_1', { createdAt: '2026-10-13T00:00:00.000Z' }),
      ),
    ]);
    expect(identities.size).toBe(6);
  });

  it('reports a re-login of the same account as an identity change', async () => {
    refreshCanopyCloudEnforcedSettings.mockResolvedValue(
      signedIn('acct_1', { createdAt: '2026-10-13T00:00:00.000Z' }),
    );
    await expect(refreshCanopyCloudAccountData()).resolves.toMatchObject({
      status: 'refreshed',
      reason: 'identity',
    });
  });

  it('is not fenced by a same-account refresh that lands mid-refresh', async () => {
    let finish: (value: CanopyCloudAccountPublicState) => void = () => {};
    refreshCanopyCloudEnforcedSettings.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = refreshCanopyCloudAccountData();
    await Promise.resolve();
    await Promise.resolve();
    announceCanopyCloudAccountChanged('same-account-refresh');
    announceCanopyCloudAccountChanged('refresh-failed');
    finish(signedIn());

    await expect(pending).resolves.toMatchObject({
      reason: 'same-account-refresh',
    });
  });

  it('announces a failed probe, destructively only on stored evidence', async () => {
    refreshCanopyCloudEnforcedSettings.mockRejectedValue(new Error('offline'));
    await refreshAndAnnounceCanopyCloudAccount();

    loadCanopyCloudAccount
      .mockResolvedValueOnce(signedIn())
      .mockResolvedValueOnce(SIGNED_OUT);
    await refreshAndAnnounceCanopyCloudAccount();

    // Degraded and unreadable stored reads are not evidence of a change.
    loadCanopyCloudAccount.mockResolvedValue({ ...SIGNED_OUT, read: 'error' });
    await refreshAndAnnounceCanopyCloudAccount();
    loadCanopyCloudAccount.mockRejectedValue(new Error('locked'));
    await refreshAndAnnounceCanopyCloudAccount();

    expect(reasons).toEqual([
      'refresh-failed',
      'identity',
      'refresh-failed',
      'refresh-failed',
    ]);
  });

  it.each(['error', 'unavailable', 'rejected'] as const)(
    'purges when an %s initial read recovers a confirmed identity',
    async (read) => {
      for (const confirmed of [signedIn('acct_2'), SIGNED_OUT]) {
        for (const refreshFails of [false, true]) {
          loadCanopyCloudAccount.mockReset();
          if (read === 'rejected') {
            loadCanopyCloudAccount.mockRejectedValueOnce(new Error('locked'));
          } else {
            loadCanopyCloudAccount.mockResolvedValueOnce({
              ...SIGNED_OUT,
              read,
            });
          }
          loadCanopyCloudAccount.mockResolvedValue(confirmed);
          if (refreshFails) {
            refreshCanopyCloudEnforcedSettings.mockRejectedValue(
              new Error('offline'),
            );
          } else {
            refreshCanopyCloudEnforcedSettings.mockResolvedValue(confirmed);
          }
          await expect(refreshCanopyCloudAccountData()).resolves.toMatchObject({
            status: refreshFails ? 'failed' : 'refreshed',
            reason: 'identity',
          });
        }
      }
    },
  );

  it('announces a refreshed result with its classification', async () => {
    await refreshAndAnnounceCanopyCloudAccount();
    refreshCanopyCloudEnforcedSettings.mockResolvedValue(signedIn('acct_2'));
    await refreshAndAnnounceCanopyCloudAccount();
    refreshCanopyCloudEnforcedSettings.mockResolvedValue({
      ...signedIn(),
      read: 'error',
    });
    await refreshAndAnnounceCanopyCloudAccount();

    expect(reasons).toEqual([
      'same-account-refresh',
      'identity',
      'refresh-failed',
    ]);
  });
});
