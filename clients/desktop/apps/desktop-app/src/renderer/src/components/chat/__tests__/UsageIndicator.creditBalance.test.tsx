/**
 * @jest-environment jsdom
 *
 * CAN-5026: the composer hands the shared meter a pending balance (`null`)
 * only while a figure it showed is being re-read, and omits the balance for
 * a first load, so the slot neither collapses nor appears from nothing.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as ComposerBalanceModule from '@/hooks/useComposerAiCreditsBalance';
import type { ComposerAiCreditsBalance } from '@/hooks/useComposerAiCreditsBalance';
import { UsageIndicator } from '../UsageIndicator';

let mockBalance: ComposerAiCreditsBalance = { credits: null, pending: false };
jest.mock('@/hooks/useComposerAiCreditsBalance', () => ({
  ...jest.requireActual<typeof ComposerBalanceModule>(
    '@/hooks/useComposerAiCreditsBalance',
  ),
  useComposerAiCreditsBalance: (): ComposerAiCreditsBalance => mockBalance,
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});

describe('UsageIndicator AI Credits balance', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderWith(balance: ComposerAiCreditsBalance): HTMLButtonElement {
    mockBalance = balance;
    act(() => {
      root.render(
        <UsageIndicator
          usage={undefined}
          isCodex={false}
          creditTarget={{ chatId: 'chat-1' }}
          aiCreditsRouted
          aiCreditsBilled
        />,
      );
    });
    const button = container.querySelector('[data-testid="usage-indicator"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('no trigger');
    return button;
  }

  function slot(): Element | null {
    return container.querySelector(
      '[data-testid="usage-indicator-credit-balance"]',
    );
  }

  it('omits the slot while the first read loads', () => {
    const button = renderWith({ credits: null, pending: false });
    expect(slot()).toBeNull();
    expect(button.hasAttribute('aria-busy')).toBe(false);
  });

  it('shows the figure, then holds its place while it is re-read', () => {
    const button = renderWith({ credits: 3.2, pending: false });
    expect(slot()?.textContent).toBe('3.2 AI Credits');

    renderWith({ credits: null, pending: true });
    expect(slot()?.getAttribute('data-pending')).toBe('true');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Usage indicator');
    expect(button.textContent).not.toContain('3.2');

    renderWith({ credits: 1200, pending: false });
    expect(slot()?.textContent).toBe('1,200 AI Credits');
    expect(button.getAttribute('aria-label')).toBe(
      'Usage indicator, 1,200 AI Credits',
    );
  });
});
