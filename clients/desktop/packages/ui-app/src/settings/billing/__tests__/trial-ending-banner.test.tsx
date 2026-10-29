/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BillingChrome } from '@canopy/protocol/settings/billing';
import { TrialEndingBanner } from '../trial-ending-banner';
import { TestSettingsHost } from '../../__tests__/helpers/test-settings-host';

declare global {
  // React reads this flag to enable act()-based testing with the concurrent
  // root. Declared here (rather than cast onto globalThis) to satisfy the
  // repo's no-type-assertion rule.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Fixed "now" so the day-countdown math is deterministic across the boundary.
const NOW = Date.parse('2026-07-12T00:00:00.000Z');
// 6 days out → shown; exactly 7 days out → hidden.
const SIX_DAYS_OUT = '2026-07-18T00:00:00.000Z';
const SEVEN_DAYS_OUT = '2026-07-19T00:00:00.000Z';

function chrome(overrides: Partial<BillingChrome>): BillingChrome {
  return {
    planDisplayName: 'Business',
    trial: { active: true, endsAt: SIX_DAYS_OUT },
    hasPaymentMethod: false,
    ...overrides,
  };
}

describe('TrialEndingBanner', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  function render(billing: BillingChrome): void {
    act(() => {
      // The test host renders links as plain anchors, so hrefs can be asserted.
      root.render(
        <TestSettingsHost>
          <TrialEndingBanner billing={billing} />
        </TestSettingsHost>,
      );
    });
  }

  function banner(): HTMLElement | null {
    return container.querySelector('[data-testid="trial-ending-banner"]');
  }

  it('stays hidden under free app access, even if a trial field leaks through', () => {
    render(chrome({ freeAccess: true }));
    expect(banner()).toBeNull();
  });

  it('renders with both links and plan copy for a trial ending in under a week without a card', () => {
    render(chrome({}));
    const el = banner();
    expect(el).not.toBeNull();
    const text = el?.textContent ?? '';
    expect(text).toContain('Your trial ends');
    // Formatted in the viewer's locale/timezone, so assert month + year rather
    // than a fixed day that would shift across timezones.
    expect(text).toContain('July');
    expect(text).toContain('2026');
    // Plan name is threaded in, never hardcoded.
    expect(text).toContain('Business');
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs).toContain('/account');
    expect(hrefs).toContain('/pricing');
  });

  it('hides when a payment method is already on file', () => {
    render(chrome({ hasPaymentMethod: true }));
    expect(banner()).toBeNull();
  });

  it('hides when the trial is not active', () => {
    render(chrome({ trial: { active: false, endsAt: SIX_DAYS_OUT } }));
    expect(banner()).toBeNull();
  });

  it('hides when there is no trial', () => {
    render(chrome({ trial: null }));
    expect(banner()).toBeNull();
  });

  it('hides at exactly 7 days left (only surfaces under a week)', () => {
    render(chrome({ trial: { active: true, endsAt: SEVEN_DAYS_OUT } }));
    expect(banner()).toBeNull();
  });

  it('shows at 6 days left', () => {
    render(chrome({ trial: { active: true, endsAt: SIX_DAYS_OUT } }));
    expect(banner()).not.toBeNull();
  });

  it('hides when the trial end date is not a valid ISO instant', () => {
    // An unparseable endsAt must not surface a banner with an empty date label.
    render(chrome({ trial: { active: true, endsAt: 'not-a-date' } }));
    expect(banner()).toBeNull();
  });

  it('is session-dismissible via the close button', () => {
    render(chrome({}));
    expect(banner()).not.toBeNull();
    const dismiss = container.querySelector('button[aria-label="Dismiss"]');
    expect(dismiss).not.toBeNull();
    act(() => {
      dismiss?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(banner()).toBeNull();
  });
});
