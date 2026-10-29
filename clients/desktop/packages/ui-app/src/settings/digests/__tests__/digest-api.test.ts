import {
  ACCOUNT_DIGEST_OWNER,
  readDigestPreferences,
  requestDigest,
  setDigestProfileFeature,
  updateDigestPreferences,
  updateDigestSharing,
  type DigestOwner,
} from '../digest-api';
import { createFakeSettingsClient } from '../../__tests__/helpers/test-settings-host';

const ORG: DigestOwner = { kind: 'organization', organizationId: 'org-1' };

const PREFERENCES = {
  daily: true,
  weekly: false,
  monthly: true,
  weeklyAnchorDay: 3,
  monthlyAnchorDay: 12,
};

function fakeClient(): ReturnType<typeof createFakeSettingsClient> {
  const echo = (input: unknown): unknown => input;
  const share = (): unknown => ({
    sharingEnabled: true,
    sharePath: '/share/digests/slug',
  });
  return createFakeSettingsClient({
    'account.digests.request': () => ({
      status: 'enqueued',
      digestExternalId: 'd-1',
    }),
    'organization.digests.request': () => ({
      status: 'already_exists',
      digestExternalId: 'd-2',
    }),
    'account.notifications.digestPreferences.read': () => PREFERENCES,
    'organization.digests.preferences': () => PREFERENCES,
    'account.notifications.digestPreferences.update': echo,
    'organization.digests.preferences.update': echo,
    'account.digests.share.update': share,
    'organization.digests.sharing.update': () => ({ sharingEnabled: false }),
    'account.digests.profileFeature.set': (input) => input,
  });
}

describe('digest owner operation mapping', () => {
  it('requests an account digest through account.digests.request', async () => {
    const client = fakeClient();

    await expect(
      requestDigest(client, ACCOUNT_DIGEST_OWNER, {
        startDate: '2026-06-01',
        endDate: '2026-06-07',
      }),
    ).resolves.toEqual({ status: 'enqueued', digestExternalId: 'd-1' });
    expect(client.calls).toEqual([
      {
        operation: 'account.digests.request',
        input: { startDate: '2026-06-01', endDate: '2026-06-07' },
      },
    ]);
  });

  it('requests an organization digest through organization.digests.request', async () => {
    const client = fakeClient();

    await requestDigest(client, ORG, {
      startDate: '2026-06-01',
      endDate: '2026-06-07',
    });

    expect(client.calls).toEqual([
      {
        operation: 'organization.digests.request',
        input: {
          organizationId: 'org-1',
          startDate: '2026-06-01',
          endDate: '2026-06-07',
        },
      },
    ]);
  });

  it('maps preference reads and writes per owner', async () => {
    const client = fakeClient();

    await readDigestPreferences(client, ACCOUNT_DIGEST_OWNER);
    await readDigestPreferences(client, ORG);
    await updateDigestPreferences(client, ACCOUNT_DIGEST_OWNER, PREFERENCES);
    await updateDigestPreferences(client, ORG, PREFERENCES);

    expect(client.calls).toEqual([
      {
        operation: 'account.notifications.digestPreferences.read',
        input: {},
      },
      {
        operation: 'organization.digests.preferences',
        input: { organizationId: 'org-1' },
      },
      {
        operation: 'account.notifications.digestPreferences.update',
        input: PREFERENCES,
      },
      {
        operation: 'organization.digests.preferences.update',
        input: { organizationId: 'org-1', ...PREFERENCES },
      },
    ]);
  });

  it('maps share updates per owner and normalizes the result', async () => {
    const client = fakeClient();

    await expect(
      updateDigestSharing(client, ACCOUNT_DIGEST_OWNER, 'd-1', {
        action: 'rotate',
      }),
    ).resolves.toEqual({
      sharingEnabled: true,
      sharePath: '/share/digests/slug',
    });
    // No share path in the response stays absent rather than `undefined`.
    await expect(
      updateDigestSharing(client, ORG, 'd-2', {
        action: 'set-sharing',
        sharingEnabled: false,
      }),
    ).resolves.toStrictEqual({ sharingEnabled: false });

    expect(client.calls).toEqual([
      {
        operation: 'account.digests.share.update',
        input: { digestId: 'd-1', action: 'rotate' },
      },
      {
        operation: 'organization.digests.sharing.update',
        input: {
          organizationId: 'org-1',
          digestId: 'd-2',
          action: 'set-sharing',
          sharingEnabled: false,
        },
      },
    ]);
  });

  it('features a personal digest through account.digests.profileFeature.set', async () => {
    const client = fakeClient();

    await setDigestProfileFeature(client, 'd-1', 'org-9', true);

    expect(client.calls).toEqual([
      {
        operation: 'account.digests.profileFeature.set',
        input: { digestId: 'd-1', organizationId: 'org-9', featured: true },
      },
    ]);
  });
});
