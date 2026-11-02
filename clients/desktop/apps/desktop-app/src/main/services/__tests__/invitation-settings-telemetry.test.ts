import { createInvitationSettingsWriteObserver } from '../invitation-settings-telemetry';
const inviteId = '11111111-1111-4111-8111-111111111111';

it('bounds duplicate accepts by account, TTL and capacity and ignores declines', () => {
  let time = 0;
  const accept = jest.fn();
  const report = jest.fn();
  const create = jest.fn();
  let enabled = false;
  const observe = createInvitationSettingsWriteObserver({
    accept,
    report,
    create,
    enabled: () => enabled,
    now: () => time,
  });
  const input = { inviteId, action: 'accept' };
  observe('organization.invitations.respond', input, { ok: true }, 'account-1');
  expect(accept).not.toHaveBeenCalled();
  enabled = true;
  observe(
    'organization.invitations.respond',
    { ...input, action: 'decline' },
    { ok: true },
    'account-1',
  );
  observe('organization.invitations.respond', input, { ok: true }, 'account-1');
  observe('organization.invitations.respond', input, { ok: true }, 'account-1');
  expect(accept).toHaveBeenCalledTimes(1);
  observe('organization.invitations.respond', input, { ok: true }, 'account-2');
  expect(accept).toHaveBeenCalledTimes(2);
  time += 86_400_001;
  observe('organization.invitations.respond', input, { ok: true }, 'account-1');
  expect(accept).toHaveBeenCalledTimes(3);
  expect(accept).toHaveBeenLastCalledWith({
    inviteType: 'organization',
    inviteId,
    acceptSurface: 'desktop_switcher',
  });
});

it('records creation from its own request and ignores promotion (owned by the upgrade hook)', () => {
  const create = jest.fn();
  const observe = createInvitationSettingsWriteObserver({
    accept: jest.fn(),
    report: jest.fn(),
    create,
    enabled: () => true,
  });
  observe('organization.create', { name: 'Private team' }, {}, 'account');
  observe('organization.promote', {}, {}, 'account');
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith({
    creationMethod: 'create',
    inviteIncluded: false,
    projectCount: 0,
  });
});

it.each([
  'sent',
  'resent',
  'deferred-for-payment',
  'email-suppressed',
] as const)('maps members invitation delivery %s once', (delivery) => {
  const report = jest.fn();
  const observe = createInvitationSettingsWriteObserver({
    accept: jest.fn(),
    report,
    create: jest.fn(),
    enabled: () => true,
  });
  observe(
    'organization.members.invite',
    {},
    {
      id: inviteId,
      code: 'private-code',
      emailQueued: delivery === 'sent',
      emailSuppressed: delivery === 'email-suppressed',
      emailDeferred: delivery === 'deferred-for-payment',
      seatPaymentState: 'READY',
      role: 'MEMBER',
      delivery,
    },
    'account',
  );
  expect(report).toHaveBeenCalledWith({
    inviteType: 'organization',
    inviteId,
    recipientKind: 'email',
    sendSurface: 'members_tab',
    delivery,
  });
  expect(JSON.stringify(report.mock.calls)).not.toContain('private-code');
});

it('evicts old duplicate suppression without retaining an unbounded invite ledger', () => {
  const accept = jest.fn();
  const observe = createInvitationSettingsWriteObserver({
    accept,
    report: jest.fn(),
    create: jest.fn(),
    enabled: () => true,
    now: () => 0,
  });
  const input = { inviteId, action: 'accept' };
  observe('organization.invitations.respond', input, {}, 'first');
  for (let i = 0; i < 500; i++)
    observe('organization.invitations.respond', input, {}, `account-${i}`);
  observe('organization.invitations.respond', input, {}, 'first');
  expect(accept).toHaveBeenCalledTimes(502);
});

it('keeps a confirmed legacy invitation while omitting an unavailable sent-versus-resent delivery fact', () => {
  const report = jest.fn();
  const observe = createInvitationSettingsWriteObserver({
    accept: jest.fn(),
    report,
    create: jest.fn(),
    enabled: () => true,
  });
  observe(
    'organization.members.invite',
    {},
    {
      id: inviteId,
      code: 'private-code',
      emailQueued: true,
      emailSuppressed: false,
      emailDeferred: false,
      seatPaymentState: 'READY',
      role: 'MEMBER',
    },
    'account',
  );
  expect(report).toHaveBeenCalledWith({
    inviteType: 'organization',
    inviteId,
    recipientKind: 'email',
    sendSurface: 'members_tab',
  });
});
