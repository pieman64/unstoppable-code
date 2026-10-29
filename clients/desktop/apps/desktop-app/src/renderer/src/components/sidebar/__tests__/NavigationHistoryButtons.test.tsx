/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { focusViaKeyboard } from '@/test-utils/dom';
import { useNavigationHistoryStore } from '@/stores/navigationHistoryStore';
import { NavigationHistoryButtons } from '../NavigationHistoryButtons';

describe('NavigationHistoryButtons', () => {
  afterEach(() => {
    useNavigationHistoryStore.getState().reset();
    document.body.innerHTML = '';
  });

  it('shows tooltips for the back and forward actions', () => {
    useNavigationHistoryStore.setState({
      canGoBack: true,
      canGoForward: true,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => root.render(<NavigationHistoryButtons />));

    const back = container.querySelector<HTMLButtonElement>(
      '[data-testid="nav-history-back"]',
    );
    const forward = container.querySelector<HTMLButtonElement>(
      '[data-testid="nav-history-forward"]',
    );

    act(() => focusViaKeyboard(back));
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Go back',
    );

    act(() => focusViaKeyboard(forward));
    expect(
      Array.from(document.body.querySelectorAll('[role="tooltip"]')).some(
        (tooltip) => tooltip.textContent === 'Go forward',
      ),
    ).toBe(true);

    act(() => root.unmount());
  });
});
