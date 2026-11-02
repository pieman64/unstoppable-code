import { createHash } from 'node:crypto';
import {
  isDesktopPostHogOperationCaptureEnabled,
  startDesktopOperation,
  succeedDesktopOperation,
  failDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import {
  readPostHogIdentityKey,
  recordPostHogInviteAcceptance,
} from '../lib/anonymous-id';
import {
  recordInviteSendTelemetry,
  recordInviteAcceptTelemetry,
  recordOrganizationCreateTelemetry,
  startRemotePairingTelemetry,
} from '../lib/desktop-telemetry';
import { invitationReference } from '../lib/invitation-reference';

jest.mock('../lib/anonymous-id', () => ({
  readPostHogIdentityKey: jest.fn(),
  recordPostHogInviteAcceptance: jest.fn(),
}));
jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  isDesktopPostHogOperationCaptureEnabled: jest.fn(),
  startDesktopOperation: jest.fn(),
  succeedDesktopOperation: jest.fn(),
  failDesktopOperation: jest.fn(),
}));
const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isDesktopPostHogOperationCaptureEnabled).mockReturnValue(true);
  jest.mocked(readPostHogIdentityKey).mockResolvedValue('install-key');
  jest.mocked(recordPostHogInviteAcceptance).mockResolvedValue({
    is_first_accept_on_install: true,
    install_age_days: 3,
  });
});

it('hashes only the approved domains with identical sender/recipient references', () => {
  const id = 'invitation-external-fixture';
  expect(invitationReference('organization', id)).toBe(
    createHash('sha256')
      .update(`organization:${id}`)
      .digest('hex')
      .slice(0, 16),
  );
  expect(
    new Set(
      (['organization', 'teammate_share', 'teammate_share_grant'] as const).map(
        (domain) => invitationReference(domain, id),
      ),
    ).size,
  ).toBe(3);
  expect(invitationReference('organization', id)).toMatch(/^[a-f0-9]{16}$/);
});

it.each([
  'sent',
  'resent',
  'deferred-for-payment',
  'email-suppressed',
] as const)(
  'captures confirmed organization delivery %s without identity',
  async (delivery) => {
    recordInviteSendTelemetry({
      inviteType: 'organization',
      inviteId: 'private-invite',
      recipientKind: 'email',
      sendSurface: 'invite_dialog',
      delivery,
    });
    await flush();
    expect(succeedDesktopOperation).toHaveBeenCalledWith(
      'canopy.invite_send',
      expect.objectContaining({
        context: {
          invite_type: 'organization',
          invite_ref: invitationReference('organization', 'private-invite'),
          recipient_kind: 'email',
          send_surface: 'invite_dialog',
          delivery,
        },
      }),
    );
    expect(
      JSON.stringify(jest.mocked(succeedDesktopOperation).mock.calls),
    ).not.toContain('private-invite');
  },
);

it('joins teammate accepts at container level, sends at grant level, and preserves milestone ordering', async () => {
  recordInviteSendTelemetry({
    inviteType: 'teammate_share',
    inviteId: 'private-container',
    grantId: 'private-grant',
    recipientKind: 'member',
    sendSurface: 'share_dialog',
    shareAudience: 'team',
    containerType: 'WORKTREE',
  });
  recordInviteAcceptTelemetry({
    inviteType: 'teammate_share',
    inviteId: 'private-container',
    acceptSurface: 'desktop_share_accept',
  });
  await flush();
  expect(recordPostHogInviteAcceptance).toHaveBeenCalledWith(
    'install-key',
    expect.any(Number),
    expect.any(Function),
  );
  const contexts = jest
    .mocked(succeedDesktopOperation)
    .mock.calls.map((call) => call[1]?.context);
  expect(contexts[0]).toMatchObject({
    invite_ref: invitationReference('teammate_share', 'private-container'),
    grant_ref: invitationReference('teammate_share_grant', 'private-grant'),
  });
  expect(contexts[1]).toEqual({
    invite_type: 'teammate_share',
    invite_ref: contexts[0]?.invite_ref,
    accept_surface: 'desktop_share_accept',
    is_first_accept_on_install: true,
    install_age_days: 3,
  });
});

it('does not consume claims while disabled, including after scheduling, and omits failed metadata', async () => {
  jest.mocked(isDesktopPostHogOperationCaptureEnabled).mockReturnValue(false);
  recordInviteAcceptTelemetry({
    inviteType: 'organization',
    inviteId: 'invite',
    acceptSurface: 'desktop_switcher',
  });
  expect(readPostHogIdentityKey).not.toHaveBeenCalled();
  jest.mocked(isDesktopPostHogOperationCaptureEnabled).mockReturnValue(true);
  recordInviteAcceptTelemetry({
    inviteType: 'organization',
    inviteId: 'invite',
    acceptSurface: 'desktop_switcher',
  });
  jest.mocked(isDesktopPostHogOperationCaptureEnabled).mockReturnValue(false);
  await flush();
  expect(recordPostHogInviteAcceptance).not.toHaveBeenCalled();
  expect(startDesktopOperation).not.toHaveBeenCalled();
  jest.mocked(isDesktopPostHogOperationCaptureEnabled).mockReturnValue(true);
  jest
    .mocked(recordPostHogInviteAcceptance)
    .mockRejectedValue(new Error('disk'));
  recordInviteAcceptTelemetry({
    inviteType: 'organization',
    inviteId: 'invite',
    acceptSurface: 'desktop_switcher',
  });
  await flush();
  expect(succeedDesktopOperation).toHaveBeenCalledWith(
    'canopy.invite_accept',
    expect.objectContaining({
      context: {
        invite_type: 'organization',
        invite_ref: invitationReference('organization', 'invite'),
        accept_surface: 'desktop_switcher',
      },
    }),
  );
});

