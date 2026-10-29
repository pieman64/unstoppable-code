/**
 * @jest-environment jsdom
 */
// Effect-driven coverage for the add-member dialog's prorated-seat confirmation.
// The dialog must never create an invitation that silently charges the card, so
// this asserts the whole gate: the amount is stated, the submit button carries
// it, a free seat renders no notice at all, and a missing card blocks submission
// with the right affordance per role.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createFakeSettingsClient,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';
import type { OrganizationSeatQuote } from '../organization-settings-slots';
// The shell owns the invite dialog's open state; these tests start with it
// open, which saves driving the header action just to reach the dialog.
import { TeamMembersSection } from '../team-members-section';
import { TeamApiError } from '../team-api';
import {
  buildOrganizationDetail as buildDetail,
  OrganizationTestHost,
  seatChargeSlot,
} from './helpers/members-section-harness';

const getOrgSeatQuoteMock = jest.fn();

function chargeableQuote(
  overrides: Partial<OrganizationSeatQuote> = {},
): OrganizationSeatQuote {
  return {
    chargeRequired: true,
    amountUsd: 15,
    minimumApplied: false,
    periodEndsAt: '2026-07-31T00:00:00.000Z',
    daysRemaining: 15,
    hasPaymentMethod: true,
    card: { brand: 'visa', last4: '4242' },
    ...overrides,
  };
}

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
let client: FakeSettingsClient;

/**
 * `DialogModal` portals to `document.body`, so the dialog's DOM is a sibling of
 * the render container rather than inside it. Every assertion below reads the
 * document.
 */
function dialogHtml(): string {
  return document.body.innerHTML;
}

