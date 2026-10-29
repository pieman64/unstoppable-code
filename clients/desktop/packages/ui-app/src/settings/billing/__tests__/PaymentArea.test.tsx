/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SettingsPaymentOwner } from '@canopy/protocol/billing';
import type {
  SettingsPaymentHandoffIntent,
  SettingsPaymentHandoffResult,
} from '@canopy/protocol/settings/payment-handoff';
import type { BillingSummary } from '@canopy/protocol/settings/billing';
import {
  PAYMENT_AREA_FOCUS_REFRESH_DELAY_MS,
  PaymentArea,
  PaymentAreaCta,
  PaymentAreaNotice,
  billingSummaryNeedsPaymentMethod,
  subscriptionRecoveryIntent,
  type PaymentAreaAction,
} from '../PaymentArea';
import {
  TestSettingsHost,
  createTestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const PERSONAL: SettingsPaymentOwner = { kind: 'personal' };
const ORGANIZATION: SettingsPaymentOwner = {
  kind: 'organization',
  organizationId: 'org-1',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});

type Handoff = (
  owner: SettingsPaymentOwner,
  intent: SettingsPaymentHandoffIntent,
) => Promise<SettingsPaymentHandoffResult>;

interface RenderOptions {
  readonly inlineCheckout?: boolean;
  readonly available?: boolean | null;
  readonly owner?: SettingsPaymentOwner;
  readonly canManage?: boolean;
  readonly handoff?: Handoff;
  readonly refresh?: () => void;
  readonly openExternal?: (url: string) => void;
  readonly children?: JSX.Element;
}