it.each([
  ['approved', undefined],
  ['declined', 'other'],
  ['rejected', 'other'],
  ['failed', 'error'],
  ['cancelled', 'abandoned'],
  ['expired', 'abandoned'],
  ['timed_out', 'abandoned'],
] as const)(
  'records one start and one terminal pairing outcome %s',
  async (outcome, failureReason) => {
    const attempt = startRemotePairingTelemetry({
      pairing_kind: 'phone_code',
      pairing_entry: 'portal_modal',
      peer_platform: 'unknown',
      is_additional_device: false,
    });
    expect(attempt).toBeDefined();
    attempt?.end(outcome);
    attempt?.end('failed');
    await flush();
    expect(
      jest
        .mocked(startDesktopOperation)
        .mock.calls.filter((call) => call[0] === 'canopy.remote_pairing'),
    ).toHaveLength(1);
    expect(succeedDesktopOperation).toHaveBeenCalledWith(
      'canopy.remote_pairing_start',
      expect.anything(),
    );
    const outcomeContext: unknown = expect.objectContaining({ outcome });
    if (failureReason)
      expect(failDesktopOperation).toHaveBeenCalledWith(
        'canopy.remote_pairing',
        failureReason,
        expect.objectContaining({
          context: outcomeContext,
        }),
      );
    else
      expect(succeedDesktopOperation).toHaveBeenCalledWith(
        'canopy.remote_pairing',
        expect.objectContaining({
          context: outcomeContext,
        }),
      );
    expect(
      jest.mocked(failDesktopOperation).mock.calls.length +
        jest
          .mocked(succeedDesktopOperation)
          .mock.calls.filter((call) => call[0] === 'canopy.remote_pairing')
          .length,
    ).toBe(1);
  },
);

it('isolates scheduler failures and invalid creation counts', () => {
  const schedule = jest
    .spyOn(globalThis, 'setImmediate')
    .mockImplementation(() => {
      throw new Error('scheduler');
    });
  try {
    expect(() =>
      recordOrganizationCreateTelemetry({
        creationMethod: 'create',
        inviteIncluded: false,
        projectCount: 0,
      }),
    ).not.toThrow();
    expect(() =>
      recordInviteSendTelemetry({
        inviteType: 'organization',
        inviteId: 'x',
        recipientKind: 'email',
        sendSurface: 'invite_dialog',
        delivery: 'sent',
      }),
    ).not.toThrow();
    expect(() =>
      recordInviteAcceptTelemetry({
        inviteType: 'organization',
        inviteId: 'x',
        acceptSurface: 'desktop_switcher',
      }),
    ).not.toThrow();
  } finally {
    schedule.mockRestore();
  }
  recordOrganizationCreateTelemetry({
    creationMethod: 'create',
    inviteIncluded: false,
    projectCount: -1,
  });
  expect(startDesktopOperation).not.toHaveBeenCalled();
});

it('drops pairing ends without an eligible tracked start or after capture is disabled', async () => {
  jest.mocked(isDesktopPostHogOperationCaptureEnabled).mockReturnValue(false);
  const context = {
    pairing_kind: 'phone_code',
    pairing_entry: 'portal_modal',
    peer_platform: 'unknown',
  } as const;
  expect(startRemotePairingTelemetry(context)).toBeUndefined();
  jest.mocked(isDesktopPostHogOperationCaptureEnabled).mockReturnValue(true);
  const queued = startRemotePairingTelemetry(context);
  jest.mocked(isDesktopPostHogOperationCaptureEnabled).mockReturnValue(false);
  queued?.end('approved');
  await flush();
  expect(startDesktopOperation).not.toHaveBeenCalled();
  jest.mocked(isDesktopPostHogOperationCaptureEnabled).mockReturnValue(true);
  const started = startRemotePairingTelemetry(context);
  await flush();
  jest.mocked(isDesktopPostHogOperationCaptureEnabled).mockReturnValue(false);
  started?.end('approved');
  await flush();
  expect(
    jest.mocked(succeedDesktopOperation).mock.calls.map((call) => call[0]),
  ).toEqual(['canopy.remote_pairing_start']);
});

it('drops queued acceptance when the observed identity has changed', async () => {
  jest
    .mocked(readPostHogIdentityKey)
    .mockResolvedValueOnce('old-install')
    .mockResolvedValue('replacement-install');
  recordInviteAcceptTelemetry({
    inviteType: 'organization',
    inviteId: 'invite',
    acceptSurface: 'desktop_switcher',
  });
  await flush();
  expect(recordPostHogInviteAcceptance).not.toHaveBeenCalled();
  expect(succeedDesktopOperation).not.toHaveBeenCalled();
});

it('records a confirmed invitation without inventing unknown delivery metadata', async () => {
  recordInviteSendTelemetry({
    inviteType: 'organization',
    inviteId: 'legacy-invite',
    recipientKind: 'email',
    sendSurface: 'members_tab',
  });
  await flush();
  expect(succeedDesktopOperation).toHaveBeenCalledWith(
    'canopy.invite_send',
    expect.objectContaining({
      context: {
        invite_type: 'organization',
        invite_ref: invitationReference('organization', 'legacy-invite'),
        recipient_kind: 'email',
        send_surface: 'members_tab',
      },
    }),
  );
});
