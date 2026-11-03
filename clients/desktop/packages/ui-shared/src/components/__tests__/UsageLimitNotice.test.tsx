/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { UsageLimitNotice } from '../UsageLimitNotice';
import { AiCreditsCheckFeedback } from '../AiCreditsCheckFeedback';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('UsageLimitNotice', () => {
  it('announces the provider and feedback once, preserves actions and dismisses', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const dismiss = jest.fn();
    const reopen = jest.fn();
    try {
      act(() =>
        root.render(
          <UsageLimitNotice
            provider="codex"
            onDismiss={dismiss}
            dismissLabel="Dismiss usage limit banner"
            actions={<button type="button">Check again</button>}
            detail={
              <AiCreditsCheckFeedback
                kind="uncovered"
                onReopenBilling={reopen}
              />
            }
          >
            You can keep chatting.
          </UsageLimitNotice>,
        ),
      );
      const status = container.querySelector('[role="status"]');
      expect(status?.textContent).toContain(
        'Codex usage limit reached. You can keep chatting.',
      );
      expect(status?.getAttribute('aria-live')).toBe('polite');
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(status?.textContent).toContain(
        "No credits yet. If you've paid, they can take a minute to arrive.",
      );
      expect(status?.textContent).toContain('Check again');
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="ai-credits-check-feedback-reopen-billing"]',
          )
          ?.click(),
      );
      expect(reopen).toHaveBeenCalledTimes(1);
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Dismiss usage limit banner"]',
          )
          ?.click(),
      );
      expect(dismiss).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe('UsageLimitNotice purchase step (CAN-5160)', () => {
  function renderStep(failed: boolean): HTMLElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <UsageLimitNotice
          provider="claude"
          data-testid="limit"
          purchaseStep={{ title: 'Finish checkout in your browser', failed }}
          actions={<button type="button">Check again</button>}
        >
          Your credits show up here once the payment goes through.
        </UsageLimitNotice>,
      ),
    );
    return container;
  }

  it('replaces the limit with the neutral checkout step, keeping the actions', () => {
    const container = renderStep(false);
    const notice = container.querySelector('[data-testid="limit"]');
    expect(notice?.getAttribute('data-notice-intent')).toBe('neutral');
    expect(notice?.textContent).toContain(
      'Finish checkout in your browser. Your credits show up here once the payment goes through.',
    );
    expect(notice?.textContent).not.toContain('usage limit reached');
    expect(notice?.textContent).toContain('Check again');
    container.remove();
  });

  it('is a warning again only when the check failed', () => {
    const container = renderStep(true);
    expect(
      container
        .querySelector('[data-testid="limit"]')
        ?.getAttribute('data-notice-intent'),
    ).toBe('attention');
    container.remove();
  });
});
