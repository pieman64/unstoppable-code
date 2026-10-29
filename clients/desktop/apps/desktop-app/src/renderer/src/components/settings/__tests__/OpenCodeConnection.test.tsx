/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OpenCodeConnection } from '../OpenCodeConnection';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('OpenCode connection errors', () => {
  it.each(['connect', 'disconnect'])(
    'removes the IPC wrapper from a failed %s',
    async (kind) => {
      const message = 'OpenCode setup was cancelled. Try again.';
      const mutation = jest.fn(() =>
        Promise.reject(
          new Error(
            `Error invoking remote method 'opencode-connection:${kind}': Error: ${message}`,
          ),
        ),
      );
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          opencodeConnection: {
            status: () =>
              Promise.resolve({
                supported: true,
                installed: kind === 'disconnect',
                enabled: kind === 'disconnect',
                phase: 'idle',
                version: 'test',
              }),
            connect: mutation,
            disconnect: mutation,
            onProgress: (): (() => void) => (): void => undefined,
            cancel: () => Promise.resolve(),
          },
          loadPreferences: () => Promise.resolve({}),
        },
      });
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act((): Promise<void> => {
          root.render(<OpenCodeConnection />);
          return Promise.resolve();
        });
        const button = container.querySelector(
          '[data-testid="opencode-connect"]',
        );
        if (!(button instanceof HTMLButtonElement))
          throw new Error('Missing connection button');
        await act((): Promise<void> => {
          button.click();
          return Promise.resolve();
        });
        expect(mutation).toHaveBeenCalledTimes(1);
        expect(
          container.querySelector('[data-testid="opencode-connection-error"]')
            ?.textContent,
        ).toBe(message);
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    },
  );
});
