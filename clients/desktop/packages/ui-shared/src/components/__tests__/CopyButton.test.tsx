/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CopyButton } from '../CopyButton';
import { buttonClassName } from '../Button';

// The Button recipe, as an element, so class lists compare after trimming.
function renderedButton(
  options: Parameters<typeof buttonClassName>[0],
): Element {
  const element = document.createElement('button');
  element.setAttribute('class', buttonClassName(options));
  return element;
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function classesOf(element: Element | null): string[] {
  return (element?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

describe('CopyButton', () => {
  let container: HTMLDivElement;
  let root: Root;
  let writeText: jest.Mock<Promise<void>, []>;

  beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    writeText = jest.fn((): Promise<void> => Promise.resolve());
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

  it('is the shared Button: a quiet icon-only control by default', () => {
    act(() => {
      root.render(<CopyButton value="npm run dev" />);
    });
    const button = container.querySelector('button');

    expect(button?.getAttribute('aria-label')).toBe('Copy to clipboard');
    expect(classesOf(button)).toEqual(
      classesOf(
        renderedButton({ variant: 'ghost', size: 'sm', iconOnly: true }),
      ),
    );
    expect(button?.querySelector('svg')?.getAttribute('width')).toBe('14px');
  });

  it('takes Button variants and sizes, and a label makes it a labeled button', () => {
    act(() => {
      root.render(
        <CopyButton
          value="https://example.test/invite"
          label="Copy link"
          variant="secondary"
          size="md"
          ariaLabel="Copy invite link"
        />,
      );
    });
    const button = container.querySelector('button');

    expect(button?.textContent).toBe('Copy link');
    expect(button?.getAttribute('aria-label')).toBe('Copy invite link');
    expect(classesOf(button)).toEqual(
      classesOf(renderedButton({ variant: 'secondary', size: 'md' })),
    );
    expect(button?.querySelector('svg')?.getAttribute('width')).toBe('14px');
  });

  it('keeps caller classes for placement only', () => {
    act(() => {
      root.render(<CopyButton value="x" className="ml-auto" />);
    });

    expect(classesOf(container.querySelector('button'))).toContain('ml-auto');
  });

  it('copies on click, shows the copied state, and returns after the duration', async () => {
    const onCopy = jest.fn();
    act(() => {
      root.render(
        <CopyButton
          value="npm run dev"
          label="Copy"
          copiedLabel="Copied"
          copiedDurationMs={500}
          onCopy={onCopy}
        />,
      );
    });
    const button = container.querySelector('button');
    if (!button) throw new Error('no button');

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith('npm run dev');
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(button.textContent).toBe('Copied');
    expect(button.getAttribute('aria-label')).toBe('Copied');

    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(button.textContent).toBe('Copy');
  });
});