function requireButton(testId: string): HTMLButtonElement {
  const button = document.body.querySelector(`[data-testid="${testId}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`${testId} was not rendered`);
  }
  return button;
}

function submitButton(): HTMLButtonElement {
  return requireButton('add-member-submit');
}

beforeEach(() => {
  jest.clearAllMocks();
  getOrgSeatQuoteMock.mockResolvedValue(chargeableQuote());
  // The pending-invite refresh is supplementary and swallows failures; the
  // fake client rejects every read without a handler.
  client = createFakeSettingsClient();
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

async function mount(node: ReactNode): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <OrganizationTestHost
        client={client}
        slots={{ seatCharge: seatChargeSlot(getOrgSeatQuoteMock) }}
      >
        {node}
      </OrganizationTestHost>,
    );
    await Promise.resolve();
  });
  // The quote load is scheduled on a macrotask (see the `setTimeout(0)` in
  // `AddMemberDialog`, which keeps the synchronous setState out of the effect
  // body), so flushing microtasks alone would leave the dialog in its loading
  // state. Yield the timer first, then drain the resulting promise chain.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('add-member dialog prorated-seat confirmation', () => {
  it('states the prorated amount and puts it on the submit button', async () => {
    await mount(
      <TeamMembersSection
        detail={buildDetail()}
        viewerEmail="owner@example.com"
        onDetailChange={jest.fn()}
        onLeft={jest.fn()}
        adding
        onAddingChange={jest.fn()}
      />,
    );

    const html = dialogHtml();
    expect(html).toContain('seat-charge-notice');
    expect(html).toContain('This adds a paid seat');
    expect(html).toContain('$15.00');
    expect(html).toContain('15 days');
    expect(html).toContain('4242');
    expect(submitButton().textContent).toBe('Add member and pay $15.00');
    expect(submitButton().disabled).toBe(true); // no email typed yet
  });

  it('says the amount is the minimum when the floor set it', async () => {
    // Without this the copy reads as "$5.00 for the 2 days left", which does not
    // add up against a $30 seat and looks like a pricing bug to the admin.
    getOrgSeatQuoteMock.mockResolvedValue(
      chargeableQuote({
        amountUsd: 5,
        minimumApplied: true,
        daysRemaining: 2,
      }),
    );

    await mount(
      <TeamMembersSection
        detail={buildDetail()}
        viewerEmail="owner@example.com"
        onDetailChange={jest.fn()}
        onLeft={jest.fn()}
        adding
        onAddingChange={jest.fn()}
      />,
    );

    const html = dialogHtml();
    expect(html).toContain('2 days');
    expect(html).toContain('our $5.00 minimum for adding a seat');
    expect(submitButton().textContent).toBe('Add member and pay $5.00');
  });

  it('renders no charge notice and the plain button when the seat is free', async () => {
    getOrgSeatQuoteMock.mockResolvedValue(freeQuote());

    await mount(
      <TeamMembersSection
        detail={buildDetail()}
        viewerEmail="owner@example.com"
        onDetailChange={jest.fn()}
        onLeft={jest.fn()}
        adding
        onAddingChange={jest.fn()}
      />,
    );

    expect(dialogHtml()).not.toContain('seat-charge-notice');
    expect(submitButton().textContent).toBe('Add member');
  });

  // CAN-3926: with free access on the server answers every seat quote with
  // `noChargeQuote('free_access')`: no charge, no card on file, no period. That
  // must read as a plain invite, never as a card requirement, for either role
  // that can invite. This is also where a new organization lands
  // (`?invite=1`), so it is the whole "create, then invite" path.
  it.each(['OWNER', 'ADMIN'] as const)(
    'invites with no charge notice or card prompt under free access (%s)',
    async (viewerRole) => {
      getOrgSeatQuoteMock.mockResolvedValue({
        chargeRequired: false,
        amountUsd: 0,
        minimumApplied: false,
        periodEndsAt: null,
        daysRemaining: 0,
        hasPaymentMethod: false,
        card: null,
      } satisfies OrganizationSeatQuote);

      await mount(
        <TeamMembersSection
          detail={buildDetail({ viewerRole })}
          viewerEmail="admin@example.com"
          onDetailChange={jest.fn()}
          onLeft={jest.fn()}
          adding
          onAddingChange={jest.fn()}
        />,
      );

      const html = dialogHtml();
      expect(html).toContain('add-member-email');
      expect(html).not.toContain('seat-charge-notice');
      expect(html).not.toContain('seat-charge-needs-card');
      expect(html).not.toContain('seat-charge-add-card');
      expect(html).not.toContain('seat-charge-error');
      expect(html).not.toContain('add-member-payment-method-modal');
      expect(document.body.textContent).not.toContain('paid seat');
      expect(submitButton().textContent).toBe('Add member');
    },
  );

  it('offers an owner an add-card CTA when a charge is owed with no card on file', async () => {
    getOrgSeatQuoteMock.mockResolvedValue(
      chargeableQuote({ hasPaymentMethod: false, card: null }),
    );

    await mount(
      <TeamMembersSection
        detail={buildDetail({ viewerRole: 'OWNER' })}
        viewerEmail="owner@example.com"
        onDetailChange={jest.fn()}
        onLeft={jest.fn()}
        adding
        onAddingChange={jest.fn()}
      />,
    );

    const html = dialogHtml();
    expect(html).toContain('seat-charge-needs-card');
    expect(html).toContain('seat-charge-add-card');
    expect(submitButton().disabled).toBe(true);
  });

  it('tells an admin to ask an owner instead of offering the add-card CTA', async () => {
    getOrgSeatQuoteMock.mockResolvedValue(
      chargeableQuote({ hasPaymentMethod: false, card: null }),
    );

    await mount(
      <TeamMembersSection
        detail={buildDetail({ viewerRole: 'ADMIN' })}
        viewerEmail="admin@example.com"
        onDetailChange={jest.fn()}
        onLeft={jest.fn()}
        adding
        onAddingChange={jest.fn()}
      />,
    );

    const html = dialogHtml();
    expect(html).toContain('seat-charge-needs-card');
    expect(html).not.toContain('seat-charge-add-card');
    expect(html).toContain('owner needs to add a card');
  });

  it('opens the card modal from the add-card CTA', async () => {
    getOrgSeatQuoteMock.mockResolvedValue(
      chargeableQuote({ hasPaymentMethod: false, card: null }),
    );

    await mount(
      <TeamMembersSection
        detail={buildDetail({ viewerRole: 'OWNER' })}
        viewerEmail="owner@example.com"
        onDetailChange={jest.fn()}
        onLeft={jest.fn()}
        adding
        onAddingChange={jest.fn()}
      />,
    );

    const cta = requireButton('seat-charge-add-card');
    await act(async () => {
      cta.click();
      await Promise.resolve();
    });

    expect(dialogHtml()).toContain('add-member-payment-method-modal');
  });

  it('refreshes server chrome when an invitation saves a payment method', async () => {
    getOrgSeatQuoteMock.mockResolvedValue(
      chargeableQuote({ hasPaymentMethod: false, card: null }),
    );
    const onBillingChanged = jest.fn();
    const props = {
      detail: buildDetail(),
      viewerEmail: 'owner@example.com',
      onDetailChange: jest.fn(),
      onLeft: jest.fn(),
      onBillingChanged,
      adding: true,
      onAddingChange: jest.fn(),
    };
    await mount(<TeamMembersSection {...props} />);
    expect(onBillingChanged).not.toHaveBeenCalled();
    await act(async () => {
      requireButton('seat-charge-add-card').click();
      await Promise.resolve();
    });
    getOrgSeatQuoteMock.mockRejectedValueOnce(
      new Error('seat quote unavailable'),
    );
    await act(async () => {
      requireButton('add-member-payment-method-modal').click();
      await Promise.resolve();
    });
    expect(onBillingChanged).toHaveBeenCalledTimes(1);
    expect(dialogHtml()).not.toContain('add-member-payment-method-modal');
  });

  it('blocks the charge when the price moved between opening and submitting', async () => {
    // The button states a specific amount the admin consents to. If the seat
    // costs something different by the time they submit, they must see the new
    // figure and confirm again rather than being charged a price they never saw.
    getOrgSeatQuoteMock.mockResolvedValueOnce(chargeableQuote());

    await mount(
      <TeamMembersSection
        detail={buildDetail()}
        viewerEmail="owner@example.com"
        onDetailChange={jest.fn()}
        onLeft={jest.fn()}
        adding
        onAddingChange={jest.fn()}
      />,
    );
    expect(submitButton().textContent).toBe('Add member and pay $15.00');

    // Another admin took a seat in the meantime, so the next quote is dearer.
    getOrgSeatQuoteMock.mockResolvedValue(chargeableQuote({ amountUsd: 22.5 }));

    const email = document.body.querySelector(
      '[data-testid="add-member-email"]',
    );
    if (!(email instanceof HTMLInputElement)) {
      throw new Error('email input was not rendered');
    }
    const setValue = (target: HTMLInputElement, next: string): void => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(target, next);
    };
    await act(async () => {
      setValue(email, 'new@example.com');
      email.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    const form = document.body.querySelector('form');
    await act(async () => {
      form?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // No invitation was created, and the dialog now shows the updated price.
    expect(
      client.calls.some(
        (call) => call.operation === 'organization.members.invite',
      ),
    ).toBe(false);
    expect(dialogHtml()).toContain('The price for this seat changed');
    expect(submitButton().textContent).toBe('Add member and pay $22.50');

    // Drain the dialog's deferred quote timer so the component is quiescent
    // before `afterEach` unmounts it, otherwise React warns about an update
    // landing outside `act`.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it('falls back to the free path when the quote endpoint is absent (billing off)', async () => {
    getOrgSeatQuoteMock.mockRejectedValue(new TeamApiError(404, 'Not found'));

    await mount(
      <TeamMembersSection
        detail={buildDetail()}
        viewerEmail="owner@example.com"
        onDetailChange={jest.fn()}
        onLeft={jest.fn()}
        adding
        onAddingChange={jest.fn()}
      />,
    );

    expect(dialogHtml()).not.toContain('seat-charge-notice');
    expect(dialogHtml()).not.toContain('seat-charge-error');
    expect(submitButton().textContent).toBe('Add member');
  });

  it('blocks submission and offers a retry when the quote genuinely fails', async () => {
    getOrgSeatQuoteMock.mockRejectedValue(new TeamApiError(500, 'boom'));

    await mount(
      <TeamMembersSection
        detail={buildDetail()}
        viewerEmail="owner@example.com"
        onDetailChange={jest.fn()}
        onLeft={jest.fn()}
        adding
        onAddingChange={jest.fn()}
      />,
    );

    expect(dialogHtml()).toContain('seat-charge-error');
    expect(dialogHtml()).toContain('seat-charge-retry');
    expect(submitButton().disabled).toBe(true);
  });
});
