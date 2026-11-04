/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  FirstRunAiCreditsRow,
  type FirstRunDailyCreditsDrip,
} from '../FirstRunAiCreditsRow';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * CAN-4764 — the first-run daily AI Credits row, shared from ui-app. The host
 * supplies the drip state and the brand logo; the row owns the offer,
 * confirmations, switch wiring and error.
 */
describe('FirstRunAiCreditsRow', () => {
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
  });

  function drip(
    overrides: Partial<FirstRunDailyCreditsDrip> = {},
  ): FirstRunDailyCreditsDrip {
    return {
      live: { state: 'undecided', enabled: false, capCredits: 10 },
      busy: false,
      error: null,
      outcome: null,
      turnOn: jest.fn(() => Promise.resolve()),
      notNow: jest.fn(() => Promise.resolve()),
      ...overrides,
    };
  }

  function render(state: FirstRunDailyCreditsDrip): void {
    act(() =>
      root.render(
        <FirstRunAiCreditsRow
          drip={state}
          logo={<svg data-testid="brand-logo" />}
        />,
      ),
    );
  }

  const byTestId = (id: string): HTMLElement => {
    const node = container.querySelector(`[data-testid="${id}"]`);
    if (!(node instanceof HTMLElement)) throw new Error(`missing ${id}`);
    return node;
  };
  const query = (id: string): Element | null =>
    container.querySelector(`[data-testid="${id}"]`);
  const toggle = (): HTMLElement => byTestId('first-run-daily-credits-toggle');
  const rowState = (): string | undefined =>
    byTestId('first-run-daily-credits-description').dataset.state;
  const describedText = (): string | null | undefined =>
    document.getElementById(toggle().getAttribute('aria-describedby') ?? '')
      ?.textContent;

  it('offers the credits with the host logo and a labelled switch', () => {
    render(
      drip({ live: { state: 'undecided', enabled: false, capCredits: 25 } }),
    );

    expect(rowState()).toBe('offer');
    expect(query('brand-logo')).not.toBeNull();
    const label = byTestId('first-run-daily-credits').querySelector('label');
    expect(label?.textContent?.trim()).toBe('Free daily AI Credits');
    expect(label?.htmlFor).toBe(toggle().id);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(describedText()).toBe('No card needed · 25 AI Credits every day');
    expect(query('first-run-daily-credits-confirmation')).toBeNull();
  });

  it('falls back to the default cap', () => {
    render(
      drip({ live: { state: 'undecided', enabled: false, capCredits: null } }),
    );

    expect(describedText()).toBe('No card needed · 10 AI Credits every day');
  });

  it('confirms a grant and describes the switch with it', () => {
    render(
      drip({
        live: { state: 'decided', enabled: true, capCredits: 10 },
        outcome: { granted: 10, balanceCredits: 10 },
      }),
    );

    expect(rowState()).toBe('granted');
    expect(byTestId('first-run-daily-credits-confirmation').textContent).toBe(
      '10 free AI Credits added · refills daily',
    );
    expect(describedText()).toBe('10 free AI Credits added · refills daily');
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('acknowledges a turn-on that granted nothing', () => {
    render(
      drip({
        live: { state: 'decided', enabled: true, capCredits: 10 },
        outcome: { granted: 0, balanceCredits: 0 },
      }),
    );

    expect(rowState()).toBe('enabled');
    expect(byTestId('first-run-daily-credits-confirmation').textContent).toBe(
      'Free daily AI Credits enabled.',
    );
  });

  it('keeps the offer when the grant was blocked', () => {
    render(
      drip({
        live: { state: 'decided', enabled: true, capCredits: 10 },
        outcome: {
          granted: 10,
          balanceCredits: 10,
          blockedReason: 'network_limit',
        },
      }),
    );

    expect(rowState()).toBe('offer');
    expect(query('first-run-daily-credits-confirmation')).toBeNull();
  });

  it.each(['loading', 'unavailable'] as const)(
    'disables the switch while the opt-in is %s',
    (state) => {
      render(drip({ live: { state, enabled: false, capCredits: null } }));

      expect(toggle().hasAttribute('disabled')).toBe(true);
    },
  );

  it('turns the credits on and off through the host', () => {
    const state = drip();
    render(state);
    act(() => toggle().click());
    expect(state.turnOn).toHaveBeenCalledTimes(1);

    const enabled = drip({
      live: { state: 'decided', enabled: true, capCredits: 10 },
    });
    render(enabled);
    act(() => toggle().click());
    expect(enabled.notNow).toHaveBeenCalledTimes(1);
  });

  it('shows the pending choice and keeps the offer while saving', () => {
    const state = drip();
    render(state);
    act(() => toggle().click());

    render({ ...state, busy: true });
    expect(toggle().hasAttribute('disabled')).toBe(true);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(rowState()).toBe('offer');
  });

  it('shows the save error', () => {
    render(drip({ error: "Couldn't save. Try again." }));

    expect(byTestId('first-run-daily-credits-error').textContent).toContain(
      "Couldn't save. Try again.",
    );
  });
});
