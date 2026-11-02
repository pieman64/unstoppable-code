/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  AI_CREDITS_CHECK_FAILED_COPY,
  AI_CREDITS_CHECK_UNCOVERED_COPY,
  AiCreditsCheckFeedback,
} from '../AiCreditsCheckFeedback';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('AiCreditsCheckFeedback', () => {
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

  function reopen(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      '[data-testid="ai-credits-check-feedback-reopen-billing"]',
    );
  }

  it('offers Reopen billing after an uncovered check', () => {
    const onReopenBilling = jest.fn();
    act(() => {
      root.render(
        <AiCreditsCheckFeedback
          kind="uncovered"
          onReopenBilling={onReopenBilling}
        />,
      );
    });

    expect(container.textContent).toContain(AI_CREDITS_CHECK_UNCOVERED_COPY);
    expect(reopen()?.textContent).toBe('Reopen billing');
    act(() => reopen()?.click());
    expect(onReopenBilling).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending reopen visible but inert', () => {
    const onReopenBilling = jest.fn();
    act(() => {
      root.render(
        <AiCreditsCheckFeedback
          kind="uncovered"
          onReopenBilling={onReopenBilling}
          reopenPending
        />,
      );
    });

    expect(reopen()?.disabled).toBe(true);
    expect(reopen()?.getAttribute('aria-busy')).toBe('true');
    act(() => reopen()?.click());
    expect(onReopenBilling).not.toHaveBeenCalled();
  });

  it('never offers Reopen billing for a failed check', () => {
    act(() => {
      root.render(
        <AiCreditsCheckFeedback
          kind="check-failed"
          onReopenBilling={jest.fn()}
        />,
      );
    });

    expect(container.textContent).toContain(AI_CREDITS_CHECK_FAILED_COPY);
    expect(reopen()).toBeNull();
  });

  it('has no live region of its own', () => {
    act(() => {
      root.render(
        <AiCreditsCheckFeedback kind="uncovered" onReopenBilling={jest.fn()} />,
      );
    });

    expect(container.querySelector('[role], [aria-live]')).toBeNull();
  });
});
