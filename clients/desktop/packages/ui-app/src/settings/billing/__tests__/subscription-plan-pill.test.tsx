/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SubscriptionPlanPill } from '../subscription-plan-pill';
import type { BillingChrome } from '@canopy/protocol/settings/billing';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function chrome(overrides: Partial<BillingChrome>): BillingChrome {
  return {
    planDisplayName: 'Pro',
    trial: null,
    hasPaymentMethod: false,
    ...overrides,
  };
}

describe('SubscriptionPlanPill', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(billing: BillingChrome): void {
    act(() => {
      root.render(
        <SubscriptionPlanPill
          chrome={billing}
          dataTestId="plan-pill"
          fallback={<span data-testid="fallback">Member</span>}
        />,
      );
    });
  }

  it('shows the plan when there is one', () => {
    render(chrome({}));
    expect(
      container.querySelector('[data-testid="plan-pill"]')?.textContent,
    ).toContain('Pro');
  });

  it('shows no plan or trial under free app access (CAN-3926)', () => {
    render(
      chrome({
        freeAccess: true,
        trial: { active: true, endsAt: '2099-01-01T00:00:00.000Z' },
        displayPlan: {
          key: 'business',
          displayName: 'Business',
          source: 'trial',
        },
      }),
    );
    expect(container.querySelector('[data-testid="plan-pill"]')).toBeNull();
    expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull();
  });
});
