/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ModelUnlockConfirmedNotice } from '../ModelUnlockConfirmedNotice';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('ModelUnlockConfirmedNotice', () => {
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

  function render(
    props: {
      credits?: number;
      addedCredits?: number;
      modelLabel?: string;
    } = {},
    onDismiss: () => void = jest.fn(),
  ): HTMLElement {
    act(() =>
      root.render(
        <ModelUnlockConfirmedNotice {...props} onDismiss={onDismiss} />,
      ),
    );
    const notice = container.querySelector<HTMLElement>(
      '[data-testid="model-unlock-confirmed-notice"]',
    );
    if (notice === null) throw new Error('notice did not render');
    return notice;
  }

  it('reports the balance and the selected model', () => {
    const notice = render({ credits: 1200, modelLabel: 'Sonnet 5.5' });
    expect(notice.textContent).toBe(
      'Your 1,200 AI Credits are now available. Sonnet 5.5 is selected for this chat.',
    );
  });

  it('names the credits added, like every purchase path (CAN-5160)', () => {
    expect(
      render({ credits: 16, addedCredits: 16, modelLabel: 'Opus 5.5' })
        .textContent,
    ).toBe('16 AI Credits added. Opus 5.5 is selected for this chat.');
  });

  it('adds the balance when it differs from the amount added', () => {
    expect(render({ credits: 40, addedCredits: 16 }).textContent).toBe(
      '16 AI Credits added. Balance: 40 credits. Advanced models are unlocked.',
    );
  });

  it('follows the balance with the plain confirmation when no model matches', () => {
    expect(render({ credits: 1200 }).textContent).toBe(
      'Your 1,200 AI Credits are now available. Advanced models are unlocked.',
    );
  });

  it('falls back to the plain confirmation before the model sentence', () => {
    expect(render({ modelLabel: 'Sonnet 5.5' }).textContent).toBe(
      'Advanced models are unlocked. Sonnet 5.5 is selected for this chat.',
    );
  });

  it('says only that the unlock happened with neither fact', () => {
    expect(render().textContent).toBe('Advanced models are unlocked.');
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'never reports an unusable balance (%p)',
    (credits) => {
      expect(render({ credits }).textContent).toBe(
        'Advanced models are unlocked.',
      );
    },
  );

  it('formats a fractional balance', () => {
    expect(render({ credits: 12.5 }).textContent).toContain(
      'Your 12.5 AI Credits are now available.',
    );
  });

  it('is a positive, polite status with a named dismiss control', () => {
    const onDismiss = jest.fn();
    const notice = render({ credits: 1200 }, onDismiss);
    expect(notice.getAttribute('data-notice-intent')).toBe('positive');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.getAttribute('aria-live')).toBe('polite');
    const dismiss = container.querySelector<HTMLButtonElement>(
      '[data-testid="model-unlock-confirmed-notice-dismiss"]',
    );
    expect(dismiss?.getAttribute('aria-label')).toBe(
      'Dismiss unlock confirmation',
    );
    act(() => dismiss?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
