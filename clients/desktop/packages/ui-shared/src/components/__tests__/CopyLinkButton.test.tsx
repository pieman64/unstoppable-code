/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { buttonClassName } from '../Button';
import { COPY_LINK_CONFIRMATION_MS, CopyLinkButton } from '../CopyLinkButton';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('CopyLinkButton', () => {
  let container: HTMLDivElement;
  let root: Root;
  let writeText: jest.Mock<Promise<void>, [string]>;

  beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    writeText = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  it('shows the copy icon and the Copy link label', () => {
    act(() => {
      root.render(
        <CopyLinkButton url="https://example.test/s/1" dataTestId="copy" />,
      );
    });
    const button = container.querySelector('[data-testid="copy"]');
    expect(button?.textContent).toBe('Copy link');
    expect(button?.getAttribute('aria-label')).toBe('Copy link');
    expect(button?.querySelector('svg')).not.toBeNull();
  });

  it('takes the size of the box it sits in, defaulting to sm', () => {
    const tokens = (size: 'sm' | 'compact'): string[] =>
      buttonClassName({ variant: 'ghost', size }).split(' ').filter(Boolean);
    act(() => {
      root.render(
        <CopyLinkButton url="https://example.test/s/1" dataTestId="copy" />,
      );
    });
    expect(
      container.querySelector('[data-testid="copy"]')?.className.split(' '),
    ).toEqual(expect.arrayContaining(tokens('sm')));
    act(() => {
      root.render(
        <CopyLinkButton
          url="https://example.test/s/1"
          dataTestId="copy"
          size="compact"
        />,
      );
    });
    expect(
      container.querySelector('[data-testid="copy"]')?.className.split(' '),
    ).toEqual(expect.arrayContaining(tokens('compact')));
  });

  it('copies only on click and confirms with Copied for two seconds', async () => {
    const onCopy = jest.fn();
    act(() => {
      root.render(
        <CopyLinkButton
          url="https://example.test/s/1"
          dataTestId="copy"
          onCopy={onCopy}
        />,
      );
    });
    expect(writeText).not.toHaveBeenCalled();
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="copy"]',
    );
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('https://example.test/s/1');
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(button?.textContent).toBe('Copied');

    act(() => {
      jest.advanceTimersByTime(COPY_LINK_CONFIRMATION_MS - 1);
    });
    expect(button?.textContent).toBe('Copied');
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(button?.textContent).toBe('Copy link');
  });

  // CAN-5452: a row listing several links names which one this copies.
  it.each(['button', 'notice'] as const)(
    'keeps the %s accessible name out of replay-recorded attributes',
    async (variant) => {
      act(() => {
        root.render(
          <CopyLinkButton
            url="https://example.test/s/1"
            dataTestId="copy"
            ariaLabel="Copy the Acme link for Deploy"
            variant={variant}
          />,
        );
      });
      const button = container.querySelector<HTMLButtonElement>(
        '[data-testid="copy"]',
      );
      expect(button?.textContent).toBe('Copy link');
      expect(button?.getAttribute('aria-label') ?? '').not.toContain('Acme');
      const labelId = button?.getAttribute('aria-labelledby');
      expect(labelId).toBeTruthy();
      const label = document.getElementById(labelId ?? '');
      expect(label?.textContent).toBe('Copy the Acme link for Deploy');
      expect(label?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
      expect(button?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(false);
      await act(async () => {
        button?.click();
        await Promise.resolve();
      });
      expect(button?.getAttribute('aria-labelledby')).toBeNull();
      expect(button?.textContent).toBe('Copied');
      act(() => jest.advanceTimersByTime(COPY_LINK_CONFIRMATION_MS));
      expect(button?.getAttribute('aria-labelledby')).toBe(labelId);
    },
  );
});
