/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AutomationOfferNotice } from '../AutomationOfferNotice';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('AutomationOfferNotice', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(): { onCreate: jest.Mock; onDismiss: jest.Mock } {
    const onCreate = jest.fn();
    const onDismiss = jest.fn();
    act(() => {
      root.render(
        <AutomationOfferNotice onCreate={onCreate} onDismiss={onDismiss} />,
      );
    });
    return { onCreate, onDismiss };
  }

  function button(testId: string): HTMLButtonElement {
    const element = container.querySelector(`[data-testid="${testId}"]`);
    if (!(element instanceof HTMLButtonElement)) {
      throw new Error(`Missing button ${testId}`);
    }
    return element;
  }

  it('offers exactly two choices in a polite live region', () => {
    const { onCreate, onDismiss } = render();
    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(container.textContent).toContain('Turn this into an automation?');
    expect(container.textContent).toContain(
      "You've run a similar task before. Make it an automation to run it on a schedule.",
    );
    const buttons = container.querySelectorAll('button');
    expect(Array.from(buttons, (entry) => entry.textContent)).toEqual([
      'Not now',
      'Create automation',
    ]);

    act(() => {
      button('automation-offer-notice-create').click();
    });
    act(() => {
      button('automation-offer-notice-dismiss').click();
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('never moves focus when it mounts', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    render();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