function renderArea({
  inlineCheckout = false,
  available = true,
  owner = PERSONAL,
  canManage = true,
  handoff = (): Promise<SettingsPaymentHandoffResult> =>
    Promise.resolve({ ok: true }),
  refresh = (): void => undefined,
  openExternal = (): void => undefined,
  children,
}: RenderOptions = {}): void {
  const { host } = createTestSettingsHost({
    inlineCheckout,
    paymentHandoffAvailable: available,
    navigation: { openPaymentHandoff: handoff, openExternal },
  });
  act(() => {
    root.render(
      <TestSettingsHost host={host}>
        <PaymentArea owner={owner} canManage={canManage} refresh={refresh}>
          <PaymentAreaNotice testId="notice" />
          {children ?? (
            <PaymentAreaCta
              action="payment-method"
              testId="cta"
              inline={<span data-testid="inline-ui">inline</span>}
            />
          )}
        </PaymentArea>
      </TestSettingsHost>,
    );
  });
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function button(id: string): HTMLButtonElement {
  const element = byTestId(id);
  if (!(element instanceof HTMLButtonElement))
    throw new Error(`No button ${id}`);
  return element;
}

async function click(id: string): Promise<void> {
  await act(async () => {
    button(id).click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function noticeMessage(): string {
  return byTestId('notice-message')?.textContent ?? '';
}

describe('PaymentArea on a host with inline checkout', () => {
  it('renders the inline UI and no handoff CTA or notice', () => {
    renderArea({ inlineCheckout: true });

    expect(byTestId('inline-ui')).not.toBeNull();
    expect(byTestId('cta')).toBeNull();
    expect(byTestId('notice')).toBeNull();
  });

  it('renders nothing for a CTA whose inline UI is absent', () => {
    renderArea({
      inlineCheckout: true,
      children: <PaymentAreaCta action="top-up" testId="cta" />,
    });

    expect(container.querySelector('button')).toBeNull();
  });
});

describe('PaymentArea handoff', () => {
  it.each<
    [
      PaymentAreaAction,
      SettingsPaymentOwner,
      string,
      SettingsPaymentHandoffIntent,
    ]
  >([
    [
      'payment-method',
      PERSONAL,
      'Add card',
      { kind: 'modal', modal: 'payment-method' },
    ],
    [
      'payment-method',
      ORGANIZATION,
      'Add card',
      { kind: 'modal', modal: 'payment-method' },
    ],
    ['top-up', PERSONAL, 'Buy credits', { kind: 'top-up', reason: 'credits' }],
    [
      'top-up',
      ORGANIZATION,
      'Buy credits',
      { kind: 'top-up', reason: 'credits' },
    ],
    [
      'auto-top-up',
      PERSONAL,
      'Manage automatic top-up',
      { kind: 'modal', modal: 'auto-top-up' },
    ],
    [
      'auto-top-up',
      ORGANIZATION,
      'Manage automatic top-up',
      { kind: 'modal', modal: 'auto-top-up' },
    ],
    [
      'subscription',
      PERSONAL,
      'Manage billing on web',
      { kind: 'modal', modal: 'subscription' },
    ],
    [
      'subscription',
      ORGANIZATION,
      'Manage billing on web',
      { kind: 'modal', modal: 'subscription' },
    ],
  ])('opens %s for the %o wallet', async (action, owner, label, expected) => {
    const handoff = jest.fn<ReturnType<Handoff>, Parameters<Handoff>>(() =>
      Promise.resolve({ ok: true }),
    );
    renderArea({
      owner,
      handoff,
      children: <PaymentAreaCta action={action} testId="cta" />,
    });

    expect(button('cta').textContent).toBe(label);
    // No status line until a handoff starts.
    expect(byTestId('notice')).toBeNull();
    await click('cta');

    expect(handoff).toHaveBeenCalledTimes(1);
    expect(handoff).toHaveBeenCalledWith(owner, expected);
  });

  it('names the subscription plan when the CTA carries one', async () => {
    const handoff = jest.fn<ReturnType<Handoff>, Parameters<Handoff>>(() =>
      Promise.resolve({ ok: true }),
    );
    renderArea({
      handoff,
      children: (
        <PaymentAreaCta action="subscription" plan="business" testId="cta" />
      ),
    });

    await click('cta');

    expect(handoff).toHaveBeenCalledWith(PERSONAL, {
      kind: 'modal',
      modal: 'subscription',
      plan: 'business',
    });
  });

  it('labels a payment-method CTA for an existing card', () => {
    renderArea({
      children: <PaymentAreaCta action="payment-method" hasCard testId="cta" />,
    });

    expect(button('cta').textContent).toBe('Manage payment method');
  });

  it('withholds a CTA the summary does not offer', () => {
    renderArea({
      children: (
        <PaymentAreaCta action="subscription" offered={false} testId="cta" />
      ),
    });

    expect(byTestId('cta')).toBeNull();
  });

  it.each([false, null])(
    'renders disabled CTAs and Open on web while availability is %s',
    async (available) => {
      const handoff = jest.fn<ReturnType<Handoff>, Parameters<Handoff>>(() =>
        Promise.resolve({ ok: true }),
      );
      const openExternal = jest.fn<void, [string]>();
      renderArea({
        available,
        handoff,
        openExternal,
        owner: ORGANIZATION,
      });

      expect(button('cta').disabled).toBe(true);
      expect(noticeMessage()).toBe('Manage payments on the web.');
      await click('cta');
      expect(handoff).not.toHaveBeenCalled();
      // Never the failure copy: the click could not have happened.
      expect(container.textContent).not.toContain("Couldn't open");

      await click('notice-open-on-web');
      expect(openExternal).toHaveBeenCalledWith(
        'https://canopy.test/organization/org-1/settings?tab=billing',
      );
    },
  );

  it('opens the personal billing page on the web while unavailable', async () => {
    const openExternal = jest.fn<void, [string]>();
    renderArea({ available: false, openExternal });

    await click('notice-open-on-web');

    expect(openExternal).toHaveBeenCalledWith(
      'https://canopy.test/account/billing',
    );
  });

  it('disables the CTA with a busy state while the handoff opens, ignoring repeat clicks', async () => {
    let finish: (result: SettingsPaymentHandoffResult) => void = () => {};
    const handoff = jest.fn<ReturnType<Handoff>, Parameters<Handoff>>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderArea({
      handoff,
      children: (
        <>
          <PaymentAreaCta action="top-up" testId="cta" />
          <PaymentAreaCta action="auto-top-up" testId="other-cta" />
        </>
      ),
    });

    await click('cta');
    expect(button('cta').disabled).toBe(true);
    expect(button('cta').getAttribute('aria-busy')).toBe('true');
    expect(button('cta').textContent).toBe('Opening…');
    expect(button('other-cta').disabled).toBe(true);
    await click('cta');
    await click('other-cta');
    expect(handoff).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({ ok: true });
      await Promise.resolve();
    });
    expect(button('cta').disabled).toBe(false);
    expect(button('cta').textContent).toBe('Buy credits');
  });

  it('says to continue in the browser and refetches on Check again', async () => {
    const refresh = jest.fn();
    renderArea({ refresh });

    await click('cta');

    expect(noticeMessage()).toBe('Continue in your browser.');
    // Opening the browser is not a payment: nothing is refetched yet.
    expect(refresh).not.toHaveBeenCalled();
    await click('notice-check-again');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each<[SettingsPaymentHandoffResult, string]>([
    [
      { ok: false, reason: 'failed' },
      "Couldn't open this payment page. Try again.",
    ],
    [
      { ok: false, reason: 'forbidden' },
      "Couldn't open this payment page. Try again.",
    ],
    [
      { ok: false, reason: 'identity_changed' },
      "Couldn't open this payment page. Try again.",
    ],
    [
      { ok: false, reason: 'browser_failed' },
      "Couldn't open your browser. Try again.",
    ],
  ])('reports %o as a failure with Try again', async (result, copy) => {
    const handoff = jest.fn<ReturnType<Handoff>, Parameters<Handoff>>(() =>
      Promise.resolve(result),
    );
    renderArea({ handoff });

    await click('cta');
    expect(noticeMessage()).toBe(copy);

    await click('notice-try-again');
    expect(handoff).toHaveBeenCalledTimes(2);
    expect(handoff.mock.calls[1]).toEqual(handoff.mock.calls[0]);
  });

  it('reports a rejected handoff as the payment page failure', async () => {
    renderArea({
      handoff: () => Promise.reject(new Error('ipc closed')),
    });

    await click('cta');

    expect(noticeMessage()).toBe("Couldn't open this payment page. Try again.");
  });

  it('switches to the unavailable state when the host reports it on click', async () => {
    renderArea({
      handoff: () => Promise.resolve({ ok: false, reason: 'unavailable' }),
    });

    await click('cta');

    expect(button('cta').disabled).toBe(true);
    expect(noticeMessage()).toBe('Manage payments on the web.');
    expect(byTestId('notice-open-on-web')).not.toBeNull();
    expect(container.textContent).not.toContain("Couldn't open");
  });

  it('refreshes once per window focus after the browser opened', async () => {
    jest.useFakeTimers();
    const refresh = jest.fn();
    renderArea({ refresh });

    // No refresh on focus before any handoff opened.
    act(() => {
      window.dispatchEvent(new Event('focus'));
      jest.advanceTimersByTime(PAYMENT_AREA_FOCUS_REFRESH_DELAY_MS);
    });
    expect(refresh).not.toHaveBeenCalled();

    await click('cta');
    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
      jest.advanceTimersByTime(PAYMENT_AREA_FOCUS_REFRESH_DELAY_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('focus'));
      jest.advanceTimersByTime(PAYMENT_AREA_FOCUS_REFRESH_DELAY_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('hides the CTAs and notice from a viewer who may not manage payments', () => {
    renderArea({ canManage: false, owner: ORGANIZATION });

    expect(byTestId('cta')).toBeNull();
    expect(byTestId('notice')).toBeNull();
  });
});

function summary(overrides: Partial<BillingSummary> = {}): BillingSummary {
  return {
    plan: {
      key: 'business',
      displayName: 'Business',
      billingModel: 'PER_SEAT',
    },
    status: 'ACTIVE',
    trial: null,
    nextBillingDate: null,
    nextBillingAmountUsd: null,
    seatCount: 3,
    paymentMethod: {
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
    },
    walletBalanceUsd: 0,
    capabilities: [],
    coverageNotes: [],
    ...overrides,
  };
}

describe('subscription recovery', () => {
  it('offers nothing for a healthy paid plan', () => {
    expect(subscriptionRecoveryIntent(summary(), 'business')).toBeNull();
    expect(billingSummaryNeedsPaymentMethod(summary())).toBe(false);
  });

  it('opens the update-card flow (no plan) for a failed payment', () => {
    expect(
      subscriptionRecoveryIntent(summary({ status: 'PAST_DUE' }), 'business'),
    ).toEqual({});
    expect(
      subscriptionRecoveryIntent(
        summary({ lapseReason: 'payment_failed', status: null }),
        'business',
      ),
    ).toEqual({});
    expect(
      billingSummaryNeedsPaymentMethod(summary({ status: 'PAST_DUE' })),
    ).toBe(true);
  });

  it('opens the plan checkout for a trial converting without a card', () => {
    const trialing = summary({
      status: 'TRIALING',
      trial: { active: true, endsAt: '2099-01-01T00:00:00.000Z' },
      paymentMethod: null,
    });
    expect(subscriptionRecoveryIntent(trialing, 'business')).toEqual({
      plan: 'business',
    });
    expect(billingSummaryNeedsPaymentMethod(trialing)).toBe(true);
  });

  it('opens the plan checkout for a lapsed plan', () => {
    expect(
      subscriptionRecoveryIntent(
        summary({ plan: null, status: null, lapseReason: 'trial_ended' }),
        'business',
      ),
    ).toEqual({ plan: 'business' });
  });

  it('offers nothing while a cancellation is pending or for a complimentary plan', () => {
    expect(
      subscriptionRecoveryIntent(
        summary({
          status: 'PAST_DUE',
          pendingCancellation: {
            effectiveAt: '2099-01-01T00:00:00.000Z',
            requestedAt: null,
          },
        }),
        'business',
      ),
    ).toBeNull();
    expect(
      subscriptionRecoveryIntent(
        summary({ status: 'PAST_DUE', complimentary: true }),
        'business',
      ),
    ).toBeNull();
  });
});
