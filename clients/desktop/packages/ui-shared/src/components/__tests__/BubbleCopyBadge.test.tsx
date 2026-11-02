/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BubbleCopyBadge } from '../BubbleCopyBadge';

describe('BubbleCopyBadge', () => {
  it('copies its text and flips a caller label to Copied', async () => {
    jest.useFakeTimers();
    const writeText = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <BubbleCopyBadge copyText="queued words" label="Copy to clipboard" />,
        ),
      );
      const badge = container.querySelector('button');
      expect(badge?.getAttribute('aria-label')).toBe('Copy to clipboard');
      expect(badge?.hasAttribute('title')).toBe(false);
      expect(badge?.hasAttribute('data-testid')).toBe(false);
      await act(async () => {
        badge?.click();
        await Promise.resolve();
      });
      expect(writeText).toHaveBeenCalledWith('queued words');
      expect(
        container.querySelector('button')?.getAttribute('aria-label'),
      ).toBe('Copied');
    } finally {
      act(() => root.unmount());
      container.remove();
      jest.useRealTimers();
    }
  });
});
