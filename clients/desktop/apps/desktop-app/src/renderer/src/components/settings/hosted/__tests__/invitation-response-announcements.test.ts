/**
 * @jest-environment jsdom
 */
import { SettingsOperationError } from '@canopy/protocol/settings';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { createFakeSettingsClient } from '@canopy/ui-app/settings/__tests__/helpers/test-settings-host';
import { readCanopyCloudAccountChangeReason } from '@/lib/canopyCloudAccountChange';
import { withInvitationResponseAnnouncements } from '../invitation-response-announcements';

describe('withInvitationResponseAnnouncements', () => {
  let reasons: string[];
  const record = (event: Event): void => {
    reasons.push(readCanopyCloudAccountChangeReason(event));
  };

  beforeEach(() => {
    reasons = [];
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, record);
  });

  afterEach(() => {
    window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, record);
  });

  it.each(['accept', 'decline'] as const)(
    'announces one same-account refresh after a Settings %s resolves',
    async (action) => {
      let complete: () => void = () => {};
      const fake = createFakeSettingsClient({
        'organization.invitations.respond': () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      });
      const client = withInvitationResponseAnnouncements(fake);
      const write = client.write('organization.invitations.respond', {
        inviteId: 'invite-1',
        action,
      });
      await Promise.resolve();
      // The switcher would re-read before the server consumed the invitation.
      expect(reasons).toEqual([]);
      complete();
      await write;
      expect(reasons).toEqual(['same-account-refresh']);
      expect(fake.calls).toEqual([
        {
          operation: 'organization.invitations.respond',
          input: { inviteId: 'invite-1', action },
        },
      ]);
    },
  );

  it('announces nothing when the response fails', async () => {
    const client = withInvitationResponseAnnouncements(
      createFakeSettingsClient({
        'organization.invitations.respond': () => {
          throw new SettingsOperationError({ code: 'failed', status: 500 });
        },
      }),
    );
    await expect(
      client.write('organization.invitations.respond', {
        inviteId: 'invite-1',
        action: 'accept',
      }),
    ).rejects.toBeInstanceOf(SettingsOperationError);
    expect(reasons).toEqual([]);
  });

  it('passes other writes, reads and subscriptions through without announcing', async () => {
    const fake = createFakeSettingsClient({
      'organization.leave': () => null,
      'organization.invitations.incoming': () => ({ invitations: [] }),
    });
    const client = withInvitationResponseAnnouncements(fake);
    await client.write('organization.leave', { organizationId: 'org-1' });
    await expect(
      client.read('organization.invitations.incoming', {}),
    ).resolves.toEqual({ invitations: [] });
    const events: unknown[] = [];
    const unsubscribe = client.subscribe({ kind: 'credit-pool' }, (event) => {
      events.push(event);
    });
    expect(fake.subscriptions).toEqual([{ kind: 'credit-pool' }]);
    unsubscribe();
    expect(reasons).toEqual([]);
  });
});
