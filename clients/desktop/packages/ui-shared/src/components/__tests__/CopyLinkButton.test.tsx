/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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
});
