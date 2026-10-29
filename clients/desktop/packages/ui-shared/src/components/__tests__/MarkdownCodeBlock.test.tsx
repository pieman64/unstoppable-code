/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Markdown } from '../Markdown';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('Markdown code block copy affordance', () => {
  let container: HTMLDivElement;
  let root: Root;
  const writeText = jest.fn<Promise<void>, [string]>();

  beforeEach(() => {
    jest.useFakeTimers();
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  const source =
    'function configure() {\n    const path = "' +
    'deployment/'.repeat(35) +
    '";\n    return path;\n}';

  it('copies the block text and briefly replaces the copy label with confirmation', async () => {
    act(() => {
      root.render(
        <Markdown>
          {'Before `inline()`.\n\n```ts\n' + source + '\n```'}
        </Markdown>,
      );
    });

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy code to clipboard"]',
    );
    expect(button).not.toBeNull();
    expect(container.querySelectorAll('pre')).toHaveLength(1);
    expect(container.querySelectorAll('button')).toHaveLength(1);

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(source);
    expect(button?.getAttribute('aria-label')).toBe('Copied');

    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(button?.getAttribute('aria-label')).toBe('Copy code to clipboard');
  });
  it('preserves streamed source without adding a wrap control', () => {
    act(() => root.render(<Markdown>{'```text\nfirst line\n```'}</Markdown>));
    act(() =>
      root.render(
        <Markdown>{'```text\nfirst line\n    streamed line\n```'}</Markdown>,
      ),
    );
    expect(container.querySelector('pre')?.textContent).toBe(
      'first line\n    streamed line',
    );
    expect(
      container.querySelector('[aria-label="Wrap long lines"]'),
    ).toBeNull();
    expect(container.querySelector('pre')?.getAttribute('tabindex')).toBe('0');
    expect(container.querySelector('pre')?.getAttribute('role')).toBe('group');
  });
});
