/**
 * @jest-environment jsdom
 */
// CAN-1101: the invitee is now emailed their link. Account-existence metadata
// must not cross the API boundary; these fixtures intentionally omit it while
// exercising the dialog success state and pending list.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createFakeSettingsClient,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';
import type { OrganizationSeatQuote } from '../organization-settings-slots';
// The shell owns the invite dialog's open state; these tests start with it
// open, which saves driving the header action just to reach the dialog.
import { TeamMembersSection } from '../team-members-section';
import {
  buildOrganizationDetail as buildDetail,
  OrganizationTestHost,
  seatChargeSlot,
} from './helpers/members-section-harness';

const getOrgSeatQuoteMock = jest.fn();

// A free seat keeps the charge gate out of the way; the copy under test is
// identical either way.
function freeQuote(): OrganizationSeatQuote {
  return {
    chargeRequired: false,
    amountUsd: 0,
    minimumApplied: false,
    periodEndsAt: '2026-07-31T00:00:00.000Z',
    daysRemaining: 0,
    hasPaymentMethod: true,
    card: { brand: 'visa', last4: '4242' },
  };
}

interface InviteRow {
  id: string;
  code: string;
  status: string;
  organizationId: string | null;
  organizationTeamName: string | null;
  role: string | null;
  invitedEmail: string | null;
  seatPaymentState: 'READY' | 'PROCESSING' | 'FAILED';
  emailQueued?: boolean;
  emailSuppressed?: boolean;
  emailDeferred?: boolean;
}

function buildInviteRow(overrides: Partial<InviteRow> = {}): InviteRow {
  return {
    id: 'invite-1',
    code: 'code-1',
    status: 'ACTIVE',
    organizationId: 'org-1',
    organizationTeamName: null,
    role: 'MEMBER',
    invitedEmail: 'new@example.com',
    seatPaymentState: 'READY',
    emailQueued: true,
    emailSuppressed: false,
    emailDeferred: false,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
let listInvites: InviteRow[] = [];
let createdInvite: InviteRow = buildInviteRow();
let client: FakeSettingsClient;

beforeEach(() => {
  jest.clearAllMocks();
  getOrgSeatQuoteMock.mockResolvedValue(freeQuote());
  listInvites = [];
  createdInvite = buildInviteRow();
  // The list read is the pending-invite refresh; the invite write creates.
  client = createFakeSettingsClient({
    'organization.invitations.list': () => ({
      enabled: true,
      invites: listInvites,
    }),
    'organization.members.invite': () => createdInvite,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container.remove();
});

async function settle(): Promise<void> {
  // The quote load is scheduled on a macrotask (see the `setTimeout(0)` in
  // `AddMemberDialog`), so flushing microtasks alone leaves it loading.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <OrganizationTestHost
        client={client}
        slots={{ seatCharge: seatChargeSlot(getOrgSeatQuoteMock) }}
      >
        <TeamMembersSection
          detail={buildDetail()}
          viewerEmail="owner@example.com"
          onDetailChange={jest.fn()}
          onLeft={jest.fn()}
          adding
          onAddingChange={jest.fn()}
        />
      </OrganizationTestHost>,
    );
    await Promise.resolve();
  });
  await settle();
}

function requireElement(testId: string): HTMLElement {
  const found = document.body.querySelector(`[data-testid="${testId}"]`);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`${testId} was not rendered`);
  }
  return found;
}

