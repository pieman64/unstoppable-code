/**
 * @jest-environment jsdom
 */
// CAN-4558: a refused invite shows local copy chosen by the route's status
// and `code`, never the route's `{ error }` text.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createFakeSettingsClient,
  type FakeSettingsClient,
  type FakeSettingsHandler,
} from '../../__tests__/helpers/test-settings-host';
import type { OrganizationSeatQuote } from '../organization-settings-slots';
import { TeamMembersSection } from '../team-members-section';
import {
  buildOrganizationDetail as buildDetail,
  OrganizationTestHost,
  seatChargeSlot,
} from './helpers/members-section-harness';
import { failWith } from './helpers/settings-responses';

const SENTINEL = 'SENTINEL-SERVER-BODY';

const getOrgSeatQuoteMock = jest.fn<Promise<OrganizationSeatQuote>, []>();

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

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  getOrgSeatQuoteMock.mockResolvedValue(freeQuote());
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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function requireElement(testId: string): HTMLElement {
  const found = document.body.querySelector(`[data-testid="${testId}"]`);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`${testId} was not rendered`);
  }
  return found;
}

async function mount(invite: FakeSettingsHandler): Promise<FakeSettingsClient> {
  const client = createFakeSettingsClient({
    'organization.invitations.list': () => ({ enabled: true, invites: [] }),
    'organization.members.invite': invite,
  });
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
  return client;
}

async function submit(email: string): Promise<string> {
  const input = requireElement('add-member-email');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('add-member-email is not an input');
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(input, email);
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
  return requireElement('add-member-dialog').textContent ?? '';
}

describe('add-member refusals', () => {
  it.each([
    [
      429,
      'rate_limited',
      "You've sent a lot of invitations recently. Try again later.",
    ],
    [
      402,
      'invite_refused',
      "The payment for this seat was declined, so we didn't add this member.",
    ],
    [
      503,
      'invite_refused',
      "We couldn't confirm the payment for this seat, so we didn't add this member.",
    ],
    [
      409,
      'invite_refused',
      "Couldn't add this member. They may already be in the organization or have a pending invitation.",
    ],
    [500, undefined, "Couldn't add this member. Try again."],
  ] satisfies Array<[number, string | undefined, string]>)(
    'maps a %s %s to local copy without the server text',
    async (status, code, copy) => {
      await mount(
        failWith(
          status,
          code === undefined ? { error: SENTINEL } : { error: SENTINEL, code },
          { write: true },
        ),
      );

      const text = await submit('new@example.com');

      expect(text).toContain(copy);
      expect(text).not.toContain(SENTINEL);
    },
  );

  it('switches to the add-card state for no_saved_card instead of showing copy', async () => {
    await mount(
      failWith(
        409,
        { error: SENTINEL, code: 'no_saved_card' },
        { write: true },
      ),
    );

    const text = await submit('new@example.com');

    expect(text).toContain('Add a payment method to charge the new seat.');
    expect(text).not.toContain(SENTINEL);
  });
});
