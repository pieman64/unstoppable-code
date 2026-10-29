/**
 * @jest-environment jsdom
 *
 * CAN-3137 — the explicit Resume offer shown after the user stops a turn.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StoppedTurnResumeNotice } from '../StoppedTurnResumeNotice';

describe('StoppedTurnResumeNotice', () => {
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

  function render(error?: string): jest.Mock {
    const onResume = jest.fn();
    act(() => {
      root.render(
        <StoppedTurnResumeNotice
          onResume={onResume}
          {...(error ? { error } : {})}
        />,
      );
    });
    return onResume;
  }

  function resumeButton(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="stopped-turn-resume-button"]',
    );
    if (!button) throw new Error('Missing Resume button');
    return button;
  }

  it('offers Resume for the stopped turn', () => {
    const onResume = render();
    expect(
      container.querySelector('[data-testid="stopped-turn-resume"]')
        ?.textContent,
    ).toContain('Turn stopped');
    expect(resumeButton().textContent).toBe('Resume');
    act(() => resumeButton().click());
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('shows the failure and keeps Resume available to try again', () => {
    const onResume = render('Provider unavailable. Try again.');
    expect(container.textContent).toContain('Provider unavailable. Try again.');
    expect(resumeButton().disabled).toBe(false);
    act(() => resumeButton().click());
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
