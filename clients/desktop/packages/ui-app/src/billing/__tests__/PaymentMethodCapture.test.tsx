/**
 * @jest-environment jsdom
 */
// CAN-3714: a banner left by a failed Pay (e.g. pressed mid Link SMS
// verification) must clear once Stripe reports the PaymentElement complete,
// and must stay while the form is still incomplete. Submit is never gated on
// completeness, and the confirm path is unchanged.
import { act, createElement as mockCreateElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { StripePaymentElementChangeEvent } from '@stripe/stripe-js';
import type { BillingPaymentMethodSummary } from '@canopy/protocol/billing';
import { BILLING_CARD_DECLINED_ERROR } from '@canopy/app-state/billing';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const mockConfirmSetup = jest.fn();
let mockPaymentElementOnChange:
  | ((event: StripePaymentElementChangeEvent) => void)
  | undefined;

jest.mock('@stripe/react-stripe-js', () => ({
  __esModule: true,
  Elements: ({ children }: { children: unknown }): unknown => children,
  PaymentElement: (props: {
    onChange?: (event: StripePaymentElementChangeEvent) => void;
  }): unknown => {
    mockPaymentElementOnChange = props.onChange;
    return mockCreateElement('div', {
      'data-testid': 'stripe-payment-element',
    });
  },
  useStripe: (): unknown => ({
    confirmSetup: (...args: unknown[]): unknown => mockConfirmSetup(...args),
  }),
  useElements: (): unknown => ({}),
}));

jest.mock('../stripe-browser', () => ({
  getBrowserStripe: (): Promise<unknown> => Promise.resolve({}),
}));

import { PaymentMethodCapture } from '../PaymentMethodCapture';

const STRIPE_INCOMPLETE = 'Your payment information is incomplete.';
const INCOMPLETE_ERROR = 'Card setup did not complete. Please try again.';

const summary: BillingPaymentMethodSummary = {
  brand: 'visa',
  last4: '4242',
  expMonth: 12,
  expYear: 2030,
};

let container: HTMLDivElement;
let root: Root | null = null;
const createSetupIntent = jest.fn();
const confirmPaymentMethod = jest.fn();
const onSaved = jest.fn();
const onCancel = jest.fn();

beforeEach(() => {
  mockConfirmSetup.mockReset();
  mockPaymentElementOnChange = undefined;
  createSetupIntent.mockReset();
  createSetupIntent.mockResolvedValue({ clientSecret: 'seti_secret' });
  confirmPaymentMethod.mockReset();
  confirmPaymentMethod.mockResolvedValue(summary);
  onSaved.mockReset();
  onCancel.mockReset();
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  act(() => {
    root = createRoot(container);
    root.render(
      <PaymentMethodCapture
        publishableKey="pk_test_123"
        createSetupIntent={createSetupIntent}
        confirmPaymentMethod={confirmPaymentMethod}
        onSaved={onSaved}
        onCancel={onCancel}
      />,
    );
  });
  await flush();
  expect(
    container.querySelector('[data-testid="stripe-payment-element"]'),
  ).not.toBeNull();
}

function submitButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    '[data-testid="billing-payment-method-submit"]',
  );
}

async function submit(): Promise<void> {
  const button = submitButton();
  expect(button).not.toBeNull();
  act(() => {
    button?.click();
  });
  await flush();
}

function changeEvent(
  overrides: Partial<StripePaymentElementChangeEvent>,
): StripePaymentElementChangeEvent {
  return {
    elementType: 'payment',
    empty: false,
    complete: false,
    collapsed: false,
    value: { type: 'card' },
    ...overrides,
  };
}

function change(overrides: Partial<StripePaymentElementChangeEvent>): void {
  const onChange = mockPaymentElementOnChange;
  if (!onChange) {
    throw new Error('PaymentElement onChange not wired');
  }
  act(() => {
    onChange(changeEvent(overrides));
  });
}

function banner(): Element | null {
  return container.querySelector('[data-notice-intent="destructive"]');
}

async function raiseStripeWarning(): Promise<void> {
  mockConfirmSetup.mockResolvedValue({
    error: { type: 'validation_error', message: STRIPE_INCOMPLETE },
  });
  await submit();
  expect(banner()?.textContent).toContain(STRIPE_INCOMPLETE);
}

describe('PaymentMethodCapture stale warning (CAN-3714)', () => {
  it('clears a stale Stripe warning once a Link card is selected and verified', async () => {
    await mount();
    await raiseStripeWarning();

    change({ complete: true, value: { type: 'link' } });

    expect(banner()).toBeNull();
  });

  it('clears the incomplete-setup fallback the same way', async () => {
    await mount();
    mockConfirmSetup.mockResolvedValue({
      setupIntent: { id: 'seti_1', status: 'requires_action' },
    });
    await submit();
    expect(banner()?.textContent).toContain(INCOMPLETE_ERROR);

    change({ complete: true, value: { type: 'link' } });

    expect(banner()).toBeNull();
  });

  it('keeps the warning while the card is incomplete or empty', async () => {
    await mount();
    await raiseStripeWarning();

    change({ complete: false, value: { type: 'card' } });
    expect(banner()?.textContent).toContain(STRIPE_INCOMPLETE);

    change({ empty: true, complete: false });
    expect(banner()?.textContent).toContain(STRIPE_INCOMPLETE);
  });

  it('keeps the warning when Link verification fails or is abandoned', async () => {
    await mount();
    await raiseStripeWarning();

    change({ complete: false, value: { type: 'link' } });

    expect(banner()?.textContent).toContain(STRIPE_INCOMPLETE);
  });

  it('never gates submit on completeness and still confirms the card', async () => {
    await mount();
    expect(submitButton()).not.toBeNull();
    expect(submitButton()?.disabled).toBe(false);

    change({ complete: false, value: { type: 'card' } });
    expect(submitButton()?.disabled).toBe(false);

    await raiseStripeWarning();
    change({ complete: true, value: { type: 'link' } });
    expect(banner()).toBeNull();

    mockConfirmSetup.mockResolvedValue({
      setupIntent: { id: 'seti_1', status: 'succeeded' },
    });
    await submit();

    expect(confirmPaymentMethod).toHaveBeenCalledWith('seti_1');
    expect(onSaved).toHaveBeenCalledWith(summary);
    expect(banner()).toBeNull();
  });

  it('drops a server-side error once a complete method is chosen again', async () => {
    await mount();
    mockConfirmSetup.mockResolvedValue({
      setupIntent: { id: 'seti_1', status: 'succeeded' },
    });
    // A 402 decline: local decline copy, never the server's own text.
    confirmPaymentMethod.mockRejectedValue(
      Object.assign(new Error('SENTINEL-decline-server-body'), { status: 402 }),
    );
    await submit();
    expect(banner()?.textContent).toContain(BILLING_CARD_DECLINED_ERROR);
    expect(banner()?.textContent).not.toContain('SENTINEL');

    change({ complete: true });

    expect(banner()).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('treats a complete change with no warning as a no-op', async () => {
    await mount();

    change({ complete: true });

    expect(banner()).toBeNull();
    expect(
      container.querySelector('[data-testid="stripe-payment-element"]'),
    ).not.toBeNull();
  });
});