/** Drive the controlled email input the way React sees a real keystroke. */
function typeEmail(value: string): void {
  const input = requireElement('add-member-email');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('add-member-email is not an input');
  }
  const setter = (target: HTMLInputElement, next: string): void => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(target, next);
  };
  if (!setter) {
    throw new Error('HTMLInputElement value setter is unavailable');
  }
  setter(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Submit the dialog and return the rendered success panel's text, with the
 * typed address normalized out so two runs with different invitees compare.
 */
async function submitAndReadSuccessText(email: string): Promise<string> {
  await act(async () => {
    typeEmail(email);
    await Promise.resolve();
  });
  const form = requireElement('add-member-submit').closest('form');
  if (!(form instanceof HTMLFormElement)) {
    throw new Error('add-member-submit is not inside a form');
  }
  await act(async () => {
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
  });
  await settle();
  const success = requireElement('add-member-success');
  return (success.textContent ?? '').replace(email, '{email}');
}

describe('add-member success state after the invite email landed', () => {
  it('accepts a creation response without account-existence metadata', async () => {
    createdInvite = buildInviteRow();
    await mount();
    const text = await submitAndReadSuccessText('new@example.com');

    expect(text).toContain('Invitation sent');
    expect(text).toContain('We sent an invitation email to {email}');
    expect(text).toContain('Acme');
    expect(text).toContain('Member');
    expect(text).not.toContain("doesn't have an account");
  });

  it('keeps a copyable invite URL as a delivery fallback', async () => {
    createdInvite = buildInviteRow();
    await mount();
    await submitAndReadSuccessText('new@example.com');

    const success = requireElement('add-member-success');
    // Invite links leave the host, so they always carry the web origin.
    expect(success.textContent ?? '').toContain(
      'https://canopy.test/invite/code-1',
    );
    expect(
      client.calls.find(
        (call) => call.operation === 'organization.members.invite',
      )?.input,
    ).toEqual({
      organizationId: 'org-1',
      email: 'new@example.com',
      role: 'MEMBER',
    });
    expect(success.querySelector('code')).not.toBeNull();
    expect(
      success.querySelector('[aria-label="Copy invite link"]'),
    ).not.toBeNull();
  });

  it('reports a send failure without claiming the email was sent', async () => {
    createdInvite = buildInviteRow({ emailQueued: false });
    await mount();
    const text = await submitAndReadSuccessText('new@example.com');

    expect(text).toContain(
      "Invitation created, but we couldn't send the email",
    );
    expect(text).not.toContain('We sent an invitation email');
    expect(
      requireElement('add-member-success').querySelector(
        '[aria-label="Copy invite link"]',
      ),
    ).not.toBeNull();
  });

  it('explains a cooldown without inviting another immediate retry', async () => {
    createdInvite = buildInviteRow({
      emailQueued: false,
      emailSuppressed: true,
    });
    await mount();
    const text = await submitAndReadSuccessText('duplicate@example.com');

    expect(text).toContain('Invitation requested recently');
    expect(text).toContain("we didn't send another email");
    expect(text).not.toContain("couldn't send");
    expect(
      requireElement('add-member-success').querySelector(
        '[aria-label="Copy invite link"]',
      ),
    ).not.toBeNull();
  });

  it('explains deferred payment without presenting an unusable link', async () => {
    createdInvite = buildInviteRow({
      seatPaymentState: 'PROCESSING',
      emailQueued: false,
      emailSuppressed: false,
      emailDeferred: true,
    });
    await mount();
    const text = await submitAndReadSuccessText('processing@example.com');

    expect(text).toContain('Payment processing');
    expect(text).toContain('send the invitation email once payment confirms');
    expect(text).not.toContain('requested recently');
    expect(text).not.toContain('/invite/code-1');
    expect(
      requireElement('add-member-success').querySelector(
        '[aria-label="Copy invite link"]',
      ),
    ).toBeNull();
  });

  it('suppresses a repeat email without exposing a processing invite link', async () => {
    createdInvite = buildInviteRow({
      seatPaymentState: 'PROCESSING',
      emailQueued: false,
      emailSuppressed: true,
      emailDeferred: false,
    });
    await mount();
    const text = await submitAndReadSuccessText('processing@example.com');

    expect(text).toContain('Payment processing');
    expect(text).toContain("won't send an invitation email");
    expect(text).toContain('link will become available after payment confirms');
    expect(text).not.toContain('/invite/code-1');
    expect(
      requireElement('add-member-success').querySelector(
        '[aria-label="Copy invite link"]',
      ),
    ).toBeNull();
  });

  it('states one outcome in the dialog subtitle rather than branching', async () => {
    await mount();
    const dialogText = requireElement('add-member-dialog').textContent ?? '';
    expect(dialogText).toContain(
      "Add someone by email. We'll send them an invitation to join Acme.",
    );
    expect(dialogText).not.toContain('shareable invite link');
  });
});

describe('pending invites list', () => {
  it('offers Copy link only when seat payment makes the invite redeemable', async () => {
    listInvites = [
      buildInviteRow({
        id: 'invite-ready',
        code: 'code-ready',
        invitedEmail: 'ready@example.com',
      }),
      buildInviteRow({
        id: 'invite-processing',
        code: 'code-processing',
        invitedEmail: 'processing@example.com',
        seatPaymentState: 'PROCESSING',
      }),
      buildInviteRow({
        id: 'invite-failed',
        code: 'code-failed',
        invitedEmail: 'failed@example.com',
        seatPaymentState: 'FAILED',
      }),
    ];
    await mount();

    const rows = document.body.querySelectorAll(
      '[data-testid="team-pending-invite-row"]',
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent ?? '').toContain('Pending');
    expect(
      rows[0].querySelector('[aria-label="Copy invite link"]'),
    ).not.toBeNull();
    expect(rows[1].textContent ?? '').toContain('Payment processing');
    expect(rows[1].querySelector('[aria-label="Copy invite link"]')).toBeNull();
    expect(rows[2].textContent ?? '').toContain('Payment failed');
    expect(rows[2].querySelector('[aria-label="Copy invite link"]')).toBeNull();

    // The blurb no longer explains a two-path acceptance flow.
    const panel = requireElement('team-pending-invites');
    expect(panel.textContent ?? '').toContain(
      "People you've invited who haven't joined yet.",
    );
    expect(panel.textContent ?? '').not.toContain(
      'accept from their dashboard',
    );
  });
});
