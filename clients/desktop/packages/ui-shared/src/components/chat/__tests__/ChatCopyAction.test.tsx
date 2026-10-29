/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatLookProvider } from '../../chat-look';
import { ChatCopyAction } from '../ChatCopyAction';

describe('ChatCopyAction', () => {
  it('copies the reply without hidden provider citation markers', async () => {
    const writeText = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <ChatCopyAction
          text={'Sunny today.citeturn0forecast0'}
          dataTestId="copy"
        />,
      ),
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="copy"]')
        ?.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('Sunny today.');
    act(() => root.unmount());
    container.remove();
  });

  describe('feedback (CAN-4704)', () => {
    let container: HTMLDivElement;
    let root: Root;
    let writeText: jest.Mock<Promise<void>, [string]>;

    beforeEach(() => {
      jest.useFakeTimers();
      writeText = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
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

    function render(node: ReactNode): void {
      act(() => root.render(node));
    }

    function button(): HTMLButtonElement {
      const element = container.querySelector('[data-testid="copy"]');
      if (!(element instanceof HTMLButtonElement)) throw new Error('no copy');
      return element;
    }

    function status(): HTMLElement {
      const element = container.querySelector('[data-testid="copy-status"]');
      if (!(element instanceof HTMLElement)) throw new Error('no status');
      return element;
    }

    async function press(): Promise<void> {
      await act(async () => {
        button().click();
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => jest.advanceTimersByTime(100));
    }

    it('takes the footer icon styling of each look', () => {
      render(<ChatCopyAction text="Done." dataTestId="copy" />);
      expect(button().className).toContain('fg-quaternary');
      render(
        <ChatLookProvider value="clean">
          <ChatCopyAction text="Done." dataTestId="copy" />
        </ChatLookProvider>,
      );
      expect(button().className).toContain('fg-secondary');
    });

    it('keeps an empty polite status beside the button until a copy', () => {
      render(<ChatCopyAction text="Done." dataTestId="copy" />);
      expect(status().getAttribute('role')).toBe('status');
      expect(status().textContent).toBe('');
      expect(button().contains(status())).toBe(false);
      expect(button().getAttribute('aria-label')).toBe('Copy message');
    });

    it('confirms a copy with a check, its name and an announcement, then resets', async () => {
      render(<ChatCopyAction text={'# Plan\n\n- **one**'} dataTestId="copy" />);
      await press();
      expect(writeText).toHaveBeenCalledWith('# Plan\n\n- **one**');
      expect(button().getAttribute('aria-label')).toBe('Copied');
      expect(button().hasAttribute('data-copied')).toBe(true);
      expect(status().textContent).toBe('Copied');
      act(() => {
        jest.advanceTimersByTime(1500);
      });
      expect(button().getAttribute('aria-label')).toBe('Copy message');
      expect(status().textContent).toBe('');
    });

    it('announces a repeat copy afresh and restarts the duration', async () => {
      render(<ChatCopyAction text="Done." dataTestId="copy" />);
      await press();
      act(() => {
        jest.advanceTimersByTime(1000);
      });
      await act(async () => {
        button().click();
        await Promise.resolve();
      });
      expect(status().textContent).toBe('');
      act(() => jest.advanceTimersByTime(100));
      expect(status().textContent).toBe('Copied');
      act(() => {
        jest.advanceTimersByTime(1000);
      });
      expect(button().getAttribute('aria-label')).toBe('Copied');
      act(() => {
        jest.advanceTimersByTime(400);
      });
      expect(button().getAttribute('aria-label')).toBe('Copy message');
    });

    it('reports a fallback copy as copied', async () => {
      writeText.mockImplementation(() => Promise.reject(new Error('denied')));
      const execCommand = jest.fn(() => true);
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: execCommand,
      });
      render(<ChatCopyAction text="Done." dataTestId="copy" />);
      await press();
      expect(execCommand).toHaveBeenCalledWith('copy');
      expect(status().textContent).toBe('Copied');
    });

    it('never reports a failed copy as copied', async () => {
      writeText.mockImplementation(() => Promise.reject(new Error('denied')));
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: jest.fn(() => false),
      });
      render(<ChatCopyAction text="Done." dataTestId="copy" />);
      await press();
      expect(button().getAttribute('aria-label')).toBe('Copy message');
      expect(status().textContent).toBe('');
    });

    it('clears an earlier success when the next copy fails', async () => {
      render(<ChatCopyAction text="Done." dataTestId="copy" />);
      await press();
      expect(button().getAttribute('aria-label')).toBe('Copied');
      writeText.mockRejectedValueOnce(new Error('denied'));
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: jest.fn(() => false),
      });
      await press();
      expect(button().getAttribute('aria-label')).toBe('Copy message');
      expect(status().textContent).toBe('');
    });

    it.each([false, true])(
      'drops feedback when reply text changes (pending copy: %s)',
      async (pending) => {
        let finish = (): void => undefined;
        if (pending) {
          writeText.mockImplementationOnce(
            () =>
              new Promise<void>((resolve) => {
                finish = resolve;
              }),
          );
        }
        render(<ChatCopyAction text="First reply" dataTestId="copy" />);
        await press();
        render(<ChatCopyAction text="Second reply" dataTestId="copy" />);
        await act(async () => {
          finish();
          await Promise.resolve();
        });
        expect(button().getAttribute('aria-label')).toBe('Copy message');
        expect(status().textContent).toBe('');
      },
    );

    it('writes through the clicked button document in an auxiliary window', async () => {
      const frame = document.createElement('iframe');
      document.body.append(frame);
      const doc = frame.contentDocument;
      const view = doc?.defaultView;
      if (!doc || !view) throw new Error('no auxiliary document');
      const auxWrite = jest.fn(() => Promise.resolve());
      Object.defineProperty(view.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: auxWrite },
      });
      const host = doc.createElement('div');
      doc.body.append(host);
      const auxRoot = createRoot(host);
      try {
        act(() => auxRoot.render(<ChatCopyAction text="Aux reply" />));
        const copy = host.querySelector('button');
        if (!copy) throw new Error('no auxiliary copy');
        await act(async () => {
          copy.click();
          await Promise.resolve();
        });
        expect(auxWrite).toHaveBeenCalledWith('Aux reply');
        expect(writeText).not.toHaveBeenCalled();
      } finally {
        act(() => auxRoot.unmount());
        frame.remove();
      }
    });

    it('ignores a slow copy that a newer, failed copy overtook', async () => {
      let finishFirst: () => void = () => undefined;
      writeText.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve;
          }),
      );
      writeText.mockImplementationOnce(() =>
        Promise.reject(new Error('denied')),
      );
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: jest.fn(() => false),
      });
      render(<ChatCopyAction text="Done." dataTestId="copy" />);
      await press();
      await press();
      await act(async () => {
        finishFirst();
        await Promise.resolve();
      });
      expect(button().getAttribute('aria-label')).toBe('Copy message');
      expect(status().textContent).toBe('');
    });

    it('leaves no timer behind when it unmounts mid-copy', async () => {
      let finish: () => void = () => undefined;
      writeText.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      render(<ChatCopyAction text="Done." dataTestId="copy" />);
      await press();
      render(null);
      const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
      await act(async () => {
        finish();
        await Promise.resolve();
        await Promise.resolve();
      });
      // The settled write starts no reset timer for the unmounted button.
      expect(setTimeoutSpy).not.toHaveBeenCalledWith(
        expect.any(Function),
        1500,
      );
      setTimeoutSpy.mockRestore();
    });
  });
});
