/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AiCreditsArrivedNotice } from '../AiCreditsArrivedNotice';
import { aiCreditsArrivalTitle } from '../aiCreditsArrival';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * CAN-5160 — the arrival title states an observed increase only when it
 * shows as a nonzero amount, and the notice is a positive status that keeps
 * the host's continuation, actions, and dismissal.
 */
describe('aiCreditsArrivalTitle', () => {
  it('names the increase alone when the balance reads the same', () => {
    expect(
      aiCreditsArrivalTitle({ addedCredits: 16, balanceCredits: 16 }),
    ).toBe('16 AI Credits added.');
    expect(
      aiCreditsArrivalTitle({ addedCredits: 16.001, balanceCredits: 15.999 }),
    ).toBe('16 AI Credits added.');
  });

  it('adds the balance when it reads differently', () => {
    expect(
      aiCreditsArrivalTitle({ addedCredits: 16, balanceCredits: 216 }),
    ).toBe('16 AI Credits added. Balance: 216 credits.');
    expect(
      aiCreditsArrivalTitle({ addedCredits: 1234, balanceCredits: 1234 }),
    ).toBe('1,234 AI Credits added.');
  });

  it('rounds a fractional increase to two decimals', () => {
    expect(aiCreditsArrivalTitle({ addedCredits: 2.345678 })).toBe(
      '2.35 AI Credits added.',
    );
  });

  it('never says zero credits were added', () => {
    expect(
      aiCreditsArrivalTitle({ addedCredits: 0.004, balanceCredits: 16 }),
    ).toBe('Your 16 AI Credits are now available.');
    expect(aiCreditsArrivalTitle({ addedCredits: 0, balanceCredits: 16 })).toBe(
      'Your 16 AI Credits are now available.',
    );
    expect(
      aiCreditsArrivalTitle({ addedCredits: -5, balanceCredits: null }),
    ).toBe('AI Credits are available for this chat.');
  });

  it('falls back without a usable balance', () => {
    expect(aiCreditsArrivalTitle({})).toBe(
      'AI Credits are available for this chat.',
    );
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0, -3, null]) {
      expect(
        aiCreditsArrivalTitle({ addedCredits: null, balanceCredits: value }),
      ).toBe('AI Credits are available for this chat.');
    }
    expect(
      aiCreditsArrivalTitle({
        addedCredits: Number.NaN,
        balanceCredits: 40,
      }),
    ).toBe('Your 40 AI Credits are now available.');
  });
});

describe('AiCreditsArrivedNotice', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('is one positive polite status with the host content and controls', () => {
    const onDismiss = jest.fn();
    act(() =>
      root.render(
        <AiCreditsArrivedNotice
          addedCredits={16}
          balanceCredits={16}
          data-testid="arrival"
          tabIndex={-1}
          onDismiss={onDismiss}
          dismissTestId="arrival-dismiss"
          actions={<button type="button">Use credits now</button>}
          actionsPlacement="below"
        >
          Continue on credits or wait for your quota to reset.
        </AiCreditsArrivedNotice>,
      ),
    );
    const notice = container.querySelector<HTMLElement>(
      '[data-testid="arrival"]',
    );
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute('data-notice-intent')).toBe('positive');
    const status = notice?.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toContain('16 AI Credits added.');
    expect(status?.textContent).toContain('Continue on credits');
    expect(status?.textContent).not.toContain('Use credits now');
    expect(status?.querySelector('button')).toBeNull();
    expect(notice?.getAttribute('tabindex')).toBe('-1');
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(notice?.textContent).toContain('16 AI Credits added.');
    expect(notice?.textContent).toContain(
      'Continue on credits or wait for your quota to reset.',
    );
    expect(notice?.textContent).not.toContain('usage limit reached');
    expect(notice?.querySelector('button')?.textContent).toBe(
      'Use credits now',
    );

    const dismiss = container.querySelector<HTMLButtonElement>(
      '[data-testid="arrival-dismiss"]',
    );
    expect(dismiss?.getAttribute('aria-label')).toBe(
      'Dismiss AI Credits notice',
    );
    act(() => dismiss?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
